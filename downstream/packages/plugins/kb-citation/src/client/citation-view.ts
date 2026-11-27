/**
 * Apply viewer hints after the host opens a KB citation.
 *
 * PDF citations use the page/bbox/text highlighter. Text and spreadsheet viewers do not expose
 * host-level navigation parameters in every build, so their DOM is searched for the line, sheet,
 * and cell markers already rendered by the viewer; a miss is a no-op rather than an ENOENT.
 */
import { citationTargetOf, oneUnionPerPage, resolveKbPath, type Citation, type CitationBox, type CitationBoxGroup, type CitationOpenOptions } from '../shared/citation.ts'
import { highlightDocxChunk, highlightPdfChunk, highlightPdfCitation } from './pdf-highlight.ts'
import { markCitationTiming, recordCitationDebug } from './timing.ts'
import { originalOfficePath, parseBoxes } from '../shared/citation.ts'

/** Only text-like documents consume a line hint; PDF/scanned chunks never do. */
export function isOfficeDocumentPath(path: string | undefined): boolean {
  return path !== undefined && /\.(docx|doc|xlsx|xls|pptx|ppt)$/i.test(path)
}

export function isDocxPath(path: string | undefined): boolean {
  return path !== undefined && /\.(docx|doc)(\.md)?$/i.test(path)
}

export function isTextPath(path: string | undefined): boolean {
  if (path === undefined) return false
  return /\.(md|markdown|txt|json|ya?ml|csv|log|ts|tsx|js|jsx|py|css|html)$/i.test(path)
}

/** Scroll a text/markdown preview to a 1-based line when the viewer exposes a marker. */
export function scrollTextLine(line: number): boolean {
  const candidates = [
    `[data-line-number="${String(line)}"]`,
    `[data-line="${String(line)}"]`,
    `[data-source-line="${String(line)}"]`,
  ]
  for (const selector of candidates) {
    const element = document.querySelector<HTMLElement>(selector)
    if (element !== null) {
      element.scrollIntoView({ block: 'center', behavior: 'smooth' })
      element.classList.add('kb-citation-flash')
      window.setTimeout(() => { element.classList.remove('kb-citation-flash') }, 1800)
      return true
    }
  }
  return false
}

/** Select a sheet tab and scroll a cell into view when the spreadsheet viewer exposes them. */
export function scrollSheetCell(sheet: string | undefined, cell: string | undefined): boolean {
  if (typeof document === 'undefined') return false
  if (sheet !== undefined) {
    const tab = document.querySelector<HTMLElement>(`[data-sheet-name="${CSS.escape(sheet)}"]`)
    tab?.click()
  }
  if (cell === undefined) return false
  const escaped = CSS.escape(cell)
  const target = document.querySelector<HTMLElement>(`[data-cell="${escaped}"], [data-cell-address="${escaped}"], [aria-label="${escaped}"]`)
  if (target === null) return false
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
  target.classList.add('kb-citation-flash')
  window.setTimeout(() => { target.classList.remove('kb-citation-flash') }, 1800)
  return true
}

/** What the KB chunk endpoint returns for one chunk. */
export interface ChunkProvenance {
  readonly path?: string
  readonly docId?: string
  readonly chunkId?: string
  readonly chunkKey?: string
  readonly groups: readonly CitationBoxGroup[]
  readonly line?: number
  readonly quote?: string
  readonly heading?: string
  readonly paragraphText?: string
  readonly chunkText?: string
  readonly paragraphs?: readonly { text: string; ordinal?: number; page?: number }[]
  readonly chunkOrdinal?: number
  /** First derived-markdown line of the chunk, in the same space as the citation's `line`. */
  readonly lineStart?: number
  /** Last derived-markdown line of the chunk, inclusive. */
  readonly lineEnd?: number
  readonly sheet?: string
  readonly cell?: string
}

/**
 * Build one union group per page from a chunk/resolve payload.
 *
 * Newer KB builds return `unionBoxes` (already one rectangle per page). Older builds return
 * `boxes` with one row per extracted block; both shapes are unioned here so the first paint is
 * always a single blue box per page.
 */
export function groupsFromChunkPayload(body: {
  unionBoxes?: unknown
  boxes?: unknown
}): CitationBoxGroup[] {
  const byPage = new Map<number, CitationBox[]>()
  const feed = (rows: unknown): void => {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row !== 'object' || row === null) continue
      const record = row as { page?: unknown; bbox?: unknown }
      const page = Number(record.page)
      const parsed = parseBoxes(typeof record.bbox === 'string' ? record.bbox : JSON.stringify(record.bbox))
      if (!Number.isInteger(page) || page <= 0 || parsed === undefined) continue
      byPage.set(page, [...(byPage.get(page) ?? []), ...parsed])
    }
  }
  feed(body.unionBoxes)
  if (byPage.size === 0) feed(body.boxes)
  const groups: CitationBoxGroup[] = []
  for (const [page, boxes] of [...byPage.entries()].sort((left, right) => left[0] - right[0])) {
    const union = oneUnionPerPage([{ page, boxes }])
    if (union[0] !== undefined) groups.push(union[0])
  }
  return groups
}

/**
 * Resolve one chunk's complete boxes from the KB plugin.
 *
 * The citation token stays compact; the boxes live in SQLite behind the KB API. A failed or
 * malformed response returns undefined so the caller can fall back to the token's page/boxes/quote.
 */
