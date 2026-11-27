/**
 * 私聊/群聊共用的工具进度文案映射。
 *
 * 只读工具名：忽略 arguments/text/callId/路径/结果，绝不把参数或凭据展示给用户。
 * 已知工具族映射为固定中文阶段；未知工具展示去掉 `mcp__`/服务前缀后的实际工具名。
 *
 * @module connector/tool-progress
 */

/** 工具阶段；`tool` 是未知工具的兜底。 */
export type ToolProgressPhase = 'data' | 'sql' | 'knowledge' | 'document' | 'tool'

const MAX_DISPLAY_NAME = 40

function rawName(toolName: string): string {
  return toolName.trim().replace(/^mcp__/u, '')
}

/** 去掉 `mcp__` 与服务前缀，只保留最后一段；超长截断到 40 字符。 */
export function displayToolName(toolName: string): string {
  const name = rawName(toolName)
  if (name === '') return '工具'
  const last = name.split('__').at(-1) ?? name
  const cleaned = last.replace(/[^\w.-]/gu, '') || '工具'
  return cleaned.length > MAX_DISPLAY_NAME ? `${cleaned.slice(0, MAX_DISPLAY_NAME - 1)}…` : cleaned
}

/** 工具名 → 固定阶段。 */
export function toolProgressPhase(toolName: string): ToolProgressPhase {
  const full = rawName(toolName).toLowerCase()
  const last = full.split('__').at(-1) ?? full
  if (/^sql_/u.test(last) || last === 'execute_sql' || /(?:^|_)sql(?:_|$)/u.test(last)) return 'sql'
  if (/^(?:kb|knowledge|memory)/u.test(last) || /knowledge/iu.test(full)) return 'knowledge'
  if (/^(?:office|pdf|docx|xlsx|pptx)/u.test(last)) return 'document'
  if (/^(?:dataops|data_query|query_table|query_api|search_resources|list_resources)/u.test(last)
    || /data-?query/iu.test(full)) return 'data'
  return 'tool'
}

/** 工具名 → 可展示的中文进度文案。 */
export function toolProgressText(toolName: string): string {
  switch (toolProgressPhase(toolName)) {
    case 'data': {
      const last = rawName(toolName).toLowerCase().split('__').at(-1) ?? ''
      return /^(?:query_table|query_api|execute|run)/u.test(last)
        ? '正在执行数据查询'
        : '正在查询数据资源'
    }
    case 'sql': return '正在执行 SQL'
    case 'knowledge': return '正在检索知识库'
    case 'document': return '正在处理文档'
    default: return `正在调用 ${displayToolName(toolName)}`
  }
}

/** 兼容旧调用名；等价于 {@link toolProgressText}。 */
export function toolProgressLabel(toolName: string | undefined): string | undefined {
  return toolName === undefined || toolName.trim() === '' ? undefined : toolProgressText(toolName)
}

/**
 * 从 DSH 进度更新里只读 `type` 与 `name`；其余字段（arguments/result/path/callId）一律忽略。
 *
 * @returns 可展示文案；不是 tool 事件或没有工具名时返回 undefined。
 */
export function toolProgressFromUpdate(update: unknown): string | undefined {
  if (update === null || typeof update !== 'object') return undefined
  const record = update as { type?: unknown; name?: unknown }
  if (record.type !== 'tool' || typeof record.name !== 'string' || record.name.trim() === '') return undefined
  return toolProgressText(record.name)
}
