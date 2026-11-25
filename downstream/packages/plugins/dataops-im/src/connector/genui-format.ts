/**
 * `dsh-ui` GenUI spec 的结构化读取与纯文本降级。
 *
 * 企微不渲染 GenUI，渲染策略需要先判断「这段 spec 是否值得截图」以及截图失败时如何
 * 用可读文本兜底。这里只做与 HTML 无关的解析/遍历/文本化，保持纯函数，便于单测。
 *
 * @module connector/genui-format
 */

/** 未知字段保留在节点上，读取时按需收窄，不因上游新增字段而丢弃整个卡片。 */
export type GenUiNode = Record<string, unknown> & { type?: unknown }

/** 一个可渲染的 GenUI spec。 */
export interface GenUiSpec {
  readonly title?: string
  readonly gap?: number
  readonly items: readonly GenUiNode[]
}

const MAX_NODES = 400

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 解析围栏内容；非法 JSON 或形状不符返回 undefined。 */
export function parseGenUiSpec(raw: string): GenUiSpec | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (Array.isArray(parsed)) {
    const items = parsed.filter((item): item is GenUiNode => recordOf(item) !== undefined)
    return items.length === 0 ? undefined : { items }
  }
  const record = recordOf(parsed)
  if (record === undefined) return undefined
  const rawItems = record.items
  const items = Array.isArray(rawItems)
    ? rawItems.filter((item): item is GenUiNode => recordOf(item) !== undefined)
    : []
  if (items.length === 0) return undefined
  return {
    ...(stringOf(record.title) === '' ? {} : { title: stringOf(record.title) }),
    ...(numberOf(record.gap) === undefined ? {} : { gap: numberOf(record.gap) as number }),
    items,
  }
}

/** 深度优先遍历所有节点（有上限，避免恶意/超大 spec 拖垮进程）。 */
export function collectGenUiNodes(spec: GenUiSpec): GenUiNode[] {
  const out: GenUiNode[] = []
  const visit = (node: GenUiNode): void => {
    if (out.length >= MAX_NODES) return
    out.push(node)
    for (const child of childNodes(node)) visit(child)
  }
  for (const item of spec.items) visit(item)
  return out
}

function childNodes(node: GenUiNode): GenUiNode[] {
  const out: GenUiNode[] = []
  const push = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const item of value) {
      const record = recordOf(item)
      if (record !== undefined) out.push(record as GenUiNode)
    }
  }
  push(node.items)
  for (const tab of Array.isArray(node.tabs) ? node.tabs : []) {
    const record = recordOf(tab)
    if (record !== undefined) push(record.items)
  }
  return out
}

/** 实际渲染的子组件（tabs 的 items 已展开）。 */
export function childComponentNodes(node: GenUiNode): GenUiNode[] {
  return childNodes(node)
}

/** 一张表格的数据形状。 */
export interface GenUiTable {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly rowCount: number
  readonly columnCount: number
}

function cellText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return ''
  const record = recordOf(value)
  if (record !== undefined) {
    return stringOf(record.text) || stringOf(record.label) || stringOf(record.value) || JSON.stringify(record)
  }
  return String(value)
}

/** 读取表格；columns 缺失时按第一行宽度补列名。 */
export function readGenUiTable(node: GenUiNode): GenUiTable {
  const columns = Array.isArray(node.columns) ? node.columns.map(cellText) : []
  const rows = Array.isArray(node.rows)
    ? node.rows.filter((row): row is unknown[] => Array.isArray(row)).map(row => row.map(cellText))
    : []
  const columnCount = Math.max(columns.length, ...rows.map(row => row.length), 0)
  const normalizedColumns = Array.from({ length: columnCount }, (_value, index) => columns[index] ?? `列${String(index + 1)}`)
  return {
    columns: normalizedColumns,
    rows,
    rowCount: rows.length,
    columnCount,
  }
}

/** 设计 §3 的大表格阈值：>8 行或 >4 列。 */
export function isLargeTable(table: GenUiTable): boolean {
  return table.rowCount > 8 || table.columnCount > 4
}

/** spec 内是否含大表格（任一 table 节点）。 */
export function hasLargeTable(spec: GenUiSpec): boolean {
  return collectGenUiNodes(spec).some(node => node.type === 'table' && isLargeTable(readGenUiTable(node)))
}

/** 需要图片呈现的组件类型；纯文本组件不强行截图。 */
const IMAGE_TYPES = new Set([
  'chart',
  'echart',
  'svg',
  'mermaid',
  'diagram',
  'compare',
  'timeline',
  'scene3d',
])

