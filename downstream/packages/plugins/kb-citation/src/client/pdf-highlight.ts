/**
 * DOM-side PDF citation enhancement.
 *
 * The host already owns the PDF renderer. This module never reads a `file://` URL and never
 * changes the allowlist: it finds the rendered page element, scrolls it into view, and paints
 * citation rectangles (normalized 0..1) into an absolutely positioned overlay. Text-only
 * citations search the rendered text layer; more than one hit opens a picker, so the reader
 * chooses instead of the code silently taking the first occurrence.
 */

import { oneUnionPerPage, unionOfBoxes, type CitationBox, type CitationBoxGroup } from '../shared/citation.ts'
import { markCitationTiming, recordCitationDebug } from './timing.ts'

/** One text-layer occurrence. */
export interface PdfTextMatch {
  readonly page: number
  readonly element: HTMLElement
  readonly text: string
  readonly context: string
  readonly occurrence: number
  /** The term this span was matched for, used to paint only the characters that matched. */
  readonly term?: string
}

/** Result of applying one citation to the viewer. */
export interface PdfHighlightResult {
  readonly status: 'boxes' | 'text' | 'ambiguous' | 'missing' | 'invalid'
  readonly page?: number
  readonly pageCount?: number
  readonly groups?: number
  readonly matches?: number
}

const PAGE_SELECTOR = '[data-pdf-page]'
const BOX_CLASS = 'kb-citation-box'
const FLASH_CLASS = 'kb-citation-flash'
const STYLE_ID = 'kb-citation-highlight-style'