/** Successful chunk provenance is immutable for a reader session; keep it across repeat clicks. */
const CHUNK_CACHE_TTL_MS = 5 * 60_000
const chunkCache = new Map<string, { at: number; value: ChunkProvenance }>()
const chunkPending = new Map<string, Promise<ChunkProvenance | undefined>>()
const sourceTextCache = new Map<string, { at: number; text: string }>()
const sourceTextPending = new Map<string, Promise<string | undefined>>()
const resolveCache = new Map<string, { at: number; value: ChunkProvenance }>()
const resolvePending = new Map<string, Promise<ChunkProvenance | undefined>>()

/**
 * Chunks already resolved for a document, with the derived-markdown line range each one owns.
 *
 * A message often cites several lines of the same document. The KB resolve endpoint answers one
 * line at a time, so without this index every chip paid its own `/resolve`; a resolved chunk
 * already states `lineStart`/`lineEnd`, and any later citation inside that range with matching
 * text is the same chunk and needs no second round trip.
 */
interface ResolvedLineRange {
  readonly lineStart: number
  readonly lineEnd: number
  readonly key: string
  readonly value: ChunkProvenance
}
const resolvedLineRanges = new Map<string, ResolvedLineRange[]>()
/** Resolved chunks retained per document; beyond this the oldest range is dropped. */
const MAX_RESOLVED_RANGES_PER_DOCUMENT = 64

/**
 * One same-document resolve queue.
 *
 * Every chip in a rendered message enqueues in the same task, so a single request can answer the
 * chunks around it before the next line asks. Resolving one document at a time also stops a long
 * answer from opening dozens of SQLite reads at once; different documents still run in parallel.
 */
const documentResolveTails = new Map<string, { tail: Promise<unknown>; pending: number }>()

/** Counts for field diagnosis; published through `recordCitationDebug` when debug is enabled. */
const resolveDiagnostics = {
  resolveRequests: 0,
  sourceReads: 0,
  rangeHits: 0,
  sourceReadHits: 0,
}

function bumpResolveDiagnostic(key: keyof typeof resolveDiagnostics): void {
  resolveDiagnostics[key] += 1
  recordCitationDebug('resolve-cache', { ...resolveDiagnostics })
}

/** Drop cached chunk provenance, source text, line resolutions and line ranges, for tests or after an index rebuild. */
export function clearChunkCache(): void {
  chunkCache.clear()
  chunkPending.clear()
  sourceTextCache.clear()
  sourceTextPending.clear()
  resolveCache.clear()
  resolvePending.clear()
  resolvedLineRanges.clear()
  documentResolveTails.clear()
}

/**
 * Resolve one chunk, sharing an in-flight request and a short-lived cache.
 *
 * A citation click used to pay a `/knowledge-base/api/chunk` round trip every time, and the
 * chip's label enrichment paid it again. The chunk row cannot change while a reader is on the
 * page, so a five-minute hit is safe; a failed request is never cached, which keeps the first
 * click after a JWT sync working.
 */
export async function fetchChunkGroups(docId: string | undefined, chunkId: string | undefined): Promise<ChunkProvenance | undefined> {
  if (docId === undefined || chunkId === undefined || !/^\d+$/.test(docId)) return undefined
  const key = docId + ':' + chunkId.trim()
  const cached = chunkCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < CHUNK_CACHE_TTL_MS) return cached.value
  const pending = chunkPending.get(key)
  if (pending !== undefined) return pending
  const task = fetchChunkGroupsUncached(docId, chunkId)
    .then(value => {
      if (value !== undefined) chunkCache.set(key, { at: Date.now(), value })
      return value
    })
    .finally(() => { chunkPending.delete(key) })
  chunkPending.set(key, task)
  return task
}

