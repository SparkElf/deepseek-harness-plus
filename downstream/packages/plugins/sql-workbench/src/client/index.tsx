// @ts-nocheck
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { useEffect } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { VscDatabase } from 'react-icons/vsc'
import { setComposerSessionId } from './composerBridge.ts'
import { I18nProvider, translate } from './i18n.tsx'
import { SqlWorkbench } from './SqlWorkbench.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The session-scoped composer dock. A list seat: this contribution is invisible and
     * only learns which Session the composer belongs to.
     */
    'conversation.input.dock': {
      kind: 'list'
      scope: 'session'
      owner: {
        readonly session: { readonly sessionId?: unknown }
        readonly [key: string]: unknown
      }
    }
  }
}

/**
 * An invisible seat that records the composer's Session id.
 *
 * The right-Sidebar tab has a session id of its own, and `uiSession.current` is not
 * always the id `sessions.scope()` accepts. The dock is session-scoped and receives the
 * real one, so recording it here is what makes "Add to chat" reach the composer the
 * reader is actually looking at.
 */
function ComposerSessionBridge(props: { session?: { sessionId?: unknown } }): null {
  const sessionId = props.session?.sessionId
  useEffect(() => {
    setComposerSessionId(typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined)
  }, [sessionId])
  return null
}

const TAB_ID = 'dsh-sql-workbench'
const TAB_KIND = 'sql-workbench'

export const inject = ['slots', 'sidebarRightTabs', 'locale', 'uiSession', 'sessions', 'conversation']

/** Register the SQL workbench as an official right-Sidebar page type. */
export function apply(ctx: Context): void {
  const Body = (props: PropsRuntime<'sidebar.right.pane.tab'>) => {
    const { tab } = props.useTabInfo()
    return <I18nProvider ctx={ctx}><SqlWorkbench ctx={ctx} sessionId={props.sessionId} visible={tab.visible} /></I18nProvider>
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => translate(ctx, 'tab.database'),
    guide: [{ id: 'sql-workbench.guide', order: 45, title: () => translate(ctx, 'tab.database'), description: () => translate(ctx, 'tab.database'), icon: VscDatabase }],
  }), 'dsh-sql-workbench: right Sidebar type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_ID },
    Body,
  )), 'dsh-sql-workbench: right Sidebar body')
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'sql-workbench.composer-bridge',
  }, ComposerSessionBridge as never)), 'dsh-sql-workbench: composer session bridge')
}
