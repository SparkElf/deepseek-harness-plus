/**
 * sender_only turn-private 分支的生命周期。
 *
 * 方案 B 的公开共享 session 只保存 room_safe turn；每条 sender_only 消息从公开 session
 * fork 一个 turn-private child，执行完立即从「可复用/可见」面移除：
 *
 * 1. `workspaceRegistry.archiveSession(child, { stopActivity: true })`：归档后 child 不出现在
 *    sidebar/workspace 列表，也被 archived-session gate 拦在 agent 入口之外；
 * 2. 在本模块的账本里记录 `ephemeral=true / parentGroupSession / senderId / turnId /
 *    expiresAt`，默认保留 7 天，便于审计与到期清理；
 * 3. 到期后只清理「已归档且当前进程不再持有」的会话日志目录；仍存活的会话留到下次
 *    进程启动后重试，避免删掉正在写的日志。
 *
 * 归档 API 不可用时退化为改名 + 不引用；证据里必须说明审计/隐藏能力损失。
 *
 * @module connector/group-branch-lifecycle
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** 一条 turn-private 分支的元数据；只落本地账本，不进 session 内容。 */
export interface GroupBranchMeta {
  readonly botId: string
  readonly chatId: string
  readonly senderId: string
  readonly turnId: string
  /** fork 来源的公开共享 session id。 */
  readonly parentGroupSession: string
  /** `sender_only`：敏感 turn；`downgraded`：公开候选被答案判据降级；
   *  `superseded`：DSH 重启后持久化但未 live 的旧共享 session。 */
  readonly reason: 'sender_only' | 'downgraded' | 'superseded'
  readonly createdAt: number
  readonly expiresAt: number
}

/** 账本条目：元数据 + 归档结果。 */
export interface GroupBranchEntry extends GroupBranchMeta {
  readonly sessionId: string
  readonly ephemeral: true
  readonly archivedAt?: number
  readonly archiveError?: string
  readonly deletedAt?: number
}

/** 生命周期接缝；测试可注入内存实现。 */
export interface GroupBranchLifecycle {
  /** 归档 child 并记账；失败只记日志，不阻断私聊投递。 */
  retire(sessionId: string, meta: GroupBranchMeta): Promise<void>
  /** 清理已到期的分支（尽力而为）；返回删除条数。 */
  sweep(): Promise<number>
}

/** DSH 里我们用到的生命周期面。 */
interface DshLifecycleContext {
  readonly workspaceRegistry?: {
    archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
    unarchiveSession?(sessionId: string): Promise<void>
  }
  readonly sessions?: { get(id: unknown): unknown }
  readonly sessionTitle?: { rename(session: unknown, title: string): unknown }
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

interface LedgerFile {
  version: 1
  entries: Record<string, GroupBranchEntry>
}

/** 默认保留 7 天。 */
export const DEFAULT_BRANCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 基于 DSH workspaceRegistry 与本地 JSON 账本创建生命周期。
 *
 * @param ctx - 连接器所在 DSH Host。
 * @param options - 账本目录、保留时长、时钟与日志。
 */
export function createDshBranchLifecycle(
  ctx: Context,
  options: {
    readonly dataDir: string
    readonly retentionMs?: number
    readonly now?: () => number
    readonly logger?: { warn(message: string): void; info?(message: string): void }
  },
): GroupBranchLifecycle {
  const slice = ctx as unknown as DshLifecycleContext
  const registry = optionalService(ctx, 'workspaceRegistry') as DshLifecycleContext['workspaceRegistry']
  const sessionTitle = optionalService(ctx, 'sessionTitle') as DshLifecycleContext['sessionTitle']
  const filePath = join(options.dataDir, 'branch-ledger.json')
  const retentionMs = Math.max(60_000, options.retentionMs ?? DEFAULT_BRANCH_RETENTION_MS)
  const now = options.now ?? Date.now
  let cache: LedgerFile | undefined
  let chain: Promise<void> = Promise.resolve()

  const load = async (): Promise<LedgerFile> => {
    if (cache !== undefined) return cache
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<LedgerFile>
      cache = parsed.version === 1 && parsed.entries !== null && typeof parsed.entries === 'object'
        ? { version: 1, entries: parsed.entries as Record<string, GroupBranchEntry> }
        : { version: 1, entries: {} }
    } catch {
      cache = { version: 1, entries: {} }
    }
    return cache
  }