async function fetchChunkGroupsUncached(docId: string | undefined, chunkId: string | undefined): Promise<ChunkProvenance | undefined> {
  if (docId === undefined || chunkId === undefined || !/^\d+$/.test(docId)) return undefined
  const chunkKey = chunkId.trim()
  if (chunkKey === '') return undefined
  // Current indexes mint a 16-hex chunk_key (`e63b7f9eda2d86cb`); legacy rows use a numeric id.
  // The endpoint accepts either, but a numeric string must stay a JSON number for old rows and a
  // key must stay a JSON string so `findChunkId` can look it up in `kb_chunks.chunk_key`.
  const numericChunk = /^\d+$/.test(chunkKey)
  try {
    const response = await fetch('/knowledge-base/api/chunk', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ docId: Number(docId), chunkId: numericChunk ? Number(chunkKey) : chunkKey }),
    })
    if (!response.ok) return undefined
    const body = await response.json() as {
      path?: unknown
      line?: unknown
      lineStart?: unknown
      snippet?: unknown
      quote?: unknown
      paragraphText?: unknown
      chunkText?: unknown
      paragraphs?: unknown
      heading?: unknown
      docId?: unknown
      chunkId?: unknown
      chunkKey?: unknown
      sheet?: unknown
      cell?: unknown
      chunkOrdinal?: unknown
      ordinal?: unknown
      boxes?: readonly { page?: unknown; bbox?: unknown }[]
      unionBoxes?: readonly { page?: unknown; bbox?: unknown }[]
    }
    const groups = groupsFromChunkPayload(body)
    const path = typeof body.path === 'string' ? resolveKbPath(body.path) : undefined
    const lineValue = typeof body.lineStart === 'number' ? body.lineStart : body.line
    const line = typeof lineValue === 'number' && Number.isInteger(lineValue) && lineValue > 0 ? lineValue : undefined
    const quoteValue = typeof body.quote === 'string' && body.quote.trim() !== ''
      ? body.quote
      : typeof body.snippet === 'string' && body.snippet.trim() !== '' ? body.snippet : typeof body.paragraphText === 'string' ? body.paragraphText : undefined
    const quote = quoteValue !== undefined && quoteValue.trim() !== '' ? quoteValue : undefined
    const heading = typeof body.heading === 'string' && body.heading.trim() !== '' ? body.heading : undefined
    const paragraphText = typeof body.paragraphText === 'string' && body.paragraphText.trim() !== '' ? body.paragraphText : undefined
    const chunkText = typeof body.chunkText === 'string' && body.chunkText.trim() !== '' ? body.chunkText : undefined
    const paragraphs = Array.isArray(body.paragraphs) ? body.paragraphs.flatMap((value: unknown) => {
      if (typeof value === 'string') return value.trim() === '' ? [] : [{ text: value }]
      if (typeof value !== 'object' || value === null) return []
      const record = value as { text?: unknown; ordinal?: unknown; page?: unknown }
      return typeof record.text === 'string' && record.text.trim() !== '' ? [{ text: record.text, ...(typeof record.ordinal === 'number' ? { ordinal: record.ordinal } : {}), ...(typeof record.page === 'number' ? { page: record.page } : {}) }] : []
    }) : undefined
    const ordinalValue = typeof body.chunkOrdinal === 'number' ? body.chunkOrdinal : body.ordinal
    const chunkOrdinal = typeof ordinalValue === 'number' && Number.isInteger(ordinalValue) && ordinalValue >= 0 ? ordinalValue : undefined
    const sheet = typeof body.sheet === 'string' && body.sheet.trim() !== '' ? body.sheet : undefined
    const cell = typeof body.cell === 'string' && body.cell.trim() !== '' ? body.cell : undefined
    return {
      ...(path === undefined ? {} : { path }),
      ...(typeof body.docId === 'number' ? { docId: String(body.docId) } : {}),
      ...(typeof body.chunkId === 'number' ? { chunkId: String(body.chunkId) } : {}),
      ...(typeof body.chunkKey === 'string' && body.chunkKey.trim() !== '' ? { chunkKey: body.chunkKey } : {}),
      ...(line === undefined ? {} : { line }),
      ...(quote === undefined ? {} : { quote }),
      ...(heading === undefined ? {} : { heading }),
      ...(paragraphText === undefined ? {} : { paragraphText }),
      ...(chunkText === undefined ? {} : { chunkText }),
      ...(paragraphs === undefined ? {} : { paragraphs }),
      ...(chunkOrdinal === undefined ? {} : { chunkOrdinal }),
      ...(sheet === undefined ? {} : { sheet }),
      ...(cell === undefined ? {} : { cell }),
      groups,
    }
  } catch {
    return undefined
  }
}

/** One raw resolve response, before its chunk is checked against the cited line. */
async function fetchResolveAt(path: string, line?: number): Promise<ChunkProvenance | undefined> {
  try {
    bumpResolveDiagnostic('resolveRequests')
    const response = await fetch('/knowledge-base/api/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ path: path.replace(/^\/workspace\/kb\//, '').replace(/^\/workspace\//, ''), ...(line === undefined ? {} : { line }) }),
    })
    if (!response.ok) return undefined
    const body = await response.json() as {
      path?: unknown
      quote?: unknown
      heading?: unknown
      paragraphText?: unknown
      chunkText?: unknown
      paragraphs?: unknown
      docId?: unknown
      chunkId?: unknown
      chunkKey?: unknown
      sheet?: unknown
      cell?: unknown
      chunkOrdinal?: unknown
      ordinal?: unknown
      line?: unknown
      lineStart?: unknown
      lineEnd?: unknown
      boxes?: readonly { page?: unknown; bbox?: unknown }[]
      unionBoxes?: readonly { page?: unknown; bbox?: unknown }[]
    }
    const groups = groupsFromChunkPayload(body)
    const resolved = typeof body.path === 'string' ? resolveKbPath(body.path) : undefined
    const ordinalValue = typeof body.chunkOrdinal === 'number' ? body.chunkOrdinal : body.ordinal
    const chunkOrdinal = typeof ordinalValue === 'number' && Number.isInteger(ordinalValue) && ordinalValue >= 0 ? ordinalValue : undefined
    const lineStartValue = typeof body.lineStart === 'number' ? body.lineStart : body.line
    const lineStart = typeof lineStartValue === 'number' && Number.isInteger(lineStartValue) && lineStartValue > 0 ? lineStartValue : undefined
    const lineEndValue = typeof body.lineEnd === 'number' ? body.lineEnd : undefined
    const lineEnd = typeof lineEndValue === 'number' && Number.isInteger(lineEndValue) && lineStart !== undefined && lineEndValue >= lineStart
      ? lineEndValue
      : lineStart
    const sheet = typeof body.sheet === 'string' && body.sheet.trim() !== '' ? body.sheet : undefined
    const cell = typeof body.cell === 'string' && body.cell.trim() !== '' ? body.cell : undefined
    return {
      ...(resolved === undefined ? {} : { path: resolved }),
      ...(typeof body.docId === 'number' ? { docId: String(body.docId) } : {}),
      ...(typeof body.chunkId === 'number' ? { chunkId: String(body.chunkId) } : {}),
      ...(typeof body.chunkKey === 'string' && body.chunkKey.trim() !== '' ? { chunkKey: body.chunkKey } : {}),
      ...(lineStart === undefined ? {} : { lineStart }),
      ...(lineEnd === undefined ? {} : { lineEnd }),
      ...(typeof body.quote === 'string' && body.quote.trim() !== '' ? { quote: body.quote } : {}),
      ...(typeof body.heading === 'string' && body.heading.trim() !== '' ? { heading: body.heading } : {}),
      ...(typeof body.paragraphText === 'string' && body.paragraphText.trim() !== '' ? { paragraphText: body.paragraphText } : {}),
      ...(typeof body.chunkText === 'string' && body.chunkText.trim() !== '' ? { chunkText: body.chunkText } : {}),
      ...(Array.isArray(body.paragraphs) ? { paragraphs: body.paragraphs.flatMap((value: unknown) => {
        if (typeof value === 'string') return value.trim() === '' ? [] : [{ text: value }]
        if (typeof value !== 'object' || value === null) return []
        const record = value as { text?: unknown; ordinal?: unknown; page?: unknown }
        return typeof record.text === 'string' && record.text.trim() !== '' ? [{ text: record.text, ...(typeof record.ordinal === 'number' ? { ordinal: record.ordinal } : {}), ...(typeof record.page === 'number' ? { page: record.page } : {}) }] : []
      }) } : {}),
      ...(chunkOrdinal === undefined ? {} : { chunkOrdinal }),
      ...(sheet === undefined ? {} : { sheet }),
      ...(cell === undefined ? {} : { cell }),
      groups,
    }
  } catch {
    return undefined
  }
}

