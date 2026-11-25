/**
 * 企微群聊 @ 机器人 → 全群共享 agent session + 按 turn 切换 sender actor。
 *
 * 方案 B：同一群的每条 @ 都在**同一个** DSH Session 里执行（持久键 `(botId, chatId)`），
 * 群成员共享上下文；但每个 turn 的工具体调用仍然使用当前发送者本人的 scoped JWT：
 *
 * 1. `POST /api/ai/chat/external/ingest` 用机器人服务账号把消息写入共享 room；
 * 2. `history.refreshRecent(chatId, 10)` 补拉最近 10 分钟群消息，拼进 prompt；
 * 3. 用 DSH Host 的 harness 在该群唯一的 Session 上投递 prompt；
 * 4. 投递前把 `session.actor` 与
 *    `DATAOPS_ACCESS_TOKEN_S_<SESSION_ID>` scoped 槽切成当前 sender（
 *    `/api/im/identity/resolve` 返回的 actor + token），turn 结束换回占位 actor，
 *    失败一律 fail closed，不回落到服务账号或上一位 sender；
 * 5. 结果由后端 `/replies` 裁决 audience：`room_safe` 回群并写 room，
 *    `sender_only` 只把完整结果私聊给 sender、群里只回 ack，且不切私聊 session。
 *
 * 同一群的消息由处理器按 `chatId` 串行；不同群可并行。私聊仍由 `private-chat.ts` 处理。
 *
 * @module connector/group-chat
 */

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  DirectChatDeps,
  DirectChatHandler,
  PrivateChatHost,
} from './private-chat.ts'
import {
  createDirectChatHandler,
  PrivateChatError,
  PrivateChatRouter,
  splitUtf8Bytes,
} from './private-chat.ts'
import { toolProgressFromUpdate } from './tool-progress.ts'
import {
  createDshGroupSessionBranches,
  createDshGroupTurnActors,
  resolveServiceCredential,
  type GroupSessionBranches,
  type GroupTurnActorGateway,
} from './group-turn-actor.ts'
import {
  createDshBranchLifecycle,
  type GroupBranchLifecycle,
} from './group-branch-lifecycle.ts'
import {
  ensureGroupHistorySync,
  formatWecomTime,
  historyCliInstalled,
  type GroupHistoryProvider,
} from './history-sync.ts'

/** 一轮群 turn 的最长等待；与私聊一致。 */
const MAX_WAIT_MS = 10 * 60 * 1000
/** sender actor token 复用余量；token 寿命 15 分钟。 */
const TOKEN_REFRESH_MARGIN_MS = 60_000
const RESOLVE_TIMEOUT_MS = 180_000
const PROMPT_TIMEOUT_MS = 30_000
const MAX_REPLY_BYTES = 6_000
/** @ 前补拉群历史最多等 1.8s；超时用缓存继续，后台跑完 delta。 */
const HISTORY_REFRESH_MAX_WAIT_MS = 1_800
/** @ 前只拉最近 10 分钟 delta，不跑 7 天全量。 */
const HISTORY_REFRESH_LOOKBACK_MINUTES = 10
/** 群聊进度卡文案；只放通用状态，不含个人数据。 */
const PROGRESS_RECEIVED = '已收到，正在处理…'
const PROGRESS_CONTEXT = '已读取最近群消息，正在整理上下文…'
const PROGRESS_EXECUTING = '正在执行…'
/** 单次企微投递（replyStream/sendMessage）超时；超时立即降级普通消息。 */
const DELIVERY_TIMEOUT_MS = 8_000

/** 群聊结果类型；与后端 `EXTERNAL_RESULT_TYPES` 对齐，避免拼错后落到 other。 */
export type ExternalResultType =
  | 'weekly_report'
  | 'meeting_notes'
  | 'public_knowledge'
  | 'data_query'
  | 'sql'
  | 'detail'
  | 'kb_file'
  | 'account'
  | 'credential'
  | 'other'

/** 群结果可见性。 */
export type GroupAudience = 'room_safe' | 'sender_only'

/** 群聊链路的显式错误；`code` 只进日志，`message` 可以回给用户。 */
export class GroupChatError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'GroupChatError'
  }
}

/** 已构造过的群聊 Runtime（仅诊断：bot 脱敏 id + 时间，不含凭据）。 */
const installedRuntimes = new Map<string, number>()

/** 最近群帧诊断（只记脱敏 id/长度，不记正文）。 */
export interface GroupFrameTrace {
  readonly at: number
  readonly chatIdMasked: string
  readonly senderIdMasked: string
  readonly messageIdMasked: string
  readonly textChars: number
  readonly hasReceivedAt: boolean
}
const recentGroupFrames: GroupFrameTrace[] = []

/** 读取最近群帧；供状态路由确认企微帧是否真的到达 connector。 */
export function groupChatFrameStatus(): GroupFrameTrace[] {
  return [...recentGroupFrames]
}

/** 最近群消息失败诊断；只记 code 和脱敏后的短消息，不含 token。 */
export interface GroupChatErrorTrace {
  readonly at: number
  readonly chatIdMasked: string
  readonly senderIdMasked: string
  readonly code: string
  readonly message: string
}
const recentGroupErrors: GroupChatErrorTrace[] = []

/** 读取最近群消息失败；供状态路由/证据脚本确认失败发生在哪个阶段。 */
export function groupChatErrorStatus(): GroupChatErrorTrace[] {
  return [...recentGroupErrors]
}

/** 最近群消息投递阶段；卡住时 status 能看到 progress-start/update/finish/group-ack/private-send。 */
export interface GroupDeliveryTrace {
  readonly at: number
  readonly chatIdMasked: string
  readonly senderIdMasked: string
  readonly stage: string
  readonly mode?: GroupDeliveryMode
}
const recentDeliveryStages: GroupDeliveryTrace[] = []

/** 读取最近投递阶段。 */
export function groupChatDeliveryStatus(): GroupDeliveryTrace[] {
  return [...recentDeliveryStages]
}

/** 记一条投递阶段；环形保留 20 条。 */
function rememberDeliveryStage(message: GroupMessage, stage: string, mode?: GroupDeliveryMode): void {
  recentDeliveryStages.push({
    at: Date.now(),
    chatIdMasked: mask(message.chatId),
    senderIdMasked: mask(message.senderId),
    stage,
    ...(mode === undefined ? {} : { mode }),
  })
  if (recentDeliveryStages.length > 20) {
    recentDeliveryStages.splice(0, recentDeliveryStages.length - 20)
  }
}

/** 记一条群消息失败诊断；截断并打码长 token，环形保留 20 条。 */
function rememberGroupError(input: {
  chatId: string
  senderId: string
  code: string
  message: string
}): void {
  recentGroupErrors.push({
    at: Date.now(),
    chatIdMasked: mask(input.chatId),
    senderIdMasked: mask(input.senderId),
    code: input.code,
    message: input.message.replace(/[A-Za-z0-9_-]{40,}/gu, '<redacted>').slice(0, 300),
  })
  if (recentGroupErrors.length > 20) recentGroupErrors.splice(0, recentGroupErrors.length - 20)
}

/** 记一条群帧诊断；环形保留 20 条。 */
function rememberGroupFrame(message: GroupMessage): void {
  recentGroupFrames.push({
    at: Date.now(),
    chatIdMasked: mask(message.chatId),
    senderIdMasked: mask(message.senderId),
    messageIdMasked: mask(message.messageId),
    textChars: message.text.length,
    hasReceivedAt: message.receivedAt !== undefined,
  })
  if (recentGroupFrames.length > 20) recentGroupFrames.splice(0, recentGroupFrames.length - 20)
}

/** 读取 connector 进程里已构造的群聊 Runtime；供状态路由使用。 */
export function groupChatRuntimeStatus(): { botIdMasked: string; installedAt: number }[] {
  return [...installedRuntimes.entries()].map(([botIdMasked, installedAt]) => ({ botIdMasked, installedAt }))
}

/** 一条群消息归一化后的字段。 */
export interface GroupMessage {
  readonly frame: unknown
  readonly messageId: string
  readonly chatId: string
  readonly senderId: string
  readonly senderName: string
  readonly text: string
  readonly receivedAt?: string
  readonly externalName?: string
}

/** sender 在 DataOps 的稳定 actor 绑定；token 只在内存里，不落盘、不打印。 */
interface SenderActorBinding {
  readonly userId: string
  readonly actor: Record<string, unknown>
  readonly token: string
  readonly expiresAt: number
}

/** 群聊 session 存储；dsh-im 的 WecomStateStore 已实现这些方法，也允许测试注入。 */
export interface GroupChatState {
  sessionFor(key: string): string | null
  setSession(key: string, sessionId: string): Promise<unknown> | unknown
  clearSession?(key: string): Promise<unknown> | unknown
}

/**
 * DSH Host 的执行接缝；生产来自 dsh-im Runtime 的 `options.harness`。
 *
 * 只声明群聊路径用到的部分：创建/复用 session、改名、判断存在、投递一轮 prompt。
 * `ask` 的返回值是本次 turn 的最终 assistant 文本。
 */
export interface GroupHarness {
  createSession(options?: Record<string, unknown>): Promise<string>
  ask(sessionId: string, prompt: string, options?: {
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
    readonly progressMode?: 'latest' | 'all' | 'live'
    readonly onUpdate?: (update: unknown) => void
  }): Promise<string | undefined>
  renameSession?(sessionId: string, title: string): Promise<unknown>
  sessionExists?(sessionId: string): Promise<boolean>
  ensureRunning?(options?: Record<string, unknown>): Promise<unknown>
}