/** Install the small style sheet once. */
function ensureStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .${BOX_CLASS}{position:absolute;box-sizing:border-box;border:1.5px solid rgba(37,99,235,.95);
      background:rgba(59,130,246,.24);border-radius:2px;pointer-events:none;z-index:5;
      animation:kb-citation-fade 1.4s ease-out}
    .${FLASH_CLASS}{outline:2px solid rgba(37,99,235,.95);outline-offset:2px;background:rgba(59,130,246,.22)!important}
    @keyframes kb-citation-fade{0%{background:rgba(59,130,246,.5)}100%{background:rgba(59,130,246,.24)}}
    .kb-citation-hit{position:absolute;box-sizing:border-box;border:2px solid rgba(245,158,11,.95);background:rgba(251,191,36,.28);border-radius:2px;pointer-events:none;z-index:6}
    .kb-citation-picker{position:fixed;z-index:2147483000;width:320px;max-height:46vh;overflow:auto;
      padding:10px;border:1px solid var(--dsw-alias-border-l2,#d0d5dd);border-radius:8px;
      background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 10px 30px rgba(0,0,0,.24);
      color:var(--dsw-alias-label-primary,#111);font:12px/1.5 system-ui,sans-serif}
    .kb-citation-picker h4{margin:0 0 6px;font-size:12px}
    .kb-citation-picker button{display:block;width:100%;margin:4px 0;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);
      border-radius:5px;background:transparent;color:inherit;text-align:left;cursor:pointer}
    .kb-citation-picker button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
    .kb-citation-picker small{display:block;color:var(--dsw-alias-label-tertiary,#667085)}
  `
  document.head.appendChild(style)
}

/** The canvas/content area and the element that owns the positioned overlay. */
interface PdfContentBox {
  readonly parent: HTMLElement
  readonly contentRect: DOMRect
  readonly parentRect: DOMRect
}

function pdfContentBox(pageElement: HTMLElement): PdfContentBox {
  const candidate = pageElement.querySelector<HTMLElement>('canvas, [data-pdf-content]')
  const pageRect = pageElement.getBoundingClientRect()
  const candidateRect = candidate?.getBoundingClientRect()
  // Office→PDF previews can leave a zero-sized/placeholder canvas while their text layer is
  // still lazy-loading. Fall back to the page's own content box instead of painting 0px boxes.
  const usable = candidate !== null && candidateRect !== undefined && candidateRect.width > 0 && candidateRect.height > 0
  const content = usable ? candidate : pageElement
  const candidateParent = usable ? candidate.parentElement ?? pageElement : pageElement
  const parent = pageElement.contains(candidateParent) ? candidateParent : pageElement
  const style = getComputedStyle(parent)
  if (style.position !== 'relative' && style.position !== 'absolute' && style.position !== 'fixed') parent.style.position = 'relative'
  return { parent, contentRect: usable ? candidateRect : pageRect, parentRect: parent.getBoundingClientRect() }
}

/** Intersection ratio of two rendered rectangles; used by geometry tests and overlays. */
export function rectIntersectionRatio(left: DOMRect, right: DOMRect): number {
  const width = Math.min(left.right, right.right) - Math.max(left.left, right.left)
  const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top)
  if (width <= 0 || height <= 0) return 0
  const area = width * height
  const base = Math.min(left.width * left.height, right.width * right.height)
  return base <= 0 ? 0 : Math.min(1, area / base)
}

/** Find one rendered page by its 1-based number. */
export function findPdfPage(page: number, root: ParentNode = document): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>(PAGE_SELECTOR)].find(element => Number(element.dataset.pdfPage) === page)
}

/** Every page shell the viewer has mounted, in reading order. */
export function renderedPdfPageNumbers(root: ParentNode = document): number[] {
  return [...root.querySelectorAll<HTMLElement>(PAGE_SELECTOR)]
    .map(element => Number(element.dataset.pdfPage))
    .filter(page => Number.isInteger(page) && page > 0)
}

/** Wait until the PDF surface has mounted at least one page shell. */
async function waitForPdfPageNumbers(timeoutMs = 6000): Promise<number[]> {
  const started = Date.now()
  for (;;) {
    const pages = renderedPdfPageNumbers()
    if (pages.length > 0 || Date.now() - started > timeoutMs) return pages
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Normalized text of one rendered page, reused across paragraph candidates. */
interface PageText {
  readonly spans: readonly HTMLElement[]
  readonly parts: readonly string[]
  readonly combined: string
}

/** Page text and confirmed chunk pages survive a tab remount for one document. */
interface DocPageCache {
  readonly pageByChunk: Map<string, number>
  readonly textByPage: Map<number, { spanCount: number; parts: readonly string[]; combined: string }>
}

const DOC_CACHE_LIMIT = 8
const pageTextCache = new WeakMap<HTMLElement, { spanCount: number; text: PageText }>()
const docPageCaches = new Map<string, DocPageCache>()
/** Every new citation bumps this; background repaints from an older click must stand down. */
let activeCitation = 0

function docCacheFor(docKey: string | undefined): DocPageCache | undefined {
  if (docKey === undefined || docKey === '') return undefined
  let cache = docPageCaches.get(docKey)
  if (cache === undefined) {
    cache = { pageByChunk: new Map(), textByPage: new Map() }
    docPageCaches.set(docKey, cache)
    while (docPageCaches.size > DOC_CACHE_LIMIT) {
      const oldest = docPageCaches.keys().next().value
      if (oldest === undefined) break
      docPageCaches.delete(oldest)
    }
  }
  return cache
}

/** Drop cached page text for one document, or every document when no key is given. */
export function clearCitationPageCache(docKey?: string): void {
  if (docKey === undefined) docPageCaches.clear()
  else docPageCaches.delete(docKey)
}

/** The page a previous click confirmed for a chunk, if any. */
export function cachedChunkPage(docKey: string | undefined, chunkKey: string | undefined): number | undefined {
  if (docKey === undefined || chunkKey === undefined) return undefined
  return docPageCaches.get(docKey)?.pageByChunk.get(chunkKey)
}

function rememberChunkPage(docKey: string | undefined, chunkKey: string | undefined, page: number): void {
  if (docKey === undefined || chunkKey === undefined) return
  docCacheFor(docKey)?.pageByChunk.set(chunkKey, page)
}

/**
 * Read a page's text once.
 *
 * Matching a long chunk used to normalize every span again for the whole paragraph, every
 * sentence fragment and every 16-character window. A 19-page chunk could spend hundreds of
 * milliseconds re-normalizing the same page. The cache is keyed by the page element and
 * invalidated by its span count, so a lazy text layer that grows still re-reads.
 */
function pageTextOf(page: HTMLElement, docKey?: string): PageText {
  const spans = [...page.querySelectorAll<HTMLElement>('span')]
    .filter(span => normalizeChunkText(span.textContent ?? '') !== '')
  const cached = pageTextCache.get(page)
  if (cached !== undefined && cached.spanCount === spans.length) return cached.text
  const pageNumber = Number(page.dataset.pdfPage)
  const docCached = docCacheFor(docKey)?.textByPage.get(pageNumber)
  const text: PageText = docCached !== undefined
    && docCached.spanCount === spans.length
    && docCached.parts.length === spans.length
    ? { spans, parts: docCached.parts, combined: docCached.combined }
    : { spans, parts: spans.map(span => normalizeChunkText(span.textContent ?? '')), combined: '' }
  const complete: PageText = text.combined === '' && text.parts.length > 0
    ? { ...text, combined: text.parts.join('') }
    : text
  pageTextCache.set(page, { spanCount: spans.length, text: complete })
  if (spans.length > 0) {
    docCacheFor(docKey)?.textByPage.set(pageNumber, {
      spanCount: spans.length,
      parts: complete.parts,
      combined: complete.combined,
    })
  }
  return complete
}

/** The read-only PDF.js face the document preview exposes through its page component. */
interface PdfTextItemLike {
  readonly str: string
  readonly transform: readonly number[]
  readonly width: number
  readonly height: number
}

interface PdfPageProxyLike {
  getViewport(options: { scale: number }): { width: number; height: number; scale: number; transform: readonly number[] }
  getTextContent(): Promise<{ items: readonly PdfTextItemLike[] }>
}

interface PdfDocumentProxyLike {
  getPage(page: number): Promise<PdfPageProxyLike>
}

/**
 * Read the PDF document the document-preview page component already owns.
 *
 * The viewer renders a page's canvas and text layer lazily, so on a cold document a late page's
 * spans can take seconds to appear. The PDF document proxy is reachable from the page element's
 * React fiber, and `getTextContent()` is a read-only worker call. This is an optional fast path:
 * a different React build, a different viewer, or a missing fiber simply returns undefined and the
 * documented DOM text-layer path takes over. Nothing on the fiber is written.
 */
function pdfDocumentOf(page: HTMLElement): PdfDocumentProxyLike | undefined {
  try {
    const key = Object.keys(page).find(name => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'))
    if (key === undefined) return undefined
    type FiberLike = { readonly memoizedProps?: { readonly document?: unknown }; readonly return?: FiberLike }
    let fiber = (page as unknown as Record<string, FiberLike | undefined>)[key]
    for (let depth = 0; depth < 12 && fiber !== undefined; depth += 1) {
      const document = fiber.memoizedProps?.document
      if (document !== null && typeof document === 'object'
        && typeof (document as { getPage?: unknown }).getPage === 'function') {
        return document as PdfDocumentProxyLike
      }
      fiber = fiber.return
    }
  } catch { /* a host without React fibers keeps the DOM path */ }
  return undefined
}

/** Resolve with a deadline so a stalled worker cannot hold the citation click hostage. */
function withDeadline<T>(task: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(undefined)
    }, timeoutMs)
    task.then(value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }, () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

/** PDF.js matrix multiplication, copied from its public `Util.transform` shape. */
function multiplyTransform(left: readonly number[], right: readonly number[]): [number, number, number, number, number, number] {
  return [
    left[0]! * right[0]! + left[2]! * right[1]!,
    left[1]! * right[0]! + left[3]! * right[1]!,
    left[0]! * right[2]! + left[2]! * right[3]!,
    left[1]! * right[2]! + left[3]! * right[3]!,
    left[0]! * right[4]! + left[2]! * right[5]! + left[4]!,
    left[1]! * right[4]! + left[3]! * right[5]! + left[5]!,
  ]
}

/** One text item's normalized rectangle, top-left origin. */
function textItemBox(item: PdfTextItemLike, viewport: { width: number; height: number; scale: number; transform: readonly number[] }): CitationBox | undefined {
  if (viewport.width <= 0 || viewport.height <= 0) return undefined
  const tx = multiplyTransform(viewport.transform, item.transform)
  const width = item.width * viewport.scale
  const height = item.height * viewport.scale
  if (!Number.isFinite(tx[4]) || !Number.isFinite(tx[5]) || width <= 0 || height <= 0) return undefined
  const left = tx[4]! / viewport.width
  const top = (tx[5]! - height) / viewport.height
  const right = (tx[4]! + width) / viewport.width
  const bottom = tx[5]! / viewport.height
  const clamp = (value: number): number => Math.max(0, Math.min(1, value))
  return [clamp(left), clamp(top), clamp(right), clamp(bottom)]
}

/**
 * Locate the chunk in a page's PDF text items and return one normalized union box.
 *
 * Candidates are tried exactly like the DOM matcher: the whole paragraph first, then sentence
 * pieces. The union of the matching items is the paragraph's range, so a multi-line paragraph
 * stays one box instead of one box per line.
 */
function boxesFromTextItems(items: readonly PdfTextItemLike[], viewport: { width: number; height: number; scale: number; transform: readonly number[] }, candidates: readonly string[]): CitationBox[] {
  const usable = items.filter(item => typeof item.str === 'string' && normalizeChunkText(item.str) !== '')
  if (usable.length === 0) return []
  const parts = usable.map(item => normalizeChunkText(item.str))
  const combined = parts.join('')
  const rangeFor = (needle: string): { first: number; last: number } | undefined => {
    const start = combined.indexOf(needle)
    if (start === -1) return undefined
    let cursor = 0
    let first = -1
    let last = -1
    for (let index = 0; index < parts.length; index += 1) {
      const next = cursor + parts[index]!.length
      if (first === -1 && start >= cursor && start < next) first = index
      if (start + needle.length > cursor && start + needle.length <= next) { last = index; break }
      cursor = next
    }
    return first === -1 ? undefined : { first, last: last === -1 ? parts.length - 1 : last }
  }
  const unionOf = (range: { first: number; last: number }): CitationBox | undefined => {
    const boxes = usable.slice(range.first, range.last + 1)
      .map(item => textItemBox(item, viewport))
      .filter((box): box is CitationBox => box !== undefined)
    if (boxes.length === 0) return undefined
    const left = Math.min(...boxes.map(box => box[0]))
    const top = Math.min(...boxes.map(box => box[1]))
    const right = Math.max(...boxes.map(box => box[2]))
    const bottom = Math.max(...boxes.map(box => box[3]))
    return right > left && bottom > top ? [left, top, right, bottom] : undefined
  }
  const unionBoxes = (boxes: readonly CitationBox[]): CitationBox => {
    const left = Math.min(...boxes.map(box => box[0]))
    const top = Math.min(...boxes.map(box => box[1]))
    const right = Math.max(...boxes.map(box => box[2]))
    const bottom = Math.max(...boxes.map(box => box[3]))
    return [left, top, right, bottom]
  }
  for (const candidate of candidates) {
    const needle = normalizeChunkText(candidate)
    if (needle.length < 2) continue
    const direct = rangeFor(needle)
    if (direct !== undefined) {
      const box = unionOf(direct)
      if (box !== undefined) return [box]
    }
    // A paragraph often crosses a page break, so the candidate itself is absent from this page
    // even though several of its sentences are present. Union every matching sentence; returning
    // the first one would paint a one-line box instead of the chunk's range.
    const pieceBoxes: CitationBox[] = []
    for (const piece of candidate.split(/[。！？；\n]/).map(value => value.trim()).filter(value => value.length >= 4)) {
      const range = rangeFor(normalizeChunkText(piece))
      if (range === undefined) continue
      const box = unionOf(range)
      if (box !== undefined) pieceBoxes.push(box)
    }
    if (pieceBoxes.length > 0) return [unionBoxes(pieceBoxes)]
  }
  return []
}

/**
 * Fast-path the target page's box from PDF text while the viewer renders its canvas.
 *
 * The page shell exists before its text layer; `getTextContent()` arrives in roughly half a
 * second, while the canvas render can take seconds on a software rasterizer. The returned box is
 * normalized to the PDF page, so it scales with the page as the viewer replaces its placeholder.
 */
async function fastPdfTextBoxes(pageNumber: number, candidates: readonly string[]): Promise<CitationBox[] | undefined> {
  const pageElement = findPdfPage(pageNumber)
  if (pageElement === undefined || pageElement.querySelectorAll('span').length > 0) return undefined
  const document = pdfDocumentOf(pageElement)
  if (document === undefined) return undefined
  const proxy = await withDeadline(document.getPage(pageNumber), 900)
  if (proxy === undefined) return undefined
  const viewport = proxy.getViewport({ scale: 1 })
  const content = await withDeadline(proxy.getTextContent(), 900)
  if (content === undefined) return undefined
  const boxes = boxesFromTextItems(content.items, viewport, candidates)
  if (boxes.length === 0) return undefined
  markCitationTiming('pdf-text-boxes', `p${String(pageNumber)} items=${String(content.items.length)}`)
  return boxes
}


/** A page-normalized overlay that survives the viewer's React re-renders. */
export interface FloatingOverlay {
  /** Remove the boxes and stop tracking the page. */
  destroy(): void
  /** Re-read the page's viewport rect now (call after a programmatic scroll). */
  position(): void
}

/**
 * Paint provisional boxes in a fixed layer owned by the plugin.
 *
 * The viewer replaces the page surface's children when a lazy page finishes rendering, so a box
 * appended inside the page can disappear mid-render. A body-level fixed layer is outside React's
 * tree; the boxes are positioned from the page's current viewport rect and refreshed on scroll,
 * resize and layout settle. This is the only overlay that exists before the text layer; the
 * precise DOM text-layer boxes replace it as soon as the page renders.
 */
export function renderFloatingPageBoxes(pageElement: HTMLElement, boxes: readonly CitationBox[]): FloatingOverlay {
  ensureStyle()
  for (const old of document.querySelectorAll('[data-kb-citation-floating="true"]')) old.remove()
  const layerId = 'kb-citation-floating-layer'
  let layer = document.getElementById(layerId)
  if (layer === null) {
    layer = document.createElement('div')
    layer.id = layerId
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000'
    document.body.appendChild(layer)
  }
  const pageNumber = pageElement.dataset.pdfPage ?? ''
  // A provisional overlay is the first thing the reader sees; it must already be one box.
  const union = unionOfBoxes(boxes)
  const normalized = union === undefined ? [] : [union]
  const elements = normalized.map(([x1, y1, x2, y2]) => {
    const box = document.createElement('div')
    box.className = BOX_CLASS
    box.dataset.kbCitationBox = 'true'
    box.dataset.kbCitationPage = pageNumber
    box.dataset.kbCitationFloating = 'true'
    box.style.position = 'fixed'
    box.style.margin = '0'
    box.dataset.kbCitationX = [x1, y1, x2, y2].join(',')
    layer.appendChild(box)
    return box
  })
  const position = (): void => {
    if (!pageElement.isConnected) return
    const rect = pageElement.getBoundingClientRect()
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight
    for (const box of elements) {
      box.style.display = visible ? '' : 'none'
      if (!visible) continue
      const [x1, y1, x2, y2] = (box.dataset.kbCitationX ?? '0,0,0,0').split(',').map(Number) as [number, number, number, number]
      box.style.left = (rect.left + x1 * rect.width).toFixed(2) + 'px'
      box.style.top = (rect.top + y1 * rect.height).toFixed(2) + 'px'
      box.style.width = (Math.max(0.005, x2 - x1) * rect.width).toFixed(2) + 'px'
      box.style.height = (Math.max(0.005, y2 - y1) * rect.height).toFixed(2) + 'px'
    }
  }
  const container = pdfScrollContainer(pageElement)
  const onScroll = (): void => { position() }
  container?.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll)
  const timer = setInterval(position, 120)
  position()
  let destroyed = false
  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    clearInterval(timer)
    container?.removeEventListener('scroll', onScroll)
    window.removeEventListener('resize', onScroll)
    for (const box of elements) box.remove()
    if (layer !== null && layer.childElementCount === 0) layer.remove()
  }
  const safety = setTimeout(destroy, 20_000)
  return {
    position,
    destroy(): void {
      clearTimeout(safety)
      destroy()
    },
  }
}

/** Wait for one page to receive a text layer, scrolling it into view at most once. */
async function ensurePageText(pageNumber: number, timeoutMs: number): Promise<HTMLElement | undefined> {
  const started = Date.now()
  let page = findPdfPage(pageNumber)
  if (page === undefined) return undefined
  // Placeholder pages are 3:4 blocks before their real PDF dimensions arrive. Scrolling a
  // zero-height placeholder computes a meaningless target, so let layout settle first.
  while (page.getBoundingClientRect().height <= 0 && Date.now() - started < 350) {
    await new Promise(resolve => setTimeout(resolve, 32))
    page = findPdfPage(pageNumber)
    if (page === undefined) return undefined
  }
  if (page.querySelectorAll('span').length > 0) return page
  scrollPdfPageIntoView(page)
  markCitationTiming('page-scroll', `p${String(pageNumber)}`)
  for (;;) {
    const current = findPdfPage(pageNumber) ?? page
    if (current.querySelectorAll('span').length > 0) {
      markCitationTiming('page-text-ready', `p${String(pageNumber)} +${String(Math.round(Date.now() - started))}ms`)
      return current
    }
    if (Date.now() - started > timeoutMs) {
      markCitationTiming('page-text-timeout', `p${String(pageNumber)} +${String(Math.round(Date.now() - started))}ms`)
      return current
    }
    await new Promise(resolve => setTimeout(resolve, 40))
  }
}

/**
 * Materialize the small page window a chunk ordinal points at.
 *
 * The viewer renders a page's canvas and text layer only while that page is near the viewport,
 * and its placeholders shift layout as real pages arrive. One jump to the estimated page is
 * enough: the observer's one-viewport margin starts its neighbours too. Scrolling every page in
 * the window is what made a late chunk take seconds and bounce through the document.
 */
async function materializeTargetPages(pages: readonly number[], primaryTimeoutMs = 2400): Promise<Map<number, HTMLElement>> {
  const ready = new Map<number, HTMLElement>()
  const first = pages[0]
  if (first !== undefined) {
    const page = await ensurePageText(first, primaryTimeoutMs)
    if (page !== undefined) ready.set(first, page)
  }
  for (const number of pages.slice(1)) {
    const page = findPdfPage(number)
    if (page === undefined) continue
    if (page.querySelectorAll('span').length > 0) {
      ready.set(number, page)
      continue
    }
    // A neighbour is only worth a scroll when the primary page never produced text.
    if (ready.size === 0) {
      const neighbour = await ensurePageText(number, 800)
      if (neighbour !== undefined) ready.set(number, neighbour)
    }
  }
  for (const [number, page] of ready) {
    markCitationTiming('page-ready', `p${String(number)} spans=${String(page.querySelectorAll('span').length)}`)
  }
  return ready
}

/** Where a chunk is likely to be, and what to scan if that guess misses. */
export interface ChunkPagePlan {
  /** Pages tried first, in the order they are visited. */
  readonly primary: readonly number[]
  /** The small window around the estimate; no other page is touched on a hit. */
  readonly window: readonly number[]
  /** Remaining pages, scanned only when the window misses. */
  readonly rest: readonly number[]
}

/**
 * Map a document-local chunk ordinal onto a page window.
 *
 * A docx chunk has no page number. Chunk ordinals track reading order, and in practice chunk
 * `n` starts on page `n + 1` (the same ordinal the KB index assigned to paragraph `n`). The
 * window is deliberately `estimate + 1` then `estimate`: the ordinal points at the page where
 * the chunk starts, and a chunk often opens at the bottom of that page and continues on the
 * next. `estimate + 2` is the one-page continuation guard. Everything else is a correctness
 * fallback, never part of the fast path.
 */
export function planChunkPageWindow(
  pageNumbers: readonly number[],
  chunkOrdinal: number | undefined,
  cachedPage?: number,
): ChunkPagePlan {
  const sorted = [...new Set(pageNumbers)].sort((left, right) => left - right)
  if (sorted.length === 0) return { primary: [], window: [], rest: [] }
  const has = (page: number): boolean => sorted.includes(page)
  if (cachedPage !== undefined && has(cachedPage)) {
    return { primary: [cachedPage], window: [cachedPage], rest: sorted.filter(page => page !== cachedPage) }
  }
  const last = sorted[sorted.length - 1] ?? 1
  const estimate = chunkOrdinal === undefined
    ? Math.max(1, Math.round(last / 2))
    : Math.min(last, Math.max(1, chunkOrdinal + 1))
  const window = [estimate + 1, estimate, estimate + 2].filter(has)
  const primary = window.filter(page => page === estimate + 1 || page === estimate)
  // Fallback order is distance from the estimate, not reading order. A conversion can paginate
  // differently from the index that minted the ordinal (15 pages instead of 19), leaving the
  // chunk two pages above the estimate; visiting 12 and 11 before page 1 finds it in one lazy
  // render instead of after a full-document walk.
  const rest = sorted.filter(page => !window.includes(page))
    .sort((left, right) => Math.abs(left - estimate) - Math.abs(right - estimate) || left - right)
  return { primary, window, rest }
}

/**
 * Search pages in reading order, waiting only for the page under the cursor.
 *
 * The previous implementation materialized all 19 pages and only then searched, so a chunk on
 * page 14 paid for pages 15–19 and could take ~10s. A hit on page N is followed by one more
 * page (chunks often cross a page break), then the scan stops.
 */
async function scanDocxPages(
  pages: readonly number[],
  candidates: readonly string[],
  perPageTimeoutMs = 160,
  earlyStop = true,
  docKey?: string,
): Promise<ChunkParagraphMatch[]> {
  const matches: ChunkParagraphMatch[] = []
  const seen = new Set<HTMLElement>()
  let lastMatchedPage: number | undefined
  for (const number of pages) {
    const page = findPdfPage(number)
    if (page === undefined) continue
    if (page.querySelectorAll('span').length === 0) {
      scrollPdfPageIntoView(page)
      const started = Date.now()
      while (page.querySelectorAll('span').length === 0 && Date.now() - started <= perPageTimeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (page.querySelectorAll('span').length === 0) continue
    }
    const found = collectParagraphMatches(candidates, new Set([number]), docKey)
    for (const match of found) {
      if (seen.has(match.element)) continue
      seen.add(match.element)
      matches.push(match)
    }
    if (found.length > 0) lastMatchedPage = number
    // One extra page covers a chunk that crosses the page break.
    if (earlyStop && lastMatchedPage !== undefined && number >= lastMatchedPage + 1) break
  }
  return matches
}

/**
 * Scan the planned pages only, waiting for the first page's lazy text layer.
 *
 * The first page in `order` is the chunk-ordinal estimate. A page that is still loading gets a
 * real deadline instead of the old 160 ms probe, because the viewer commonly needs ~400 ms to
 * build a text layer after the page enters the viewport. Neighbours are read only when they are
 * already rendered; a miss then falls through to the caller's correctness fallback.
 */
async function scanTargetPages(
  order: readonly number[],
  candidates: readonly string[],
  docKey: string | undefined,
  primaryTimeoutMs: number,
): Promise<ChunkParagraphMatch[]> {
  const matches: ChunkParagraphMatch[] = []
  const seen = new Set<HTMLElement>()
  let lastMatchedPage: number | undefined
  for (const [index, number] of order.entries()) {
    let page = findPdfPage(number)
    if (page === undefined) continue
    if (page.querySelectorAll('span').length === 0) {
      if (index === 0) {
        page = await ensurePageText(number, primaryTimeoutMs) ?? page
      } else if (matches.length > 0) {
        // A continuation page is worth a short grace; do not scroll the viewer for it.
        const started = Date.now()
        while (page.querySelectorAll('span').length === 0 && Date.now() - started < 220) {
          await new Promise(resolve => setTimeout(resolve, 40))
        }
      }
    }
    if (page.querySelectorAll('span').length === 0) continue
    const found = collectParagraphMatches(candidates, new Set([number]), docKey)
    for (const match of found) {
      if (seen.has(match.element)) continue
      seen.add(match.element)
      matches.push(match)
    }
    if (found.length > 0) lastMatchedPage = number
    // The window is small; stop after the page following a hit.
    if (lastMatchedPage !== undefined && number >= lastMatchedPage + 1) break
  }
  return matches
}

/** Wait until the viewer has rendered the requested page. */
export async function waitForPdfPage(page: number, timeoutMs = 6000): Promise<HTMLElement | undefined> {
  const started = Date.now()
  for (;;) {
    const found = findPdfPage(page)
    if (found !== undefined) return found
    if (Date.now() - started > timeoutMs) return undefined
    await new Promise(resolve => setTimeout(resolve, 120))
  }
}

/** Scroll one page block into the middle of the viewer. */
export function scrollToPdfPage(pageElement: HTMLElement): void {
  pageElement.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/** Find the scrolling ancestor that actually owns the PDF viewport. */
export function pdfScrollContainer(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement
  while (node !== null && node !== document.body) {
    const style = getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node
    node = node.parentElement
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null
}

/**
 * Bring one rendered page into the scrollport without `scrollIntoView`.
 *
 * `scrollIntoView` walks every scrollable ancestor and, in the document-preview viewer, gives
 * React and PDF.js a chance to synchronously lay out and render each visited page; a 19-page
 * pass took ~8s. A direct `scrollTop` write is deterministic and leaves the same geometry.
 */
export function scrollPdfPageIntoView(page: HTMLElement): boolean {
  const container = pdfScrollContainer(page)
  if (container === null) {
    page.scrollIntoView({ block: 'center', behavior: 'auto' })
    return true
  }
  const containerRect = container.getBoundingClientRect()
  const pageRect = page.getBoundingClientRect()
  const target = container.scrollTop + (pageRect.top - containerRect.top) - Math.max(0, (container.clientHeight - pageRect.height) / 2)
  container.scrollTop = Math.max(0, target)
  return true
}

/**
 * Put the first bbox at the center of the PDF scroll container immediately.
 * `scrollIntoView` can be overridden by lazy-page scrolling and smooth animation; direct
 * scrollTop assignment is deterministic and leaves no animation to finish after our check.
 */
export function scrollToFirstBox(pageElement: HTMLElement): boolean {
  const box = pageElement.querySelector<HTMLElement>('.' + BOX_CLASS)
  if (box === null) return false
  return scrollElementToCenter(box)
}

/** Scroll the query-hit box when present. */
export function scrollToFirstHit(pageElement: HTMLElement): boolean {
  const box = pageElement.querySelector<HTMLElement>('.kb-citation-hit')
  if (box === null) return false
  return scrollElementToCenter(box)
}

function scrollElementToCenter(box: HTMLElement): boolean {
  const container = pdfScrollContainer(box)
  if (container === null) {
    box.scrollIntoView({ block: 'center', inline: 'nearest' })
    return true
  }
  const containerRect = container.getBoundingClientRect()
  const boxRect = box.getBoundingClientRect()
  const target = container.scrollTop + (boxRect.top - containerRect.top) - (container.clientHeight - boxRect.height) / 2
  container.scrollTop = Math.max(0, target)
  return true
}

/**
 * Verify the first painted box actually sits inside the viewer viewport.
 *
 * Programmatic `scrollTop` can be clamped by the viewer's own scroll anchoring or by
 * lazy-page height changes; when that happens the browser's scrollIntoView is the only
 * reliable fallback.
 */
export function ensureBoxInViewport(box: HTMLElement | undefined): boolean {
  if (box === undefined) return false
  const container = pdfScrollContainer(box)
  if (container === null) {
    box.scrollIntoView({ block: 'center', inline: 'nearest' })
    return true
  }
  scrollElementToCenter(box)
  const containerRect = container.getBoundingClientRect()
  const boxRect = box.getBoundingClientRect()
  const visible = boxRect.bottom > containerRect.top + 2 && boxRect.top < containerRect.bottom - 2
  if (!visible) box.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
  return true
}

/** Is any part of the box inside the PDF scrollport right now? */
function boxInScrollport(box: HTMLElement): boolean {
  const container = pdfScrollContainer(box)
  if (container === null) {
    const rect = box.getBoundingClientRect()
    return rect.bottom > 0 && rect.top < window.innerHeight
  }
  const containerRect = container.getBoundingClientRect()
  const boxRect = box.getBoundingClientRect()
  return boxRect.bottom > containerRect.top + 2 && boxRect.top < containerRect.bottom - 2
}

/**
 * Land the first box and keep it landed while placeholder pages acquire real dimensions.
 *
 * The viewer mounts every page as a 3:4 placeholder and replaces those heights as pages render;
 * a scrollTop that was correct when the box was painted can leave it thousands of pixels away a
 * few frames later. Two identical visible frames end the correction, so this is a landing loop,
 * not a second search: it never scrolls to another page.
 */
export async function stabilizeFirstBox(
  box: HTMLElement | undefined,
  timeoutMs = 420,
  repaint?: () => HTMLElement | undefined,
): Promise<boolean> {
  if (box === undefined) return false
  const started = typeof performance === 'undefined' ? Date.now() : performance.now()
  const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())
  let current = box
  let lastKey = ''
  let repainted = false
  while (now() - started <= timeoutMs) {
    const visible = boxInScrollport(current)
    const rect = current.getBoundingClientRect()
    const key = String(Math.round(rect.top)) + ':' + String(Math.round(rect.height))
    if (!visible) {
      // The page may have moved after its own layout settled; repaint once from fresh span
      // geometry before trusting a scroll target computed from a stale overlay.
      if (!repainted && repaint !== undefined) {
        repainted = true
        current = repaint() ?? current
      }
      scrollElementToCenter(current)
      lastKey = ''
    } else if (key === lastKey) {
      markCitationTiming('first-box-visible', `+${String(Math.round(now() - started))}ms`)
      return true
    } else {
      lastKey = key
    }
    await nextFrame()
  }
  const landed = boxInScrollport(current)
  markCitationTiming('first-box-visible', landed ? 'settled' : 'timeout')
  return landed
}

/** Paint normalized citation rectangles over one rendered page. */
export function renderBoxHighlights(pageElement: HTMLElement, boxes: readonly CitationBox[]): void {
  ensureStyle()
  for (const old of pageElement.querySelectorAll('.' + BOX_CLASS)) old.remove()
  if (boxes.length === 0) return
  // A chunk is one region per page. Callers normally pass the page union already; older
  // payloads that still carry one box per paragraph are unioned here so the first painted
  // frame is a single rectangle, never a stack that merges a frame later.
  const union = unionOfBoxes(boxes)
  if (union === undefined) return
  const [x1, y1, x2, y2] = union
  const { parent, contentRect, parentRect } = pdfContentBox(pageElement)
  const box = document.createElement('div')
  box.className = BOX_CLASS
  box.dataset.kbCitationBox = 'true'
  // Normalized coordinates are relative to the rendered canvas/content area, not the padded
  // page shell; translate by the content's offset inside the overlay parent.
  box.style.left = ((contentRect.left - parentRect.left) + x1 * contentRect.width).toFixed(2) + 'px'
  box.style.top = ((contentRect.top - parentRect.top) + y1 * contentRect.height).toFixed(2) + 'px'
  box.style.width = Math.max(0.005, (x2 - x1) * contentRect.width) + 'px'
  box.style.height = Math.max(0.005, (y2 - y1) * contentRect.height) + 'px'
  parent.appendChild(box)
}

/** Normalize text for comparison across PDF text-layer line breaks. */
function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Every page under a root, including the root itself when it is a page. */
function pageElements(root: ParentNode): HTMLElement[] {
  const pages = [...root.querySelectorAll<HTMLElement>(PAGE_SELECTOR)]
  if (root instanceof HTMLElement && root.matches(PAGE_SELECTOR)) pages.unshift(root)
  return pages
}

/** Collect every rendered occurrence of a quote across all pages. */
export function findPdfTextMatches(quote: string, root: ParentNode = document): PdfTextMatch[] {
  const needle = normalize(quote).toLowerCase()
  if (needle === '') return []
  const matches: PdfTextMatch[] = []
  for (const page of pageElements(root)) {
    const number = Number(page.dataset.pdfPage)
    const spans = [...page.querySelectorAll<HTMLElement>('span')]
    let occurrence = 0
    for (const span of spans) {
      const text = normalize(span.textContent ?? '')
      if (text === '' || !text.toLowerCase().includes(needle)) continue
      occurrence += 1
      matches.push({
        page: number, element: span, text,
        occurrence, context: (page.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120),
      })
    }
  }
  return matches
}

/** Draw one union box for the matched text; never outline individual PDF spans. */
export function flashTextMatch(match: PdfTextMatch): void {
  flashElement(match.element)
}

/** Draw one union box around one text element without outlining its nested spans. */
function flashElement(element: HTMLElement): void {
  const page = element.closest<HTMLElement>(PAGE_SELECTOR)
  if (page === null) return
  const { contentRect } = pdfContentBox(page)
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  if (contentRect.width <= 0 || contentRect.height <= 0) {
    // Minimal test/legacy page shell without a measured content box: keep one box rather
    // than falling back to outlining the span itself.
    const box = document.createElement('div')
    box.className = BOX_CLASS
    box.dataset.kbCitationBox = 'true'
    box.style.position = 'absolute'
    box.style.left = `${String(Math.max(0, rect.left))}px`
    box.style.top = `${String(Math.max(0, rect.top))}px`
    box.style.width = `${String(rect.width)}px`
    box.style.height = `${String(rect.height)}px`
    page.appendChild(box)
    return
  }
  renderBoxHighlights(page, [[
    (rect.left - contentRect.left) / contentRect.width,
    (rect.top - contentRect.top) / contentRect.height,
    (rect.right - contentRect.left) / contentRect.width,
    (rect.bottom - contentRect.top) / contentRect.height,
  ]])
}

/**
 * Let the reader choose among multiple text matches.
 *
 * @returns the chosen match, or null when the picker is dismissed.
 */
export function chooseTextMatch(matches: readonly PdfTextMatch[]): Promise<PdfTextMatch | null> {
  if (matches.length === 0) return Promise.resolve(null)
  if (matches.length === 1) return Promise.resolve(matches[0] ?? null)
  ensureStyle()
  return new Promise(resolve => {
    const panel = document.createElement('div')
    panel.className = 'kb-citation-picker'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', '选择引用位置')
    const title = document.createElement('h4')
    title.textContent = '找到 ' + String(matches.length) + ' 处引用，请选择'
    panel.appendChild(title)
    const close = (value: PdfTextMatch | null): void => {
      panel.remove()
      document.removeEventListener('keydown', onKey, true)
      resolve(value)
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(null) }
    for (const match of matches) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = '第 ' + String(match.page) + ' 页 · 第 ' + String(match.occurrence) + ' 处'
      const small = document.createElement('small')
      small.textContent = match.context
      button.appendChild(small)
      button.addEventListener('click', () => { close(match) })
      panel.appendChild(button)
    }
    document.body.appendChild(panel)
    const rect = matches[0]?.element.getBoundingClientRect()
    panel.style.left = String(Math.max(12, Math.min(window.innerWidth - 340, (rect?.left ?? 80)))) + 'px'
    panel.style.top = String(Math.max(12, Math.min(window.innerHeight - 320, (rect?.top ?? 80)))) + 'px'
    document.addEventListener('keydown', onKey, true)
  })
}

/**
 * Chunk-first PDF highlighting: render every page group's boxes, scrolled to the first page.
 * A multi-page chunk is preserved as separate groups instead of flattening all rectangles onto
 * the first page.
 */
export async function highlightPdfChunk(groups: readonly CitationBoxGroup[]): Promise<PdfHighlightResult> {
  ensureStyle()
  let firstPage: HTMLElement | undefined
  let rendered = 0
  let count = 0
  // One box per page is the paint contract even if an old token or an old KB response carries
  // several paragraph boxes for the same page.
  for (const group of oneUnionPerPage(groups)) {
    const pageElement = await waitForPdfPage(group.page)
    if (pageElement === undefined) continue
    firstPage ??= pageElement
    renderBoxHighlights(pageElement, group.boxes)
    rendered += 1
    count += 1
  }
  if (firstPage === undefined) return { status: 'missing' }
  if (!scrollToFirstBox(firstPage)) scrollToPdfPage(firstPage)
  return { status: 'boxes', page: Number(firstPage.dataset.pdfPage), pageCount: count, groups: rendered }
}

/**
 * Apply one citation to the already-open PDF viewer.
 *
 * @param page - 1-based page, when the backend supplied one.
 * @param boxes - normalized boxes for that page.
 * @param quote - text used when boxes are absent.
 */
export async function highlightPdfCitation(input: {
  page?: number
  boxes?: readonly CitationBox[]
  quote?: string
}): Promise<PdfHighlightResult> {
  ensureStyle()
  if (input.page !== undefined) {
    const pageElement = await waitForPdfPage(input.page)
    if (pageElement === undefined) return { status: 'missing' }
    scrollToPdfPage(pageElement)
    if (input.boxes !== undefined && input.boxes.length > 0) {
      renderBoxHighlights(pageElement, input.boxes)
      return { status: 'boxes', page: input.page, pageCount: input.boxes.length }
    }
    if (input.quote !== undefined) {
      const matches = findPdfTextMatches(input.quote).filter(match => match.page === input.page)
      if (matches.length === 0) return { status: 'missing', page: input.page }
      if (matches.length === 1) {
        flashTextMatch(matches[0] as PdfTextMatch)
        return { status: 'text', page: input.page, matches: 1 }
      }
      const chosen = await chooseTextMatch(matches)
      if (chosen === null) return { status: 'ambiguous', page: input.page, matches: matches.length }
      scrollToPdfPage(chosen.element)
      flashTextMatch(chosen)
      return { status: 'text', page: chosen.page, matches: matches.length }
    }
    return { status: 'boxes', page: input.page }
  }
  if (input.quote !== undefined && input.quote.trim() !== '') {
    const matches = findPdfTextMatches(input.quote)
    if (matches.length === 0) return { status: 'missing' }
    if (matches.length === 1) {
      scrollToPdfPage(matches[0]!.element)
      flashTextMatch(matches[0]!)
      return { status: 'text', page: matches[0]!.page, matches: 1 }
    }
    const chosen = await chooseTextMatch(matches)
    if (chosen === null) return { status: 'ambiguous', matches: matches.length }
    scrollToPdfPage(chosen.element)
    flashTextMatch(chosen)
    return { status: 'text', page: chosen.page, matches: matches.length }
  }
  return { status: 'missing' }
}

/**
 * Wait until the active PDF surface has real page boxes.
 *
 * A `[data-pdf-preview]` node alone is not enough: the document-preview tab mounts it before
 * pages have dimensions, and an inactive tab can keep an old preview mounted. Requiring a page
 * with a non-zero rect skips both, so the first scroll lands on the document the reader opened.
 */
export async function waitForPdfPreview(timeoutMs = 8000): Promise<boolean> {
  const started = Date.now()
  for (;;) {
    const pages = [...document.querySelectorAll<HTMLElement>(PAGE_SELECTOR)]
    const preview = document.querySelector('[data-pdf-preview]')
    // A fixture or a bare host PDF has no preview wrapper; page shells alone mean it is ready.
    if (preview === null && pages.length > 0) return true
    if (pages.some(page => page.getBoundingClientRect().width > 0)) return true
    if (Date.now() - started > timeoutMs) return preview !== null || pages.length > 0
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Scroll each page into view once so lazy text layers materialize before a quote search. */
export async function renderAllPdfPages(root: ParentNode = document): Promise<number> {
  const pages = [...root.querySelectorAll<HTMLElement>(PAGE_SELECTOR)]
  for (const page of pages) {
    page.scrollIntoView({ block: 'center', behavior: 'auto' })
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  return pages.length
}

/** Draw one union rectangle per page over the matched text spans. */
export function renderTextMatchBoxes(matches: readonly PdfTextMatch[]): number {
  ensureStyle()
  // One page, one rectangle: a paragraph can match several spans, and painting each span would
  // reproduce the paragraph-stack flicker the citation viewer must never show.
  const unions = new Map<HTMLElement, { left: number; top: number; right: number; bottom: number }>()
  for (const match of matches) {
    const page = match.element.closest<HTMLElement>(PAGE_SELECTOR)
    if (page === null) continue
    const rect = match.element.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) continue
    const union = unions.get(page) ?? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    union.left = Math.min(union.left, rect.left)
    union.top = Math.min(union.top, rect.top)
    union.right = Math.max(union.right, rect.right)
    union.bottom = Math.max(union.bottom, rect.bottom)
    unions.set(page, union)
  }
  let drawn = 0
  for (const [page, union] of unions) {
    const { parent, parentRect } = pdfContentBox(page)
    if (union.right <= union.left || union.bottom <= union.top) continue
    const box = document.createElement('div')
    box.className = BOX_CLASS
    box.dataset.kbCitationBox = 'true'
    box.style.left = (union.left - parentRect.left).toFixed(2) + 'px'
    box.style.top = (union.top - parentRect.top).toFixed(2) + 'px'
    box.style.width = Math.max(0.5, union.right - union.left).toFixed(2) + 'px'
    box.style.height = Math.max(0.5, union.bottom - union.top).toFixed(2) + 'px'
    parent.appendChild(box)
    drawn += 1
  }
  return drawn
}

/** Wait for lazy text spans to yield the requested quote (Office PDFs load text ~seconds). */
export async function waitForQuoteMatches(needle: string, timeoutMs = 12000): Promise<PdfTextMatch[]> {
  const started = Date.now()
  for (;;) {
    const matches = findPdfTextMatches(needle)
    if (matches.length > 0 || Date.now() - started > timeoutMs) return matches
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/** Normalize chunk/PDF text for cross-span matching: NFKC, lower case, markdown/table noise. */
function normalizeChunkText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s|#*_>`~]+/g, '')
}

/** One paragraph's mapped area on a rendered PDF page. */
export interface ChunkParagraphMatch {
  readonly page: number
  readonly rect: DOMRect
  readonly element: HTMLElement
  /** Every span the paragraph covers on this page, used to repaint after layout shifts. */
  readonly spans: readonly HTMLElement[]
  /** The paragraph or sentence fragment that matched this page. */
  readonly text: string
}

/** Union of the current viewport rectangles of a span range. */
function unionSpanRect(spans: readonly HTMLElement[]): { left: number; top: number; right: number; bottom: number } | undefined {
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const span of spans) {
    const rect = span.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) continue
    left = Math.min(left, rect.left)
    top = Math.min(top, rect.top)
    right = Math.max(right, Number.isFinite(rect.right) ? rect.right : rect.left + rect.width)
    bottom = Math.max(bottom, Number.isFinite(rect.bottom) ? rect.bottom : rect.top + rect.height)
  }
  return Number.isFinite(left) && Number.isFinite(top) && right > left && bottom > top
    ? { left, top, right, bottom }
    : undefined
}

