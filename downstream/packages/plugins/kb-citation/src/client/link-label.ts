/**
 * Render-layer label cleanup for inline Markdown file links.
 *
 * The model may cite the derived `.docx.md`/`.xlsx.md` and include a `:line` suffix. The click
 * target must stay the original Office file, but the visible label should read like the source
 * document. This post-processes already-rendered buttons and observes new messages. Rewriting a
 * GenUI title strips its `< >` wrapper, while the original kb token moves to
 * `data-kb-citation-token`; the click delegate reads that token before the display path.
 */
import { isTextDocumentPath, originalOfficePath, parseCitationToken } from '../shared/citation.ts'
import { citationTokenForChunk, fetchChunkGroups, fetchResolve } from './citation-view.ts'

const ordinalCache = new Map<string, number | null>()
const tokenCache = new Map<string, string | null>()
const kbLabelCache = new Map<string, string | null>()

/** Drop label/resolve caches, for tests or after an index rebuild. */
export function clearLabelCaches(): void {
  ordinalCache.clear()
  tokenCache.clear()
  kbLabelCache.clear()
}

/** Mark a chip whose cited line no longer belongs to any chunk. */
function markInvalid(button: HTMLElement): void {
  button.dataset.kbCitationInvalid = 'true'
  delete button.dataset.kbCitationToken
  button.setAttribute('aria-disabled', 'true')
  applyLabel(button, '引用已失效')
}

/** Whether the click landed on a chip whose citation could not be verified. */
export function isInvalidCitationTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest<HTMLElement>('[data-kb-citation-invalid="true"]') !== null
}

/**
 * One KB citation token as the index emits it: `kb://doc/<docId>/chunk/<chunkKey>`.
 *
 * A chunk key is not always numeric. Current indexes mint a 16-character SHA-1 prefix
 * (`e63b7f9eda2d86cb`), so a `\d+` matcher silently misses every modern GenUI citation.
 * Doc ids and chunk keys are both URL-safe tokens; punctuation outside the token is never
 * part of `match[0]`.
 */
const KB_TOKEN_SOURCE = String.raw`kb:\/\/doc\/[A-Za-z0-9._~-]+\/chunk\/[A-Za-z0-9._~-]+(?:\?[^\s)\x60"'<>，。；：、！？]*)?`

/** Selectors that own assistant-rendered content. User prompt rows are deliberately absent. */
export const CITATION_LINK_ROOT_SELECTOR = '[data-chat-flow-kind="assistant-step"], [data-genui-artifact], [data-genui="true"], [data-slot="tool.call.toolview"], [data-tool]'

/**
 * A streaming markdown block renders an unfinished inline-code token as plain text. Parsing
 * that prefix as a citation creates a permanent `引用已失效` chip beside the finished token,
 * so every normalizer skips streaming subtrees and lets the settled render do the rewrite.
 */
const STREAMING_SELECTOR = '[data-streaming="true"]'
const isStreaming = (element: Element | null): boolean => element?.closest(STREAMING_SELECTOR) != null

/** Selector for every clickable citation carrier, including the legacy GenUI button class. */
export const CITATION_LINK_SELECTOR = [
  'button[class*="fileLink"]', 'a[class*="fileLink"]',
  // Inline-code mentions render as `button.fileMention`; without this selector a bare
  // `kb://…` token stayed visible even though the source panel already knew its file.
  'button[class*="fileMention"]', 'a[class*="fileMention"]',
  'button[class*="inlineFileLink"]', 'a[class*="inlineFileLink"]',
  'button[data-kb-inline-filelink]', '[data-kb-inline-filelink]',
  'a[href*="kb://doc/"]', 'button[title*="kb://doc/"]',
  '[data-href*="kb://doc/"]', '[data-file-link*="kb://doc/"]',
  '[data-kb-citation-token]',
].join(', ')

/** True when a link path is a local KB file rather than an external URL. */
export function isLocalFileLink(value: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('file://')
}

