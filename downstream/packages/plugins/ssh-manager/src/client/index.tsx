import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { VscRemoteExplorer } from 'react-icons/vsc'
import { SshManager } from './SshManager.tsx'
import { I18nProvider, translate } from './i18n.tsx'
import { installXtermStyles } from './xterm-styles.ts'

const TAB_ID = '@sparkelf/dsh-ssh-manager'
const TAB_KIND = 'ssh-manager'

export const inject = ['slots', 'sidebarRightTabs', 'conversation', 'sessions', 'locale']

export function apply(ctx: Context): void {
  installXtermStyles()
  const Body = (props: PropsRuntime<'sidebar.right.pane.tab'>) => {
    const { tab } = props.useTabInfo()
    return <I18nProvider ctx={ctx}><SshManager ctx={ctx} sessionId={props.sessionId} visible={tab.visible} /></I18nProvider>
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => translate(ctx, 'tab.ssh'),
    guide: [{ id: 'ssh-manager.guide', order: 46, title: () => translate(ctx, 'tab.ssh'), description: () => translate(ctx, 'tab.ssh'), icon: VscRemoteExplorer }],
  }), 'ssh-manager: right Sidebar type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_ID },
    Body,
  )), 'ssh-manager: right Sidebar body')
}
