// @ts-nocheck
/**
 * SQLite FTS5 index for Agentic RAG.
 *
 * The index is deliberately a sidecar of the authoritative tree, never inside the
 * caller's view: a view is rebuilt from grants, so an index stored there would be
 * deleted by the next sync. It also must never be reachable through `kb_file_*`.
 *
 * Chunks are tokenized with FTS5's `trigram` tokenizer, which is what makes Chinese
 * text searchable without a word segmenter. Scope columns are applied in SQL before
 * BM25 ordering; the caller's per-path grant check is applied after the top candidate
 * window, so a hit can be dropped but never leak.
 *
 * @module @sparkelf/dsh-knowledge-base/ftsIndex
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { localizedScopeForPath, type ScopeLocale } from './scopeAliases.ts'
import {
  SUMMARY_VERSION,
  buildDocumentOutline,
  renderOutlineMarkdown,
  type BuiltOutline,
  type OutlineChunk,
  type OutlineKeyFact,
  type OutlineSection,
  type OutlineTocEntry,
} from './outlineText.ts'
import {
  planOutlineSave,
  type OutlineSaveRejection,
  type OutlineSectionSubmission,
  type OutlineSummaryKind,
} from './outlineGuard.ts'
import { cosineSimilarity, ensureVectorSchema, unpackVector, vectorCandidates } from './vectorIndex.ts'

/** Prefix used for the sidecar directory when no explicit index dir is configured. */
export const DEFAULT_INDEX_DIR = '/nas/kb/index'

/** File extensions whose bytes are safe to index as text. */
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text', '.csv', '.json', '.yaml', '.yml',
  '.html', '.htm', '.xml', '.log', '.sql', '.ts', '.tsx', '.js', '.jsx',
  '.css', '.py', '.sh', '.java', '.go', '.rs',
])

/** Directory names that are state, not documents. */
const SKIP_DIRS = new Set(['.kb-pending', '.kb-trash', '.kb-audit', '.kb-settings', '.git', 'node_modules'])

/**
 * Whether a path's bytes are plain text the index can read directly.
 *
 * Shared with the write paths so "index this after the write" and "the index walk
 * will find this file" cannot disagree: both answer from the same extension set.
 * @param relPath - the document's path.
 * @returns true when {@link syncIndex} would read this file as text.
 */
export function isIndexableTextPath(relPath: string): boolean {
  const dot = relPath.lastIndexOf('.')
  return dot >= 0 && TEXT_EXTENSIONS.has(relPath.slice(dot).toLowerCase())
}

/** One search hit returned to the model. */
/** Result of one kb_search call, including whether it had to relax. */
export interface FtsSearchResult {
  hits: FtsSearchHit[]
  relaxed: boolean
  queries: string[]
  /** Set when hybrid retrieval ran; absent in pure-FTS answers. */
  retrieval?: 'fts' | 'vector' | 'hybrid'
  /** Provider/vector failure that made the answer fall back to FTS. */
  vectorWarning?: string
  /** How many vector-only slots the FTS floor reclaimed. */
  floorReplacements?: number
  /**
   * Summary chunks that matched the query, for navigation only.
   *
   * They deliberately carry no citation token: a summary is generated from the source and
   * must never become the quoted evidence. Follow one with `kb_outline` or a chunk read.
   */
  relatedSections?: FtsRelatedSection[]
}

/** One summary chunk returned by the summarised half of the FTS index. */
export interface FtsRelatedSection {
  docId: number
  kind: 'doc_summary' | 'section_summary'
  sectionId?: string
  /** Original source path (the citable document). */
  path: string
  displayPath?: string
  /** Chapter/section heading path. */
  sectionPath: string
  summary: string
  /** Source chunk ids this summary was extracted from; navigation only. */
  sourceChunkIds: number[]
  score: number
}

/** Normalize stored bbox JSON to the `[x1,y1,x2,y2]` shape viewers parse. */
function bboxCoordinates(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed) && parsed.length === 4 && parsed.every(value => typeof value === 'number')) {
      return JSON.stringify(parsed)
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const nested = (parsed as { bbox?: unknown }).bbox
      if (Array.isArray(nested) && nested.length === 4 && nested.every(value => typeof value === 'number')) {
        return JSON.stringify(nested)
      }
    }
  } catch {
    // Legacy plain strings pass through; old boxes may already be `x1,y1,x2,y2`.
  }
  return raw
}

/** Parse one stored bbox into four finite numbers, accepting legacy `x1,y1,x2,y2` strings. */
function bboxValues(raw: string): [number, number, number, number] | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed) && parsed.length === 4 && parsed.every(value => typeof value === 'number' && Number.isFinite(value))) {
      return parsed as [number, number, number, number]
    }
  } catch {
    const parts = raw.split(',').map(value => Number(value.trim()))
    if (parts.length === 4 && parts.every(value => Number.isFinite(value))) return parts as [number, number, number, number]
  }
  return undefined
}

export interface FtsChunkBox {
  page: number
  bbox: string
  blockIndex?: number
  occurrence?: number
  confidence?: number
  approximate?: boolean
}

/**
 * Collapse provenance boxes to exactly one union rectangle per page.
 *
 * `kb_chunk_boxes` intentionally stores one row per extracted block so provenance stays
 * inspectable, but every reader (search hit, chunk endpoint, PDF viewer) wants the chunk's
 * painted region: one rectangle per page. Unioning at the SQL boundary means a citation never
 * receives a list of paragraph boxes that a client might paint one by one before merging.
 */
export function unionBoxesByPage(boxes: readonly FtsChunkBox[]): FtsChunkBox[] {
  const byPage = new Map<number, { left: number; top: number; right: number; bottom: number; approximate: boolean }>()
  for (const box of boxes) {
    const values = bboxValues(box.bbox)
    if (values === undefined) continue
    const [left, top, right, bottom] = values
    const current = byPage.get(box.page) ?? { left, top, right, bottom, approximate: false }
    current.left = Math.min(current.left, left)
    current.top = Math.min(current.top, top)
    current.right = Math.max(current.right, right)
    current.bottom = Math.max(current.bottom, bottom)
    current.approximate = current.approximate || box.approximate === true || (box.confidence !== undefined && box.confidence < 0.6)
    byPage.set(box.page, current)
  }
  return [...byPage.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([page, union]) => ({
      page,
      bbox: JSON.stringify([union.left, union.top, union.right, union.bottom]),
      ...(union.approximate ? { approximate: true } : {}),
    }))
}

export interface FtsSearchHit {
  /** Original document path (docx/xlsx/pdf/txt), never the derived Markdown sibling. */
  path: string
  /** Localized virtual-root spelling for display; `path` stays canonical. */
  displayPath?: string
  /** Derived text sibling used internally for snippets/reading. */
  markdownPath: string
  heading?: string
  /** Chunk ordinal/paragraph anchor within the source. */
  paragraph?: number
  /** Zero-based chunk ordinal in the document. */
  chunkOrdinal?: number
  /** First prose paragraph anchor, for a viewer outline. */
  paragraphText?: string
  /** Plain-text quote for findController (never Markdown/table syntax). */
  quote?: string
  /** Query terms found in this chunk. */
  matchedTerms?: string[]
  /** Snippet/sentence containing the query terms. */
  highlightText?: string
  /** Character ranges of matchedTerms inside highlightText (end-exclusive). */
  highlightRanges?: Array<{ start: number; end: number }>
  /** Spreadsheet anchors, when known. */
  sheet?: string
  cell?: string
  /** Present only for text/Markdown sources; PDF/scan hits carry boxes instead. */
  line?: number
  lineStart?: number
  lineEnd?: number
  snippet: string
  score: number
  docId: number
  chunkId: number
  /** Stable content-keyed citation id (survives a full reindex). */
  chunkKey?: string
  /** Stable citation token: kb://doc/<docId>/chunk/<chunkKey or chunkId> */
  citation: string
  /** All provenance boxes for this chunk, grouped by page by the viewer. */
  boxes?: FtsChunkBox[]
  /** First box's page, kept for convenience. */
  page?: number
  /** First box bbox, kept for compatibility with earlier consumers. */
  bbox?: string
  blockIndex?: number
  occurrence?: number
  /** True when any box came from a low-confidence OCR pass. */
  approximate?: boolean
  /** Nearest outline section, when the document has one. */
  sectionId?: string
  /** Full heading path of that section (`第三章 > 第二十二条`). */
  sectionPath?: string
  /** Extractive summary of that section; navigation only, never a citation. */
  sectionSummary?: string
  /** Depth of that section (1 = chapter). */
  sectionLevel?: number
  /** Extractive document summary; navigation only, never a citation. */
  docSummary?: string
  /** Which retrieval channel produced this hit in hybrid mode. */
  retrieval?: 'fts' | 'vector' | 'hybrid'
  /** One-based rank in the FTS candidate list. */
  ftsRank?: number
  /** One-based rank in the vector candidate list. */
  vectorRank?: number
  /** Weighted reciprocal-rank-fusion score. */
  rrfScore?: number
  /** Raw BM25 score, when the FTS channel found this chunk. */
  ftsScore?: number
  /** Raw cosine similarity, when the vector channel found this chunk. */
  vectorScore?: number
  /** Set when the FTS floor put this hit back into the final window. */
  retrievalReason?: 'fts-floor'
}

/** Query-side vector inputs for hybrid retrieval. */
export interface VectorSearchInput {
  model: string
  queryVector: readonly number[]
  candidateK: number
  rrfK: number
  ftsWeight: number
  vectorWeight: number
  /** Share of the corpus that has vectors; scales only the vector contribution. */
  coverage: number
}

/** Counts reported by an index sync/rebuild. */
export interface FtsIndexStats {
  indexPath: string
  docs: number
  chunks: number
  indexed: number
  unchanged: number
  removed: number
  updatedAt: string
}

/** A caller's scope for index filtering. */
export interface FtsCallerScope {
  callerId: string
  /** Department codes the caller may see, including ancestors/descendants as resolved by the Host. */
  departmentCodes: readonly string[]
  /** Global administrators see every scope. */
  global: boolean
}

/** The index path for one deployment. */
export function indexPathFor(indexDir: string | undefined): string {
  return join(indexDir === undefined || indexDir.trim() === '' ? DEFAULT_INDEX_DIR : indexDir, 'kb-index.sqlite')
}

/** What the sidecar index knows about one document. */
export interface DocumentIndexStatus {
  found: boolean
  docId?: number
  path?: string
  scope?: string
  chunks?: number
  indexedAt?: number
}

/**
 * Read one document's row from the sidecar index.
 *
 * Used by the write paths to report whether the document they just wrote is really
 * searchable, and by the `index.status` route. The lookup accepts the view spelling
 * too (`global/…` may be stored as the actual path, or a personal view path drops the
 * owner segment), so an exact miss falls back to a suffix match before reporting
 * `found: false`.
 *
 * @param indexPath - the deployment's SQLite index file.
 * @param relPath - the document's authoritative or view-relative path.
 * @returns the row, or `found: false` when nothing matches or the index is absent.
 */
export function documentIndexStatus(indexPath: string, relPath: string): DocumentIndexStatus {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(indexPath, { readOnly: true })
    // The index stores the TEXT file it chunked: for an extracted document that is
    // the derived `<source>.md`, not the source the reader clicks. Both spellings
    // must answer, or the PDF row would report "not indexed" while its chunks are
    // the ones being retrieved.
    const row = db.prepare('SELECT id, path, scope, mtime FROM kb_docs WHERE path = ? OR source_path = ?').get(relPath, relPath) as
      { id: number; path: string; scope: string; mtime: number } | undefined
      ?? db.prepare('SELECT id, path, scope, mtime FROM kb_docs WHERE path LIKE ? OR source_path LIKE ? ORDER BY mtime DESC LIMIT 1')
        .get('%/' + relPath, '%/' + relPath) as { id: number; path: string; scope: string; mtime: number } | undefined
    if (row === undefined) return { found: false }
    const count = db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ?').get(row.id) as { n?: number } | undefined
    return {
      found: true,
      docId: row.id,
      path: row.path,
      scope: row.scope,
      chunks: Number(count?.n ?? 0),
      indexedAt: row.mtime,
    }
  } catch {
    // A missing index file or a table that has never been created is not an error:
    // the write still succeeded, it simply has no row yet.
    return { found: false }
  } finally {
    db?.close()
  }
}

/**
 * Refuse an index path inside the browsable/authoritative trees.
 *
 * The index contains unreviewed snippets; putting it under a view would expose it to
 * file tools and would let the next sync delete it as an unlinked file.
 */
export function assertIndexOutsideTrees(indexPath: string, trees: readonly string[]): void {
  const target = resolve(indexPath)
  for (const tree of trees) {
    if (tree === '') continue
    const root = resolve(tree)
    const rel = relative(root, target)
    if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) {
      throw new Error(`knowledge index must live outside the agent-visible tree (${target} is inside ${root})`)
    }
  }
}

/** Derive the scope columns from a view-relative path. */
export function scopeForPath(relPath: string): {
  scope: 'global' | 'department' | 'personal'
  ownerId: string | null
  departmentCode: string | null
} {
  const parts = relPath.split('/').filter(part => part !== '')
  if (parts[0] === 'personal' && parts.length >= 2) {
    // `personal/<file>` is the virtual-bucket spelling a UI upload uses before the
    // write route prepends the owner. Its scope is still personal; the owner is
    // unknown for that spelling, so the row is only addressable through the
    // caller-scoped path the route now writes.
    return { scope: 'personal', ownerId: parts.length >= 3 ? parts[1] ?? null : null, departmentCode: null }
  }
  if (parts[0] === 'department' && parts.length >= 3) {
    return { scope: 'department', ownerId: null, departmentCode: parts[1] ?? null }
  }
  return { scope: 'global', ownerId: null, departmentCode: null }
}

/**
 * Split text into structure-aware, line-addressed chunks for retrieval.
 *
 * Chapter/section headings, article headings, Markdown headings and table rows open a new
 * chunk; a heading is never appended to the body that precedes it. Article bodies may split at
 * sentence or list boundaries, but a chunk never crosses a chapter/section heading. The
 * 350–500 CJK character target is a soft packing hint (min 150, max 800); structure wins when
 * the two disagree. The 60-character overlap is added only inside one chapter and never in
 * front of a heading, so a citation quote always begins with its own structure. The index
 * records the first source line of each chunk, so text sources keep an honest `lineStart`.
 */
