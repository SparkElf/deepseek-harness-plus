/**
 * 企微 GenUI 渲染策略：扫描 `dsh-ui` 围栏 → 判 audience → 文本/图片分流。
 *
 * 设计：`dataops/docs/design-wecom-genui-render.md` §2–§8。
 *
 * 关键约束：
 * - audience 必须在渲染前确定；调用方给的 hint 优先，但硬敏感内容只能收紧不能放宽；
 * - 不确定一律 `sender_only`（fail closed）；
 * - 任何失败都不得回退原始 `dsh-ui` JSON：坏 JSON 删块 + 可读提示；
 * - 图片渲染失败返回文本摘要并标记 `render_failed`，不是 JSON。
 *
 * @module connector/render-policy
 */

import {
  hasLargeTable,
  isImageWorthy,
  parseGenUiSpec,
  specToAltText,
  specToText,
  type GenUiSpec,
} from './genui-format.ts'
import { specToHtml } from './genui-html.ts'
import { renderGenUiPng, type PngRenderOptions } from './render-image.ts'

/** 群/私聊的投递 audience。 */
export type ReplyAudience = 'room_safe' | 'sender_only'

/** 一条回复被拆成的投递片段。 */
export type ReplySegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; png: Uint8Array; alt: string }

/** `renderAssistantReply` 的返回。 */
export interface RenderedReply {
  audience: ReplyAudience
  segments: ReplySegment[]
  hadGenUI: boolean
  fallbackReason?: string
}

/** 调用方上下文；`audienceHint` 由群聊/私聊在渲染前判定。 */
export interface RenderContext {
  audienceHint?: ReplyAudience
  channel: 'wecom'
}

/** 测试注入点；生产走 headless Chrome。 */
export interface RenderDeps {
  renderPng?: (html: string, options: PngRenderOptions) => Promise<Uint8Array[]>
}

/** 一个被扫描到的 `dsh-ui` 围栏。 */
export interface GenUiFence {
  /** 围栏起始偏移（含开头行）。 */
  start: number
  /** 围栏结束偏移（含结尾 ```）。未闭合时等于内容长度。 */
  end: number
  /** 围栏内 JSON 原文。 */
  body: string
  terminated: boolean
}

const OPEN_FENCE = /^\s*```\s*dsh-ui\s*>?\s*$/iu
const CLOSE_FENCE = /^\s*```\s*$/u

/**
 * 逐行扫描 `dsh-ui` 围栏；容忍 `dsh-ui>` 尾部标点和 CRLF。
 *
 * 未闭合的围栏也会返回（`terminated:false`），用于流式预览时把半截 JSON 截掉。
 */
export function scanGenUiFences(content: string): GenUiFence[] {
  const fences: GenUiFence[] = []
  const lines = content.split('\n')
  let offset = 0
  let open: { start: number; bodyLines: string[] } | undefined
  for (const line of lines) {
    const lineStart = offset
    const lineEnd = offset + line.length
    if (open === undefined) {
      if (OPEN_FENCE.test(line)) open = { start: lineStart, bodyLines: [] }
    } else if (CLOSE_FENCE.test(line)) {
      fences.push({ start: open.start, end: lineEnd, body: open.bodyLines.join('\n'), terminated: true })
      open = undefined
    } else {
      open.bodyLines.push(line)
    }
    offset = lineEnd + 1
  }
  if (open !== undefined) {
    fences.push({ start: open.start, end: content.length, body: open.bodyLines.join('\n'), terminated: false })
  }
  return fences
}

/** 删除所有围栏（完整或未闭合），用于流式预览与最终文本兜底。 */
export function stripGenUiFences(content: string): string {
  const fences = scanGenUiFences(content)
  if (fences.length === 0) return content
  let result = ''
  let cursor = 0
  for (const fence of fences) {
    result += content.slice(cursor, fence.start)
    cursor = fence.end
  }
  result += content.slice(cursor)
  return result.replace(/\n{3,}/gu, '\n\n').trim()
}

/** 流式预览：去掉围栏并限制长度，避免半截 JSON 被刷到企微。 */
export function sanitizeGenUiPreview(content: string, maxChars = 800): string {
  const stripped = stripGenUiFences(content).replace(/[ \t]+\n/gu, '\n').trim()
  if (stripped === '') return '正在整理结果…'
  return stripped.length > maxChars ? `${stripped.slice(0, maxChars)}…` : stripped
}

