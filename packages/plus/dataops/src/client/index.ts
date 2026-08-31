import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { DataOpsController } from './controller.ts'
import type { DataOpsClientInjected } from './contract.ts'
import { DataOpsExpiryModal } from './DataOpsExpiryModal.tsx'
import { DataOpsSection } from './DataOpsSection.tsx'
import { en, zh, type DataOpsKey } from './locales.ts'
import { createDataOpsStore, type DataOpsActions } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.dataops': DataOpsKey
  }
}

const NS = 'settings.dataops'

/** Client services required for Host activation discovery, Settings, and frame overlays. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory']

/** 仅在Host inventory确认对应plugin有效启用时注册browser contributions。 */
export async function apply(ctx: Context): Promise<void> {
  const result = await ctx.remote.pluginInventory.list()
  if (!result.ok) {
    throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
  }
  const active = result.value.entries.some(entry => entry.entryId === 'plus-dataops' && entry.enabled)
  if (!active) return

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-dataops: Client copy')
  const t = ctx.locale.bind(NS) as DataOpsClientInjected['t']
  const store = createDataOpsStore()
  const controller = new DataOpsController()
  const injectFace = (actions: DataOpsActions): DataOpsClientInjected => {
    controller.attach(actions)
    return {
      t,
      start: () => controller.start(),
      reload: () => { void controller.load() },
      openAuthorization: () => { controller.openAuthorization() },
      disconnect: () => controller.disconnect(),
    }
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dataops',
    order: 25,
    label: () => t('nav'),
    store,
    inject: injectFace,
  }, DataOpsSection))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dataops-authorization',
    order: 25,
    store,
    inject: injectFace,
  }, DataOpsExpiryModal))
}