export function chunkText(
  text: string,
  options: number | { target?: number; min?: number; max?: number; overlap?: number } = {},
): Array<{ line: number; content: string }> {
  const opts = typeof options === 'number' ? { max: options, target: Math.max(80, Math.round(options * 0.6)) } : options
  const target = Math.max(1, opts.target ?? 430)
  const min = Math.max(1, opts.min ?? 150)
  const max = Math.max(target, opts.max ?? 800)
  const overlap = Math.max(0, Math.min(80, opts.overlap ?? 60))
  const lines = text.split('\n')
  /** `chapter`/`heading` open a scope; `article` starts a new chunk inside it. */
  type Kind = 'chapter' | 'heading' | 'article' | 'table' | 'list' | 'paragraph'
  interface Block { line: number; text: string; kind: Kind; scope: number }
  const blocks: Block[] = []
  const markdownHeading = /^#{1,6}\s+/u
  const chapterHeading = /^第[一二三四五六七八九十百零〇\d]+[章节]/u
  const chineseHeading = /^[一二三四五六七八九十百]+、/u
  const articleHeading = /^第[一二三四五六七八九十百零〇\d]+条/u
  const listItem = /^(?:[（(][一二三四五六七八九十百零〇\d]+[）)]|\d+[.、．)])/u
  const table = /^\s*\|/u
  const isHeading = (kind: Kind): boolean => kind === 'chapter' || kind === 'heading' || kind === 'article'
  const isStructural = (kind: Kind): boolean => isHeading(kind) || kind === 'table'
  // Only a pure container heading may stack with the heading after it. An article block owns its
  // body, so it counts as content: the next article must start a new chunk.
  const isContainerHeading = (kind: Kind): boolean => kind === 'chapter' || kind === 'heading'
  const kindOf = (line: string): Kind => {
    const value = line.trim()
    if (markdownHeading.test(value) || chineseHeading.test(value)) return 'heading'
    if (chapterHeading.test(value)) return 'chapter'
    if (articleHeading.test(value)) return 'article'
    if (table.test(value)) return 'table'
    if (listItem.test(value)) return 'list'
    return 'paragraph'
  }
  let scope = 0
  const push = (line: number, parts: string[], kind: Kind): void => {
    const value = parts.join('\n').trim()
    if (value !== '') blocks.push({ line, text: value, kind, scope })
  }
  for (let index = 0; index < lines.length;) {
    const value = lines[index] ?? ''
    if (value.trim() === '') { index += 1; continue }
    const kind = kindOf(value)
    if (kind === 'chapter' || kind === 'heading') {
      scope += 1
      push(index + 1, [value], kind)
      index += 1
      continue
    }
    if (kind === 'table') { push(index + 1, [value], kind); index += 1; continue }
    // An article or list item owns its wrapped continuation lines; the next article, heading,
    // table row or list item always starts a new block.
    const parts = [value]
    let next = index + 1
    while (next < lines.length) {
      const candidate = lines[next] ?? ''
      const candidateKind = kindOf(candidate)
      if (candidate.trim() === '' || isStructural(candidateKind) || candidateKind === 'list') break
      parts.push(candidate); next += 1
    }
    push(index + 1, parts, kind)
    index = next
  }
  // A single oversized block is split on sentence boundaries. Tables stay atomic, and the first
  // piece keeps the original kind so a heading/anchor is never detached from its body.
  const splitOversized = (block: Block): string[] => {
    const sentences = block.text.split(/(?<=[。！？；.!?])\s*/u).filter(Boolean)
    if (sentences.length <= 1) {
      const slices: string[] = []
      for (let offset = 0; offset < block.text.length; offset += max) slices.push(block.text.slice(offset, offset + max))
      return slices
    }
    const slices: string[] = []
    let buffer: string[] = []
    for (const sentence of sentences) {
      if (buffer.length > 0 && buffer.join('').length + sentence.length > max) {
        slices.push(buffer.join(''))
        buffer = []
      }
      buffer.push(sentence)
    }
    if (buffer.length > 0) slices.push(buffer.join(''))
    return slices
  }
  const expanded: Block[] = []
  for (const block of blocks) {
    if (block.text.length <= max || block.kind === 'table') { expanded.push(block); continue }
    splitOversized(block).forEach((value, index) => {
      expanded.push({ line: block.line, text: value, kind: index === 0 ? block.kind : 'paragraph', scope: block.scope })
    })
  }
  interface Draft {
    line: number
    content: string
    blocks: Block[]
    startsStructural: boolean
    scope: number
  }
  const drafts: Draft[] = []
  let current: Block[] = []
  let chars = 0
  const headingsOnly = (list: readonly Block[]): boolean => list.every(block => isContainerHeading(block.kind))
  const flush = (): void => {
    if (current.length === 0) return
    const content = current.map(block => block.text).join('\n').trim()
    if (content !== '') {
      drafts.push({
        line: current[0]!.line,
        content,
        blocks: current,
        startsStructural: isStructural(current[0]!.kind),
        scope: current[0]!.scope,
      })
    }
    current = []; chars = 0
  }
  for (const block of expanded) {
    const size = block.text.length
    const structural = isStructural(block.kind)
    if (current.length > 0) {
      // A heading opens a new chunk as soon as the current chunk has body text. Consecutive
      // headings stay together (document title + chapter title, chapter title + article title)
      // so a heading is never an orphan chunk and is never glued to the previous body.
      if (structural && !headingsOnly(current)) flush()
      else if (chars >= target) flush()
      else if (chars + size + 1 > max) flush()
    }
    current.push(block); chars += size + 1
    if (chars >= target && !structural) flush()
  }
  flush()
  // Merge a short chunk into a neighbour only inside one chapter. A chunk that starts with a
  // structural block is never merged backwards, so a chapter/article/table never loses its
  // own start.
  for (let index = 0; index < drafts.length;) {
    const chunk = drafts[index]!
    if (chunk.content.length >= min) { index += 1; continue }
    const previous = index > 0 ? drafts[index - 1] : undefined
    if (previous !== undefined && !chunk.startsStructural && previous.scope === chunk.scope
      && previous.content.length + chunk.content.length + 1 <= max) {
      previous.content += '\n' + chunk.content
      previous.blocks = [...previous.blocks, ...chunk.blocks]
      drafts.splice(index, 1)
      continue
    }
    const next = index + 1 < drafts.length ? drafts[index + 1] : undefined
    if (next !== undefined && next.scope === chunk.scope
      && chunk.content.length + next.content.length + 1 <= max
      && (!next.startsStructural || headingsOnly(chunk.blocks))) {
      chunk.content += '\n' + next.content
      chunk.blocks = [...chunk.blocks, ...next.blocks]
      drafts.splice(index + 1, 1)
      continue
    }
    index += 1
  }
  if (overlap === 0 || drafts.length < 2) return drafts.map(chunk => ({ line: chunk.line, content: chunk.content }))
  // A bounded tail overlap keeps a boundary phrase retrievable. It never crosses a chapter and
  // never prepends stale text in front of a new chunk's own heading.
  for (let index = 1; index < drafts.length; index += 1) {
    const previous = drafts[index - 1]!
    const chunk = drafts[index]!
    if (chunk.startsStructural || chunk.scope !== previous.scope) continue
    if (previous.content.length <= overlap) continue
    const tail = previous.content.slice(-overlap)
    if (tail.length < 50) continue
    chunk.content = tail + '\n' + chunk.content
  }
  return drafts.map(chunk => ({ line: chunk.line, content: chunk.content }))
}

/** Stable citation key for one chunk: heading + normalized content hash. */
export function stableChunkKey(heading: string | null | undefined, content: string): string {
  return createHash('sha1').update((heading ?? '') + '\0' + content.replace(/\s+/gu, '')).digest('hex').slice(0, 16)
}

/**
 * Content shingles used only to migrate old citations.
 *
 * Every position contributes a shingle. A fixed stride makes the set phase-sensitive: the same
 * paragraph starting 3 characters later in a new chunk shares almost nothing, which is exactly
 * what happens when the chunker moves a boundary. Eight characters are enough to identify a
 * Chinese clause while keeping the multiset small.
 */
const CHUNK_SHINGLE_SIZE = 8
type ChunkShingles = Map<string, number>

function chunkShingles(value: string): ChunkShingles {
  const normalized = value.replace(/\s+/gu, '')
  const out: ChunkShingles = new Map()
  for (let index = 0; index + CHUNK_SHINGLE_SIZE <= normalized.length; index += 1) {
    const part = normalized.slice(index, index + CHUNK_SHINGLE_SIZE)
    out.set(part, (out.get(part) ?? 0) + 1)
  }
  return out
}

/**
 * Share of the OLD chunk's text contained in the candidate text.
 *
 * Counts, not a set: a paragraph that repeats one sentence must not look fully covered when only
 * a single copy survives. A low ratio means the content was rewritten or removed, and a citation
 * pointing at it must expire (404) rather than open an unrelated paragraph.
 */
function chunkOverlapRatio(oldContent: string, candidateContents: readonly string[]): number {
  const oldShingles = chunkShingles(oldContent)
  let total = 0
  for (const count of oldShingles.values()) total += count
  if (total === 0) {
    const oldText = oldContent.trim()
    return oldText !== '' && candidateContents.join('\n').trim() === oldText ? 1 : 0
  }
  const next = chunkShingles(candidateContents.join('\n'))
  let shared = 0
  for (const [part, count] of oldShingles) shared += Math.min(count, next.get(part) ?? 0)
  return shared / total
}

/** A citation alias is only written when at least this share of the old chunk survives. */
const CHUNK_ALIAS_MIN_SPAN_RATIO = 0.5
/** Bound the candidate scan so a heading repeated throughout a book cannot make migration O(n²). */
const CHUNK_ALIAS_MAX_CANDIDATES = 12
/** Longest run of new chunks considered as one split target. */
const CHUNK_ALIAS_MAX_SPAN = 20

/** Visible text: tags and entities removed, so HTML/Markdown wrappers cannot hide a match. */
function visibleText(value: string): string {
  return value.replace(/<\/?[^>]+>/gu, ' ').replace(/&(?:[a-z]+|#\d+);/giu, ' ')
}

/** First meaningful line of a chunk, normalized; used to find where the old text starts. */
function chunkStartAnchor(content: string): string {
  for (const line of content.split('\n')) {
    const text = visibleText(line)
      .replace(/^[\s|]+|[\s|]+$/gu, '')
      .replace(/^\/?[0-9A-Za-z]+\s*>/u, '')
    const normalized = text.replace(/\s+/gu, '')
    if (normalized.length >= 4 && /[0-9A-Za-z\u4e00-\u9fff]/u.test(normalized)) return normalized.slice(0, 24)
  }
  return visibleText(content).replace(/\s+/gu, '').slice(0, 8)
}

/** Where `anchor` occurs in a new chunk, or -1. */
function anchorPosition(content: string, anchor: string): number {
  return anchor === '' ? -1 : visibleText(content).replace(/\s+/gu, '').indexOf(anchor)
}

interface ChunkAliasCandidate {
  candidate: { id: number; key: string; content: string; ord: number; line: number }
  ratio: number
  mode: 'exact' | 'span' | 'single'
  spanChars: number
}

/**
 * Pick the new chunk that should receive an old citation.
 *
 * An exact content match wins (preferring the same ordinal when repeated text makes content
 * ambiguous). Otherwise the old chunk usually starts inside one new chunk and continues into the
 * next ones; map to the chunk that contains its start so the citation never lands on a later,
 * merely overlapping block. If neither the start nor enough of the text survives, return
 * undefined: the caller lets the citation expire as 404.
 */
function findChunkAliasCandidate(
  oldChunk: { content: string; ord: number | null; line: number },
  newChunks: readonly { id: number; key: string; content: string; ord: number; line: number }[],
  options: { scanAllAnchors: boolean; anchorIndex?: ReadonlyMap<string, readonly number[]> },
): ChunkAliasCandidate | undefined {
  // Large documents keep an O(1) fast path: a chunk that still occupies its old ordinal and has
  // identical text resolves without scanning the book. Everything else uses the anchor index.
  if (!options.scanAllAnchors) {
    const sameOrd = newChunks[oldChunk.ord ?? -1]
    if (sameOrd !== undefined && sameOrd.content === oldChunk.content) {
      return { candidate: sameOrd, ratio: 1, mode: 'exact', spanChars: sameOrd.content.replace(/\s+/gu, '').length }
    }
  }
  const exact = options.scanAllAnchors ? newChunks.filter(chunk => chunk.content === oldChunk.content) : []
  if (exact.length > 0) {
    const wanted = oldChunk.ord ?? 0
    const best = exact.reduce((nearest, chunk) => {
      const distance = Math.abs(chunk.line - oldChunk.line)
      const nearestDistance = Math.abs(nearest.line - oldChunk.line)
      if (distance !== nearestDistance) return distance < nearestDistance ? chunk : nearest
      return Math.abs(chunk.ord - wanted) < Math.abs(nearest.ord - wanted) ? chunk : nearest
    })
    return { candidate: best, ratio: 1, mode: 'exact', spanChars: best.content.replace(/\s+/gu, '').length }
  }
  const anchor = chunkStartAnchor(oldChunk.content)
  const starts: number[] = options.scanAllAnchors ? [] : [...(options.anchorIndex?.get(anchor) ?? [])]
  if (options.scanAllAnchors) {
    for (const [index, chunk] of newChunks.entries()) {
      if (anchorPosition(chunk.content, anchor) >= 0) starts.push(index)
    }
  }
  const wanted = oldChunk.ord ?? 0
  // Repeated headings occur more than once. A bucket can hold thousands of entries in a
  // repetitive book, so pick a window around the old ordinal before sorting.
  let candidates = starts
  if (candidates.length > CHUNK_ALIAS_MAX_CANDIDATES * 2) {
    let low = 0
    let high = candidates.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (candidates[middle]! < wanted) low = middle + 1
      else high = middle
    }
    candidates = candidates.slice(Math.max(0, low - CHUNK_ALIAS_MAX_CANDIDATES), low + CHUNK_ALIAS_MAX_CANDIDATES)
  }
  candidates.sort((left, right) => {
    const leftChunk = newChunks[left]!
    const rightChunk = newChunks[right]!
    const lineDelta = Math.abs(leftChunk.line - oldChunk.line) - Math.abs(rightChunk.line - oldChunk.line)
    return lineDelta !== 0 ? lineDelta : Math.abs(leftChunk.ord - wanted) - Math.abs(rightChunk.ord - wanted)
  })
  const oldChars = oldChunk.content.replace(/\s+/gu, '').length
  // A genuine re-chunk spans the old text plus neighbouring context and one overlap per boundary.
  // Anything far longer is accumulating unrelated later text from a coincidentally repeated
  // phrase, not covering this chunk.
  const maxSpanChars = Math.max(oldChars * 4 + 400, 600)
  let best: ChunkAliasCandidate | undefined
  for (const start of candidates.slice(0, CHUNK_ALIAS_MAX_CANDIDATES)) {
    const position = anchorPosition(newChunks[start]!.content, anchor)
    let spanChars = 0
    let previousRatio = 0
    let stagnant = 0
    for (let end = start; end < Math.min(newChunks.length, start + CHUNK_ALIAS_MAX_SPAN); end += 1) {
      spanChars += newChunks[end]!.content.replace(/\s+/gu, '').length
      if (spanChars > maxSpanChars) break
      const ratio = chunkOverlapRatio(oldChunk.content, newChunks.slice(start, end + 1).map(chunk => chunk.content))
      if (ratio < CHUNK_ALIAS_MIN_SPAN_RATIO) {
        previousRatio = Math.max(previousRatio, ratio)
        continue
      }
      const current = best
      const better = current === undefined || ratio > current.ratio + 0.02
        || (Math.abs(ratio - current.ratio) <= 0.02 && spanChars < current.spanChars)
        || (Math.abs(ratio - current.ratio) <= 0.02 && spanChars === current.spanChars
          && Math.abs(newChunks[start]!.line - oldChunk.line) < Math.abs(current.candidate.line - oldChunk.line))
        || (Math.abs(ratio - current.ratio) <= 0.02 && spanChars === current.spanChars
          && Math.abs(newChunks[start]!.line - oldChunk.line) === Math.abs(current.candidate.line - oldChunk.line)
          && position < anchorPosition(current.candidate.content, anchor))
      if (better) best = { candidate: newChunks[start]!, ratio, mode: 'span', spanChars }
      if (ratio >= 0.999) break
      if (ratio <= previousRatio + 0.02) stagnant += 1
      else stagnant = 0
      previousRatio = Math.max(previousRatio, ratio)
      // Three further chunks without new old text means this start is exhausted.
      if (stagnant >= 3 && ratio >= CHUNK_ALIAS_MIN_SPAN_RATIO) break
    }
  }
  if (best !== undefined && options.scanAllAnchors) {
    // A chapter title can be its own tiny new chunk. When the old chunk starts there but almost
    // all of its text lives in one following chunk, that following chunk is the useful landing
    // page; a 5-character title is not.
    const startRatio = chunkOverlapRatio(oldChunk.content, [best.candidate.content])
    if (startRatio < 0.1) {
      let single: { candidate: (typeof newChunks)[number]; ratio: number } | undefined
      for (const chunk of newChunks) {
        const ratio = chunkOverlapRatio(oldChunk.content, [chunk.content])
        if (single === undefined || ratio > single.ratio) single = { candidate: chunk, ratio }
      }
      if (single !== undefined && single.ratio >= 0.5) {
        return { candidate: single.candidate, ratio: single.ratio, mode: 'single', spanChars: single.candidate.content.replace(/\s+/gu, '').length }
      }
    }
  }
  return best
}

/** Extensions whose `<name>.md` is an extracted text sibling, not the source. */
const DERIVED_SOURCE_EXTENSIONS = new Set([
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp',
  '.html', '.htm', '.rtf',
])

/** Text extensions that can honestly carry a source line number. */
const TEXT_SOURCE_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text', '.csv', '.json', '.yaml', '.yml', '.html', '.htm',
  '.xml', '.log', '.sql', '.ts', '.tsx', '.js', '.jsx', '.css', '.py', '.sh', '.java', '.go', '.rs',
])

/**
 * Resolve the original document for one indexed text file.
 *
 * A derived sibling is named `<source>.<ext>.md`; the source is that name with the
 * trailing `.md` removed. A plain `.md`/`.txt` is its own source.
 */
