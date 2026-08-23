/** Shared JSON contracts for the interactive chart tool and its browser replay view. */

import type { JsonValue } from '@deepseek-ai/dsh-tools'

/** Model-facing arguments accepted by `render_chart`. */
export interface RenderChartArgs {
  /** Opaque provenance for the one chart-ready query result used to build the option. */
  sourceResultRef: string
  /** Complete JSON-serializable ECharts option, including the data required for replay. */
  option: JsonValue
  /** Optional human-facing card title. */
  title?: string
}

/** Durable UI projection stored on the tool result for history replay. */
export interface ChartPresentationMeta {
  version: 1
  sourceResultRef: string
  option: JsonValue
  title?: string
}

/** Canonical compact result returned to Code/Native callers. */
export interface RenderChartResult {
  rendered: true
  sourceResultRef: string
  title?: string
}

/** Whether an opaque value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Narrow live or replayed opaque tool metadata to the chart presentation shape.
 * A malformed historical value simply lets the browser card report that its chart data is unavailable.
 */
export function chartMetaFromUnknown(value: unknown): ChartPresentationMeta | undefined {
  if (!isRecord(value)) return undefined
  const { version, sourceResultRef, option, title } = value
  if (version !== 1 || typeof sourceResultRef !== 'string' || sourceResultRef.length === 0) return undefined
  if (!isRecord(option)) return undefined
  if (title !== undefined && typeof title !== 'string') return undefined
  return {
    version: 1,
    sourceResultRef,
    option: option as JsonValue,
    ...title === undefined ? {} : { title },
  }
}
