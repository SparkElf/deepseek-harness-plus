/** Browser registration for the interactive `render_chart` tool view. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ChartRow } from './ChartRow.tsx'
import { en, NS, zh } from './locales.ts'

export { ChartCanvas } from './ChartCanvas.tsx'
export { ChartRow, type ChartRowProps } from './ChartRow.tsx'
export { chartMetaFromUnknown, type ChartPresentationMeta } from './meta.ts'
export { en, NS, zh, type ChartKey } from './locales.ts'

export const inject = ['slots', 'locale']

/** Register localized copy and the keyed chart tool row. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-chart: dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'render_chart',
    locale: NS,
  }, ChartRow))
}