/** 群共享 session 的只读诊断；只含脱敏 id、计数，不含正文/凭据。 */
export interface GroupSessionTrace {
  readonly botIdMasked: string
  readonly chatIdMasked: string
  readonly sessionId: string
  readonly actorUserIdMasked?: string
  readonly turnActive: boolean
  readonly turns: number
  /** 最近一次 turn 的执行分支：公开共享 session 或 turn-private child。 */
  readonly lastBranch?: 'shared' | 'private'
  /** sender_only / 降级隔离的 turn 数。 */
  readonly privateTurns?: number
  readonly lastAudience?: GroupAudience
  readonly lastPromptMessages?: number
  readonly lastPromptChars?: number
  readonly lastPromptHadHistory?: boolean
  readonly updatedAt: number
}

/** 当前进程里每个 `(botId, chatId)` 的共享 session 诊断；供状态路由/证据脚本读取。 */
const groupSessionTraces = new Map<string, GroupSessionTrace>()

/** 读取群共享 session 诊断快照。 */
export function groupChatSessionStatus(): GroupSessionTrace[] {
  return [...groupSessionTraces.values()].map(trace => ({ ...trace }))
}

/** 记一条群共享 session 诊断；key 用完整 botId+chatId，返回时只暴露脱敏值。 */
function recordGroupSessionTrace(input: {
  botId: string
  chatId: string
  sessionId: string
  actorUserId?: string
  turnActive?: boolean
  turns?: number
  lastBranch?: 'shared' | 'private'
  privateTurns?: number
  lastAudience?: GroupAudience
  lastPromptMessages?: number
  lastPromptChars?: number
  lastPromptHadHistory?: boolean
  now: number
}): void {
  const key = `${input.botId}\u0000${input.chatId}`
  const previous = groupSessionTraces.get(key)
  groupSessionTraces.set(key, {
    botIdMasked: mask(input.botId),
    chatIdMasked: mask(input.chatId),
    sessionId: input.sessionId,
    ...(input.actorUserId === undefined ? {} : { actorUserIdMasked: mask(input.actorUserId) }),
    turnActive: input.turnActive ?? previous?.turnActive ?? false,
    turns: input.turns ?? previous?.turns ?? 0,
    ...(input.lastBranch === undefined
      ? previous?.lastBranch === undefined ? {} : { lastBranch: previous.lastBranch }
      : { lastBranch: input.lastBranch }),
    ...(input.privateTurns === undefined
      ? previous?.privateTurns === undefined ? {} : { privateTurns: previous.privateTurns }
      : { privateTurns: input.privateTurns }),
    ...(input.lastAudience === undefined
      ? previous?.lastAudience === undefined ? {} : { lastAudience: previous.lastAudience }
      : { lastAudience: input.lastAudience }),
    ...(input.lastPromptMessages === undefined
      ? previous?.lastPromptMessages === undefined ? {} : { lastPromptMessages: previous.lastPromptMessages }
      : { lastPromptMessages: input.lastPromptMessages }),
    ...(input.lastPromptChars === undefined
      ? previous?.lastPromptChars === undefined ? {} : { lastPromptChars: previous.lastPromptChars }
      : { lastPromptChars: input.lastPromptChars }),
    ...(input.lastPromptHadHistory === undefined
      ? previous?.lastPromptHadHistory === undefined ? {} : { lastPromptHadHistory: previous.lastPromptHadHistory }
      : { lastPromptHadHistory: input.lastPromptHadHistory }),
    updatedAt: input.now,
  })
}

/** 后端 ingest 的返回子集。 */
interface IngestResult {
  readonly roomId: string
  readonly deduplicated: boolean
}

/** 后端 replies 的返回子集。 */
interface ReplyResult {
  readonly roomId: string
  readonly audience: GroupAudience | 'not_applicable'
  readonly deliveredToRoom: boolean
  readonly ack?: string
}

/** 单个群消息的处理结果；handler 用它决定往哪里发。 */
export interface GroupChatOutcome {
  readonly deduplicated: boolean
  readonly roomId?: string
  readonly audience?: GroupAudience
  readonly text?: string
  readonly ack?: string
  readonly resultType?: ExternalResultType
}

/** @ 前补拉历史的预算结果；只含计数，不含消息正文。 */
export interface RefreshGroupHistoryResult {
  readonly elapsedMs: number
  readonly timedOut: boolean
  readonly promptMessages: number
}

/**
 * 有界刷新群历史：只等 `waitMs`，超时后后台继续跑，返回当前缓存条数。
 *
 * 必须把 `refreshRecent` 的 Promise 接住（catch），否则超时后它再 reject 会变成
 * unhandled rejection。
 */
