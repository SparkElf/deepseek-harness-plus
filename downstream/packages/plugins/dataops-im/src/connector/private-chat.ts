/**
 * 企微私聊 → 用户默认工作区会话。
 *
 * dsh-im 的通道层把私聊和群聊都绑定到机器人工作区的本地 Session；产品要求私聊落在提问者
 * 自己的 DataOps 默认工作区。这里用 dsh-im 支持的 `config.internals.Runtime` 接缝换入一个
 * Runtime 子类，只改写 `chattype === 'single'` 的入站消息：
 *
 * 1. connector → `POST /api/im/private-sessions/resolve`（机器人服务账号凭据）拿到用户
 *    工作区里的稳定 session 与一枚 `sub=用户` 的短时 token；
 * 2. connector → `POST /api/ai/sessions/:id/messages` 把消息投递进去；
 * 3. 轮询同一 session 的最近消息，把 agent 的最终回复发回企微私聊。
 *
 * 群聊完全走原来的 `WecomHarnessBridge.accept`，不经过这里；解析失败时 fail closed，
 * 不会回落到机器人工作区的本地会话。
 *
 * @module connector/private-chat
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { HistorySyncConfig } from './history-sync.ts'
import {
  renderAssistantReply,
  sanitizeGenUiPreview,
  stripGenUiFences,
  type RenderedReply,
  type ReplySegment,
} from './render-policy.ts'
import { toolProgressText } from './tool-progress.ts'

/** 私聊路由需要的宿主能力。 */
export interface PrivateChatHost {
  /** 宿主任意上下文，用来读取机器人服务账号 credential。 */
  readonly ctx: Context
  /** DataOps API origin（不含 `/api`）。 */
  readonly baseUrl: string
  /** 工作区 JWT 的凭据名。 */
  readonly credentialRef: string
  /** 日志；只允许记录 id/原因，不允许记录 token。 */
  readonly logger: { info?(message: string): void; warn(message: string): void; error?(message: string): void }
  /** 测试注入点；生产走 globalThis.fetch。 */
  readonly fetchImpl?: typeof fetch
  /** 测试注入点；生产走 Date.now。 */
  readonly now?: () => number
  /** 群历史同步配置；缺省关闭，实时 @ 链路不受影响。 */
  readonly historySync?: HistorySyncConfig
}

/** 一个用户的稳定绑定。token 只在内存里，不落盘、不打印。 */
interface PrivateBinding {
  readonly userId: string
  readonly workspaceId: number
  readonly dshSessionId: string
  readonly title: string
  readonly token: string
  readonly expiresAt: number
}

/** resolve 不可用时的显式错误；`code` 用于日志，`message` 可以回给用户。 */
export class PrivateChatError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PrivateChatError'
  }
}

/** 私聊执行心跳；只暴露阶段，不含工具名/参数。 */
export interface PrivateChatHeartbeat {
  readonly elapsedMs: number
  readonly polls: number
  readonly sawTool: boolean
  /** 当前工具名；只用于阶段文案，不展示参数。 */
  readonly toolName?: string
}

/** 轮询参数。 */
const POLL_INTERVAL_MS = 1_500
const MAX_WAIT_MS = 10 * 60 * 1000
/** turn 结束后 assistant 事件可能晚到；最多再等 15s（约 10 轮）。 */
const EMPTY_REPLY_GRACE_MS = 15_000
/** 私聊进度心跳；只更新文案，不传工具参数。 */
const HEARTBEAT_INTERVAL_MS = 5_000
const TOKEN_REFRESH_MARGIN_MS = 60_000
const RESOLVE_TIMEOUT_MS = 180_000
const PROMPT_TIMEOUT_MS = 30_000
const MAX_REPLY_BYTES = 6_000

/** 已构造过的私聊 Runtime（仅诊断用：bot 脱敏 id + 时间，不含任何凭据）。 */
const installedRuntimes = new Map<string, number>()

/** 读取 connector 进程里已构造的私聊 Runtime；供状态路由与证据脚本使用。 */
export function privateChatRuntimeStatus(): { botIdMasked: string; installedAt: number }[] {
  return [...installedRuntimes.entries()].map(([botIdMasked, installedAt]) => ({ botIdMasked, installedAt }))
}

/**
 * 把一条消息按 UTF-8 字节上限切块，避免企微单条消息超限。
 * @param text - 完整回复。
 * @param maxBytes - 单块上限。
 */