/** Find a paragraph across PDF spans, returning a union rectangle for the matched range. */
export function findChunkParagraphMatches(paragraph: string, root: ParentNode = document, pages?: ReadonlySet<number>, docKey?: string): ChunkParagraphMatch[] {
  const needle = normalizeChunkText(paragraph)
  if (needle.length < 2) return []
  const found: ChunkParagraphMatch[] = []
  for (const page of pageElements(root)) {
    const number = Number(page.dataset.pdfPage)
    if (pages !== undefined && !pages.has(number)) continue
    const text = pageTextOf(page, docKey)
    const spans = text.spans
    if (spans.length === 0) continue
    const parts = text.parts
    const combined = text.combined
    const start = combined.indexOf(needle)
    if (start === -1) continue
    let cursor = 0
    let first = -1
    let last = -1
    for (let index = 0; index < parts.length; index += 1) {
      const next = cursor + parts[index]!.length
      if (first === -1 && start >= cursor && start < next) first = index
      if (start + needle.length > cursor && start + needle.length <= next) { last = index; break }
      cursor = next
    }
    if (first === -1) continue
    if (last === -1) last = parts.length - 1
    const matched = spans.slice(first, last + 1)
    const rect = unionSpanRect(matched) ?? { left: 0, top: 0, right: 0, bottom: 0 }
    found.push({
      page: number,
      rect: { ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top, x: rect.left, y: rect.top, toJSON: () => ({}) } as DOMRect,
      element: spans[first]!,
      spans: matched,
      text: paragraph,
    })
  }
  return found
}

