/**
 * 批量绑定企微 userid 的数据访问。
 *
 * 与单条绑定共用同一个同源代理前缀；请求体始终是 JSON，CSV 文本放在 `csv` 字段里，
 * 由后端解析。错误响应可能带 `rows`（apply 被整批拒绝时的预览），UI 需要原样展示。
 */

import { errorMessage } from './api.ts'

/** 代理根路径，与 `api.ts` 的 `IM_BASE` 保持一致。 */
const IM_BASE = '/integrations/dataops/im'

/** 后端返回的匹配用户摘要。 */
export interface BulkBindUser {
  id: string
  username: string
  displayName: string
  email: string
  phone: string | null
  oaNumber: string | null
  enabled: boolean
  wecomUserId: string | null
}

/** 单行结果状态。 */
export type BulkBindRowStatus = 'matched' | 'applied' | 'conflict' | 'unmatched' | 'invalid'

/** 单行预览/结果。 */
export interface BulkBindRow {
  index: number
  wecomUserId: string | null
  identifiers: Array<{ field: 'username' | 'email' | 'mobile' | 'employeeId'; value: string }>
  status: BulkBindRowStatus
  reason: string | null
  message: string
  user: BulkBindUser | null
  candidates: Array<Pick<BulkBindUser, 'id' | 'username' | 'displayName'>>
  auditId?: string
}

/** 汇总计数。 */
export interface BulkBindSummary {
  total: number
  matched: number
  applied: number
  conflicts: number
  unmatched: number
  invalid: number
}

/** 批量绑定响应。 */
export interface BulkBindResult {
  dryRun: boolean
  applied: number
  total: number
  summary: BulkBindSummary
  rows: BulkBindRow[]
}

/** apply 被拒绝时后端返回的 409 体（预览在 `details`，与 DataOps 错误信封一致）。 */
export interface BulkBindRejectedBody {
  code?: string
  message?: string
  applied?: number
  total?: number
  summary?: BulkBindSummary
  rows?: BulkBindRow[]
  details?: {
    dryRun?: boolean
    applied?: number
    total?: number
    summary?: BulkBindSummary
    rows?: BulkBindRow[]
  }
}

/** 请求失败；`body` 保留后端结构化预览，供 UI 展示冲突原因。 */
export class BulkBindError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: BulkBindRejectedBody | null,
  ) {
    super(message)
    this.name = 'BulkBindError'
  }
}

/**
 * 调一次批量绑定接口。
 * @param payload - `{ rows }` 或 `{ csv }` 加 `dryRun`。
 */
async function postBulkBind(payload: unknown): Promise<BulkBindResult> {
  const response = await fetch(IM_BASE + '/identity/bulk-bind', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  })
  const text = await response.text()
  let body: unknown = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (response.status !== 200 || body === null || typeof body !== 'object') {
    throw new BulkBindError(
      errorMessage(response.status, body),
      response.status,
      body as BulkBindRejectedBody | null,
    )
  }
  return body as BulkBindResult
}

/** dryRun 预览：不写库。 */
export function previewBulkBindings(payload: { rows: unknown[] } | { csv: string }): Promise<BulkBindResult> {
  return postBulkBind({ ...payload, dryRun: true })
}

/** 确认写入：后端在一个事务里重新匹配并写入，任一行冲突则整批拒绝。 */
export function applyBulkBindings(payload: { rows: unknown[] } | { csv: string }): Promise<BulkBindResult> {
  return postBulkBind({ ...payload, dryRun: false })
}