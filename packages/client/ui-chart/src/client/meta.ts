/** Durable metadata contract consumed from `render_chart` tool results. */

export interface ChartPresentationMeta {
  version: 1
  sourceResultRef: string
  option: Record<string, unknown>
  title?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow live or replayed opaque tool metadata to the chart presentation shape. */
export function chartMetaFromUnknown(value: unknown): ChartPresentationMeta | undefined {
  if (!isRecord(value)) return undefined
  const { version, sourceResultRef, option, title } = value
  if (version !== 1 || typeof sourceResultRef !== 'string' || sourceResultRef.length === 0) return undefined
  if (!isRecord(option)) return undefined
  if (title !== undefined && typeof title !== 'string') return undefined
  return {
    version: 1,
    sourceResultRef,
    option,
    ...(title === undefined ? {} : { title }),
  }
}
