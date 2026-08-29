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

/**
 * Narrow live or replayed opaque tool metadata to chart presentation data.
 * @param value - Opaque direct tool metadata.
 * @returns Valid chart presentation data, or undefined when the metadata is not a chart.
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
    option,
    ...(title === undefined ? {} : { title }),
  }
}

/**
 * Read the chart payload appended to a nested Code Mode dispatch result.
 * @param value - Opaque durable result content.
 * @returns Valid chart presentation data, or undefined when no chart block exists.
 */
export function chartMetaFromContent(value: unknown): ChartPresentationMeta | undefined {
  if (!Array.isArray(value)) return undefined
  for (const block of value) {
    if (!isRecord(block) || block.type !== 'dsh/chart') continue
    const meta = chartMetaFromUnknown(block.meta)
    if (meta !== undefined) return meta
  }
  return undefined
}
