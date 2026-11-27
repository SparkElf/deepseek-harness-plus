/**
 * 企微群历史同步：把群里**未 @ 机器人**的消息也补进 DataOps 群聊 room。
 *
 * 实时 @ 链路仍由 `group-chat.ts` 的 WebSocket 入站处理；本模块是独立的拉取式后台任务：
 *
 * 1. 每 5 分钟（可配 5–10 分钟）用 `@wecom/cli@1.3.4` 的 `chat groups list` /
 *    `chat messages list` 拉最近 7 天群消息；
 * 2. 无 `msgid`，用 `(chatId, send_time, userid, msg_type, text_hash, same_second_ordinal)`
 *    的复合键去重；每群保存 `lastSendTime`，下一轮从 `lastSendTime - 10 分钟` 起拉；
 * 3. 归一化后调用 `/api/ai/chat/external/ingest` 写入 room；后端固定
 *    `authorKind=external`，新建 room 的 `agentTrigger=never`，不会触发任何人的 agent；
 * 4. @ 时 `group-chat.ts` 从本地环形缓存取最近 N 条，拼进 sender 的 prompt，让 agent
 *    能基于未 @ 的会议纪要/讨论生成周报。
 *
 * 安全边界：
 * - CLI 以独立 `HOME` 运行，凭据只在 CLI 自己的 `.config/wecom`（0600）；不写进 workspace，
 *   不进 PATH，不打印 Secret/token；
 * - 只解析 CLI 响应的 `messages` / `chats` / 分页字段，丢弃 `security_notice` 与
 *   `extra_identity_context`；
 * - 文件/图片/语音/视频 v1 同步未验证，只记 TODO 计数，不写 room、不进 prompt。
 *
 * @module connector/history-sync
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** 与 dsh-im 一致的最小日志面；不允许记录凭据。 */
export interface HistorySyncLogger {
  info?(message: string): void
  warn(message: string): void
  error?(message: string): void
}

/** history-sync 的宿主依赖；与 `PrivateChatHost` 解耦，便于单测。 */
export interface HistorySyncHost {
  /** DSH 上下文，用来解析机器人服务账号 credential。 */
  readonly ctx: Context
  /** DataOps API origin（不含 `/api`）。 */
  readonly baseUrl: string
  /** 机器人服务账号 JWT 的凭据名。 */
  readonly credentialRef: string
  readonly logger: HistorySyncLogger
  /** 测试注入点；生产走 globalThis.fetch。 */
  readonly fetchImpl?: typeof fetch
  /** 测试注入点；生产走 Date.now。 */
  readonly now?: () => number
}

/** 一条归一化后的群消息。 */
export interface HistoryMessage {
  readonly chatId: string
  /** 企微秒级时间，固定 `YYYY-MM-DD HH:MM:SS`（+08:00）。 */
  readonly sendTime: string
  /** sendTime 对应的 epoch 毫秒。 */
  readonly sendTimeMs: number
  readonly userId: string
  readonly userName?: string
  readonly msgType: string
  /** 文本消息归一化后的正文；非文本为空串。 */
  readonly text: string
  readonly textHash: string
  /** 同秒同发送者同类型同文本的第几条，从 0 开始。 */
  readonly sameSecondOrdinal: number
  /** 复合去重键（sha256 hex）。 */
  readonly dedupKey: string
  /** 交给 `/ingest` 的稳定 messageId；复用后端 `(botId, group, messageId)` 账本。 */
  readonly messageId: string
}

/** 一条本地缓存消息，带来源，供 @ 时拼 prompt。 */
export interface StoredHistoryMessage {
  readonly chatId: string
  readonly sendTime: string
  readonly sendTimeMs: number
  readonly userId: string
  readonly userName?: string
  readonly msgType: string
  readonly text: string
  readonly textHash: string
  readonly sameSecondOrdinal: number
  readonly dedupKey: string
  readonly source: 'cli' | 'live'
}

/** 每群持久状态。 */
export interface HistoryGroupState {
  readonly chatId: string
  chatName?: string
  /** 已成功处理（入库或明确跳过）的最大 send_time。 */
  lastSendTime?: string
  lastRunAt?: number
  firstSyncDone: boolean
  /** 已见复合键；保留最近 5000 个，覆盖 10 分钟 overlap 足够。 */
  seen: string[]
  /** 最近消息环形缓存；@ 时只取最后 N 条。 */
  messages: StoredHistoryMessage[]
  /** 文件/图片/语音/视频：v1 只计数，TODO 第二阶段接 `message files get` → KB。 */
  pendingMedia: number
}

/** 落盘状态。 */
export interface HistorySyncState {
  version: 1
  groups: Record<string, HistoryGroupState>
}

/** 运行时配置；全部可由环境变量覆盖。 */
export interface HistorySyncConfig {
  readonly enabled: boolean
  readonly intervalMs: number
  readonly contextLimit: number
  readonly firstRunRoomLimit: number
  readonly overlapMinutes: number
  readonly requestTimeoutMs: number
  readonly cliPath: string
  readonly cliHome: string
  readonly nodePath: string
  readonly dataDir: string
  /** CLI 降权运行的 uid/gid；缺省不降权（仅测试）。 */
  readonly uid?: number
  readonly gid?: number
  /** 降权用户；默认 `nobody`（镜像自带，凭据目录属主）。 */
  readonly runAs?: string
  /** CLI 桥地址；设置时 DSH 进程不直接 spawn CLI（它没有 capabilities）。 */
  readonly bridgeUrl?: string
  /** 只同步这些 chatId；空数组表示同步 CLI 返回的全部群。 */
  readonly chatAllowlist: readonly string[]
  /** prompt 里历史正文的字符上限，防止长文撑爆上下文。 */
  readonly maxContextChars: number
  /** 群内 @ 机器人的展示名；用于剥离 mention 前缀。 */
  readonly botMentions: readonly string[]
  /** 首次同步时只把最近 N 条写进 room；更早的只落本地账本。 */
  readonly firstSyncAtMs?: number
}

/** 默认值；5 分钟在需求 5–10 分钟区间内。 */
export const DEFAULT_HISTORY_SYNC_CONFIG: Omit<HistorySyncConfig, 'enabled' | 'cliPath' | 'cliHome' | 'nodePath' | 'dataDir'> = {
  intervalMs: 5 * 60_000,
  contextLimit: 50,
  firstRunRoomLimit: 50,
  overlapMinutes: 10,
  requestTimeoutMs: 60_000,
  chatAllowlist: [],
  maxContextChars: 12_000,
  botMentions: [],
}

/** 状态路由用的只读摘要。 */
export interface HistorySyncStatus {
  readonly enabled: boolean
  readonly running: boolean
  readonly lastRunAt?: number
  readonly lastSuccessAt?: number
  readonly lastError?: string
  readonly groups: number
  readonly lastFetched: number
  readonly lastIngested: number
  readonly lastSkipped: number
  /** 已启用但 CLI 尚未授权时给出可读原因（不含凭据）。 */
  readonly auth: 'unknown' | 'authorized' | 'unauthorized' | 'unavailable'
  readonly lastRefreshMs?: number
  readonly lastRefreshTimedOut?: boolean
  readonly lastPromptMessages?: number
}