export function splitUtf8Bytes(text: string, maxBytes = MAX_REPLY_BYTES): string[] {
  if (text === '') return []
  const chunks: string[] = []
  let current = ''
  let bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes && current !== '') {
      chunks.push(current)
      current = ''
      bytes = 0
    }
    current += char
    bytes += size
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/**
 * 私聊会话路由器：负责 resolve、投递和等待最终回复。
 *
 * 绑定按 `botId + 企微 userid` 缓存；token 过期前复用，投递遇到会话丢失时失效缓存并重建一次。
 */
export class PrivateChatRouter {
  private readonly bindings = new Map<string, PrivateBinding>()

  constructor(
    private readonly host: PrivateChatHost,
    private readonly botId: string,
  ) {}

  /** 清掉一个用户的缓存（测试/诊断用）。 */
  forget(senderId: string): void {
    this.bindings.delete(this.bindingKey(senderId))
  }

  /**
   * 投递一条私聊消息并等待 agent 的最终文本。
   *
   * @param input.senderId - 企微 userid。
   * @param input.senderName - 可选姓名，仅首次自动建号时使用。
   * @param input.text - 用户消息。
   * @param input.onUpdate - 有新的可展示文本时回调（做流式预览用）。
   * @param input.onHeartbeat - 每 5s 的心跳；只给阶段文案，不含工具参数。
   * @returns agent 的最终可见文本。
   */
  async ask(input: {
    senderId: string
    senderName?: string
    text: string
    onUpdate?: (text: string) => void
    onHeartbeat?: (info: PrivateChatHeartbeat) => void
  }): Promise<string> {
    const binding = await this.binding(input.senderId, input.senderName)
    try {
      return await this.deliver(binding, input)
    } catch (error) {
      if (!isRecoverableBindingError(error)) throw error
      // 会话被用户删除/工作区卷重建：丢掉缓存，按当前工作区重建一次。
      this.forget(input.senderId)
      const rebuilt = await this.binding(input.senderId, input.senderName)
      return this.deliver(rebuilt, input)
    }
  }

  /** 读取或刷新绑定。 */
  private async binding(senderId: string, senderName?: string): Promise<PrivateBinding> {
    const key = this.bindingKey(senderId)
    const cached = this.bindings.get(key)
    const now = this.now()
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return cached

    const serviceToken = await this.serviceCredential()
    const response = await this.request('/api/im/private-sessions/resolve', {
      method: 'POST',
      token: serviceToken,
      body: {
        botId: this.botId,
        senderId,
        wecomUserId: senderId,
        ...(senderName === undefined ? {} : { senderName }),
      },
      timeoutMs: RESOLVE_TIMEOUT_MS,
    })
    const body = await response.json().catch(() => undefined) as {
      decision?: unknown
      reason?: unknown
      message?: unknown
      userId?: unknown
      workspaceId?: unknown
      dshSessionId?: unknown
      title?: unknown
      token?: unknown
      expiresAt?: unknown
    } | undefined
    if (!response.ok) {
      throw new PrivateChatError(
        `PRIVATE_SESSION_HTTP_${String(response.status)}`,
        explicitMessage(body) ?? `私聊会话解析失败（HTTP ${String(response.status)}）`,
      )
    }
    if (body?.decision !== 'bound') {
      throw new PrivateChatError(
        typeof body?.reason === 'string' ? body.reason : 'PRIVATE_SESSION_UNMAPPED',
        explicitMessage(body) ?? '该企业微信用户暂时无法创建私聊会话，请联系管理员。',
      )
    }
    if (
      typeof body.userId !== 'string' || body.userId === ''
      || typeof body.dshSessionId !== 'string' || body.dshSessionId === ''
      || typeof body.token !== 'string' || body.token === ''
      || typeof body.workspaceId !== 'number'
    ) {
      throw new PrivateChatError('PRIVATE_SESSION_INVALID', '私聊会话解析返回了不完整的绑定。')
    }
    const expiresAt = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : Number.NaN
    const binding: PrivateBinding = {
      userId: body.userId,
      workspaceId: body.workspaceId,
      dshSessionId: body.dshSessionId,
      title: typeof body.title === 'string' ? body.title : '',
      token: body.token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + 30 * 60_000,
    }
    this.bindings.set(key, binding)
    this.host.logger.info?.(
      `[dataops-im] private chat bound sender=${mask(senderId)} user=${binding.userId} workspace=${String(binding.workspaceId)} session=${binding.dshSessionId}`,
    )
    return binding
  }

