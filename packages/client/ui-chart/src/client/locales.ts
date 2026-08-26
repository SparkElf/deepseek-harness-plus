/** Interactive chart browser UI dictionaries. */

export const NS = 'chart'

/** Simplified Chinese chart UI copy. */
export const zh = {
  'row.title': '交互式图表',
  'state.rendering': '正在生成图表…',
  'state.failed': '图表生成失败',
  'state.unavailable': '图表数据不可用',
  'action.inspect': '查看详情',
  'chart.aria': '交互式数据图表',
} satisfies Record<string, string>

/** Translation keys owned by the chart UI namespace. */
export type ChartKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    chart: ChartKey
  }
}

/** English chart UI copy. */
export const en = {
  'row.title': 'Interactive chart',
  'state.rendering': 'Rendering chart…',
  'state.failed': 'Chart rendering failed',
  'state.unavailable': 'Chart data is unavailable',
  'action.inspect': 'Inspect',
  'chart.aria': 'Interactive data chart',
} satisfies Record<ChartKey, string>