export function sourcePathFor(markdownPath: string): string {
  if (!markdownPath.toLowerCase().endsWith('.md')) return markdownPath
  const base = markdownPath.slice(0, -3)
  const dot = base.lastIndexOf('.')
  const extension = dot < 0 ? '' : base.slice(dot).toLowerCase()
  return DERIVED_SOURCE_EXTENSIONS.has(extension) ? base : markdownPath
}

/** Whether a source path is text that can expose a real line anchor. */
export function isTextSourcePath(sourcePath: string): boolean {
  const dot = sourcePath.lastIndexOf('.')
  return dot >= 0 && TEXT_SOURCE_EXTENSIONS.has(sourcePath.slice(dot).toLowerCase())
}

/** Pull minimal spreadsheet anchors out of derived Markdown text. */
function sheetCellFor(content: string): { sheet?: string; cell?: string } {
  const sheetMatch = content.match(/<!--\s*sheet:\s*([^>\n]+?)\s*-->/i)
    ?? content.match(/^#{1,6}\s*(?:sheet|工作表)[:：\s]+(.+)$/im)
  const cellMatch = content.match(/<!--\s*cell:\s*([A-Z]{1,3}[0-9]+)\s*-->/i)
    ?? content.match(/^\s*([A-Z]{1,3}[0-9]+)\s*[|:]/m)
  return {
    ...(sheetMatch?.[1] === undefined ? {} : { sheet: sheetMatch[1].trim() }),
    ...(cellMatch?.[1] === undefined ? {} : { cell: cellMatch[1].trim() }),
  }
}

/** Collapse Markdown/table syntax into plain text suitable for a viewer search. */
export function plainQuoteText(content: string): string {
  return content
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^#{1,6}\s*/gmu, '')
    .replace(/^\s*\|\s*/gmu, '')
    .replace(/\s*\|\s*$/gmu, ' ')
    .replace(/\|/gu, ' ')
    .replace(/[*_`~]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Pick the most distinctive prose sentence in a chunk. A title/heading is short and
 * often repeated; a body sentence is the useful quote for findController when the
 * caller has no query (`kb_chunk_get`).
 */
export function quoteForContent(content: string, minChars = 48, maxChars = 120): string {
  const plain = plainQuoteText(content)
  if (plain === '') return ''
  const candidates = plain
    .split(/(?<=[。！？；.!?])\s*/u)
    .map(value => value.trim())
    .filter(value => value.length >= 8)
  const best = (candidates.length === 0 ? [plain] : candidates)
    .sort((left, right) => right.length - left.length)[0] ?? plain
  let quote = best
  if (quote.length < minChars) {
    const at = plain.indexOf(best)
    quote = plain.slice(Math.max(0, at - Math.floor((minChars - best.length) / 2)), at + minChars)
  }
  if (quote.length > maxChars) quote = quote.slice(0, maxChars)
  return quote.trim()
}

/** Strip FTS5 `[highlight]` markers/ellipses from a query-centered snippet. */
export function quoteFromSnippet(snippet: string, minChars = 48, maxChars = 120): string {
  const hit = snippet.match(/\[(.*?)\]/u)?.[1]
  const plain = plainQuoteText(snippet.replace(/\[(.*?)\]/gu, '$1').replace(/^\.\.\.|\.\.\.$/gu, ''))
  if (hit !== undefined && hit.trim() !== '') {
    const sentence = plain.split(/(?<=[。！？；.!?])\s*/u)
      .find(value => value.includes(hit.trim()))
    if (sentence !== undefined) {
      const at = sentence.indexOf(hit.trim())
      // A short prefix is usually a heading/title sharing this snippet; start at the
      // hit instead of returning the title. Longer prefixes are real context.
      const prefix = sentence.slice(0, at).trim()
      const start = prefix.length > 0 && prefix.length < 16 ? at : Math.max(0, at - 12)
      let quote = sentence.slice(start).replace(/…+$/u, '').trim()
      if (quote.length < minChars) quote = plain.slice(Math.max(0, plain.indexOf(sentence) + start)).trim()
      return quote.slice(0, maxChars)
    }
  }
  if (plain.length >= minChars) return plain.slice(0, maxChars).trim()
  return plain
}

/** Split a chunk into plain-text paragraphs for viewer-side whole-chunk boxes. */
export function paragraphsFor(content: string): Array<{ ordinal: number; text: string }> {
  const blocks = content.split(/\n\s*\n/u).map(block => plainQuoteText(block)).filter(text => text !== '')
  const source = blocks.length > 0 ? blocks : content.split('\n').map(block => plainQuoteText(block)).filter(text => text !== '')
  return source.map((text, ordinal) => ({ ordinal, text }))
}

/** Query tokens used by the viewer to draw yellow/orange hit boxes. */
export function queryTerms(query: string): string[] {
  const raw = query.trim()
  if (raw === '') return []
  const spaced = raw.split(/\s+/u).map(term => term.replace(/^[`"'“”]+|[`"'“”]+$/gu, '')).filter(term => term !== '')
  return [...new Set(spaced.length > 0 ? spaced : [raw])].slice(0, 12)
}

/** Locate all term occurrences inside the plain snippet; ranges index highlightText. */
export function highlightRangesFor(text: string, terms: readonly string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const lower = text.toLowerCase()
  for (const term of terms) {
    if (term === '') continue
    const needle = term.toLowerCase()
    let from = 0
    for (;;) {
      const at = lower.indexOf(needle, from)
      if (at < 0) break
      ranges.push({ start: at, end: at + needle.length })
      from = at + Math.max(1, needle.length)
    }
  }
  return ranges.sort((left, right) => left.start - right.start || left.end - right.end)
}

/** Build the query-relevance fields a viewer uses for the second (yellow) layer. */
export function queryHighlights(query: string, snippet: string, content: string): {
  matchedTerms: string[]
  highlightText: string
  highlightRanges: Array<{ start: number; end: number }>
} {
  const terms = queryTerms(query)
  const plainContent = plainQuoteText(content)
  const matchedTerms = terms.filter(term => plainContent.toLowerCase().includes(term.toLowerCase()))
  if (matchedTerms.length === 0) return { matchedTerms: [], highlightText: '', highlightRanges: [] }
  const plainSnippet = plainQuoteText(snippet.replace(/\[(.*?)\]/gu, '$1').replace(/…/gu, ' '))
  const first = matchedTerms[0]!.toLowerCase()
  let at = plainSnippet.toLowerCase().indexOf(first)
  let highlightText = plainSnippet
  if (at < 0) { at = plainContent.toLowerCase().indexOf(first); highlightText = plainContent }
  if (at < 0) return { matchedTerms: [], highlightText: '', highlightRanges: [] }
  const start = Math.max(0, at - 24)
  highlightText = highlightText.slice(start, start + 240).trim()
  return {
    matchedTerms,
    highlightText,
    highlightRanges: highlightRangesFor(highlightText, matchedTerms),
  }
}

/** Append the query-highlight hints to a citation token for the viewer. */
export function citationWithHighlights(citation: string, highlights: {
  matchedTerms: string[]
  highlightText: string
  highlightRanges: Array<{ start: number; end: number }>
}): string {
  if (highlights.matchedTerms.length === 0) return citation
  const params = new URLSearchParams()
  params.set('terms', highlights.matchedTerms.join(','))
  params.set('highlight', highlights.highlightText)
  params.set('ranges', JSON.stringify(highlights.highlightRanges.map(range => [range.start, range.end])))
  return citation + '?' + params.toString()
}

/** Backwards-compatible simple quote for callers that only have content. */
export function quoteFor(content: string, maxChars = 120): string {
  return quoteForContent(content, 48, maxChars)
}

/** First content line that reads like a paragraph rather than a heading/table rule. */
function paragraphTextFor(content: string): string | undefined {
  const line = content.split('\n')
    .map(value => value.trim())
    .find(value => value !== '' && !value.startsWith('#') && !value.startsWith('|') && !value.startsWith('<!--'))
  return line === undefined ? undefined : quoteFor(line, 240)
}

const hashOf = (value: string): string => createHash('sha256').update(value).digest('hex')

const INDEX_BUSY_TIMEOUT_MS = 8_000
let indexTail: Promise<unknown> = Promise.resolve()

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY|database is locked|database table is locked/iu.test(message)
}

/** Retry one SQLite operation on BUSY with short exponential backoff. */
async function withBusyRetry<T>(operation: () => T | Promise<T>, attempts = 3): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation() } catch (error) {
      last = error
      if (!isBusyError(error) || attempt === attempts - 1) throw error
      await new Promise(resolve => setTimeout(resolve, 80 * (2 ** attempt)))
    }
  }
  throw last
}

/** Serialize index writers/readers inside this process; WAL still serves cross-process readers. */
function withIndexLock<T>(operation: () => Promise<T> | T): Promise<T> {
  const run = indexTail.then(operation, operation)
  indexTail = run.then(() => undefined, () => undefined)
  return run
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA busy_timeout = 8000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kb_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      source_path TEXT,
      markdown_path TEXT,
      mtime INTEGER NOT NULL,
      hash TEXT NOT NULL,
      sha256 TEXT,
      mime TEXT,
      pages INTEGER,
      title TEXT NOT NULL,
      scope TEXT NOT NULL,
      owner_id TEXT,
      department_code TEXT,
      summary TEXT,
      toc_json TEXT,
      summary_version TEXT,
      summary_kind TEXT
    );
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      line INTEGER NOT NULL,
      ord INTEGER,
      chunk_key TEXT,
      page_start INTEGER,
      page_end INTEGER,
      heading TEXT,
      sheet TEXT,
      cell TEXT,
      content TEXT NOT NULL,
      ocr_confidence REAL,
      page INTEGER,
      bbox TEXT,
      block_index INTEGER,
      occurrence INTEGER
    );
    CREATE TABLE IF NOT EXISTS kb_chunk_unions (
      chunk_id INTEGER NOT NULL,
      page INTEGER NOT NULL,
      bbox_json TEXT NOT NULL,
      page_width REAL,
      page_height REAL,
      PRIMARY KEY (chunk_id, page)
    );
    CREATE TABLE IF NOT EXISTS kb_chunk_aliases (
      doc_id INTEGER NOT NULL,
      old_chunk_id INTEGER NOT NULL,
      chunk_key TEXT NOT NULL,
      PRIMARY KEY (doc_id, old_chunk_id)
    );
    CREATE TABLE IF NOT EXISTS kb_chunk_key_aliases (
      doc_id INTEGER NOT NULL,
      old_chunk_key TEXT NOT NULL,
      chunk_key TEXT NOT NULL,
      overlap REAL,
      PRIMARY KEY (doc_id, old_chunk_key)
    );
    CREATE TABLE IF NOT EXISTS kb_chunk_boxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER NOT NULL,
      page INTEGER NOT NULL,
      bbox_json TEXT NOT NULL,
      block_index INTEGER,
      occurrence INTEGER,
      confidence REAL,
      page_width REAL,
      page_height REAL
    );
    CREATE INDEX IF NOT EXISTS kb_boxes_chunk ON kb_chunk_boxes(chunk_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(content, tokenize = 'trigram');
    CREATE TABLE IF NOT EXISTS kb_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS kb_chunks_doc ON kb_chunks(doc_id);
    CREATE INDEX IF NOT EXISTS kb_docs_scope ON kb_docs(scope, owner_id, department_code);
    CREATE TABLE IF NOT EXISTS kb_sections (
      id TEXT PRIMARY KEY,
      doc_id INTEGER NOT NULL,
      heading_path TEXT NOT NULL,
      level INTEGER NOT NULL,
      summary TEXT NOT NULL,
      key_facts_json TEXT,
      chunk_ids_json TEXT NOT NULL,
      source_chunk_ids_json TEXT NOT NULL,
      summary_version TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS kb_sections_doc ON kb_sections(doc_id);
    CREATE TABLE IF NOT EXISTS kb_summary_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL,
      section_id TEXT,
      kind TEXT NOT NULL,
      heading_path TEXT,
      summary TEXT NOT NULL,
      key_facts_json TEXT,
      text TEXT NOT NULL,
      source_chunk_ids_json TEXT NOT NULL,
      summary_version TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS kb_summary_chunks_doc ON kb_summary_chunks(doc_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_summary_fts USING fts5(content, tokenize = 'trigram');
  `)
  ensureVectorSchema(db)
}

export const CHUNKER_VERSION = 'structure-v3-keyed'

function ensureChunkColumns(db: DatabaseSync): void {
  const columns = new Set((db.prepare('PRAGMA table_info(kb_chunks)').all() as Array<{ name: string }>).map(row => row.name))
  for (const [name, type] of [
    ['page', 'INTEGER'], ['bbox', 'TEXT'], ['block_index', 'INTEGER'], ['occurrence', 'INTEGER'],
    ['ord', 'INTEGER'], ['chunk_key', 'TEXT'], ['page_start', 'INTEGER'], ['page_end', 'INTEGER'], ['heading', 'TEXT'], ['sheet', 'TEXT'], ['cell', 'TEXT'], ['ocr_confidence', 'REAL'],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE kb_chunks ADD COLUMN ${name} ${type}`)
  }
  const docColumns = new Set((db.prepare('PRAGMA table_info(kb_docs)').all() as Array<{ name: string }>).map(row => row.name))
  let addedSummaryKind = false
  for (const [name, type] of [['sha256', 'TEXT'], ['mime', 'TEXT'], ['pages', 'INTEGER'], ['source_path', 'TEXT'], ['markdown_path', 'TEXT'], ['chunker_version', 'TEXT'], ['summary', 'TEXT'], ['toc_json', 'TEXT'], ['summary_version', 'TEXT'], ['summary_kind', 'TEXT']] as const) {
    if (!docColumns.has(name)) {
      db.exec(`ALTER TABLE kb_docs ADD COLUMN ${name} ${type}`)
      if (name === 'summary_kind') addedSummaryKind = true
    }
  }
  if (addedSummaryKind) {
    // Every pre-0.2 summary was produced by the deterministic extractor. Marking it keeps
    // those rows readable without pretending they were model-written; an explicit
    // `kb_outline_save` later replaces the document with `llm`.
    db.prepare("UPDATE kb_docs SET summary_kind = 'extractive' WHERE summary_kind IS NULL AND summary IS NOT NULL AND TRIM(summary) <> ''").run()
  }
}

async function walkTextFiles(root: string, prefix = ''): Promise<Array<{ relPath: string; absolute: string; mtimeMs: number; size: number }>> {
  const out: Array<{ relPath: string; absolute: string; mtimeMs: number; size: number }> = []
  let entries
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const relPath = prefix === '' ? entry.name : prefix + '/' + entry.name
    const absolute = join(root, relPath)
    if (entry.isDirectory()) {
      out.push(...await walkTextFiles(root, relPath))
      continue
    }
    if (!entry.isFile()) continue
    const dot = entry.name.lastIndexOf('.')
    const extension = dot < 0 ? '' : entry.name.slice(dot).toLowerCase()
    if (!TEXT_EXTENSIONS.has(extension)) continue
    try {
      const info = await stat(absolute)
      out.push({ relPath, absolute, mtimeMs: Math.trunc(info.mtimeMs), size: info.size })
    } catch {
      // A file removed while walking is simply absent from this pass.
    }
  }
  return out
}

/** Rebuild/refresh the FTS index incrementally from the authoritative tree. */
export async function syncIndex(options: {
  actualRoot: string
  indexPath: string
  now?: () => Date
  /**
   * Opt-in legacy extractive summaries. The production config default is false: upload
   * and extraction create the TOC/section structure only, and a model-authored summary
   * arrives later through `kb_outline_save`.
   */
  autoGenerateSummaries?: boolean
}): Promise<FtsIndexStats> {
  return withIndexLock(() => withBusyRetry(() => syncIndexUnlocked(options)))
}

