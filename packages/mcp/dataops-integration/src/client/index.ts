import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { DataOpsSection } from './DataOpsSection.tsx'
import type { DataOpsSectionInjected } from './DataOpsSection.tsx'
import { en, zh, type DataOpsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.dataops': DataOpsKey
  }
}

const NS = 'settings.dataops'

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-dataops: settings copy')
  const t = ctx.locale.bind(NS) as DataOpsSectionInjected['t']
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dataops',
    order: 25,
    label: () => t('nav'),
    inject: () => ({ t }),
  }, DataOpsSection))
}
