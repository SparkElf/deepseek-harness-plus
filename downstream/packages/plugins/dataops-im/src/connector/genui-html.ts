/**
 * GenUI spec → 独立 HTML（供 headless Chrome 截图）。
 *
 * 只覆盖企微投递常见组件：文本、列表、键值、提示、步骤、表格、指标、进度、卡片、
 * 图表（bars/line/donut）、SVG/Mermaid 占位和时间线。所有模型文本都经过 HTML 转义；
 * SVG 只接受 `<svg` 开头并剥离脚本/事件/外链，避免截图进程执行任意内容。
 *
 * @module connector/genui-html
 */

import {
  chartSummary,
  childComponentNodes,
  collectGenUiNodes,
  readGenUiTable,
  type GenUiNode,
  type GenUiSpec,
} from './genui-format.ts'

const MAX_NODES = 200

function esc(value: unknown): string {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function cellText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const record = recordOf(value)
  if (record !== undefined) {
    return stringOf(record.text) || stringOf(record.label) || stringOf(record.value) || ''
  }
  return ''
}

function withChildren(node: GenUiNode, depth: number): string {
  return childComponentNodes(node)
    .slice(0, 40)
    .map(child => renderNode(child, depth + 1))
    .filter(html => html !== '')
    .join('')
}

function renderList(node: GenUiNode): string {
  const items = Array.isArray(node.items) ? node.items : []
  const rows = items.flatMap((item) => {
    if (typeof item === 'string') return [`<li>${esc(item)}</li>`]
    const record = recordOf(item)
    if (record === undefined) return []
    const title = stringOf(record.title) || stringOf(record.label) || stringOf(record.name)
    const desc = stringOf(record.desc) || stringOf(record.description) || stringOf(record.content) || stringOf(record.text)
    if (title === '' && desc === '') return []
    return [desc === ''
      ? `<li><span class="li-title">${esc(title)}</span></li>`
      : `<li><span class="li-title">${esc(title)}</span><span class="li-desc">${esc(desc)}</span></li>`]
  })
  return `<ul class="list">${rows.join('')}</ul>`
}

function renderKeyValue(node: GenUiNode): string {
  const pairs = Array.isArray(node.pairs) ? node.pairs : []
  const rows = pairs.flatMap((pair) => {
    const record = recordOf(pair)
    if (record === undefined) return []
    return [`<div class="kv-row"><span class="kv-key">${esc(record.key)}</span><span class="kv-value">${esc(cellText(record.value))}</span></div>`]
  })
  return `<div class="kv">${rows.join('')}</div>`
}

function renderTable(node: GenUiNode): string {
  const table = readGenUiTable(node)
  const head = table.columns.map(column => `<th>${esc(column)}</th>`).join('')
  const body = table.rows.slice(0, 12).map(row => `<tr>${table.columns.map((_column, index) => `<td>${esc(row[index] ?? '')}</td>`).join('')}</tr>`).join('')
  const title = stringOf(node.title)
  return `<div class="table-wrap">${title === '' ? '' : `<div class="block-title">${esc(title)}</div>`}<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${table.rowCount > 12 ? `<div class="muted">仅展示前 12 行，共 ${String(table.rowCount)} 行</div>` : ''}</div>`
}

function toneClass(tone: unknown): string {
  switch (tone) {
    case 'success': return 'tone-success'
    case 'warning': return 'tone-warning'
    case 'danger':
    case 'error': return 'tone-error'
    default: return 'tone-info'
  }
}

function renderCallout(node: GenUiNode): string {
  const title = stringOf(node.title)
  const content = stringOf(node.content)
  return `<div class="callout ${toneClass(node.tone)}">${title === '' ? '' : `<div class="callout-title">${esc(title)}</div>`}<div class="callout-content">${esc(content).replace(/\n/gu, '<br>')}</div></div>`
}