const MAX_SEEN_PER_GROUP = 5_000
const MAX_MESSAGES_PER_GROUP = 1_000
const MAX_CLI_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_PAGES = 100
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000

/** 已启动的同步器（每个 bot 一个），便于状态路由和避免重复定时器。 */
const syncRegistry = new Map<string, HistorySync>()

/** 读取当前进程里的 history-sync 状态；供 `/private-chat/status` 诊断。 */
export function historySyncStatus(): HistorySyncStatus[] {
  return [...syncRegistry.values()].map(sync => sync.status())
}

/** 企微群里 @ 机器人时的常见展示名；用于剥离开头的 mention。 */
export const DEFAULT_BOT_MENTIONS: readonly string[] = ['万相专家', '万相', '企业微信机器人']

/**
 * 归一化文本：剥离开头 @ 机器人 mention、统一换行、trim。
 *
 * 企微 CLI 返回的正文常是 `@万相专家你好`（mention 与问题之间没有空格），不能用
 * `^\s*@\S+` 贪婪匹配，否则会把整条问题吃掉。这里只剥已知 mention 前缀；未知 mention
 * 原样保留，宁可多一个 @ 也不丢用户内容。
 */
export function normalizeHistoryText(value: string, mentions: readonly string[] = DEFAULT_BOT_MENTIONS): string {
  let text = value.replace(/\r\n?/gu, '\n')
  for (const mention of mentions) {
    if (mention === '') continue
    const prefix = `@${mention}`
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length).replace(/^[\s\u2000-\u200b]+/u, '')
      break
    }
  }
  // 兼容带空格的未知 mention；没有空格时保留原文。
  text = text.replace(/^\s*@[^\s@]{1,32}(?=\s|$)\s*/u, '')
  return text.trim()
}

/** 文本哈希（sha256 hex）。 */
export function historyTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 复合去重键：`(chatId, send_time, userid, msg_type, text_hash, same_second_ordinal)`。 */
export function historyDedupKey(input: {
  chatId: string
  sendTime: string
  userId: string
  msgType: string
  textHash: string
  sameSecondOrdinal: number
}): string {
  return createHash('sha256')
    .update([
      input.chatId,
      input.sendTime,
      input.userId,
      input.msgType,
      input.textHash,
      String(input.sameSecondOrdinal),
    ].join('\u0000'), 'utf8')
    .digest('hex')
}

/** 后端 messageId：保留 `hist:v1:` 前缀，长度 < 200。 */
export function historyMessageId(dedupKey: string): string {
  return `hist:v1:${dedupKey}`
}

/** 企微秒级时间 → epoch 毫秒（按 +08:00 解释）。 */
export function parseWecomTime(value: string): number {
  const parsed = Date.parse(value.replace(' ', 'T') + '+08:00')
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/** epoch 毫秒 → 企微秒级时间（固定 +08:00，避免容器 UTC 时区偏移）。 */
export function formatWecomTime(ms: number): string {
  return new Date(ms + CHINA_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * 给一批消息分配 `same_second_ordinal`。
 *
 * 同一 batch 内按 `(chatId, sendTime, userId, msgType, textHash)` 计数；调用方应先把消息
 * 按时间升序排好，再调用本函数，这样重复同步同一时间窗会得到同样的序号。
 */
export function assignSameSecondOrdinals<T extends {
  readonly chatId: string
  readonly sendTime: string
  readonly userId: string
  readonly msgType: string
  readonly textHash: string
}>(messages: readonly T[]): (T & { sameSecondOrdinal: number; dedupKey: string; messageId: string })[] {
  const counters = new Map<string, number>()
  return messages.map((message) => {
    const tuple = [message.chatId, message.sendTime, message.userId, message.msgType, message.textHash].join('\u0000')
    const ordinal = counters.get(tuple) ?? 0
    counters.set(tuple, ordinal + 1)
    const dedupKey = historyDedupKey({ ...message, sameSecondOrdinal: ordinal })
    return {
      ...message,
      sameSecondOrdinal: ordinal,
      dedupKey,
      messageId: historyMessageId(dedupKey),
    }
  })
}

/** 从 CLI 消息对象里取正文；mixed 只取文本片段，文件/图片留空。 */
function messageText(record: Record<string, unknown>, mentions: readonly string[]): string {
  const type = typeof record.msg_type === 'string' ? record.msg_type : ''
  if (type === 'text') {
    const text = record.text as { content?: unknown } | undefined
    return normalizeHistoryText(typeof text?.content === 'string' ? text.content : '', mentions)
  }
  if (type === 'mixed') {
    const mixed = record.mixed as { items?: unknown; msg_item?: unknown } | undefined
    const items = Array.isArray(mixed?.items)
      ? mixed.items
      : Array.isArray(mixed?.msg_item)
        ? mixed.msg_item
        : []
    return normalizeHistoryText(items.flatMap((item) => {
      const value = item as { msg_type?: unknown; text?: { content?: unknown } }
      return value.msg_type === 'text' && typeof value.text?.content === 'string'
        ? [value.text.content]
        : []
    }).join('\n'), mentions)
  }
  return ''
}

/** 非文本消息的媒体标识；只参与哈希，不拉取。 */
function mediaDescriptor(record: Record<string, unknown>): string {
  const type = typeof record.msg_type === 'string' ? record.msg_type : 'unknown'
  const section = record[type] as { media_id?: unknown; file_name?: unknown } | undefined
  return `${type}:${typeof section?.media_id === 'string' ? section.media_id : typeof section?.file_name === 'string' ? section.file_name : ''}`
}

/** 把 CLI 的一条消息归一化；调用方负责排序和序号。 */
export function normalizeCliMessage(
  chatId: string,
  record: Record<string, unknown>,
  mentions: readonly string[] = DEFAULT_BOT_MENTIONS,
): {
  chatId: string
  sendTime: string
  sendTimeMs: number
  userId: string
  userName?: string
  msgType: string
  text: string
  textHash: string
} | undefined {
  const sendTime = typeof record.send_time === 'string' ? record.send_time.trim() : ''
  const userId = typeof record.userid === 'string' ? record.userid.trim() : ''
  const msgType = typeof record.msg_type === 'string' ? record.msg_type.trim() : ''
  if (sendTime === '' || userId === '' || msgType === '') return undefined
  const sendTimeMs = parseWecomTime(sendTime)
  if (!Number.isFinite(sendTimeMs)) return undefined
  const userName = typeof record.user_name === 'string' && record.user_name.trim() !== ''
    ? record.user_name.trim()
    : undefined
  const text = messageText(record, mentions)
  // 非文本消息也保留一条 hash 记录用于去重/计数，但正文为空；v1 不写 room。
  const textHash = messageTextHash(msgType, text, record)
  return { chatId, sendTime, sendTimeMs, userId, ...userName === undefined ? {} : { userName }, msgType, text, textHash }
}

/** 文本消息用正文哈希；非文本用媒体标识哈希，避免所有空文本同键。 */
function messageTextHash(msgType: string, text: string, record: Record<string, unknown>): string {
  return msgType === 'text' || (msgType === 'mixed' && text !== '')
    ? historyTextHash(text)
    : historyTextHash(mediaDescriptor(record))
}

/** 从 `chat messages list` 响应中取消息数组；其它顶层字段全部丢弃。 */
export function readCliMessages(payload: unknown): { messages: Record<string, unknown>[]; hasMore: boolean; nextCursor?: string } {
  if (payload === null || typeof payload !== 'object') return { messages: [], hasMore: false }
  const body = payload as { messages?: unknown; has_more?: unknown; next_cursor?: unknown }
  return {
    messages: Array.isArray(body.messages)
      ? body.messages.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      : [],
    hasMore: body.has_more === true,
    ...typeof body.next_cursor === 'string' && body.next_cursor !== '' ? { nextCursor: body.next_cursor } : {},
  }
}

/** 从 `chat groups list` 响应中取群数组；其它顶层字段全部丢弃。 */
export function readCliGroups(payload: unknown): { chats: { chatId: string; chatName?: string; lastMsgTime?: string; msgCount: number }[]; hasMore: boolean; nextCursor?: string } {
  if (payload === null || typeof payload !== 'object') return { chats: [], hasMore: false }
  const body = payload as { chats?: unknown; has_more?: unknown; next_cursor?: unknown }
  const chats = Array.isArray(body.chats)
    ? body.chats.flatMap((item) => {
        if (item === null || typeof item !== 'object') return []
        const record = item as Record<string, unknown>
        const chatId = typeof record.chat_id === 'string' ? record.chat_id.trim() : ''
        if (chatId === '') return []
        return [{
          chatId,
          ...typeof record.chat_name === 'string' && record.chat_name.trim() !== ''
            ? { chatName: record.chat_name.trim() } : {},
          ...typeof record.last_msg_time === 'string' && record.last_msg_time.trim() !== ''
            ? { lastMsgTime: record.last_msg_time.trim() } : {},
          msgCount: typeof record.msg_count === 'number' && Number.isFinite(record.msg_count) ? record.msg_count : 0,
        }]
      })
    : []
  return {
    chats,
    hasMore: body.has_more === true,
    ...typeof body.next_cursor === 'string' && body.next_cursor !== '' ? { nextCursor: body.next_cursor } : {},
  }
}

/** 状态文件读写；原子替换，文件 0600。 */
class HistoryLedger {
  private state: HistorySyncState = { version: 1, groups: {} }
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<HistorySyncState>
      if (parsed.version === 1 && parsed.groups !== null && typeof parsed.groups === 'object') {
        this.state = { version: 1, groups: parsed.groups as Record<string, HistoryGroupState> }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // 状态损坏不应阻塞实时 @；从空账本重建，历史最多重复一轮。
        this.state = { version: 1, groups: {} }
      }
    }
  }

  group(chatId: string, chatName?: string): HistoryGroupState {
    const existing = this.state.groups[chatId]
    if (existing !== undefined) {
      if (chatName !== undefined && existing.chatName !== chatName) existing.chatName = chatName
      return existing
    }
    const created: HistoryGroupState = {
      chatId,
      ...chatName === undefined ? {} : { chatName },
      firstSyncDone: false,
      seen: [],
      messages: [],
      pendingMedia: 0,
    }
    this.state.groups[chatId] = created
    return created
  }

  groups(): HistoryGroupState[] {
    return Object.values(this.state.groups)
  }

  /** 只读取一个群的状态；不创建。 */
  peek(chatId: string): HistoryGroupState | undefined {
    return this.state.groups[chatId]
  }

  /** 幂等落盘；并发调用串行化。 */
  flush(): Promise<void> {
    const snapshot = JSON.stringify(this.state)
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(join(this.filePath, '..'), { recursive: true, mode: 0o700 })
      const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
      await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 })
      await chmod(tmp, 0o600).catch(() => undefined)
      await rename(tmp, this.filePath)
    }).catch(() => undefined)
    return this.writeChain
  }
}

