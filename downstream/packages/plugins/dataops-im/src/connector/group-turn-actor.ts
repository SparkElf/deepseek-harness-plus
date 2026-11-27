/**
 * 共享群 session 的「当前 turn actor」与分支隔离。
 *
 * 方案 B 让一个群只有一个**公开**共享 session，但每条 @ 仍然要按发送者本人执行工具。
 * DSH 的 Session 带一个可替换的 `actor`，MCP 凭据解析
 * （`@sparkelf/dsh-plugin-mcp-credentials`）在每次请求前读取它。原生 DataOps 插件
 * （dataops-managed / knowledge-base 等）不走 MCP 凭据解析，而是在工具执行期间直接
 * `ctx.credentials.resolve('DATAOPS_ACCESS_TOKEN')`。这里同时安装一个进程内凭据作用域：
 * 当解析发生在群 session（或它 fork 出的分支/子代理）的 turn 内时，把工作区服务账号
 * token 替换成当前 sender 的 scoped token；没有当前 actor 就抛 `not_authorized`，
 * 绝不回落机器人服务账号。
 *
 * 一次 turn 的顺序：
 *
 * 1. 先写 `DATAOPS_ACCESS_TOKEN_S_<SESSION_ID>` scoped 凭据槽；
 * 2. 再整体替换 `session.actor`；
 * 3. 投递 prompt，期间 MCP 与原生工具都读到当前 sender；
 * 4. turn 结束清 scoped 槽并把 `session.actor` 换回占位 actor（不是 `undefined`）。
 *
 * @module connector/group-turn-actor
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { scopedCredentialRef } from './identity.ts'

/**
 * 无 turn 时的占位 actor。
 *
 * 形状与 `identity.ts` 的 pending actor 一致：不含 `userId`/`permissions`/资源 scope，
 * 只表示“本 Session 由连接器管理、当前没有授权主体”。凭据解析看到任何 actor 都只走
 * scoped 槽，因此这个占位值保证未设置凭据时工具直接失败。
 */
export const GROUP_PENDING_ACTOR: Readonly<Record<string, unknown>> = Object.freeze({
  identityPending: true,
  source: 'wecom',
  groupShared: true,
})

/** 当前进程里被连接器管理的群 session（含公开共享 session 与 turn-private fork）。 */
const groupSessionIds = new Set<string>()
const GROUP_SESSION_LIMIT = 1_000

/** 当前 turn 的 sender 凭据；只在 turn 期间存在。 */
const activeGroupTurns = new Map<string, { userId: string; token: string }>()

/**
 * 被 group scope 包装前的原始 `credentials.resolve`。
 *
 * connector 自己的服务调用（ingest / identity resolve / provisioning）必须用机器人服务
 * 账号 token；它们可能恰好运行在某个群 agent 的 async context 里（例如探针/回调），
 * 不能走 group scope 的 sender 替换，否则会拿到 not_authorized。
 */
const rawCredentialResolvers = new WeakMap<
  object,
  (ref: unknown) => Promise<{ value: string; source: string } | undefined>
>()

/**
 * 解析 connector 自己的服务凭据：始终使用包装前的原始 resolve，绕过 group scope。
 *
 * 只给 ingest/reply/identity resolve 等“机器人为自己发起的 DataOps 调用”使用；
 * agent 工具调用不得调用本函数，必须走 Session.actor/scoped 槽。
 */
export async function resolveServiceCredential(
  ctx: Context,
  ref: unknown,
): Promise<{ value: string; source: string } | undefined> {
  const service = (ctx as unknown as { credentials?: DshActorContext['credentials'] }).credentials
  if (service === undefined || typeof service.resolve !== 'function') return undefined
  const raw = rawCredentialResolvers.get(service)
  return raw === undefined ? service.resolve(ref) : raw(ref)
}

/** 记住一个群 session id；超出上限时淘汰最旧的（只是诊断/凭据作用域，不影响 DSH）。 */
function rememberGroupSession(sessionId: string): void {
  if (groupSessionIds.has(sessionId)) return
  groupSessionIds.add(sessionId)
  if (groupSessionIds.size > GROUP_SESSION_LIMIT) {
    const oldest = groupSessionIds.values().next().value
    if (oldest !== undefined) groupSessionIds.delete(oldest)
  }
}

/** 测试/诊断：一个 session 是否被连接器登记为群分支。 */
export function isManagedGroupSession(sessionId: string): boolean {
  return groupSessionIds.has(sessionId)
}

/** 一次群 turn 的 actor 切换接口；测试可注入内存实现。 */
export interface GroupTurnActorGateway {
  /** 会话创建/复用后先放占位 actor，并清掉可能残留的 scoped 槽。 */
  ensurePlaceholder(sessionId: string): Promise<void>
  /** 写 scoped 凭据后再换 actor；任一步失败都不得继续投递 prompt。 */
  activate(sessionId: string, actor: unknown, token: string): Promise<void>
  /** turn 结束后清 scoped 槽并换回占位 actor；幂等。 */
  clear(sessionId: string): Promise<void>
  /** 该 session 是否已在当前 DSH Host 中 live（持久化但未 resume 的不算）。 */
  isSessionLive?(sessionId: string): boolean
}

