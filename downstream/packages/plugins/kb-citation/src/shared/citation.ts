/**
 * Parse and validate one knowledge-base source token.
 *
 * Assistant prose may carry either a canonical `kb://doc/<docId>/chunk/<chunkId>` token or an
 * inline-code workspace path with a line (`/workspace/kb/global/a.md:12`). Both forms are
 * untrusted: the path is normalised and must stay inside the KB mount before anything calls the
 * file opener.
 */

/** Normalised PDF rectangle in page coordinates, `[x1, y1, x2, y2]`. */
export type CitationBox = readonly [number, number, number, number]

/** One paragraph of a chunk, with optional source page/ordinal. */
export interface CitationParagraph {
  readonly text: string
  readonly ordinal?: number
  readonly page?: number
}

/** What a citation token resolved to. */
export interface Citation {
  readonly raw: string
  readonly kind: 'kb' | 'path'
  readonly docId?: string
  readonly chunkId?: string
  readonly chunkOrdinal?: number
  readonly path?: string
  /** 1-based text line. */
  readonly line?: number
  /** 1-based PDF page. */
  readonly page?: number
  /** PDF highlight rectangles. */
  readonly boxes?: readonly CitationBox[]
  readonly sheet?: string
  readonly cell?: string
  /** Chunk-first PDF ranges: all boxes per page, in reading order. */
  readonly chunkGroups?: readonly CitationBoxGroup[]
  readonly heading?: string
  readonly quote?: string
  /**
   * Search terms that actually matched this chunk, as emitted on the citation token by
   * `kb_search`. They are the authoritative amber layer: re-segmenting the user's question
   * turns ordinary words such as 董事/通过 into hits on unrelated articles.
   */
  readonly matchedTerms?: readonly string[]
  /** Short plain-text window around the first match, with `highlightRanges` indexing it. */
  readonly highlightText?: string
  readonly highlightRanges?: readonly { readonly start: number; readonly end: number }[]
  readonly paragraphText?: string
  readonly chunkText?: string
  readonly paragraphs?: readonly CitationParagraph[]
  /** Chip face; footnote numbering itself stays ordinary prose. */
  readonly label: string
  /** Hover text: document, section, and quote. */
  readonly title: string
}

/** All boxes belonging to one PDF page of a chunk. */
export interface CitationBoxGroup {
  readonly page: number
  readonly boxes: readonly CitationBox[]
}

/** One union rectangle covering every box of a page. */
export function unionOfBoxes(boxes: readonly CitationBox[]): CitationBox | undefined {
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const [x1, y1, x2, y2] of boxes) {
    if (![x1, y1, x2, y2].every(value => Number.isFinite(value))) continue
    left = Math.min(left, x1, x2)
    top = Math.min(top, y1, y2)
    right = Math.max(right, x1, x2)
    bottom = Math.max(bottom, y1, y2)
  }
  return right > left && bottom > top ? [left, top, right, bottom] : undefined
}

/**
 * Collapse page groups to exactly one union rectangle per page.
 *
 * `kb_chunk_boxes` stores one row per extracted block and older KB builds return all of them.
 * Painting is a page-level contract: the viewer must never draw a paragraph stack and merge it
 * a frame later, so every path that reaches the painter normalizes here first. Duplicate page
 * entries are merged, not painted twice.
 */
export function oneUnionPerPage(groups: readonly CitationBoxGroup[]): CitationBoxGroup[] {
  const byPage = new Map<number, CitationBox[]>()
  for (const group of groups) {
    if (!Number.isInteger(group.page) || group.page <= 0) continue
    byPage.set(group.page, [...(byPage.get(group.page) ?? []), ...group.boxes])
  }
  const out: CitationBoxGroup[] = []
  for (const [page, boxes] of [...byPage.entries()].sort((left, right) => left[0] - right[0])) {
    const union = unionOfBoxes(boxes)
    if (union !== undefined) out.push({ page, boxes: [union] })
  }
  return out
}