/** One cited source line together with its position in the index's paragraph space. */
export interface SourceLine {
  readonly text: string
  /**
   * 1-based count of non-empty lines up to and including the requested line.
   *
   * The knowledge-base chunker records `kb_chunks.line` from the newline count of the
   * overlapping chunk *content*, which makes it a paragraph ordinal rather than a source-file
   * line. `findChunkForPath` compares the caller's source line against that column and falls
   * back to the *nearest* chunk when no range matches, so a long citation silently lands on the
   * document's last chunk. The ordinal is the second candidate to try in that space.
   */
  readonly paragraphOrdinal: number
}

/** Drop whitespace so extracted DOCX/PDF text can be compared across line wrapping. */
function normalizedCitationText(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u3000]+/gu, '')
}

/** Read the derived text beside a cited file so a line can be checked against a chunk. */
async function fetchSourceText(path: string): Promise<string | undefined> {
  const relative = path.replace(/^\/workspace\/kb\//, '').replace(/^\/workspace\//, '')
  if (relative === '') return undefined
  const cached = sourceTextCache.get(relative)
  if (cached !== undefined && Date.now() - cached.at < CHUNK_CACHE_TTL_MS) {
    bumpResolveDiagnostic('sourceReadHits')
    return cached.text
  }
  // One in-flight read per document: a message with N line citations used to start N reads of
  // the same (often large) derived markdown before the first one landed.
  const pending = sourceTextPending.get(relative)
  if (pending !== undefined) {
    bumpResolveDiagnostic('sourceReadHits')
    return pending
  }
  bumpResolveDiagnostic('sourceReads')
  const task = fetchSourceTextUncached(relative)
    .then(text => {
      if (text !== undefined) sourceTextCache.set(relative, { at: Date.now(), text })
      return text
    })
    .finally(() => { sourceTextPending.delete(relative) })
  sourceTextPending.set(relative, task)
  return task
}

async function fetchSourceTextUncached(relative: string): Promise<string | undefined> {
  try {
    const response = await fetch('/knowledge-base/api/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ path: relative }),
    })
    if (!response.ok) return undefined
    const body = await response.json() as { kind?: unknown; content?: unknown }
    if (body.kind !== 'text' || typeof body.content !== 'string') return undefined
    return body.content
  } catch {
    return undefined
  }
}

/**
 * Locate one 1-based line in a source text and count the non-empty lines before it.
 *
 * @param text - derived Markdown/plain text of the cited file.
 * @param line - 1-based source line from the citation.
 * @returns the trimmed line and its paragraph ordinal, or undefined when out of range.
 */
export function sourceLineAt(text: string, line: number): SourceLine | undefined {
  if (!Number.isInteger(line) || line <= 0) return undefined
  const lines = text.split(/\r?\n/)
  if (line > lines.length) return undefined
  let paragraphOrdinal = 0
  for (let index = 0; index < line; index += 1) {
    if ((lines[index] ?? '').trim() !== '') paragraphOrdinal += 1
  }
  return { text: (lines[line - 1] ?? '').trim(), paragraphOrdinal }
}

/**
 * Whether a resolved chunk really contains the cited source line.
 *
 * The first 48 normalized characters are the probe: long enough to include the article number
 * and its operative words, short enough to survive the chunker's 800-character split.
 */
export function chunkContainsSourceLine(chunkText: string, lineText: string): boolean {
  const needle = normalizedCitationText(lineText)
  if (needle === '') return true
  return normalizedCitationText(chunkText).includes(needle.slice(0, 48))
}

/** The text a provenance record carries, whichever field the endpoint populated. */
function provenanceText(chunk: ChunkProvenance): string {
  return chunk.chunkText ?? chunk.paragraphText ?? chunk.quote ?? ''
}

/** Stable citation token for a resolved chunk; label and click both reuse this id. */
export function citationTokenForChunk(chunk: Pick<ChunkProvenance, 'docId' | 'chunkId' | 'chunkKey'>): string | undefined {
  const key = chunk.chunkKey === undefined || chunk.chunkKey === '' ? chunk.chunkId : chunk.chunkKey
  if (chunk.docId === undefined || key === undefined || key === '') return undefined
  return 'kb://doc/' + chunk.docId + '/chunk/' + key
}

