/** Host-lifetime Settings section owner for one Subagent tool configuration. */
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { SubagentSettings } from './index.ts'
import { SUBAGENT_SETTINGS_SCHEMA, settingsFromConfig, validateSettings } from './index.ts'

export const name = 'tool-subagent-settings'
export const inject = ['subagents']

/** Host-owned Settings registration configuration. */
export interface Config extends SubagentSettings {
  /** Unique Settings namespace consumed by Agent-scoped tool instances. */
  settingsNamespace: string
  /** Subagent provider whose capabilities validate user-owned defaults. */
  provider: string
}

export const Config = z.intersect([
  z.object({
    settingsNamespace: z.string().required(),
    provider: z.string().required(),
  }),
  SUBAGENT_SETTINGS_SCHEMA,
]) as z<Config>

/** Register one Subagent settings namespace at Host lifetime.
 * @param ctx - Host plugin context carrying Settings and Subagent services.
 * @param config - namespace, provider, and composition defaults.
 */
export function apply(ctx: Context, config: Config): void {
  const namespace = settingsNamespace(config.settingsNamespace)
  const base = settingsFromConfig(config)
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(namespace, SUBAGENT_SETTINGS_SCHEMA, {
      base,
      validate: (value) => { validateSettings(value, ctx.subagents.getProvider(config.provider)) },
    })
  })
}