/** DSH 会话分支能力；sender_only turn 从公开共享 session fork，执行后丢弃。 */
export interface GroupSessionBranches {
  /** 会话当前最后一个事件 seq；空会话返回 undefined。 */
  lastSeq(sessionId: string): number | undefined
  /** 从 source 的指定前缀 fork 一个独立 live child；boundary 缺省表示复制到当前。 */
  fork(sourceSessionId: string, boundary?: number): Promise<string>
  /** 给丢弃的分支改名，便于管理员识别；失败不影响主流程。 */
  markDiscarded(sessionId: string, title: string): Promise<void>
}

interface DshSessionLike {
  readonly id?: string
  actor?: unknown
  readonly log?: readonly { readonly seq?: number }[]
  readonly header?: { readonly parentSession?: unknown }
  snapshotEvents?(): readonly { readonly seq?: number }[]
}

/** DSH 里我们用到的最小上下文面；避免依赖具体 Session/Credentials 类型。 */
interface DshActorContext {
  readonly credentials?: {
    resolve(ref: unknown): Promise<{ value: string; source: string } | undefined>
    set(ref: unknown, value: string): Promise<void>
    unset(ref: unknown): Promise<void>
  }
  readonly sessions?: {
    get(id: unknown): unknown
    fork?(source: unknown, boundary?: number, childSessionId?: string): unknown
  }
  readonly sessionTitle?: {
    rename(session: unknown, title: string): unknown
  }
  readonly agents?: {
    currentInitiator?(): { readonly session?: DshSessionLike } | undefined
  }
}

/** 把 sessionId 折叠成与 mcp-credentials 完全一致的 scoped 凭据引用。 */
export function groupScopedCredentialRef(baseRef: string, sessionId: string): string {
  return credentialRef(scopedCredentialRef(baseRef, sessionId))
}

/** 读取可选 Cordis 服务；未注入/不可用时返回 undefined。 */
function optionalService(ctx: Context, name: string): unknown {
  try {
    const holder = ctx as unknown as { get?(serviceName: string): unknown; [key: string]: unknown }
    if (typeof holder.get === 'function') {
      const value = holder.get.call(ctx, name)
      if (value !== undefined) return value
    }
    return holder[name]
  } catch {
    return undefined
  }
}

/** 读取会话对象。 */
function sessionOf(ctx: Context, sessionId: string): DshSessionLike | undefined {
  try {
    return (ctx as unknown as DshActorContext).sessions?.get(sessionId) as DshSessionLike | undefined
  } catch {
    return undefined
  }
}