/** Normalize a cited path to the spelling the resolve body and the source cache use. */
function relativeResolvePath(path: string): string {
  return path.replace(/^\/workspace\/kb\//, '').replace(/^\/workspace\//, '')
}

/** Cache the derived-markdown line range a verified chunk owns. */
function rememberResolvedRange(path: string, chunk: ChunkProvenance): void {
  const lineStart = chunk.lineStart
  const lineEnd = chunk.lineEnd ?? lineStart
  if (lineStart === undefined || lineEnd === undefined) return
  const key = relativeResolvePath(path)
  if (key === '') return
  const identity = chunk.chunkKey ?? chunk.chunkId ?? (chunk.chunkOrdinal === undefined ? '' : 'ord:' + String(chunk.chunkOrdinal))
  if (identity === '') return
  const ranges = resolvedLineRanges.get(key) ?? []
  if (ranges.some(entry => entry.key === identity && entry.lineStart === lineStart && entry.lineEnd === lineEnd)) return
  ranges.push({ lineStart, lineEnd, key: identity, value: chunk })
  while (ranges.length > MAX_RESOLVED_RANGES_PER_DOCUMENT) ranges.shift()
  resolvedLineRanges.set(key, ranges)
}

/**
 * Whether an already resolved chunk owns this line.
 *
 * The range alone is not proof: chunker versions disagree about whether `line` is a source line
 * or a paragraph ordinal, so the cited text must also appear in the chunk. A miss falls through
 * to the resolve endpoint, which has the full index.
 */
function cachedResolveForLine(path: string, line: number, lineText: string): ChunkProvenance | undefined {
  for (const entry of resolvedLineRanges.get(relativeResolvePath(path)) ?? []) {
    if (line < entry.lineStart || line > entry.lineEnd) continue
    if (!chunkContainsSourceLine(provenanceText(entry.value), lineText)) continue
    bumpResolveDiagnostic('rangeHits')
    return entry.value
  }
  return undefined
}

/**
 * Queue one resolve behind the previous request for the same document.
 *
 * The first chip resolves its chunk; chips inside the same chunk then answer from
 * {@link cachedResolveForLine} instead of sending their own request. Different documents keep
 * their own queues, so an answer citing several files still resolves them in parallel.
 */
function enqueueDocumentResolve<T>(path: string, task: () => Promise<T>): Promise<T> {
  const key = relativeResolvePath(path)
  const entry = documentResolveTails.get(key) ?? { tail: Promise.resolve(), pending: 0 }
  entry.pending += 1
  const run = entry.tail.catch(() => undefined).then(task)
  entry.tail = run as Promise<unknown>
  documentResolveTails.set(key, entry)
  return run.finally(() => {
    entry.pending -= 1
    if (entry.pending === 0 && documentResolveTails.get(key) === entry) documentResolveTails.delete(key)
  })
}

/** Milliseconds for the opt-in citation timeline. */
function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

/**
 * Resolve a path+line citation to the chunk that owns that line, and prove it owns the line.
 *
 * A resolve that cannot be checked stays trusted (the read preview may be unavailable for a
 * binary source); a resolve that *is* checked and fails is rejected. When the first lookup fails
 * the check, retry in the index's paragraph-ordinal space before rejecting: every 0911 DOCX
 * citation lands on the nearest chunk otherwise, e.g. line 137 (第十五条) opened 第9块
 * (第二十一条/第二十二条).
 */
export async function fetchResolve(path: string, line?: number): Promise<ChunkProvenance | undefined> {
  const key = path + '|' + String(line ?? '')
  const cached = resolveCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < CHUNK_CACHE_TTL_MS) return cached.value
  const pending = resolvePending.get(key)
  if (pending !== undefined) return pending
  const startedAt = nowMs()
  const task = enqueueDocumentResolve(path, () => fetchVerifiedResolve(path, line))
    .then(value => {
      // A failed/mismatched resolution is never cached: the next click after an index rebuild
      // must be allowed to recover without waiting for the five-minute window.
      if (value !== undefined) resolveCache.set(key, { at: Date.now(), value })
      markCitationTiming(
        'citation-resolve',
        path + ':' + String(line ?? '') + ' ' + Math.round(nowMs() - startedAt).toString() + 'ms '
          + (value === undefined ? 'miss' : 'hit'),
      )
      return value
    })
    .finally(() => { resolvePending.delete(key) })
  resolvePending.set(key, task)
  return task
}

/** The derived source text when it is already cached; never starts a read. */
function cachedSourceText(path: string): string | undefined {
  const cached = sourceTextCache.get(relativeResolvePath(path))
  if (cached === undefined || Date.now() - cached.at >= CHUNK_CACHE_TTL_MS) return undefined
  return cached.text
}

