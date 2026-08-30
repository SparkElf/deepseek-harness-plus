/** Browser Settings section for the two shipped settings-backed delegation entries. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SubagentSettingsSection, type SubagentSettingsSectionInjected } from './SubagentCard.tsx'
import { SubagentSettingsStore, type SubagentSettingsValue } from './subagent-store.ts'
import { en, zh, type SubagentSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Product copy for the Subagent Settings section. */
    'settings.subagents': SubagentSettingsLocaleKey
  }
}

const NS = 'settings.subagents'

/** Required browser services. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Mount the dedicated Subagents Settings section.
 * @param ctx - Browser plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plus-subagent-settings: dictionaries')
  const settings = new SubagentSettingsStore({
    subagent: ctx.settingsScope.bind<SubagentSettingsValue>({ namespace: 'subagent' }),
    'subagent-fork': ctx.settingsScope.bind<SubagentSettingsValue>({ namespace: 'subagent-fork' }),
  })
  const injected = (): SubagentSettingsSectionInjected => ({
    hooks: { subagentSettings: settings.store },
    ensure: () => { settings.ensure() },
    stage: (entry, value) => { settings.stage(entry, value) },
    save: entry => settings.save(entry),
    reset: (entry) => { settings.reset(entry) },
    discard: (entry) => { settings.discard(entry) },
  })
  ctx.effect(() => () => { settings.dispose() }, 'plus-subagent-settings: settings scopes')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'subagents', order: 15, label: () => t('nav'), locale: NS, inject: injected,
  }, SubagentSettingsSection))
}
