import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { VscCloud } from 'react-icons/vsc'
import { ApiClient } from './ApiClient.tsx'
import { I18nProvider, translate } from './i18n.tsx'

const TAB_ID = '@sparkelf/dsh-api-client'
const TAB_KIND = 'api-client'

export const inject = ['slots', 'sidebarRightTabs', 'conversation', 'sessions', 'locale']

export function apply(ctx: Context): void {
  const Body = (props: PropsRuntime<'sidebar.right.pane.tab'>) => {
    const { tab } = props.useTabInfo()
    return <I18nProvider ctx={ctx}><ApiClient ctx={ctx} sessionId={props.sessionId} visible={tab.visible} /></I18nProvider>
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => translate(ctx, 'tab.api'),
    guide: [{ id: 'api-client.guide', order: 47, title: () => translate(ctx, 'tab.api'), description: () => translate(ctx, 'tab.api'), icon: VscCloud }],
  }), 'api-client: right Sidebar type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_ID },
    Body,
  )), 'api-client: right Sidebar body')
}
