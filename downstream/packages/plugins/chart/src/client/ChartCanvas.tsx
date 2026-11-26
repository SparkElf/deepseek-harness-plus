/** ECharts lifecycle wrapper for one durable JSON option. */

import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import type { ECharts, EChartsOption } from 'echarts'
import css from './ChartRow.module.css'

function isDarkTheme(): boolean {
  return document.body.hasAttribute('data-ds-dark-theme')
}

/** Render one option and keep its canvas sized and themed with the Harness shell. */
export function ChartCanvas({
  option,
  ariaLabel,
  errorLabel,
}: {
  option: Record<string, unknown>
  ariaLabel: string
  errorLabel: string
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    let chart: ECharts | undefined
    let dark = isDarkTheme()

    const mount = () => {
      chart = echarts.init(root, dark ? 'dark' : undefined)
      chart.setOption(option as EChartsOption, { notMerge: true, lazyUpdate: false })
    }

    const render = () => {
      try {
        setFailed(false)
        mount()
      } catch (error) {
        console.error('dsh-chart: ECharts render failed', error)
        chart?.dispose()
        chart = undefined
        setFailed(true)
      }
    }

    render()

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
          render()
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
      {failed && <div className={css.canvasError} role="alert">{errorLabel}</div>}
    </div>
  )
}