const VISUAL_TYPES = new Set([
  'chart',
  'echart',
  'stat',
  'progress',
  'table',
  'callout',
  'svg',
  'diagram',
  'mermaid',
  'compare',
  'timeline',
])

const LAYOUT_TYPES = new Set(['grid', 'row', 'col', 'card', 'hero', 'tabs', 'accordion', 'carousel', 'blocks'])

/**
 * 是否值得走 HTML→PNG。
 *
 * 图表/可视化卡片直接上图；≥8 个节点且同时有布局容器和可视化叶子时视为 dashboard。
 * 普通 list/callout/keyvalue/steps 保持文本，避免「一句话配一张大图」。
 */
export function isImageWorthy(spec: GenUiSpec): boolean {
  const nodes = collectGenUiNodes(spec)
  if (nodes.some(node => typeof node.type === 'string' && IMAGE_TYPES.has(node.type))) return true
  if (nodes.length < 8) return false
  const hasLayout = nodes.some(node => typeof node.type === 'string' && LAYOUT_TYPES.has(node.type))
  const hasVisual = nodes.some(node => typeof node.type === 'string' && VISUAL_TYPES.has(node.type))
  return hasLayout && hasVisual
}

function toneLabel(tone: unknown): string {
  switch (tone) {
    case 'success': return '完成'
    case 'warning': return '注意'
    case 'danger':
    case 'error': return '风险'
    case 'info': return '提示'
    default: return '提示'
  }
}

function listItemText(item: unknown): string {
  if (typeof item === 'string') return item
  const record = recordOf(item)
  if (record === undefined) return ''
  const title = stringOf(record.title) || stringOf(record.label) || stringOf(record.name)
  const desc = stringOf(record.desc) || stringOf(record.description) || stringOf(record.content) || stringOf(record.text)
  if (title !== '' && desc !== '') return `${title}：${desc}`
  return title || desc
}

function kvPairs(node: GenUiNode): string[] {
  const pairs = Array.isArray(node.pairs) ? node.pairs : []
  return pairs.flatMap((pair) => {
    const record = recordOf(pair)
    if (record === undefined) return []
    const key = stringOf(record.key)
    const value = cellText(record.value)
    return key === '' && value === '' ? [] : [`${key}：${value}`]
  })
}

function renderChildren(node: GenUiNode, depth: number): string {
  return childComponentNodes(node)
    .map(child => renderNode(child, depth + 1))
    .filter(text => text !== '')
    .join('\n\n')
}