/** The uncached half of {@link fetchResolve}: resolve, check the line, retry once. */
async function fetchVerifiedResolve(path: string, line?: number): Promise<ChunkProvenance | undefined> {
  if (line === undefined) {
    const resolved = await fetchResolveAt(path)
    if (resolved !== undefined) rememberResolvedRange(path, resolved)
    return resolved
  }
  // A document already read for an earlier chip can answer a line inside one of its resolved
  // chunks without touching the resolve endpoint. Only the cache is consulted here: the first
  // chip still resolves before reading, so this adds no request to the cold path.
  const knownSource = cachedSourceText(path)
  if (knownSource !== undefined) {
    const knownAt = sourceLineAt(knownSource, line)
    if (knownAt !== undefined && knownAt.text !== '') {
      const local = cachedResolveForLine(path, line, knownAt.text)
      if (local !== undefined) {
        recordCitationDebug('resolve-range-hit', { path, line, chunkOrdinal: local.chunkOrdinal ?? null, range: [local.lineStart ?? null, local.lineEnd ?? null] })
        return local
      }
    }
  }
  const first = await fetchResolveAt(path, line)
  if (first === undefined) return undefined
  const source = await fetchSourceText(path)
  if (source === undefined) {
    rememberResolvedRange(path, first)
    return first
  }
  const at = sourceLineAt(source, line)
  if (at === undefined) return undefined
  if (at.text === '') {
    rememberResolvedRange(path, first)
    return first
  }
  if (chunkContainsSourceLine(provenanceText(first), at.text)) {
    rememberResolvedRange(path, first)
    return first
  }
  if (at.paragraphOrdinal !== line) {
    const retry = await fetchResolveAt(path, at.paragraphOrdinal)
    if (retry !== undefined && chunkContainsSourceLine(provenanceText(retry), at.text)) {
      rememberResolvedRange(path, retry)
      recordCitationDebug('resolve-line-retry', {
        path, line, paragraphOrdinal: at.paragraphOrdinal,
        rejectedOrdinal: first.chunkOrdinal ?? null, chunkOrdinal: retry.chunkOrdinal ?? null,
      })
      return retry
    }
  }
  recordCitationDebug('resolve-line-mismatch', {
    path, line, paragraphOrdinal: at.paragraphOrdinal,
    chunkOrdinal: first.chunkOrdinal ?? null, chunkKey: first.chunkKey ?? null,
    lineText: at.text.slice(0, 80),
  })
  return undefined
}

/** A citation resolved far enough to call the host opener. */
export interface ResolvedCitationTarget {
  readonly path: string
  readonly options: CitationOpenOptions
  readonly citation: Citation
}

/**
 * Resolve one source row to a file path. A path-bearing token opens directly; a bare chunk
 * token first asks the KB endpoint for the chunk's path and all page boxes.
 */
export async function resolveOpenTarget(
  citation: Citation,
  fetcher: typeof fetchChunkGroups = fetchChunkGroups,
): Promise<ResolvedCitationTarget | undefined> {
  const target = citationTargetOf(citation)
  if (target === undefined) return undefined
  if (target.path !== undefined) {
    const path = originalOfficePath(target.path)
    // A .docx.md:73 link has a line but no chunkId; resolve it to the owning chunk so the
    // document tab can draw the quote boxes instead of showing a blank Office preview.
    if (citation.line !== undefined && (isOfficeDocumentPath(path) || path.toLowerCase().endsWith('.pdf'))) {
      const chunk = await fetchResolve(citation.path ?? target.path, citation.line)
      // A cited line that cannot be proven to belong to any chunk must not open the nearest
      // chunk; the caller shows 引用已失效 instead. Opening the file at page 1 would be just
      // as misleading as opening the wrong paragraph.
      if (chunk === undefined) return undefined
      const chunkId = chunk.chunkKey ?? chunk.chunkId
      return {
        path: chunk.path === undefined ? path : originalOfficePath(chunk.path),
        options: {
          ...target.options,
          ...(chunkId === undefined ? {} : { chunkId }),
          ...(chunk.groups.length === 0 ? {} : { chunkGroups: chunk.groups }),
          ...(chunk.chunkOrdinal === undefined ? {} : { chunkOrdinal: chunk.chunkOrdinal }),
          ...(chunk.sheet === undefined ? {} : { sheet: chunk.sheet }),
          ...(chunk.cell === undefined ? {} : { cell: chunk.cell }),
        },
        citation: {
          ...citation, path: chunk.path === undefined ? path : originalOfficePath(chunk.path),
          ...(chunkId === undefined ? {} : { chunkId }),
          ...(chunk.quote === undefined ? {} : { quote: chunk.quote }),
          ...(chunk.heading === undefined ? {} : { heading: chunk.heading }),
          ...(chunk.paragraphText === undefined ? {} : { paragraphText: chunk.paragraphText }),
          ...(chunk.chunkText === undefined ? {} : { chunkText: chunk.chunkText }),
          ...(chunk.paragraphs === undefined ? {} : { paragraphs: chunk.paragraphs }),
          ...(chunk.chunkOrdinal === undefined ? {} : { chunkOrdinal: chunk.chunkOrdinal }),
        },
      }
    }
    // Inline office links may carry both path and chunkId. Fetch the chunk so the viewer gets
    // the real quote/boxes instead of only renaming `.docx.md` and opening a blank preview.
    if (citation.chunkId !== undefined && isOfficeDocumentPath(path)) {
      const chunk = await fetcher(citation.docId, citation.chunkId)
      if (chunk !== undefined) {
        return {
          path: chunk.path === undefined ? path : originalOfficePath(resolveKbPath(chunk.path) ?? path),
          options: {
            ...target.options,
            ...((chunk.chunkKey ?? chunk.chunkId) === undefined ? {} : { chunkId: chunk.chunkKey ?? chunk.chunkId }),
            ...(chunk.groups.length === 0 ? {} : { chunkGroups: chunk.groups }),
            ...(chunk.chunkOrdinal === undefined ? {} : { chunkOrdinal: chunk.chunkOrdinal }),
            ...(chunk.sheet === undefined ? {} : { sheet: chunk.sheet }),
            ...(chunk.cell === undefined ? {} : { cell: chunk.cell }),
            ...(chunk.line === undefined ? {} : { line: chunk.line }),
          },
          citation: {
            ...citation, path,
            ...(chunk.quote === undefined ? {} : { quote: chunk.quote }),
            ...(chunk.heading === undefined ? {} : { heading: chunk.heading }),
            ...(chunk.paragraphText === undefined ? {} : { paragraphText: chunk.paragraphText }),
            ...(chunk.chunkText === undefined ? {} : { chunkText: chunk.chunkText }),
            ...(chunk.paragraphs === undefined ? {} : { paragraphs: chunk.paragraphs }),
            ...(chunk.chunkOrdinal === undefined ? {} : { chunkOrdinal: chunk.chunkOrdinal }),
          },
        }
      }
    }
    return { path, options: target.options, citation: { ...citation, path } }
  }
  if (target.docId === undefined || target.chunkId === undefined) return undefined
  const chunk = await fetcher(target.docId, target.chunkId)
  if (chunk === undefined || chunk.path === undefined) return undefined
  const resolved = resolveKbPath(chunk.path)
  if (resolved === undefined) return undefined
  const path = originalOfficePath(resolved)
  return {
    path,
    options: {
      ...target.options,
      ...(chunk.line === undefined ? {} : { line: chunk.line }),
      ...(chunk.chunkOrdinal === undefined ? {} : { chunkOrdinal: chunk.chunkOrdinal }),
      ...(chunk.sheet === undefined ? {} : { sheet: chunk.sheet }),
      ...(chunk.cell === undefined ? {} : { cell: chunk.cell }),
      ...(chunk.groups.length === 0 ? {} : { chunkGroups: chunk.groups }),
    },
    citation: {
      ...citation, path,
      ...(chunk.quote === undefined ? {} : { quote: chunk.quote }),
      ...(chunk.heading === undefined ? {} : { heading: chunk.heading }),
      ...(chunk.paragraphText === undefined ? {} : { paragraphText: chunk.paragraphText }),
      ...(chunk.chunkText === undefined ? {} : { chunkText: chunk.chunkText }),
      ...(chunk.paragraphs === undefined ? {} : { paragraphs: chunk.paragraphs }),
      ...(chunk.chunkOrdinal === undefined ? {} : { chunkOrdinal: chunk.chunkOrdinal }),
    },
  }
}

