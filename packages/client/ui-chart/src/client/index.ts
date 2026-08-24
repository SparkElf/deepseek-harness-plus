/** Browser registration for the interactive `render_chart` tool view. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ChartRow } from './ChartRow.tsx'
import { en, NS, zh } from './locales.ts'

/** Client services required before the keyed chart renderer can register. */
export const inject = ['slots', 'locale']

/**
 * Register localized copy and the keyed chart tool row.
 * @param ctx - Browser Cordis context carrying slots and locale services.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-chart: dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'render_chart',
    locale: NS,
  }, ChartRow))
}