/** Validate that a drawn union box actually covers the chunk's text content. */
export function verifyChunkBoxContent(pageElement: HTMLElement, box: { left: number; top: number; right: number; bottom: number }, texts: readonly string[]): { readonly ok: boolean; readonly score: number } {
  if (box.right - box.left <= 0 || box.bottom - box.top <= 0) return { ok: true, score: 1 }
  const inside = [...pageElement.querySelectorAll<HTMLElement>('span')].filter(span => {
    const rect = span.getBoundingClientRect()
    const right = Number.isFinite(rect.right) ? rect.right : rect.left + rect.width
    const bottom = Number.isFinite(rect.bottom) ? rect.bottom : rect.top + rect.height
    return right > box.left && rect.left < box.right && bottom > box.top && rect.top < box.bottom
  }).map(span => normalizeChunkText(span.textContent ?? '')).join('')
  const needle = normalizeChunkText(texts.join(''))
  if (needle === '' || inside === '') return { ok: false, score: 0 }
  let hit = 0
  // Character bigram coverage is tolerant of line breaks/spacing and cheap to compute.
  for (let index = 0; index + 1 < needle.length; index += 1) {
    if (inside.includes(needle.slice(index, index + 2))) hit += 1
  }
  const score = hit / Math.max(1, needle.length - 1)
  return { ok: score >= 0.5, score }
}