/** Prefer token groups; only call the KB chunk endpoint when the token carries no complete groups. */
export async function resolveChunkGroups(
  citation: Pick<Citation, 'docId' | 'chunkId'>,
  options: CitationOpenOptions,
  fetcher: typeof fetchChunkGroups = fetchChunkGroups,
): Promise<readonly CitationBoxGroup[] | undefined> {
  // A token minted before the union fix can still carry several boxes per page; normalize it so
  // the painter never sees a paragraph stack.
  if (options.chunkGroups !== undefined && options.chunkGroups.length > 0) return oneUnionPerPage(options.chunkGroups)
  const fetched = await fetcher(citation.docId, options.chunkId ?? citation.chunkId)
  return fetched === undefined ? undefined : oneUnionPerPage(fetched.groups)
}

/**
 * Wait for the document tab that owns this path to become the active tab.
 *
 * The host opens the tab asynchronously, and the previous implementation always paid a blind
 * 500 ms after asking for it. Watching the tab strip instead lets a warm tab proceed at once and
 * a cold tab proceed as soon as the title appears, while `highlightDocxChunk` keeps waiting for
 * the page layout that actually matters.
 */
export async function waitForDocumentTab(path: string, timeoutMs = 1500): Promise<void> {
  if (typeof document === 'undefined') return
  const name = path.split('/').pop() ?? path
  const started = Date.now()
  for (;;) {
    const titles = [...document.querySelectorAll<HTMLElement>('[class*="tabTitle"], [role="tab"]')]
    const active = titles.find(element => (element.textContent ?? '').includes(name)
      && (element.className.includes('tabActive') || element.closest('[class*="tabActive"]') !== null))
    if (active !== undefined) {
      markCitationTiming('document-tab', name)
      return
    }
    if (Date.now() - started > timeoutMs) {
      markCitationTiming('document-tab-timeout', name)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 40))
  }
}

/**
 * Ordinary words that match half the document and therefore say nothing about relevance.
 *
 * The amber layer answers "did the reader's question land on this page", so a term that appears
 * in every article (董事/董事会/公司/会议/通过) turns an unrelated page yellow and makes the
 * citation look wrong. Keep domain-intent words such as 表决/过半数/三分之二 and multi-character
 * phrases such as 董事会议事规则.
 */
const GENERIC_QUERY_TERMS = new Set([
  '董事', '董事会', '经营', '班子', '经营班子会', '公司', '集团', '有限', '责任',
  '会议', '通过', '规则', '制度', '管理', '办法', '工作', '人员', '相关', '有关',
  '问题', '情况', '区别', '不同', '需要', '应当', '可以', '进行', '使用',
  '知识库', '检索', '查询', '搜索', '回答',
])

/** Drop generic/function words while preserving real query phrases. */
export function specificQueryTerms(terms: readonly string[]): string[] {
  return [...new Set(terms
    .map(term => term.trim())
    .filter(term => term.length >= 2
      && !GENERIC_QUERY_TERMS.has(term)
      && !/^[\d\s\p{P}\p{S}]+$/u.test(term)))]
}

/** Apply one citation's hints after its file tab has mounted. */
/**
 * Extract real search terms from the latest user prompt; empty when unavailable.
 *
 * The prompt row also contains the message timestamp and adjacent chrome, and a bare `10:18`
 * becomes the term `10`, which then matches page numbers and article numbers instead of the
 * question. Only the message body is segmented, and pure numbers/symbols are dropped.
 */