async function syncIndexUnlocked(options: {
  actualRoot: string
  indexPath: string
  now?: () => Date
  autoGenerateSummaries?: boolean
}): Promise<FtsIndexStats> {
  const { actualRoot, indexPath } = options
  await mkdir(resolve(indexPath, '..'), { recursive: true })
  const db = new DatabaseSync(indexPath)
  try {
    ensureSchema(db)
    ensureChunkColumns(db)
    const files = await walkTextFiles(actualRoot)
    const seen = new Set(files.map(file => file.relPath))
    let indexed = 0
    let unchanged = 0
    let removed = 0
    const outlineWrites: Array<{ docId: number; markdown: string }> = []
    const outlineRemovals: number[] = []
    const getDoc = db.prepare('SELECT id, path, mtime, hash, title, source_path, markdown_path, chunker_version, summary_version, summary_kind FROM kb_docs WHERE path = ?')
    const deleteChunks = db.prepare('SELECT id FROM kb_chunks WHERE doc_id = ?')
    const deleteFts = db.prepare('DELETE FROM kb_chunks_fts WHERE rowid = ?')
    const deleteChunk = db.prepare('DELETE FROM kb_chunks WHERE id = ?')
    const deleteDoc = db.prepare('DELETE FROM kb_docs WHERE id = ?')
    const insertDoc = db.prepare('INSERT INTO kb_docs(path, source_path, markdown_path, mtime, hash, sha256, mime, pages, title, scope, owner_id, department_code, chunker_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const updateDoc = db.prepare('UPDATE kb_docs SET source_path = ?, markdown_path = ?, mtime = ?, hash = ?, sha256 = ?, mime = ?, pages = ?, title = ?, scope = ?, owner_id = ?, department_code = ?, chunker_version = ? WHERE id = ?')
    const insertChunk = db.prepare('INSERT INTO kb_chunks(doc_id, path, line, ord, chunk_key, heading, sheet, cell, content, page_start, page_end, page, bbox, block_index, occurrence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const insertAlias = db.prepare('INSERT INTO kb_chunk_aliases(doc_id, old_chunk_id, chunk_key) VALUES (?, ?, ?) ON CONFLICT(doc_id, old_chunk_id) DO UPDATE SET chunk_key = excluded.chunk_key')
    const insertKeyAlias = db.prepare('INSERT INTO kb_chunk_key_aliases(doc_id, old_chunk_key, chunk_key, overlap) VALUES (?, ?, ?, ?) ON CONFLICT(doc_id, old_chunk_key) DO UPDATE SET chunk_key = excluded.chunk_key, overlap = excluded.overlap')
    const deleteAliasesForDoc = db.prepare('DELETE FROM kb_chunk_aliases WHERE doc_id = ?')
    const deleteKeyAliasesForDoc = db.prepare('DELETE FROM kb_chunk_key_aliases WHERE doc_id = ?')
    const insertFts = db.prepare('INSERT INTO kb_chunks_fts(rowid, content) VALUES (?, ?)')
    const readBoxes = db.prepare(`
      SELECT c.line AS line, COALESCE(c.ord, 0) AS ord, b.page AS page, b.bbox_json AS bbox_json,
             b.block_index AS block_index, b.occurrence AS occurrence, b.confidence AS confidence,
             b.page_width AS page_width, b.page_height AS page_height
      FROM kb_chunks c JOIN kb_chunk_boxes b ON b.chunk_id = c.id
      WHERE c.doc_id = ? ORDER BY c.line, c.ord, b.id
    `)
    const insertBox = db.prepare('INSERT INTO kb_chunk_boxes(chunk_id, page, bbox_json, block_index, occurrence, confidence, page_width, page_height) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    // Existing indexes predate the persisted union table; backfill once so the
    // viewer can draw a page union without DOM-merging boxes on every click.
    const unionCount = (db.prepare('SELECT COUNT(*) AS n FROM kb_chunk_unions').get() as { n: number }).n
    if (unionCount === 0) {
      const boxed = db.prepare('SELECT DISTINCT chunk_id FROM kb_chunk_boxes').all() as Array<{ chunk_id: number }>
      for (const row of boxed) rebuildUnionsForChunk(db, row.chunk_id)
    }
    const deleteBoxesForDoc = db.prepare('DELETE FROM kb_chunk_boxes WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE doc_id = ?)')
    const deleteUnionsForDoc = db.prepare('DELETE FROM kb_chunk_unions WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE doc_id = ?)')
    const readBoxesForChunk = db.prepare('SELECT page, bbox_json, block_index, occurrence, confidence, page_width, page_height FROM kb_chunk_boxes WHERE chunk_id = ? ORDER BY page, id')
    for (const file of files) {
      let text: string
      try {
        text = await readFile(file.absolute, 'utf8')
      } catch {
        continue
      }
      const hash = hashOf(text)
      const sourcePath = sourcePathFor(file.relPath)
      const expectedSummaryVersion = summaryVersionFor(hash)
      const existing = getDoc.get(file.relPath) as {
        id: number; path: string; mtime: number; hash: string; title: string;
        source_path?: string | null; markdown_path?: string | null;
        chunker_version?: string | null; summary_version?: string | null;
        summary_kind?: string | null;
      } | undefined
      const chunkStateUnchanged = existing !== undefined && existing.mtime === file.mtimeMs && existing.hash === hash
        && existing.source_path === sourcePath && existing.markdown_path === file.relPath && existing.chunker_version === CHUNKER_VERSION
      if (chunkStateUnchanged) {
        unchanged += 1
        const sectionCount = Number((db.prepare('SELECT COUNT(*) AS n FROM kb_sections WHERE doc_id = ?')
          .get(existing.id) as { n: number }).n)
        const kind = summaryKindOf(existing.summary_kind)
        const auto = options.autoGenerateSummaries === true
        // A legacy index (chunks but no outline) still needs its TOC/section rows. Rebuild
        // ONLY those rows: re-chunking would replace every chunk id and needlessly expire
        // citations for a document whose bytes did not change. An existing `llm` summary is
        // preserved regardless of the summary-rule version.
        const needsStructure = sectionCount === 0
        // An existing extractive summary is source-derived evidence. A summary-rule or
        // package-version bump alone must not erase it: only a source/chunker change (which
        // makes chunkStateUnchanged false) or an explicit force rebuild may replace it.
        const needsExtractiveRefresh = auto
          && kind === 'none'
          && (existing.summary_version ?? '') !== expectedSummaryVersion
        if (needsStructure || needsExtractiveRefresh) {
          db.exec('BEGIN')
          try {
            const builtRaw = buildDocumentOutline({
              docId: existing.id,
              docTitle: existing.title,
              sourcePath,
              chunks: outlineChunksForDocument(db, existing.id),
            })
            const summaryKind: OutlineSummaryKind = auto ? 'extractive' : 'none'
            const built = summaryKind === 'none' ? structureOnly(builtRaw) : builtRaw
            const version = summaryKind === 'extractive' ? expectedSummaryVersion : structureVersionFor(existing.hash)
            const markdown = storeOutlineForDocument(db, {
              id: existing.id,
              path: existing.path,
              source_path: existing.source_path ?? sourcePath,
              markdown_path: existing.markdown_path ?? file.relPath,
              title: existing.title,
            }, built, version, summaryKind)
            db.exec('COMMIT')
            outlineWrites.push({ docId: existing.id, markdown })
          } catch {
            db.exec('ROLLBACK')
          }
        }
        continue
      }
      const scope = scopeForPath(sourcePath)
      const title = file.relPath.slice(file.relPath.lastIndexOf('/') + 1)
      let docId: number
      let oldChunks: Array<{ id: number; content: string; chunk_key: string | null; ord: number | null; line: number }> = []
      const oldBoxMap = new Map<number, Array<{ page: number; bbox_json: string; block_index: number | null; occurrence: number | null; confidence: number | null; page_width: number | null; page_height: number | null }>>()
      let carriedBoxes: Array<{
        line: number; ord: number; page: number; bbox_json: string;
        block_index: number | null; occurrence: number | null; confidence: number | null;
        page_width: number | null; page_height: number | null;
      }> = []
      // One transaction per document: a malformed PDF/Markdown cannot roll back the
      // documents that were already indexed in this batch.
      db.exec('BEGIN')
      try {
      if (existing === undefined) {
        const mime = file.relPath.toLowerCase().endsWith('.md') || file.relPath.toLowerCase().endsWith('.markdown') ? 'text/markdown' : 'text/plain'
        const result = insertDoc.run(file.relPath, sourcePath, file.relPath, file.mtimeMs, hash, hash, mime, 1, title, scope.scope, scope.ownerId, scope.departmentCode, CHUNKER_VERSION)
        docId = Number(result.lastInsertRowid)
      } else {
        docId = existing.id
        const mime = file.relPath.toLowerCase().endsWith('.md') || file.relPath.toLowerCase().endsWith('.markdown') ? 'text/markdown' : 'text/plain'
        // Reindexing replaces chunk ids; carry provenance boxes across by
        // (line, ord) so a source_path migration cannot silently lose bboxes.
        carriedBoxes = readBoxes.all(docId) as typeof carriedBoxes
        oldChunks = db.prepare('SELECT id, content, chunk_key, ord, line FROM kb_chunks WHERE doc_id = ?').all(docId) as Array<{ id: number; content: string; chunk_key: string | null; ord: number | null; line: number }>
        for (const oldChunk of oldChunks) {
          oldBoxMap.set(oldChunk.id, readBoxesForChunk.all(oldChunk.id) as Array<{ page: number; bbox_json: string; block_index: number | null; occurrence: number | null; confidence: number | null; page_width: number | null; page_height: number | null }>)
        }
        updateDoc.run(sourcePath, file.relPath, file.mtimeMs, hash, hash, mime, 1, title, scope.scope, scope.ownerId, scope.departmentCode, CHUNKER_VERSION, docId)
        deleteBoxesForDoc.run(docId)
        deleteUnionsForDoc.run(docId)
        for (const chunk of deleteChunks.all(docId) as Array<{ id: number }>) {
          deleteFts.run(chunk.id)
          deleteChunk.run(chunk.id)
        }
        // carriedBoxes now holds boxes keyed by the old chunk's (line, ord).
      }
      const newChunks: Array<{ id: number; key: string; content: string; ord: number; line: number; heading: string | null }> = []
      const keyCounts = new Map<string, number>()
      for (const [ord, chunk] of chunkText(text).entries()) {
        const heading = chunk.content.split('\n').find(line => line.trim() !== '')?.slice(0, 200) ?? null
        const anchors = sheetCellFor(chunk.content)
        const baseKey = stableChunkKey(heading, chunk.content)
        const count = (keyCounts.get(baseKey) ?? 0) + 1
        keyCounts.set(baseKey, count)
        const chunkKey = count === 1 ? baseKey : `${baseKey}-${String(count)}`
        const result = insertChunk.run(docId, file.relPath, chunk.line, ord, chunkKey, heading, anchors.sheet ?? null, anchors.cell ?? null, chunk.content, null, null, null, null, null, null)
        const newChunkId = Number(result.lastInsertRowid)
        insertFts.run(newChunkId, chunk.content)
        newChunks.push({ id: newChunkId, key: chunkKey, content: chunk.content, ord, line: chunk.line, heading })
        rebuildUnionsForChunk(db, newChunkId)
      }
      // Alias migration maps each old chunk to the new chunk that contains its start. The
      // candidate scan is anchored on the old chunk's first line, so it stays linear for a huge
      // book instead of comparing every old chunk with every new chunk. Only a chunk whose text
      // really survives gets an alias; a rewritten or removed paragraph leaves the old token
      // unresolvable (404) instead of opening the nearest unrelated chunk.
      const remap = (oldChunk: { id: number; content: string; chunk_key: string | null }, candidate: { id: number; key: string; content: string; ord: number; line: number }, ratio: number): void => {
        insertAlias.run(docId, oldChunk.id, candidate.key)
        if (oldChunk.chunk_key !== null && oldChunk.chunk_key !== '') {
          insertKeyAlias.run(docId, oldChunk.chunk_key, candidate.key, ratio)
        }
        // Provenance moves with the text so a pure re-chunk does not lose the PDF boxes.
        for (const box of oldBoxMap.get(oldChunk.id) ?? []) {
          insertBox.run(candidate.id, box.page, box.bbox_json, box.block_index, box.occurrence, box.confidence, box.page_width, box.page_height)
        }
      }
      const scanAllAnchors = oldChunks.length * newChunks.length <= 20_000
      const anchorIndex = new Map<string, number[]>()
      if (!scanAllAnchors) {
        for (const [index, chunk] of newChunks.entries()) {
          const anchor = chunkStartAnchor(chunk.content)
          if (anchor === '') continue
          const bucket = anchorIndex.get(anchor)
          if (bucket === undefined) anchorIndex.set(anchor, [index])
          else bucket.push(index)
        }
      }
      for (const oldChunk of oldChunks) {
        const match = findChunkAliasCandidate(oldChunk, newChunks, { scanAllAnchors, anchorIndex })
        if (match !== undefined) remap(oldChunk, match.candidate, match.ratio)
      }
      // Carried boxes land after the per-chunk rebuild above; refresh the persisted unions.
      for (const candidate of newChunks) rebuildUnionsForChunk(db, candidate.id)
      // The outline is rebuilt from the chunks just written, inside the same transaction, so
      // `kb_docs.summary`, `kb_sections` and the summary FTS rows cannot disagree with them.
      const builtRaw = buildDocumentOutline({
        docId,
        docTitle: title,
        sourcePath,
        chunks: newChunks.map(chunk => ({
          id: chunk.id,
          chunkKey: chunk.key,
          ordinal: chunk.ord,
          ...(chunk.heading === null ? {} : { heading: chunk.heading }),
          content: chunk.content,
        })),
      })
      const summaryKind: OutlineSummaryKind = options.autoGenerateSummaries === true ? 'extractive' : 'none'
      const built = summaryKind === 'none' ? structureOnly(builtRaw) : builtRaw
      const summaryVersion = summaryKind === 'extractive' ? expectedSummaryVersion : structureVersionFor(hash)
      const outlineMarkdown = storeOutlineForDocument(db, {
        id: docId,
        path: file.relPath,
        source_path: sourcePath,
        markdown_path: file.relPath,
        title,
      }, built, summaryVersion, summaryKind)
      indexed += 1
      db.exec('COMMIT')
      outlineWrites.push({ docId, markdown: outlineMarkdown })
      } catch {
        db.exec('ROLLBACK')
      }
    }
    // Remove documents whose source disappeared. Their chunks and FTS rows go too.
    const known = db.prepare('SELECT id, path FROM kb_docs').all() as Array<{ id: number; path: string }>
    for (const doc of known) {
      if (seen.has(doc.path)) continue
      db.exec('BEGIN')
      try {
        deleteBoxesForDoc.run(doc.id)
        deleteUnionsForDoc.run(doc.id)
        deleteAliasesForDoc.run(doc.id)
        deleteKeyAliasesForDoc.run(doc.id)
        for (const chunk of deleteChunks.all(doc.id) as Array<{ id: number }>) {
          deleteFts.run(chunk.id)
          deleteChunk.run(chunk.id)
        }
        deleteOutlineRows(db, doc.id)
        deleteDoc.run(doc.id)
        removed += 1
        db.exec('COMMIT')
        outlineRemovals.push(doc.id)
      } catch {
        db.exec('ROLLBACK')
      }
    }
    // INDEX.md lives beside the SQLite file, never in the authoritative tree. A failed write
    // leaves the DB rows authoritative and `kb_outline` rewrites the file on demand.
    for (const write of outlineWrites) {
      try { await writeOutlineFile(indexPath, write.docId, write.markdown) } catch { /* regenerated lazily */ }
    }
    for (const docId of outlineRemovals) {
      await rm(outlineFilePath(indexPath, docId), { force: true }).catch(() => undefined)
    }
    db.exec("INSERT INTO kb_index_meta(key, value) VALUES ('updatedAt', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    const docs = Number((db.prepare('SELECT COUNT(*) AS n FROM kb_docs').get() as { n: number }).n)
    const chunks = Number((db.prepare('SELECT COUNT(*) AS n FROM kb_chunks').get() as { n: number }).n)
    return {
      indexPath,
      docs,
      chunks,
      indexed,
      unchanged,
      removed,
      updatedAt: (options.now?.() ?? new Date()).toISOString(),
    }
  } finally {
    db.close()
  }
}

/** Read only the counts, without a rebuild. */
export async function indexStats(indexPath: string): Promise<{ docs: number; chunks: number; indexPath: string }> {
  await mkdir(resolve(indexPath, '..'), { recursive: true })
  const db = new DatabaseSync(indexPath)
  try {
    ensureSchema(db)
    ensureChunkColumns(db)
    return {
      indexPath,
      docs: Number((db.prepare('SELECT COUNT(*) AS n FROM kb_docs').get() as { n: number }).n),
      chunks: Number((db.prepare('SELECT COUNT(*) AS n FROM kb_chunks').get() as { n: number }).n),
    }
  } finally {
    db.close()
  }
}

/**
 * Search FTS5 and apply the caller's scope in SQL before BM25 ordering.
 *
 * `canRead` is the final path-level grant check. The SQL window is `topK * 4`, so a
 * few unreadable descendants cannot starve the result; the returned list is still
 * capped at `topK`.
 */
/**
 * 把一段连续中文切成长度 3 的滑动窗口（去重，最多 `limit` 个，默认 12）。
 *
 * trigram FTS 只能匹配长度 ≥3 的片段：整句中文当 phrase 查通常 0 命中，
 * 而窗口化之后「加油站」这样的 trigram 就能命中索引，再按 chunk 合并回来。
 *
 * 成本上限（有意为之，别去掉）：只有在「整句 phrase 查询返回 0 行」时才会走到这里，
 * 且最多展开 `limit` 个窗口 → 最多多跑 `limit` 次 FTS 查询；每个窗口仍受原来的
 * `candidateWindow`（topK*4）限制，所以单次检索的 SQL 次数与返回量都是常数级的。
 * 12 个窗口足够覆盖一句 14 字左右的中文提问里最有信息量的前缀片段；再长也不会增加开销。
 */
export function trigramWindows(text: string, limit = 12): string[] {
  const chars = [...text].filter(char => /[\p{Script=Han}A-Za-z0-9]/u.test(char))
  if (chars.length < 3) return []
  const windows: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i + 3 <= chars.length; i += 1) {
    const window = chars.slice(i, i + 3).join('')
    if (seen.has(window)) continue
    seen.add(window)
    windows.push(window)
    if (windows.length >= limit) break
  }
  return windows
}

export async function searchIndex(options: {
  indexPath: string
  query: string
  topK: number
  scope?: string
  /** Locale for `displayPath`; the canonical `path` is unchanged. */
  locale?: ScopeLocale
  caller: FtsCallerScope
  canRead: (relPath: string) => Promise<boolean>
  /** Present only when vector retrieval is enabled and the query embedded successfully. */
  vector?: VectorSearchInput
}): Promise<FtsSearchResult> {
  return withIndexLock(() => withBusyRetry(() => searchIndexUnlocked(options)))
}

/**
 * Intent boost for a relaxed query that asks about a voting/threshold rule.
 *
 * BM25 over a trigram index rewards a title/preamble chunk that repeats the organisation and
 * meeting names; the article that actually answers "what is the voting threshold" can sit below
 * it, and a chunk about meeting minutes can outrank the operative clause. This boost only
 * activates when the query itself asks for a threshold, so unrelated searches keep pure BM25.
 */
function thresholdRerankBoost(query: string, content: string): number {
  if (!/表决|门槛|过半数|三分之二|半数|票/u.test(query)) return 0
  let boost = 0
  if (/普通决议|特别决议|决议分为/u.test(content)) boost += 4
  if (/方可通过|表决通过|通过普通决议|通过特别决议|通过门槛/u.test(content)) boost += 4
  if (/过半数|三分之二|二分之一/u.test(content)) boost += 2
  if (/全体成员|应出席人数/u.test(content)) boost += 1
  if (/会议记录|会议纪要|档案|保密|通知|列席|回避|合法性|合规性/u.test(content)) boost -= 3
  return boost
}

async function searchIndexUnlocked(options: {
  indexPath: string
  query: string
  topK: number
  scope?: string
  locale?: ScopeLocale
  caller: FtsCallerScope
  canRead: (relPath: string) => Promise<boolean>
  vector?: VectorSearchInput
}): Promise<FtsSearchResult> {
  const query = options.query.trim()
  if (query === '') return { hits: [], relaxed: false, queries: [] }
  const topK = Math.max(1, Math.min(50, Math.trunc(options.topK)))
  const candidateWindow = options.vector === undefined
    ? topK * 4
    : Math.max(topK * 4, Math.max(1, Math.trunc(options.vector.candidateK)))
  const db = new DatabaseSync(options.indexPath)
  try {
    ensureSchema(db)
    ensureChunkColumns(db)
    // 可检索范围 = 全局 ∪ 自己的 personal ∪ 自己所属部门。
    // 管理员（caller.global=true）同样有自己的个人空间，不能因为 global 就整体排除；
    // 也不能反过来把所有人的 personal 都放进来——别人的 personal 永远不在并集里。
    const clauses = ["d.scope = 'global'"]
    const params: Array<string | number> = []
    clauses.push("(d.scope = 'personal' AND d.owner_id = ?)")
    params.push(options.caller.callerId)
    if (options.caller.departmentCodes.length > 0) {
      clauses.push(`(d.scope = 'department' AND d.department_code IN (${options.caller.departmentCodes.map(() => '?').join(',')}))`)
      params.push(...options.caller.departmentCodes)
    }
    const narrowed = options.scope === 'personal' || options.scope === 'department' || options.scope === 'global'
      ? options.scope
      : undefined
    const scopeClause = narrowed === undefined ? '' : ' AND d.scope = ?'
    const scopeParams = narrowed === undefined ? [] : [narrowed]
    const sql = `
      SELECT c.path AS path, c.line AS line, c.content AS content, c.id AS chunk_id, c.doc_id AS doc_id, d.mime AS mime, d.source_path AS source_path, d.markdown_path AS markdown_path, c.chunk_key AS chunk_key, c.heading AS heading, c.ord AS ord, c.sheet AS sheet, c.cell AS cell, d.summary AS doc_summary, bm25(kb_chunks_fts) AS score,
             COALESCE(b.page, c.page) AS page, COALESCE(b.bbox_json, c.bbox) AS bbox,
             COALESCE(b.block_index, c.block_index) AS block_index, COALESCE(b.occurrence, c.occurrence) AS occurrence,
             snippet(kb_chunks_fts, 0, '[', ']', '…', 18) AS snippet
      FROM kb_chunks_fts
      JOIN kb_chunks c ON c.id = kb_chunks_fts.rowid
      JOIN kb_docs d ON d.id = c.doc_id
      LEFT JOIN kb_chunk_boxes b ON b.chunk_id = c.id
      WHERE kb_chunks_fts MATCH ? AND (${clauses.join(' OR ')})${scopeClause}
      ORDER BY score ASC
      LIMIT ?
    `
    type Row = { path: string; line: number; content: string; chunk_id: number; doc_id: number; mime?: string | null; source_path?: string | null; markdown_path?: string | null; chunk_key?: string | null; heading?: string | null; ord?: number | null; sheet?: string | null; cell?: string | null; doc_summary?: string | null; score: number; snippet: string; page?: number | null; bbox?: string | null; block_index?: number | null; occurrence?: number | null }
    const likeFallback = (term: string): Row[] => db.prepare(`
      SELECT c.path AS path, c.line AS line, c.content AS content, c.id AS chunk_id, c.doc_id AS doc_id, d.mime AS mime, d.source_path AS source_path, d.markdown_path AS markdown_path, c.chunk_key AS chunk_key, c.heading AS heading, c.ord AS ord, c.sheet AS sheet, c.cell AS cell, d.summary AS doc_summary, 0 AS score,
             COALESCE(b.page, c.page) AS page, COALESCE(b.bbox_json, c.bbox) AS bbox,
             COALESCE(b.block_index, c.block_index) AS block_index, COALESCE(b.occurrence, c.occurrence) AS occurrence,
             substr(c.content, 1, 240) AS snippet
      FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id LEFT JOIN kb_chunk_boxes b ON b.chunk_id = c.id
      WHERE c.content LIKE ? AND (${clauses.join(' OR ')})${scopeClause}
      LIMIT ?
    `).all('%' + term + '%', ...params, ...scopeParams, candidateWindow) as Row[]
    const runTerm = (term: string): Row[] => {
      if ([...term].length < 3) return likeFallback(term)
      const ftsQuery = '"' + term.replace(/"/gu, '""') + '"'
      try {
        return db.prepare(sql).all(ftsQuery, ...params, ...scopeParams, candidateWindow) as Row[]
      } catch {
        return likeFallback(term)
      }
    }

    const rows = runTerm(query)
    // A phrase search over a multi-word query is effectively an AND. When it gives
    // fewer than two rows, search each token and merge: the reader still gets the
    // chunk that matches part of the question instead of an empty answer.
    const tokens = query.split(/\s+/u).map(token => token.trim()).filter(token => token !== '')
    // 中文没有空格：整句当 phrase 去 MATCH 时 trigram 往往匹配不上（「投资一个加油站立项流程」
    // 这种整句 0 命中），而 tokens 只有一个、走不到上面的 relaxed 分支。这里按 3 字窗口展开，
    // 逐窗检索后合并，等价于「用 query 自己的 trigram 去命中索引里的 trigram」。
    const cjkWindows = tokens.length === 1 && rows.length === 0 ? trigramWindows(query) : []
    const relaxed = (tokens.length > 1 && rows.length < 2) || cjkWindows.length > 0
    const merged = new Map<string, Row>()
    const addRows = (candidates: Row[]): void => {
      for (const row of candidates) {
        const key = row.path + '\0' + String(row.line)
        const existing = merged.get(key)
        if (existing === undefined || row.score < existing.score) merged.set(key, row)
      }
    }
    const queries = relaxed
      ? (cjkWindows.length > 0 ? cjkWindows : tokens.slice(0, 8))
      : [query]
    if (relaxed) {
      for (const token of queries) addRows(runTerm(token))
    } else {
      addRows(rows)
    }

    const ordered = [...merged.values()].sort((a, b) => {
      const boost = relaxed ? thresholdRerankBoost(query, b.content) - thresholdRerankBoost(query, a.content) : 0
      return boost !== 0 ? boost : a.score - b.score
    })
    const boxRows = db.prepare(`
      SELECT page, bbox_json, block_index, occurrence, confidence, page_width, page_height
      FROM kb_chunk_boxes WHERE chunk_id = ? ORDER BY page, block_index, id
    `)
    // Chunk -> nearest section. Read once per document, not once per hit: a broad query can
    // touch several chapters of the same book and this stays a handful of SQL calls.
    interface SectionLookupRow { id: string; heading_path: string; level: number; summary: string; chunk_ids_json: string }
    const sectionCache = new Map<number, Map<number, SectionLookupRow>>()
    const sectionsForDocument = (docId: number): Map<number, SectionLookupRow> => {
      const cached = sectionCache.get(docId)
      if (cached !== undefined) return cached
      const map = new Map<number, SectionLookupRow>()
      const rows = db.prepare(`
        SELECT id, heading_path, level, summary, chunk_ids_json
        FROM kb_sections WHERE doc_id = ? ORDER BY rowid
      `).all(docId) as unknown as SectionLookupRow[]
      for (const section of rows) {
        for (const chunkId of numberArray(section.chunk_ids_json)) map.set(chunkId, section)
      }
      sectionCache.set(docId, map)
      return map
    }
    const toHit = async (row: Row): Promise<FtsSearchHit | undefined> => {

      if (!await options.canRead(row.path)) return undefined
      const rawBoxes = boxRows.all(row.chunk_id) as Array<{
        page: number; bbox_json: string; block_index: number | null;
        occurrence: number | null; confidence: number | null;
        page_width: number | null; page_height: number | null;
      }>
      // `kb_chunk_boxes` keeps one row per extracted block as provenance. Readers get the
      // page union instead: exactly one bbox per page, so no client can paint a paragraph
      // stack before merging it.
      const provenanceBoxes: FtsChunkBox[] = rawBoxes.map(box => ({
        page: box.page,
        bbox: bboxCoordinates(box.bbox_json),
        ...(box.block_index === null ? {} : { blockIndex: box.block_index }),
        ...(box.occurrence === null ? {} : { occurrence: box.occurrence }),
        ...(box.confidence === null ? {} : { confidence: box.confidence }),
        ...(box.confidence !== null && box.confidence < 0.6 ? { approximate: true } : {}),
      }))
      const boxes = unionBoxesByPage(provenanceBoxes)
      const markdownPath = row.markdown_path ?? row.path
      const sourcePath = row.source_path ?? sourcePathFor(row.path)
      // Only a plain text source has an honest line anchor. A `.docx`/`.xlsx`/`.pdf`
      // indexed through its `.md` sibling must open the original and use boxes/sheet/cell.
      const textSource = sourcePath === markdownPath && isTextSourcePath(sourcePath)
      const provenance = boxes.length > 0 || row.mime === 'application/pdf' || !textSource
      const lineCount = row.content.split('\n').length
      const firstBox = boxes[0]
      const approximate = boxes.some(box => box.approximate === true)
      const highlights = queryHighlights(query, row.snippet, row.content)
      const section = sectionsForDocument(row.doc_id).get(row.chunk_id)
      const docSummary = row.doc_summary ?? undefined
      return {
        path: sourcePath,
        ...(options.locale === undefined ? {} : { displayPath: localizedScopeForPath(sourcePath, options.locale) }),
        markdownPath,
        ...(row.heading === null || row.heading === undefined ? {} : { heading: row.heading }),
        ...(docSummary === undefined || docSummary === '' ? {} : { docSummary }),
        ...(section === undefined ? {} : {
          sectionId: section.id,
          sectionPath: section.heading_path,
          ...(section.summary.trim() === '' ? {} : { sectionSummary: section.summary }),
          sectionLevel: section.level,
        }),
        paragraph: row.ord ?? 0,
        chunkOrdinal: row.ord ?? 0,
        ...(paragraphTextFor(row.content) === undefined ? {} : { paragraphText: paragraphTextFor(row.content) }),
        quote: quoteFromSnippet(row.snippet) || quoteForContent(row.content),
        ...(highlights.matchedTerms.length === 0 ? {} : highlights),
        ...(row.sheet === null || row.sheet === undefined ? {} : { sheet: row.sheet }),
        ...(row.cell === null || row.cell === undefined ? {} : { cell: row.cell }),
        ...(textSource ? { line: row.line, lineStart: row.line, lineEnd: row.line + lineCount - 1 } : {}),
        snippet: row.snippet,
        score: Number((-row.score).toFixed(6)),
        docId: row.doc_id,
        chunkId: row.chunk_id,
        ...(row.chunk_key === null || row.chunk_key === undefined ? {} : { chunkKey: row.chunk_key }),
        citation: citationWithHighlights(`kb://doc/${String(row.doc_id)}/chunk/${String(row.chunk_key === null || row.chunk_key === undefined || row.chunk_key === '' ? row.chunk_id : row.chunk_key)}`, highlights),
        ...(boxes.length === 0 ? {} : { boxes }),
        ...(firstBox === undefined ? {} : { page: firstBox.page, bbox: firstBox.bbox }),
        ...(firstBox?.blockIndex === undefined ? {} : { blockIndex: firstBox.blockIndex }),
        ...(firstBox?.occurrence === undefined ? {} : { occurrence: firstBox.occurrence }),
        ...(approximate ? { approximate: true } : {}),
      }
    }
    const hits: FtsSearchHit[] = []
    const hitWindow = options.vector === undefined ? topK : candidateWindow
    for (const row of ordered) {
      const hit = await toHit(row)
      if (hit === undefined) continue
      hits.push(hit)
      if (hits.length >= hitWindow) break
    }

    let finalHits = hits
    let floorReplacements = 0
    if (options.vector !== undefined) {
      const vector = options.vector
      const vectorRows = vectorCandidates(db, {
        model: vector.model,
        query: vector.queryVector,
        clauses,
        params,
        scopeClause,
        scopeParams,
        candidateK: Math.max(1, Math.trunc(vector.candidateK)),
      })
      if (vectorRows.length > 0) {
        const hydrated = db.prepare(`
          SELECT c.path AS path, c.line AS line, c.content AS content, c.id AS chunk_id, c.doc_id AS doc_id,
                 d.mime AS mime, d.source_path AS source_path, d.markdown_path AS markdown_path,
                 c.chunk_key AS chunk_key, c.heading AS heading, c.ord AS ord, c.sheet AS sheet, c.cell AS cell,
                 d.summary AS doc_summary, 0 AS score,
                 COALESCE(b.page, c.page) AS page, COALESCE(b.bbox_json, c.bbox) AS bbox,
                 COALESCE(b.block_index, c.block_index) AS block_index, COALESCE(b.occurrence, c.occurrence) AS occurrence,
                 substr(c.content, 1, 240) AS snippet
          FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id LEFT JOIN kb_chunk_boxes b ON b.chunk_id = c.id
          WHERE c.id = ?
        `)
        const ftsById = new Map<number, { hit: FtsSearchHit; rank: number }>()
        for (const [index, hit] of hits.entries()) ftsById.set(hit.chunkId, { hit, rank: index + 1 })
        const vectorById = new Map<number, { hit: FtsSearchHit; rank: number; score: number }>()
        for (const [index, candidate] of vectorRows.entries()) {
          const known = ftsById.get(candidate.chunkId)
          if (known !== undefined) {
            vectorById.set(candidate.chunkId, { hit: known.hit, rank: index + 1, score: candidate.score })
            continue
          }
          const row = hydrated.get(candidate.chunkId) as Row | undefined
          if (row === undefined) continue
          const hit = await toHit(row)
          if (hit === undefined) continue
          hit.score = Number(candidate.score.toFixed(6))
          vectorById.set(candidate.chunkId, { hit, rank: index + 1, score: candidate.score })
        }
        const coverage = Math.max(0, Math.min(1, vector.coverage))
        const union = new Set<number>([...ftsById.keys(), ...vectorById.keys()])
        const fused: FtsSearchHit[] = []
        for (const chunkId of union) {
          const fts = ftsById.get(chunkId)
          const vec = vectorById.get(chunkId)
          const hit = fts?.hit ?? vec?.hit
          if (hit === undefined) continue
          const ftsPart = fts === undefined ? 0 : vector.ftsWeight / (vector.rrfK + fts.rank)
          const vectorPart = vec === undefined ? 0 : (vector.vectorWeight * coverage) / (vector.rrfK + vec.rank)
          hit.retrieval = fts !== undefined && vec !== undefined ? 'hybrid' : fts !== undefined ? 'fts' : 'vector'
          if (fts !== undefined) {
            hit.ftsRank = fts.rank
            hit.ftsScore = hit.score
          }
          if (vec !== undefined) {
            hit.vectorRank = vec.rank
            hit.vectorScore = Number(vec.score.toFixed(6))
          }
          hit.rrfScore = Number((ftsPart + vectorPart).toFixed(8))
          hit.score = hit.rrfScore
          fused.push(hit)
        }
        fused.sort((left, right) => (right.rrfScore ?? 0) - (left.rrfScore ?? 0)
          || (left.ftsRank ?? Number.MAX_SAFE_INTEGER) - (right.ftsRank ?? Number.MAX_SAFE_INTEGER)
          || left.chunkId - right.chunkId)
        const selected = fused.slice(0, topK)
        const selectedIds = new Set(selected.map(hit => hit.chunkId))
        const floor = hits.slice(0, Math.min(10, Math.max(1, Math.trunc(vector.candidateK))))
        for (const floorHit of floor) {
          if (selectedIds.has(floorHit.chunkId)) continue
          let replacement = -1
          for (let index = selected.length - 1; index >= 0; index -= 1) {
            if (selected[index]?.retrieval === 'vector') { replacement = index; break }
          }
          if (replacement < 0) break
          const removed = selected[replacement]
          selected[replacement] = floorHit
          selectedIds.delete(removed?.chunkId ?? -1)
          selectedIds.add(floorHit.chunkId)
          floorHit.retrieval = 'fts'
          floorHit.retrievalReason = 'fts-floor'
          floorHit.rrfScore = Number((vector.ftsWeight / (vector.rrfK + (floorHit.ftsRank ?? floor.indexOf(floorHit) + 1))).toFixed(8))
          floorHit.score = floorHit.rrfScore
          floorReplacements += 1
        }
        finalHits = selected
      }
    }
    const relatedSections = await searchRelatedSections(db, {
      query,
      clauses,
      params,
      scopeClause,
      scopeParams,
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      canRead: options.canRead,
    })
    return {
      hits: finalHits,
      relaxed,
      queries,
      ...(options.vector === undefined ? {} : { retrieval: finalHits.some(hit => hit.retrieval === 'hybrid') ? 'hybrid' as const : finalHits.some(hit => hit.retrieval === 'vector') ? 'vector' as const : 'fts' as const }),
      ...(floorReplacements === 0 ? {} : { floorReplacements }),
      ...(relatedSections.length === 0 ? {} : { relatedSections }),
    }
  } finally {
    db.close()
  }
}

/**
 * Search the summary half of the index.
 *
 * This is a navigation channel, not evidence: summary rows have no citation token. The
 * caller's scope and per-path grant check apply exactly as they do for chunk hits.
 */
async function searchRelatedSections(
  db: DatabaseSync,
  options: {
    query: string
    clauses: readonly string[]
    params: readonly (string | number)[]
    scopeClause: string
    scopeParams: readonly (string | number)[]
    locale?: ScopeLocale
    canRead: (relPath: string) => Promise<boolean>
  },
): Promise<FtsRelatedSection[]> {
  if ([...options.query].length < 3) return []
  type SummaryRow = {
    doc_id: number
    kind: string
    section_id?: string | null
    heading_path?: string | null
    summary: string
    source_chunk_ids_json: string
    doc_path: string
    source_path?: string | null
    score: number
  }
  const statement = db.prepare(`
    SELECT s.doc_id AS doc_id, s.kind AS kind, s.section_id AS section_id,
           s.heading_path AS heading_path, s.summary AS summary,
           s.source_chunk_ids_json AS source_chunk_ids_json,
           d.path AS doc_path, d.source_path AS source_path,
           bm25(kb_summary_fts) AS score
    FROM kb_summary_fts
    JOIN kb_summary_chunks s ON s.id = kb_summary_fts.rowid
    JOIN kb_docs d ON d.id = s.doc_id
    WHERE kb_summary_fts MATCH ? AND (${options.clauses.join(' OR ')})${options.scopeClause}
    ORDER BY score ASC
    LIMIT ?
  `)
  const runTerm = (term: string): SummaryRow[] => {
    if ([...term].length < 3) return []
    try {
      return statement.all('"' + term.replace(/"/gu, '""') + '"', ...options.params, ...options.scopeParams, 8) as unknown as SummaryRow[]
    } catch {
      return []
    }
  }
  let rows: SummaryRow[] = runTerm(options.query)
  const tokens = options.query.split(/\s+/u).map(token => token.trim()).filter(token => token !== '')
  if (rows.length < 2 && tokens.length > 1) {
    const merged = new Map<string, SummaryRow>()
    for (const term of tokens.slice(0, 8)) {
      for (const row of runTerm(term)) {
        // Dedupe on document + section: the same summary can match several tokens.
        const identity = `${String(row.doc_id)}:${row.kind}:${row.section_id ?? ''}`
        const existing = merged.get(identity)
        if (existing === undefined || row.score < existing.score) merged.set(identity, row)
      }
    }
    rows = [...merged.values()].sort((left, right) => left.score - right.score)
  }
  const related: FtsRelatedSection[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const sourcePath = row.source_path ?? row.doc_path
    if (!await options.canRead(sourcePath)) continue
    const key = `${String(row.doc_id)}:${row.section_id ?? row.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    const kind = row.kind === 'doc_summary' ? 'doc_summary' as const : 'section_summary' as const
    related.push({
      docId: row.doc_id,
      kind,
      ...(row.section_id === null || row.section_id === undefined ? {} : { sectionId: row.section_id }),
      path: sourcePath,
      ...(options.locale === undefined ? {} : { displayPath: localizedScopeForPath(sourcePath, options.locale) }),
      sectionPath: row.heading_path ?? '',
      summary: row.summary,
      sourceChunkIds: numberArray(row.source_chunk_ids_json),
      score: Number((-row.score).toFixed(6)),
    })
    if (related.length >= 4) break
  }
  return related
}

/** One MinerU block, as extract.ts reports it. */
export interface ProvenanceBlock {
  page: number
  bbox: readonly [number, number, number, number]
  text: string
  type?: string
  blockIndex?: number
  occurrence?: number
  confidence?: number
  pageWidth?: number
  pageHeight?: number
  coordSpace?: 'normalized' | 'points'
}

/**
 * Attach MinerU page/bbox provenance to the chunks already indexed for one document.
 *
 * The Markdown and FTS rows stay pure text; bbox lives only in `kb_chunk_boxes`.
 */
export async function attachProvenance(options: {
  indexPath: string
  markdownPath: string
  sourcePath?: string
  blocks: readonly ProvenanceBlock[]
}): Promise<{ chunks: number; boxes: number; pages: number }> {
  return withIndexLock(() => withBusyRetry(() => attachProvenanceUnlocked(options)))
}

async function attachProvenanceUnlocked(options: {
  indexPath: string
  markdownPath: string
  sourcePath?: string
  blocks: readonly ProvenanceBlock[]
}): Promise<{ chunks: number; boxes: number; pages: number }> {
  if (options.blocks.length === 0) return { chunks: 0, boxes: 0, pages: 0 }
  const db = new DatabaseSync(options.indexPath)
  try {
    ensureSchema(db)
    ensureChunkColumns(db)
    const doc = db.prepare('SELECT id FROM kb_docs WHERE path = ?').get(options.markdownPath) as { id: number } | undefined
    if (doc === undefined) return { chunks: 0, boxes: 0, pages: 0 }
    const chunks = db.prepare('SELECT id, content FROM kb_chunks WHERE doc_id = ? ORDER BY ord, id').all(doc.id) as Array<{ id: number; content: string }>
    if (chunks.length === 0) return { chunks: 0, boxes: 0, pages: 0 }
    const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim().toLowerCase()
    const chunkTexts = chunks.map(chunk => normalize(chunk.content))
    const boxes = db.prepare('INSERT INTO kb_chunk_boxes(chunk_id, page, bbox_json, block_index, occurrence, confidence, page_width, page_height) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const updateRange = db.prepare('UPDATE kb_chunks SET page_start = COALESCE(MIN(page_start, ?), ?), page_end = COALESCE(MAX(page_end, ?), ?) WHERE id = ?')
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM kb_chunk_boxes WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE doc_id = ?)').run(doc.id)
      const pagesByChunk = new Map<number, { start: number; end: number }>()
      let boxesWritten = 0
      let fallback = 0
      for (const block of options.blocks) {
        const needle = normalize(block.text).slice(0, 160)
        let index = needle === '' ? -1 : chunkTexts.findIndex(text => text.includes(needle))
        if (index < 0) {
          fallback += 1
          index = Math.min(chunks.length - 1, Math.floor((fallback / Math.max(1, options.blocks.length)) * chunks.length))
        }
        const chunk = chunks[index]
        if (chunk === undefined) continue
        const bboxJson = JSON.stringify({
          bbox: block.bbox,
          coord_space: block.coordSpace ?? 'normalized',
          ...(block.pageWidth === undefined ? {} : { page_width: block.pageWidth }),
          ...(block.pageHeight === undefined ? {} : { page_height: block.pageHeight }),
          type: block.type ?? 'text',
        })
        boxes.run(chunk.id, block.page, bboxJson, block.blockIndex ?? null, block.occurrence ?? 1, block.confidence ?? null, block.pageWidth ?? null, block.pageHeight ?? null)
        boxesWritten += 1
        const range = pagesByChunk.get(chunk.id) ?? { start: block.page, end: block.page }
        range.start = Math.min(range.start, block.page)
        range.end = Math.max(range.end, block.page)
        pagesByChunk.set(chunk.id, range)
      }
      for (const chunkId of pagesByChunk.keys()) rebuildUnionsForChunk(db, chunkId)
      for (const [chunkId, range] of pagesByChunk) updateRange.run(range.start, range.start, range.end, range.end, chunkId)
      let sha256: string | null = null
      if (options.sourcePath !== undefined) {
        try { sha256 = createHash('sha256').update(await readFile(options.sourcePath)).digest('hex') } catch { sha256 = null }
      }
      const pages = options.blocks.reduce((max, block) => Math.max(max, block.page), 0)
      db.prepare('UPDATE kb_docs SET mime = ?, pages = ?, sha256 = COALESCE(?, sha256) WHERE id = ?').run('application/pdf', pages, sha256, doc.id)
      db.exec('COMMIT')
      return { chunks: chunks.length, boxes: boxesWritten, pages }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

/** Compute and persist one union rectangle per page from a chunk's boxes. */
function rebuildUnionsForChunk(db: DatabaseSync, chunkId: number): number {
  const boxes = db.prepare('SELECT page, bbox_json, page_width, page_height FROM kb_chunk_boxes WHERE chunk_id = ? ORDER BY page, id').all(chunkId) as Array<{ page: number; bbox_json: string; page_width: number | null; page_height: number | null }>
  const byPage = new Map<number, { minX: number; minY: number; maxX: number; maxY: number; pageWidth: number | null; pageHeight: number | null }>()
  for (const box of boxes) {
    const parsed = bboxCoordinates(box.bbox_json)
    let values: number[] = []
    try { values = JSON.parse(parsed) as number[] } catch { values = [] }
    if (values.length !== 4 || values.some(value => !Number.isFinite(value))) continue
    const [minX, minY, maxX, maxY] = values as [number, number, number, number]
    const union = byPage.get(box.page) ?? { minX, minY, maxX, maxY, pageWidth: box.page_width, pageHeight: box.page_height }
    union.minX = Math.min(union.minX, minX); union.minY = Math.min(union.minY, minY)
    union.maxX = Math.max(union.maxX, maxX); union.maxY = Math.max(union.maxY, maxY)
    byPage.set(box.page, union)
  }
  db.prepare('DELETE FROM kb_chunk_unions WHERE chunk_id = ?').run(chunkId)
  const insert = db.prepare('INSERT INTO kb_chunk_unions(chunk_id, page, bbox_json, page_width, page_height) VALUES (?, ?, ?, ?, ?)')
  for (const [page, union] of byPage) {
    insert.run(chunkId, page, JSON.stringify([union.minX, union.minY, union.maxX, union.maxY]), union.pageWidth, union.pageHeight)
  }
  return byPage.size
}

/** Read one chunk and all of its provenance boxes by stable id. */
/**
 * Resolve a path (original or derived Markdown sibling) plus an optional 1-based
 * line to the chunk that contains it. The viewer needs this for inline
 * `.docx.md:73` links, whose label is derived text but whose citation must point at
 * the original document's chunk.
 */
export async function findChunkForPath(options: {
  indexPath: string
  path: string
  line?: number
  /** The text on the requested markdown line, used when stored line anchors are stale. */
  lineText?: string
}): Promise<{ docId: number; chunkId: number } | undefined> {
  return withIndexLock(() => withBusyRetry(() => findChunkForPathUnlocked(options)))
}

/** Whitespace/format-insensitive form for matching a source line against a chunk. */
function compactForLineMatch(value: string): string {
  return value.normalize('NFKC').replace(/[\s|#*_>`~]+/gu, '')
}

async function findChunkForPathUnlocked(options: {
  indexPath: string
  path: string
  line?: number
  lineText?: string
}): Promise<{ docId: number; chunkId: number } | undefined> {
  const path = options.path.trim().replace(/:\d+$/u, '')
  if (path === '') return undefined
  const db = new DatabaseSync(options.indexPath)
  try {
    ensureSchema(db)
    ensureChunkColumns(db)
    // Index paths are actual-root relative (`rag-eval-fixtures/x.docx.md`), while an
    // inline link arrives view-relative (`global/rag-eval-fixtures/x.docx.md`).
    const variants = [...new Set([path, path.replace(/^global\//u, ''), path.replace(/^全局\//u, '')])]
    const doc = db.prepare(`
      SELECT id FROM kb_docs
      WHERE path IN (?, ?, ?) OR source_path IN (?, ?, ?)
      ORDER BY CASE WHEN path IN (?, ?, ?) THEN 0 ELSE 1 END
      LIMIT 1
    `).get(...variants, ...variants, ...variants) as { id: number } | undefined
    if (doc === undefined) return undefined
    const chunks = db.prepare('SELECT id, line, content FROM kb_chunks WHERE doc_id = ? ORDER BY line, ord, id').all(doc.id) as Array<{ id: number; line: number; content: string }>
    if (chunks.length === 0) return undefined
    const requested = options.line === undefined || !Number.isFinite(options.line) ? undefined : Math.trunc(options.line)
    let chosen = chunks[0]
    // Stored `line` anchors are computed at index time. An index built before the overlap-anchor
    // fix can point every late chunk at the wrong line, so when the caller supplies the actual
    // source line prefer the chunk whose content contains it. This also keeps old indexes usable
    // until their next reindex.
    const lineText = options.lineText?.trim() ?? ''
    const byLineText = lineText === ''
      ? undefined
      : chunks.find(chunk => compactForLineMatch(chunk.content).includes(compactForLineMatch(lineText)))
    if (byLineText !== undefined) {
      chosen = byLineText
    } else if (requested !== undefined) {
      const containing = chunks.find(chunk => requested >= chunk.line && requested < chunk.line + chunk.content.split('\n').length)
      chosen = containing ?? chunks.reduce((nearest, chunk) => (
        Math.abs(chunk.line - requested) < Math.abs(nearest.line - requested) ? chunk : nearest
      ), chunks[0])
    }
    return { docId: doc.id, chunkId: chosen.id }
  } finally { db.close() }
}

/** Resolve a stable chunk_key (or an old numeric id) to the current numeric id. */
export async function findChunkId(options: {
  indexPath: string
  docId: number
  chunkId: number | string
}): Promise<number | undefined> {
  return withIndexLock(() => withBusyRetry(() => findChunkIdUnlocked(options)))
}

async function findChunkIdUnlocked(options: {
  indexPath: string
  docId: number
  chunkId: number | string
}): Promise<number | undefined> {
  const db = new DatabaseSync(options.indexPath)
  try {
    ensureSchema(db); ensureChunkColumns(db)
    const byId = db.prepare('SELECT id FROM kb_chunks WHERE doc_id = ? AND id = ?')
    const byKey = db.prepare('SELECT id FROM kb_chunks WHERE doc_id = ? AND chunk_key = ?')
    const numericAlias = db.prepare('SELECT chunk_key FROM kb_chunk_aliases WHERE doc_id = ? AND old_chunk_id = ?')
    const keyAlias = db.prepare('SELECT chunk_key FROM kb_chunk_key_aliases WHERE doc_id = ? AND old_chunk_key = ?')
    // A key may itself be an alias from an older reindex (v2 chunk key → v3 key). Follow the
    // chain a bounded number of hops so a citation survives more than one chunker upgrade.
    const resolveKey = (start: string): number | undefined => {
      let key = start
      for (let hop = 0; hop < 8; hop += 1) {
        const keyed = byKey.get(options.docId, key) as { id: number } | undefined
        if (keyed !== undefined) return keyed.id
        const alias = keyAlias.get(options.docId, key) as { chunk_key: string } | undefined
        if (alias === undefined || alias.chunk_key === key) return undefined
        key = alias.chunk_key
      }
      return undefined
    }
    if (typeof options.chunkId === 'number' || /^\d+$/u.test(String(options.chunkId))) {
      const numeric = Number(options.chunkId)
      const direct = byId.get(options.docId, numeric) as { id: number } | undefined
      if (direct !== undefined) return direct.id
      const alias = numericAlias.get(options.docId, numeric) as { chunk_key: string } | undefined
      return alias === undefined ? undefined : resolveKey(alias.chunk_key)
    }
    return resolveKey(String(options.chunkId))
  } finally { db.close() }
}

export async function readChunkProvenance(options: {
  indexPath: string
  docId: number
  chunkId: number
  query?: string
}): ReturnType<typeof readChunkProvenanceUnlocked> {
  return withIndexLock(() => withBusyRetry(() => readChunkProvenanceUnlocked(options)))
}

async function readChunkProvenanceUnlocked(options: {
  indexPath: string
  docId: number
  chunkId: number
  query?: string
}): Promise<{
  docId: number
  chunkId: number
  chunkKey?: string
  path: string
  sourcePath: string
  markdownPath: string
  heading?: string
  paragraph?: number
  chunkOrdinal?: number
  paragraphText?: string
  quote?: string
  sheet?: string
  cell?: string
  chunkText: string
  paragraphs: Array<{ ordinal: number; text: string }>
  snippet: string
  line?: number
  lineStart?: number
  lineEnd?: number
  boxes: FtsChunkBox[]
  unionBoxes: Array<{ page: number; bbox: string }>
  matchedTerms?: string[]
  highlightText?: string
  highlightRanges?: Array<{ start: number; end: number }>
} | undefined> {
  const db = new DatabaseSync(options.indexPath)
  try {
    ensureSchema(db)
    ensureChunkColumns(db)
    const row = db.prepare(`
      SELECT c.id AS chunk_id, c.doc_id AS doc_id, c.path AS path, c.line AS line,
             c.chunk_key AS chunk_key, c.heading AS heading, c.ord AS ord, c.sheet AS sheet, c.cell AS cell, c.content AS content, d.mime AS mime,
             d.source_path AS source_path, d.markdown_path AS markdown_path
      FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id
      WHERE c.doc_id = ? AND (c.id = ? OR c.chunk_key = (SELECT chunk_key FROM kb_chunk_aliases WHERE doc_id = ? AND old_chunk_id = ?))
    `).get(options.docId, options.chunkId, options.docId, options.chunkId) as { chunk_id: number; doc_id: number; path: string; line: number; chunk_key?: string | null; heading?: string | null; content: string; mime?: string | null; source_path?: string | null; markdown_path?: string | null; chunker_version?: string | null; ord?: number | null; sheet?: string | null; cell?: string | null } | undefined
    if (row === undefined) return undefined
    const rawBoxes = db.prepare(`
      SELECT page, bbox_json, block_index, occurrence, confidence
      FROM kb_chunk_boxes WHERE chunk_id = ? ORDER BY page, block_index, id
    `).all(options.chunkId) as Array<{ page: number; bbox_json: string; block_index: number | null; occurrence: number | null; confidence: number | null }>
    const provenanceBoxes: FtsChunkBox[] = rawBoxes.map(box => ({
      page: box.page,
      bbox: bboxCoordinates(box.bbox_json),
      ...(box.block_index === null ? {} : { blockIndex: box.block_index }),
      ...(box.occurrence === null ? {} : { occurrence: box.occurrence }),
      ...(box.confidence === null ? {} : { confidence: box.confidence }),
      ...(box.confidence !== null && box.confidence < 0.6 ? { approximate: true } : {}),
    }))
    const unionRows = db.prepare('SELECT page, bbox_json FROM kb_chunk_unions WHERE chunk_id = ? ORDER BY page').all(options.chunkId) as Array<{ page: number; bbox_json: string }>
    // The public `boxes` field is the painted contract: one union per page. The block-level
    // rows stay in SQLite for provenance and debugging, not in the response.
    const approximatePages = new Set(provenanceBoxes.filter(box => box.approximate === true).map(box => box.page))
    const boxes: FtsChunkBox[] = unionRows.length > 0
      ? unionRows.map(union => ({
        page: union.page,
        bbox: bboxCoordinates(union.bbox_json),
        ...(approximatePages.has(union.page) ? { approximate: true } : {}),
      }))
      : unionBoxesByPage(provenanceBoxes)
    const markdownPath = row.markdown_path ?? row.path
    const sourcePath = row.source_path ?? sourcePathFor(row.path)
    const textSource = sourcePath === markdownPath && isTextSourcePath(sourcePath)
    const highlights = options.query === undefined ? undefined : queryHighlights(options.query, row.content.slice(0, 240), row.content)
    return {
      docId: row.doc_id,
      chunkId: row.chunk_id,
      ...(row.chunk_key === null || row.chunk_key === undefined ? {} : { chunkKey: row.chunk_key }),
      path: sourcePath,
      sourcePath,
      markdownPath,
      ...(row.heading === null || row.heading === undefined ? {} : { heading: row.heading }),
      paragraph: row.ord ?? 0,
      chunkOrdinal: row.ord ?? 0,
      ...(paragraphTextFor(row.content) === undefined ? {} : { paragraphText: paragraphTextFor(row.content) }),
      quote: quoteForContent(row.content),
      chunkText: plainQuoteText(row.content),
      paragraphs: paragraphsFor(row.content),
      ...(row.sheet === null || row.sheet === undefined ? {} : { sheet: row.sheet }),
      ...(row.cell === null || row.cell === undefined ? {} : { cell: row.cell }),
      snippet: row.content.slice(0, 240),
      ...(textSource ? { line: row.line, lineStart: row.line, lineEnd: row.line + row.content.split('\n').length - 1 } : {}),
      boxes,
      unionBoxes: boxes.map(box => ({ page: box.page, bbox: box.bbox })),
      ...(highlights === undefined || highlights.matchedTerms.length === 0 ? {} : highlights),
    }
  } finally {
    db.close()
  }
}

export async function optimizeIndex(indexPath: string): Promise<void> {
  const db = new DatabaseSync(indexPath)
  try {
    ensureSchema(db)
    db.exec("INSERT INTO kb_chunks_fts(kb_chunks_fts) VALUES ('optimize')")
    db.exec("INSERT INTO kb_summary_fts(kb_summary_fts) VALUES ('optimize')")
    db.exec('VACUUM')
  } finally {
    db.close()
  }
}
/* ------------------------------------------------------------------ *
 * Document outline storage
 *
 * `kb_docs.summary` / `toc_json` hold the navigable outline; `kb_sections` keeps one
 * row per heading node; `kb_summary_chunks` + `kb_summary_fts` make the summaries
 * retrievable without ever turning them into citation evidence.
 * ------------------------------------------------------------------ */

/** Absolute path of one document's generated INDEX.md (outside the agent-visible tree). */
export function outlineFilePath(indexPath: string, docId: number): string {
  return join(dirname(indexPath), 'md', `${String(docId)}.INDEX.md`)
}

/** Write one generated outline beside the SQLite index; never into the source tree. */
export async function writeOutlineFile(indexPath: string, docId: number, markdown: string): Promise<string> {
  const target = outlineFilePath(indexPath, docId)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${String(process.pid)}.tmp`
  await writeFile(temporary, markdown, 'utf8')
  await rename(temporary, target)
  return target
}

/** Version string that changes when the source bytes or the chunker/summary rules change. */
function summaryVersionFor(hash: string): string {
  return `${SUMMARY_VERSION}:${CHUNKER_VERSION}:${hash.slice(0, 12)}`
}

/** One stored outline, as `kb_outline` returns it. */
export interface DocumentOutlineRecord {
  docId: number
  /** Original source path (the citable document). */
  path: string
  /** Derived Markdown path; internal routing detail. */
  markdownPath: string
  title: string
  summary: string
  summaryVersion?: string
  /** How the current summary was produced. Missing summaries are `none`. */
  summaryKind: OutlineSummaryKind
  /** `missing` until an explicit `kb_outline_save` writes a model-authored summary. */
  summaryStatus: 'ready' | 'missing'
  /** Source chunk ids behind the document summary. */
  sourceChunkIds: number[]
  toc: OutlineTocEntry[]
  sections: OutlineSection[]
  /** Absolute path of the generated INDEX.md. */
  indexPath: string
}

interface OutlineDocumentRow {
  id: number
  path: string
  source_path?: string | null
  markdown_path?: string | null
  title: string
  hash: string
  summary?: string | null
  toc_json?: string | null
  summary_version?: string | null
  summary_kind?: string | null
}

interface StoredSectionRow {
  id: string
  doc_id: number
  heading_path: string
  level: number
  summary: string
  key_facts_json: string | null
  chunk_ids_json: string
  source_chunk_ids_json: string
  summary_version: string
}

interface OutlineDocumentMeta {
  id: number
  path: string
  source_path?: string | null
  markdown_path?: string | null
  title: string
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (raw === null || raw === undefined || raw === '') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

function numberArray(raw: string | null | undefined): number[] {
  return parseJsonArray<unknown>(raw)
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value > 0)
}

function storedSections(db: DatabaseSync, docId: number): OutlineSection[] {
  const rows = db.prepare(`
    SELECT id, doc_id, heading_path, level, summary, key_facts_json,
           chunk_ids_json, source_chunk_ids_json, summary_version
    FROM kb_sections WHERE doc_id = ? ORDER BY rowid
  `).all(docId) as unknown as StoredSectionRow[]
  return rows.map(row => ({
    sectionId: row.id,
    headingPath: row.heading_path,
    title: row.heading_path.split(' > ').pop() ?? row.heading_path,
    level: Number(row.level),
    summary: row.summary,
    keyFacts: parseJsonArray<OutlineKeyFact>(row.key_facts_json),
    chunkIds: numberArray(row.chunk_ids_json),
    sourceChunkIds: numberArray(row.source_chunk_ids_json),
  }))
}

function storedToc(raw: string | null | undefined): OutlineTocEntry[] {
  return parseJsonArray<OutlineTocEntry>(raw).filter(entry => (
    typeof entry.sectionId === 'string'
    && typeof entry.title === 'string'
    && Number.isInteger(entry.level)
  ))
}

/** Chunks of one document in ordinal order, ready for outline building. */
function outlineChunksForDocument(db: DatabaseSync, docId: number): OutlineChunk[] {
  const rows = db.prepare(`
    SELECT id, chunk_key, ord, heading, content FROM kb_chunks
    WHERE doc_id = ? ORDER BY ord, id
  `).all(docId) as Array<{ id: number; chunk_key?: string | null; ord?: number | null; heading?: string | null; content: string }>
  return rows.map((row, index) => ({
    id: row.id,
    ...(row.chunk_key === null || row.chunk_key === undefined ? {} : { chunkKey: row.chunk_key }),
    ordinal: row.ord ?? index,
    ...(row.heading === null || row.heading === undefined ? {} : { heading: row.heading }),
    content: row.content,
  }))
}

/** Delete a document's outline rows, including the summary FTS entries. */
function deleteOutlineRows(db: DatabaseSync, docId: number): void {
  const ids = db.prepare('SELECT id FROM kb_summary_chunks WHERE doc_id = ?').all(docId) as Array<{ id: number }>
  const deleteFts = db.prepare('DELETE FROM kb_summary_fts WHERE rowid = ?')
  for (const row of ids) deleteFts.run(row.id)
  db.prepare('DELETE FROM kb_summary_chunks WHERE doc_id = ?').run(docId)
  db.prepare('DELETE FROM kb_sections WHERE doc_id = ?').run(docId)
}

/**
 * Persist one built outline. The caller owns the transaction; this never commits, so the
 * chunks, the doc summary and the section rows become visible together.
 */
function summaryKindOf(raw: string | null | undefined): OutlineSummaryKind {
  return raw === 'llm' || raw === 'extractive' ? raw : 'none'
}

/**
 * Persist one built outline. The caller owns the transaction; this never commits, so the
 * chunks, the doc summary and the section rows become visible together.
 *
 * `none` is the upload/extraction default: the heading tree and TOC are still written so
 * navigation works, but every summary field is empty and no summary FTS row is created.
 * `extractive` is the legacy 0.1.9 behaviour (opt-in via `outline.autoGenerate`), and
 * `llm` is only produced by `saveDocumentOutline`.
 */
function storeOutlineForDocument(
  db: DatabaseSync,
  doc: OutlineDocumentMeta,
  built: BuiltOutline,
  version: string,
  summaryKind: OutlineSummaryKind,
): string {
  deleteOutlineRows(db, doc.id)
  db.prepare('UPDATE kb_docs SET summary = ?, toc_json = ?, summary_version = ?, summary_kind = ? WHERE id = ?')
    .run(built.summary, JSON.stringify(built.toc), version, summaryKind, doc.id)
  const insertSection = db.prepare(`
    INSERT INTO kb_sections(id, doc_id, heading_path, level, summary, key_facts_json,
                            chunk_ids_json, source_chunk_ids_json, summary_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const section of built.sections) {
    insertSection.run(
      section.sectionId,
      doc.id,
      section.headingPath,
      section.level,
      section.summary,
      JSON.stringify(section.keyFacts),
      JSON.stringify(section.chunkIds),
      JSON.stringify(section.sourceChunkIds),
      version,
    )
  }
  if (summaryKind !== 'none') {
    const insertSummary = db.prepare(`
      INSERT INTO kb_summary_chunks(doc_id, section_id, kind, heading_path, summary, key_facts_json,
                                    text, source_chunk_ids_json, summary_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertSummaryFts = db.prepare('INSERT INTO kb_summary_fts(rowid, content) VALUES (?, ?)')
    const addSummary = (
      sectionId: string | null,
      kind: 'doc_summary' | 'section_summary',
      headingPath: string,
      summary: string,
      keyFacts: OutlineKeyFact[],
      text: string,
      sourceChunkIds: readonly number[],
    ): void => {
      const result = insertSummary.run(
        doc.id,
        sectionId,
        kind,
        headingPath,
        summary,
        JSON.stringify(keyFacts),
        text,
        JSON.stringify(sourceChunkIds),
        version,
      )
      insertSummaryFts.run(Number(result.lastInsertRowid), text)
    }
    const documentTitle = built.documentTitle === '' ? doc.title : built.documentTitle
    if (built.summary.trim() !== '') {
      addSummary(
        null,
        'doc_summary',
        documentTitle,
        built.summary,
        [],
        `文档摘要\n${documentTitle}\n${built.summary}`,
        built.sourceChunkIds,
      )
    }
    // Extractive summaries index chapters only: article rows would flood the summary
    // channel. Model-written summaries may cover every level the skill chose to write.
    const indexedSections = summaryKind === 'llm'
      ? built.sections.filter(section => section.summary.trim() !== '')
      : built.sections.filter(section => section.level === 1)
    for (const section of indexedSections) {
      addSummary(
        section.sectionId,
        'section_summary',
        section.headingPath,
        section.summary,
        section.keyFacts,
        `章节摘要\n${section.headingPath}\n${section.summary}\n关键事实：${section.keyFacts.map(fact => fact.value).join('；')}`,
        section.sourceChunkIds,
      )
    }
  }
  return renderOutlineMarkdown({
    docId: doc.id,
    docTitle: doc.title,
    sourcePath: doc.source_path ?? doc.path,
    summaryVersion: version,
    summaryKind,
    summary: built.summary,
    summarySourceChunkIds: built.sourceChunkIds,
    toc: built.toc,
    sections: built.sections,
  })
}

function outlineRecordFromRow(
  db: DatabaseSync,
  doc: OutlineDocumentRow,
  indexPath: string,
): DocumentOutlineRecord {
  const source = db.prepare(`
    SELECT source_chunk_ids_json FROM kb_summary_chunks
    WHERE doc_id = ? AND kind = 'doc_summary' ORDER BY id DESC LIMIT 1
  `).get(doc.id) as { source_chunk_ids_json?: string | null } | undefined
  const summary = doc.summary ?? ''
  const summaryKind = summaryKindOf(doc.summary_kind)
  return {
    docId: doc.id,
    path: doc.source_path ?? doc.path,
    markdownPath: doc.markdown_path ?? doc.path,
    title: doc.title,
    summary,
    summaryKind,
    summaryStatus: summaryKind !== 'none' && summary.trim() !== '' ? 'ready' : 'missing',
    ...(doc.summary_version === null || doc.summary_version === undefined ? {} : { summaryVersion: doc.summary_version }),
    sourceChunkIds: numberArray(source?.source_chunk_ids_json),
    toc: storedToc(doc.toc_json),
    sections: storedSections(db, doc.id),
    indexPath,
  }
}

/** Read one stored outline without rebuilding it. */
export async function readDocumentOutline(options: {
  indexPath: string
  docId: number
}): Promise<DocumentOutlineRecord | undefined> {
  return withIndexLock(() => withBusyRetry(() => readDocumentOutlineUnlocked(options)))
}

async function readDocumentOutlineUnlocked(options: {
  indexPath: string
  docId: number
}): Promise<DocumentOutlineRecord | undefined> {
  const db = new DatabaseSync(options.indexPath)
  try {
    ensureSchema(db)
    ensureChunkColumns(db)
    const doc = db.prepare(`
      SELECT id, path, source_path, markdown_path, title, hash, summary, toc_json, summary_version, summary_kind
      FROM kb_docs WHERE id = ?
    `).get(options.docId) as OutlineDocumentRow | undefined
    if (doc === undefined) return undefined
    return outlineRecordFromRow(db, doc, outlineFilePath(options.indexPath, doc.id))
  } finally {
    db.close()
  }
}

/**
 * Rewrite one document's INDEX.md from the summaries already stored in SQLite.
 *
 * This is deliberately not a summary generator: it reads `kb_docs`/`kb_sections`
 * and re-renders the file, so a renderer-only change (for example adding article
 * headings) never regenerates or rewrites any summary text. Permission is decided
 * by the caller on the source path before this function runs.
 */
export async function rewriteDocumentOutline(options: {
  indexPath: string
  docId: number
}): Promise<string | undefined> {
  const record = await readDocumentOutline(options)
  if (record === undefined) return undefined
  return writeOutlineFile(options.indexPath, record.docId, renderStoredOutline(record))
}

/** Version string for a structure-only outline (TOC + section rows, no prose). */
function structureVersionFor(hash: string): string {
  return `structure-v1:${CHUNKER_VERSION}:${hash.slice(0, 12)}`
}

/** True when an `llm-v1:` version still names this source hash. */
function llmVersionMatchesHash(version: string | null | undefined, hash: string): boolean {
  if (version === null || version === undefined || !version.startsWith('llm-v1:')) return true
  return version.split(':')[1] === hash.slice(0, 12)
}

/** Strip every generated summary while keeping the heading tree and TOC. */
function structureOnly(built: BuiltOutline): BuiltOutline {
  return {
    documentTitle: built.documentTitle,
    summary: '',
    sourceChunkIds: [],
    toc: built.toc,
    sections: built.sections.map(section => ({ ...section, summary: '', keyFacts: [] })),
  }
}

/** Render an already-stored outline, including a structure-only one. */
function renderStoredOutline(record: DocumentOutlineRecord): string {
  return renderOutlineMarkdown({
    docId: record.docId,
    docTitle: record.title,
    sourcePath: record.path,
    summaryVersion: record.summaryVersion ?? 'structure-v1',
    summaryKind: record.summaryKind,
    summary: record.summary,
    summarySourceChunkIds: record.sourceChunkIds,
    toc: record.toc,
    sections: record.sections,
  })
}

/**
 * Ensure one document has an outline and an INDEX.md.
 *
 * Upload and extraction only guarantee the navigation structure: TOC rows and section
 * records exist, but summaries stay empty unless `autoGenerate` explicitly asks for the
 * legacy extractive text. A model-written (`llm`) summary is never regenerated here: it is
 * preserved until the source hash changes or `kb_outline_save` replaces it.
 */
export async function ensureDocumentOutline(options: {
  indexPath: string
  docId: number
  force?: boolean
  /** Opt-in legacy extractive summaries; production config defaults this to false. */
  autoGenerate?: boolean
}): Promise<DocumentOutlineRecord | undefined> {
  return withIndexLock(() => withBusyRetry(async () => {
    const db = new DatabaseSync(options.indexPath)
    try {
      ensureSchema(db)
      ensureChunkColumns(db)
      const doc = db.prepare(`
        SELECT id, path, source_path, markdown_path, title, hash, summary, toc_json, summary_version, summary_kind
        FROM kb_docs WHERE id = ?
      `).get(options.docId) as OutlineDocumentRow | undefined
      if (doc === undefined) return undefined
      const target = outlineFilePath(options.indexPath, doc.id)
      const fileExists = await stat(target).then(info => info.isFile() && info.size > 0).catch(() => false)
      const kind = summaryKindOf(doc.summary_kind)
      const sections = storedSections(db, doc.id)
      const toc = storedToc(doc.toc_json)
      const hasStructure = sections.length > 0 || toc.length > 0
      const autoGenerate = options.autoGenerate === true
      let rebuild = options.force === true || !hasStructure
      let nextKind: OutlineSummaryKind = kind

      if (!rebuild) {
        if (kind === 'llm') {
          // A summary version that still names another hash is stale; a custom version
          // (no `llm-v1:` prefix) is left alone because only the caller can interpret it.
          rebuild = !llmVersionMatchesHash(doc.summary_version, doc.hash)
          nextKind = 'llm'
        } else if (kind === 'extractive') {
          // Legacy extractive summaries are kept without regeneration. Turning the
          // config flag on is an explicit request to refresh them.
          rebuild = autoGenerate && doc.summary_version !== summaryVersionFor(doc.hash)
          nextKind = 'extractive'
        } else {
          // A structure-only index is current as long as its structure version names the
          // same source hash and chunker; otherwise the heading rows may be stale.
          const expected = structureVersionFor(doc.hash)
          rebuild = doc.summary_version === null || doc.summary_version === undefined
            ? true
            : doc.summary_version !== expected && doc.summary_version !== summaryVersionFor(doc.hash)
          nextKind = 'none'
        }
      }

      if (!rebuild) {
        const record = outlineRecordFromRow(db, doc, target)
        if (!fileExists) await writeOutlineFile(options.indexPath, doc.id, renderStoredOutline(record))
        return record
      }

      const builtRaw = buildDocumentOutline({
        docId: doc.id,
        docTitle: doc.title,
        sourcePath: doc.source_path ?? doc.path,
        chunks: outlineChunksForDocument(db, doc.id),
      })
      const summaryKind: OutlineSummaryKind = autoGenerate ? 'extractive' : 'none'
      const built = summaryKind === 'none' ? structureOnly(builtRaw) : builtRaw
      const version = summaryKind === 'extractive' ? summaryVersionFor(doc.hash) : structureVersionFor(doc.hash)
      db.exec('BEGIN')
      let markdown: string
      try {
        markdown = storeOutlineForDocument(db, {
          id: doc.id,
          path: doc.path,
          source_path: doc.source_path,
          markdown_path: doc.markdown_path,
          title: doc.title,
        }, built, version, summaryKind)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      await writeOutlineFile(options.indexPath, doc.id, markdown)
      return {
        docId: doc.id,
        path: doc.source_path ?? doc.path,
        markdownPath: doc.markdown_path ?? doc.path,
        title: doc.title,
        summary: built.summary,
        summaryVersion: version,
        summaryKind,
        summaryStatus: summaryKind !== 'none' && built.summary.trim() !== '' ? 'ready' : 'missing',
        sourceChunkIds: built.sourceChunkIds,
        toc: built.toc,
        sections: built.sections,
        indexPath: target,
      }
    } finally {
      db.close()
    }
  }))
}

/** Statistics for one successful outline save. */
export interface OutlineSaveStats {
  /** Document summary written. */
  docSummary: boolean
  /** Section rows replaced (the full heading tree, not only submitted rows). */
  sections: number
  /** Sections whose non-empty summary was written. */
  sectionSummaries: number
  /** Key facts written across all sections. */
  keyFacts: number
  /** Rows inserted into `kb_summary_chunks` (and its FTS mirror). */
  summaryChunks: number
  /** Generated INDEX.md path. */
  indexPath: string
}

/** Result of `kb_outline_save`: either the write statistics or the refused fields. */
export interface OutlineSaveResult {
  ok: boolean
  docId: number
  summaryVersion?: string
  summaryKind: 'llm' | 'none'
  written: OutlineSaveStats
  rejected: OutlineSaveRejection[]
}

/**
 * Persist one model-authored summary set.
 *
 * Validation runs before the transaction, so a refused field writes nothing. The write
 * itself replaces `kb_docs.summary`/`toc_json`/`summary_version`/`summary_kind`, every
 * `kb_sections` row, the `kb_summary_chunks` rows and their FTS mirror, then rewrites the
 * document's INDEX.md. Section structure (ids, heading paths, own chunks) is never
 * invented: unknown ids and foreign chunk ids are refused rather than created.
 */
export async function saveDocumentOutline(options: {
  indexPath: string
  docId: number
  summary: string
  sections: readonly OutlineSectionSubmission[]
  summaryVersion?: string
}): Promise<OutlineSaveResult | undefined> {
  return withIndexLock(() => withBusyRetry(async () => {
    const db = new DatabaseSync(options.indexPath)
    try {
      ensureSchema(db)
      ensureChunkColumns(db)
      const doc = db.prepare(`
        SELECT id, path, source_path, markdown_path, title, hash, summary, toc_json, summary_version, summary_kind
        FROM kb_docs WHERE id = ?
      `).get(options.docId) as OutlineDocumentRow | undefined
      if (doc === undefined) return undefined
      const chunks = outlineChunksForDocument(db, doc.id)
      const stored = storedSections(db, doc.id)
      const rejected: OutlineSaveRejection[] = []
      const requestedVersion = typeof options.summaryVersion === 'string' ? options.summaryVersion.trim() : ''
      if (requestedVersion !== '' && !/^[A-Za-z0-9._:/-]{1,120}$/u.test(requestedVersion)) {
        rejected.push({
          field: 'summaryVersion',
          reason: 'summaryVersion 只能包含字母、数字和 . _ : / -，最长 120 字符',
          value: requestedVersion.slice(0, 160),
        })
      }
      const planResult = planOutlineSave({
        docId: doc.id,
        chunks,
        storedSections: stored,
        submission: {
          docId: doc.id,
          summary: options.summary,
          sections: options.sections,
        },
      })
      const allRejected = planResult.ok ? rejected : [...rejected, ...planResult.rejected]
      if (!planResult.ok || allRejected.length > 0) {
        return {
          ok: false,
          docId: doc.id,
          summaryKind: 'none',
          written: {
            docSummary: false,
            sections: 0,
            sectionSummaries: 0,
            keyFacts: 0,
            summaryChunks: 0,
            indexPath: outlineFilePath(options.indexPath, doc.id),
          },
          rejected: allRejected,
        }
      }

      const plan = planResult.plan
      const digest = createHash('sha256')
        .update(JSON.stringify({ summary: plan.summary, sections: plan.sections.map(section => ({
          sectionId: section.sectionId,
          summary: section.summary,
          keyFacts: section.keyFacts,
        })) }))
        .digest('hex')
        .slice(0, 12)
      const version = requestedVersion !== '' ? requestedVersion : `llm-v1:${doc.hash.slice(0, 12)}:${digest}`
      const storedTocEntries = storedToc(doc.toc_json)
      const built: BuiltOutline = {
        documentTitle: doc.title,
        summary: plan.summary,
        sourceChunkIds: plan.docSourceChunkIds,
        // A legacy index can have section rows but no persisted TOC. Rebuild the TOC from
        // those rows instead of wiping navigation in the saved INDEX.md.
        toc: storedTocEntries.length > 0
          ? storedTocEntries
          : plan.sections.map(section => ({
            sectionId: section.sectionId,
            title: section.title,
            level: section.level,
            chunkIds: [...section.chunkIds],
          })),
        sections: plan.sections,
      }
      const targetPath = outlineFilePath(options.indexPath, doc.id)
      const markdown = renderOutlineMarkdown({
        docId: doc.id,
        docTitle: doc.title,
        sourcePath: doc.source_path ?? doc.path,
        summaryVersion: version,
        summaryKind: 'llm',
        summary: built.summary,
        summarySourceChunkIds: built.sourceChunkIds,
        toc: built.toc,
        sections: built.sections,
      })
      // Write INDEX.md first. A failed file write must not leave the database ahead of the
      // navigation file; if the DB transaction then fails, the previous file is restored.
      const previousMarkdown = await readFile(targetPath, 'utf8').catch(() => undefined)
      const target = await writeOutlineFile(options.indexPath, doc.id, markdown)
      try {
        db.exec('BEGIN')
        try {
          storeOutlineForDocument(db, {
            id: doc.id,
            path: doc.path,
            source_path: doc.source_path,
            markdown_path: doc.markdown_path,
            title: doc.title,
          }, built, version, 'llm')
          db.exec('COMMIT')
        } catch (error) {
          try { db.exec('ROLLBACK') } catch { /* no active transaction */ }
          throw error
        }
      } catch (error) {
        if (previousMarkdown === undefined) await rm(target, { force: true }).catch(() => undefined)
        else await writeOutlineFile(options.indexPath, doc.id, previousMarkdown).catch(() => undefined)
        throw error
      }
      const sectionSummaries = plan.sections.filter(section => section.summary.trim() !== '').length
      const summaryChunks = (plan.summary.trim() === '' ? 0 : 1) + sectionSummaries
      return {
        ok: true,
        docId: doc.id,
        summaryVersion: version,
        summaryKind: 'llm',
        written: {
          docSummary: plan.summary.trim() !== '',
          sections: plan.sections.length,
          sectionSummaries,
          keyFacts: plan.keyFactCount,
          summaryChunks,
          indexPath: target,
        },
        rejected: [],
      }
    } finally {
      db.close()
    }
  }))
}
