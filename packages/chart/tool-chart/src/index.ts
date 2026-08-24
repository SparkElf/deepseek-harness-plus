/** Model-facing interactive chart tool. @module @deepseek-ai/dsh-tool-chart */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { ChartPresentationMeta, RenderChartArgs, RenderChartResult } from './types.ts'

export type { ChartPresentationMeta, RenderChartArgs, RenderChartResult } from './types.ts'

/** Cordis plugin name. */
export const name = 'tool-chart'
/** Tool registry required by this Consumer. */
export const inject = ['tools']

/** Normalize the small human/provenance fields while preserving the option exactly. */
function normalizeArgs(args: RenderChartArgs): RenderChartResult {
  const sourceResultRef = args.sourceResultRef.trim()
  if (sourceResultRef.length === 0) throw new Error('sourceResultRef must be a non-empty string')
  const title = args.title?.trim()
  return {
    rendered: true,
    sourceResultRef,
    ...(title === undefined || title.length === 0 ? {} : { title }),
  }
}

/** Build the durable replay projection from validated input plus its compact canonical result. */
export function chartPresentationMeta(args: RenderChartArgs, value: RenderChartResult): JsonValue {
  const meta: ChartPresentationMeta = {
    version: 1,
    sourceResultRef: value.sourceResultRef,
    option: args.option,
    ...(value.title === undefined ? {} : { title: value.title }),
  }
  return meta as unknown as JsonValue
}

/** Register `render_chart`; Web presentation is owned by `dsh-client-ui-chart`. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'render_chart',
    description: 'Render one interactive chart from a complete JSON-serializable ECharts option prepared from exactly one chart-ready resultRef. If execute_sql returned only a preview and that preview has more rows, read the result pages needed for the complete chart before building the option. The option must contain all chart data required for durable replay. Use DataOps SQL to produce the right business granularity; Code Mode may perform visualization-oriented mapping, reshape, derived statistics, and annotation before this call.',
    parameters: {
      sourceResultRef: {
        type: 'string',
        required: true,
        description: 'The single opaque resultRef whose chart-ready data was used to prepare this chart. It is provenance, not the replay data source.',
      },
      option: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: 'Complete JSON-serializable ECharts option. Include every result row required by the intended chart, not merely an incomplete query preview, plus the dataset/series data needed to render the chart again from session history.',
      },
      title: {
        type: 'string',
        description: 'Optional short human-facing title for the chart card.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rendered: { type: 'boolean', const: true, required: true },
          sourceResultRef: { type: 'string', required: true },
          title: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.title === undefined
          ? `Rendered interactive chart from ${value.sourceResultRef}.`
          : `Rendered interactive chart “${value.title}” from ${value.sourceResultRef}.`,
      }],
      presentationMeta: (args, value) => chartPresentationMeta(args, value),
    },
    isConcurrencySafe: () => true,
    execute(args) {
      return Promise.resolve(normalizeArgs(args))
    },
    presentCall: args => ({
      card: 'generic',
      title: args.title?.trim() || 'Render interactive chart',
      kind: 'other',
      rawInput: { sourceResultRef: args.sourceResultRef },
    }),
  }))
}