  const persist = async (): Promise<void> => {
    const ledger = await load()
    const snapshot = JSON.stringify(ledger)
    chain = chain.then(async () => {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
      const tmp = `${filePath}.tmp-${process.pid}-${now()}`
      await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, filePath)
    }).catch((error: unknown) => {
      options.logger?.warn(
        `[dataops-im] group branch ledger write failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    return chain
  }

  const sessionRoot = (): string => join(process.env.DATAOPS_DSH_HOME ?? '/workspace/.dataops/dsh', 'sessions')

  /** 删除一个已归档且不再 live 的会话日志目录；只删除 basename 完全匹配的目录。 */
  const removeSessionFiles = async (sessionId: string): Promise<boolean> => {
    if (slice.sessions?.get(sessionId) !== undefined) return false
    let removed = false
    let workspaceDirs: string[]
    try {
      workspaceDirs = await readdir(sessionRoot())
    } catch {
      return false
    }
    for (const dir of workspaceDirs) {
      const target = join(sessionRoot(), dir, sessionId)
      if (target.split('/').at(-1) !== sessionId) continue // 只允许删除精确匹配的会话目录
      try {
        await rm(target, { recursive: true, force: true })
        removed = true
      } catch {
        // 下次 sweep 再试。
      }
    }
    return removed
  }

  return {
    async retire(sessionId: string, meta: GroupBranchMeta): Promise<void> {
      const ledger = await load()
      const entry: GroupBranchEntry = {
        ...meta,
        sessionId,
        ephemeral: true,
        expiresAt: meta.expiresAt > 0 ? meta.expiresAt : now() + retentionMs,
      }
      ledger.entries[sessionId] = entry
      // 先归档再记账：归档失败时账本仍标记 archiveError，证据可追踪。
      try {
        if (registry?.archiveSession === undefined) {
          throw new Error('workspaceRegistry.archiveSession unavailable')
        }
        await registry.archiveSession(sessionId, { stopActivity: true })
        ledger.entries[sessionId] = { ...entry, archivedAt: now() }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ledger.entries[sessionId] = { ...entry, archiveError: message }
        options.logger?.warn(`[dataops-im] group branch archive failed session=${sessionId}: ${message}`)
      }
      // 归档后改一个可识别的名字，防止管理员在日志/审计里误认成公开群会话。
      try {
        const session = slice.sessions?.get(sessionId)
        if (session !== undefined) {
          sessionTitle?.rename(session, `turn-private · ${entry.chatId.slice(0, 8)} · ${entry.senderId.slice(0, 8)}`)
        }
      } catch {
        // 改名只是可读性。
      }
      await persist()
      await this.sweep().catch(() => 0)
    },

    async sweep(): Promise<number> {
      const ledger = await load()
      const current = now()
      let removed = 0
      for (const [sessionId, entry] of Object.entries(ledger.entries)) {
        if (entry.deletedAt !== undefined || entry.expiresAt > current) continue
        if (entry.archivedAt === undefined) continue // 归档失败的分支不能直接删日志
        if (await removeSessionFiles(sessionId)) {
          ledger.entries[sessionId] = { ...entry, deletedAt: current }
          removed += 1
          try {
            await registry?.unarchiveSession?.(sessionId)
          } catch {
            // 保留归档 id 不影响正确性。
          }
        }
      }
      if (removed > 0) {
        await persist()
        options.logger?.info?.(`[dataops-im] group branch sweep removed=${String(removed)}`)
      }
      return removed
    },
  }
}