export async function refreshGroupHistory(input: {
  history: GroupHistoryProvider | undefined
  chatId: string
  logger: { warn(message: string): void; info?(message: string): void }
  now: () => number
  waitMs?: number
  lookbackMinutes?: number
}): Promise<RefreshGroupHistoryResult> {
  const startedAt = input.now()
  const waitMs = input.waitMs ?? HISTORY_REFRESH_MAX_WAIT_MS
  let timedOut = false
  const refresh = input.history?.refreshRecent?.(input.chatId, input.lookbackMinutes ?? HISTORY_REFRESH_LOOKBACK_MINUTES)
  if (refresh !== undefined) {
    const guarded = refresh.catch((error: unknown) => {
      input.logger.warn(
        `[dataops-im] group history refresh before prompt failed chat=${mask(input.chatId)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    await Promise.race([guarded, sleep(waitMs).then(() => { timedOut = true })])
  }
  const elapsedMs = input.now() - startedAt
  const promptMessages = input.history?.messageCount(input.chatId) ?? 0
  if (timedOut) {
    input.logger.warn(
      `[dataops-im] HISTORY_REFRESH_TIMEOUT chat=${mask(input.chatId)} waited=${String(waitMs)}ms promptMessages=${String(promptMessages)}; continue with cached prompt`,
    )
  } else {
    input.logger.info?.(
      `[dataops-im] history refresh chat=${mask(input.chatId)} ms=${String(elapsedMs)} promptMessages=${String(promptMessages)}`,
    )
  }
  return { elapsedMs, timedOut, promptMessages }
}

/** 群聊路由器依赖。 */
export interface GroupChatRouterOptions {
  readonly host: PrivateChatHost
  readonly botId: string
  /** 群名缺失时的机器人展示名；默认“万相”。 */
  readonly botName?: string
  readonly state: GroupChatState
  readonly history?: GroupHistoryProvider
  /** DSH Host 执行接缝；缺失时群消息 fail closed。 */
  readonly harness?: GroupHarness
  /** 测试注入；生产用 DSH ctx 实现。 */
  readonly actors?: GroupTurnActorGateway
  /** sender_only turn 的 fork/丢弃能力；缺失时退化为新 session。 */
  readonly branches?: GroupSessionBranches
  /** turn-private 分支的归档/到期清理；缺失时不归档（证据需说明损失）。 */
  readonly lifecycle?: GroupBranchLifecycle
  /** 分支保留时长；默认 7 天。 */
  readonly branchRetentionMs?: number
  readonly signal?: AbortSignal
}

/** 群聊单条消息处理的可选钩子。 */
export interface GroupProcessHooks {
  /** 通用进度文案；调用方不得传入个人数据。 */
  readonly onProgress?: (text: string) => void
}

/** 一次 sender 身份解析的返回体子集。 */
interface IdentityResolveBody {
  readonly decision?: unknown
  readonly reason?: unknown
  readonly message?: unknown
  readonly user?: { readonly id?: unknown; readonly username?: unknown; readonly displayName?: unknown }
  readonly actor?: unknown
  readonly token?: unknown
  readonly expiresAt?: unknown
}

/** 群聊路由器：共享 session、每 turn 切换 actor、room 镜像与 audience 回写。 */
export class GroupChatRouter {
  private readonly host: PrivateChatHost
  private readonly botId: string
  private readonly botName: string
  private readonly state: GroupChatState
  private readonly history?: GroupHistoryProvider
  private readonly harness?: GroupHarness
  private readonly actors: GroupTurnActorGateway
  private readonly branches?: GroupSessionBranches
  private readonly lifecycle?: GroupBranchLifecycle
  private readonly branchRetentionMs: number
  private readonly signal?: AbortSignal
  private readonly senders = new Map<string, SenderActorBinding>()
  private readonly sessions = new Map<string, string>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly turnCounts = new Map<string, number>()
  private readonly privateTurnCounts = new Map<string, number>()

  constructor(options: GroupChatRouterOptions) {
    this.host = options.host
    this.botId = options.botId
    this.botName = options.botName === undefined || options.botName.trim() === '' ? '万相' : options.botName.trim()
    this.state = options.state
    this.history = options.history
    this.harness = options.harness
    this.signal = options.signal
    this.actors = options.actors ?? createDshGroupTurnActors(options.host.ctx, options.host.credentialRef)
    this.branches = options.branches
      ?? (options.actors === undefined ? createDshGroupSessionBranches(options.host.ctx) : undefined)
    this.lifecycle = options.lifecycle
      ?? (options.actors === undefined
        ? createDshBranchLifecycle(options.host.ctx, {
            dataDir: options.host.historySync?.dataDir ?? '/workspace/.dataops/wecom-group-sessions',
            ...(options.branchRetentionMs === undefined ? {} : { retentionMs: options.branchRetentionMs }),
            logger: options.host.logger,
          })
        : undefined)
    this.branchRetentionMs = options.branchRetentionMs ?? 7 * 24 * 60 * 60 * 1000
  }

  /** 清掉一个 sender 的 actor 缓存（测试/诊断用）。 */
  forget(senderId: string): void {
    this.senders.delete(this.senderKey(senderId))
  }

  /** 当前群共享 session id（诊断/证据用）；未创建时 undefined。 */
  sessionIdFor(chatId: string): string | undefined {
    return this.sessions.get(this.groupKey(chatId))
  }

  /** 投递卡住/异常时也把 turnActive 归零；保留其他诊断字段。 */
  markTurnInactive(message: GroupMessage): void {
    const sessionId = this.sessions.get(this.groupKey(message.chatId))
    if (sessionId === undefined) return
    this.trace(message, sessionId, { turnActive: false })
  }

  /**
   * 处理一条群消息：串行锁 → 写 room → 补群历史 → 共享 session 上切换 sender actor → 执行。
   *
   * @param message - 归一化的群消息。
   * @param hooks - 通用进度回调；不得携带个人数据。
   * @returns 可见性、完整文本与 ack；`deduplicated` 为 true 时调用方不得再回复。
   */
  async process(message: GroupMessage, hooks: GroupProcessHooks = {}): Promise<GroupChatOutcome> {
    return this.withGroupLock(message.chatId, async () => {
      // 历史同步可能已先一步把这条 @ 消息写进 room；此时只补 agent 回复，不再重复入库。
      const live = this.liveMessage(message)
      const liveKey = live === undefined ? undefined : this.history?.dedupKey(live)
      const alreadyInRoom = live !== undefined && this.history?.hasLiveMessage(live) === true
      if (!alreadyInRoom) {
        const ingested = await this.ingest(message)
        if (ingested.deduplicated) return { deduplicated: true, roomId: ingested.roomId }
      }
      if (live !== undefined) this.history?.rememberLiveMessage(live)

      // @ 到达时只拉最近 10 分钟 delta，最多等 1.8s；超时先用缓存回答，后台继续刷新。
      // 7 天全量只属于定时任务，不能阻塞实时 @。
      const refreshStats = await refreshGroupHistory({
        history: this.history,
        chatId: message.chatId,
        logger: this.host.logger,
        now: () => this.now(),
        waitMs: HISTORY_REFRESH_MAX_WAIT_MS,
        lookbackMinutes: HISTORY_REFRESH_LOOKBACK_MINUTES,
      })
      this.history?.recordRefresh?.(refreshStats)
      hooks.onProgress?.(refreshStats.promptMessages > 0 ? PROGRESS_CONTEXT : PROGRESS_EXECUTING)

      const sharedSessionId = await this.ensureSharedSession(message)
      const resultType = classifyGroupRequest(message.text)
      const publicCandidate = isPublicCandidate(resultType)
      let asked: { answer: string; sessionId: string; userId: string }
      let branch: 'shared' | 'private' = 'shared'

      if (publicCandidate) {
        // 公开候选：在共享 session 上执行；若答案被硬敏感判据降级，则用 turn 前快照
        // fork 一个干净的共享 session，把敏感 turn 从后续上下文里隔离掉。
        const boundary = this.branches?.lastSeq(sharedSessionId)
        try {
          asked = await this.askAsSender(sharedSessionId, message, liveKey, hooks)
        } catch (error) {
          if (!isRecoverableSessionError(error)) throw error
          const rebuilt = await this.rebuildSharedSession(message)
          asked = await this.askAsSender(rebuilt, message, liveKey, hooks)
        }
        if (decideAudience(resultType, asked.answer) === 'sender_only') {
          branch = 'private'
          const clean = await this.isolateSensitiveSharedTurn({
            sharedSessionId,
            boundary,
            message,
            reason: 'downgraded',
          })
          this.trace(message, clean, { actorUserId: asked.userId, turnActive: false, lastBranch: 'private' })
        }
      } else {
        // sender_only：从公开共享 session fork turn-private child，执行完立即归档、不 merge。
        branch = 'private'
        const child = await this.forkPrivateBranch(sharedSessionId, message)
        let finalChild = child
        try {
          try {
            asked = await this.askAsSender(child, message, liveKey, hooks)
          } catch (error) {
            if (!isRecoverableSessionError(error)) throw error
            finalChild = await this.forkPrivateBranch(undefined, message)
            asked = await this.askAsSender(finalChild, message, liveKey, hooks)
          }
        } finally {
          // 即使本轮失败，child 也可能已包含 prompt/工具结果；必须归档，不能留在可见面。
          await this.retirePrivateBranch(child, finalChild, message, 'sender_only')
        }
      }

      const finalAnswer = asked.answer.trim() === '' ? '（Agent 本次没有返回文本回复。）' : asked.answer
      const requestedAudience = branch === 'private'
        ? 'sender_only'
        : decideAudience(resultType, finalAnswer)
      const reply = await this.reply({
        message,
        resultType,
        audience: requestedAudience,
        text: finalAnswer,
      })
      this.trace(message, asked.sessionId, {
        actorUserId: asked.userId,
        turnActive: false,
        lastBranch: branch,
        lastAudience: reply.audience === 'room_safe' ? 'room_safe' : 'sender_only',
        ...(branch === 'private' ? { countPrivateTurn: true } : {}),
      })
      return {
        deduplicated: false,
        roomId: reply.roomId,
        audience: reply.audience === 'room_safe' ? 'room_safe' : 'sender_only',
        text: finalAnswer,
        ack: reply.ack,
        resultType,
      }
    })
  }

  /**
   * 从公开共享 session fork 一个 turn-private child；fork 不可用时退化为新 session +
   * 群历史 prompt。child 只用于本条消息，执行后归档。
   */
  private async forkPrivateBranch(
    sharedSessionId: string | undefined,
    message: GroupMessage,
  ): Promise<string> {
    // 新 child 的 session id 与缓存的 actor token sid 不同，清缓存让它按 child 重新铸 token。
    this.senders.clear()
    if (sharedSessionId !== undefined && this.branches !== undefined) {
      try {
        const boundary = this.branches.lastSeq(sharedSessionId)
        return await this.branches.fork(sharedSessionId, boundary)
      } catch (error) {
        this.host.logger.warn(
          `[dataops-im] group private branch fork failed, falling back to new session: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    const created = await this.harness?.createSession()
    if (typeof created !== 'string' || created === '') {
      throw new GroupChatError('GROUP_SESSION_CREATE_INVALID', '工作区没有返回群聊会话 id。')
    }
    await this.actors.ensurePlaceholder(created)
    return created
  }

  /** 归档 sender_only 分支；失败的审计损失写日志，不阻断私聊投递。 */
  private async retirePrivateBranch(
    firstSessionId: string,
    finalSessionId: string,
    message: GroupMessage,
    reason: 'sender_only' | 'downgraded' | 'superseded',
  ): Promise<void> {
    const ids = firstSessionId === finalSessionId ? [finalSessionId] : [firstSessionId, finalSessionId]
    const now = this.now()
    for (const sessionId of ids) {
      if (this.lifecycle === undefined) {
        this.host.logger.warn(
          `[dataops-im] group private branch not archived (no lifecycle) session=${sessionId}; audit retention unavailable`,
        )
        continue
      }
      await this.lifecycle.retire(sessionId, {
        botId: this.botId,
        chatId: message.chatId,
        senderId: message.senderId,
        turnId: message.messageId,
        parentGroupSession: this.sessions.get(this.groupKey(message.chatId)) ?? '',
        reason,
        createdAt: now,
        expiresAt: now + (this.branchRetentionMs ?? 7 * 24 * 60 * 60 * 1000),
      })
    }
  }

  /**
   * 公开候选被降级时的隔离：从 turn 前 boundary fork 一个干净 child 并提升为共享 session。
   * fork 失败则清掉共享绑定、下一条消息重建空 session（宁可丢公开上下文，也不留敏感 turn）。
   */
  private async isolateSensitiveSharedTurn(input: {
    sharedSessionId: string
    boundary: number | undefined
    message: GroupMessage
    reason: 'downgraded'
  }): Promise<string> {
    try {
      let clean: string
      if (input.boundary === undefined) {
        // 空共享 session 没有 turn 前 boundary：DSH fork 省略 boundary 会复制到当前
        // （即包含敏感 turn），所以直接建一个新的空 session 提升为共享 session。
        const created = await this.harness?.createSession()
        if (typeof created !== 'string' || created === '') {
          throw new Error('无法创建干净的共享 session')
        }
        await this.actors.ensurePlaceholder(created)
        clean = created
      } else {
        if (this.branches === undefined) throw new Error('no session branches')
        clean = await this.branches.fork(input.sharedSessionId, input.boundary)
        await this.actors.ensurePlaceholder(clean)
      }
      await this.renameSession(clean, input.message)
      this.sessions.set(this.groupKey(input.message.chatId), clean)
      await this.state.setSession(this.stateKey(input.message.chatId), clean)
      // token 的 sid 绑定旧 session，清缓存重新铸。
      this.senders.clear()
      await this.retirePrivateBranch(input.sharedSessionId, input.sharedSessionId, input.message, 'downgraded')
      this.host.logger.warn(
        `[dataops-im] group shared turn downgraded; isolated old session=${input.sharedSessionId} clean=${clean}`,
      )
      return clean
    } catch (error) {
      this.host.logger.warn(
        `[dataops-im] group shared turn isolation failed; dropping shared binding: ${error instanceof Error ? error.message : String(error)}`,
      )
      // fork 失败也必须把含敏感 turn 的旧共享 session 归档，避免它继续被复用。
      await this.retirePrivateBranch(input.sharedSessionId, input.sharedSessionId, input.message, 'downgraded')
      this.sessions.delete(this.groupKey(input.message.chatId))
      await this.state.clearSession?.(this.stateKey(input.message.chatId))
      this.senders.clear()
      return this.rebuildSharedSession(input.message)
    }
  }

  /** 把实时帧归一化成历史账本同构的时间/文本字段。 */
  private liveMessage(message: GroupMessage): {
    chatId: string
    sendTime: string
    userId: string
    userName?: string
    msgType: string
    text: string
  } | undefined {
    const ms = message.receivedAt === undefined ? this.now() : Date.parse(message.receivedAt)
    if (!Number.isFinite(ms) || message.text === '') return undefined
    return {
      chatId: message.chatId,
      sendTime: formatWecomTime(ms),
      userId: message.senderId,
      ...message.senderName === '' ? {} : { userName: message.senderName },
      msgType: 'text',
      text: message.text,
    }
  }

  /**
   * 在当前 sender 的 actor/凭据下执行一轮 prompt。
   *
   * 顺序是 fail closed 的关键：先解析 actor，再写 scoped 凭据、换 Session.actor，
   * 然后才投递 prompt；`finally` 无论成功失败都清凭据并换回占位 actor，下一条消息
   * 不会继承上一位 sender。
   */
  private async askAsSender(
    sessionId: string,
    message: GroupMessage,
    liveKey: string | undefined,
    hooks: GroupProcessHooks,
  ): Promise<{ answer: string; sessionId: string; userId: string }> {
    const binding = await this.senderActor(message.senderId, message.senderName, sessionId)
    const prompt = this.history?.buildPrompt(message.chatId, message.text, liveKey) ?? message.text
    await this.actors.activate(sessionId, binding.actor, binding.token)
    this.trace(message, sessionId, {
      actorUserId: binding.userId,
      turnActive: true,
      lastPromptMessages: this.history?.messageCount(message.chatId) ?? 0,
      lastPromptChars: prompt.length,
      lastPromptHadHistory: prompt !== message.text,
    })
    try {
      hooks.onProgress?.(PROGRESS_EXECUTING)
      const answer = await this.ask(sessionId, prompt, hooks)
      return { answer, sessionId, userId: binding.userId }
    } finally {
      await this.actors.clear(sessionId).catch((error: unknown) => {
        this.host.logger.warn(
          `[dataops-im] group turn actor clear failed session=${mask(sessionId)}: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
      this.trace(message, sessionId, {
        actorUserId: binding.userId,
        turnActive: false,
        countTurn: true,
      })
    }
  }

  /** 投递一轮 prompt 并等待最终 assistant 文本；失败由调用方决定是否重建 session。 */
  private async ask(sessionId: string, prompt: string, hooks: GroupProcessHooks): Promise<string> {
    const harness = this.harness
    if (harness === undefined) {
      throw new GroupChatError('GROUP_HARNESS_UNAVAILABLE', '群聊执行器不可用，请稍后重试。')
    }
    const answer = await harness.ask(sessionId, prompt, {
      timeoutMs: MAX_WAIT_MS,
      // all 才能看到每次 tool/call；回调只读工具名并映射固定阶段，忽略参数/结果。
      progressMode: 'all',
      ...(hooks.onProgress === undefined ? {} : {
        onUpdate: (update: unknown) => {
          const phase = toolProgressFromUpdate(update)
          if (phase !== undefined) hooks.onProgress?.(phase)
        },
      }),
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    })
    return typeof answer === 'string' ? answer : ''
  }

  /** 找/建该群唯一的共享 session；持久键只含 `(botId, chatId)`。 */
  private async ensureSharedSession(message: GroupMessage): Promise<string> {
    const key = this.groupKey(message.chatId)
    const stateKey = this.stateKey(message.chatId)
    const cached = this.sessions.get(key)
    if (cached !== undefined) {
      if (await this.sessionExists(cached) && this.actors.isSessionLive?.(cached) !== false) {
        await this.actors.ensurePlaceholder(cached)
        this.trace(message, cached, {})
        return cached
      }
      this.sessions.delete(key)
    }

    const stored = this.state.sessionFor(stateKey)
    if (typeof stored === 'string' && stored !== '') {
      if (await this.sessionExists(stored) && this.actors.isSessionLive?.(stored) !== false) {
        this.sessions.set(key, stored)
        await this.actors.ensurePlaceholder(stored)
        this.trace(message, stored, {})
        return stored
      }
      // DSH 重启后 persisted session 不会自动 resume；actor 无法写到非 live session。
      // 先归档旧共享 session（隐藏、保留审计），再建新 session，避免每条消息都失败。
      await this.state.clearSession?.(stateKey)
      await this.archiveStaleSharedSession(stored, message)
    }

    return this.createSharedSession(message)
  }

  /** 重建共享 session：state 里旧 id 先清掉，避免下一次又复用坏会话。 */
  private async rebuildSharedSession(message: GroupMessage): Promise<string> {
    const key = this.groupKey(message.chatId)
    this.sessions.delete(key)
    await this.state.clearSession?.(this.stateKey(message.chatId))
    return this.createSharedSession(message)
  }

  /** 归档 DSH 重启后已持久化但未 live 的旧共享 session。 */
  private async archiveStaleSharedSession(sessionId: string, message: GroupMessage): Promise<void> {
    if (this.lifecycle === undefined) return
    const now = this.now()
    await this.lifecycle.retire(sessionId, {
      botId: this.botId,
      chatId: message.chatId,
      senderId: '-',
      turnId: '-',
      parentGroupSession: '',
      reason: 'superseded',
      createdAt: now,
      expiresAt: now + this.branchRetentionMs,
    })
  }

  /** 在机器人工作区创建一个群共享 session，并写入群名/占位名。 */
  private async createSharedSession(message: GroupMessage): Promise<string> {
    const harness = this.harness
    if (harness === undefined) {
      throw new GroupChatError('GROUP_HARNESS_UNAVAILABLE', '群聊执行器不可用，请稍后重试。')
    }
    const created = await harness.createSession()
    if (typeof created !== 'string' || created === '') {
      throw new GroupChatError('GROUP_SESSION_CREATE_INVALID', '工作区没有返回群聊会话 id。')
    }
    this.sessions.set(this.groupKey(message.chatId), created)
    await this.state.setSession(this.stateKey(message.chatId), created)
    // 新 session id 会让旧 token 的 sid 对不上审计；清缓存，下一条消息重新铸。
    this.senders.clear()
    await this.actors.ensurePlaceholder(created)
    await this.renameSession(created, message)
    this.trace(message, created, { turnActive: false })
    this.host.logger.info?.(
      `[dataops-im] group shared session created chat=${mask(message.chatId)} session=${created}`,
    )
    return created
  }

  /** 群名优先用平台透传/CLI 群名，否则用固定占位名；改名失败不影响执行。 */
  private async renameSession(sessionId: string, message: GroupMessage): Promise<void> {
    const name = message.externalName ?? this.history?.chatName(message.chatId)
    const title = name !== undefined && name.trim() !== ''
      ? name.trim()
      : `企业微信群 · ${this.botName} · ${message.chatId.slice(0, 8)}`
    try {
      await this.harness?.renameSession?.(sessionId, title)
    } catch (error) {
      this.host.logger.warn(
        `[dataops-im] group session rename failed session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 会话是否仍在机器人工作区；列表/检查失败时乐观返回 true，交给 prompt 的错误路径兜底。 */
  private async sessionExists(sessionId: string): Promise<boolean> {
    if (this.harness?.sessionExists === undefined) return true
    try {
      return await this.harness.sessionExists(sessionId)
    } catch {
      return true
    }
  }

  /**
   * 解析当前 sender 的 actor 与 scoped token。
   *
   * token 绑定到共享 session id（审计 sid 一致），有效期 15 分钟；缓存到过期前 1 分钟。
   * 首次遇到的未绑定企微用户仍走私聊 resolve 的自动建号（只建号/建默认会话，不把群 turn
   * 切到私聊 session），再重试一次 identity resolve。
   */
  private async senderActor(
    senderId: string,
    senderName: string,
    sessionId: string,
  ): Promise<SenderActorBinding> {
    const key = this.senderKey(senderId)
    const cached = this.senders.get(key)
    const now = this.now()
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return cached

    let body = await this.identityResolve(senderId, sessionId)
    if (body.decision !== 'bound' && body.reason === 'IDENTITY_NOT_BOUND') {
      await this.provisionSender(senderId, senderName)
      body = await this.identityResolve(senderId, sessionId)
    }
    if (body.decision !== 'bound') {
      throw new GroupChatError(
        typeof body.reason === 'string' ? body.reason : 'GROUP_SENDER_UNMAPPED',
        explicitMessage(body) ?? '该企业微信用户暂时无法建立工作区会话，请联系管理员。',
      )
    }
    const userId = body.user?.id
    const actor = body.actor
    const token = body.token
    if (
      typeof userId !== 'string' || userId === ''
      || typeof actor !== 'object' || actor === null
      || typeof token !== 'string' || token === ''
    ) {
      throw new GroupChatError('GROUP_IDENTITY_INVALID', '群聊 sender 解析返回了不完整的 actor/凭据。')
    }
    const expiresAt = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : Number.NaN
    const binding: SenderActorBinding = {
      userId,
      actor: actor as Record<string, unknown>,
      token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + 10 * 60_000,
    }
    this.senders.set(key, binding)
    this.host.logger.info?.(
      `[dataops-im] group turn actor bound sender=${mask(senderId)} user=${binding.userId} session=${sessionId}`,
    )
    return binding
  }

  /** `POST /api/im/identity/resolve`：拿到 actor 与绑定共享 session 的 scoped JWT。 */
  private async identityResolve(senderId: string, sessionId: string): Promise<IdentityResolveBody> {
    const serviceToken = await this.serviceCredential()
    const response = await this.request('/api/im/identity/resolve', {
      method: 'POST',
      token: serviceToken,
      body: { botId: this.botId, senderId, sessionId },
      timeoutMs: RESOLVE_TIMEOUT_MS,
    })
    const body = await response.json().catch(() => undefined) as IdentityResolveBody | undefined
    if (!response.ok) {
      throw new GroupChatError(
        `GROUP_IDENTITY_HTTP_${String(response.status)}`,
        explicitMessage(body) ?? '群聊 sender 身份解析失败，请稍后重试。',
      )
    }
    return body ?? {}
  }

  /**
   * 首次未绑定用户：调用私聊 resolve 自动建号（只建号，不使用其私聊 session 执行群 turn）。
   * 失败只记日志，随后仍由 identity resolve 给出最终 fail-closed 原因。
   */
  private async provisionSender(senderId: string, senderName: string): Promise<void> {
    try {
      const serviceToken = await this.serviceCredential()
      const response = await this.request('/api/im/private-sessions/resolve', {
        method: 'POST',
        token: serviceToken,
        body: {
          botId: this.botId,
          senderId,
          wecomUserId: senderId,
          ...senderName === '' ? {} : { senderName },
        },
        timeoutMs: RESOLVE_TIMEOUT_MS,
      })
      if (!response.ok) {
        this.host.logger.warn(
          `[dataops-im] group sender auto-provision failed sender=${mask(senderId)} http=${String(response.status)}`,
        )
      }
    } catch (error) {
      this.host.logger.warn(
        `[dataops-im] group sender auto-provision failed sender=${mask(senderId)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 把消息镜像进共享 room；重复消息由后端账本幂等返回。 */
  private async ingest(message: GroupMessage): Promise<IngestResult> {
    const serviceToken = await this.serviceCredential()
    const response = await this.request('/api/ai/chat/external/ingest', {
      method: 'POST',
      token: serviceToken,
      body: {
        provider: 'wecom',
        botId: this.botId,
        externalGroupId: message.chatId,
        chatId: message.chatId,
        messageId: message.messageId,
        senderId: message.senderId,
        ...(message.senderName === '' ? {} : { senderName: message.senderName }),
        text: message.text,
        chatType: 'group',
        ...(message.externalName === undefined ? {} : { externalName: message.externalName }),
        ...(message.receivedAt === undefined ? {} : { receivedAt: message.receivedAt }),
      },
      timeoutMs: PROMPT_TIMEOUT_MS,
    })
    const body = await response.json().catch(() => undefined) as {
      roomId?: unknown
      deduplicated?: unknown
      message?: unknown
    } | undefined
    if (!response.ok || typeof body?.roomId !== 'string' || body.roomId === '') {
      throw new GroupChatError(
        `GROUP_INGEST_HTTP_${String(response.status)}`,
        explicitMessage(body) ?? '写入群聊镜像失败，请稍后重试。',
      )
    }
    return { roomId: body.roomId, deduplicated: body.deduplicated === true }
  }

  /** 结果可见性由后端做最终裁决；connector 只提交类型与建议 audience。 */
  private async reply(input: {
    message: GroupMessage
    resultType: ExternalResultType
    audience: GroupAudience
    text: string
  }): Promise<ReplyResult> {
    const serviceToken = await this.serviceCredential()
    const response = await this.request('/api/ai/chat/external/replies', {
      method: 'POST',
      token: serviceToken,
      body: {
        provider: 'wecom',
        botId: this.botId,
        externalGroupId: input.message.chatId,
        chatId: input.message.chatId,
        senderId: input.message.senderId,
        ...(input.message.senderName === '' ? {} : { senderName: input.message.senderName }),
        turnId: input.message.messageId,
        chatType: 'group',
        resultType: input.resultType,
        audience: input.audience,
        text: input.text,
      },
      timeoutMs: PROMPT_TIMEOUT_MS,
    })
    const body = await response.json().catch(() => undefined) as {
      roomId?: unknown
      audience?: unknown
      deliveredToRoom?: unknown
      ack?: unknown
      message?: unknown
    } | undefined
    if (!response.ok || typeof body?.roomId !== 'string') {
      throw new GroupChatError(
        `GROUP_REPLY_HTTP_${String(response.status)}`,
        explicitMessage(body) ?? '回写群聊结果失败。',
      )
    }
    const audience = body.audience === 'room_safe' || body.audience === 'sender_only'
      ? body.audience
      : 'sender_only'
    return {
      roomId: body.roomId,
      audience,
      deliveredToRoom: body.deliveredToRoom === true,
      ...(typeof body.ack === 'string' && body.ack !== '' ? { ack: body.ack } : {}),
    }
  }

  /**
   * 机器人服务账号 credential；缺失时 fail closed。
   *
   * 必须走 `resolveServiceCredential` 的原始 resolve：ingest/identity resolve/provisioning
   * 是 connector 自己发起的服务调用，不能因为当前 async context 属于群 turn 就被
   * group scope 换成 sender token 或抛 not_authorized。
   */
  private async serviceCredential(): Promise<string> {
    try {
      const resolved = await resolveServiceCredential(this.host.ctx, this.host.credentialRef)
      const value = resolved?.value
      if (typeof value !== 'string' || value === '') {
        throw new GroupChatError('GROUP_SERVICE_CREDENTIAL_MISSING', '机器人工作区缺少 DataOps 服务账号凭据。')
      }
      return value
    } catch (error) {
      if (error instanceof GroupChatError) throw error
      throw new GroupChatError('GROUP_SERVICE_CREDENTIAL_MISSING', '机器人工作区缺少 DataOps 服务账号凭据。')
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
      throw new GroupChatError(
        'GROUP_UNREACHABLE',
        `DataOps 群聊服务不可达：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 同一群串行：A 的 turn 没清 actor 之前，B 不能开始。 */
  private async withGroupLock<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(chatId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(work)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(chatId, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(chatId) === tail) this.locks.delete(chatId)
    }
  }

  /** 更新/合并一条共享 session 诊断。 */
  private trace(
    message: GroupMessage,
    sessionId: string,
    patch: {
      actorUserId?: string
      turnActive?: boolean
      countTurn?: boolean
      countPrivateTurn?: boolean
      lastBranch?: 'shared' | 'private'
      lastAudience?: GroupAudience
      lastPromptMessages?: number
      lastPromptChars?: number
      lastPromptHadHistory?: boolean
    },
  ): void {
    const key = `${this.botId}\u0000${message.chatId}`
    const countTurn = patch.countTurn === true
    const turns = (this.turnCounts.get(key) ?? 0) + (countTurn ? 1 : 0)
    if (countTurn) this.turnCounts.set(key, turns)
    const countPrivate = patch.countPrivateTurn === true
    const privateTurns = (this.privateTurnCounts.get(key) ?? 0) + (countPrivate ? 1 : 0)
    if (countPrivate) this.privateTurnCounts.set(key, privateTurns)
    recordGroupSessionTrace({
      botId: this.botId,
      chatId: message.chatId,
      sessionId,
      turns,
      privateTurns,
      now: this.now(),
      ...patch.actorUserId === undefined ? {} : { actorUserId: patch.actorUserId },
      ...patch.turnActive === undefined ? {} : { turnActive: patch.turnActive },
      ...patch.lastBranch === undefined ? {} : { lastBranch: patch.lastBranch },
      ...patch.lastAudience === undefined ? {} : { lastAudience: patch.lastAudience },
      ...patch.lastPromptMessages === undefined ? {} : { lastPromptMessages: patch.lastPromptMessages },
      ...patch.lastPromptChars === undefined ? {} : { lastPromptChars: patch.lastPromptChars },
      ...patch.lastPromptHadHistory === undefined ? {} : { lastPromptHadHistory: patch.lastPromptHadHistory },
    })
  }

  private now(): number {
    return (this.host.now ?? Date.now)()
  }

  private senderKey(senderId: string): string {
    return `${this.botId}\u0000${senderId}`
  }

  private groupKey(chatId: string): string {
    return `${this.botId}\u0000${chatId}`
  }

  private stateKey(chatId: string): string {
    return `group-session:${this.botId}:${chatId}`
  }
}

/**
 * 群聊消息处理器：同一群串行执行，负责进度卡、group ack / 私聊投递。
 *
 * 群消息是广播的，所以 `sender_only` 的完整结果只能走私聊；群里只放后端返回的 ack。
 */
export interface GroupChatDeps {
  readonly client: {
    replyStream(frame: unknown, streamId: string, content: string, finish: boolean): Promise<unknown>
    sendMessage(chatId: string, content: unknown): Promise<unknown>
  }
  readonly state: GroupChatState & {
    hasSeen(id: string): boolean
    markSeen(id: string): Promise<unknown> | unknown
  }
  readonly router: GroupChatProcessor
  readonly logger: { warn(message: string): void; info?(message: string): void }
  readonly signal?: AbortSignal
}

/** 群消息处理器只需要路由器的 process 接缝（测试可注入 fake）。 */
export interface GroupChatProcessor {
  process(message: GroupMessage, hooks?: GroupProcessHooks): Promise<GroupChatOutcome>
  /** 强制把当前 turn 标为结束；投递卡住/异常时也保证 status 归零。 */
  markTurnInactive?(message: GroupMessage): void
}

/** 群聊消息处理器的公开形状。 */
export interface GroupChatHandler {
  handle(frame: unknown): Promise<void>
  waitForIdle(): Promise<void>
}

/** 创建只处理 `chattype === 'group'` 的入站处理器。 */
export function createGroupChatHandler(deps: GroupChatDeps): GroupChatHandler {
  const queues = new Map<string, Promise<void>>()
  const inFlight = new Set<Promise<void>>()
  const handled = new WeakSet<object>()

  async function run(message: GroupMessage): Promise<void> {
    if (deps.signal?.aborted === true) return
    const progress = createGroupProgress(
      deps.client,
      message,
      deps.logger,
      (stage, mode) => rememberDeliveryStage(message, stage, mode),
    )
    // 先回一条通用进度卡，再开始 refresh/agent；用户不用等到最终答案才看到机器人有反应。
    await progress.start()
    let outcome: GroupChatOutcome | undefined
    let finalText: string | undefined
    let privateText: string | undefined
    try {
      if (message.text === '') {
        finalText = '群聊暂时只支持文字消息。'
      } else {
        outcome = await deps.router.process(message, {
          // 只传通用状态；不把模型中间文本/个人数据刷到群里。
          onProgress: text => progress.update(text),
        })
        if (outcome.deduplicated) {
          finalText = '这条消息已经处理过了。'
        } else {
          const text = outcome.text?.trim() ?? ''
          if (text === '') {
            finalText = outcome.ack ?? '（Agent 本次没有返回文本回复。）'
          } else if (outcome.audience === 'room_safe') {
            finalText = text
          } else {
            // sender_only：群里只把进度卡收尾成固定 ack，完整结果发到 sender 私聊。
            // 执行上下文始终是共享群 session，不切私聊 session、不写共享 room。
            finalText = outcome.ack ?? '结果涉及个人数据，已私聊发送'
            privateText = text
          }
        }
      }
    } catch (error) {
      const code = error instanceof GroupChatError || error instanceof PrivateChatError
        ? error.code
        : 'GROUP_CHAT_FAILED'
      finalText = error instanceof GroupChatError || error instanceof PrivateChatError
        ? error.message
        : '处理失败，请稍后重试。'
      const detail = error instanceof Error ? error.message : String(error)
      deps.logger.warn(
        `[dataops-im] group chat failed chat=${mask(message.chatId)} sender=${mask(message.senderId)} code=${code} message=${detail}`,
      )
      rememberGroupError({ chatId: message.chatId, senderId: message.senderId, code, message: detail })
    } finally {
      // 无论 process 成功/失败，turnActive 都先归零；再保证一次最终 ack/正文尝试。
      deps.router.markTurnInactive?.(message)
      if (outcome !== undefined) await safeMarkSeen(deps.state, message.messageId)
      try {
        await progress.finish(
          finalText ?? '处理失败，请稍后重试。',
          privateText === undefined ? 'group-final' : 'group-ack',
        )
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        deps.logger.warn(
          `[dataops-im] group final delivery failed chat=${mask(message.chatId)}: ${detail}`,
        )
        rememberGroupError({ chatId: message.chatId, senderId: message.senderId, code: 'GROUP_DELIVERY_FAILED', message: detail })
      } finally {
        deps.router.markTurnInactive?.(message)
      }
      if (privateText !== undefined) {
        rememberDeliveryStage(message, 'private-send')
        try {
          await sendToSender(deps.client, message.senderId, privateText)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          deps.logger.warn(
            `[dataops-im] group private send failed chat=${mask(message.chatId)} sender=${mask(message.senderId)}: ${detail}`,
          )
          rememberGroupError({ chatId: message.chatId, senderId: message.senderId, code: 'GROUP_PRIVATE_SEND_FAILED', message: detail })
        }
      }
      rememberDeliveryStage(message, 'done')
    }
  }

  return {
    handle(frame: unknown): Promise<void> {
      const message = readGroupMessage(frame)
      if (message === undefined) return Promise.resolve()
      rememberGroupFrame(message)
      if (frame !== null && typeof frame === 'object') {
        if (handled.has(frame)) return Promise.resolve()
        handled.add(frame)
      }
      if (safeHasSeen(deps.state, message.messageId)) return Promise.resolve()
      // 方案 B：同一群共用一个 session，必须整群串行；不同群仍可并行。
      const queueKey = message.chatId
      const previous = queues.get(queueKey) ?? Promise.resolve()
      const task = previous
        .catch(() => undefined)
        .then(() => run(message))
        .finally(() => {
          if (queues.get(queueKey) === task) queues.delete(queueKey)
          inFlight.delete(task)
        })
      queues.set(queueKey, task)
      inFlight.add(task)
      return task
    },
    async waitForIdle(): Promise<void> {
      await Promise.allSettled([...inFlight])
    },
  }
}

/** 群进度卡的只读接缝。 */
export type GroupDeliveryMode = 'stream' | 'fallback'

interface GroupProgress {
  start(): Promise<void>
  update(text: string): Promise<void>
  finish(text: string, stage?: string): Promise<void>
}

/**
 * 一张群进度卡的串行发送队列。
 *
 * 企微流式卡片只能更新同一 `streamId`，且 10 分钟后失效；这里把 start/update/finish
 * 排成一条链，任何一次失败都只降级为最终单条消息，不会重复刷屏。
 */
function createGroupProgress(
  client: GroupChatDeps['client'],
  message: GroupMessage,
  logger: GroupChatDeps['logger'],
  onStage?: (stage: string, mode: GroupDeliveryMode) => void,
): GroupProgress {
  const streamId = `group_${randomUUID()}`
  /** fallback 模式下最多补发的工具阶段普通消息数；首条“已收到”不算。 */
  const MAX_FALLBACK_PHASE_MESSAGES = 3
  let mode: GroupDeliveryMode = 'stream'
  let alive = false
  let finished = false
  let lastText = ''
  let fallbackPhases = 0
  let chain: Promise<void> = Promise.resolve()

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    chain = chain.then(
      () => withDeliveryTimeout(work(), 'progress-chain'),
      () => withDeliveryTimeout(work(), 'progress-chain'),
    ).catch((error: unknown) => {
      logger.warn(
        `[dataops-im] group progress failed chat=${mask(message.chatId)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    return chain
  }

  const sendPlain = async (text: string, label: string): Promise<void> => {
    for (const chunk of splitUtf8Bytes(text, MAX_REPLY_BYTES)) {
      await withDeliveryTimeout(
        client.sendMessage(message.chatId, { msgtype: 'markdown', markdown: { content: chunk } }),
        label,
      )
    }
  }

  const enterFallback = (stage: string): void => {
    mode = 'fallback'
    alive = false
    onStage?.(stage, 'fallback')
  }

  return {
    start(): Promise<void> {
      return enqueue(async () => {
        onStage?.('progress-start', 'stream')
        try {
          await withDeliveryTimeout(
            client.replyStream(message.frame, streamId, PROGRESS_RECEIVED, false),
            'progress-start',
          )
          mode = 'stream'
          alive = true
          lastText = PROGRESS_RECEIVED
        } catch (error) {
          // 流式不可用/超时：至少用普通消息发一次“已收到”，不能让用户完全无提示。
          enterFallback('progress-fallback')
          logger.warn(
            `[dataops-im] group progress start fallback chat=${mask(message.chatId)}: ${error instanceof Error ? error.message : String(error)}`,
          )
          try {
            await sendPlain(PROGRESS_RECEIVED, 'progress-fallback')
          } catch (fallbackError) {
            logger.warn(
              `[dataops-im] group progress fallback failed chat=${mask(message.chatId)}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
            )
          }
        }
      })
    },
    update(text: string): Promise<void> {
      return enqueue(async () => {
        onStage?.('progress-update', mode)
        if (finished || text.trim() === '' || text === lastText) return
        lastText = text
        if (mode === 'stream' && alive) {
          try {
            await withDeliveryTimeout(
              client.replyStream(message.frame, streamId, text, false),
              'progress-update',
            )
            return
          } catch {
            enterFallback('progress-fallback')
          }
        }
        // B) 普通消息兜底：只在阶段切换时发，最多 3 条，避免刷屏。
        if (mode !== 'fallback' || fallbackPhases >= MAX_FALLBACK_PHASE_MESSAGES) return
        fallbackPhases += 1
        try {
          await sendPlain(text, 'progress-fallback')
        } catch (error) {
          logger.warn(
            `[dataops-im] group fallback phase failed chat=${mask(message.chatId)}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })
    },
    finish(text: string, stage = 'progress-finish'): Promise<void> {
      return enqueue(async () => {
        if (finished) return
        finished = true
        onStage?.(stage, mode)
        const content = text.trim() === '' ? '（处理完成。）' : text
        // A) 流式卡收尾；B) fallback 直接发一条普通最终消息（不再尝试流式）。
        if (mode === 'fallback' || !alive) {
          await sendPlain(content, 'group-final')
          return
        }
        const chunks = splitUtf8Bytes(content, MAX_REPLY_BYTES)
        try {
          await withDeliveryTimeout(
            client.replyStream(message.frame, streamId, chunks[0]!, true),
            'progress-finish',
          )
        } catch {
          // finish 被拒绝（卡片过期/限流/超时）：退回最终单条回复，不重试同一张卡。
          enterFallback('progress-fallback')
          await sendPlain(content, 'group-final')
          return
        }
        for (const chunk of chunks.slice(1)) {
          try {
            await withDeliveryTimeout(
              client.sendMessage(message.chatId, { msgtype: 'markdown', markdown: { content: chunk } }),
              'progress-chunk',
            )
          } catch (error) {
            logger.warn(
              `[dataops-im] group progress chunk failed chat=${mask(message.chatId)}: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
      })
    },
  }
}

/* ------------------------------------------------------------------ */
/* 证据探针：在生产 DSH 进程内用合成企微帧驱动真实 Router/Harness。       */
/* ------------------------------------------------------------------ */

/** 进程内已构造的群聊 Router；仅用于 env 显式开启的证据探针。 */
const probeRouters = new Map<string, { makeRouter: () => GroupChatRouter; state: GroupChatDeps['state'] }>()

/**
 * 记录一个已加载群聊 Router 的工厂。
 *
 * 探针需要绕过 WeCom runtime 的 stop signal（真实 @ 只有 runtime 在线时才会到达；
 * 合成帧不应因 runtime 重连中断而失败），因此每次探针新建一个无 signal 的 Router，
 * 其余 host/state/harness/actor 完全一致。
 */
function registerGroupProbeRouter(
  botId: string,
  makeRouter: () => GroupChatRouter,
  state: GroupChatDeps['state'],
): void {
  if (botId === '') return
  probeRouters.set(botId, { makeRouter, state })
}

/** 合成帧探针输入；只给本地证据使用。 */
export interface GroupProbeInput {
  readonly botId?: string
  readonly chatId: string
  readonly senderId: string
  readonly senderName?: string
  readonly messageId?: string
  readonly text: string
}

/** 合成帧探针输出；含回复文本与会话 id，供证据 JSON 使用。 */
export interface GroupProbeOutput {
  readonly ok: boolean
  readonly chatId: string
  readonly senderId: string
  readonly messageId: string
  readonly sessionId?: string
  readonly replies: {
    readonly kind: 'group' | 'direct'
    readonly via: 'replyStream' | 'sendMessage'
    readonly content: string
    readonly finish?: boolean
  }[]
  readonly warnings?: string[]
  readonly durationMs: number
}

/**
 * 用一条合成群帧跑完整生产路由（fake 企微客户端只记录回复，不连企微）。
 *
 * 该函数必须运行在 DSH Host 进程内，才能访问真实 `harness` 与 `ctx.sessions`；
 * 由 `/integrations/dataops/private-chat/probe` 在 `DATAOPS_IM_GROUP_PROBE=1` 时暴露。
 */
export async function probeGroupChatFrame(input: GroupProbeInput): Promise<GroupProbeOutput> {
  const entry = input.botId === undefined
    ? [...probeRouters.values()][0]
    : probeRouters.get(input.botId)
  if (entry === undefined) {
    throw new GroupChatError('GROUP_PROBE_UNAVAILABLE', '当前进程没有已加载的群聊 Runtime。')
  }
  const messageId = input.messageId ?? `probe-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const replies: GroupProbeOutput['replies'][number][] = []
  const warnings: string[] = []
  const client: GroupChatDeps['client'] = {
    async replyStream(_frame, _streamId, content, finish) {
      replies.push({ kind: 'group', via: 'replyStream', content, ...(finish ? { finish: true } : {}) })
      return {}
    },
    async sendMessage(target, content) {
      const body = content as { markdown?: { content?: unknown } } | undefined
      const text = typeof body?.markdown?.content === 'string' ? body.markdown.content : String(content)
      replies.push({ kind: target === input.chatId ? 'group' : 'direct', via: 'sendMessage', content: text })
      return {}
    },
  }
  const probeRouter = entry.makeRouter()
  const handler = createGroupChatHandler({
    client,
    state: entry.state,
    router: probeRouter,
    logger: { warn: message => { warnings.push(message) } },
  })
  const frame = {
    body: {
      chattype: 'group',
      chatid: input.chatId,
      msgid: messageId,
      msgtype: 'text',
      create_time: Math.floor(Date.now() / 1000),
      from: { userid: input.senderId, ...(input.senderName === undefined ? {} : { name: input.senderName }) },
      text: { content: input.text },
    },
  }
  const startedAt = Date.now()
  await handler.handle(frame)
  return {
    ok: true,
    chatId: input.chatId,
    senderId: input.senderId,
    messageId,
    ...(probeRouter.sessionIdFor(input.chatId) === undefined
      ? {}
      : { sessionId: probeRouter.sessionIdFor(input.chatId)! }),
    replies,
    warnings,
    durationMs: Date.now() - startedAt,
  }
}

/** 从 WeCom 帧里读取群消息字段；不是群聊/结构不对返回 undefined。 */
export function readGroupMessage(frame: unknown): GroupMessage | undefined {
  if (frame === null || typeof frame !== 'object') return undefined
  const body = (frame as { body?: unknown }).body
  if (body === null || typeof body !== 'object') return undefined
  const value = body as {
    chattype?: unknown
    chatid?: unknown
    msgid?: unknown
    msgtype?: unknown
    create_time?: unknown
    chatname?: unknown
    chat_name?: unknown
    groupname?: unknown
    externalName?: unknown
    from?: { userid?: unknown; name?: unknown }
    text?: { content?: unknown }
    voice?: { content?: unknown }
    mixed?: { msg_item?: unknown }
  }
  if (value.chattype !== 'group') return undefined
  const chatId = textOf(value.chatid)
  const messageId = textOf(value.msgid)
  const senderId = textOf(value.from?.userid)
  if (chatId === '' || messageId === '' || senderId === '') return undefined
  const externalName = firstText(value.chatname, value.chat_name, value.groupname, value.externalName)
  const receivedAt = receivedAtOf(value.create_time)
  return {
    frame,
    messageId,
    chatId,
    senderId,
    senderName: textOf(value.from?.name),
    text: stripLeadingMention(messageContentText(value)),
    ...(receivedAt === undefined ? {} : { receivedAt }),
    ...(externalName === undefined ? {} : { externalName }),
  }
}

/** 群里的 `/status`、`/menu` 等命令仍交给 dsh-im 原 Bridge，保持既有菜单行为。 */
function isGroupCommand(text: string): boolean {
  return /^\s*\//u.test(text)
}

/** 读取文本类消息内容（text / voice / mixed 中的文本）。 */
function messageContentText(body: {
  msgtype?: unknown
  text?: { content?: unknown }
  voice?: { content?: unknown }
  mixed?: { msg_item?: unknown }
}): string {
  if (body.msgtype === 'text') return textOf(body.text?.content)
  if (body.msgtype === 'voice') return textOf(body.voice?.content)
  if (body.msgtype === 'mixed' && Array.isArray(body.mixed?.msg_item)) {
    return body.mixed.msg_item
      .filter((item) => (item as { msgtype?: unknown })?.msgtype === 'text')
      .map((item) => textOf((item as { text?: { content?: unknown } }).text?.content))
      .filter((text) => text !== '')
      .join('\n')
  }
  return ''
}

/**
 * 群回调保留开头 `@机器人`，它是路由标记，不是用户问题的一部分。
 *
 * 企微 CLI/回调里 mention 与问题之间可能没有空格（`@万相专家你好`），不能贪婪匹配
 * `@\S+`；只剥已知机器人名，未知 mention 保留，避免把用户问题整条吃掉。
 */
function stripLeadingMention(text: string): string {
  const known = ['@万相专家', '@万相', '@企业微信机器人']
  const trimmed = text.trimStart()
  for (const mention of known) {
    if (trimmed.startsWith(mention)) {
      return trimmed.slice(mention.length).replace(/^[\s\u2000-\u200b]+/u, '').trim()
    }
  }
  return text.replace(/^\s*@[^\s@]{1,32}(?=\s|$)\s*/u, '').trim()
}

/** 安全读取对象里的字符串字段。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 取第一个非空字符串。 */
function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = textOf(value)
    if (text !== '') return text
  }
  return undefined
}

/** WeCom 帧的 create_time 可能是秒或毫秒；转成带时区的 ISO。 */
function receivedAtOf(value: unknown): string | undefined {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/u.test(value.trim())
      ? Number(value)
      : Number.NaN
  if (Number.isFinite(number) && number > 0) {
    const millis = number > 1e12 ? number : number * 1000
    const date = new Date(millis)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }
  return undefined
}

/** 把后端返回的 sender_only ack / room_safe 正文发回群，首块优先用回复流。 */
async function sendToGroup(
  client: GroupChatDeps['client'],
  frame: unknown,
  chatId: string,
  text: string,
): Promise<void> {
  const chunks = splitUtf8Bytes(text, MAX_REPLY_BYTES)
  if (chunks.length === 0) return
  try {
    await withDeliveryTimeout(
      client.replyStream(frame, `group_${randomUUID()}`, chunks[0]!, true),
      'group-reply',
    )
  } catch {
    await withDeliveryTimeout(
      client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: chunks[0]! } }),
      'group-send',
    )
  }
  for (const chunk of chunks.slice(1)) {
    await withDeliveryTimeout(
      client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: chunk } }),
      'group-send',
    )
  }
}

/** 把完整结果发到 sender 的企微私聊（chatid = 用户 userid）。 */
async function sendToSender(
  client: GroupChatDeps['client'],
  senderId: string,
  text: string,
): Promise<void> {
  for (const chunk of splitUtf8Bytes(text, MAX_REPLY_BYTES)) {
    await withDeliveryTimeout(
      client.sendMessage(senderId, { msgtype: 'markdown', markdown: { content: chunk } }),
      'private-send',
    )
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

/**
 * 这些错误意味着缓存的共享 session 不可再用，值得按当前工作区重建一次。
 *
 * dsh-im 的 harness 在会话日志损坏/归档时抛带 `code` 的错误；普通超时、模型失败、
 * actor/凭据失败都不重建，避免把认证问题伪装成“换一个会话就好了”。
 */
function isRecoverableSessionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  return code === 'session-unreadable'
    || code === 'session-archived'
    || code === 'session-not-found'
}

/** 从 Nest 错误体里取一句可读消息。 */
function explicitMessage(body: { message?: unknown } | undefined): string | undefined {
  const message = body?.message
  return typeof message === 'string' && message !== '' ? message : undefined
}

/** 脱敏 id（日志用）。 */
function mask(value: string): string {
  if (value.length <= 2) return '*'.repeat(value.length)
  return `${value.slice(0, 2)}***${value.slice(-2)}`
}

/**
 * 给一次企微投递加硬超时。
 *
 * 企微 SDK 的 replyStream/sendMessage 在卡片过期、频控或连接半死时可能永不 settle；
 * 进度链和最终 ack 不能被它挂住。超时后由调用方降级到普通消息/下一阶段。
 */
function withDeliveryTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`delivery timeout (${label})`))
    }, DELIVERY_TIMEOUT_MS)
    timer.unref?.()
    operation.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** 简单等待。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 安全读取去重状态。 */
function safeHasSeen(state: GroupChatDeps['state'], messageId: string): boolean {
  try {
    return state.hasSeen(messageId)
  } catch {
    return false
  }
}

/** 去重失败不应让用户丢掉回复。 */
async function safeMarkSeen(state: GroupChatDeps['state'], messageId: string): Promise<void> {
  try {
    await state.markSeen(messageId)
  } catch {
    // 后端账本仍是最终幂等边界。
  }
}

/* ------------------------------------------------------------------ */
/* 结果分级：群消息是广播，无法证明全群可看就只回 sender 私聊。          */
/* ------------------------------------------------------------------ */

/** 默认允许回群的类型；其余一律 sender_only。 */
const ROOM_SAFE_TYPES = new Set<ExternalResultType>([
  'weekly_report',
  'meeting_notes',
  'public_knowledge',
])

/**
 * 是否走公开共享 session 的候选类型。
 *
 * 只有周报/纪要/公开知识在**执行前**可以进共享 session；其余类型默认 sender_only，
 * 从共享公开历史 fork turn-private child 执行，避免敏感结果落进共享日志。
 */
export function isPublicCandidate(resultType: ExternalResultType): boolean {
  return ROOM_SAFE_TYPES.has(resultType)
}

/**
 * 按用户请求判定结果类型。
 *
 * 这是保守的确定性规则，不是权限判定：服务端仍会按 resultType 再裁决一次，
 * 且账号/凭据类即使被误判为公开也会被服务端拒绝。
 */
export function classifyGroupRequest(text: string): ExternalResultType {
  const value = text.trim()
  if (value === '') return 'other'
  if (/密码|密钥|私钥|凭据|token|secret|cookie|连接串/iu.test(value)) return 'credential'
  if (/账号|账户|角色|权限|授权|成员列表|用户列表/iu.test(value)) return 'account'
  if (/周报|周工作总结|本周工作|工作周报|周汇报/iu.test(value)) return 'weekly_report'
  if (/会议纪要|会议记录|会议总结|会议要点|纪要/iu.test(value)) return 'meeting_notes'
  if (/(知识库|kb|附件|pdf|文档内容|文件内容|资料).*(查|找|读|看|总结|内容)|(查|找|读|看|总结).*(知识库|kb|附件|pdf|文档|文件|资料)/iu.test(value)) {
    return 'kb_file'
  }
  if (/\bsql\b|select\s|数据库|表结构|建表|查询语句/iu.test(value)) return 'sql'
  if (/明细|清单|名单|逐条|每一条|行数据/iu.test(value)) return 'detail'
  if (/数据|查询|统计|指标|报表|多少|排名|趋势|同比|环比|汇总|计算/iu.test(value)) return 'data_query'
  if (/你好|您好|大家好|在吗|你是谁|能做什么|会什么|帮助|help|hi|hello|介绍一下|使用说明|怎么用/iu.test(value)) {
    return 'public_knowledge'
  }
  if (/公开|制度|规章|流程|公告|知识/iu.test(value)) return 'public_knowledge'
  return 'other'
}

/**
 * 建议 audience；最终以后端 `/replies` 的返回为准。
 *
 * 模型说“可以公开”不作为依据：只有请求类型本身允许回群，且答案没有明显敏感标记时才建议
 * `room_safe`。KB 文件需要 room 内成员批量 canRead，本连接器拿不到该证明，默认私聊。
 */
export function decideAudience(
  resultType: ExternalResultType,
  answer: string,
): GroupAudience {
  if (resultType === 'account' || resultType === 'credential') return 'sender_only'
  if (resultType === 'kb_file') return 'sender_only'
  if (!ROOM_SAFE_TYPES.has(resultType)) return 'sender_only'
  // 周报/会议纪要本身就是给群里看的摘要。只拦截“真实明细/真实凭据/SQL 结果”，
  // 不能因为摘要里出现“账号/权限/密码”这些词、或用了 dsh-ui 代码块，就把整篇降级私聊。
  if (resultType === 'weekly_report' || resultType === 'meeting_notes') {
    return containsHardSensitiveAnswer(answer) ? 'sender_only' : 'room_safe'
  }
  return containsSensitiveAnswer(answer) ? 'sender_only' : 'room_safe'
}

/**
 * 周报/纪要的硬敏感判据：只拦真实资源标识、SQL 结果、凭据值/私钥。
 * 普通“账号/权限/密码”字样只是话题名，不作为降级依据。
 */
function containsHardSensitiveAnswer(answer: string): boolean {
  return /resource:table:|resource:kb:/iu.test(answer)
    || /```sql/iu.test(answer)
    || /\bselect\b[\s\S]{0,300}\bfrom\b/iu.test(answer)
    || /(?:密码|口令|secret|token|api[_-]?key)\s*[:=：]\s*[^\s，。；]{6,}/iu.test(answer)
    || /-----BEGIN [A-Z ]+PRIVATE KEY-----/u.test(answer)
}

/** 查询/明细类的敏感判据；出现明细/凭据/资源标识时降级私聊。 */
function containsSensitiveAnswer(answer: string): boolean {
  return /密码|密钥|私钥|凭据|token|secret|cookie|身份证|手机号|客户名|客户明细|账号|权限|resource:table:|resource:kb|\bselect\b/iu.test(answer)
    || /\n\s*\|[^\n]*\|/u.test(answer)
    || /```(?:sql)?/iu.test(answer)
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

/** Runtime 子类构造参数里我们关心的字段。 */
interface RuntimeOptions extends Record<string, unknown> {
  config?: { remoteBotId?: unknown; secretRef?: unknown; botName?: unknown }
}

/**
 * 构造一个同时接管私聊与群聊的 Runtime 子类。
 *
 * - `chattype=single` 继续走 `createDirectChatHandler`（私聊落提问者自己的默认工作区）；
 * - `chattype=group` 且不是 `/命令` 时走 `createGroupChatHandler`（全群共享一个 session，
 *   每条消息按 sender 切换 actor）；
 * - 群命令与其它帧仍交给 dsh-im 原 Bridge，保持菜单/事件行为不变。
 *
 * @param host - DataOps 地址、凭据名与日志。
 */
export async function createGroupChatRuntime(
  host: PrivateChatHost,
): Promise<new (options: RuntimeOptions) => DshImRuntime> {
  const { WecomRuntime, WecomHarnessBridge } = await loadDshImInternals()

  class ImChatBridge extends WecomHarnessBridge {
    private readonly direct: DirectChatHandler
    private readonly group: GroupChatHandler

    constructor(options: Record<string, unknown>) {
      super(options)
      const botId = typeof options.botId === 'string' ? options.botId : ''
      const privateRouter = new PrivateChatRouter(host, botId)
      this.direct = createDirectChatHandler({
        client: options.client as DirectChatDeps['client'],
        state: options.state as DirectChatDeps['state'],
        router: privateRouter,
        logger: host.logger,
        signal: options.signal as AbortSignal | undefined,
      })
      const makeGroupRouter = (signal: AbortSignal | undefined): GroupChatRouter => new GroupChatRouter({
        host,
        botId,
        ...(typeof options.botName === 'string' && options.botName.trim() !== ''
          ? { botName: options.botName }
          : {}),
        state: options.state as GroupChatState,
        ...(options.history === undefined
          ? {}
          : { history: options.history as GroupHistoryProvider }),
        ...(options.harness === undefined ? {} : { harness: options.harness as GroupHarness }),
        ...(signal === undefined ? {} : { signal }),
      })
      const groupRouter = makeGroupRouter(options.signal as AbortSignal | undefined)
      registerGroupProbeRouter(botId, () => makeGroupRouter(undefined), options.state as GroupChatDeps['state'])
      this.group = createGroupChatHandler({
        client: options.client as GroupChatDeps['client'],
        state: options.state as GroupChatDeps['state'],
        router: groupRouter,
        logger: host.logger,
        signal: options.signal as AbortSignal | undefined,
      })
    }

    accept(frame: unknown): Promise<void> {
      const groupMessage = readGroupMessage(frame)
      if (groupMessage !== undefined) {
        // 命令保持 dsh-im 既有菜单/会话命令语义；普通群消息才走共享群 session。
        if (isGroupCommand(groupMessage.text)) return super.accept(frame)
        return this.group.handle(frame)
      }
      return this.direct.handle(frame)
    }

    async waitForIdle(): Promise<void> {
      await Promise.all([
        super.waitForIdle(),
        this.direct.waitForIdle(),
        this.group.waitForIdle(),
      ])
    }
  }

  return class GroupChatRuntime extends WecomRuntime {
    constructor(options: RuntimeOptions) {
      const botId = typeof options.config?.remoteBotId === 'string' ? options.config.remoteBotId : ''
      const secretRef = typeof options.config?.secretRef === 'string' ? options.config.secretRef : undefined
      const botName = typeof options.config?.botName === 'string' ? options.config.botName : undefined
      const masked = botId === '' ? '-' : `***${botId.slice(-6)}`
      installedRuntimes.set(masked, Date.now())
      const history = botId !== '' && host.historySync?.enabled === true
        ? historyCliInstalled(host.historySync)
          ? ensureGroupHistorySync(host, botId, secretRef, host.historySync)
          : undefined
        : undefined
      if (host.historySync?.enabled === true && history === undefined) {
        host.logger.warn('[dataops-im] history-sync enabled but CLI is not installed; live @ path continues')
      }
      if (installedRuntimes.size > 20) {
        const oldest = installedRuntimes.keys().next().value
        if (oldest !== undefined) installedRuntimes.delete(oldest)
      }
      host.logger.info?.(`[dataops-im] group-chat runtime installed bot=${masked}`)
      super({
        ...options,
        createBridge: (bridgeOptions: Record<string, unknown>) => new ImChatBridge({
          ...bridgeOptions,
          botId,
          ...(botName === undefined ? {} : { botName }),
          history,
        }),
      })
    }
  }
}