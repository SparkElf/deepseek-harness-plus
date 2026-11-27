/** 设置页的数据访问：只经过本插件的同源代理，浏览器永远看不到 DataOps 的 baseUrl 之外的东西。 */

/** 机器人视图，字段与后端 `ImBotViewDto` 一一对应。 */
export interface ImBotView {
  id: string
  name: string
  provider: 'WECOM' | 'DINGTALK'
  botIdMasked: string
  secretConfigured: boolean
  workspaceId: number | null
  workspaceName: string | null
  serviceAccountId: string | null
  enabled: boolean
  status: 'UNKNOWN' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'DISABLED'
  lastError: string | null
  lastCheckedAt: string | null
  createdAt: string
  updatedAt: string
}

/** 可绑定的工作区与服务账号。 */
export interface ImBotOptions {
  workspaces: { id: number; name: string; imConnectorEnabled: boolean }[]
  serviceAccounts: { id: string; name: string }[]
}

/** 连接测试结果。 */
export interface ImBotTestResult {
  ok: boolean
  code: string
  message: string
  verified: boolean
  latencyMs: number
  checkedAt: string
}

/** 用户与其企微 userid 绑定状态（管理页的绑定面板）。 */
export interface ImIdentityUser {
  id: string
  username: string
  displayName: string
  enabled: boolean
  wecomUserId: string | null
  roleCodes: string[]
}

/** 连接器身份桥里的发送者状态。 */
export type ImPendingStatus = 'resolving' | 'bound' | 'unmapped' | 'unavailable'

/** 待绑定/已识别的企微发送者；senderId 完整值只用于管理员绑定。 */
export interface ImPendingSender {
  sessionId: string
  botId: string
  /** dsh-im 内部 botId 对应的 DataOps 远端 Bot ID；解析成功时展示后者。 */
  remoteBotId?: string
  senderId: string
  senderIdMasked: string
  senderName: string | null
  chatType: string | null
  status: ImPendingStatus
  bound: boolean
  unmapped: boolean
  reason?: string
  message?: string
  actorUserId?: string
  updatedAt: number
}

/** 管理端功能开关；默认全部关闭，避免诊断面成为产品入口。 */
export interface ImFeatures {
  showPendingSenders: boolean
}

/**
 * 当前部署的 IM 管理能力。
 *
 * `available:false` 表示 backend/代理没有提供 IM 管理接口（旧版部署、404、502、网络不通），
 * 页面应隐藏入口而不是显示空表或报错。`allowed` 只在接口存在时才有意义。
 */
export interface ImCapability {
  available: boolean
  allowed: boolean
  reason?: string
}

/** 待绑定发送者查询结果；`connector:false` 表示当前工作区没有连接器。 */
export interface ImPendingSenderResult {
  items: ImPendingSender[]
  connector: boolean
  message?: string
}

/** 新建/更新入参。`secret` 只进不出。 */
export interface ImBotDraft {
  name: string
  provider: 'WECOM' | 'DINGTALK'
  botId?: string
  secret?: string
  workspaceId?: number | null
  serviceAccountId?: string | null
  enabled?: boolean
}

/** 代理根路径，与宿主侧 `IM_BASE_PATH` 保持一致。 */
const IM_BASE = '/integrations/dataops/im'
const BASE = IM_BASE + '/bots'

/**
 * 调一次代理接口并解析 JSON。
 * @param path - 前缀之后的路径（`''`、`/<id>`、`/<id>/test`）。
 * @param init - fetch 初始化。
 * @returns 状态码与响应体；响应不是 JSON 时 body 为 null。
 */
async function call<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T | null }> {
  const response = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    cache: 'no-store',
  })
  const text = await response.text()
  let body: T | null = null
  if (text !== '') {
    try { body = JSON.parse(text) as T } catch { body = null }
  }
  return { status: response.status, body }
}

/** 与 {@link call} 相同，但接受完整代理路径（身份绑定接口不在 bots 前缀下）。 */
async function callAt<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T | null }> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    cache: 'no-store',
  })
  const text = await response.text()
  let body: T | null = null
  if (text !== '') {
    try { body = JSON.parse(text) as T } catch { body = null }
  }
  return { status: response.status, body }
}

/**
 * 把非 2xx 的响应折成一句可展示的错误。
 * @param status - HTTP 状态码。
 * @param body - 后端响应体。
 */
export function errorMessage(status: number, body: unknown): string {
  if (status === 401) return 'DataOps 会话已失效，请重新进入工作台'
  if (status === 403) return '当前账号没有 IM 机器人管理权限'
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const message = (body as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'string' && error !== '') return error
  }
  return `请求失败（HTTP ${status}）`
}

/** 读取机器人列表。 */
export async function fetchBots(): Promise<ImBotView[]> {
  const { status, body } = await call<{ items: ImBotView[] }>('')
  if (status !== 200 || body === null) throw new Error(errorMessage(status, body))
  return body.items
}

/** 读取工作区/服务账号选项。 */
export async function fetchOptions(): Promise<ImBotOptions> {
  const { status, body } = await call<ImBotOptions>('/options')
  if (status !== 200 || body === null) throw new Error(errorMessage(status, body))
  return body
}

/** 新建机器人。 */
export async function createBot(draft: ImBotDraft): Promise<ImBotView> {
  const { status, body } = await call<{ bot: ImBotView }>('', { method: 'POST', body: JSON.stringify(draft) })
  if (status !== 201 || body === null) throw new Error(errorMessage(status, body))
  return body.bot
}