function renderSteps(node: GenUiNode): string {
  const steps = Array.isArray(node.steps) ? node.steps : []
  const current = numberOf(node.current)
  const items = steps.map((step, index) => {
    const record = recordOf(step) ?? {}
    const title = stringOf(record.title) || `第 ${String(index + 1)} 步`
    const desc = stringOf(record.desc) || stringOf(record.description)
    const active = current !== undefined && current === index
    return `<div class="step${active ? ' step-active' : ''}"><span class="step-index">${String(index + 1)}</span><div class="step-body"><div class="step-title">${esc(title)}</div>${desc === '' ? '' : `<div class="step-desc">${esc(desc)}</div>`}</div></div>`
  })
  return `<div class="steps">${items.join('')}</div>`
}

function renderStats(node: GenUiNode): string {
  const label = stringOf(node.label)
  const value = cellText(node.value)
  const delta = stringOf(node.delta)
  const deltaClass = delta.startsWith('+') ? 'up' : delta.startsWith('-') ? 'down' : ''
  return `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div>${delta === '' ? '' : `<div class="stat-delta ${deltaClass}">${esc(delta)}</div>`}</div>`
}

function renderProgress(node: GenUiNode): string {
  const value = Math.max(0, Math.min(100, numberOf(node.value) ?? 0))
  const label = stringOf(node.label)
  return `<div class="progress-block">${label === '' ? '' : `<div class="progress-label">${esc(label)}</div>`}<div class="progress-track"><div class="progress-bar" style="width:${String(value)}%"></div></div><div class="progress-value">${String(Math.round(value))}%</div></div>`
}

function seriesPoints(node: GenUiNode): { label: string; value: number; color?: string }[] {
  const points: { label: string; value: number; color?: string }[] = []
  const push = (data: unknown): void => {
    if (!Array.isArray(data)) return
    for (const item of data) {
      const record = recordOf(item)
      if (record === undefined) continue
      const value = numberOf(record.value)
      if (value === undefined) continue
      points.push({
        label: stringOf(record.label) || `#${String(points.length + 1)}`,
        value,
        ...(stringOf(record.color) === '' ? {} : { color: stringOf(record.color) }),
      })
    }
  }
  push(node.data)
  for (const series of Array.isArray(node.series) ? node.series : []) {
    const record = recordOf(series)
    if (record !== undefined) push(record.data)
  }
  return points
}

