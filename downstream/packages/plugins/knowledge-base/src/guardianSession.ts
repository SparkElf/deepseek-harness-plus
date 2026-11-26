/**
 * The per-user memory guardian session: identity, lazy creation and message
 * delivery.
 *
 * A guardian is an ordinary DSH Agent in STANDARD mode. There is deliberately
 * no custom agent preset and no hidden queue:
 *
 * - the durable identity is `<memoryUsersRoot>/<userId>/guardian.json`, which
 *   stores the sessionId. The title 「记忆守护会话」 is display-only;
 * - the session is created lazily on the first message, then reused forever.
 *   One user has exactly one guardian, so memory state never forks across
 *   sessions;
 * - sending is just `agent.followup(UserMessage)`. DSH's own inbox is the
 *   queue: a busy guardian accepts the message and runs it after the current
 *   turn. This module does not build a second queue;
 * - a stale state file (session deleted, persistence lost, resume failure) is
 *   recovered by creating a fresh standard session and overwriting the state.
 *
 * All DSH types live behind {@link GuardianSessionHost}. The plugin package
 * does not depend on `@deepseek-ai/dsh-agent` / `dsh-llm`; the wiring layer
 * implements the seam with the real services (`ctx.agentLoop`,
 * `ctx.agents`, `createUserMessage`, `agent.followup`). Keeping the seam
 * structural is what lets the identity/lazy-create/recreate rules be tested
 * without an Agent runtime.
 *
 * @module @sparkelf/dsh-knowledge-base/guardian-session
 */
import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPathSegment, writeFileAtomic } from './memoryBindings.ts'

/** Why a guardian message was produced. */
export type GuardianReason = 'idle' | 'compaction' | 'dream' | 'manual'

/** One message to deliver to the user's guardian session. */
export interface GuardianMessage {
  reason: GuardianReason
  /** The ordinary session that triggered this message (idle/compaction). */
  sessionId?: string
  /** The compaction transaction that triggered this message. */
  compactionId?: string
  /** Short free-form context; never a document body. */
  note?: string
}

/** Durable guardian identity. */
export interface GuardianSessionState {
  version: 1
  userId: string
  sessionId: string
  /** Display-only title; never used as the identity. */
  title: string
  createdAt: string
  updatedAt: string
}

/** The live-agent facts this module needs. Structural on purpose. */
export interface GuardianAgentRef {
  readonly id: string
  /** `running` means a further followup is queued behind the current turn. */
  readonly status?: 'idle' | 'running'
}

/** Result of one text delivery. */
export interface GuardianDelivery {
  delivered?: boolean
  queued?: boolean
}

/** Inputs for a standard-mode session creation. */
export interface CreateGuardianAgentInput {
  sessionId: string
  /** Absolute working directory required by the DSH session boundary. */
  cwd: string
  title: string
}

/** Host seam implemented by the plugin wiring against the real DSH services. */
export interface GuardianSessionHost {
  /** `<actualRoot>/.memory/users` or the configured `memoryUsersRoot`. */
  usersRoot: string
  /** Absolute session cwd; defaults to the host process cwd. */
  cwd?: string
  /**
   * Optional bound for session resolution and message delivery.
   *
   * Omitted keeps the previous unbounded behavior for embedders that already
   * impose their own timeout; the plugin passes {@link DEFAULT_GUARDIAN_TIMEOUT_MS}.
   */
  timeoutMs?: number
  /** `ctx.agents.get(sessionId)`. */
  getAgent(sessionId: string): GuardianAgentRef | undefined
  /** `ctx.agentLoop.createAgent(ctx, { sessionId, meta: { cwd } })` with NO agentPreset. */
  createAgent(input: CreateGuardianAgentInput): Promise<GuardianAgentRef>
  /** `ctx.agentLoop.resume(ctx, { resumeSessionId })`. */
  resumeAgent(input: { sessionId: string; cwd: string }): Promise<GuardianAgentRef>
  /** Build a user message and call `agent.followup(...)`; report whether it queued. */
  deliverText(agent: GuardianAgentRef, text: string): Promise<GuardianDelivery> | GuardianDelivery
  /**
   * Optional title lookup used only when guardian.json is lost. The design says:
   * find a unique title match before creating another guardian.
   */
  findByTitle?(title: string): Promise<string | undefined>
  /** Test seam: deterministic session id. Defaults to `session-<uuid>`. */
  newSessionId?(): string
  /** Optional explicit rename; implementation may append `session/title`. */
  setTitle?(agent: GuardianAgentRef, title: string): Promise<void> | void
}