/** Options handed to the host file opener. */
export interface CitationOpenOptions {
  readonly line?: number
  readonly page?: number
  readonly boxes?: readonly CitationBox[]
  readonly chunkId?: string
  /** The document-local chunk ordinal used in inline labels (1-based). */
  readonly chunkOrdinal?: number
  readonly chunkGroups?: readonly CitationBoxGroup[]
  readonly sheet?: string
  readonly cell?: string
  readonly paragraphText?: string
  readonly chunkText?: string
  readonly paragraphs?: readonly CitationParagraph[]
}

/** Default mount point of the current user's KB view. */
export const DEFAULT_KB_MOUNT = '/workspace/kb'

// Doc ids and chunk keys are URL-safe tokens. Keeping the character class tight is what
// makes a bare token followed by Chinese punctuation parse as the token, not as part of
// the chunk key.
const KB_TOKEN = /^kb:\/\/doc\/([A-Za-z0-9._~-]+)(?:\/chunk\/([A-Za-z0-9._~-]+))?(?:\?(.*))?$/i
/** The same token without anchors, for scanning prose. Stops before CJK punctuation/quotes. */
const KB_TOKEN_SCAN = /kb:\/\/doc\/[A-Za-z0-9._~-]+\/chunk\/[A-Za-z0-9._~-]+(?:\?[^\s)`"'<>，。；：、！？]*)?/gi
const PATH_LINE = /^(.+?):(\d+)$/
const PATH_FRAGMENT_LINE = /^(.+?)#L(\d+)(?:-L(\d+))?$/i

/** Whether a value is a positive integer. */
function positive(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

/** Decode one query value without letting malformed escapes throw. */
function decode(value: string): string {
  try { return decodeURIComponent(value.replace(/\+/g, ' ')) } catch { return value }
}

/**
 * Resolve every KB citation path to the mounted view root.
 *
 * The backend may emit `department/...`, `/workspace/department/...`, an absolute view path
 * `/nas/kb/views/<id>/department/...`, or an already-correct `/workspace/kb/...`. All of them
 * mean the same file inside the current user's KB view; a caller that passes the raw backend
 * path to the file opener produces ENOENT. This function folds those spellings into the one
 * mount the Host serves, and rejects paths that still point outside it after folding.
 *
 * @param raw - path from a citation token or backend hit.
 * @param mount - KB view root.
 * @returns the normalized path under the mount, or undefined when it escapes.
 */
export function resolveKbPath(raw: string, mount: string = DEFAULT_KB_MOUNT): string | undefined {
  const decoded = decode(raw).replace(/\\/g, '/').trim()
  if (decoded === '') return undefined
  const root = mount.replace(/\/+$/, '')
  let relative = decoded
  // Absolute paths under the view root are already canonical.
  if (relative === root || relative.startsWith(root + '/')) {
    relative = relative.slice(root.length).replace(/^\/+/, '')
  } else if (relative.startsWith('/nas/kb/views/')) {
    // Index hits carry the physical NAS view path; the Host opens the mounted view.
    relative = relative.replace(/^\/nas\/kb\/views\/[^/]+\/?/, '')
  } else if (relative.startsWith('/workspace/kb-')) {
    // A sibling path such as `/workspace/kb-other` is not inside this view.
    return undefined
  } else if (/^\/workspace\/(?:global|department|personal|rag-eval-fixtures)\//.test(relative)) {
    // Legacy backend-relative citations spell the KB prefix under /workspace.
    relative = relative.slice('/workspace/'.length)
  } else if (relative.startsWith('/workspace/')) {
    // An ordinary workspace file is not a KB citation: `/workspace/report.zip`
    // must keep its absolute path instead of becoming `/workspace/kb/report.zip`.
    return undefined
  } else if (relative.startsWith('/kb/')) {
    relative = relative.slice('/kb/'.length)
  } else if (relative.startsWith('kb/')) {
    relative = relative.slice('kb/'.length)
  } else if (/^(?:global|department|personal|rag-eval-fixtures)\//.test(relative)) {
    // Explicit backend-relative KB prefixes stay supported.
  } else if (relative.startsWith('/')) {
    // A foreign absolute path must not be silently folded into the KB view.
    return undefined
  } else {
    // A bare name or arbitrary relative path is not a KB citation. Folding it into
    // /workspace/kb silently turns ordinary Markdown file links into wrong KB paths.
    return undefined
  }
  const parts: string[] = []
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
      continue
    }
    parts.push(part)
  }
  const normalised = root + '/' + parts.join('/')
  return normalised === root || normalised.startsWith(root + '/') ? normalised : undefined
}

/** Backwards-compatible name for the canonical resolver. */
export function safeKbPath(raw: string, mount: string = DEFAULT_KB_MOUNT): string | undefined {
  return resolveKbPath(raw, mount)
}

/** Split `a=1&b=2` into a decoded record. */
function queryOf(input: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (input === undefined) return result
  for (const pair of input.split('&')) {
    if (pair === '') continue
    const index = pair.indexOf('=')
    const key = decode(index === -1 ? pair : pair.slice(0, index))
    const value = index === -1 ? '' : decode(pair.slice(index + 1))
    if (key !== '') result[key] = value
  }
  return result
}

/** Parse the `ranges=[[start,end],...]` hint emitted by `kb_search`; malformed ranges are dropped. */
function parseHighlightRanges(raw: string | undefined): Array<{ start: number; end: number }> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return undefined
    const ranges = value.flatMap((entry: unknown) => {
      if (!Array.isArray(entry) || entry.length !== 2) return []
      const start = Number(entry[0])
      const end = Number(entry[1])
      return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start ? [{ start, end }] : []
    })
    return ranges.length === 0 ? undefined : ranges
  } catch {
    return undefined
  }
}

/**
 * Parse one rectangle list: `x1,y1,x2,y2` or `x1,y1,x2,y2;x3,y3,x4,y4`, or JSON.
 * Coordinates in 0..1 stay normalized; 0..1000 values from MinerU are divided by 1000.
 */
export function parseBoxes(raw: string | undefined): CitationBox[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  let values: unknown = raw
  if (raw.trim().startsWith('[') || raw.trim().startsWith('{')) {
    try { values = JSON.parse(raw) as unknown } catch { return undefined }
  }
  // MinerU provenance stores `bbox` as a JSON object: {"bbox":[x1,y1,x2,y2],...}.
  if (typeof values === 'object' && values !== null && !Array.isArray(values)) {
    const record = values as Record<string, unknown>
    if (record.bbox !== undefined) values = record.bbox
  }
  if (Array.isArray(values) && values.some(value => typeof value === 'object' && value !== null)) {
    values = (values as unknown[]).map(value => {
      const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
      return record.bbox ?? record.box ?? value
    })
  }
  const groups: unknown[][] = Array.isArray(values) && values.every(value => typeof value === 'number')
    ? [values]
    : Array.isArray(values) && values.every(value => Array.isArray(value))
      ? values as unknown[][]
      : String(values).split(';').map(group => group.split(',').map(value => Number(value)))
  const boxes: CitationBox[] = []
  for (const group of groups) {
    if (group.length !== 4 || group.some(value => typeof value !== 'number' || !Number.isFinite(value))) continue
    const numbers = group.map(value => Number(value))
    const scale = numbers.some(value => Math.abs(value) > 1) ? 1000 : 1
    const [x1, y1, x2, y2] = numbers.map(value => Math.min(1, Math.max(0, value / scale))) as [number, number, number, number]
    boxes.push([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)])
  }
  return boxes.length === 0 ? undefined : boxes
}

/**
 * Parse chunk-first groups: JSON `[{page, boxes:[...]}]`, a JSON map `{ "1": [...] }`, or
 * `1:x1,y1,x2,y2;2:x1,y1,x2,y2`. Page numbers are 1-based.
 */
export function parseChunkGroups(raw: string | undefined): CitationBoxGroup[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  let value: unknown = raw
  try { value = JSON.parse(raw) as unknown } catch { value = raw }
  const groups: CitationBoxGroup[] = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      const page = Number(record.page)
      const boxes = parseBoxes(JSON.stringify(record.boxes ?? record.bbox ?? []))
      if (Number.isInteger(page) && page > 0 && boxes !== undefined) groups.push({ page, boxes })
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, boxes] of Object.entries(value as Record<string, unknown>)) {
      const page = Number(key)
      const parsed = parseBoxes(JSON.stringify(boxes))
      if (Number.isInteger(page) && page > 0 && parsed !== undefined) groups.push({ page, boxes: parsed })
    }
  } else {
    for (const part of String(value).split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      const page = Number(part.slice(0, colon))
      const boxes = parseBoxes(part.slice(colon + 1))
      if (Number.isInteger(page) && page > 0 && boxes !== undefined) groups.push({ page, boxes })
    }
  }
  groups.sort((left, right) => left.page - right.page)
  return groups.length === 0 ? undefined : groups
}

/** Office previews open the original file, never the extraction sibling `.docx.md`. */
export function originalOfficePath(path: string): string {
  return /\.(docx|doc|xlsx|xls|pptx|ppt|pdf)\.md$/i.test(path) ? path.slice(0, -3) : path
}

/** Whether this path is a text document whose line hint should survive resolution. */
export function isTextDocumentPath(path: string): boolean {
  return /\.(md|markdown|txt|json|ya?ml|csv|log|ts|tsx|js|jsx|py|css|html)$/i.test(path)
}

/** Normalize a parsed markdown-link citation: Office/PDF use the source file and lose `:line`. */
function normalizeParsedCitation(citation: Citation): Citation {
  if (citation.path === undefined) return citation
  const source = originalOfficePath(citation.path)
  const label = source.split('/').filter(Boolean).pop() ?? citation.label
  if (isTextDocumentPath(source)) {
    return citation.path === source ? citation : { ...citation, path: source, label }
  }
  const { line: _line, ...rest } = citation
  return { ...rest, path: source, label, title: source }
}

/** The chip label for one path. */
function labelFor(path: string, query: Record<string, string>): string {
  if (query.label !== undefined && query.label.trim() !== '') return query.label.trim()
  const file = path.split('/').pop() ?? path
  return file
}

/**
 * Parse one candidate token. Non-citation text and paths outside the KB mount return undefined.
 *
 * @param token - inline-code value exactly as authored.
 * @param mount - KB view root.
 * @returns the citation, or undefined when the token is not a usable KB source.
 */
export function parseCitationToken(token: string, mount: string = DEFAULT_KB_MOUNT): Citation | undefined {
  let raw = token.trim().replace(/^`|`$/g, '').replace(/^<|>$/g, '')
  if (raw === '') return undefined
  // Prose often puts a full stop right after an inline token. It is punctuation, not
  // part of the chunk key, and must not turn a valid citation into a 404.
  if (/^kb:\/\//i.test(raw)) raw = raw.replace(/[，。；：、！？]+$/u, '')
  if (raw === '') return undefined

  const kb = KB_TOKEN.exec(raw)
  if (kb !== null) {
    const query = queryOf(kb[3])
    const path = query.path === undefined ? undefined : resolveKbPath(query.path, mount)
    if (query.path !== undefined && path === undefined) return undefined
    const line = positive(query.line)
    const chunkOrdinal = positive(query.chunkOrdinal ?? query.ordinal)
    const docId = decode(kb[1])
    const chunkId = kb[2] === undefined ? (query.chunkId === undefined ? undefined : query.chunkId) : decode(kb[2])
    const chunkGroups = parseChunkGroups(query.groups ?? query.chunkGroups ?? query.boxesByPage)
      ?? (() => {
        const singlePage = positive(query.page)
        const singleBoxes = parseBoxes(query.boxes ?? query.bbox)
        return singlePage === undefined || singleBoxes === undefined ? undefined : [{ page: singlePage, boxes: singleBoxes }]
      })()
    const page = positive(query.page) ?? chunkGroups?.[0]?.page
    const boxes = parseBoxes(query.boxes ?? query.bbox) ?? chunkGroups?.[0]?.boxes
    const matchedTerms = (query.terms ?? '').split(',').map(term => term.trim()).filter(term => term !== '')
    const highlightRanges = parseHighlightRanges(query.ranges)
    const titleParts = [query.doc, query.heading, query.quote].filter((part): part is string => part !== undefined && part !== '')
    return {
      raw, kind: 'kb', docId, ...(chunkId === undefined ? {} : { chunkId }),
      ...(chunkOrdinal === undefined ? {} : { chunkOrdinal }),
      ...(path === undefined ? {} : { path }), ...(line === undefined ? {} : { line }),
      ...(page === undefined ? {} : { page }), ...(boxes === undefined ? {} : { boxes }),
      ...(chunkGroups === undefined ? {} : { chunkGroups }),
      ...(query.sheet === undefined ? {} : { sheet: query.sheet }),
      ...(query.cell === undefined ? {} : { cell: query.cell }),
      ...(query.heading === undefined ? {} : { heading: query.heading }),
      ...(query.quote === undefined ? {} : { quote: query.quote }),
      ...(matchedTerms.length === 0 ? {} : { matchedTerms }),
      ...(query.highlight === undefined || query.highlight.trim() === '' ? {} : { highlightText: query.highlight }),
      ...(highlightRanges === undefined ? {} : { highlightRanges }),
      label: path === undefined ? 'KB 来源' : labelFor(path, query),
      title: titleParts.length === 0 ? (path ?? 'kb://doc/' + docId + (chunkId === undefined ? '' : '/chunk/' + chunkId)) : titleParts.join(' · '),
    }
  }

  const fragment = PATH_FRAGMENT_LINE.exec(raw)
  if (fragment !== null) {
    const path = resolveKbPath(fragment[1], mount)
    const line = positive(fragment[2])
    if (path !== undefined && line !== undefined) {
      return {
        raw, kind: 'path', path, line,
        label: labelFor(path, {}), title: path + ':' + String(line),
      }
    }
  }

  const match = PATH_LINE.exec(raw)
  if (match !== null) {
    // A URL's `https:` prefix must never look like a line citation.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return undefined
    const path = resolveKbPath(match[1], mount)
    const line = positive(match[2])
    if (path !== undefined && line !== undefined) {
      return {
        raw, kind: 'path', path, line,
        label: labelFor(path, {}), title: path + ':' + String(line),
      }
    }
  }

  // Inline links often carry only an absolute/workspace path (no `:line`). Resolve it through
  // the same KB mount; reject URLs, query/fragment suffixes, and line-shaped tokens.
  if ((raw.startsWith('/') || /^(global|department|personal|rag-eval-fixtures)\//.test(raw)) && !/[?#:]/.test(raw)) {
    const barePath = resolveKbPath(raw, mount)
    if (barePath !== undefined) {
      return { raw, kind: 'path', path: barePath, label: labelFor(barePath, {}), title: barePath }
    }
  }
  return undefined
}

/** Extract every citation token from a prose string, in document order. */
export function parseCitations(text: string, mount: string = DEFAULT_KB_MOUNT): Citation[] {
  const tokens: string[] = []
  // Markdown links are the common shape in final answers: [label](global/...docx.md:193).
  const links = /\[[^\]]*\]\(([^)\s]+(?:\s+['"][^'"]*['"])?)\)/g
  for (let match = links.exec(text); match !== null; match = links.exec(text)) {
    const target = (match[1] ?? '').replace(/\s+['"][^'"]*['"]$/, '').trim()
    if (parseCitationToken(target, mount) !== undefined) tokens.push(target)
  }
  const code = /`([^`\n]+)`/g
  for (let match = code.exec(text); match !== null; match = code.exec(text)) {
    if (parseCitationToken(match[1], mount) !== undefined) tokens.push(match[1])
  }
  if (tokens.length === 0) {
    for (let match = KB_TOKEN_SCAN.exec(text); match !== null; match = KB_TOKEN_SCAN.exec(text)) tokens.push(match[0])
    KB_TOKEN_SCAN.lastIndex = 0
  }
  const parsed = tokens.map(token => parseCitationToken(token, mount)).filter((value): value is Citation => value !== undefined).map(normalizeParsedCitation)
  const seen = new Set<string>()
  return parsed.filter(citation => {
    // One chunk is one source even when two hits carry different query hints (`terms`,
    // `highlight`). Dedup on the stable identity, not on the raw token spelling.
    const key = [
      citation.docId ?? '', citation.chunkId ?? '', citation.path ?? citation.raw,
      String(citation.line ?? ''), String(citation.page ?? ''),
      String(citation.sheet ?? ''), String(citation.cell ?? ''),
    ].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Options to hand the opener, in a stable shape. */
export function openOptionsOf(citation: Citation): CitationOpenOptions {
  return {
    ...(citation.line === undefined ? {} : { line: citation.line }),
    ...(citation.page === undefined ? {} : { page: citation.page }),
    ...(citation.boxes === undefined ? {} : { boxes: citation.boxes }),
    ...(citation.chunkId === undefined ? {} : { chunkId: citation.chunkId }),
    ...(citation.chunkOrdinal === undefined ? {} : { chunkOrdinal: citation.chunkOrdinal }),
    ...(citation.chunkGroups === undefined ? {} : { chunkGroups: citation.chunkGroups }),
    ...(citation.sheet === undefined ? {} : { sheet: citation.sheet }),
    ...(citation.cell === undefined ? {} : { cell: citation.cell }),
    ...(citation.paragraphText === undefined ? {} : { paragraphText: citation.paragraphText }),
    ...(citation.chunkText === undefined ? {} : { chunkText: citation.chunkText }),
    ...(citation.paragraphs === undefined ? {} : { paragraphs: citation.paragraphs }),
  }
}

/**
 * Open one citation through the host opener. The opener is injected so the parser stays testable;
 * callers must not pass arbitrary `file://` paths.
 */
export function openCitation(
  citation: Citation,
  openFile: (path: string, options: CitationOpenOptions) => void,
): boolean {
  if (citation.path === undefined) return false
  openFile(citation.path, openOptionsOf(citation))
  return true
}

/** One resolved opener target: canonical path when known, chunk identity otherwise. */
export interface CitationTarget {
  readonly path?: string
  readonly docId?: string
  readonly chunkId?: string
  readonly options: CitationOpenOptions
}

/**
 * Resolve a citation target. A bare `kb://doc/<id>/chunk/<id>` has no path yet; the caller
 * resolves it through the KB chunk endpoint before opening, rather than dropping the click.
 */
export function citationTargetOf(citation: Citation): CitationTarget | undefined {
  if (citation.path !== undefined) {
    const resolved = resolveKbPath(citation.path)
    if (resolved === undefined) return undefined
    return { path: originalOfficePath(resolved), options: openOptionsOf(citation) }
  }
  if (citation.docId !== undefined && citation.chunkId !== undefined) {
    return { docId: citation.docId, chunkId: citation.chunkId, options: openOptionsOf(citation) }
  }
  return undefined
}
