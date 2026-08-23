/** ECharts lifecycle wrapper for one durable JSON option. */

import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import type { ECharts, EChartsOption } from 'echarts'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import css from './ChartRow.module.css'

function isDarkTheme(): boolean {
  return document.body.hasAttribute('data-ds-dark-theme')
}

/** Render one option and keep its canvas sized and themed with the Harness shell. */
export function ChartCanvas({ option, ariaLabel }: { option: JsonValue; ariaLabel: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    let chart: ECharts | undefined
    let dark = isDarkTheme()

    const mount = () => {
      chart = echarts.init(root, dark ? 'dark' : undefined)
      chart.setOption(option as unknown as EChartsOption, { notMerge: true, lazyUpdate: false })
    }

    try {
      setError(null)
      mount()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => { chart?.resize() })
    resizeObserver?.observe(root)

    const themeObserver = typeof MutationObserver === 'undefined'
      ? undefined
      : new MutationObserver(() => {
          const nextDark = isDarkTheme()
          if (nextDark === dark) return
          dark = nextDark
          chart?.dispose()
          chart = undefined
          try {
            setError(null)
            mount()
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          }
        })
    themeObserver?.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })

    return () => {
      resizeObserver?.disconnect()
      themeObserver?.disconnect()
      chart?.dispose()
    }
  }, [option])

  return (
    <div className={css.canvasWrap}>
      <div ref={rootRef} className={css.canvas} role="img" aria-label={ariaLabel} />
      {error !== null && <div className={css.canvasError} role="alert">{error}</div>}
    </div>
  )
}