/** Where one amber box goes, or undefined when the span has no usable layout yet. */
function hitBoxPlacement(match: PdfTextMatch): { parent: HTMLElement; left: number; top: number; width: number; height: number } | undefined {
  const page = match.element.closest<HTMLElement>(PAGE_SELECTOR)
  if (page === null) return undefined
  const { parent, parentRect } = pdfContentBox(page)
  const rect = match.element.getBoundingClientRect()
  // A text layer that has text but has not been typeset yet reports a 0×0 rect. Drawing that
  // produces a 0.5px dot pinned to the page corner — the reported "amber never appears" state
  // — so treat it as not-yet-matchable and let the caller retry once layout exists.
  if (rect.width <= 0 || rect.height <= 0) return undefined
  const left = rect.left - parentRect.left
  const top = rect.top - parentRect.top
  // A stale rect (layout changed between match and paint) lands far outside the page; skip it
  // instead of painting an overlay over unrelated chrome. A host without a measurable page box
  // (jsdom, a detached shell) has no bounds to check against.
  if (parentRect.width > 0 && parentRect.height > 0
    && (left < -8 || top < -8 || left > parentRect.width + 8 || top > parentRect.height + 8)) return undefined
  return { parent, left, top, width: rect.width, height: rect.height }
}

/** Text nodes of one span in reading order, with their character offsets in `textContent`. */
function textNodesOf(element: HTMLElement): Array<{ node: Text; start: number; end: number }> {
  const result: Array<{ node: Text; start: number; end: number }> = []
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let offset = 0
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType !== 3) continue
    const text = node as Text
    const length = text.data.length
    if (length > 0) result.push({ node: text, start: offset, end: offset + length })
    offset += length
  }
  return result
}

/**
 * The exact character range of `term` inside one text-layer span.
 *
 * PDF.js often exposes a whole line as one span. Outlining that span whenever it contains 董事
 * paints the entire article line and makes an unrelated sentence look like a semantic match;
 * a Range over the matched characters gives the reader the two characters that actually matched.
 * Whitespace is ignored for the search because the text layer inserts line-break spaces.
 */
function termRange(element: HTMLElement, term: string): Range | undefined {
  const text = element.textContent ?? ''
  let normalized = ''
  const offsets: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (/\s/u.test(character)) continue
    normalized += character
    offsets.push(index)
  }
  const at = normalized.indexOf(term)
  if (at < 0) return undefined
  const start = offsets[at]!
  const end = offsets[at + term.length - 1]! + 1
  const nodes = textNodesOf(element)
  const startEntry = nodes.find(entry => start >= entry.start && start < entry.end)
  const endEntry = nodes.find(entry => end > entry.start && end <= entry.end)
  if (startEntry === undefined || endEntry === undefined) return undefined
  const range = element.ownerDocument.createRange()
  range.setStart(startEntry.node, start - startEntry.start)
  range.setEnd(endEntry.node, end - endEntry.start)
  return range
}

/** Client rects for the matched characters, or an empty list when the host cannot measure them. */
function termRects(match: PdfTextMatch): DOMRect[] {
  if (match.term === undefined || match.term === '') return []
  const range = termRange(match.element, match.term)
  if (range === undefined || typeof range.getClientRects !== 'function') return []
  return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
}

/** Draw amber only where a matching span intersects this page's blue union box. */
export function renderClippedHitBoxes(pageElement: HTMLElement, matches: readonly PdfTextMatch[]): number {
  ensureStyle()
  const pageRect = pageElement.getBoundingClientRect()
  const unionBoxes = [...pageElement.querySelectorAll<HTMLElement>('.' + BOX_CLASS)]
  if (unionBoxes.length === 0) return 0
  const measured = unionBoxes.map(box => box.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0)
  // A blue box always exists here. Zero geometry means the host has not typeset yet or the unit
  // fixture has no layout; use the page bounds rather than dropping a real in-chunk hit.
  const unions = measured.length > 0 ? measured : [pageRect.width > 0 ? pageRect : { left: -1e6, top: -1e6, right: 1e6, bottom: 1e6 }]
  let drawn = 0
  const seen = new Set<string>()
  for (const match of matches) {
    const exact = termRects(match)
    const sourceRects = exact.length > 0 ? exact : [match.element.getBoundingClientRect()]
    for (const spanRect of sourceRects) {
      if (spanRect.width <= 0 || spanRect.height <= 0) continue
      for (const union of unions) {
        const left = Math.max(spanRect.left, union.left)
        const top = Math.max(spanRect.top, union.top)
        const right = Math.min(spanRect.right, union.right)
        const bottom = Math.min(spanRect.bottom, union.bottom)
        if (right - left <= 0 || bottom - top <= 0) continue
        const key = [left, top, right, bottom].map(value => value.toFixed(1)).join(':')
        if (seen.has(key)) continue
        seen.add(key)
        const box = document.createElement('div')
        box.className = 'kb-citation-hit'
        box.dataset.kbCitationHit = 'true'
        box.dataset.kbCitationPage = pageElement.dataset.pdfPage ?? ''
        box.style.left = (left - pageRect.left).toFixed(2) + 'px'
        box.style.top = (top - pageRect.top).toFixed(2) + 'px'
        box.style.width = (right - left).toFixed(2) + 'px'
        box.style.height = (bottom - top).toFixed(2) + 'px'
        pageElement.appendChild(box)
        drawn += 1
      }
    }
  }
  return drawn
}

/** Draw query-hit boxes in a distinct amber color; chunk union stays blue. */
export function renderHitBoxes(matches: readonly PdfTextMatch[]): number {
  ensureStyle()
  let drawn = 0
  for (const match of matches) {
    const placement = hitBoxPlacement(match)
    if (placement === undefined) continue
    const box = document.createElement('div')
    box.className = 'kb-citation-hit'
    box.dataset.kbCitationHit = 'true'
    box.style.left = placement.left.toFixed(2) + 'px'
    box.style.top = placement.top.toFixed(2) + 'px'
    box.style.width = Math.max(0.5, placement.width).toFixed(2) + 'px'
    box.style.height = Math.max(0.5, placement.height).toFixed(2) + 'px'
    placement.parent.appendChild(box)
    drawn += 1
  }
  return drawn
}

/** Normalized page text plus the span that owns each character. */
interface PageTextIndex {
  readonly text: string
  readonly spans: readonly { span: HTMLElement; start: number; end: number }[]
}

/**
 * Concatenate a page's text-layer spans in reading order.
 *
 * A PDF text layer splits a run at every line break, and Chinese runs are often split per
 * character. Matching one span at a time therefore misses `表决` whenever the two characters
 * land in different spans, which is the common case over a line wrap. The page-level string is
 * the unit the reader actually sees.
 */
