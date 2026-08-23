/** Keyed `render_chart` tool row with the chart as its primary completed content. */

import { IconInspectOutline12 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { ChartCanvas } from './ChartCanvas.tsx'
import { chartMetaFromUnknown } from './meta.ts'
import css from './ChartRow.module.css'

export type ChartRowProps = ToolCallViewProps & PropsLocale<'chart'>

/** Render pending, failed, or durable interactive chart state for one tool call. */
export function ChartRow({ block, inspect, t }: ChartRowProps) {
  const result = block.kind === 'tool-result' ? block : null
  const meta = result === null ? undefined : chartMetaFromUnknown(result.meta)
  const title = meta?.title ?? t('row.title')

  if (result === null) {
    return <div className={css.status} data-tool="render_chart">{t('state.rendering')}</div>
  }

  if (result.isError || meta === undefined) {
    return (
      <div className={css.statusCard} data-tool="render_chart" data-state="error">
        <span>{result.isError ? t('state.failed') : t('state.unavailable')}</span>
        {inspect !== undefined && (
          <button type="button" className={css.inspect} onClick={inspect} aria-label={t('action.inspect')}>
            <IconInspectOutline12 />
          </button>
        )}
      </div>
    )
  }

  return (
    <section className={css.card} data-tool="render_chart" data-state="ready">
      <header className={css.header}>
        <h3 className={css.title}>{title}</h3>
        {inspect !== undefined && (
          <button type="button" className={css.inspect} onClick={inspect} aria-label={t('action.inspect')}>
            <IconInspectOutline12 />
          </button>
        )}
      </header>
      <ChartCanvas option={meta.option} ariaLabel={meta.title ?? t('chart.aria')} />
    </section>
  )
}