/** Display label: source basename plus a chunk/segment marker when the link carries one. */
export function sourceLabelForLink(value: string, chunkId?: string, line?: number, chunkOrdinal?: number): string | undefined {
  if (!isLocalFileLink(value)) return undefined
  const parsed = parseCitationToken(value)
  chunkId ??= parsed?.chunkId
  line ??= parsed?.line
  chunkOrdinal ??= parsed?.chunkOrdinal
  const bare = value.replace(/^file:\/\//i, '').replace(/[?#].*$/, '').replace(/:\d+$/, '')
  const original = originalOfficePath(bare)
  const name = original.split('/').filter(Boolean).pop()
  if (name === undefined || name === '') return undefined
  const source = originalOfficePath(bare)
  // Chunk identity wins: a token is rendered as `文件名:第N块` even for a text source.
  // The raw chunk key is an implementation detail and is never shown.
  if (chunkOrdinal !== undefined) return name + ':第' + String(chunkOrdinal + 1) + '块'
  if (chunkId !== undefined && chunkId !== '') return name
  if (isTextDocumentPath(source) && line !== undefined) return name + ':第' + String(line) + '行'
  return name
}

/** The raw citation value carried by a rendered file link (button title or anchor href). */
export function fileLinkValue(element: Element): string | undefined {
  const token = element instanceof HTMLElement ? element.dataset.kbCitationToken : undefined
  if (token === undefined || token === '') {
    const source = element instanceof HTMLElement ? element.dataset.kbSourceValue : undefined
    if (source !== undefined && source !== '') return source
  }
  if (token !== undefined && token !== '') return token
  const title = element.getAttribute('title')?.trim()
  if (title !== undefined && title !== '') return title
  const href = element.getAttribute('href')?.trim()
  if (href !== undefined && href !== '') return href
  // Some host-rendered fileLink buttons carry neither title nor href; their visible text is
  // the only target. Accept only path-shaped text, never an already-normalized display label.
  const text = (element.textContent ?? '').trim()
  if (/^kb\//.test(text)) return '/workspace/kb/' + text.slice(3)
  if (/^workspace\/kb\//.test(text)) return '/workspace/' + text
  if (/^\/workspace\/kb\//.test(text)) return text
  if (/^global\//.test(text)) return '/workspace/kb/' + text
  return undefined
}

/** Legacy GenUI inline file links keep the token in a text sibling, not in the button. */
export function normalizeInlineFileLinks(root: ParentNode): number {
  const tokenPattern = new RegExp(KB_TOKEN_SOURCE)
  let changed = 0
  for (const button of root.querySelectorAll<HTMLElement>('button[class*="inlineFileLink"], button[class*="InlineFileLink"], [data-kb-inline-filelink]')) {
    if (isStreaming(button)) continue
    if (button.dataset.kbCitationToken !== undefined) continue
    const rawTitle = (button.getAttribute('title') ?? '').trim()
    // GenUI writes the source path as `<path>`; the click target must carry the bare path.
    const sourcePath = rawTitle.replace(/^[<\s]+|[>\s]+$/g, '')
    let token: string | undefined
    let tokenNode: Text | undefined
    for (let node = button.nextSibling; node !== null; node = node.nextSibling) {
      if (node.nodeType !== Node.TEXT_NODE) continue
      const match = tokenPattern.exec(node.textContent ?? '')
      if (match !== null) { token = match[0]; tokenNode = node as Text; break }
    }
    if (token === undefined) continue
    button.dataset.kbInlineFilelink = 'true'
    button.dataset.kbCitationToken = token
    button.title = sourcePath
    // Show the file name immediately; the chunk fetch below upgrades it to `:第N块`.
    const fallback = sourceLabelForLink(sourcePath)
    if (fallback !== undefined) button.dataset.kbFallbackLabel = fallback
    applyLabel(button, fallback ?? 'KB 引用')
    if (tokenNode !== undefined) {
      const remove = new RegExp(String.raw`\s*(?:·\s*)?<?${KB_TOKEN_SOURCE}>?`, 'g')
      tokenNode.data = tokenNode.data.replace(remove, '')
    }
    changed += 1
  }
  return changed
}

/** GenUI cards render "打开原文 · kb://…" as plain text; turn only that pattern into anchors. */
export function normalizeOpeningLinks(root: ParentNode): number {
  const pattern = new RegExp(String.raw`(打开原文\s*·\s*)(${KB_TOKEN_SOURCE})`, 'g')
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text
    if (!text.data.includes('打开原文')) continue
    if (isStreaming(text.parentElement)) continue
    if (text.parentElement?.closest('pre, a, button') !== null) continue
    targets.push(text)
  }
  let changed = 0
  for (const text of targets) {
    const value = text.data
    const fragment = document.createDocumentFragment()
    let cursor = 0
    pattern.lastIndex = 0
    for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
      if (match.index > cursor) fragment.appendChild(document.createTextNode(value.slice(cursor, match.index)))
      const anchor = document.createElement('a')
      anchor.href = match[2] ?? ''
      anchor.title = match[2] ?? ''
      anchor.className = 'kb-citation-inline'
      anchor.dataset.kbCitationInline = 'true'
      anchor.textContent = 'KB 引用'
      fragment.appendChild(anchor)
      cursor = match.index + match[0].length
      changed += 1
    }
    if (cursor === 0) continue
    if (cursor < value.length) fragment.appendChild(document.createTextNode(value.slice(cursor)))
    text.replaceWith(fragment)
  }
  return changed
}

/** Turn GenUI/action buttons whose visible label embeds a kb token into the same citation. */
export function normalizeInteractiveTokens(root: ParentNode): number {
  const pattern = new RegExp(KB_TOKEN_SOURCE)
  let changed = 0
  for (const element of root.querySelectorAll<HTMLElement>('button, a, [role="button"]')) {
    if (isStreaming(element)) continue
    if (element.getAttribute('data-kb-citation-token') !== null) continue
    if (element.querySelector('button, a') !== null) continue
    const text = element.textContent ?? ''
    const match = pattern.exec(text)
    if (match === null) continue
    const token = match[0]
    element.dataset.kbCitationToken = token
    element.dataset.kbPrefix = text.slice(0, match.index)
    element.title = token
    element.classList.add('kb-citation-inline')
    element.textContent = element.dataset.kbPrefix + 'KB 引用'
    changed += 1
  }
  return changed
}

/**
 * Turn a bare `kb://doc/…/chunk/…` in assistant prose into a citation anchor.
 *
 * The model is told to write the token as inline code, but a plain token is still a valid
 * citation and must not stay as an unreadable URL. Only assistant/GenUI roots are scanned
 * by the caller, and links, buttons, inline code and fenced code are skipped.
 */
export function normalizeBareCitationText(root: ParentNode): number {
  if (typeof document === 'undefined') return 0
  const pattern = new RegExp(KB_TOKEN_SOURCE, 'g')
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text
    if (!text.data.includes('kb://doc/')) continue
    if (isStreaming(text.parentElement)) continue
    if (text.parentElement?.closest('a, button, code, pre, script, style, textarea') != null) continue
    targets.push(text)
  }
  let changed = 0
  for (const text of targets) {
    const value = text.data
    const fragment = document.createDocumentFragment()
    let cursor = 0
    pattern.lastIndex = 0
    for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
      if (match.index > cursor) fragment.appendChild(document.createTextNode(value.slice(cursor, match.index)))
      const anchor = document.createElement('a')
      anchor.href = match[0]
      anchor.title = match[0]
      anchor.className = 'kb-citation-inline'
      anchor.dataset.kbCitationToken = match[0]
      anchor.textContent = match[0]
      fragment.appendChild(anchor)
      cursor = match.index + match[0].length
      changed += 1
    }
    pattern.lastIndex = 0
    if (cursor === 0) continue
    if (cursor < value.length) fragment.appendChild(document.createTextNode(value.slice(cursor)))
    text.replaceWith(fragment)
  }
  return changed
}

/**
 * Convert an inline-code token that has no host-rendered fileMention into an anchor.
 *
 * `MarkdownText` only asks `chatFileMentions` to resolve inline code; when that service is
 * absent the token would stay inert. Fenced blocks are left alone.
 */
export function normalizeInlineCodeCitationTokens(root: ParentNode): number {
  if (typeof document === 'undefined') return 0
  const exact = new RegExp('^' + KB_TOKEN_SOURCE + '$')
  let changed = 0
  for (const code of root.querySelectorAll<HTMLElement>('code')) {
    if (isStreaming(code)) continue
    if (code.closest('pre') !== null || code.querySelector('a, button') !== null) continue
    const value = (code.textContent ?? '').trim()
    if (value === '' || parseCitationToken(value)?.kind !== 'kb' || !exact.test(value)) continue
    const anchor = document.createElement('a')
    anchor.href = value
    anchor.title = value
    anchor.className = 'kb-citation-inline'
    anchor.dataset.kbCitationToken = value
    anchor.textContent = value
    // Keep the host's `<code>` wrapper (React owns it); replace only its text with the
    // citation anchor so a settled answer stays stable across a re-render.
    code.textContent = ''
    code.appendChild(anchor)
    changed += 1
  }
  return changed
}

/** Replace the visible text of every rendered fileLink, preserving its icon and title. */
export function normalizeFileLinkLabels(root: ParentNode = document): number {
  normalizeInlineFileLinks(root)
  normalizeOpeningLinks(root)
  normalizeInteractiveTokens(root)
  normalizeBareCitationText(root)
  normalizeInlineCodeCitationTokens(root)
  let changed = 0
  for (const button of root.querySelectorAll<HTMLElement>(CITATION_LINK_SELECTOR)) {
    if (isStreaming(button)) continue
    const value = fileLinkValue(button)
    if (value === undefined) continue
    const parsed = parseCitationToken(value)
    if (parsed?.kind === 'kb' && parsed.docId !== undefined && parsed.chunkId !== undefined) {
      // Pin every KB chip to its token before any label rewrite; the click delegate then
      // resolves the same chunk even if the visible title is the original file path.
      if (button instanceof HTMLElement) button.dataset.kbCitationToken = value
      const cacheKey = parsed.docId + ':' + parsed.chunkId
      const cached = kbLabelCache.get(cacheKey)
      if (typeof cached === 'string') { applyLabel(button, cached); changed += 1; continue }
      if (cached === null) {
        if (parsed.path === undefined) markInvalid(button)
        continue
      }
      // A token may already carry the ordinal (a search hit or a resolved chip). In that
      // case there is nothing to fetch; render `文件名:第N块` synchronously.
      if (parsed.chunkOrdinal !== undefined && parsed.path !== undefined) {
        const label = sourceLabelForLink(parsed.path, parsed.chunkId, undefined, parsed.chunkOrdinal)
        if (label !== undefined) { applyLabel(button, label); changed += 1; continue }
      }
      // A token with a path has a readable fallback while the ordinal request is in
      // flight; a bare token shows the neutral label instead of a raw `kb://…` string.
      const fallback = parsed.path === undefined ? parsed.label : sourceLabelForLink(parsed.path, parsed.chunkId)
      if (fallback !== undefined) applyLabel(button, fallback)
      void fetchChunkGroups(parsed.docId, parsed.chunkId).then(chunk => {
        if (chunk?.path === undefined) {
          kbLabelCache.set(cacheKey, null)
          // A bare token has no fallback target; a path-bearing token can still open its
          // original file, so keep the filename rather than blocking the click.
          if (parsed.path === undefined) markInvalid(button)
          return
        }
        const label = sourceLabelForLink(chunk.path, chunk.chunkKey ?? chunk.chunkId, undefined, chunk.chunkOrdinal)
          ?? sourceLabelForLink(chunk.path)
          ?? chunk.path.split('/').pop()
        if (label === undefined) return
        kbLabelCache.set(cacheKey, label)
        applyLabel(button, label)
      })
      continue
    }
    if (button instanceof HTMLElement) {
      button.dataset.kbSourceValue = value
      // Hover title is user-visible; never keep the derived `.docx.md`/fragment spelling.
      button.title = originalOfficePath(parsed?.path ?? value)
    }
    const label = parsed?.path === undefined ? sourceLabelForLink(value, parsed?.chunkId, parsed?.line, parsed?.chunkOrdinal) : sourceLabelForLink(parsed.path, parsed?.chunkId, parsed?.line, parsed?.chunkOrdinal)
    if (label === undefined) continue
    if (button.dataset.kbSourceLabel !== label) {
      applyLabel(button, label)
      changed += 1
    }
    const source = parsed?.path === undefined ? undefined : originalOfficePath(parsed.path)
    if (parsed?.line !== undefined && parsed.chunkOrdinal === undefined && source !== undefined && !isTextDocumentPath(source)) {
      const key = (parsed.path ?? value) + ':' + String(parsed.line)
      const known = ordinalCache.get(key)
      if (known !== undefined) {
        if (known === null) { markInvalid(button); continue }
        const token = tokenCache.get(key)
        if (typeof token === 'string') {
          button.dataset.kbCitationToken = token
          delete button.dataset.kbCitationInvalid
          button.removeAttribute('aria-disabled')
        }
        applyLabel(button, label + ':第' + String(known + 1) + '块')
        continue
      }
      void fetchResolve(parsed.path ?? value, parsed.line).then(resolved => {
        if (resolved === undefined) {
          ordinalCache.set(key, null)
          tokenCache.set(key, null)
          markInvalid(button)
          return
        }
        const ordinal = resolved.chunkOrdinal
        const token = citationTokenForChunk(resolved)
        ordinalCache.set(key, ordinal ?? null)
        tokenCache.set(key, token ?? null)
        // Pin the click to the same chunk the label was derived from. Without this stamp the
        // click resolves the line again and can land on a different chunk after an index change.
        if (token !== undefined) {
          button.dataset.kbCitationToken = token
          delete button.dataset.kbCitationInvalid
          button.removeAttribute('aria-disabled')
        }
        applyLabel(button, ordinal === undefined ? label : label + ':第' + String(ordinal + 1) + '块')
      })
    }
  }
  return changed
}

/**
 * Normalize citations inside assistant-rendered roots, including GenUI cards.
 *
 * The scan is root-scoped on purpose: running `normalizeOpeningLinks` over the whole document
 * would turn a `打开原文 · kb://…` quoted in the user's prompt into a clickable anchor. Nested
 * roots (a GenUI artifact inside an assistant step) are deduplicated to their outermost element.
 *
 * @param root - document or an already-scoped assistant container.
 * @returns number of labels changed by the per-root normalizer.
 */
export function normalizeCitationLinks(root: ParentNode = document): number {
  const elementRoot = (root as Node).nodeType === Node.ELEMENT_NODE ? root as Element : null
  const roots: HTMLElement[] = []
  if (elementRoot?.matches(CITATION_LINK_ROOT_SELECTOR) === true) roots.push(elementRoot as HTMLElement)
  for (const element of root.querySelectorAll<HTMLElement>(CITATION_LINK_ROOT_SELECTOR)) roots.push(element)
  let changed = 0
  for (const candidate of roots) {
    if (roots.some(other => other !== candidate && other.contains(candidate))) continue
    changed += normalizeFileLinkLabels(candidate)
  }
  return changed
}

/**
 * Keep GenUI cards normalized as they render.
 *
 * A Turn's source panel is mounted only when assistant text carries a citation; a GenUI artifact
 * can introduce its `打开原文 · kb://…` button afterwards, or in a Turn with no source panel at
 * all. One document-level observer therefore owns the late-rendered case, while
 * `normalizeCitationLinks` keeps the scan limited to assistant/GenUI roots.
 *
 * @param doc - document whose body is observed.
 * @returns disposer that disconnects the observer and cancels a pending scan.
 */
export function installCitationLinkNormalizer(doc: Document = document): () => void {
  const dirty = new Set<HTMLElement>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    timer = undefined
    const pending = [...dirty].filter(root => ![...dirty].some(other => other !== root && other.contains(root)))
    dirty.clear()
    for (const root of pending) normalizeFileLinkLabels(root)
  }
  const schedule = (): void => {
    // Coalesce a render burst but do not let a long stream postpone the scan indefinitely.
    if (timer !== undefined) return
    timer = setTimeout(flush, 120)
  }
  const collect = (node: Node | null): void => {
    if (node === null) return
    if (node.nodeType !== Node.ELEMENT_NODE) {
      const root = node.parentElement?.closest<HTMLElement>(CITATION_LINK_ROOT_SELECTOR) ?? null
      if (root !== null) { dirty.add(root); schedule() }
      return
    }
    const element = node as Element
    const root = element.closest<HTMLElement>(CITATION_LINK_ROOT_SELECTOR)
    if (root !== null) {
      // The enclosing assistant/GenUI root will rescan this subtree; no need to look deeper.
      dirty.add(root)
      schedule()
      return
    }
    // A portal may mount the GenUI artifact as a descendant of an otherwise unmarked wrapper.
    for (const nested of element.querySelectorAll<HTMLElement>(CITATION_LINK_ROOT_SELECTOR)) {
      dirty.add(nested)
      schedule()
    }
  }
  normalizeCitationLinks(doc)
  if (typeof MutationObserver === 'undefined' || doc.body === null) {
    return () => { if (timer !== undefined) clearTimeout(timer) }
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') { collect(record.target); continue }
      for (const node of record.addedNodes) collect(node)
    }
  })
  observer.observe(doc.body, { childList: true, subtree: true, characterData: true })
  return () => {
    observer.disconnect()
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The citation a click on `target` would open.
 *
 * A normalized GenUI button carries its kb token in `data-kb-citation-token`, which
 * `fileLinkValue` prefers over the display path in `title`; that is what keeps the click routed
 * through the chunk endpoint after the label is rewritten.
 */
export function citationFromClickTarget(target: EventTarget | null): ReturnType<typeof parseCitationToken> {
  if (!(target instanceof Element)) return undefined
  const button = target.closest<HTMLElement>(CITATION_LINK_SELECTOR)
  if (button === null || button.dataset.kbCitationInvalid === 'true') return undefined
  const value = fileLinkValue(button)
  return value === undefined ? undefined : parseCitationToken(value)
}

/** The official Markdown file-link class names rendered by ui-primitives. */
const NATIVE_FILE_LINK_CLASS = /(?:^|_)(?:fileMention|fileLink)$/

/** Reuse the exact class names of a rendered official MarkdownFileLink when one is on screen. */
function nativeFileLinkClasses(root: ParentNode): string[] {
  const candidates = [...root.querySelectorAll<HTMLElement>('button[class*="fileLink"], a[class*="fileLink"]')]
  for (const element of candidates) {
    if (element.hasAttribute('data-kb-citation-token') || element.hasAttribute('data-kb-inline-filelink')) continue
    if (element.className.includes('inlineFileLink')) continue
    const names = [...element.classList].filter(name => NATIVE_FILE_LINK_CLASS.test(name))
    if (names.length > 0) return names
  }
  return []
}

/**
 * Native file-link styling.
 *
 * These rules mirror ui-primitives' MarkdownText.module.css `.markdown a, .fileLink`
 * (link-blue at 500 weight, no underline at rest, dotted underline on hover/focus) and its
 * `.linkIcon` metric. The only addition is the muted `:第N块` suffix; it is an atomic
 * inline-block so the parent's hover underline covers the filename, not the suffix.
 */
function ensureCitationChipStyle(): void {
  if (typeof document === 'undefined' || document.getElementById('kb-citation-chip-style') !== null) return
  const style = document.createElement('style')
  style.id = 'kb-citation-chip-style'
  style.textContent = `
    [data-kb-citation-token].kb-citation-file-link{margin:0;padding:0;border:0;background:none;
      font:inherit;font-weight:500;color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary,#2563eb));
      text-decoration:none;cursor:pointer;max-width:100%;text-align:inherit;position:relative;
      vertical-align:baseline}
    [data-kb-citation-token].kb-citation-file-link:hover,
    [data-kb-citation-token].kb-citation-file-link:focus{outline:none;
      text-decoration:underline dotted var(--dsw-alias-link,var(--dsw-alias-state-business-primary,#2563eb));
      text-underline-offset:3px}
    [data-kb-citation-token].kb-citation-file-link:focus-visible{
      box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2563eb));
      border-radius:3px}
    [data-kb-citation-token].kb-citation-file-link .kb-citation-file-link-icon{
      flex:none;width:1.1em;height:1.1em;vertical-align:-.25em;margin-right:5px}
    [data-kb-citation-token].kb-citation-file-link .kb-citation-filename{
      color:inherit;font-weight:inherit;text-decoration:inherit}
    [data-kb-citation-token].kb-citation-file-link .kb-citation-suffix{
      display:inline-block;margin-left:2px;color:var(--dsw-alias-label-tertiary,#98a2b3);
      font-weight:400;text-decoration:none}
  `
  document.head.appendChild(style)
}

type CitationGlyphKind = 'document' | 'other'

/** Same category decision as ui-primitives `classifyLinkPath`, reduced to its two glyphs. */
function citationGlyphKind(value: string): CitationGlyphKind {
  const path = value.replace(/^file:\/\//i, '').split(/[?#]/)[0]?.toLowerCase() ?? ''
  return /\.(docx?|xlsx?|pptx?|pdf)$/.test(path) ? 'document' : 'other'
}

/** Official `PaperDocGlyph` paths (LinkIconArtwork kind="document"). */
const DOCUMENT_GLYPH_PATHS = [
  'M3.51919 14.5069H12.4807C13.0679 14.5069 13.5438 14.031 13.5438 13.4438V5.97499C13.5438 5.68818 13.428 5.41352 13.2226 5.21341L9.71251 1.79459C9.51402 1.60124 9.24781 1.49304 8.97075 1.49304H3.51919C2.93204 1.49304 2.45605 1.96902 2.45605 2.55618V13.4438C2.45605 14.031 2.93203 14.5069 3.51919 14.5069Z',
  'M8.90454 1.6095V4.87091C8.90454 5.45806 9.38051 5.93405 9.96768 5.93405H13.4953',
  'M4.31152 8.7561H7.83046',
  'M4.31152 11.3651H9.36598',
] as const

/** Official `PaperGlyph` paths (LinkIconArtwork kind="other"). */
const OTHER_GLYPH_PATHS = [
  'M3.75275 14.271H12.2473C12.7749 14.271 13.2027 13.8433 13.2027 13.3156V5.91732C13.2027 5.65958 13.0985 5.41276 12.9139 5.23293L9.59477 2.00011C9.4164 1.82636 9.17717 1.72913 8.9282 1.72913H3.75275C3.22511 1.72913 2.79736 2.15686 2.79736 2.68451V13.3156C2.79736 13.8433 3.22511 14.271 3.75275 14.271Z',
  'M8.84888 1.83838V4.94133C8.84888 5.46896 9.2766 5.89671 9.80426 5.89671H13.157',
] as const

function citationIcon(kind: CitationGlyphKind): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('stroke-width', '1.3')
  svg.setAttribute('class', 'kb-citation-file-link-icon')
  svg.dataset.kbFileKind = kind
  for (const data of kind === 'document' ? DOCUMENT_GLYPH_PATHS : OTHER_GLYPH_PATHS) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', data)
    path.setAttribute('stroke', 'currentColor')
    svg.appendChild(path)
  }
  return svg
}