function fmt(value: number): string {
  if (Math.abs(value) >= 10000) return `${String(Math.round(value / 1000) / 10)}k`
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

function renderBars(points: readonly { label: string; value: number; color?: string }[]): string {
  const max = Math.max(...points.map(point => Math.abs(point.value)), 1)
  const rows = points.slice(0, 12).map((point) => {
    const width = Math.max(2, Math.round(Math.abs(point.value) / max * 100))
    const color = point.color ?? '#2563eb'
    return `<div class="bar-row"><span class="bar-label">${esc(point.label)}</span><span class="bar-track"><span class="bar-fill" style="width:${String(width)}%;background:${esc(color)}"></span></span><span class="bar-value">${esc(fmt(point.value))}</span></div>`
  })
  return `<div class="bars">${rows.join('')}</div>`
}

function renderLine(points: readonly { label: string; value: number }[]): string {
  const width = 640
  const height = 220
  const padding = 28
  const values = points.map(point => point.value)
  const max = Math.max(...values)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const step = points.length <= 1 ? 0 : (width - padding * 2) / (points.length - 1)
  const coords = points.map((point, index) => {
    const x = padding + step * index
    const y = height - padding - ((point.value - min) / span) * (height - padding * 2)
    return `${String(Math.round(x))},${String(Math.round(y))}`
  })
  const labels = points.length === 0 ? '' : `<div class="line-labels"><span>${esc(points[0]!.label)}</span><span>${esc(points.at(-1)!.label)}</span></div>`
  return `<svg class="line-chart" viewBox="0 0 ${String(width)} ${String(height)}" preserveAspectRatio="none"><polyline points="${coords.join(' ')}" fill="none" stroke="#2563eb" stroke-width="3" stroke-linejoin="round"/></svg>${labels}`
}

function renderDonut(points: readonly { label: string; value: number }[]): string {
  const total = points.reduce((sum, point) => sum + Math.max(0, point.value), 0) || 1
  const colors = ['#2563eb', '#0ea5e9', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b']
  let offset = 0
  const radius = 70
  const circumference = 2 * Math.PI * radius
  const circles = points.slice(0, 7).map((point, index) => {
    const fraction = Math.max(0, point.value) / total
    const dash = `${String(fraction * circumference)} ${String(circumference)}`
    const circle = `<circle cx="90" cy="90" r="${String(radius)}" fill="none" stroke="${colors[index % colors.length]!}" stroke-width="26" stroke-dasharray="${dash}" stroke-dashoffset="${String(-offset)}" transform="rotate(-90 90 90)"/>`
    offset += fraction * circumference
    return circle
  })
  const legend = points.slice(0, 7).map((point, index) => `<div class="legend-row"><span class="legend-dot" style="background:${colors[index % colors.length]!}"></span><span class="legend-label">${esc(point.label)}</span><span class="legend-value">${esc(fmt(point.value))}</span></div>`).join('')
  return `<div class="donut"><svg viewBox="0 0 180 180" class="donut-chart">${circles.join('')}</svg><div class="donut-legend">${legend}</div></div>`
}

function renderChart(node: GenUiNode): string {
  const points = seriesPoints(node)
  const title = stringOf(node.title)
  const kind = stringOf(node.kind) || stringOf(node.preset)
  const heading = title === '' ? '' : `<div class="block-title">${esc(title)}</div>`
  if (points.length === 0) return `${heading}<div class="muted">${esc(chartSummary(node))}</div>`
  const body = kind === 'line' || kind === 'area' || kind === 'bigline'
    ? renderLine(points)
    : kind === 'donut' || kind === 'pie'
      ? renderDonut(points)
      : renderBars(points)
  return `<div class="chart">${heading}${body}</div>`
}

function sanitizeSvg(code: string): string | undefined {
  if (!/^\s*<svg[\s>]/iu.test(code)) return undefined
  const cleaned = code
    .replace(/<script[\s\S]*?<\/script>/giu, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/giu, '')
    .replace(/<image[\s\S]*?>/giu, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/giu, '')
    .replace(/\s(?:href|xlink:href)\s*=\s*("[^"]*"|'[^']*')/giu, '')
  return cleaned.slice(0, 12_000)
}

function renderSvg(node: GenUiNode): string {
  const code = sanitizeSvg(stringOf(node.code))
  if (code === undefined) return `<div class="muted">[SVG 图形无法渲染]</div>`
  const height = Math.max(100, Math.min(800, numberOf(node.height) ?? 300))
  return `<div class="svg-wrap" style="height:${String(height)}px">${code}</div>`
}

function renderTimeline(node: GenUiNode): string {
  const items = Array.isArray(node.items) ? node.items : []
  const rows = items.map((item) => {
    const record = recordOf(item) ?? {}
    const time = stringOf(record.time)
    const title = stringOf(record.title)
    const desc = stringOf(record.desc)
    return `<div class="timeline-row"><div class="timeline-time">${esc(time)}</div><div class="timeline-body"><div class="timeline-title">${esc(title)}</div>${desc === '' ? '' : `<div class="timeline-desc">${esc(desc)}</div>`}</div></div>`
  })
  return `<div class="timeline">${rows.join('')}</div>`
}

function renderFileTree(node: GenUiNode): string {
  const lines: string[] = []
  const visit = (entries: unknown[], depth: number): void => {
    if (depth > 6) return
    for (const entry of entries) {
      const record = recordOf(entry)
      if (record === undefined) continue
      const name = stringOf(record.name) || stringOf(record.label)
      if (name === '') continue
      lines.push(`${'  '.repeat(depth)}${record.type === 'dir' ? '📁' : '📄'} ${esc(name)}`)
      if (Array.isArray(record.children)) visit(record.children, depth + 1)
    }
  }
  visit(Array.isArray(node.items) ? node.items : [], 0)
  return `<pre class="file-tree">${lines.join('\n')}</pre>`
}

function renderCode(node: GenUiNode): string {
  const code = stringOf(node.code)
  const lang = stringOf(node.lang)
  return `<pre class="code" data-lang="${esc(lang)}">${esc(code)}</pre>`
}

function renderDiff(node: GenUiNode): string {
  const diffs = Array.isArray(node.diffs) ? node.diffs : []
  const blocks = diffs.map((diff) => {
    const record = recordOf(diff) ?? {}
    const path = stringOf(record.path)
    const oldText = stringOf(record.oldText)
    const newText = stringOf(record.newText)
    const lines = [
      ...oldText.split('\n').filter(Boolean).map(line => `<span class="diff-del">- ${esc(line)}</span>`),
      ...newText.split('\n').filter(Boolean).map(line => `<span class="diff-add">+ ${esc(line)}</span>`),
    ].join('\n')
    return `<div class="diff-block"><div class="diff-path">${esc(path)}</div><pre class="diff">${lines}</pre></div>`
  })
  return blocks.join('')
}

function renderChildrenBlock(node: GenUiNode, depth: number): string {
  const title = stringOf(node.title)
  const children = withChildren(node, depth)
  if (title === '') return children
  return `<section class="card"><div class="card-title">${esc(title)}</div>${children}</section>`
}

function renderGrid(node: GenUiNode, depth: number): string {
  const cols = Math.max(1, Math.min(4, numberOf(node.cols) ?? 2))
  const children = childComponentNodes(node).slice(0, 40)
  const cells = children.map(child => `<div class="grid-cell">${renderNode(child, depth + 1)}</div>`).join('')
  return `<div class="grid" style="grid-template-columns:repeat(${String(cols)},minmax(0,1fr))">${cells}</div>`
}

function renderTabs(node: GenUiNode, depth: number): string {
  const tabs = Array.isArray(node.tabs) ? node.tabs : []
  const sections = tabs.map((tab) => {
    const record = recordOf(tab) ?? {}
    const label = stringOf(record.label)
    const items = Array.isArray(record.items)
      ? record.items.filter((item): item is GenUiNode => recordOf(item) !== undefined)
      : []
    const body = items.map(item => renderNode(item, depth + 1)).join('')
    return `<section class="tab-section"><div class="tab-label">${esc(label)}</div>${body}</section>`
  })
  return `<div class="tabs">${sections.join('')}</div>`
}

function renderNode(node: GenUiNode, depth: number): string {
  if (depth > 8) return ''
  const type = stringOf(node.type)
  switch (type) {
    case 'text': {
      const size = stringOf(node.size)
      const tone = stringOf(node.tone)
      const align = stringOf(node.align) || (node.center === true ? 'center' : '')
      const classes = ['text', size === '' ? '' : `text-${size}`, tone === '' ? '' : `text-${tone}`, align === '' ? '' : `align-${align}`]
        .filter(Boolean).join(' ')
      return `<div class="${classes}">${esc(node.content).replace(/\n/gu, '<br>')}</div>`
    }
    case 'list': return renderList(node)
    case 'keyvalue': return renderKeyValue(node)
    case 'table': return renderTable(node)
    case 'callout': return renderCallout(node)
    case 'steps': return renderSteps(node)
    case 'stat': return renderStats(node)
    case 'badge': return `<span class="badge">${esc(node.label)}</span>`
    case 'progress': return renderProgress(node)
    case 'divider': return `<div class="divider">${stringOf(node.label) === '' ? '' : `<span>${esc(node.label)}</span>`}</div>`
    case 'spacer': return '<div class="spacer"></div>'
    case 'card':
    case 'col':
    case 'row':
    case 'carousel':
    case 'accordion': return renderChildrenBlock(node, depth)
    case 'grid': return renderGrid(node, depth)
    case 'tabs': return renderTabs(node, depth)
    case 'hero': {
      const value = cellText(node.value)
      const subtitle = stringOf(node.subtitle)
      const label = stringOf(node.label)
      return `<div class="hero"><div class="hero-title">${esc(node.title)}</div>${subtitle === '' ? '' : `<div class="hero-sub">${esc(subtitle)}</div>`}<div class="hero-value">${esc(value)}</div>${label === '' ? '' : `<div class="hero-label">${esc(label)}</div>`}</div>`
    }
    case 'timeline': return renderTimeline(node)
    case 'file-tree': return renderFileTree(node)
    case 'code': return renderCode(node)
    case 'diff': return renderDiff(node)
    case 'json': {
      let text = ''
      try {
        text = JSON.stringify(node.value, undefined, 2)
      } catch {
        text = ''
      }
      return `<pre class="code">${esc(text)}</pre>`
    }
    case 'chart':
    case 'echart': return renderChart(node)
    case 'svg': return renderSvg(node)
    case 'mermaid':
    case 'diagram': {
      const title = stringOf(node.title)
      return `${title === '' ? '' : `<div class="block-title">${esc(title)}</div>`}<pre class="diagram">${esc(node.code)}</pre><div class="muted">图形源码；完整交互请在万相查看</div>`
    }
    case 'compare': {
      const before = recordOf(node.before) ?? {}
      const after = recordOf(node.after) ?? {}
      const box = (label: string, sub: string): string => `<div class="compare-box"><div class="compare-label">${esc(label)}</div><div class="compare-sub">${esc(sub)}</div><div class="compare-placeholder">图片对比</div></div>`
      return `<div class="compare">${box(stringOf(before.label) || '改动前', stringOf(before.caption))}${box(stringOf(after.label) || '改动后', stringOf(after.caption))}</div>`
    }
    case 'image': return `<div class="placeholder">[图片] ${esc(node.alt ?? node.caption ?? '')}</div>`
    case 'image-group': return `<div class="placeholder">[图片组]</div>`
    case 'audio':
    case 'video': return `<div class="placeholder">[${type === 'audio' ? '音频' : '视频'}] ${esc(node.alt ?? '')}</div>`
    case 'breadcrumb': {
      const items = Array.isArray(node.items) ? node.items.map(cellText) : []
      return `<div class="breadcrumb">${items.map(item => esc(item)).join('<span class="sep">/</span>')}</div>`
    }
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
      return `<div class="placeholder">该内容为可交互卡片，请在万相查看。</div>`
    default: {
      const content = stringOf(node.content)
      if (content !== '') return `<div class="text">${esc(content)}</div>`
      return withChildren(node, depth)
    }
  }
}

/** 生成完整 HTML 文档；节点超限时截断，保证截图可控。 */
export function specToHtml(spec: GenUiSpec): string {
  const nodes = collectGenUiNodes(spec)
  const budget = new Set<GenUiNode>(nodes.slice(0, MAX_NODES))
  const body = spec.items
    .map(item => (budget.has(item) ? renderNode(item, 0) : ''))
    .filter(html => html !== '')
    .join('')
  const title = esc(spec.title ?? '万相 GenUI')
  const heading = spec.title === undefined || spec.title === '' ? '' : `<div class="doc-title">${esc(spec.title)}</div>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=720,initial-scale=1">
<title>${title}</title>
<style>
  html,body{margin:0;padding:0;background:#fff;color:#111827;font-family:"Noto Sans CJK SC","Microsoft YaHei","PingFang SC",sans-serif;-webkit-font-smoothing:antialiased}
  .sheet{width:720px;box-sizing:border-box;padding:24px 22px 14px;font-size:15px;line-height:1.65}
  .doc-title{font-size:22px;font-weight:800;line-height:1.35;margin:0 0 16px;letter-spacing:.2px}
  .block-title{font-size:16px;font-weight:700;margin:4px 0 10px}
  .text{margin:0 0 12px}
  .text-display{font-size:28px;font-weight:800;line-height:1.35}
  .text-h1{font-size:24px;font-weight:800;line-height:1.4}
  .text-h2{font-size:20px;font-weight:700}
  .text-h3{font-size:17px;font-weight:700}
  .text-muted,.muted{color:#6b7280;font-size:13px}
  .text-caption{font-size:12px;color:#6b7280}
  .text-danger{color:#b91c1c}.text-success{color:#047857}.text-warning{color:#b45309}.text-info{color:#1d4ed8}
  .align-center{text-align:center}.align-right{text-align:right}
  .list{margin:0 0 12px;padding-left:0;list-style:none}
  .list li{position:relative;padding-left:16px;margin:6px 0}
  .list li::before{content:"";position:absolute;left:2px;top:9px;width:6px;height:6px;border-radius:50%;background:#2563eb}
  .li-title{font-weight:600}
  .li-desc{display:block;color:#4b5563;font-size:13px;margin-top:2px}
  .kv{margin:0 0 12px;border-top:1px solid #e5e7eb}
  .kv-row{display:flex;gap:16px;padding:7px 0;border-bottom:1px solid #e5e7eb}
  .kv-key{width:150px;flex:none;color:#6b7280}
  .kv-value{flex:1;text-align:right;font-weight:600}
  .table-wrap{margin:0 0 14px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{border:1px solid #e5e7eb;padding:8px 10px;text-align:left;vertical-align:top}
  th{background:#f3f4f6;font-weight:700}
  tr:nth-child(even) td{background:#fafafa}
  .callout{border-radius:10px;padding:14px 16px;margin:0 0 14px;border:1px solid #bfdbfe;background:#eff6ff}
  .callout-title{font-weight:700;margin-bottom:4px}
  .callout-content{color:#1f2937}
  .tone-success{border-color:#bbf7d0;background:#f0fdf4}
  .tone-warning{border-color:#fde68a;background:#fffbeb}
  .tone-error{border-color:#fecaca;background:#fef2f2}
  .steps{margin:0 0 14px}
  .step{display:flex;gap:12px;padding:9px 0;border-bottom:1px dashed #e5e7eb}
  .step:last-child{border-bottom:0}
  .step-index{width:24px;height:24px;flex:none;border-radius:50%;background:#e5e7eb;color:#374151;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center}
  .step-active .step-index{background:#2563eb;color:#fff}
  .step-title{font-weight:600}
  .step-desc{color:#6b7280;font-size:13px;margin-top:2px}
  .stat{display:inline-block;min-width:140px;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;margin:0 8px 10px 0;background:#fff}
  .stat-label{color:#6b7280;font-size:12px}
  .stat-value{font-size:24px;font-weight:800;margin-top:4px}
  .stat-delta{font-size:12px;margin-top:2px}.stat-delta.up{color:#047857}.stat-delta.down{color:#b91c1c}
  .badge{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;margin-right:6px}
  .progress-block{display:flex;align-items:center;gap:10px;margin:0 0 12px}
  .progress-label{width:140px;flex:none;color:#374151}
  .progress-track{flex:1;height:10px;background:#e5e7eb;border-radius:999px;overflow:hidden}
  .progress-bar{height:100%;background:#2563eb;border-radius:999px}
  .progress-value{width:48px;text-align:right;font-weight:700}
  .divider{display:flex;align-items:center;gap:10px;color:#9ca3af;font-size:12px;margin:14px 0}
  .divider::before,.divider::after{content:"";height:1px;background:#e5e7eb;flex:1}
  .spacer{height:12px}
  .card{border:1px solid #e5e7eb;border-radius:12px;padding:14px 16px;margin:0 0 14px;background:#fff}
  .card-title{font-size:16px;font-weight:700;margin-bottom:8px}
  .grid{display:grid;gap:12px;margin:0 0 14px}
  .grid-cell{min-width:0}
  .hero{border-radius:14px;padding:22px;margin:0 0 16px;background:linear-gradient(135deg,#eff6ff,#e0f2fe);border:1px solid #bfdbfe}
  .hero-title{font-size:15px;color:#1d4ed8;font-weight:700}
  .hero-sub{color:#475569;margin-top:4px}
  .hero-value{font-size:44px;font-weight:800;line-height:1.15;margin-top:10px;color:#0f172a}
  .hero-label{color:#64748b;font-size:13px;margin-top:2px}
  .chart{margin:0 0 16px}
  .bars{display:flex;flex-direction:column;gap:8px}
  .bar-row{display:flex;align-items:center;gap:10px}
  .bar-label{width:120px;flex:none;font-size:13px;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bar-track{flex:1;height:16px;background:#f1f5f9;border-radius:4px;overflow:hidden}
  .bar-fill{display:block;height:100%;background:#2563eb;border-radius:4px}
  .bar-value{width:70px;text-align:right;font-size:13px;font-weight:600}
  .line-chart{width:100%;height:220px;background:#f8fafc;border:1px solid #eef2f7;border-radius:10px}
  .line-labels{display:flex;justify-content:space-between;color:#6b7280;font-size:12px;margin-top:4px}
  .donut{display:flex;align-items:center;gap:22px}
  .donut-chart{width:180px;height:180px;flex:none}
  .donut-legend{flex:1}
  .legend-row{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px}
  .legend-dot{width:9px;height:9px;border-radius:50%;flex:none}
  .legend-label{flex:1;color:#374151}
  .legend-value{font-weight:600}
  .svg-wrap{margin:0 0 14px;display:flex;align-items:center;justify-content:center;overflow:visible}
  .svg-wrap svg{max-width:100%;max-height:100%}
  .timeline{margin:0 0 14px;border-left:2px solid #bfdbfe;padding-left:16px}
  .timeline-row{position:relative;padding:6px 0 10px}
  .timeline-row::before{content:"";position:absolute;left:-22px;top:12px;width:9px;height:9px;border-radius:50%;background:#2563eb;border:2px solid #fff}
  .timeline-time{font-size:12px;color:#6b7280}
  .timeline-title{font-weight:600}
  .timeline-desc{color:#4b5563;font-size:13px}
  .code,.diagram,.file-tree{background:#0f172a;color:#e2e8f0;border-radius:10px;padding:12px 14px;font-family:"Noto Sans Mono CJK SC",Consolas,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0 0 14px}
  .diagram{background:#f8fafc;color:#334155;border:1px solid #e2e8f0}
  .file-tree{background:#f8fafc;color:#334155;border:1px solid #e2e8f0}
  .diff-block{margin:0 0 12px}
  .diff-path{font-family:monospace;font-size:12px;color:#6b7280;margin-bottom:4px}
  .diff{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;font-size:12px;line-height:1.6;white-space:pre-wrap}
  .diff-del{color:#b91c1c;display:block}
  .diff-add{color:#047857;display:block}
  .tabs{margin:0 0 14px}
  .tab-section{border-left:3px solid #dbeafe;padding-left:12px;margin:0 0 12px}
  .tab-label{font-weight:700;margin-bottom:6px}
  .placeholder{border:1px dashed #cbd5e1;border-radius:8px;background:#f8fafc;color:#64748b;padding:12px;text-align:center;margin:0 0 12px;font-size:13px}
  .compare{display:flex;gap:12px;margin:0 0 14px}
  .compare-box{flex:1;border:1px solid #e2e8f0;border-radius:10px;padding:10px;background:#f8fafc}
  .compare-label{font-weight:700;font-size:13px}
  .compare-sub{color:#64748b;font-size:12px;margin-top:2px}
  .compare-placeholder{border:1px dashed #cbd5e1;border-radius:6px;color:#94a3b8;text-align:center;padding:28px 0;margin-top:8px;font-size:12px}
  .breadcrumb{color:#6b7280;font-size:13px;margin:0 0 12px}
  .breadcrumb .sep{margin:0 6px;color:#cbd5e1}
</style>
</head>
<body>
<div id="genui-sheet" class="sheet">${heading}${body}</div>
</body>
</html>`
}