function renderNode(node: GenUiNode, depth: number): string {
  if (depth > 8) return ''
  const type = stringOf(node.type)
  const title = stringOf(node.title)
  switch (type) {
    case 'text': {
      const content = stringOf(node.content)
      return content
    }
    case 'list': {
      const items = Array.isArray(node.items) ? node.items : []
      const lines = items.map(item => listItemText(item)).filter(line => line !== '')
      return lines.map(line => `• ${line}`).join('\n')
    }
    case 'keyvalue':
      return kvPairs(node).join('\n')
    case 'callout': {
      const content = stringOf(node.content)
      const heading = title === '' ? '' : `${title}\n`
      return `【${toneLabel(node.tone)}】\n${heading}${content}`.trim()
    }
    case 'steps': {
      const steps = Array.isArray(node.steps) ? node.steps : []
      return steps.flatMap((step, index) => {
        const record = recordOf(step)
        if (record === undefined) return []
        const stepTitle = stringOf(record.title) || `第 ${String(index + 1)} 步`
        const desc = stringOf(record.desc) || stringOf(record.description)
        return [desc === '' ? `${String(index + 1)}. ${stepTitle}` : `${String(index + 1)}. ${stepTitle}：${desc}`]
      }).join('\n')
    }
    case 'table': {
      const table = readGenUiTable(node)
      const heading = title === '' ? '' : `${title}\n`
      if (isLargeTable(table)) return `${heading}${largeTableSummary(node)}`
      const lines = table.rows.slice(0, 8).map((row, index) => {
        const pairs = table.columns
          .map((column, columnIndex) => `${column}：${row[columnIndex] ?? ''}`)
          .join('；')
        return `${String(index + 1)}. ${pairs}`
      })
      return `${heading}${lines.join('\n')}`.trim()
    }
    case 'stat': {
      const label = stringOf(node.label)
      const value = cellText(node.value)
      const delta = stringOf(node.delta)
      return `${label}：${value}${delta === '' ? '' : `（${delta}）`}`
    }
    case 'badge': {
      const label = stringOf(node.label)
      return label === '' ? '' : `【${label}】`
    }
    case 'progress': {
      const label = stringOf(node.label) || '进度'
      const value = numberOf(node.value)
      return value === undefined ? label : `${label}：${String(Math.round(value))}%`
    }
    case 'divider':
      return stringOf(node.label) === '' ? '———' : `——— ${stringOf(node.label)} ———`
    case 'card':
    case 'col':
    case 'row':
    case 'grid':
    case 'carousel':
    case 'accordion': {
      const children = renderChildren(node, depth)
      if (title === '') return children
      return `${title}\n${children}`.trim()
    }
    case 'hero': {
      const value = cellText(node.value)
      const subtitle = stringOf(node.subtitle)
      const label = stringOf(node.label)
      return [title, value, label, subtitle].filter(part => part !== '').join('\n')
    }
    case 'timeline': {
      const items = Array.isArray(node.items) ? node.items : []
      return items.flatMap((item) => {
        const record = recordOf(item)
        if (record === undefined) return []
        const time = stringOf(record.time)
        const itemTitle = stringOf(record.title)
        const desc = stringOf(record.desc)
        const head = [time, itemTitle].filter(part => part !== '').join(' ')
        return [desc === '' ? head : `${head}：${desc}`].filter(line => line !== '')
      }).join('\n')
    }
    case 'tabs': {
      const tabs = Array.isArray(node.tabs) ? node.tabs : []
      return tabs.flatMap((tab) => {
        const record = recordOf(tab)
        if (record === undefined) return []
        const label = stringOf(record.label)
        const items = Array.isArray(record.items)
          ? record.items.filter((item): item is GenUiNode => recordOf(item) !== undefined)
          : []
        const body = items.map(item => renderNode(item, depth + 1)).filter(text => text !== '').join('\n')
        return [`【${label}】`, body].filter(part => part !== '')
      }).join('\n\n')
    }
    case 'code': {
      const lang = stringOf(node.lang)
      const code = stringOf(node.code)
      return code === '' ? '' : `\`\`\`${lang}\n${code}\n\`\`\``
    }
    case 'json': {
      try {
        return JSON.stringify(node.value, undefined, 2)
      } catch {
        return ''
      }
    }
    case 'diff': {
      const diffs = Array.isArray(node.diffs) ? node.diffs : []
      return diffs.flatMap((diff) => {
        const record = recordOf(diff)
        if (record === undefined) return []
        const path = stringOf(record.path)
        const oldText = stringOf(record.oldText)
        const newText = stringOf(record.newText)
        return [
          path,
          ...oldText.split('\n').filter(line => line !== '').map(line => `- ${line}`),
          ...newText.split('\n').filter(line => line !== '').map(line => `+ ${line}`),
        ].filter(part => part !== '')
      }).join('\n')
    }
    case 'file-tree': return renderFileTree(node)
    case 'breadcrumb': {
      const items = Array.isArray(node.items) ? node.items.map(cellText) : []
      return items.join(' / ')
    }
    case 'image': {
      const alt = stringOf(node.alt) || stringOf(node.caption) || '图片'
      return `[图片] ${alt}`
    }
    case 'image-group': {
      const items = Array.isArray(node.items) ? node.items : []
      const alts = items.flatMap((item) => {
        const record = recordOf(item)
        return record === undefined ? [] : [stringOf(record.alt) || stringOf(record.caption) || '图片']
      })
      return alts.map(alt => `[图片] ${alt}`).join('\n')
    }
    case 'compare': {
      const before = recordOf(node.before)
      const after = recordOf(node.after)
      const beforeLabel = before === undefined ? '改动前' : stringOf(before.label) || '改动前'
      const afterLabel = after === undefined ? '改动后' : stringOf(after.label) || '改动后'
      return `[图片对比] ${beforeLabel} → ${afterLabel}`
    }
    case 'audio':
    case 'video': {
      const alt = stringOf(node.alt) || (type === 'audio' ? '音频' : '视频')
      return `[${type === 'audio' ? '音频' : '视频'}] ${alt}`
    }
    case 'chart':
    case 'echart': return chartSummary(node)
    case 'svg': return stringOf(node.title) === '' ? '[SVG 图形]' : `[SVG 图形] ${stringOf(node.title)}`
    case 'mermaid':
    case 'diagram': {
      const heading = title === '' ? '' : `${title}\n`
      const code = stringOf(node.code)
      return `${heading}${code === '' ? '[图形]' : code}`.trim()
    }
    case 'scene3d': return `[3D 场景] ${title}（请在万相查看）`
    case 'button':
    case 'input':
    case 'select':
    case 'checkbox':
    case 'radio':
    case 'switch':
    case 'slider':
    case 'textarea':
    case 'submit':
    case 'quiz':
      return '（该内容为可交互卡片，请在万相查看。）'
    default: {
      const content = stringOf(node.content)
      if (content !== '') return content
      const children = renderChildren(node, depth)
      return children
    }
  }
}