/** A resolved (possibly just-created) guardian. */
export interface ResolvedGuardian {
  state: GuardianSessionState
  agent: GuardianAgentRef
  created: boolean
}

/** Outcome of {@link sendToGuardian}. */
export interface GuardianSendResult {
  /** The host accepted the message (`followup` returned without throwing). */
  delivered: boolean
  /** The agent was busy, so the message sits in the DSH inbox behind the turn. */
  queued: boolean
  /** Guardian session id the message went to. */
  sessionId: string
  /** True when this call lazily created or recreated the session. */
  created: boolean
}

/**
 * Default bound for guardian session resolution and message delivery.
 *
 * The guardian TURN itself is asynchronous (DSH's own inbox is the queue), so
 * this cannot bound model latency. What it does bound is the plugin's wait for
 * a standard-mode agent to be created/resumed or for `followup` to accept the
 * message; without it a hung agent loop can block a normal session's tool call
 * indefinitely.
 */
export const DEFAULT_GUARDIAN_TIMEOUT_MS = 30_000

/** A guardian operation exceeded its bounded wait. */
export class GuardianTimeoutError extends Error {
  override readonly name = 'GuardianTimeoutError'
  readonly code = 'unreachable'

  constructor(message: string) {
    super(message)
  }
}

/** Bound one promise without cancelling the underlying operation. */
function withGuardianTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new GuardianTimeoutError(`${label} timed out after ${String(timeoutMs)}ms`))
    }, timeoutMs)
    operation.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Title is display-only but stable, so an operator can recognize the session. */
export const GUARDIAN_SESSION_TITLE = '记忆守护会话'

/** Skill the guardian must load before doing anything else. */
export const GUARDIAN_SKILL_NAME = 'memory'

/**
 * The preset first message. It intentionally stays product-level: read the
 * skill, check memory state, ensure the daily dream task exists.
 */
export function guardianSeedText(): string {
  return [
    '你是记忆守护会话：唯一负责个人记忆提取、合并、纠偏、遗忘和 SOP 维护的会话。',
    `第一步：阅读 ${GUARDIAN_SKILL_NAME} 技能，再按其中的指引读取 references/guardian.md，之后严格按该准则工作。`,
    '启动检查：确认个人记忆状态与待处理队列；确认每日 dream 任务存在，不存在则创建。',
    '之后只处理收到的 idle / compaction / dream 消息；串行处理，不为单条消息新建会话。',
  ].join('\n')
}

/** Render one trigger message for the guardian. */
export function renderGuardianMessage(message: GuardianMessage): string {
  const lines = [`[记忆守护] reason=${message.reason}`]
  if (message.sessionId !== undefined && message.sessionId !== '') lines.push(`sourceSession: ${message.sessionId}`)
  if (message.compactionId !== undefined && message.compactionId !== '') lines.push(`compactionId: ${message.compactionId}`)
  if (message.note !== undefined && message.note.trim() !== '') lines.push(`note: ${message.note.trim()}`)
  lines.push(`请按 ${GUARDIAN_SKILL_NAME} 技能处理这条消息。`)
  return lines.join('\n')
}