function pageTextIndex(pageElement: HTMLElement): PageTextIndex {
  const spans: { span: HTMLElement; start: number; end: number }[] = []
  let text = ''
  for (const span of pageElement.querySelectorAll<HTMLElement>('span')) {
    const normalized = normalizeChunkText(span.textContent ?? '')
    if (normalized === '') continue
    spans.push({ span, start: text.length, end: text.length + normalized.length })
    text += normalized
  }
  return { text, spans }
}

/** Every span touched by one character range of the page text. */
function spansInRange(index: PageTextIndex, start: number, end: number): HTMLElement[] {
  const touched: HTMLElement[] = []
  for (const entry of index.spans) {
    if (entry.end <= start) continue
    if (entry.start >= end) break
    touched.push(entry.span)
  }
  return touched
}

/**
 * Draw amber hits for the query/quote terms on one page, tolerating truncated quotes.
 *
 * Terms are matched against the page-level text so a term split across spans (a line wrap or a
 * per-character text run) still lands, then every span the match touches is outlined. The chunk
 * union stays blue and is never replaced: amber only adds a second, thinner series.
 */
export function renderQueryHits(query: string, pageElement: HTMLElement, queryTerms?: readonly string[]): number {
  const pageNumber = Number(pageElement.dataset.pdfPage)
  if (!Number.isInteger(pageNumber)) return 0
  const terms = [...new Set((queryTerms !== undefined && queryTerms.length > 0 ? queryTerms : [query, ...query.split(/[：:，,。；;、\s…]+|\.{2,}/).map(term => term.trim())]).map(term => normalizeChunkText(term)).filter(term => term.length >= 2))]
  const index = pageTextIndex(pageElement)
  const matches: PdfTextMatch[] = []
  const perTerm: { term: string; occurrences: number; spans: number }[] = []
  for (const term of terms) {
    let occurrences = 0
    let cursor = 0
    while (cursor <= index.text.length - term.length) {
      const at = index.text.indexOf(term, cursor)
      if (at === -1) break
      occurrences += 1
      for (const span of spansInRange(index, at, at + term.length)) {
        // Do not dedupe by span: a line span can contain two different terms, and both need
        // their own exact character range for the amber layer.
        matches.push({
          page: pageNumber, element: span, text: span.textContent ?? '', term,
          occurrence: matches.length + 1, context: index.text.slice(at, at + 120),
        })
      }
      cursor = at + term.length
    }
    perTerm.push({ term, occurrences, spans: matches.length })
  }
  // Keep an earlier pass's boxes when this pass matched only unlaid-out spans: removing them
  // would blink amber off exactly while the text layer is being typeset.
  const existing = pageElement.querySelectorAll('.kb-citation-hit').length
  if (existing > 0 && matches.every(match => hitBoxPlacement(match) === undefined)) return 0
  for (const old of pageElement.querySelectorAll<HTMLElement>('.kb-citation-hit')) old.remove()
  for (const old of pageElement.querySelectorAll<HTMLElement>('.kb-citation-hit')) old.remove()
  const drawn = renderClippedHitBoxes(pageElement, matches)
  document.querySelector('.kb-citation-legend')?.remove()
  recordCitationDebug('renderQueryHits', {
    page: pageNumber,
    terms,
    pageChars: index.text.length,
    pageSpans: index.spans.length,
    drawn,
    placeable: matches.filter(match => hitBoxPlacement(match) !== undefined).length,
    perTerm,
    matchedSpans: matches.slice(0, 12).map(match => normalizeChunkText(match.text).slice(0, 80)),
  })
  return drawn
}


/** Page hosts that currently carry a blue union box, in reading order. */
function boxPageElements(): HTMLElement[] {
  const pages: HTMLElement[] = []
  for (const box of document.querySelectorAll<HTMLElement>('.' + BOX_CLASS)) {
    const page = box.closest<HTMLElement>(PAGE_SELECTOR)
    if (page !== null && !pages.includes(page)) pages.push(page)
  }
  return pages
}

/** Remove every amber overlay and the retired legend node. */
function clearQueryHits(): void {
  for (const old of document.querySelectorAll<HTMLElement>('.kb-citation-hit')) old.remove()
  document.querySelector('.kb-citation-legend')?.remove()
}

/**
 * Draw amber query hits on the chunk's own pages.
 *
 * The chunk page is where the reader is looking, so only that page's text is evidence that the
 * question landed on this citation. Painting a term found on another page would put amber where
 * the reader is not looking and, worse, report success while the visible page still has none.
 * A page whose text layer is not typeset yet yields zero, which the caller retries.
 */
function paintAmberHits(query: string, queryTerms: readonly string[] | undefined, preferred: readonly HTMLElement[]): number {
  // Each page replaces only its own boxes. A global clear here would wipe a good earlier pass
  // when a later refresh runs against a text layer that is momentarily unlaid-out.
  let drawn = 0
  const visited = new Set<HTMLElement>()
  for (const page of preferred) {
    if (visited.has(page)) continue
    visited.add(page)
    drawn += renderQueryHits(query, page, queryTerms)
  }
  return drawn
}

/**
 * Keep trying to paint amber while the page's text layer is still arriving.
 *
 * A citation can land on a page shell before PDF.js has built its text layer (the viewer shows
 * "文档渲染中" for seconds on a cold Office→PDF conversion). The blue union is already correct at
 * that moment; amber is not, because there are no spans to match yet. Poll until a page produces
 * text, then stop on the first hit.
 */
function scheduleAmberRetry(input: {
  generation: number
  query: string
  queryTerms?: readonly string[]
  pages: readonly HTMLElement[]
  timeoutMs?: number
}): void {
  const started = Date.now()
  const timeout = input.timeoutMs ?? 20000
  const tick = (): void => {
    if (input.generation !== activeCitation) return
    if (input.pages.some(page => page.isConnected && page.querySelectorAll('.kb-citation-hit').length > 0)) return
    if (Date.now() - started > timeout) return
    const ready = input.pages.filter(page => page.isConnected && page.querySelectorAll('span').length > 0)
    if (ready.length === 0) {
      setTimeout(tick, 500)
      return
    }
    const drawn = paintAmberHits(input.query, input.queryTerms, ready)
    if (drawn > 0) {
      recordCitationDebug('amberLate', { drawn, atMs: Date.now() - started })
      return
    }
    setTimeout(tick, 500)
  }
  setTimeout(tick, 400)
}

/**
 * Repaint amber when the page's text layer grows after the first paint.
 *
 * The first amber pass can run while PDF.js has only the page's first screenful of spans; the
 * rest of the page (where the key terms often live) arrives a second later. Without a refresh
 * the boxes stay correct for the partial text and miss the terms that came in later, which is
 * exactly the "amber 0 on the important words" report. Three bounded passes keyed on span count
 * catch that growth without polling forever.
 */
function scheduleAmberRefresh(input: {
  generation: number
  query: string
  queryTerms?: readonly string[]
  pages: readonly HTMLElement[]
}): void {
  const stamp = new Map<HTMLElement, number>()
  for (const page of input.pages) stamp.set(page, page.querySelectorAll('span').length)
  for (const delay of [700, 1800, 4000]) {
    setTimeout(() => {
      if (input.generation !== activeCitation) return
      const ready = input.pages.filter(page => page.isConnected && page.querySelectorAll('span').length > 0)
      if (ready.length === 0) return
      const grew = ready.some(page => page.querySelectorAll('span').length !== stamp.get(page))
      if (!grew) return
      const drawn = paintAmberHits(input.query, input.queryTerms, ready)
      for (const page of ready) stamp.set(page, page.querySelectorAll('span').length)
      recordCitationDebug('amberRefresh', { drawn, atMs: delay })
    }, delay)
  }
}

/** Let React commit freshly appended overlay boxes before measuring them. */
async function nextFrame(): Promise<void> {
  await new Promise<void>(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    else setTimeout(resolve, 32)
  })
}

/** The text candidates a docx chunk can be located by, most specific first. */
function paragraphCandidates(input: {
  quote?: string
  heading?: string
  paragraphText?: string
  chunkText?: string
  paragraphs?: readonly { text: string }[]
}): string[] {
  const candidates: string[] = []
  for (const paragraph of input.paragraphs ?? []) if (paragraph.text.trim() !== '') candidates.push(paragraph.text)
  if (candidates.length === 0 && input.chunkText !== undefined) {
    candidates.push(...input.chunkText.split(/\n{2,}|\n/).map(text => text.trim()).filter(text => text !== ''))
  }
  if (input.paragraphText !== undefined && input.paragraphText.trim() !== '') candidates.push(input.paragraphText)
  if (candidates.length === 0 && input.heading !== undefined) candidates.push(input.heading)
  if (candidates.length === 0 && input.quote !== undefined) candidates.push(input.quote)
  return candidates
}

/**
 * Locate every candidate on the rendered pages.
 *
 * A docx chunk is usually a whole section: the full paragraph often crosses a page break,
 * so the PDF text layer never contains it inside one page. Sentence-sized fragments are the
 * reliable unit; short character windows are only a last resort when nothing else matched.
 */
function collectParagraphMatches(candidates: readonly string[], pages: ReadonlySet<number>, docKey?: string): ChunkParagraphMatch[] {
  const matches: ChunkParagraphMatch[] = []
  const seen = new Set<HTMLElement>()
  const add = (found: readonly ChunkParagraphMatch[]): void => {
    for (const match of found) {
      if (seen.has(match.element)) continue
      seen.add(match.element)
      matches.push(match)
    }
  }
  for (const candidate of candidates) {
    const before = matches.length
    const direct = findChunkParagraphMatches(candidate, document, pages, docKey)
    add(direct)
    if (direct.length > 0) continue
    // A paragraph is often split into punctuation/line fragments in the PDF text layer.
    const pieces = candidate.split(/[。！？；\n]/).map(piece => piece.trim()).filter(piece => piece.length >= 4)
    for (const piece of pieces) add(findChunkParagraphMatches(piece, document, pages, docKey))
    if (matches.length === before) {
      // Last resort: short overlapping character windows still locate the body text.
      for (let start = 0; start + 16 <= candidate.length; start += 12) {
        add(findChunkParagraphMatches(candidate.slice(start, start + 16), document, pages, docKey))
      }
    }
  }
  return matches
}

