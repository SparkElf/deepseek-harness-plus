/**
 * Compose KB citation resolution with the single host-owned `chatFileMentions` service.
 *
 * `ui-deliverables` provides that service. Providing it again makes the whole plugin entry fail
 * to activate, so this module wraps the one object and restores the exact original function on
 * dispose. The byte-for-byte original method is kept, which also makes hot reload idempotent.
 */
import type { ChatFileMentions } from '@deepseek-ai/dsh-client-ui-chat/client'
import { originalOfficePath, parseCitationToken } from '../shared/citation.ts'
import { applyCitationView, isOfficeDocumentPath, resolveOpenTarget, waitForDocumentTab } from './citation-view.ts'
import { sourceLabelForLink } from './link-label.ts'
import { markCitationTiming } from './timing.ts'

/** The provider shape the Chat markdown renderer consumes. */
export type CitationMentionResolver = (value: string, owner: { openFile?: (path: string) => void }, sessionId?: string) => { open: () => void; label: string; title: string } | undefined

/** Services already wrapped; a hot reload must not add a second layer. */
const wrapped = new WeakSet<object>()

/**
 * Wrap the existing provider.
 *
 * @param service - the provider published by ui-deliverables.
 * @param resolveCitation - KB resolver tried before the delegate resolver.
 * @returns dispose that restores the original `forClosing`.
 */
export function wrapCitationMentions(service: ChatFileMentions, resolveCitation: CitationMentionResolver): () => void {
  if (wrapped.has(service as object)) return () => {}
  try {
    const descriptor = Object.getOwnPropertyDescriptor(service, 'forClosing') ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service) as object, 'forClosing')
    if (descriptor !== undefined && descriptor.writable === false && descriptor.set === undefined) return () => {}
  } catch { return () => {} }
  const original = service.forClosing
  try {
  service.forClosing = function (owner, sessionId) {
    const base = original.call(service, owner, sessionId)
    return {
      resolve(value: string) {
        return resolveCitation(value, owner, sessionId) ?? base?.resolve(value)
      },
    }
  }
  } catch {
    return () => {}
  }
  wrapped.add(service as object)
  return () => {
    service.forClosing = original
    wrapped.delete(service as object)
  }
}


/**
 * Build the inline Markdown-link resolver used by the Chat renderer.
 *
 * It is deliberately the same chain as the source panel: parse token → resolveOpenTarget
 * (canonical /workspace/kb path + chunk quote/boxes) → document tab for Office originals or
 * file tab otherwise → apply page/box/quote/sheet/line. A link label never keeps `.docx.md`
 * or `.xlsx.md`; it shows the source basename.
 */
export function inlineCitationResolver(options: {
  openFile: (path: string) => void
  openDocument?: (sessionId: string, path: string) => boolean
}): CitationMentionResolver {
  return (value, owner, sessionId) => {
    const citation = parseCitationToken(value)
    if (citation === undefined) return undefined
    const rawPath = citation.path === undefined ? undefined : originalOfficePath(citation.path)
    const label = rawPath === undefined
      ? citation.label
      : sourceLabelForLink(rawPath, citation.chunkId, undefined, citation.chunkOrdinal) ?? rawPath.split('/').pop() ?? citation.label
    return {
      open: () => {
        void (async () => {
          markCitationTiming('click')
          const resolved = await resolveOpenTarget(citation)
          if (resolved === undefined) return
          markCitationTiming('resolved', resolved.path)
          if (isOfficeDocumentPath(resolved.path) && sessionId !== undefined && options.openDocument?.(sessionId, resolved.path) === true) {
            // document-preview tab owns Office→PDF conversion
          } else {
            (owner.openFile ?? options.openFile)(resolved.path)
          }
          markCitationTiming('resource-open')
          if (isOfficeDocumentPath(resolved.path)) await waitForDocumentTab(resolved.path)
          await applyCitationView(resolved.citation, resolved.options)
          markCitationTiming('apply-done')
        })()
      },
      label,
      title: value,
    }
  }
}