  /** 投递消息并等待回复。 */
  private async deliver(
    binding: PrivateBinding,
    input: {
      text: string
      onUpdate?: (text: string) => void
      onHeartbeat?: (info: PrivateChatHeartbeat) => void
    },
  ): Promise<string> {
    const text = input.text
    const baseSeq = await this.lastSeq(binding)
    const prompt = await this.request(`/api/ai/sessions/${encodeURIComponent(binding.dshSessionId)}/messages`, {
      method: 'POST',
      token: binding.token,
      body: { text, mode: 'queue' },
      timeoutMs: PROMPT_TIMEOUT_MS,
    })
    if (!prompt.ok) {
      const body = await prompt.json().catch(() => undefined)
      throw new PrivateChatError(
        `PRIVATE_PROMPT_HTTP_${String(prompt.status)}`,
        explicitMessage(body as { message?: unknown } | undefined) ?? '消息投递失败，请稍后重试。',
      )
    }

    const startedAt = this.now()
    let lastText = ''
    let polls = 0
    let started = false
    let endedAt: number | undefined
    let sawTool = false
    let currentTool: string | undefined
    let lastHeartbeatAt = startedAt
    while (this.now() - startedAt < MAX_WAIT_MS) {
      await sleep(POLL_INTERVAL_MS)
      polls += 1
      const [messages, running] = await Promise.all([
        this.lastMessages(binding, 200),
        this.isRunning(binding),
      ])
      const answer = lastAssistantText(messages, baseSeq)
      if (answer !== '' && answer !== lastText) {
        lastText = answer
        input.onUpdate?.(answer)
      }
      let latestTool: string | undefined
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!
        if (message.seq > baseSeq && message.role === 'tool' && message.toolName !== undefined) {
          latestTool = message.toolName
          break
        }
      }
      if (latestTool !== undefined) {
        sawTool = true
        currentTool = latestTool
      }
      const nowMs = this.now()
      if (nowMs - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
        lastHeartbeatAt = nowMs
        input.onHeartbeat?.({
          elapsedMs: nowMs - startedAt,
          polls,
          sawTool,
          ...(currentTool === undefined ? {} : { toolName: currentTool }),
        })
      }
      // prompt 被接受后 running 可能短暂为 false（turn 尚未开始），不能据此提前返回空回复。
      const userSeen = messages.some((message) => message.seq > baseSeq && message.role === 'user')
      if (running || userSeen) started = true
      if (!started) {
        if (polls >= 20) {
          throw new PrivateChatError(
            'PRIVATE_SESSION_NOT_STARTED',
            'Agent 没有开始处理这条消息，请稍后重试或检查工作区模型配置。',
          )
        }
        continue
      }
      if (!running) {
        // turn 已结束：assistant 事件可能比 running=false 晚几百毫秒到数秒写入。
        // 有文本立即返回；空文本最多再等 15s，避免把纯 dsh-ui/图片答案丢掉。
        endedAt ??= nowMs
        if (answer !== '') return answer
        if (nowMs - endedAt >= EMPTY_REPLY_GRACE_MS) return lastText
        continue
      }
      endedAt = undefined
    }
    if (lastText !== '') return lastText
    throw new PrivateChatError('PRIVATE_SESSION_TIMEOUT', 'Agent 处理超时，请稍后重试。')
  }

  /** 读取会话最后一条消息的 seq，作为本次提问的起点。 */
  private async lastSeq(binding: PrivateBinding): Promise<number> {
    const messages = await this.lastMessages(binding, 1)
    return messages.at(-1)?.seq ?? -1
  }

  /** 读取会话最近消息；失败时抛可恢复错误。 */
  private async lastMessages(
    binding: PrivateBinding,
    limit: number,
  ): Promise<{ seq: number; role: string; text: string; toolName?: string }[]> {
    const response = await this.request(
      `/api/ai/sessions/${encodeURIComponent(binding.dshSessionId)}/messages?limit=${String(limit)}`,
      { method: 'GET', token: binding.token, timeoutMs: 15_000 },
    )
    if (!response.ok) {
      throw new PrivateChatError(
        `PRIVATE_MESSAGES_HTTP_${String(response.status)}`,
        '读取会话消息失败。',
      )
    }
    const body = await response.json().catch(() => undefined) as { messages?: unknown } | undefined
    if (!Array.isArray(body?.messages)) return []
    return body.messages.flatMap((item) => {
      const record = item as { seq?: unknown; role?: unknown; text?: unknown; toolName?: unknown }
      return typeof record.seq === 'number'
        ? [{
            seq: record.seq,
            role: typeof record.role === 'string' ? record.role : '',
            text: typeof record.text === 'string' ? record.text : '',
            ...(typeof record.toolName === 'string' && record.toolName !== ''
              ? { toolName: record.toolName }
              : {}),
          }]
        : []
    })
  }

  /** 查询会话是否仍在跑一轮。 */
  private async isRunning(binding: PrivateBinding): Promise<boolean> {
    const response = await this.request('/api/ai/sessions', {
      method: 'GET',
      token: binding.token,
      timeoutMs: 15_000,
    })
    if (!response.ok) return false
    const body = await response.json().catch(() => undefined) as { sessions?: unknown } | undefined
    if (!Array.isArray(body?.sessions)) return false
    const match = body.sessions.find(
      (item) => (item as { sessionId?: unknown }).sessionId === binding.dshSessionId,
    )
    return (match as { running?: unknown } | undefined)?.running === true
  }

  /** 机器人服务账号 credential；缺失时 fail closed。 */
  private async serviceCredential(): Promise<string> {
    try {
      const credentials = (this.host.ctx as unknown as {
        credentials?: { resolve(ref: unknown): Promise<{ value?: string } | undefined> }
      }).credentials
      const resolved = await credentials?.resolve(this.host.credentialRef)
      const value = resolved?.value
      if (typeof value !== 'string' || value === '') {
        throw new PrivateChatError('SERVICE_CREDENTIAL_MISSING', '机器人工作区缺少 DataOps 服务账号凭据，无法创建私聊会话。')
      }
      return value
    } catch (error) {
      if (error instanceof PrivateChatError) throw error
      throw new PrivateChatError('SERVICE_CREDENTIAL_MISSING', '机器人工作区缺少 DataOps 服务账号凭据，无法创建私聊会话。')
    }
  }

  /** 一次带 bearer 的 DataOps 请求。 */
  private async request(
    path: string,
    options: { method: 'GET' | 'POST'; token: string; body?: unknown; timeoutMs: number },
  ): Promise<Response> {
    try {
      return await (this.host.fetchImpl ?? globalThis.fetch)(new URL(path, this.host.baseUrl), {
        method: options.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(options.timeoutMs),
      })
    } catch (error) {
      throw new PrivateChatError(
        'PRIVATE_SESSION_UNREACHABLE',
        `DataOps 私聊服务不可达：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private now(): number {
    return (this.host.now ?? Date.now)()
  }

  private bindingKey(senderId: string): string {
    return `${this.botId}\u0000${senderId}`
  }
}

/** 从消息记录里取本次提问之后最后一条非空 assistant 文本。 */
function lastAssistantText(
  messages: readonly { seq: number; role: string; text: string }[],
  afterSeq: number,
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.seq > afterSeq && message.role === 'assistant' && message.text.trim() !== '') {
      return message.text
    }
  }
  return ''
}

/** 这些错误意味着缓存绑定不可再用，值得按当前工作区重建一次。 */
function isRecoverableBindingError(error: unknown): boolean {
  if (!(error instanceof PrivateChatError)) return false
  return error.code === 'PRIVATE_PROMPT_HTTP_404'
    || error.code === 'PRIVATE_PROMPT_HTTP_503'
    || error.code === 'PRIVATE_MESSAGES_HTTP_404'
    || error.code === 'PRIVATE_MESSAGES_HTTP_503'
}

/** 从 Nest 错误体里取一句可读消息。 */
function explicitMessage(body: { message?: unknown } | undefined): string | undefined {
  const message = body?.message
  return typeof message === 'string' && message !== '' ? message : undefined
}

/** 脱敏 senderId（日志用）。 */
function mask(value: string): string {
  if (value.length <= 2) return '*'.repeat(value.length)
  return `${value.slice(0, 2)}***${value.slice(-2)}`
}

/** 简单等待。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ------------------------------------------------------------------ */
/* dsh-im Runtime/Bridge 接缝                                          */
/* ------------------------------------------------------------------ */

/** 只声明我们用到的 dsh-im 结构。 */
interface DshImBridge {
  accept(frame: unknown): Promise<void>
  acceptEvent(frame: unknown): Promise<void>
  waitForIdle(): Promise<void>
  status: unknown
  presentSessionSyncApproval(...args: unknown[]): Promise<boolean>
}

interface DshImRuntime {
  start(): Promise<unknown>
  stop(): Promise<unknown>
}

interface DshImModule {
  WecomRuntime: new (options: Record<string, unknown>) => DshImRuntime
  WecomHarnessBridge: new (options: Record<string, unknown>) => DshImBridge
}

/** 读取 dsh-im 的内部模块（pin 版本固定，exports 未导出子路径，只能按包根解析）。 */
async function loadDshImInternals(): Promise<DshImModule> {
  const require = createRequire(import.meta.url)
  const pkgPath = require.resolve('@xmanrui/dsh-im/package.json')
  const root = dirname(pkgPath)
  const [runtime, bridge] = await Promise.all([
    import(pathToFileURL(join(root, 'src/channels/wecom/wecom-runtime.mjs')).href) as Promise<{
      WecomRuntime: DshImModule['WecomRuntime']
    }>,
    import(pathToFileURL(join(root, 'src/channels/wecom/wecom-bridge.mjs')).href) as Promise<{
      WecomHarnessBridge: DshImModule['WecomHarnessBridge']
    }>,
  ])
  return { WecomRuntime: runtime.WecomRuntime, WecomHarnessBridge: bridge.WecomHarnessBridge }
}

/** 私聊 handler 依赖。 */
export interface DirectChatDeps {
  readonly client: {
    replyStream(
      frame: unknown,
      streamId: string,
      content: string,
      finish: boolean,
      msgItem?: unknown[],
    ): Promise<unknown>
    sendMessage(chatId: string, content: unknown): Promise<unknown>
    /** 主动图片/文件消息；dsh-im 的 WSClient 提供，测试可省略。 */
    uploadMedia?(bytes: Uint8Array, options: { type: 'image' | 'file'; filename: string }): Promise<{ media_id?: string }>
    sendMediaMessage?(chatId: string, mediaType: 'image' | 'file', mediaId: string): Promise<unknown>
  }
  readonly state: { hasSeen(id: string): boolean; markSeen(id: string): Promise<unknown> | unknown }
  readonly router: PrivateChatRouter
  readonly logger: { warn(message: string): void; info?(message: string): void }
  readonly signal?: AbortSignal
  /** 测试注入点；生产走 render-policy。 */
  readonly renderReply?: typeof renderAssistantReply
}

/** 一对一消息处理器的公开形状。 */
export interface DirectChatHandler {
  handle(frame: unknown): Promise<void>
  waitForIdle(): Promise<void>
}

/** 一条私聊消息的归一化字段。 */
interface DirectMessage {
  readonly frame: unknown
  readonly messageId: string
  readonly senderId: string
  readonly senderName: string
  readonly text: string
}

/**
 * 创建只处理 `chattype === 'single'` 的入站处理器；群聊由调用方交回原 bridge。
 * @param deps - WeCom 客户端、会话状态、私聊路由器。
 */
export function createDirectChatHandler(deps: DirectChatDeps): DirectChatHandler {
  const queues = new Map<string, Promise<void>>()
  const inFlight = new Set<Promise<void>>()
  const handled = new WeakSet<object>()

  async function run(message: DirectMessage): Promise<void> {
    if (deps.signal?.aborted === true) return
    const streamId = `private_${randomUUID()}`
    let streamStarted = false
    let progressClosed = false
    let heartbeatEnabled = true
    let progressSeq = 0
    let finalSent = false
    let progressChain: Promise<void> = Promise.resolve()
    let lastProgressText = ''

    /** 同一 replyStream 串行更新进度；完成/失败后不再覆盖最终帧。 */
    const pushProgress = (text: string): void => {
      if (!streamStarted || progressClosed) return
      const line = splitUtf8Bytes(text)[0] ?? ''
      if (line.trim() === '' || line === lastProgressText) return
      lastProgressText = line
      progressSeq += 1
      const seq = progressSeq
      progressChain = progressChain
        .then(async () => {
          if (!streamStarted || progressClosed) return
          try {
            await deps.client.replyStream(message.frame, streamId, line, false)
            deps.logger.info?.(`[dataops-im] private chat progress seq=${String(seq)} chars=${String(line.length)}`)
          } catch {
            streamStarted = false
          }
        })
        .catch(() => undefined)
    }
    const closeProgress = async (): Promise<void> => {
      progressClosed = true
      heartbeatEnabled = false
      await progressChain
    }

    try {
      if (message.text === '') {
        await sendFinal(deps.client, message.frame, message.senderId, '私聊暂时只支持文字消息。')
        await safeMarkSeen(deps.state, message.messageId)
        return
      }
      try {
        await deps.client.replyStream(message.frame, streamId, '已收到，正在执行…', false)
        streamStarted = true
        lastProgressText = '已收到，正在执行…'
      } catch {
        // 预览失败不影响最终回复。
      }
      await safeMarkSeen(deps.state, message.messageId)
      const answer = await deps.router.ask({
        senderId: message.senderId,
        ...(message.senderName === '' ? {} : { senderName: message.senderName }),
        text: message.text,
        onUpdate: streamStarted
          ? (preview) => {
              // 一旦有可展示的 assistant 文本，心跳立即停止，避免覆盖预览/最终内容。
              heartbeatEnabled = false
              // 流式预览同样不能把半截 dsh-ui JSON 刷给用户。
              pushProgress(sanitizeGenUiPreview(preview))
            }
          : undefined,
        onHeartbeat: streamStarted
          ? (info) => {
              if (!heartbeatEnabled) return
              const phase = info.toolName === undefined ? '正在执行…' : toolProgressText(info.toolName)
              const seconds = Math.max(1, Math.round(info.elapsedMs / 1000))
              pushProgress(`${phase}（已 ${String(seconds)}s）`)
            }
          : undefined,
      })
      await closeProgress()
      const rendered = await renderReplySafely(answer, deps.renderReply ?? renderAssistantReply)
      finalSent = true
      deps.logger.info?.(`[dataops-im] private chat final seq=1 chars=${String(rendered.segments.reduce((sum, segment) => sum + (segment.kind === 'text' ? segment.text.length : 0), 0))}`)
      await finishRenderedReply(
        deps.client,
        message.frame,
        message.senderId,
        streamId,
        streamStarted,
        rendered,
        deps.logger,
      )
    } catch (error) {
      await closeProgress().catch(() => undefined)
      if (finalSent) {
        deps.logger.warn(`[dataops-im] private chat post-final error sender=${mask(message.senderId)}`)
        return
      }
      const code = error instanceof PrivateChatError ? error.code : 'PRIVATE_CHAT_FAILED'
      const text = error instanceof PrivateChatError ? error.message : '处理失败，请稍后重试。'
      deps.logger.warn(`[dataops-im] private chat failed sender=${mask(message.senderId)} code=${code}`)
      await sendFinal(deps.client, message.frame, message.senderId, text).catch(() => undefined)
    }
  }

  return {
    handle(frame: unknown): Promise<void> {
      const message = readDirectMessage(frame)
      if (message === undefined) return Promise.resolve()
      if (frame !== null && typeof frame === 'object') {
        if (handled.has(frame)) return Promise.resolve()
        handled.add(frame)
      }
      if (safeHasSeen(deps.state, message.messageId)) return Promise.resolve()
      const previous = queues.get(message.senderId) ?? Promise.resolve()
      const task = previous
        .catch(() => undefined)
        .then(() => run(message))
        .finally(() => {
          if (queues.get(message.senderId) === task) queues.delete(message.senderId)
          inFlight.delete(task)
        })
      queues.set(message.senderId, task)
      inFlight.add(task)
      return task
    },
    async waitForIdle(): Promise<void> {
      await Promise.allSettled([...inFlight])
    },
  }
}

/** 读取 WeCom 帧里的私聊字段；不是私聊/结构不对返回 undefined。 */
function readDirectMessage(frame: unknown): DirectMessage | undefined {
  if (frame === null || typeof frame !== 'object') return undefined
  const body = (frame as { body?: unknown }).body
  if (body === null || typeof body !== 'object') return undefined
  const value = body as {
    chattype?: unknown
    msgid?: unknown
    msgtype?: unknown
    from?: { userid?: unknown; name?: unknown }
    text?: { content?: unknown }
  }
  if (value.chattype !== 'single') return undefined
  const messageId = textOf(value.msgid)
  const senderId = textOf(value.from?.userid)
  if (messageId === '' || senderId === '') return undefined
  return {
    frame,
    messageId,
    senderId,
    senderName: textOf(value.from?.name),
    text: textOf(value.text?.content),
  }
}

/** 安全读取对象里的字符串字段。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function safeHasSeen(state: DirectChatDeps['state'], messageId: string): boolean {
  try {
    return state.hasSeen(messageId)
  } catch {
    return false
  }
}

async function safeMarkSeen(state: DirectChatDeps['state'], messageId: string): Promise<void> {
  try {
    await state.markSeen(messageId)
  } catch {
    // 去重失败不应让用户丢掉回复。
  }
}

/**
 * 渲染失败也不能丢正文：退回删围栏后的纯文本，绝不把原始 JSON 发出去。
 */
async function renderReplySafely(
  answer: string,
  render: typeof renderAssistantReply,
): Promise<RenderedReply> {
  try {
    return await render(answer, { channel: 'wecom' })
  } catch {
    const text = stripGenUiFences(answer).trim()
    return {
      audience: 'sender_only',
      segments: text === '' ? [] : [{ kind: 'text', text }],
      hadGenUI: true,
      fallbackReason: 'render_failed',
    }
  }
}

/** 发送一条独立文本（非流式）；返回 replyStream 是否被接受（决定图片是否已内联）。 */
async function sendFinal(
  client: DirectChatDeps['client'],
  frame: unknown,
  chatId: string,
  text: string,
): Promise<boolean> {
  const chunks = splitUtf8Bytes(text)
  if (chunks.length === 0) return false
  try {
    await client.replyStream(frame, `private_${randomUUID()}`, chunks[0]!, true)
    for (const chunk of chunks.slice(1)) {
      await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: chunk } })
    }
    return true
  } catch {
    for (const chunk of chunks) {
      await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: chunk } })
    }
    return false
  }
}

/** 用预览流收尾；流不可用时退回主动消息。返回最终帧是否被 replyStream 接受。 */
async function finishStream(
  client: DirectChatDeps['client'],
  frame: unknown,
  chatId: string,
  streamId: string,
  streamStarted: boolean,
  text: string,
): Promise<boolean> {
  const chunks = splitUtf8Bytes(text)
  if (chunks.length === 0) return false
  if (streamStarted) {
    try {
      await client.replyStream(frame, streamId, chunks[0]!, true)
      for (const chunk of chunks.slice(1)) {
        await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: chunk } })
      }
      return true
    } catch {
      // 流过期时退回主动消息。
    }
  }
  return sendFinal(client, frame, chatId, text)
}

/** 上传并主动发送一张图片；返回明确失败原因（不记录图片内容/路径）。 */
async function sendImageSegment(
  client: DirectChatDeps['client'],
  chatId: string,
  png: Uint8Array,
  index: number,
): Promise<{ sent: boolean; reason?: string }> {
  if (typeof client.uploadMedia !== 'function' || typeof client.sendMediaMessage !== 'function') {
    return { sent: false, reason: 'client_media_unavailable' }
  }
  try {
    const uploaded = await client.uploadMedia(Buffer.from(png), {
      type: 'image',
      filename: `wanxiang-genui-${String(index)}.png`,
    })
    const mediaId = typeof uploaded?.media_id === 'string' ? uploaded.media_id : ''
    if (mediaId === '') return { sent: false, reason: 'missing_media_id' }
    await client.sendMediaMessage(chatId, 'image', mediaId)
    return { sent: true }
  } catch (error) {
    return {
      sent: false,
      reason: error instanceof Error && error.message !== '' ? error.message.slice(0, 120) : 'send_failed',
    }
  }
}

/**
 * 按 segment 顺序投递：正文和图片都不能丢。
 *
 * 企微实测会忽略 `replyStream` 最终帧里的 `msg_item` 内联图片；因此图片一律走
 * `uploadMedia` + `sendMediaMessage` 主动消息。先发正文，再逐张发图；失败退 alt 文本。
 */
async function finishRenderedReply(
  client: DirectChatDeps['client'],
  frame: unknown,
  chatId: string,
  streamId: string,
  streamStarted: boolean,
  rendered: RenderedReply,
  logger: DirectChatDeps['logger'],
): Promise<void> {
  try {
    await deliverRenderedReply(client, frame, chatId, streamId, streamStarted, rendered, logger)
  } catch (error) {
    logger.warn(
      `[dataops-im] private chat final delivery failed: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
    )
  }
}