/** CLI 调用失败；code 用于日志，message 可读但不含凭据。 */
export class HistoryCliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'HistoryCliError'
  }
}

/** `@wecom/cli` 的最小封装；只读命令，禁止 send。 */
export class WecomCli {
  private authorized: 'unknown' | 'authorized' | 'unauthorized' = 'unknown'

  constructor(private readonly config: Pick<HistorySyncConfig, 'cliPath' | 'cliHome' | 'nodePath' | 'requestTimeoutMs' | 'uid' | 'gid' | 'runAs' | 'bridgeUrl' | 'dataDir'>) {}

  /** CLI 是否已授权；只读 `auth show --status`。 */
  async authStatus(): Promise<'authorized' | 'unauthorized' | 'unavailable'> {
    try {
      const result = await this.run(['auth', 'show', '--status'], 15_000)
      const text = `${result.stdout}\n${result.stderr}`.toLowerCase()
      if (/\bunauthorized\b/u.test(text) || /未授权|未登录/u.test(text)) {
        this.authorized = 'unauthorized'
        return 'unauthorized'
      }
      if (/\bauthorized\b/u.test(text) || /已授权/u.test(text)) {
        this.authorized = 'authorized'
        return 'authorized'
      }
      return 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  get status(): 'unknown' | 'authorized' | 'unauthorized' {
    return this.authorized
  }

  /**
   * 首次授权：从 DSH credential 取 Secret，经 stdin 喂给 `auth init --manual`。
   * 伪终端由 `script` 提供；Secret 不进 argv/env/日志。
   */
  async ensureAuthorized(botId: string, secretRef: string, credentials: { resolve(ref: unknown): Promise<{ value?: string } | undefined> }): Promise<boolean> {
    const status = await this.authStatus()
    if (status === 'authorized') return true
    if (this.config.bridgeUrl !== undefined && this.config.bridgeUrl !== '') {
      // 桥进程以 nobody 运行；DSH 进程拿到 Secret 也无法写它的凭据目录，授权应由容器启动
      // 脚本一次性完成，桥只报状态。
      throw new HistoryCliError(
        status === 'unauthorized' ? 'HISTORY_CLI_AUTH_REQUIRED' : 'HISTORY_CLI_UNAVAILABLE',
        status === 'unauthorized'
          ? '企微历史同步 CLI 尚未授权；请在 bot 容器执行 wecom-history 授权脚本。'
          : '企微历史同步 CLI 不可用。',
      )
    }
    if (status === 'unavailable') {
      // auth show 本身不可用（CLI 未安装/无法启动）时不再尝试 auth init。
      throw new HistoryCliError('HISTORY_CLI_UNAVAILABLE', '企微历史同步 CLI 不可用。')
    }
    let secret = ''
    try {
      const resolved = await credentials.resolve(secretRef)
      secret = typeof resolved?.value === 'string' ? resolved.value : ''
    } catch {
      secret = ''
    }
    if (secret === '') {
      throw new HistoryCliError('HISTORY_CLI_SECRET_MISSING', '企微历史同步缺少机器人 Secret。')
    }
    const command = `${shellQuote(this.config.nodePath)} ${shellQuote(this.config.cliPath)} auth init --manual`
    const result = await this.runRaw('/usr/bin/script', ['-qec', command, '/dev/null'], 60_000, `${botId}\n${secret}\n`)
    // 输出可能带身份上下文，不落日志；只看退出码和授权状态。
    if (result.code !== 0) {
      throw new HistoryCliError('HISTORY_CLI_AUTH_FAILED', '企微历史同步 CLI 授权失败。')
    }
    const after = await this.authStatus()
    if (after !== 'authorized') {
      throw new HistoryCliError('HISTORY_CLI_AUTH_FAILED', '企微历史同步 CLI 授权后仍不可用。')
    }
    return true
  }

  /** `chat groups list` 全量翻页。 */
  async listGroups(beginTime: string, endTime: string): Promise<{ chatId: string; chatName?: string; lastMsgTime?: string; msgCount: number }[]> {
    const chats: { chatId: string; chatName?: string; lastMsgTime?: string; msgCount: number }[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.run([
        'chat', 'groups', 'list',
        '--begin-time', beginTime,
        '--end-time', endTime,
        ...cursor === undefined ? [] : ['--cursor', cursor],
      ])
      if (result.code !== 0) throw cliFailure(result)
      const parsed = readCliGroups(parseCliJson(result.stdout))
      chats.push(...parsed.chats)
      if (!parsed.hasMore || parsed.nextCursor === undefined) break
      cursor = parsed.nextCursor
    }
    return chats
  }

  /** `chat messages list` 全量翻页；返回原始消息，归一化由调用方做。 */
  async listMessages(chatId: string, beginTime: string, endTime: string): Promise<Record<string, unknown>[]> {
    const messages: Record<string, unknown>[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.run([
        'chat', 'messages', 'list',
        '--chat-id', chatId,
        '--begin-time', beginTime,
        '--end-time', endTime,
        ...cursor === undefined ? [] : ['--cursor', cursor],
      ])
      if (result.code !== 0) throw cliFailure(result)
      const parsed = readCliMessages(parseCliJson(result.stdout))
      messages.push(...parsed.messages)
      if (!parsed.hasMore || parsed.nextCursor === undefined) break
      cursor = parsed.nextCursor
    }
    return messages
  }

  private run(args: string[], timeoutMs = this.config.requestTimeoutMs): Promise<{ code: number; stdout: string; stderr: string }> {
    if (this.config.bridgeUrl !== undefined && this.config.bridgeUrl !== '') {
      return this.runBridge(args, timeoutMs)
    }
    return this.runRaw(this.config.nodePath, [this.config.cliPath, ...args], timeoutMs)
  }

  /** 通过只读桥调用 CLI；桥只认识 auth show / chat groups list / chat messages list。 */
  private async runBridge(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
    const [first, second, third] = args
    let path: string
    if (first === 'auth' && second === 'show') {
      path = '/auth'
    } else if (first === 'chat' && second === 'groups' && third === 'list') {
      path = `/groups?${new URLSearchParams(pairs(args.slice(3))).toString()}`
    } else if (first === 'chat' && second === 'messages' && third === 'list') {
      path = `/messages?${new URLSearchParams(pairs(args.slice(3))).toString()}`
    } else {
      throw new HistoryCliError('HISTORY_CLI_BRIDGE_UNSUPPORTED', '历史同步桥不支持该 CLI 命令。')
    }
    try {
      const response = await fetch(new URL(path, this.config.bridgeUrl), {
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      if (!response.ok) {
        throw new HistoryCliError(
          `HISTORY_CLI_BRIDGE_HTTP_${String(response.status)}`,
          '企微历史同步桥调用失败。',
        )
      }
      return { code: 0, stdout: text, stderr: '' }
    } catch (error) {
      if (error instanceof HistoryCliError) throw error
      throw new HistoryCliError(
        'HISTORY_CLI_BRIDGE_UNREACHABLE',
        `企微历史同步桥不可达：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private runRaw(command: string, args: string[], timeoutMs: number, stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    // DSH Host 进程会丢掉全部 capabilities（CapEff=0），Node 的 spawn({uid}) 直接 EPERM。
    // 因此用镜像自带的 setuid-root `su` 降权到 nobody；凭据目录 0700 属于 nobody，
    // root（agent bash）没有 DAC_OVERRIDE 时读不到。
    const runAs = this.config.uid === undefined ? undefined : (this.config.runAs ?? 'nobody')
    const envPrefix = `env HOME=${shellQuote(this.config.cliHome)} XDG_CONFIG_HOME=${shellQuote(join(this.config.cliHome, '.config'))} NO_COLOR=1 TERM=dumb WECOM_CLI_NO_UPDATE_CHECK=1`
    const inner = `${envPrefix} ${[command, ...args].map(shellQuote).join(' ')}`
    const file = runAs === undefined ? command : '/usr/bin/su'
    const spawnArgs = runAs === undefined ? args : ['-s', '/bin/sh', runAs, '-c', inner]
    return new Promise((resolve, reject) => {
      const child = spawn(file, spawnArgs, {
        cwd: this.config.cliHome,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (code: number): void => {
        if (settled) return
        settled = true
        resolve({ code, stdout, stderr })
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(new HistoryCliError('HISTORY_CLI_SPAWN_FAILED', `企微历史同步 CLI 启动失败：${error.message}`))
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        fail(new Error(`timeout after ${String(timeoutMs)}ms`))
      }, timeoutMs)
      timer.unref?.()
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_CLI_OUTPUT_BYTES) stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_CLI_OUTPUT_BYTES) stderr += chunk.toString('utf8')
      })
      child.on('error', fail)
      child.on('close', (code) => {
        clearTimeout(timer)
        finish(code ?? 1)
      })
      if (stdin !== undefined) child.stdin.end(stdin)
      else child.stdin.end()
    })
  }
}

/** 把 `--key value` 数组转成 URLSearchParams 的键值对。 */
function pairs(args: readonly string[]): [string, string][] {
  const result: [string, string][] = []
  for (let index = 0; index + 1 < args.length; index += 2) {
    const key = args[index]!
    if (!key.startsWith('--')) continue
    result.push([key.slice(2), args[index + 1]!])
  }
  return result
}

/** 把 CLI 非零退出转成不含凭据的可读错误。 */
function cliFailure(result: { code: number; stdout: string; stderr: string }): HistoryCliError {
  const text = `${result.stdout}\n${result.stderr}`
  const match = /"message"\s*:\s*"([^"]+)"/u.exec(text)
  const message = match?.[1]?.replace(/\\u([0-9a-fA-F]{4})/gu, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  return new HistoryCliError(
    `HISTORY_CLI_EXIT_${String(result.code)}`,
    message === undefined || message === '' ? '企微历史同步 CLI 调用失败。' : `企微历史同步 CLI 调用失败：${message}`,
  )
}

/** 从 CLI stdout 里取 JSON；容忍前面有 warning 行。 */
export function parseCliJson(stdout: string): unknown {
  const text = stdout.trim()
  if (text === '') throw new HistoryCliError('HISTORY_CLI_EMPTY', '企微历史同步 CLI 没有返回内容。')
  try {
    return JSON.parse(text)
  } catch {
    // 有的命令会在 JSON 前打印一行 warning；从最后一个 `{` 开始尝试。
    const start = text.lastIndexOf('\n{')
    if (start >= 0) {
      try {
        return JSON.parse(text.slice(start + 1))
      } catch {
        // fallthrough
      }
    }
    const first = text.indexOf('{')
    const last = text.lastIndexOf('}')
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1))
      } catch {
        // fallthrough
      }
    }
    throw new HistoryCliError('HISTORY_CLI_INVALID_JSON', '企微历史同步 CLI 返回了非 JSON 内容。')
  }
}

/** 拼 @ 时的群历史 prompt；纯函数，便于测试。 */
export function buildHistoryPrompt(input: {
  messages: readonly StoredHistoryMessage[]
  question: string
  limit: number
  maxChars: number
  excludeDedupKey?: string
}): string {
  if (input.limit <= 0) return input.question
  const filtered = input.messages
    .filter(message => message.text !== '')
    .filter(message => message.dedupKey !== input.excludeDedupKey)
    .slice(-input.limit)
  if (filtered.length === 0) return input.question

  const lines: string[] = []
  let chars = 0
  for (let index = filtered.length - 1; index >= 0; index -= 1) {
    const message = filtered[index]!
    const line = `[${message.sendTime}] ${message.userName ?? message.userId}：${message.text}`
    if (chars + line.length > input.maxChars && lines.length > 0) break
    lines.unshift(line)
    chars += line.length
  }
  return [
    `以下是本企业微信群最近 ${String(lines.length)} 条消息（含未 @ 你的消息，仅作上下文，不要逐条回复）：`,
    ...lines,
    '',
    '如果用户要求根据会议纪要/群消息生成周报，请以上述消息为依据，并说明信息来源。',
    '',
    `当前用户 @ 你并提问：${input.question}`,
  ].join('\n')
}

/** 给 GroupChatRouter 用的历史读接口。 */
export interface GroupHistoryProvider {
  /** 实时消息是否已经在历史账本里（避免同一 @ 消息被实时和回填各写一次 room）。 */
  hasLiveMessage(input: {
    chatId: string
    sendTime: string
    userId: string
    msgType: string
    text: string
  }): boolean
  /** 记录一条实时 @ 消息，便于下一轮回填跳过它、并让后续 @ 能把它作为上下文。 */
  rememberLiveMessage(input: {
    chatId: string
    sendTime: string
    userId: string
    userName?: string
    msgType: string
    text: string
  }): void
  /** 计算实时消息的复合键（与 CLI 回填同一算法）。 */
  dedupKey(input: {
    chatId: string
    sendTime: string
    userId: string
    msgType: string
    text: string
  }): string
  /** 拼最近 N 条群历史；当前消息用 excludeDedupKey 排除。 */
  buildPrompt(chatId: string, question: string, excludeDedupKey?: string): string
  /** @ 到达时同步刷新该群，避免“5 分钟窗口内刚发的未 @ 消息”来不及进 prompt。 */
  refresh(chatId: string): Promise<void>
  /** 只拉最近 N 分钟 delta；@ 前短超时使用，不能把 7 天全量塞进实时链路。 */
  refreshRecent(chatId: string, lookbackMinutes?: number): Promise<void>
  /** 当前缓存里可用于 prompt 的文本消息数（诊断/日志）。 */
  messageCount(chatId: string): number
  /** 记录 @ 前 refresh 的诊断结果（可选，测试注入的 provider 不必实现）。 */
  recordRefresh?(input: { elapsedMs: number; timedOut: boolean; promptMessages: number }): void
  /** 群名（CLI/chats 提供时）。 */
  chatName(chatId: string): string | undefined
}

/** 历史同步器；一个 bot 一个实例。 */
export class HistorySync implements GroupHistoryProvider {
  private readonly ledger: HistoryLedger
  private readonly cli: WecomCli
  private timer?: NodeJS.Timeout
  private running = false
  private started = false
  private lastRunAt?: number
  private lastSuccessAt?: number
  private lastError?: string
  private lastFetched = 0
  private lastIngested = 0
  private lastSkipped = 0
  private auth: 'unknown' | 'authorized' | 'unauthorized' | 'unavailable' = 'unknown'
  private readonly groupLocks = new Map<string, Promise<void>>()
  private lastRefreshMs?: number
  private lastRefreshTimedOut?: boolean
  private lastPromptMessages?: number

  constructor(
    private readonly host: HistorySyncHost,
    private readonly botId: string,
    private readonly secretRef: string | undefined,
    private readonly config: HistorySyncConfig,
  ) {
    this.ledger = new HistoryLedger(join(config.dataDir, 'state.json'))
    this.cli = new WecomCli(config)
  }

  /** 启动定时器；幂等。 */
  start(): void {
    if (this.started || !this.config.enabled) return
    this.started = true
    const run = (): void => {
      if (this.running) return
      this.running = true
      void this.runOnce().catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.host.logger.warn(`[dataops-im] history-sync failed: ${this.lastError}`)
      }).finally(() => {
        this.running = false
      })
    }
    // 延迟 5s，避开 DSH 启动/企微长连接握手。
    const initial = setTimeout(run, 5_000)
    initial.unref?.()
    this.timer = setInterval(run, Math.max(60_000, this.config.intervalMs))
    this.timer.unref?.()
    this.host.logger.info?.(`[dataops-im] history-sync started interval=${String(this.config.intervalMs)}ms bot=${mask(this.botId)}`)
  }

  /** 停止定时器（测试/关停）。 */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.started = false
  }

  /** 状态摘要（无凭据）。 */
  status(): HistorySyncStatus {
    return {
      enabled: this.config.enabled,
      running: this.running,
      ...this.lastRunAt === undefined ? {} : { lastRunAt: this.lastRunAt },
      ...this.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.lastSuccessAt },
      ...this.lastError === undefined ? {} : { lastError: this.lastError },
      groups: this.ledger.groups().length,
      lastFetched: this.lastFetched,
      lastIngested: this.lastIngested,
      lastSkipped: this.lastSkipped,
      auth: this.auth,
      ...this.lastRefreshMs === undefined ? {} : { lastRefreshMs: this.lastRefreshMs },
      ...this.lastRefreshTimedOut === undefined ? {} : { lastRefreshTimedOut: this.lastRefreshTimedOut },
      ...this.lastPromptMessages === undefined ? {} : { lastPromptMessages: this.lastPromptMessages },
    }
  }

  /** 跑一轮；可在测试里直接调用。 */
  async runOnce(): Promise<void> {
    await this.ledger.load()
    this.lastRunAt = this.now()
    this.lastError = undefined
    this.lastFetched = 0
    this.lastIngested = 0
    this.lastSkipped = 0
    if (this.secretRef === undefined) {
      this.auth = 'unavailable'
      throw new HistoryCliError('HISTORY_CLI_SECRET_REF_MISSING', '机器人配置缺少 Secret 引用。')
    }
    const credentials = (this.host.ctx as unknown as {
      credentials?: { resolve(ref: unknown): Promise<{ value?: string } | undefined> }
    }).credentials
    if (credentials === undefined || typeof credentials.resolve !== 'function') {
      this.auth = 'unavailable'
      throw new HistoryCliError('HISTORY_CLI_CREDENTIALS_MISSING', '宿主没有 credential 服务。')
    }
    await this.cli.ensureAuthorized(this.botId, this.secretRef, credentials)
    this.auth = 'authorized'

    const endMs = this.now()
    // CLI 按 +08:00 解释；多留 1 分钟，避免恰好 7 天边界被 850016 拒绝。
    const sevenDayStart = endMs - 7 * 24 * 60 * 60_000 + 60_000
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 })
    await mkdir(this.config.cliHome, { recursive: true, mode: this.config.uid === undefined ? 0o700 : 0o777 })
    if (this.config.uid !== undefined) await chmod(this.config.cliHome, 0o777).catch(() => undefined)
    const groups = await this.cli.listGroups(formatWecomTime(sevenDayStart), formatWecomTime(endMs))
    const allow = new Set(this.config.chatAllowlist)
    for (const group of groups) {
      if (allow.size > 0 && !allow.has(group.chatId)) continue
      await this.refresh(group.chatId, group.chatName)
    }
    await this.ledger.flush()
    if (this.lastError === undefined) this.lastSuccessAt = this.now()
    this.host.logger.info?.(
      `[dataops-im] history-sync done groups=${String(groups.length)} fetched=${String(this.lastFetched)} ingested=${String(this.lastIngested)} skipped=${String(this.lastSkipped)}`,
    )
  }

  /**
   * 同步一个群（串行化）。@ 路径会直接 await 这里，保证 prompt 用的是最新群消息。
   */
  async refresh(chatId: string, chatName?: string): Promise<void> {
    await this.withGroupLock(chatId, async () => {
      await this.ensureCliReady()
      const endMs = this.now()
      const sevenDayStart = endMs - 7 * 24 * 60 * 60_000 + 60_000
      await this.syncGroup(
        { chatId, chatName: chatName ?? this.ledger.peek(chatId)?.chatName, msgCount: 0 },
        endMs,
        sevenDayStart,
      )
    })
  }

  /**
   * @ 前只拉最近 N 分钟 delta（默认 10 分钟）。实时链路不跑 7 天全量；外层用
   * 1.5–2s 短超时，超时继续用缓存，后台把这个 Promise 跑完。
   */
  async refreshRecent(chatId: string, lookbackMinutes = 10): Promise<void> {
    await this.withGroupLock(chatId, async () => {
      await this.ensureCliReady()
      const endMs = this.now()
      const sevenDayStart = endMs - 7 * 24 * 60 * 60_000 + 60_000
      const beginMs = Math.max(sevenDayStart, endMs - Math.max(1, lookbackMinutes) * 60_000)
      await this.syncGroup(
        { chatId, chatName: this.ledger.peek(chatId)?.chatName, msgCount: 0 },
        endMs,
        sevenDayStart,
        beginMs,
      )
    })
  }

  /** 串行化同一群的刷新；@ 短超时后后台任务继续跑，不会被新请求打断。 */
  private async withGroupLock(chatId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.groupLocks.get(chatId) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(work)
    this.groupLocks.set(chatId, task)
    try {
      await task
    } finally {
      if (this.groupLocks.get(chatId) === task) this.groupLocks.delete(chatId)
    }
  }

  /** CLI/桥授权；失败时 fail closed，由调用方决定是否降级。 */
  private async ensureCliReady(): Promise<void> {
    if (this.auth === 'authorized') return
    if (this.secretRef === undefined) {
      throw new HistoryCliError('HISTORY_CLI_SECRET_REF_MISSING', '机器人配置缺少 Secret 引用。')
    }
    const credentials = (this.host.ctx as unknown as {
      credentials?: { resolve(ref: unknown): Promise<{ value?: string } | undefined> }
    }).credentials
    if (credentials === undefined || typeof credentials.resolve !== 'function') {
      throw new HistoryCliError('HISTORY_CLI_CREDENTIALS_MISSING', '宿主没有 credential 服务。')
    }
    await this.cli.ensureAuthorized(this.botId, this.secretRef, credentials)
    this.auth = 'authorized'
  }

  /** 记录一次 @ 前 refresh 的诊断结果（不包含消息正文）。 */
  recordRefresh(input: { elapsedMs: number; timedOut: boolean; promptMessages: number }): void {
    this.lastRefreshMs = input.elapsedMs
    this.lastRefreshTimedOut = input.timedOut
    this.lastPromptMessages = input.promptMessages
  }

  /** 当前缓存里可进 prompt 的文本消息数。 */
  messageCount(chatId: string): number {
    return this.ledger.peek(chatId)?.messages.filter(message => message.text !== '').length ?? 0
  }

  /** 把复合键写入有界 seen 集合。 */
  private markSeen(state: HistoryGroupState, dedupKey: string): void {
    if (state.seen.includes(dedupKey)) return
    state.seen.push(dedupKey)
    if (state.seen.length > MAX_SEEN_PER_GROUP) state.seen.splice(0, state.seen.length - MAX_SEEN_PER_GROUP)
  }

  /** 同步一个群：按 lastSendTime - overlap 拉增量，复合键去重。 */
  private async syncGroup(
    group: { chatId: string; chatName?: string; msgCount: number },
    endMs: number,
    sevenDayStart: number,
    beginOverrideMs?: number,
  ): Promise<void> {
    const state = this.ledger.group(group.chatId, group.chatName)
    const lastMs = state.lastSendTime === undefined ? Number.NaN : parseWecomTime(state.lastSendTime)
    const beginMs = beginOverrideMs !== undefined
      ? Math.max(sevenDayStart, beginOverrideMs)
      : Number.isFinite(lastMs)
        ? Math.max(sevenDayStart, lastMs - this.config.overlapMinutes * 60_000)
        : sevenDayStart
    let records: Record<string, unknown>[]
    try {
      records = await this.cli.listMessages(group.chatId, formatWecomTime(beginMs), formatWecomTime(endMs))
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.host.logger.warn(`[dataops-im] history-sync messages failed chat=${mask(group.chatId)}: ${this.lastError}`)
      return
    }
    this.lastFetched += records.length

    const normalized = records
      .map(record => normalizeCliMessage(group.chatId, record, this.config.botMentions))
      .filter((message): message is NonNullable<typeof message> => message !== undefined)
      .sort((left, right) => left.sendTimeMs - right.sendTimeMs)
    const withOrdinals = assignSameSecondOrdinals(normalized)

    const seen = new Set(state.seen)
    const overlapMs = this.config.overlapMinutes * 60_000
    const fresh: (typeof withOrdinals[number])[] = []
    for (const message of withOrdinals) {
      if (seen.has(message.dedupKey)) {
        this.lastSkipped += 1
        continue
      }
      // 实时 @ 帧没有 create_time 时，senderId 还可能是明文 userid，与 CLI 的加密 userid
      // 对不上；用 10 分钟文本窗口兜底，避免同一条 @ 消息重复进 room。
      const nearDuplicate = state.messages.some(existing => existing.textHash === message.textHash
        && Math.abs(existing.sendTimeMs - message.sendTimeMs) <= overlapMs)
      if (nearDuplicate) {
        // 标记为已见，避免 10 分钟窗口过期后同一条又回填进来。
        this.markSeen(state, message.dedupKey)
        this.lastSkipped += 1
        continue
      }
      fresh.push(message)
    }

    // 首次同步只把最近 N 条写进 room；更早的只落本地账本，避免 7 天历史一次灌爆群聊。
    const firstRun = !state.firstSyncDone
    const roomCandidates = firstRun
      ? fresh.filter(message => message.text !== '').slice(-Math.max(0, this.config.firstRunRoomLimit))
      : fresh
    const roomKeys = new Set(roomCandidates.map(message => message.dedupKey))

    const remember = (message: (typeof fresh)[number], source: 'cli'): void => {
      if (state.seen.includes(message.dedupKey)) return
      this.markSeen(state, message.dedupKey)
      if (message.text === '') return
      state.messages.push({
        chatId: message.chatId,
        sendTime: message.sendTime,
        sendTimeMs: message.sendTimeMs,
        userId: message.userId,
        ...message.userName === undefined ? {} : { userName: message.userName },
        msgType: message.msgType,
        text: message.text,
        textHash: message.textHash,
        sameSecondOrdinal: message.sameSecondOrdinal,
        dedupKey: message.dedupKey,
        source,
      })
      if (state.messages.length > MAX_MESSAGES_PER_GROUP) {
        state.messages.splice(0, state.messages.length - MAX_MESSAGES_PER_GROUP)
      }
    }

    let failed = false
    // 顺序入库，避免 CLI 拉取 + HTTP 写 room 并发过高；失败时停在该消息，下一轮 overlap 重试。
    for (const message of fresh) {
      if (message.text === '') {
        // TODO(wecom-group-history): msg_type=image/file/voice/video 用
        // `wecom-cli message files get --media-id ... --output-dir ...` 拉取 → 校验 →
        // 入 KB；v1 不写 room、不进 prompt。
        if (message.msgType !== 'text') state.pendingMedia += 1
        remember(message, 'cli')
        continue
      }
      if (!roomKeys.has(message.dedupKey)) {
        // 首次同步的 7 天老消息：只落本地账本，不写 room。
        remember(message, 'cli')
        continue
      }
      try {
        await this.ingest(message, group.chatName)
        this.lastIngested += 1
        state.lastSendTime = message.sendTime
        remember(message, 'cli')
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.host.logger.warn(`[dataops-im] history-sync ingest failed chat=${mask(group.chatId)}: ${this.lastError}`)
        failed = true
        break
      }
    }
    if (!failed) state.firstSyncDone = true
    // 即使没有可注入文本（例如整批都是媒体），也推进水位，避免下一轮重复拉同一批。
    if (state.lastSendTime === undefined && withOrdinals.length > 0) {
      state.lastSendTime = withOrdinals[withOrdinals.length - 1]!.sendTime
    }
    state.lastRunAt = this.now()
    await this.ledger.flush()
  }

  /** 调 DataOps `/api/ai/chat/external/ingest`；重复由后端账本兜底。 */
  private async ingest(message: {
    chatId: string
    sendTime: string
    sendTimeMs: number
    userId: string
    userName?: string
    msgType: string
    text: string
    dedupKey: string
    messageId: string
  }, chatName?: string): Promise<void> {
    const token = await this.serviceCredential()
    const response = await this.request('/api/ai/chat/external/ingest', {
      method: 'POST',
      token,
      body: {
        provider: 'wecom',
        botId: this.botId,
        externalGroupId: message.chatId,
        chatId: message.chatId,
        messageId: message.messageId,
        senderId: message.userId,
        ...message.userName === undefined ? {} : { senderName: message.userName },
        text: message.text,
        chatType: 'group',
        ...chatName === undefined ? {} : { externalName: chatName },
        receivedAt: new Date(message.sendTimeMs).toISOString(),
      },
    })
    const body = await response.json().catch(() => undefined) as { roomId?: unknown; message?: unknown } | undefined
    if (!response.ok || typeof body?.roomId !== 'string' || body.roomId === '') {
      throw new HistoryCliError(
        `HISTORY_INGEST_HTTP_${String(response.status)}`,
        explicitMessage(body) ?? '历史消息写入群聊 room 失败。',
      )
    }
  }

  private now(): number {
    return (this.host.now ?? Date.now)()
  }

  /** 机器人服务账号 credential；缺失时 fail closed。 */
  private async serviceCredential(): Promise<string> {
    const credentials = (this.host.ctx as unknown as {
      credentials?: { resolve(ref: unknown): Promise<{ value?: string } | undefined> }
    }).credentials
    const resolved = await credentials?.resolve(this.host.credentialRef)
    const value = resolved?.value
    if (typeof value !== 'string' || value === '') {
      throw new HistoryCliError('HISTORY_SERVICE_CREDENTIAL_MISSING', '机器人工作区缺少 DataOps 服务账号凭据。')
    }
    return value
  }

  private async request(
    path: string,
    options: { method: 'GET' | 'POST'; token: string; body?: unknown },
  ): Promise<Response> {
    try {
      return await (this.host.fetchImpl ?? globalThis.fetch)(new URL(path, this.host.baseUrl), {
        method: options.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...options.body === undefined ? {} : { 'content-type': 'application/json' },
        },
        ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      })
    } catch (error) {
      throw new HistoryCliError(
        'HISTORY_UNREACHABLE',
        `DataOps 群聊服务不可达：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /* ---------------- GroupHistoryProvider ---------------- */

  hasLiveMessage(input: { chatId: string; sendTime: string; userId: string; msgType: string; text: string }): boolean {
    const state = this.ledger.peek(input.chatId)
    if (state === undefined) return false
    const textHash = historyTextHash(normalizeHistoryText(input.text, this.config.botMentions))
    const sendTimeMs = parseWecomTime(input.sendTime)
    return state.messages.some(message => message.textHash === textHash
      && (message.sendTime === input.sendTime
        && message.userId === input.userId
        && message.msgType === input.msgType
        || Math.abs(message.sendTimeMs - sendTimeMs) <= this.config.overlapMinutes * 60_000))
  }

  rememberLiveMessage(input: {
    chatId: string
    sendTime: string
    userId: string
    userName?: string
    msgType: string
    text: string
  }): void {
    const text = normalizeHistoryText(input.text, this.config.botMentions)
    if (text === '') return
    const textHash = historyTextHash(text)
    const state = this.ledger.group(input.chatId)
    const sendTimeMs = parseWecomTime(input.sendTime)
    // 实时帧可能没有 create_time（senderExternal.receivedAt 为空），sendTime 会退化成 now；
    // 用 10 分钟文本窗口兜底，避免同一条 @ 消息被实时和历史各写一次 room。
    const nearDuplicate = state.messages.some(message => message.textHash === textHash
      && Math.abs(message.sendTimeMs - sendTimeMs) <= this.config.overlapMinutes * 60_000)
    if (nearDuplicate) return
    const ordinal = state.messages.filter(message => message.sendTime === input.sendTime
      && message.userId === input.userId
      && message.msgType === input.msgType
      && message.textHash === textHash).length
    const dedupKey = historyDedupKey({
      chatId: input.chatId,
      sendTime: input.sendTime,
      userId: input.userId,
      msgType: input.msgType,
      textHash,
      sameSecondOrdinal: ordinal,
    })
    if (state.messages.some(message => message.dedupKey === dedupKey)) return
    state.messages.push({
      chatId: input.chatId,
      sendTime: input.sendTime,
      sendTimeMs: Number.isFinite(sendTimeMs) ? sendTimeMs : this.now(),
      userId: input.userId,
      ...input.userName === undefined || input.userName === '' ? {} : { userName: input.userName },
      msgType: input.msgType,
      text,
      textHash,
      sameSecondOrdinal: ordinal,
      dedupKey,
      source: 'live',
    })
    if (state.messages.length > MAX_MESSAGES_PER_GROUP) {
      state.messages.splice(0, state.messages.length - MAX_MESSAGES_PER_GROUP)
    }
    state.seen.push(dedupKey)
    if (state.seen.length > MAX_SEEN_PER_GROUP) state.seen.splice(0, state.seen.length - MAX_SEEN_PER_GROUP)
    void this.ledger.flush()
  }

  buildPrompt(chatId: string, question: string, excludeDedupKey?: string): string {
    const state = this.ledger.peek(chatId)
    if (state === undefined) return question
    return buildHistoryPrompt({
      messages: state.messages,
      question,
      limit: this.config.contextLimit,
      maxChars: this.config.maxContextChars,
      ...excludeDedupKey === undefined ? {} : { excludeDedupKey },
    })
  }

  chatName(chatId: string): string | undefined {
    return this.ledger.peek(chatId)?.chatName
  }

  /** 实时消息的复合键（与 CLI 回填同一算法）；供 group-chat 判断是否已入库。 */
  dedupKey(input: {
    chatId: string
    sendTime: string
    userId: string
    msgType: string
    text: string
  }): string {
    const textHash = historyTextHash(normalizeHistoryText(input.text, this.config.botMentions))
    const state = this.ledger.peek(input.chatId)
    const sendTimeMs = parseWecomTime(input.sendTime)
    const existing = state?.messages.find(message => message.textHash === textHash
      && (message.sendTime === input.sendTime
        && message.userId === input.userId
        && message.msgType === input.msgType
        || Math.abs(message.sendTimeMs - sendTimeMs) <= this.config.overlapMinutes * 60_000))
    if (existing !== undefined) return existing.dedupKey
    const ordinal = state?.messages.filter(message => message.sendTime === input.sendTime
      && message.userId === input.userId
      && message.msgType === input.msgType
      && message.textHash === textHash).length ?? 0
    return historyDedupKey({ ...input, textHash, sameSecondOrdinal: ordinal })
  }
}

/** 创建/复用某个 bot 的同步器；重复 Runtime 构造不会叠加定时器。 */
export function ensureGroupHistorySync(
  host: HistorySyncHost,
  botId: string,
  secretRef: string | undefined,
  config: HistorySyncConfig,
): HistorySync {
  const key = `${botId}\u0000${config.dataDir}`
  const existing = syncRegistry.get(key)
  if (existing !== undefined) return existing
  const sync = new HistorySync(host, botId, secretRef, config)
  syncRegistry.set(key, sync)
  sync.start()
  return sync
}

/** 从环境变量构造配置；默认值面向 bot 容器的热更新安装。 */
export function historySyncConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HistorySyncConfig {
  const number = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }
  const cliHome = env.WECOM_HISTORY_CLI_HOME ?? '/opt/wecom-history/home'
  return {
    // connector-profile 才有本模块；默认开启，CLI 未安装时由 historyCliInstalled 降级。
    enabled: env.WECOM_HISTORY_SYNC === undefined
      ? true
      : env.WECOM_HISTORY_SYNC === '1' || env.WECOM_HISTORY_SYNC === 'true',
    intervalMs: Math.max(5 * 60_000, number(env.WECOM_HISTORY_SYNC_INTERVAL_MS, DEFAULT_HISTORY_SYNC_CONFIG.intervalMs)),
    contextLimit: Math.max(1, number(env.WECOM_HISTORY_CONTEXT_LIMIT, DEFAULT_HISTORY_SYNC_CONFIG.contextLimit)),
    firstRunRoomLimit: Math.max(0, number(env.WECOM_HISTORY_FIRST_RUN_ROOM_LIMIT, DEFAULT_HISTORY_SYNC_CONFIG.firstRunRoomLimit)),
    overlapMinutes: Math.max(0, number(env.WECOM_HISTORY_OVERLAP_MINUTES, DEFAULT_HISTORY_SYNC_CONFIG.overlapMinutes)),
    requestTimeoutMs: Math.max(1_000, number(env.WECOM_HISTORY_REQUEST_TIMEOUT_MS, DEFAULT_HISTORY_SYNC_CONFIG.requestTimeoutMs)),
    cliPath: env.WECOM_HISTORY_CLI_PATH ?? '/opt/wecom-history/cli/node_modules/@wecom/cli/bin/wecom.js',
    cliHome,
    nodePath: env.WECOM_HISTORY_NODE_PATH ?? process.execPath,
    dataDir: env.WECOM_HISTORY_STATE_DIR ?? '/workspace/.dataops/wecom-history',
    // CLI 凭据目录属于 nobody；不降权时 root 没有 DAC_OVERRIDE，反而读不到自己的凭据。
    uid: number(env.WECOM_HISTORY_UID, 65534),
    gid: number(env.WECOM_HISTORY_GID, 65534),
    runAs: env.WECOM_HISTORY_RUN_AS ?? 'nobody',
    bridgeUrl: env.WECOM_HISTORY_BRIDGE_URL === 'off'
      ? undefined
      : env.WECOM_HISTORY_BRIDGE_URL ?? 'http://127.0.0.1:3199',
    chatAllowlist: (env.WECOM_HISTORY_CHAT_IDS ?? '').split(',').map(value => value.trim()).filter(value => value !== ''),
    maxContextChars: Math.max(1_000, number(env.WECOM_HISTORY_MAX_CONTEXT_CHARS, DEFAULT_HISTORY_SYNC_CONFIG.maxContextChars)),
    botMentions: (env.WECOM_HISTORY_BOT_MENTIONS ?? DEFAULT_BOT_MENTIONS.join(','))
      .split(',').map(value => value.trim()).filter(value => value !== ''),
  }
}

/** 机器人配置里是否有 CLI 安装（避免没装 CLI 时每 5 分钟报错）。 */
export function historyCliInstalled(config: HistorySyncConfig): boolean {
  return existsSync(config.cliPath)
}

/** 从 Nest 错误体取一句可读消息。 */
function explicitMessage(body: { message?: unknown } | undefined): string | undefined {
  const message = body?.message
  return typeof message === 'string' && message !== '' ? message : undefined
}

/** shell 单参数转义（只用于 `script -qec` 的命令字符串）。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/** 脱敏 id（日志用）。 */
function mask(value: string): string {
  if (value.length <= 2) return '*'.repeat(value.length)
  return `${value.slice(0, 2)}***${value.slice(-2)}`
}