/** 当前 iniator agent 的 session id（只在 agent turn 的异步链内有值）。 */
function currentInitiatorSessionId(ctx: Context): string | undefined {
  try {
    const agents = optionalService(ctx, 'agents') as DshActorContext['agents'] | undefined
    const agent = agents?.currentInitiator?.()
    const id = agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * 沿 `header.parentSession` 找到最近的群 session。
 *
 * 子代理（subagent）是独立 Session，但创建时带 parentSession；工具调用继承子代理的
 * async context，所以必须沿父链判断归属，否则子代理会以机器人身份调用 DataOps。
 */
function groupRootOf(ctx: Context, sessionId: string): string | undefined {
  let current = sessionId
  for (let depth = 0; depth < 8; depth += 1) {
    if (groupSessionIds.has(current)) return current
    const parent = sessionOf(ctx, current)?.header?.parentSession
    if (typeof parent !== 'string' || parent === '' || parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * 安装进程级凭据作用域：群 turn 内解析工作区 `DATAOPS_ACCESS_TOKEN` 时返回当前 sender
 * 的 scoped token；群 session 存在但没有当前 actor 时抛 `not_authorized`。
 *
 * 非群 session（普通 Web/私聊/后台任务）完全走原实现。返回 disposer 恢复原方法。
 */
export function installGroupCredentialScope(ctx: Context, baseRef: string): () => void {
  const service = (ctx as unknown as { credentials?: DshActorContext['credentials'] }).credentials
  if (service === undefined || typeof service.resolve !== 'function') return () => {}
  const own = Object.getOwnPropertyDescriptor(service, 'resolve')
  const original = service.resolve.bind(service)
  rawCredentialResolvers.set(service, original)
  const wrapped = async (ref: unknown): Promise<{ value: string; source: string } | undefined> => {
    if (String(ref) !== baseRef) return original(ref)
    const initiator = currentInitiatorSessionId(ctx)
    if (initiator === undefined) return original(ref)
    const root = groupRootOf(ctx, initiator)
    if (root === undefined) return original(ref)
    const active = activeGroupTurns.get(root)
    if (active === undefined || active.token === '') {
      throw new Error('not_authorized: 群 turn 没有当前 sender 的 scoped 凭据，拒绝使用工作区服务账号')
    }
    return { value: active.token, source: 'group-turn-actor' }
  }
  Object.defineProperty(service, 'resolve', {
    configurable: true,
    enumerable: own?.enumerable ?? true,
    value: wrapped,
  })
  return () => {
    rawCredentialResolvers.delete(service)
    if (own === undefined) {
      delete (service as { resolve?: unknown }).resolve
    } else {
      Object.defineProperty(service, 'resolve', own)
    }
  }
}

/**
 * 基于 DSH 上下文创建 actor 网关。
 *
 * @param ctx - 连接器所在 DSH Host 的上下文。
 * @param baseRef - 工作区凭据名（`DATAOPS_ACCESS_TOKEN`）。
 * @returns 生产实现；凭据服务或会话不存在时抛错，由调用方 fail closed。
 */
export function createDshGroupTurnActors(ctx: Context, baseRef: string): GroupTurnActorGateway {
  const slice = ctx as unknown as DshActorContext
  const slot = (sessionId: string): string => groupScopedCredentialRef(baseRef, sessionId)

  return {
    async ensurePlaceholder(sessionId: string): Promise<void> {
      rememberGroupSession(sessionId)
      activeGroupTurns.delete(sessionId)
      await slice.credentials?.unset(slot(sessionId)).catch(() => undefined)
      const session = sessionOf(ctx, sessionId)
      if (session !== undefined) session.actor = GROUP_PENDING_ACTOR
    },

    async activate(sessionId: string, actor: unknown, token: string): Promise<void> {
      rememberGroupSession(sessionId)
      const session = sessionOf(ctx, sessionId)
      if (session === undefined) {
        throw new Error(`群 session ${sessionId} 不在当前 DSH Host 中，拒绝以未绑定身份执行`)
      }
      if (slice.credentials === undefined) {
        throw new Error('DSH credentials 服务不可用，拒绝以未绑定身份执行群消息')
      }
      // 先写凭据：actor 一旦可见，工具就可能立即解析凭据；顺序反过来会有一瞬间
      // “actor=发送者、凭据=空缺”的窗口，工具会拿到明确拒绝（安全但会误伤）。
      await slice.credentials.set(slot(sessionId), token)
      session.actor = actor
      activeGroupTurns.set(sessionId, {
        userId: typeof (actor as { userId?: unknown } | undefined)?.userId === 'string'
          ? String((actor as { userId: unknown }).userId)
          : '',
        token,
      })
    },

    isSessionLive(sessionId: string): boolean {
      return sessionOf(ctx, sessionId) !== undefined
    },

    async clear(sessionId: string): Promise<void> {
      activeGroupTurns.delete(sessionId)
      await slice.credentials?.unset(slot(sessionId)).catch(() => undefined)
      const session = sessionOf(ctx, sessionId)
      if (session !== undefined) session.actor = GROUP_PENDING_ACTOR
    },
  }
}

/** 基于 DSH SessionStore 的分支实现。 */
export function createDshGroupSessionBranches(ctx: Context): GroupSessionBranches {
  const slice = ctx as unknown as DshActorContext
  return {
    lastSeq(sessionId: string): number | undefined {
      const session = sessionOf(ctx, sessionId)
      if (session === undefined) return undefined
      const events = session.snapshotEvents?.() ?? session.log ?? []
      const seq = events.at(-1)?.seq
      return typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : undefined
    },

    async fork(sourceSessionId: string, boundary?: number): Promise<string> {
      const sessions = slice.sessions
      if (sessions === undefined || typeof sessions.fork !== 'function') {
        throw new Error('DSH SessionStore 不支持 fork，无法隔离 sender_only turn')
      }
      // 显式 child id：DSH 的自动 id 计数器每个进程重置，重启后可能撞上已持久化的旧
      // session id，导致后续 session/prompt resume 到错误/不存在的日志。
      const child = sessions.fork(sourceSessionId, boundary, `session-fork-${randomUUID()}`) as DshSessionLike | undefined
      const id = child?.id
      if (typeof id !== 'string' || id === '') {
        throw new Error('DSH SessionStore fork 没有返回子会话 id')
      }
      rememberGroupSession(id)
      const session = sessionOf(ctx, id)
      if (session !== undefined) session.actor = GROUP_PENDING_ACTOR
      return id
    },

    async markDiscarded(sessionId: string, title: string): Promise<void> {
      const session = sessionOf(ctx, sessionId)
      const titles = optionalService(ctx, 'sessionTitle') as DshActorContext['sessionTitle']
      if (session === undefined || titles === undefined) return
      try {
        titles.rename(session, title)
      } catch {
        // 改名只是可读性，不能影响私聊投递。
      }
    },
  }
}