/** 更新机器人（含启停与轮换 Secret）。 */
export async function updateBot(id: string, draft: Partial<ImBotDraft>): Promise<ImBotView> {
  const { status, body } = await call<{ bot: ImBotView }>(`/${id}`, { method: 'PATCH', body: JSON.stringify(draft) })
  if (status !== 200 || body === null) throw new Error(errorMessage(status, body))
  return body.bot
}

/** 删除登记。 */
export async function deleteBot(id: string): Promise<void> {
  const { status, body } = await call<{ ok: boolean }>(`/${id}`, { method: 'DELETE' })
  if (status !== 200) throw new Error(errorMessage(status, body))
}

/** 测试连接。 */
export async function testBot(id: string): Promise<{ result: ImBotTestResult; bot: ImBotView }> {
  const { status, body } = await call<{ result: ImBotTestResult; bot: ImBotView }>(`/${id}/test`, { method: 'POST' })
  if (status !== 200 || body === null) throw new Error(errorMessage(status, body))
  return body
}

/** 读取用户与企微绑定状态；`query` 为空时返回第一页。 */
export async function fetchIdentityUsers(query = ''): Promise<{ items: ImIdentityUser[]; boundCount: number }> {
  const suffix = query.trim() === '' ? '' : `?query=${encodeURIComponent(query.trim())}`
  const { status, body } = await callAt<{ items: ImIdentityUser[]; boundCount: number }>(IM_BASE + `/identity/users${suffix}`)
  if (status !== 200 || body === null) throw new Error(errorMessage(status, body))
  return body
}

/**
 * 读取当前部署的 IM 管理能力。
 *
 * 这是设置页的可见性探针，不是业务调用：任何失败（404/502/503、网络错误、响应不可解析）
 * 都折成 `{available:false, reason}`，不 throw，也不让页面出现 5xx / pageerror。
 * 代理层已经把上游失败统一成 200；这里再兜一层网络错误，保证客户端永远拿到对象。
 *
 * @returns 能力探测结果；不可用时 `available:false`。
 */
export async function fetchImCapability(): Promise<ImCapability> {
  try {
    const { status, body } = await callAt<ImCapability>(IM_BASE + '/capability')
    if (status === 401 || status === 403) {
      return { available: true, allowed: false, reason: status === 401 ? 'unauthenticated' : 'forbidden' }
    }
    if (status !== 200 || body === null || typeof body !== 'object') {
      return { available: false, allowed: false, reason: `HTTP ${status}` }
    }
    return {
      available: body.available !== false,
      allowed: body.allowed === true,
      ...(typeof body.reason === 'string' && body.reason !== '' ? { reason: body.reason } : {}),
    }
  } catch (error) {
    return {
      available: false,
      allowed: false,
      reason: error instanceof Error ? error.message : 'network error',
    }
  }
}

/** 读取本工作区的 IM 功能开关；失败时按全部关闭处理。 */
export async function fetchImFeatures(): Promise<ImFeatures> {
  try {
    const { status, body } = await callAt<{ showPendingSenders?: unknown }>(IM_BASE + '/features')
    if (status !== 200 || body === null) return { showPendingSenders: false }
    return { showPendingSenders: body.showPendingSenders === true }
  } catch {
    return { showPendingSenders: false }
  }
}

/**
 * 待绑定发送者接口的位置。
 *
 * 连接器工作区把数据直接放在本机 DSH 的 `/api/dsh-dataops-im/identity/pending`；
 * 管理端工作区没有连接器进程，改走同源代理 `/integrations/dataops/im/identity/pending`。
 * 先问本地 auth 路由拿 mode：admin 模式没有这条路由，解析失败时按管理端处理。
 */
async function pendingSenderPath(): Promise<string> {
  try {
    const response = await fetch('/api/dsh-dataops-im/auth', { cache: 'no-store' })
    if (response.ok) {
      const body = await response.json() as { mode?: unknown }
      if (body.mode === 'connector') return '/api/dsh-dataops-im/identity/pending'
    }
  } catch {
    // admin 模式没有本地 auth 路由；继续走同源代理。
  }
  return IM_BASE + '/identity/pending'
}

/** 读取待绑定发送者；只返回脱敏展示所需字段和绑定输入的完整 senderId，不含 token。 */
export async function fetchPendingSenders(): Promise<ImPendingSenderResult> {
  const path = await pendingSenderPath()
  const { status, body } = await callAt<{
    ok?: boolean
    items?: ImPendingSender[]
    connector?: boolean
    message?: string
  }>(path)
  if (status !== 200 || body === null) throw new Error(errorMessage(status, body))
  return {
    items: Array.isArray(body.items) ? body.items : [],
    connector: body.connector !== false,
    ...(typeof body.message === 'string' && body.message !== '' ? { message: body.message } : {}),
  }
}

/** 绑定/解绑一个用户的企微 userid；`wecomUserId=null` 表示解绑。 */
export async function bindIdentityUser(userId: string, wecomUserId: string | null): Promise<ImIdentityUser> {
  const { status, body } = await callAt<{ user: ImIdentityUser }>(IM_BASE + `/identity/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ wecomUserId }),
  })
  if (status !== 200 || body === null) throw new Error(errorMessage(status, body))
  return body.user
}