/** Paint one union box per page and report the first box that must be revealed. */
function paintChunkBoxes(matches: readonly ChunkParagraphMatch[], fallbackTexts: readonly string[]): {
  readonly boxes: readonly HTMLElement[]
  readonly firstBox?: HTMLElement
  readonly firstPage?: HTMLElement
  readonly invalid: boolean
} {
  for (const old of document.querySelectorAll('.' + BOX_CLASS)) {
    if (old.getAttribute('data-kb-citation-floating') !== 'true') old.remove()
  }
  const groups = new Map<number, { left: number; top: number; right: number; bottom: number }>()
  const textsByPage = new Map<number, string[]>()
  for (const match of matches) {
    // Text-layer geometry is captured while scanning, but pages above the chunk can change
    // height between the match and the paint (3:4 placeholders become real pages). Read the
    // matched spans again so the union is anchored to where the text is now.
    const current = unionSpanRect(match.spans) ?? { left: match.rect.left, top: match.rect.top, right: match.rect.right, bottom: match.rect.bottom }
    const union = groups.get(match.page) ?? { left: current.left, top: current.top, right: current.right, bottom: current.bottom }
    union.left = Math.min(union.left, current.left)
    union.top = Math.min(union.top, current.top)
    union.right = Math.max(union.right, current.right)
    union.bottom = Math.max(union.bottom, current.bottom)
    groups.set(match.page, union)
    const texts = textsByPage.get(match.page) ?? []
    texts.push(match.text)
    textsByPage.set(match.page, texts)
  }
  const boxes: HTMLElement[] = []
  let firstPage: HTMLElement | undefined
  let invalid = false
  for (const [pageNumber, union] of [...groups.entries()].sort((left, right) => left[0] - right[0])) {
    const page = findPdfPage(pageNumber)
    if (page === undefined) continue
    // A page just below the viewport can expose text spans before its surface has layout;
    // painting that match would create a 0.5px box at a negative offset. Skip it and let a
    // later citation retry after the page is ready.
    const width = union.right - union.left
    const height = union.bottom - union.top
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue
    firstPage ??= page
    // Append to the page host, not to the renderer-owned surface: React replaces the surface
    // children when a lazy page finishes rendering, which would delete an overlay appended there.
    const pageRect = page.getBoundingClientRect()
    const pageStyle = getComputedStyle(page)
    if (pageStyle.position !== 'relative' && pageStyle.position !== 'absolute' && pageStyle.position !== 'fixed') page.style.position = 'relative'
    const box = document.createElement('div')
    box.className = BOX_CLASS
    box.dataset.kbCitationBox = 'true'
    box.dataset.kbCitationPage = String(pageNumber)
    box.style.left = (union.left - pageRect.left).toFixed(2) + 'px'
    box.style.top = (union.top - pageRect.top).toFixed(2) + 'px'
    box.style.width = Math.max(0.5, union.right - union.left).toFixed(2) + 'px'
    box.style.height = Math.max(0.5, union.bottom - union.top).toFixed(2) + 'px'
    page.appendChild(box)
    boxes.push(box)
    const check = verifyChunkBoxContent(page, union, textsByPage.get(pageNumber) ?? fallbackTexts)
    if (!check.ok) invalid = true
  }
  return { boxes, ...(boxes[0] === undefined ? {} : { firstBox: boxes[0] }), ...(firstPage === undefined ? {} : { firstPage }), invalid }
}

/**
 * Office documents are opened through the original `.docx`, whose host viewer converts them to
 * PDF. Locate the quote (or heading/paragraph fallback) across span boundaries, draw one union
 * box per page, and reveal the first box. A miss restores the previous scroll position instead
 * of leaving the reader at the last lazy-loaded page.
 */
export async function highlightDocxQuote(input: {
  quote?: string
  heading?: string
  paragraphText?: string
  /** Original viewer scrollTop to restore when nothing matched. */
  restoreScroll?: number
  /** Stable document key for the page-text cache. */
  docKey?: string
}): Promise<PdfHighlightResult> {
  ensureStyle()
  if (!await waitForPdfPreview()) return { status: 'missing' }
  const pageNumbers = await waitForPdfPageNumbers()
  if (pageNumbers.length === 0) return { status: 'missing' }
  const anchor = findPdfPage(pageNumbers[0] ?? 1)
  const scroller = anchor === undefined ? null : pdfScrollContainer(anchor)
  const savedScroll = input.restoreScroll ?? scroller?.scrollTop
  if (scroller !== null) scroller.style.overflowAnchor = 'none'
  const candidates = paragraphCandidates(input)
  const matches = await scanDocxPages(pageNumbers, candidates, 260, true, input.docKey)
  if (matches.length === 0) {
    if (scroller !== null && savedScroll !== undefined) scroller.scrollTop = savedScroll
    return { status: 'missing' }
  }
  const painted = paintChunkBoxes(matches, candidates)
  await nextFrame()
  if (painted.firstPage !== undefined) {
    if (!scrollToFirstBox(painted.firstPage)) scrollToPdfPage(painted.firstPage)
  }
  ensureBoxInViewport(painted.firstBox)
  return {
    status: painted.invalid ? 'invalid' : 'text',
    page: painted.firstPage === undefined ? undefined : Number(painted.firstPage.dataset.pdfPage),
    matches: matches.length,
    pageCount: painted.boxes.length,
    groups: painted.boxes.length,
  }
}

/**
 * Scan in plan order and stop at the first page that contains the chunk.
 *
 * The first box must not wait for continuation pages. Once the estimated page matches, the
 * overlay can land while the remaining window pages are read in the background.
 */
async function scanFirstMatchingPage(
  order: readonly number[],
  candidates: readonly string[],
  docKey: string | undefined,
  primaryTimeoutMs: number,
): Promise<ChunkParagraphMatch[]> {
  for (const [index, number] of order.entries()) {
    let page = findPdfPage(number)
    if (page === undefined) continue
    if (page.querySelectorAll('span').length === 0) {
      if (index !== 0) continue
      page = await ensurePageText(number, primaryTimeoutMs) ?? page
    }
    if (page.querySelectorAll('span').length === 0) continue
    const found = collectParagraphMatches(candidates, new Set([number]), docKey)
    if (found.length > 0) return found
  }
  return []
}

/**
 * Keep the provisional box inside the viewport while placeholders above the target page grow.
 *
 * The viewer mounts every page as a 3:4 block; as pages render, their real heights push the
 * target down and a scrollTop that was correct at paint time can leave the box a thousand pixels
 * below the viewport. This loop only recenters when the box is actually outside, and stops as
 * soon as the text layer exists (or the provisional overlay has been replaced).
 */
async function keepFloatingVisible(page: HTMLElement, floating: FloatingOverlay, timeoutMs = 4000): Promise<void> {
  const started = Date.now()
  const pageNumber = page.dataset.pdfPage ?? ''
  let stable = 0
  let corrections = 0
  while (Date.now() - started < timeoutMs) {
    const box = document.querySelector<HTMLElement>('[data-kb-citation-floating="true"][data-kb-citation-page="' + pageNumber + '"]')
    if (box === null) return
    floating.position()
    if (boxInScrollport(box)) {
      stable += 1
      if (page.querySelectorAll('span').length > 0 && stable >= 3) return
    } else if (corrections < 2) {
      // Two corrections cover the common placeholder-height shifts; after that the reader's
      // scroll wins over keeping the provisional box centered.
      corrections += 1
      scrollPdfPageIntoView(page)
      floating.position()
      stable = 0
    } else {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Mutable repaint target shared by the fast overlay and its DOM refinement. */
interface OverlayRepaint {
  current: () => void
}

/**
 * Keep one page's overlay present and visible while the viewer finishes a lazy render.
 *
 * React replaces the page surface's children during that render, which can delete a node appended
 * by a plugin. Repainting only when the overlay is missing keeps the first box on screen without
 * touching any other page. The loop stops once the text layer exists and the box has been stable
 * for three checks, or after the deadline.
 */
async function keepOverlay(page: HTMLElement, repaint: OverlayRepaint, timeoutMs = 4000): Promise<void> {
  const started = Date.now()
  let stable = 0
  while (Date.now() - started < timeoutMs) {
    const boxes = [...page.querySelectorAll<HTMLElement>('.' + BOX_CLASS)]
    if (boxes.length === 0) {
      repaint.current()
      stable = 0
      const first = page.querySelector<HTMLElement>('.' + BOX_CLASS)
      if (first !== null) scrollElementToCenter(first)
    } else if (boxInScrollport(boxes[0]!)) {
      stable += 1
      if (page.querySelectorAll('span').length > 0 && stable >= 3) return
    } else {
      scrollElementToCenter(boxes[0]!)
      stable = 0
    }
    await new Promise(resolve => setTimeout(resolve, 80))
  }
}

/**
 * Read pages whose text layer already exists, without scrolling or waiting.
 *
 * Continuation boxes are a nicety: once the first box has landed, visiting another page would
 * move the reader's viewport and contradict the "land and stop" contract.
 */
function scanRenderedPages(
  order: readonly number[],
  candidates: readonly string[],
  docKey: string | undefined,
): ChunkParagraphMatch[] {
  const matches: ChunkParagraphMatch[] = []
  const seen = new Set<HTMLElement>()
  let lastMatchedPage: number | undefined
  for (const number of order) {
    const page = findPdfPage(number)
    if (page === undefined || page.querySelectorAll('span').length === 0) continue
    const found = collectParagraphMatches(candidates, new Set([number]), docKey)
    for (const match of found) {
      if (seen.has(match.element)) continue
      seen.add(match.element)
      matches.push(match)
    }
    if (found.length > 0) lastMatchedPage = number
    if (lastMatchedPage !== undefined && number >= lastMatchedPage + 1) break
  }
  return matches
}

/**
 * Replace the fast PDF-text box with the viewer's own text-layer geometry once it renders.
 *
 * This runs after the citation has already landed: it never scrolls to another page, and it is
 * allowed to fail without changing what the reader sees.
 */
async function refineFastPath(input: {
  generation: number
  pageNumber: number
  plan: ChunkPagePlan
  candidates: readonly string[]
  floating: FloatingOverlay
  docKey?: string
  query?: string
  queryTerms?: readonly string[]
}): Promise<void> {
  const page = await ensurePageText(input.pageNumber, 7000)
  if (page === undefined || page.querySelectorAll('span').length === 0) return
  const matches = await scanTargetPages([input.pageNumber], input.candidates, input.docKey, 1200)
  if (matches.length === 0) return
  const repaint: OverlayRepaint = { current: () => { paintChunkBoxes(matches, input.candidates) } }
  paintChunkBoxes(matches, input.candidates)
  // If the precise union is already on screen, drop the provisional overlay at once: keeping both
  // for a few frames draws a second blue rectangle over the same page. Only a precise box that is
  // still offscreen keeps the fallback alive until it lands.
  const precise = page.querySelector<HTMLElement>('.' + BOX_CLASS)
  if (precise !== null && boxInScrollport(precise)) {
    input.floating.destroy()
  } else {
    void keepOverlay(page, repaint)
    // React can still replace the page surface once during the lazy render, and a gap is what
    // makes a click look like it did nothing.
    void (async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 80))
        const boxes = [...page.querySelectorAll<HTMLElement>('.' + BOX_CLASS)]
        if (boxes.length > 0 && boxes.some(box => boxInScrollport(box))) {
          input.floating.destroy()
          return
        }
      }
    })()
  }
  markCitationTiming('fast-refined', `${String(matches.length)} matches`)
  if (input.query !== undefined && input.query.trim() !== '') {
    paintAmberHits(input.query, input.queryTerms, [page])
  }
  void stabilizeFirstBox(page.querySelector<HTMLElement>('.' + BOX_CLASS) ?? undefined, 420)
  const continuation = input.plan.window.filter(number => number > input.pageNumber)
  if (continuation.length > 0) {
    const extra = scanRenderedPages(continuation, input.candidates, input.docKey)
    if (extra.length > 0) {
      const seen = new Set(matches.map(match => match.element))
      const merged = [...matches, ...extra.filter(match => !seen.has(match.element))]
      repaint.current = () => { paintChunkBoxes(merged, input.candidates) }
      paintChunkBoxes(merged, input.candidates)
    }
  }
  // The precise union can open on a page just above the provisional one. Bring the first
  // (reading-order) box back into view; otherwise the box exists while the reader sees the
  // page below it and reports "no highlight".
  const firstBox = document.querySelector<HTMLElement>('.' + BOX_CLASS)
  if (firstBox !== null && !boxInScrollport(firstBox)) scrollElementToCenter(firstBox)
  if (input.query !== undefined && input.query.trim() !== '') {
    const pages = boxPageElements()
    const target = pages.length > 0 ? pages : [page]
    const drawn = paintAmberHits(input.query, input.queryTerms, target)
    if (drawn === 0) {
      scheduleAmberRetry({
        generation: input.generation, query: input.query,
        ...(input.queryTerms === undefined ? {} : { queryTerms: input.queryTerms }),
        pages: target,
      })
    } else {
      scheduleAmberRefresh({
        generation: input.generation, query: input.query,
        ...(input.queryTerms === undefined ? {} : { queryTerms: input.queryTerms }),
        pages: target,
      })
    }
  }
}

