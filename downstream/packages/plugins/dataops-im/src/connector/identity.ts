/**
 * IM 身份桥：把 dsh-im 的 `session-pre-bind` 事件变成 DataOps actor 与 scoped 凭据。
 *
 * 事件是同步、fire-and-forget 的，而且发生在 `session.create` 之前。这里用「先 fail closed、
 * 再解析」的顺序：事件到达时立即给 Session 放一个不含 scope 字段的占位 actor，MCP 凭据解析
 * 看到 actor 后只会使用本 Session 的 scoped 槽；槽没写入之前任何工具调用都会失败，绝不会
 * 回落到工作区服务账号 token。解析成功后再用真实 scope 替换占位 actor。
 *
 * @module connector/identity
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** dsh-im 在对话绑定时发出的最小载荷。 */
export interface ImSessionBindEvent {
  readonly channel?: string
  readonly botId?: string
  readonly sessionId?: string
  readonly conversationKey?: string
  readonly chatType?: string | null
  readonly chatId?: string | null
  readonly threadId?: string | null
  readonly senderId?: string | null
  readonly senderName?: string | null
}

/** 一个 Session 的身份解析状态，供管理/诊断与测试读取。 */
export type IdentitySessionState =
  | { status: 'resolving'; sessionId: string; senderId: string; botId: string; updatedAt: number }
  | { status: 'bound'; sessionId: string; senderId: string; botId: string; actorUserId: string; expiresAt: string; updatedAt: number }
  | { status: 'unmapped'; sessionId: string; senderId: string; botId: string; reason: string; message: string; updatedAt: number }
  | { status: 'unavailable'; sessionId: string; senderId: string; botId: string; reason: string; message: string; updatedAt: number }

/**
 * 管理员可见的发送者记录。
 *
 * 只保存绑定所需的最小字段：senderId 是管理员执行绑定的输入，因此服务端返回完整值；
 * 界面默认只展示 {@link PendingSenderView.senderIdMasked}。记录里永远没有 token。
 */
export interface PendingSender {
  readonly sessionId: string
  readonly botId: string
  readonly remoteBotId?: string
  readonly senderId: string
  readonly senderName: string | null
  readonly chatType: string | null
  readonly status: IdentitySessionState['status']
  readonly bound: boolean
  readonly unmapped: boolean
  readonly reason?: string
  readonly message?: string
  readonly actorUserId?: string
  readonly updatedAt: number
}

/** 列表视图：附带脱敏 senderId，避免管理员截图/日志直接带出完整通讯录 userid。 */
export interface PendingSenderView extends PendingSender {
  readonly senderIdMasked: string
}

/** 身份桥需要的宿主能力。 */
export interface IdentityBridgeOptions {
  /** DataOps API origin（不含 `/api`）。 */
  readonly baseUrl: string
  /** 工作区 JWT 的凭据名，用它的值调用 resolve。 */
  readonly credentialRef: string
  /** 日志；只允许记录 id/原因，不允许记录 token。 */
  readonly logger: { info?(message: string): void; warn(message: string): void; error?(message: string): void }
  /** 测试注入点；生产走 globalThis.fetch。 */
  readonly fetchImpl?: typeof fetch
  /** 测试注入点；生产走 Date.now。 */
  readonly now?: () => number
  /** DSH home；用于把 dsh-im 内部 botId 映射到 DataOps 登记的 remoteBotId。 */
  readonly dshHome?: string
}

/** resolve 返回体的结构子集。 */
interface ResolveResponse {
  readonly decision?: unknown
  readonly actor?: unknown
  readonly token?: unknown
  readonly expiresAt?: unknown
  readonly reason?: unknown
  readonly message?: unknown
  readonly user?: { readonly id?: unknown }
}

/** 认证失败/后端异常时的显式错误。 */
export class IdentityBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'IdentityBridgeError'
  }
}

/** 占位 actor：不含 DATAOPS scope 的识别字段，任何工具披露都按“非本工作区主体”处理。 */
const PENDING_ACTOR = Object.freeze({
  identityPending: true,
  source: 'wecom',
})