export function queryTermsFromPrompt(raw: string): string[] {
  const text = raw
    // A search instruction ("请使用知识库工具检索后回答") is chrome around the question, not a
    // topic. Left in, 工具/使用/知识 become terms that highlight unrelated body text.
    .replace(/请(?:你)?(?:使用|用|调用|通过)[^。！？?\n]*?(?:知识库|检索|查询|搜索|工具)[^。！？?\n]*?回答[。！？?]?/g, '')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line !== ''
      && !/^\d{1,2}[:：]\d{2}$/.test(line)
      && !/^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?$/.test(line)
      && !/^(复制|编辑|重新生成|发送|已编辑)$/.test(line))
    .join('\n')
  if (text.trim() === '') return []
  const stop = new Set(['什么', '怎么', '如何', '哪些', '是否', '以及', '一个', '这个', '那个', '我们', '请问', '不同', '区别', '一下', '可以', '需要', '请使用', '回答', '检索', '使用', '查询', '搜索'])
  const keep = (term: string): boolean => term.length >= 2 && !stop.has(term) && !/^[\d\s\p{P}\p{S}]+$/u.test(term)
  try {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
    return [...new Set([...segmenter.segment(text)].filter(part => part.isWordLike).map(part => part.segment.trim()).filter(keep))]
  } catch {
    return [...new Set(text.split(/[?？。！!，,、；;：:\s]+/).map(term => term.trim()).filter(keep))]
  }
}

/** The latest user prompt body, ignoring chrome that shares the message row. */
export function latestUserPromptText(): string {
  const users = [...document.querySelectorAll<HTMLElement>('[data-chat-flow-kind="user"]')]
  const last = users.at(-1)
  if (last === undefined) return ''
  const text = (last.innerText ?? '').trim() !== '' ? last.innerText : last.textContent ?? ''
  return text
}

/** Extract real search terms from the latest user prompt; empty when unavailable. */
export function userQueryTerms(): string[] {
  const text = latestUserPromptText()
  if (text.trim() === '') return []
  const terms = queryTermsFromPrompt(text)
  recordCitationDebug('userPrompt', { raw: text.slice(0, 400), terms })
  return terms
}

export async function applyCitationView(citation: Citation, options: CitationOpenOptions): Promise<void> {
  if (typeof document === 'undefined') return
  // Prefer the terms the KB says matched this chunk. Re-segmenting the question is only a
  // fallback for tokens that carry no `terms` hint (for example a plain path link).
  const tokenTerms = citation.matchedTerms ?? []
  const terms = specificQueryTerms(tokenTerms.length > 0 ? tokenTerms : userQueryTerms())
  recordCitationDebug('apply', {
    tokenTerms,
    path: citation.path,
    chunkId: options.chunkId ?? citation.chunkId,
    chunkOrdinal: citation.chunkOrdinal,
    quoteChars: citation.quote?.length ?? 0,
    chunkTextChars: citation.chunkText?.length ?? 0,
    paragraphChars: citation.paragraphText?.length ?? 0,
    paragraphs: citation.paragraphs?.length ?? 0,
    queryTerms: terms,
    pages: options.chunkGroups?.map(group => group.page) ?? (citation.page === undefined ? [] : [citation.page]),
  })
  if (isDocxPath(citation.path)) {
    markCitationTiming('apply-docx', `ordinal=${String(citation.chunkOrdinal ?? '-')} paragraphs=${String(citation.paragraphs?.length ?? 0)}`)
    await highlightDocxChunk({
      docKey: citation.path ?? (citation.docId === undefined ? undefined : 'doc:' + String(citation.docId)),
      chunkKey: options.chunkId ?? citation.chunkId,
      ...(citation.quote === undefined ? {} : { quote: citation.quote }),
      ...(citation.heading === undefined ? {} : { heading: citation.heading }),
      ...(citation.paragraphText === undefined ? {} : { paragraphText: citation.paragraphText }),
      ...(citation.chunkText === undefined ? {} : { chunkText: citation.chunkText }),
      ...(citation.paragraphs === undefined ? {} : { paragraphs: citation.paragraphs }),
      ...(citation.chunkOrdinal === undefined ? {} : { chunkOrdinal: citation.chunkOrdinal }),
      // Amber is the user's question landing on the page, not a second rendering of the chunk
      // quote. With no usable term there is nothing to highlight, and drawing the quote would
      // fake a match the reader never asked for.
      ...(terms.length === 0 ? {} : { query: terms.join(' '), queryTerms: terms }),
      ...(options.chunkGroups === undefined ? {} : { pages: [...new Set(options.chunkGroups.map(group => group.page))] }),
      ...(citation.page === undefined || options.chunkGroups !== undefined ? {} : { pages: [citation.page] }),
    })
    return
  }
  if (citation.path?.toLowerCase().endsWith('.pdf') === true) {
    // Chunk-first: the token carries a chunkId but not necessarily every box. Ask the KB
    // endpoint for the complete group before falling back to the token's single page.
    const groups = await resolveChunkGroups(citation, options)
    if (groups !== undefined && groups.length > 0) {
      await highlightPdfChunk(groups)
      return
    }
    await highlightPdfCitation({
      ...(options.page === undefined ? {} : { page: options.page }),
      ...(options.boxes === undefined ? {} : { boxes: options.boxes }),
      ...(citation.quote === undefined ? {} : { quote: citation.quote }),
    })
    return
  }
  if (options.sheet !== undefined || options.cell !== undefined) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (scrollSheetCell(options.sheet, options.cell)) return
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return
  }
  if (options.line !== undefined && isTextPath(citation.path)) scrollTextLine(options.line)
}