/** 实际的 segment 投递循环；异常由 {@link finishRenderedReply} 收口，避免二次 final。 */
async function deliverRenderedReply(
  client: DirectChatDeps['client'],
  frame: unknown,
  chatId: string,
  streamId: string,
  streamStarted: boolean,
  rendered: RenderedReply,
  logger: DirectChatDeps['logger'],
): Promise<void> {
  const segments: ReplySegment[] = rendered.segments.filter(
    segment => segment.kind === 'image' || segment.text.trim() !== '',
  )
  if (segments.length === 0) segments.push({ kind: 'text', text: '（Agent 本次没有返回文本回复。）' })

  let textSent = false
  let imageIndex = 0
  for (const segment of segments) {
    if (segment.kind === 'text') {
      const chunks = splitUtf8Bytes(segment.text)
      if (chunks.length === 0) continue
      if (!textSent) {
        await finishStream(client, frame, chatId, streamId, streamStarted, chunks[0]!)
        textSent = true
        streamStarted = false
        for (const chunk of chunks.slice(1)) {
          await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: chunk } })
        }
        continue
      }
      for (const chunk of chunks) {
        await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: chunk } })
      }
      continue
    }

    imageIndex += 1
    if (!textSent) {
      // 纯图片回复也先给一条正文，再发主动图片；不能只发“结果如下”或只依赖内联。
      await finishStream(client, frame, chatId, streamId, streamStarted, '结果如下：')
      textSent = true
      streamStarted = false
    }
    const result = await sendImageSegment(client, chatId, segment.png, imageIndex)
    if (!result.sent) {
      logger.warn(
        `[dataops-im] private chat image fallback index=${String(imageIndex)} reason=${result.reason ?? 'unknown'}`,
      )
      await client
        .sendMessage(chatId, { msgtype: 'markdown', markdown: { content: `【图片发送失败】${segment.alt}` } })
        .catch(() => undefined)
    }
  }
  if (!textSent) await finishStream(client, frame, chatId, streamId, streamStarted, '（处理完成。）')
}