/** 未解析事件在内存里的保留时间；防止 pre-bind 后 Session 没建出来留下泄漏。 */
const PENDING_TTL_MS = 5 * 60 * 1000

/** 管理面发送者记录的保留时间；管理员可能过一段时间才来绑定。 */
const SENDER_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 内存里最多保留的发送者记录数；列表只返回最近 50 条。 */
const SENDER_STORE_LIMIT = 200

/** 管理面列表的硬上限。 */
const SENDER_LIST_LIMIT = 50

/**
 * 把 Session id 折叠成凭据引用后缀，必须与 mcp-credentials 的 `scopedCredentialRef` 完全一致。
 * @param baseRef - 工作区凭据名，例如 `DATAOPS_ACCESS_TOKEN`。
 * @param sessionId - DSH Session id。
 */
export function scopedCredentialRef(baseRef: string, sessionId: string): string {
  const suffix = sessionId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `${baseRef}_S_${suffix}`
}

/**
 * 身份桥本体。
 *
 * 订阅三个事件：
 * - `dsh-im/session-pre-bind`：写入占位 actor，异步解析；
 * - `session/created`：把已解析（或占位）身份同步写到 Session 上；
 * - `dsh-im/session-unbind`：删除本 Session 的 scoped 槽，避免残留 token。
 */