function renderFileTree(node: GenUiNode): string {
  const items = Array.isArray(node.items) ? node.items : []
  const lines: string[] = []
  const visit = (entries: unknown[], prefix: string, depth: number): void => {
    if (depth > 6) return
    for (const entry of entries) {
      const record = recordOf(entry)
      if (record === undefined) continue
      const name = stringOf(record.name) || stringOf(record.label)
      if (name === '') continue
      const isDir = record.type === 'dir'
      lines.push(`${prefix}${isDir ? '📁' : '📄'} ${name}`)
      if (Array.isArray(record.children)) visit(record.children, `${prefix}  `, depth + 1)
    }
  }
  visit(items, '', 0)
  return lines.join('\n')
}

function seriesPoints(node: GenUiNode): { label: string; value: number }[] {
  const points: { label: string; value: number }[] = []
  const pushData = (data: unknown): void => {
    if (!Array.isArray(data)) return
    for (const item of data) {
      const record = recordOf(item)
      if (record === undefined) continue
      const value = numberOf(record.value)
      if (value === undefined) continue
      points.push({ label: stringOf(record.label) || `#${String(points.length + 1)}`, value })
    }
  }
  pushData(node.data)
  const series = Array.isArray(node.series) ? node.series : []
  for (const item of series) {
    const record = recordOf(item)
    if (record !== undefined) pushData(record.data)
  }
  return points
}

/** 图表的可读摘要（无图时使用；也是图片 alt 的来源）。 */
export function chartSummary(node: GenUiNode): string {
  const title = stringOf(node.title) || '图表'
  const kind = stringOf(node.kind) || stringOf(node.preset) || stringOf(node.type) || 'chart'
  const points = seriesPoints(node)
  const head = `【${title}】${kind}`
  if (points.length === 0) return `${head}（完整图表请在万相查看）`
  const shown = points.slice(0, 8).map(point => `${point.label} ${formatNumber(point.value)}`).join('、')
  const suffix = points.length > 8 ? ` 等 ${String(points.length)} 项` : ''
  return `${head}：${shown}${suffix}（完整图表请在万相查看）`
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

/** 大表格只给摘要 + 附件建议，不整表转文本。 */
export function largeTableSummary(node: GenUiNode): string {
  const table = readGenUiTable(node)
  const title = stringOf(node.title) || '表格'
  const preview = table.rows.slice(0, 3).map((row, index) => {
    const pairs = table.columns
      .map((column, columnIndex) => `${column} ${row[columnIndex] ?? ''}`.trim())
      .join('；')
    return `${String(index + 1)}. ${pairs}`
  })
  const lines = [
    `【${title}】共 ${String(table.rowCount)} 行 × ${String(table.columnCount)} 列，内容较大，仅展示摘要。`,
    ...(preview.length === 0 ? [] : ['前 3 行：', ...preview]),
    '完整表格请在万相查看，或导出 CSV/Excel 附件。',
  ]
  return lines.join('\n')
}

/** spec 的纯文本表示；绝不回显原始 JSON。 */
export function specToText(spec: GenUiSpec): string {
  const blocks: string[] = []
  if (spec.title !== undefined && spec.title !== '') blocks.push(spec.title)
  for (const item of spec.items) {
    const text = renderNode(item, 0)
    if (text !== '') blocks.push(text)
  }
  return blocks.join('\n\n')
}

/** 图片替代文本：标题 + 结构化摘要，供读屏和图片发送失败时兜底。 */
export function specToAltText(spec: GenUiSpec): string {
  const title = spec.title?.trim() || '万相 GenUI 卡片'
  const text = specToText(spec).replace(/\s+/gu, ' ').trim()
  const clipped = text.length > 160 ? `${text.slice(0, 160)}…` : text
  return clipped === '' ? title : `${title}：${clipped}`
}