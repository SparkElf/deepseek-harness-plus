/**
 * kb-citation browser half: one source panel above each answer.
 *
 * The panel is a Conversation Definition, not a composer dock. It opens at a Turn's first step,
 * folds every assistant message in that Turn into one deduplicated citation list, and materializes
 * as a Chat node whose anchor sequence sorts before the assistant row. Deliverables keep their
 * later turn-tail anchor, so the order is sources → answer → deliverables.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { KbSourcesNodeView, kbSourcesDefinition } from './kb-sources.tsx'
import { inlineCitationResolver, wrapCitationMentions } from './compose.ts'
import { citationFromClickTarget, installCitationLinkNormalizer, isInvalidCitationTarget } from './link-label.ts'
import { absoluteFileAddress, sessionFileAddress } from './resource-address.ts'
import { applyCitationView, isOfficeDocumentPath, resolveOpenTarget, waitForDocumentTab } from './citation-view.ts'
import { markCitationTiming } from './timing.ts'

/** Required client services: the conversation event engine owns node lifecycles. */
export const inject = ['slots', 'uiConversation', 'sidebarRight', 'chatFileMentions', 'sessions']

/** Register the Turn source Definition and its keyed Chat renderer. */
export function apply(ctx: ClientContext): (() => void) | void {
  ctx.uiConversation.events.register(kbSourcesDefinition as never)
  // A GenUI artifact can render its 打开原文 button after the Turn's source panel settles, and a
  // Turn with no parsed citation has no source panel at all. Own the late-rendered case here so
  // label rewriting never depends on another component being mounted.
  const disposeInlineLinks = installCitationLinkNormalizer(document)
  const openDocument = (sessionId: string, path: string): boolean => {
    const sidebar = ctx.get('sidebarRight') as { openResource?: (address: string) => void } | undefined
    if (sidebar?.openResource === undefined) return false
    sidebar.openResource(sessionFileAddress(sessionId, path))
    return true
  }
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'kb-sources',
    inject: () => ({ openDocument }),
  }, KbSourcesNodeView as never))
  // Wrap the host-owned provider, never provide a second one. Inline links use the same
  // resolveOpenTarget chain as the source panel, including Office document tabs and chunk boxes.
  const mentions = ctx.get('chatFileMentions') as Parameters<typeof wrapCitationMentions>[0] | undefined
  let disposeMentions: (() => void) | undefined
  if (mentions !== undefined) {
    disposeMentions = wrapCitationMentions(mentions, inlineCitationResolver({
      openFile: () => {},
      openDocument,
    }))
  }
  // Markdown local links are rendered by ui-primitives `MarkdownFileLink`, which calls Chat's
  // `openFile` directly and does not consult chatFileMentions. Catch that click before React's
  // handler, resolve the KB path through the same chain, and open the Office document tab.
  const onClick = (event: MouseEvent): void => {
    // A chip whose line no longer maps to a chunk must not fall through to the host's native
    // `.docx.md` opener; swallow the click so it cannot open the wrong page.
    if (isInvalidCitationTarget(event.target)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    // GenUI rewrites land after render; this helper reads `data-kb-citation-token` first so the
    // click stays pinned to the chunk token even when the visible label/title were rewritten.
    const citation = citationFromClickTarget(event.target)
    if (citation === undefined) return
    event.preventDefault()
    event.stopImmediatePropagation()
    void (async () => {
      markCitationTiming('click')
      const resolved = await resolveOpenTarget(citation)
      if (resolved === undefined) return
      markCitationTiming('resolved', resolved.path)
      const sidebar = ctx.get('sidebarRight') as { openResource?: (address: string) => void } | undefined
      if (sidebar?.openResource === undefined) return
      const sessions = ctx.get('sessions') as { list?: { getSnapshot: () => { byId: Record<string, { retainedBy?: { mainView?: number } }> } } } | undefined
      const byId = sessions?.list?.getSnapshot().byId ?? {}
      const current = Object.entries(byId).find(([, value]) => (value.retainedBy?.mainView ?? 0) > 0)?.[0]
      sidebar.openResource(current === undefined ? absoluteFileAddress(resolved.path) : sessionFileAddress(current, resolved.path))
      markCitationTiming('resource-open')
      if (isOfficeDocumentPath(resolved.path)) await waitForDocumentTab(resolved.path)
      await applyCitationView(resolved.citation, resolved.options)
      markCitationTiming('apply-done')
    })()
  }
  document.addEventListener('click', onClick, true)
  return () => {
    document.removeEventListener('click', onClick, true)
    disposeMentions?.()
    disposeInlineLinks()
  }
}
