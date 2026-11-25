// @ts-nocheck
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { VscLock } from 'react-icons/vsc'
import { CredentialsPane } from './CredentialsPane.tsx'
import { I18nProvider, translate } from './i18n.tsx'

const TAB_ID = '@sparkelf/dsh-credential-manager'
const TAB_KIND = 'credential-manager'

export const inject = ['slots', 'sidebarRightTabs', 'conversation', 'sessions', 'locale']

export function apply(ctx: Context): void {
  const Body = (props: PropsRuntime<'sidebar.right.pane.tab'>) => {
    const { tab } = props.useTabInfo()
    return <I18nProvider ctx={ctx}><CredentialsPane visible={tab.visible} /></I18nProvider>
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => translate(ctx, 'tab.credentials'),
    guide: [{
      id: 'credential-manager.guide',
      order: 48,
      title: () => translate(ctx, 'tab.credentials'),
      description: () => translate(ctx, 'app.subtitle'),
      icon: VscLock,
    }],
  }), 'credential-manager: right Sidebar type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_ID },
    Body,
  )), 'credential-manager: right Sidebar body')
}