export class WecomIdentityBridge {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly senders = new Map<string, PendingSender>()
  /** dsh-im 内部 botId -> DataOps 登记的远端 Bot ID；同一进程内缓存。 */
  private readonly remoteBotIds = new Map<string, string>()
  private readonly gcTimer: ReturnType<typeof setInterval>
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly options: IdentityBridgeOptions,
  ) {
    this.gcTimer = setInterval(() => this.gc(), 60_000)
    this.gcTimer.unref?.()
  }

  /** 开始监听；返回 disposer。 */
  start(): () => void {
    const disposers: (() => void)[] = []
    // dsh-im 的事件名是插件私有契约，内核的 Events 类型里没有它们；这里只依赖运行时
    // `ctx.on(name, listener)`，不复制上游类型包。
    const events = this.ctx as unknown as {
      on?(name: string, listener: (payload: never) => void): () => void
    }
    if (typeof events.on === 'function') {
      disposers.push(events.on('dsh-im/session-pre-bind', (event: ImSessionBindEvent) => {
        this.onPreBind(event)
      }) as () => void)
      disposers.push(events.on('dsh-im/session-unbind', (event: ImSessionBindEvent) => {
        void this.onUnbind(event)
      }) as () => void)
      disposers.push(events.on('session/created', (session: { id?: unknown }) => {
        this.onSessionCreated(session)
      }) as () => void)
    }
    return () => {
      this.disposed = true
      clearInterval(this.gcTimer)
      for (const dispose of disposers) dispose()
    }
  }

  /** 读取一个 Session 的身份状态；未知返回 undefined。 */
  status(sessionId: string): IdentitySessionState | undefined {
    return this.pending.get(sessionId)?.state
  }

  /**
   * 管理员可见的发送者列表。
   *
   * 按“未绑定优先、再按更新时间倒序”返回，最多 50 条；同一次投递的 Session 状态变化会
   * 更新同一条记录而不是重复堆积。记录里不含 token，senderId 保留完整值供管理员绑定，
   * 另带脱敏值供界面展示。
   *
   * @param limit - 可选上限；无论如何不会超过 50。
   * @returns 发送者视图数组。
   */
  listPending(limit = SENDER_LIST_LIMIT): PendingSenderView[] {
    const max = Number.isFinite(limit) ? Math.min(SENDER_LIST_LIMIT, Math.max(1, Math.trunc(limit))) : SENDER_LIST_LIMIT
    return [...this.senders.values()]
      .sort((left, right) => (Number(left.bound) - Number(right.bound)) || (right.updatedAt - left.updatedAt))
      .slice(0, max)
      .map(record => ({ ...record, senderIdMasked: maskSenderId(record.senderId) }))
  }

  /** 当前已解析的 actor（供诊断；不含 token）。 */
  actorOf(sessionId: string): unknown {
    const session = this.sessionOf(sessionId)
    return (session as { actor?: unknown } | undefined)?.actor
  }

  /**
   * 处理绑定事件：同步放占位 actor，再异步解析。
   * @param raw - dsh-im 事件载荷。
   */
  onPreBind(raw: ImSessionBindEvent): void {
    const event = normalizeEvent(raw)
    if (event === undefined) {
      this.options.logger.warn('[dataops-im] session-pre-bind ignored: missing sessionId/botId/senderId')
      return
    }
    const existing = this.pending.get(event.sessionId)
    if (existing !== undefined && existing.event.senderId === event.senderId) {
      if (existing.state.status === 'bound' && existing.actor !== undefined) {
        // 已绑定：保持现有 actor/凭据，避免重复铸 token。
        this.recordSender(event, 'bound', { actorUserId: existing.state.actorUserId })
        this.applyActor(event.sessionId, existing.actor)
        return
      }
      // 上一次未绑定/身份服务失败：同一会话的下一条消息重试一次，管理员刚绑定后
      // 不需要用户先 /new 才能生效。
      existing.state = {
        status: 'resolving',
        sessionId: event.sessionId,
        senderId: event.senderId,
        botId: event.botId,
        updatedAt: this.now(),
      }
      existing.actor = undefined
      this.recordSender(event, 'resolving')
      this.applyActor(event.sessionId, PENDING_ACTOR)
      void this.resolve(existing)
      return
    }
    const state: IdentitySessionState = {
      status: 'resolving',
      sessionId: event.sessionId,
      senderId: event.senderId,
      botId: event.botId,
      updatedAt: this.now(),
    }
    const entry: PendingEntry = { event, state }
    this.pending.set(event.sessionId, entry)
    this.recordSender(event, 'resolving')
    // 先 fail closed：即使 resolve 还没回来，本 Session 的 MCP 调用也不会用服务账号 token。
    this.applyActor(event.sessionId, PENDING_ACTOR)
    void this.resolve(entry)
  }

  /**
   * 解析成功后写凭据并替换 actor；失败保留占位 actor。
   * @param entry - 本次绑定的内存记录。
   */
  private async resolve(entry: PendingEntry): Promise<void> {
    const { event } = entry
    const baseToken = await this.resolveBaseToken()
    if (baseToken === undefined) {
      this.fail(entry, 'SERVICE_CREDENTIAL_MISSING', '机器人工作区缺少 DataOps 服务账号凭据，身份解析不可用。')
      return
    }
    const remoteBotId = await this.resolveRemoteBotId(event.botId)
    entry.remoteBotId = remoteBotId
    this.recordSender(event, 'resolving', { remoteBotId })
    let response: Response
    try {
      response = await (this.options.fetchImpl ?? globalThis.fetch)(new URL('/api/im/identity/resolve', this.options.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${baseToken}`,
        },
        body: JSON.stringify({
          botId: remoteBotId,
          senderId: event.senderId,
          sessionId: event.sessionId,
        }),
        signal: AbortSignal.timeout(8_000),
      })
    } catch (error) {
      this.fail(entry, 'IDENTITY_SERVICE_UNREACHABLE', `身份服务不可达：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const body = await readJson(response)
    if (!response.ok) {
      this.fail(entry, `IDENTITY_SERVICE_HTTP_${response.status}`, explicitMessage(body) ?? `身份服务返回 HTTP ${response.status}`)
      return
    }
    if (body?.decision !== 'bound') {
      const reason = typeof body?.reason === 'string' ? body.reason : 'IDENTITY_NOT_BOUND'
      const message = typeof body?.message === 'string' && body.message !== ''
        ? body.message
        : '该企业微信用户尚未绑定万相账号，请联系管理员绑定后重试。'
      this.fail(entry, reason, message)
      return
    }
    if (typeof body.token !== 'string' || body.token === '' || typeof body.actor !== 'object' || body.actor === null) {
      this.fail(entry, 'IDENTITY_SERVICE_INVALID', '身份服务返回了不完整的 actor/token。')
      return
    }

    const ref = credentialRef(scopedCredentialRef(this.options.credentialRef, event.sessionId))
    try {
      await this.ctx.credentials.set(ref, body.token)
    } catch (error) {
      this.fail(entry, 'SCOPED_CREDENTIAL_FAILED', `scoped 凭据写入失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }

    if (this.disposed) return
    const actor = body.actor as Record<string, unknown>
    entry.state = {
      status: 'bound',
      sessionId: event.sessionId,
      senderId: event.senderId,
      botId: event.botId,
      actorUserId: typeof actor['userId'] === 'string' ? actor['userId'] : (typeof body.user?.id === 'string' ? body.user.id : ''),
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : '',
      updatedAt: this.now(),
    }
    entry.actor = actor
    this.recordSender(event, 'bound', { actorUserId: entry.state.actorUserId, remoteBotId })
    this.applyActor(event.sessionId, actor)
    this.options.logger.info?.(
      `[dataops-im] identity bound session=${event.sessionId} actor=${String(entry.state.actorUserId)} provider=wecom`,
    )
  }

  /**
   * 把 dsh-im 的内部 botId（`wecom_<hash>`）映射成 DataOps `im_bots.bot_id` 的远端 Bot ID。
   *
   * dsh-im 的 `session-pre-bind` 载荷里的 `botId` 是它自己的配置主键，不是企微后台的
   * Bot ID；DataOps resolve 按企微后台 Bot ID 查登记。两者不转换会让真实消息稳定得到
   * `404 IM 机器人未登记`，即使管理员已经完成绑定。映射只从连接器自己的 dsh-im 配置读取，
   * 读取失败时保持原值并按 fail-closed 处理。
   *
   * @param internalBotId - 事件里的 dsh-im botId。
   * @returns DataOps 登记的远端 Bot ID；无映射时返回原值。
   */
  private async resolveRemoteBotId(internalBotId: string): Promise<string> {
    const cached = this.remoteBotIds.get(internalBotId)
    if (cached !== undefined) return cached
    if (!internalBotId.startsWith('wecom_')) {
      this.remoteBotIds.set(internalBotId, internalBotId)
      return internalBotId
    }
    const home = this.options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
    try {
      const raw = await readFile(join(home, 'integrations', 'dsh-wecom', 'config.json'), 'utf8')
      const parsed = JSON.parse(raw) as { bots?: { botId?: unknown; remoteBotId?: unknown }[] }
      for (const bot of Array.isArray(parsed.bots) ? parsed.bots : []) {
        if (bot.botId !== internalBotId || typeof bot.remoteBotId !== 'string' || bot.remoteBotId === '') continue
        this.remoteBotIds.set(internalBotId, bot.remoteBotId)
        return bot.remoteBotId
      }
    } catch {
      // dsh-im 尚未落盘配置或当前不是 WeCom 通道：保持原值，让 resolve 明确失败。
    }
    this.remoteBotIds.set(internalBotId, internalBotId)
    return internalBotId
  }

  /** 读取工作区服务账号 JWT；不打印值。 */
  private async resolveBaseToken(): Promise<string | undefined> {
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(this.options.credentialRef))
      return resolved?.value === undefined || resolved.value === '' ? undefined : resolved.value
    } catch {
      return undefined
    }
  }

  /** 写入失败状态并保留占位 actor。 */
  private fail(entry: PendingEntry, reason: string, message: string): void {
    if (this.disposed) return
    const status: IdentitySessionState['status'] =
      reason.startsWith('SERVICE_CREDENTIAL') || reason.startsWith('IDENTITY_SERVICE') ? 'unavailable' : 'unmapped'
    entry.state = {
      status,
      sessionId: entry.event.sessionId,
      senderId: entry.event.senderId,
      botId: entry.event.botId,
      reason,
      message,
      updatedAt: this.now(),
    }
    this.recordSender(entry.event, status, {
      reason,
      message,
      ...(entry.remoteBotId === undefined ? {} : { remoteBotId: entry.remoteBotId }),
    })
    // 重要：不删除占位 actor，也不写 scoped 槽。MCP 解析会因槽不存在而拒绝请求。
    this.applyActor(entry.event.sessionId, PENDING_ACTOR)
    this.options.logger.warn(`[dataops-im] identity not bound session=${entry.event.sessionId} reason=${reason}`)
  }

  /** 会话创建事件：把 pending 里的身份同步落到 Session。 */
  private onSessionCreated(session: { id?: unknown }): void {
    const sessionId = typeof session.id === 'string' ? session.id : ''
    if (sessionId === '') return
    const entry = this.pending.get(sessionId)
    if (entry !== undefined) {
      if (entry.state.status === 'bound' && entry.actor !== undefined) {
        this.applyActor(sessionId, entry.actor)
        return
      }
      this.applyActor(sessionId, PENDING_ACTOR)
      return
    }
    // 重启后 Session 仍在、pre-bind 不会重放：用 dsh-im 的只读反查补一次身份。
    void this.reconcile(sessionId)
  }

  /**
   * 对账一个已存在但没有 pending 的 Session。
   *
   * dsh-im 只在“对话→会话”绑定变化时发 `session-pre-bind`；进程重启后，已绑定的会话
   * 再次收到消息时不会重发事件。此时 Session.actor 已丢，必须从 dsh-im 的只读状态里
   * 取回 senderId 并重新解析，否则本次工具调用会回落到工作区服务账号 token。
   * @param sessionId - 刚创建/恢复的 DSH 会话。
   */
  private async reconcile(sessionId: string): Promise<void> {
    const dshIm = (this.ctx as unknown as { get?(name: string): unknown }).get?.('dshIm') as
      | { describeConversation?(id: string): Promise<ImSessionBindEvent | null> }
      | undefined
    if (dshIm === undefined || typeof dshIm.describeConversation !== 'function') return
    let info: ImSessionBindEvent | null
    try {
      info = await dshIm.describeConversation(sessionId)
    } catch {
      return
    }
    if (info === null || typeof info.senderId !== 'string' || info.senderId === '') return
    if (typeof info.botId !== 'string' || info.botId === '') return
    if (this.pending.has(sessionId)) return
    this.onPreBind({ ...info, sessionId })
  }

  /** 解绑：删除 scoped 槽；旧 token 服务端仍有效，但本会话不再持有。 */
  private async onUnbind(raw: ImSessionBindEvent): Promise<void> {
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
    if (sessionId === '') return
    this.pending.delete(sessionId)
    await this.ctx.credentials.unset(credentialRef(scopedCredentialRef(this.options.credentialRef, sessionId))).catch(() => undefined)
  }

  /** 给已存在的 Session 换 actor；Session 尚未创建时留待 `session/created`。 */
  private applyActor(sessionId: string, actor: unknown): void {
    if (actor === undefined) return
    const session = this.sessionOf(sessionId) as { actor?: unknown } | undefined
    if (session === undefined) return
    // 整体替换，不原地改字段：内核把 actor 当作不可变快照。
    session.actor = actor
  }

  /** 从宿主取 Session，避免依赖具体 Session 类型。 */
  private sessionOf(sessionId: string): unknown {
    const sessions = (this.ctx as unknown as { sessions?: { get(id: unknown): unknown } }).sessions
    if (sessions === undefined) return undefined
    try {
      return sessions.get(sessionId)
    } catch {
      return undefined
    }
  }

  /** 记录/更新一条管理员可见的发送者状态；不保存任何 token。 */
  private recordSender(
    event: RequiredBindEvent,
    status: IdentitySessionState['status'],
    extra: { reason?: string; message?: string; actorUserId?: string; remoteBotId?: string } = {},
  ): void {
    if (this.disposed) return
    const key = `${event.botId}\u0000${event.senderId}`
    const previous = this.senders.get(key)
    const record: PendingSender = {
      sessionId: event.sessionId,
      botId: event.botId,
      ...(extra.remoteBotId === undefined && previous?.remoteBotId === undefined
        ? {}
        : { remoteBotId: extra.remoteBotId ?? previous?.remoteBotId }),
      senderId: event.senderId,
      senderName: event.senderName ?? previous?.senderName ?? null,
      chatType: event.chatType ?? previous?.chatType ?? null,
      status,
      bound: status === 'bound',
      unmapped: status === 'unmapped',
      ...(extra.reason === undefined ? {} : { reason: extra.reason }),
      ...(extra.message === undefined ? {} : { message: extra.message }),
      ...(extra.actorUserId === undefined ? {} : { actorUserId: extra.actorUserId }),
      updatedAt: this.now(),
    }
    this.senders.set(key, record)
    this.trimSenders()
  }

  /** 清理过期发送者并限制内存条数；列表上限仍在 `listPending` 里单独执行。 */
  private trimSenders(): void {
    const now = this.now()
    for (const [key, record] of this.senders) {
      if (now - record.updatedAt > SENDER_TTL_MS) this.senders.delete(key)
    }
    if (this.senders.size <= SENDER_STORE_LIMIT) return
    const keep = [...this.senders.entries()]
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, SENDER_STORE_LIMIT)
    this.senders.clear()
    for (const [key, record] of keep) this.senders.set(key, record)
  }

  /** 清理超时未绑定的 pending，防止孤立条目。 */
  private gc(): void {
    const now = this.now()
    for (const [sessionId, entry] of this.pending) {
      if (now - entry.state.updatedAt < PENDING_TTL_MS) continue
      this.pending.delete(sessionId)
    }
    this.trimSenders()
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}

interface RequiredBindEvent {
  sessionId: string
  botId: string
  senderId: string
  senderName: string | null
  chatType: string | null
}

interface PendingEntry {
  event: RequiredBindEvent
  state: IdentitySessionState
  /** resolve 前解析出的 DataOps remoteBotId，供失败记录展示/诊断。 */
  remoteBotId?: string
  /** 解析成功后的真实 actor；`session/created` 晚于 resolve 时用它。 */
  actor?: Record<string, unknown>
}

/** 把事件载荷折成必有字段；缺少任一鉴权字段返回 undefined（fail closed）。 */
function normalizeEvent(raw: ImSessionBindEvent): RequiredBindEvent | undefined {
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
  const botId = typeof raw.botId === 'string' ? raw.botId.trim() : ''
  const senderId = typeof raw.senderId === 'string' ? raw.senderId.trim() : ''
  if (sessionId === '' || botId === '' || senderId === '') return undefined
  return {
    sessionId,
    botId,
    senderId,
    senderName: optionalText(raw.senderName, 120),
    chatType: optionalText(raw.chatType, 32),
  }
}

/** 取一个裁剪后的可选短文本；空串按缺失处理，防止管理面出现空白行。 */
function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed.slice(0, maxLength)
}

/** 发送者 id 的脱敏展示：保留首尾，中间固定星号，不泄漏完整通讯录 userid。 */
export function maskSenderId(senderId: string): string {
  if (senderId.length <= 2) return '*'.repeat(senderId.length)
  if (senderId.length <= 6) return `${senderId[0]}${'*'.repeat(senderId.length - 2)}${senderId[senderId.length - 1]}`
  return `${senderId.slice(0, 2)}${'*'.repeat(Math.min(8, senderId.length - 4))}${senderId.slice(-2)}`
}

/** 读 JSON；非 JSON 返回 undefined。 */
async function readJson(response: Response): Promise<ResolveResponse | undefined> {
  try {
    const value = await response.json() as unknown
    return value !== null && typeof value === 'object' ? value as ResolveResponse : undefined
  } catch {
    return undefined
  }
}

/** 从 Nest 错误体里取一句可读消息。 */
function explicitMessage(body: ResolveResponse | undefined): string | undefined {
  const message = body?.message
  if (typeof message === 'string' && message !== '') return message
  return undefined
}