function renderCitationChip(button: HTMLElement, label: string, sourceValue: string): void {
  ensureCitationChipStyle()
  button.textContent = ''
  button.removeAttribute('style')
  // Prefer the official class list when the same card already rendered a MarkdownFileLink;
  // our own class carries the identical metrics as a standalone fallback.
  const native = nativeFileLinkClasses(button.ownerDocument)
  button.className = [...new Set(['kb-citation-file-link', 'kb-citation-inline', ...native])].join(' ')
  const suffixIndex = label.search(/:第\d+[块行]$/)
  const name = suffixIndex === -1 ? label : label.slice(0, suffixIndex)
  const suffix = suffixIndex === -1 ? '' : label.slice(suffixIndex)
  button.appendChild(citationIcon(citationGlyphKind(sourceValue)))
  const nameSpan = document.createElement('span')
  nameSpan.className = 'kb-citation-filename'
  nameSpan.textContent = name
  button.appendChild(nameSpan)
  if (suffix !== '') {
    const suffixSpan = document.createElement('span')
    suffixSpan.className = 'kb-citation-suffix'
    suffixSpan.textContent = suffix
    button.appendChild(suffixSpan)
  }
  button.dataset.kbSourceLabel = label
  button.setAttribute('aria-label', label)
}

function applyLabel(button: HTMLElement, label: string): void {
  if (button.dataset.kbSourceLabel === label) return
  if (button.dataset.kbInlineFilelink === 'true' || button.classList.contains('kb-citation-inline')) {
    renderCitationChip(button, label, button.title !== '' ? button.title : label)
    return
  }
  const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node as Text).data.trim() !== '') textNodes.push(node as Text)
  }
  for (const node of textNodes) node.data = ''
  button.appendChild(document.createTextNode((button.dataset.kbPrefix ?? '') + label))
  button.dataset.kbSourceLabel = label
  button.setAttribute('aria-label', (button.dataset.kbPrefix ?? '') + label)
}
