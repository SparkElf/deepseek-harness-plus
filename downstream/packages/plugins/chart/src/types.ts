/** JSON contracts owned by the SparkElf interactive chart plugin. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Model-facing arguments accepted by `render_chart`. */
export interface RenderChartArgs {
  /** Opaque provenance for the one chart-ready query result used to build the option. */
  sourceResultRef: string
  /** Complete JSON-serializable ECharts option, including the data required for replay. */
  option: JsonValue
  /** Optional human-facing card title. */
  title?: string
}

/** Durable presentation projection stored on the tool result for browser replay. */
export interface ChartPresentationMeta {
  version: 1
  sourceResultRef: string
  option: JsonValue
  title?: string
}

/** Durable chart payload used only by a nested Code Mode dispatch result. */
export interface ChartContentBlock {
  type: 'sparkelf/chart'
  meta: ChartPresentationMeta
}

declare module '@deepseek-ai/dsh-llm/types' {
  interface ContentBlockMap {
    'sparkelf/chart': ChartContentBlock
  }
}

/** Canonical compact result returned to Code/Native callers. */
export interface RenderChartResult {
  rendered: true
  sourceResultRef: string
  title?: string
}
