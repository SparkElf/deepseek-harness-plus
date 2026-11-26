/**
 * External cockpit registry values and input checks.
 *
 * The external cockpit registry lives in DataOps. This module keeps the plugin's
 * view of a registry row narrow: ids, display metadata and a stable HTTPS link.
 * Login recipes, cookies, launch tickets and other secrets never cross this
 * boundary. M2 adds credential selection and the Playwright broker; M1 is
 * discovery and linking only.
 *
 * @module external
 */

/** Registry ids are opaque slugs/UUIDs, never paths or URLs. */
export const EXTERNAL_COCKPIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u

/** One external cockpit row exposed to tools and the sidebar. */
export interface ExternalCockpitRow {
  id: string
  name: string
  description: string | null
  /** Target site URL; only an absolute HTTPS URL is exposed. */
  url: string | null
  icon: string | null
  tags: string[]
  ownerId: string | null
  visibility: 'PRIVATE' | 'DEPARTMENT' | 'ALL'
  credentialType: 'http' | 'custom' | 'none'
  /** Account hint such as a username pattern; never a password. */
  credentialHint: string | null
  enabled: boolean
  health: string | null
  updatedAt: string | null
}

/** One page of external cockpit rows. */
export interface ExternalCockpitPage {
  items: ExternalCockpitRow[]
  total: number
  page: number
  pageSize: number
}

/** Stable link returned by `POST /api/external-cockpits/:id/link`. */
export interface ExternalCockpitLink {
  id: string
  url: string
  expiresAt: string | null
  mode: 'stable' | 'ticket'
}

/**
 * Accept one opaque registry id or fail before any URL is assembled.
 * @param value - Candidate id from a tool, route segment or caller.
 * @returns The trimmed id.
 */
export function assertExternalCockpitId(value: string): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!EXTERNAL_COCKPIT_ID_PATTERN.test(id)) {
    throw new Error('外部驾驶舱 id 非法：只接受注册表 id，不接受 URL 或路径')
  }
  return id
}

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/** Keep only absolute HTTPS URLs; reject javascript/data/file and relative values. */
const httpsUrlOf = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.trim() === '') return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  return parsed.protocol === 'https:' ? parsed.toString() : null
}

const tagsOf = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const tags: string[] = []
  for (const item of value) {
    const tag = textOf(item)
    if (tag !== null && !tags.includes(tag)) tags.push(tag)
  }
  return tags.slice(0, 20)
}

const visibilityOf = (value: unknown): ExternalCockpitRow['visibility'] =>
  value === 'DEPARTMENT' || value === 'ALL' ? value : 'PRIVATE'

const credentialTypeOf = (value: unknown): ExternalCockpitRow['credentialType'] =>
  value === 'http' || value === 'custom' ? value : 'none'

/**
 * Narrow one unsanitized registry row to the fields the model and UI may see.
 * Extra backend fields (login recipe, cookies, allowed origins) are dropped.
 * @param value - Decoded JSON row from DataOps.
 * @returns Sanitized row.
 */
export function normalizeExternalCockpitRow(value: unknown): ExternalCockpitRow {
  const record = recordOf(value)
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!EXTERNAL_COCKPIT_ID_PATTERN.test(id)) throw new Error('外部驾驶舱数据缺少合法 id')
  const name = textOf(record.name)
  if (name === null) throw new Error('外部驾驶舱数据缺少名称')
  return {
    id,
    name,
    description: textOf(record.description),
    url: httpsUrlOf(record.url),
    icon: httpsUrlOf(record.icon),
    tags: tagsOf(record.tags),
    ownerId: textOf(record.ownerId),
    visibility: visibilityOf(record.visibility),
    credentialType: credentialTypeOf(record.credentialType),
    credentialHint: textOf(record.credentialHint),
    enabled: record.enabled !== false,
    health: textOf(record.health),
    updatedAt: textOf(record.updatedAt),
  }
}

/**
 * Normalize the list/detail envelope. Accepts `{items,...}` or a bare array.
 * @param value - Decoded JSON payload.
 * @param page - Requested page, used when the server omits it.
 * @param pageSize - Requested page size, used when the server omits it.
 * @returns Normalized page.
 */
export function normalizeExternalCockpitPage(value: unknown, page: number, pageSize: number): ExternalCockpitPage {
  const record = recordOf(value)
  const rawItems = Array.isArray(value) ? value : Array.isArray(record.items) ? record.items : []
  const items = rawItems.map(normalizeExternalCockpitRow)
  return {
    items,
    total: typeof record.total === 'number' && Number.isFinite(record.total) ? record.total : items.length,
    page: typeof record.page === 'number' && Number.isFinite(record.page) ? record.page : page,
    pageSize: typeof record.pageSize === 'number' && Number.isFinite(record.pageSize) ? record.pageSize : pageSize,
  }
}

/**
 * Normalize the link response. M1 consumes the stable HTTPS link only; a
 * launch ticket without a stable URL is an M2 feature and is rejected here.
 * @param value - Decoded JSON payload.
 * @param id - Registry id the link was requested for.
 * @returns Stable link with no ticket or cookie fields.
 */
export function normalizeExternalCockpitLink(value: unknown, id: string): ExternalCockpitLink {
  const record = recordOf(value)
  const candidate = record.url ?? record.link ?? record.stableUrl ?? record.openUrl ?? record.targetUrl ?? record.href
  const url = httpsUrlOf(candidate)
  if (url === null) {
    if (record.launchTicket !== undefined || record.ticket !== undefined) {
      throw new Error('DataOps 只返回了 launch ticket；M1 只支持稳定链接，登录代理在 M2')
    }
    throw new Error('DataOps 未返回可用的 HTTPS 稳定链接')
  }
  return {
    id: typeof record.id === 'string' && record.id.trim() !== '' ? record.id.trim() : id,
    url,
    expiresAt: textOf(record.expiresAt),
    mode: record.mode === 'ticket' ? 'ticket' : 'stable',
  }
}