/**
 * Draw every paragraph of a chunk and reveal its first box.
 *
 * Fast path: chunk ordinal → a three-page window (`estimate+1`, `estimate`, `estimate+2`). One
 * scroll materializes the estimated page; the scan waits for that page's lazy text layer, paints
 * the union boxes and stops. Amber query hits are drawn after the box is landed, from the box's
 * own page, so they can never steal the viewport or add another full-document scan to the critical
 * path. The remaining pages are a correctness fallback only, and a second click for the same
 * chunk jumps straight to the page the first click confirmed.
 *
 * A docx chunk carries no page number, which is why the old `[1, 2]` default silently missed
 * every later chunk and the quote fallback scrolled all 19 pages before landing on the last one.
 */
export async function highlightDocxChunk(input: {
  quote?: string
  heading?: string
  paragraphText?: string
  chunkText?: string
  paragraphs?: readonly { text: string; ordinal?: number; page?: number }[]
  pages?: readonly number[]
  query?: string
  queryTerms?: readonly string[]
  /** Document-local chunk index, used only to choose a first page window. */
  chunkOrdinal?: number
  /** Stable document key for the page-text cache; the citation path or `doc:<id>`. */
  docKey?: string
  /** Stable chunk key for the confirmed-page cache. */
  chunkKey?: string
}): Promise<PdfHighlightResult> {
  ensureStyle()
  // A new citation replaces the previous overlay; leaving an old floating box behind would
  // point at the previous chunk while the new one loads.
  for (const old of document.querySelectorAll('.' + BOX_CLASS)) old.remove()
  clearQueryHits()
  const generation = ++activeCitation
  const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now()
  markCitationTiming('docx-start', `ordinal=${String(input.chunkOrdinal ?? '-')}`)
  // Office→PDF conversion can keep the document-preview on「文档渲染中」for well over ten
  // seconds on a cold click. Giving up at eight seconds is what made a real click show the
  // document but no box at all: the page shells appeared just after the deadline.
  if (!await waitForPdfPreview(20000)) return { status: 'missing' }
  markCitationTiming('pdf-preview', `+${String(Math.round((typeof performance === 'undefined' ? Date.now() : performance.now()) - startedAt))}ms`)
  const pageNumbers = await waitForPdfPageNumbers()
  if (pageNumbers.length === 0) return { status: 'missing' }
  markCitationTiming('pages-shells', `${String(pageNumbers.length)} pages`)
  const hinted = [...new Set([
    ...(input.pages ?? []),
    ...(input.paragraphs ?? []).flatMap(paragraph => paragraph.page === undefined ? [] : [paragraph.page]),
  ])].filter(page => Number.isInteger(page) && pageNumbers.includes(page))
  const candidates = paragraphCandidates(input)
  if (candidates.length === 0) return { status: 'missing' }
  const searchCandidates = candidates
  const confirmed = hinted.length === 0 ? cachedChunkPage(input.docKey, input.chunkKey) : undefined
  const plan: ChunkPagePlan = hinted.length > 0
    ? { primary: hinted, window: hinted, rest: [] }
    : planChunkPageWindow(pageNumbers, input.chunkOrdinal, confirmed)
  markCitationTiming('page-plan', `primary=${plan.primary.join(',')} window=${plan.window.join(',')} confirmed=${String(confirmed ?? '-')}`)

  // Fast path: the page shell exists before its canvas/text layer. Ask the PDF document the
  // viewer already holds for the page's text items, paint the normalized union immediately, and
  // refine against the DOM text layer once the viewer finishes rendering. A viewer without the
  // React fiber or a stalled worker returns undefined and the normal path below runs unchanged.
  const fastPage = hinted.length === 0 && input.chunkOrdinal !== undefined ? plan.primary[0] : undefined
  if (fastPage !== undefined) {
    const fastBoxes = await fastPdfTextBoxes(fastPage, searchCandidates)
    const fastElement = fastPage === undefined ? undefined : findPdfPage(fastPage)
    if (fastBoxes !== undefined && fastElement !== undefined) {
      const floating = renderFloatingPageBoxes(fastElement, fastBoxes)
      markCitationTiming('fast-painted', `${String(fastBoxes.length)} boxes`)
      scrollPdfPageIntoView(fastElement)
      floating.position()
      void keepFloatingVisible(fastElement, floating)
      rememberChunkPage(input.docKey, input.chunkKey, fastPage)
      markCitationTiming('first-box-visible', 'fast')
      void refineFastPath({
        generation,
        pageNumber: fastPage,
        plan,
        candidates: searchCandidates,
        floating,
        ...(input.docKey === undefined ? {} : { docKey: input.docKey }),
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.queryTerms === undefined ? {} : { queryTerms: input.queryTerms }),
      })
      return { status: 'text', page: fastPage, matches: 1, pageCount: fastBoxes.length, groups: fastBoxes.length }
    }
  }

  const anchor = findPdfPage(plan.primary[0] ?? pageNumbers[0] ?? 1)
  const scroller = anchor === undefined ? null : pdfScrollContainer(anchor)
  const savedScroll = scroller?.scrollTop
  if (scroller !== null) scroller.style.overflowAnchor = 'none'

  let matches: ChunkParagraphMatch[] = []
  const ordinalFastPath = hinted.length === 0 && input.chunkOrdinal !== undefined
  if (plan.primary.length > 0) {
    await materializeTargetPages(plan.primary, confirmed === undefined ? 2600 : 900)
    // A citation token carries an ordinal: land the first page immediately and add continuation
    // boxes after the landing. A caller that supplies paragraph pages without an ordinal is
    // asking for the complete multi-page union in one result, so it keeps the full window scan.
    matches = ordinalFastPath
      ? await scanFirstMatchingPage(plan.primary, searchCandidates, input.docKey, 2600)
      : await scanTargetPages(plan.primary, searchCandidates, input.docKey, 2600)
    markCitationTiming('primary-scan', `${String(matches.length)} matches`)
  }
  if (matches.length === 0) {
    const untriedWindow = plan.window.filter(page => !plan.primary.includes(page))
    if (untriedWindow.length > 0) {
      matches = await scanTargetPages(untriedWindow, searchCandidates, input.docKey, 700)
      markCitationTiming('window-scan', `${String(matches.length)} matches on ${untriedWindow.join(',')}`)
    }
  }
  if (matches.length === 0 && plan.rest.length > 0) {
    // Correctness fallback: a wrong ordinal must not hide a real chunk. This path scrolls the
    // document like the old implementation, and is reached only after the fast window missed.
    matches = await scanDocxPages(plan.rest, candidates, 450, true, input.docKey)
    markCitationTiming('fallback-scan', `${String(matches.length)} matches`)
  }
  if (matches.length > 0) {
    // Paint once from current span geometry, then land immediately. A second paint before the
    // scroll used to add a frame of latency without changing what the reader sees.
    const painted = paintChunkBoxes(matches, candidates)
    markCitationTiming('painted', `${String(painted.boxes.length)} boxes`)
    if (painted.firstPage !== undefined) {
      if (!scrollToFirstBox(painted.firstPage)) scrollToPdfPage(painted.firstPage)
      const page = Number(painted.firstPage.dataset.pdfPage)
      rememberChunkPage(input.docKey, input.chunkKey, page)
    }
    markCitationTiming('land-start')
    // Land synchronously: the scroll and one visibility check happen before the browser paints
    // the box, so the reader never sees an offscreen overlay. A bounded background pass only
    // repairs the box if a placeholder page above it changes height afterwards.
    ensureBoxInViewport(painted.firstBox)
    markCitationTiming('first-box-visible', 'immediate')
    void stabilizeFirstBox(painted.firstBox, 420, () => paintChunkBoxes(matches, candidates).firstBox)
      .then(landed => { markCitationTiming('landed', landed ? 'visible' : 'offscreen') })
    // Continuation boxes (a chunk that crosses a page break) are read after the first box has
    // landed. They never move the viewport and cannot delay the citation target.
    // Only pages after the anchor are continuation. A page above it holds the chunk's earlier
    // text but painting it adds a second union the reader is not looking at.
    const anchorPage = painted.firstPage === undefined ? undefined : Number(painted.firstPage.dataset.pdfPage)
    const continuation = ordinalFastPath && anchorPage !== undefined
      ? plan.window.filter(page => page > anchorPage)
      : []
    if (continuation.length > 0) {
      scheduleIdle(() => {
        void scanTargetPages(continuation, searchCandidates, input.docKey, 500).then(extra => {
          if (extra.length === 0) return
          const seen = new Set(matches.map(match => match.element))
          const merged = [...matches, ...extra.filter(match => !seen.has(match.element))]
          if (merged.length > matches.length) matches = merged
          paintChunkBoxes(merged, candidates)
        })
      })
    }
    // The chunk box is the citation target. Amber query hits are secondary: paint on the pages
    // that actually carry the blue union, then fall back to other rendered pages only when the
    // chunk page has no term at all.
    if (input.query !== undefined && input.query.trim() !== '') {
      const pages = boxPageElements()
      const preferred = pages.length > 0 ? pages : (painted.firstPage === undefined ? [] : [painted.firstPage])
      const drawn = paintAmberHits(input.query, input.queryTerms, preferred)
      recordCitationDebug('amber', { drawn, pages: pages.map(page => Number(page.dataset.pdfPage)), query: input.query.slice(0, 120), queryTerms: input.queryTerms ?? [] })
      if (drawn === 0) {
        scheduleAmberRetry({
          generation, query: input.query,
          ...(input.queryTerms === undefined ? {} : { queryTerms: input.queryTerms }),
          pages: preferred,
        })
      } else {
        scheduleAmberRefresh({
          generation, query: input.query,
          ...(input.queryTerms === undefined ? {} : { queryTerms: input.queryTerms }),
          pages: preferred,
        })
      }
    }
    return {
      status: painted.invalid ? 'invalid' : 'text',
      page: painted.firstPage === undefined ? undefined : Number(painted.firstPage.dataset.pdfPage),
      matches: matches.length,
      pageCount: painted.boxes.length,
      groups: painted.boxes.length,
    }
  }
  if (scroller !== null && savedScroll !== undefined) scroller.scrollTop = savedScroll
  return highlightDocxQuote({
    ...input,
    ...(savedScroll === undefined ? {} : { restoreScroll: savedScroll }),
  })
}

/** Run a cheap background task without competing with the first paint. */
function scheduleIdle(task: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => task(), { timeout: 500 })
  else setTimeout(task, 0)
}