/**
 * Durable guardian state under `<memoryUsersRoot>/<userId>/guardian.json`.
 *
 * Reads tolerate a corrupt file as "state lost": the resolver then uses the
 * title fallback or creates a fresh session instead of failing every message.
 * Writes are atomic (tmp + rename) and private.
 */
export class GuardianSessionStore {
  private readonly usersRoot: string
  /** Positive identity cache for trigger filtering; never used as the source of truth. */
  private readonly knownSessions = new Set<string>()

  constructor(usersRoot: string) {
    if (typeof usersRoot !== 'string' || usersRoot.trim() === '') {
      throw new Error('guardian-session: usersRoot must be a non-empty path')
    }
    this.usersRoot = usersRoot
  }

  /** Absolute path of one user's guardian state file. */
  filePath(userId: string): string {
    assertPathSegment(userId, 'userId')
    return join(this.usersRoot, userId, 'guardian.json')
  }

  /** Read the state file; missing or malformed state is `undefined`. */
  async read(userId: string): Promise<GuardianSessionState | undefined> {
    const filePath = this.filePath(userId)
    let source: string
    try {
      source = await readFile(filePath, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.sessionId !== 'string' || record.sessionId.trim() === '') return undefined
    if (record.userId !== undefined && record.userId !== userId) return undefined
    const state: GuardianSessionState = {
      version: 1,
      userId,
      sessionId: record.sessionId,
      title: typeof record.title === 'string' && record.title.trim() !== '' ? record.title : GUARDIAN_SESSION_TITLE,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    }
    this.knownSessions.add(state.sessionId)
    return state
  }

  /** Create or replace the state file atomically. */
  async write(state: GuardianSessionState): Promise<void> {
    assertPathSegment(state.userId, 'userId')
    if (typeof state.sessionId !== 'string' || state.sessionId.trim() === '') {
      throw new Error('guardian-session: sessionId must be a non-empty string')
    }
    const filePath = this.filePath(state.userId)
    const body = `${JSON.stringify({
      version: 1,
      userId: state.userId,
      sessionId: state.sessionId,
      title: state.title || GUARDIAN_SESSION_TITLE,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    }, null, 2)}\n`
    await writeFileAtomic(filePath, body, { mode: 0o600 })
    this.knownSessions.add(state.sessionId)
  }

  /** Remove one user's guardian identity. Idempotent. */
  async remove(userId: string): Promise<void> {
    const state = await this.read(userId).catch(() => undefined)
    if (state !== undefined) this.knownSessions.delete(state.sessionId)
    await rm(this.filePath(userId), { force: true })
  }

  /**
   * Whether a session id belongs to any user's guardian. Negative answers are
   * not cached because a session can become a guardian later; positive answers
   * are, so the common turn-event path stays cheap.
   */
  async isGuardianSession(sessionId: string): Promise<boolean> {
    if (sessionId === '' || this.knownSessions.has(sessionId)) return this.knownSessions.has(sessionId)
    let entries: Array<{ isDirectory(): boolean; name: string }>
    try {
      entries = await readdir(this.usersRoot, { withFileTypes: true })
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const state = await this.read(entry.name).catch(() => undefined)
      if (state?.sessionId === sessionId) return true
    }
    return false
  }
}

/**
 * Resolve the user's guardian, creating it lazily when needed.
 *
 * Existing live agent → reuse. Persisted agent → resume. Resume failure or a
 * missing state file → create one standard-mode session, write the identity
 * first (so a failed seed cannot orphan it), then deliver the seed message.
 */
export async function resolveOrCreateGuardian(
  host: GuardianSessionHost,
  userId: string,
): Promise<ResolvedGuardian> {
  // Idle and compaction can fire in the same tick. Single-flight the first
  // resolution per user so two messages cannot create two guardian sessions.
  const key = `${host.usersRoot}\u0000${userId}`
  const existing = pendingResolutions.get(key)
  if (existing !== undefined) return existing
  const pending = resolveOrCreateGuardianUncached(host, userId)
  pendingResolutions.set(key, pending)
  return pending.finally(() => {
    if (pendingResolutions.get(key) === pending) pendingResolutions.delete(key)
  })
}

/** Keyed by `<usersRoot>\u0000<userId>`; entries exist only while resolving. */
const pendingResolutions = new Map<string, Promise<ResolvedGuardian>>()

async function resolveOrCreateGuardianUncached(
  host: GuardianSessionHost,
  userId: string,
): Promise<ResolvedGuardian> {
  const store = new GuardianSessionStore(host.usersRoot)
  const cwd = host.cwd ?? process.cwd()
  const timestamp = (): string => new Date().toISOString()

  const state = await store.read(userId)
  if (state !== undefined) {
    const live = host.getAgent(state.sessionId)
    if (live !== undefined) return { state, agent: live, created: false }
    try {
      const resumed = await host.resumeAgent({ sessionId: state.sessionId, cwd })
      return { state, agent: resumed, created: false }
    } catch {
      // The session was deleted or its persistence is gone. Fall through and
      // create a replacement; the old id is abandoned, not reused.
    }
  } else if (host.findByTitle !== undefined) {
    // State lost: adopt a unique title match before creating another guardian.
    const found = await host.findByTitle(GUARDIAN_SESSION_TITLE).catch(() => undefined)
    if (found !== undefined && found !== '') {
      const live = host.getAgent(found)
      let agent: GuardianAgentRef | undefined = live
      if (agent === undefined) {
        agent = await host.resumeAgent({ sessionId: found, cwd }).catch(() => undefined)
      }
      if (agent !== undefined) {
        const adopted: GuardianSessionState = {
          version: 1,
          userId,
          sessionId: found,
          title: GUARDIAN_SESSION_TITLE,
          createdAt: timestamp(),
          updatedAt: timestamp(),
        }
        await store.write(adopted)
        return { state: adopted, agent, created: false }
      }
    }
  }

  const sessionId = host.newSessionId?.() ?? `session-${randomUUID()}`
  const agent = await host.createAgent({ sessionId, cwd, title: GUARDIAN_SESSION_TITLE })
  const created: GuardianSessionState = {
    version: 1,
    userId,
    sessionId,
    title: GUARDIAN_SESSION_TITLE,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  }
  // Identity before the seed: if delivery fails, the next call resumes this
  // session instead of creating a second guardian.
  await store.write(created)
  try {
    await host.setTitle?.(agent, GUARDIAN_SESSION_TITLE)
  } catch {
    // Title is display-only; a rename failure must not lose the identity.
  }
  await host.deliverText(agent, guardianSeedText())
  return { state: created, agent, created: true }
}

/**
 * Deliver one trigger message to the user's guardian, reusing the resolved
 * session. This is the ONLY send path used by the tool and the triggers.
 */
export async function sendToGuardian(
  host: GuardianSessionHost,
  userId: string,
  message: GuardianMessage,
): Promise<GuardianSendResult> {
  // A hung agent loop must not hold a normal session's tool call open forever.
  // The timeout releases the caller; the underlying resolution is left to
  // finish (or be reused by the single-flight map) rather than killed.
  const resolved = await withGuardianTimeout(
    resolveOrCreateGuardian(host, userId),
    host.timeoutMs,
    'guardian session resolution',
  )
  const delivery = await withGuardianTimeout(
    Promise.resolve(host.deliverText(resolved.agent, renderGuardianMessage(message))),
    host.timeoutMs,
    'guardian message delivery',
  )
  const store = new GuardianSessionStore(host.usersRoot)
  await store.write({ ...resolved.state, updatedAt: new Date().toISOString() })
  return {
    delivered: delivery.delivered !== false,
    queued: delivery.queued === true,
    sessionId: resolved.state.sessionId,
    created: resolved.created,
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}
