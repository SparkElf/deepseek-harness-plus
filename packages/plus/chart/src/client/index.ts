/** Browser registration for the interactive `render_chart` tool view. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ChartRow } from './ChartRow.tsx'
import { en, NS, zh } from './locales.ts'

export const inject = ['slots', 'locale']

/** Register localized copy and the keyed chart tool row. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-chart: dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'render_chart',
    locale: NS,
  }, ChartRow))
}