/** Runtime 子类构造参数里我们关心的字段。 */
interface RuntimeOptions extends Record<string, unknown> {
  config?: { remoteBotId?: unknown }
}

/**
 * 构造一个 Runtime 子类：保留 dsh-im 的全部连接/状态逻辑，只替换 Bridge 以接管私聊。
 *
 * 通过 `@xmanrui/dsh-im` 的 `config.internals.Runtime` 接缝注入；不修改上游源码。
 * @param host - DataOps 地址、凭据名与日志。
 */
export async function createPrivateChatRuntime(
  host: PrivateChatHost,
): Promise<new (options: RuntimeOptions) => DshImRuntime> {
  const { WecomRuntime, WecomHarnessBridge } = await loadDshImInternals()

  class PrivateChatBridge extends WecomHarnessBridge {
    private readonly direct: DirectChatHandler
    private readonly privateRouter: PrivateChatRouter

    constructor(options: Record<string, unknown>) {
      super(options)
      const botId = typeof options.botId === 'string' ? options.botId : ''
      this.privateRouter = new PrivateChatRouter(host, botId)
      this.direct = createDirectChatHandler({
        client: options.client as DirectChatDeps['client'],
        state: options.state as DirectChatDeps['state'],
        router: this.privateRouter,
        logger: host.logger,
        signal: options.signal as AbortSignal | undefined,
      })
    }

    accept(frame: unknown): Promise<void> {
      if (readDirectMessage(frame) !== undefined) return this.direct.handle(frame)
      return super.accept(frame)
    }

    async waitForIdle(): Promise<void> {
      await Promise.all([super.waitForIdle(), this.direct.waitForIdle()])
    }
  }

  return class PrivateChatRuntime extends WecomRuntime {
    constructor(options: RuntimeOptions) {
      const botId = typeof options.config?.remoteBotId === 'string' ? options.config.remoteBotId : ''
      const masked = botId === '' ? '-' : `***${botId.slice(-6)}`
      installedRuntimes.set(masked, Date.now())
      if (installedRuntimes.size > 20) {
        const oldest = installedRuntimes.keys().next().value
        if (oldest !== undefined) installedRuntimes.delete(oldest)
      }
      host.logger.info?.(`[dataops-im] private-chat runtime installed bot=${masked}`)
      super({
        ...options,
        createBridge: (bridgeOptions: Record<string, unknown>) => new PrivateChatBridge({
          ...bridgeOptions,
          botId,
        }),
      })
    }
  }
}