/** 硬敏感信号：命中即 sender_only，调用方 hint 也不能放宽。 */
const HARD_SENSITIVE: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /(?:密码|口令|secret|token|api[_-]?key|access[_-]?key|连接串)\s*[:=：]\s*[^\s，。；]{4,}/iu,
  /\bbearer\s+[A-Za-z0-9._-]{16,}/iu,
  /resource:(?:table|kb):/iu,
  /```sql/iu,
  /\bselect\b[\s\S]{0,300}\bfrom\b/iu,
  /\b1[3-9]\d{9}\b/u,
  /\b\d{17}[\dXx]\b/u,
  /(?:薪资|工资条|个税|社保明细|绩效评分|简历|面试评价)/u,
  /(?:员工|人员|客户|用户)名单|明细数据|逐条记录/u,
]

/** 明确的公开摘要信号；没有命中时 fail closed。 */
const PUBLIC_SUMMARY = /周报|周工作总结|本周工作|工作汇报|会议纪要|会议记录|会议总结|会议要点|公开摘要|公开总结|公告|制度|流程说明/iu

/** 内容本身是否含硬敏感信息。 */
export function containsHardSensitive(content: string): boolean {
  return HARD_SENSITIVE.some(pattern => pattern.test(content))
}

/**
 * 判定 audience。
 *
 * - 硬敏感 → sender_only（优先于任何 hint）；
 * - 有 hint → 采用 hint（群聊已在渲染前完成自己的分级）；
 * - 无 hint → 只有明确公开摘要才 room_safe，其余 sender_only。
 */
export function resolveReplyAudience(content: string, hint?: ReplyAudience): ReplyAudience {
  if (containsHardSensitive(content)) return 'sender_only'
  if (hint !== undefined) return hint
  return PUBLIC_SUMMARY.test(content) ? 'room_safe' : 'sender_only'
}

/** 无法解析的围栏统一提示；绝不回显 JSON。 */
const UNPARSEABLE_NOTICE = '（此 GenUI 卡片无法解析，已省略；完整内容请在万相查看。）'

/** 图片失败时的文本后缀。 */
const IMAGE_FALLBACK_NOTICE = '（图片渲染失败，已转为文字摘要；完整内容请在万相查看。）'

function pushText(segments: ReplySegment[], text: string): void {
  const cleaned = text.replace(/\n{3,}/gu, '\n\n').replace(/^\n+|\n+$/gu, '')
  if (cleaned === '') return
  const last = segments.at(-1)
  if (last?.kind === 'text') {
    segments[segments.length - 1] = { kind: 'text', text: `${last.text}\n\n${cleaned}` }
    return
  }
  segments.push({ kind: 'text', text: cleaned })
}

function validPngs(pngs: readonly Uint8Array[]): pngs is Uint8Array[] {
  return pngs.length > 0 && pngs.every(png => png instanceof Uint8Array && png.byteLength > 0)
}

async function renderSpecImage(
  spec: GenUiSpec,
  deps: RenderDeps,
): Promise<ReplySegment[]> {
  const html = specToHtml(spec)
  const render = deps.renderPng ?? renderGenUiPng
  const options: PngRenderOptions = { width: 720 }
  const pngs = await render(html, options)
  if (!validPngs(pngs)) throw new Error('GenUI renderer returned no PNG')
  const alt = specToAltText(spec)
  return pngs.map(png => ({ kind: 'image' as const, png, alt }))
}

/**
 * 把 agent 的最终回复按企微能力渲染。
 *
 * @param content - assistant 原始文本（可能含 `dsh-ui` 围栏）。
 * @param context - audience hint 与渠道；hint 必须在调用前判定。
 * @param deps - 测试注入点。
 */
export async function renderAssistantReply(
  content: string,
  context: RenderContext,
  deps: RenderDeps = {},
): Promise<RenderedReply> {
  const audience = resolveReplyAudience(content, context.audienceHint)
  const fences = scanGenUiFences(content)
  if (fences.length === 0) {
    return {
      audience,
      segments: content.trim() === '' ? [] : [{ kind: 'text', text: content }],
      hadGenUI: false,
    }
  }

  const segments: ReplySegment[] = []
  let fallbackReason: string | undefined
  let cursor = 0
  for (const fence of fences) {
    if (fence.start > cursor) pushText(segments, content.slice(cursor, fence.start))
    const spec = fence.terminated ? parseGenUiSpec(fence.body) : undefined
    if (spec === undefined) {
      pushText(segments, UNPARSEABLE_NOTICE)
      fallbackReason ??= 'parse_failed'
      cursor = fence.end
      continue
    }
    if (hasLargeTable(spec)) {
      pushText(segments, specToText(spec))
      cursor = fence.end
      continue
    }
    if (isImageWorthy(spec)) {
      try {
        for (const segment of await renderSpecImage(spec, deps)) segments.push(segment)
      } catch {
        pushText(segments, `${specToText(spec)}\n\n${IMAGE_FALLBACK_NOTICE}`)
        fallbackReason ??= 'render_failed'
      }
      cursor = fence.end
      continue
    }
    pushText(segments, specToText(spec))
    cursor = fence.end
  }
  if (cursor < content.length) pushText(segments, content.slice(cursor))

  return {
    audience,
    segments,
    hadGenUI: true,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
  }
}