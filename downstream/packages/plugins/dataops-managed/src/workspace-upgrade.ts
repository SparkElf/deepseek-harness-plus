/**
 * Workspace image upgrade orchestration.
 *
 * DataOps owns the Docker image comparison and the container restart. This plugin owns
 * the two facts DSH alone can know: which sessions are running right now, and how to
 * bring those sessions back after the container has been recreated. A small JSON file
 * on the shared workspace volume carries that hand-off across the restart.
 *
 * @module workspace-upgrade
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { noteAccepted, noteExpired } from './auth-state.ts'
import {
  WORKSPACE_UPGRADE_STATE_VERSION,
  clearWorkspaceUpgradeState,
  readWorkspaceUpgradeState,
  workspaceUpgradeStatePath,
  writeWorkspaceUpgradeState,
  type WorkspaceUpgradeSession,
  type WorkspaceUpgradeState,
} from './workspace-upgrade-state.ts'

/** Configuration needed to talk to DataOps. */
export interface WorkspaceUpgradeConfig {
  /** DataOps API origin reachable from the DSH Host. */
  baseUrl: string
  /** Credential reference holding the current DataOps JWT. */
  credentialRef: string
}

/** The subset of the DataOps restart-preview response this plugin uses. */
export interface WorkspaceUpgradePreview {
  imageStatus: 'CURRENT' | 'UPDATE_AVAILABLE' | 'NOT_RUNNING' | 'UNKNOWN'
  configuredImage: string
  activeSessions: WorkspaceUpgradeSession[]
}

/** The live agent shape used for snapshot and recovery; intentionally structural. */
interface LiveAgentLike {
  readonly status: 'running' | 'idle'
  readonly id: string
  readonly session: {
    readonly id: string
    readonly header?: { readonly cwd?: string; readonly title?: string }
  }
  followup(message: unknown): void
}

interface AgentsService {
  list(): LiveAgentLike[]
  get(id: string): LiveAgentLike | undefined
  resume(options: { resumeSessionId: string }): Promise<{ agent: LiveAgentLike }>
}

/** A refusal or transport failure from the DataOps API. */
export class WorkspaceUpgradeError extends Error {
  constructor(
    /** HTTP status, or 502 when DataOps could not be reached. */
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceUpgradeError'
  }
}

/** Create the user-message value `agent.followup` accepts. */
function userMessage(text: string): unknown {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** Extract a useful message from a DataOps error body. */
async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as Record<string, unknown>
    const message = body.message
    if (typeof message === 'string' && message.trim() !== '') return message
    if (Array.isArray(message) && typeof message[0] === 'string') return message[0]
  } catch {
    // The status line remains the only useful explanation.
  }
  return `${fallback} (HTTP ${String(response.status)})`
}

/** Owns DataOps preview/restart calls and the DSH session hand-off. */
export class WorkspaceUpgrade {
  constructor(
    private readonly ctx: Context,
    private readonly config: WorkspaceUpgradeConfig,
    readonly statePath = workspaceUpgradeStatePath(),
  ) {}

  /** Resolve the injected DSH agents service, if the profile provides one. */
  private agents(): AgentsService | undefined {
    return (this.ctx as unknown as { agents?: AgentsService }).agents
  }

  /** Read the current DataOps credential. */
  private async token(): Promise<string | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.credentialRef))
    return resolved?.value
  }

  /** DataOps origin used by this workspace. */
  private apiBase(): string {
    return new URL(this.config.baseUrl).origin
  }

  /** Call one DataOps API path with the workspace JWT. */
  private async request(path: string, init?: RequestInit): Promise<Response> {
    const token = await this.token()
    if (token === undefined) throw new WorkspaceUpgradeError(401, 'workspace is not signed in to DataOps')
    let response: Response
    try {
      response = await fetch(new URL(path, this.apiBase()), {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init?.headers ?? {}),
        },
      })
    } catch (error) {
      throw new WorkspaceUpgradeError(502, error instanceof Error ? error.message : String(error))
    }
    if (response.status === 401) {
      noteExpired()
      throw new WorkspaceUpgradeError(401, 'DataOps session has ended')
    }
    noteAccepted()
    return response
  }

  /** Read the DataOps restart preview plus this host's running-session snapshot. */
  async preview(): Promise<WorkspaceUpgradePreview> {
    const response = await this.request('/api/ai/workspace/restart-preview')
    if (!response.ok) throw new WorkspaceUpgradeError(response.status, await responseMessage(response, 'workspace preview failed'))
    const body = await response.json() as {
      workspace?: { imageStatus?: unknown; configuredImage?: unknown }
      activeTasks?: unknown
    }
    const imageStatus = body.workspace?.imageStatus
    if (imageStatus !== 'CURRENT' && imageStatus !== 'UPDATE_AVAILABLE' && imageStatus !== 'NOT_RUNNING' && imageStatus !== 'UNKNOWN') {
      throw new WorkspaceUpgradeError(502, 'workspace preview returned an unrecognized image status')
    }
    return {
      imageStatus,
      configuredImage: typeof body.workspace?.configuredImage === 'string' ? body.workspace.configuredImage : '',
      activeSessions: this.runningSessions(),
    }
  }

  /** Snapshot sessions that are executing a turn right now. */
  private runningSessions(): WorkspaceUpgradeSession[] {
    const agents = this.agents()
    if (agents === undefined) return []
    return agents.list()
      .filter(agent => agent.status === 'running')
      .map(agent => ({
        sessionId: agent.session.id,
        ...(agent.session.header?.title ? { title: agent.session.header.title } : {}),
        ...(agent.session.header?.cwd ? { cwd: agent.session.header.cwd } : {}),
      }))
  }

  /** Restart DataOps' workspace container; force is required when sessions are snapshot. */
  private async restart(): Promise<void> {
    const response = await this.request('/api/ai/workspace/restart', {
      method: 'POST',
      body: JSON.stringify({ force: true }),
    })
    if (!response.ok) throw new WorkspaceUpgradeError(response.status, await responseMessage(response, 'workspace restart failed'))
  }

  /**
   * Persist the running-session snapshot and ask DataOps to recreate the container.
   * @returns the accepted hand-off record.
   */
  async upgrade(): Promise<WorkspaceUpgradeState> {
    const preview = await this.preview()
    if (preview.imageStatus !== 'UPDATE_AVAILABLE') {
      throw new WorkspaceUpgradeError(409, 'workspace image is already current or not running')
    }
    const state: WorkspaceUpgradeState = {
      version: WORKSPACE_UPGRADE_STATE_VERSION,
      upgradeId: randomUUID(),
      targetImage: preview.configuredImage,
      sessions: preview.activeSessions,
      createdAt: new Date().toISOString(),
    }
    await writeWorkspaceUpgradeState(state, this.statePath)
    try {
      await this.restart()
    } catch (error) {
      // The container was not recreated, so there is nothing to resume.
      await clearWorkspaceUpgradeState(this.statePath)
      throw error
    }
    return state
  }

  /**
   * Resume every snapshotted session and send one "继续".
   *
   * The method deliberately does not wait for an answer: the user's workspace should
   * become usable immediately, and an in-flight tool call cannot be replayed safely.
   * `recoverWorkspaceUpgradeAfterBoot` removes the hand-off file after this attempt.
   */
  async recover(): Promise<{ recovered: number; skipped: number }> {
    const state = await readWorkspaceUpgradeState(this.statePath)
    if (state === null) return { recovered: 0, skipped: 0 }
    if (this.agents() === undefined) throw new Error('DSH agents service is not ready')
    let recovered = 0
    let skipped = 0
    for (const session of state.sessions) {
      try {
        const agent = await this.ensureAgent(session.sessionId)
        if (agent === undefined) {
          skipped += 1
          continue
        }
        agent.followup(userMessage('继续'))
        recovered += 1
      } catch (error) {
        skipped += 1
        this.ctx.logger.warn(
          `dataops-managed: could not resume session ${session.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return { recovered, skipped }
  }

  /** Remove the hand-off record once recovery has been attempted. */
  async clearRecoveryState(): Promise<void> {
    await clearWorkspaceUpgradeState(this.statePath)
  }

  /** Find a live session or resume it from persisted state. */
  private async ensureAgent(sessionId: string): Promise<LiveAgentLike | undefined> {
    const agents = this.agents()
    if (agents === undefined) return undefined
    const live = agents.get(sessionId)
    if (live !== undefined) return live
    const resumed = await agents.resume({ resumeSessionId: sessionId })
    return resumed?.agent
  }
}

/** Delay helper for boot-time recovery without keeping the plugin apply() pending. */
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

/**
 * Run recovery after the DSH host and its session persistence have had time to boot.
 *
 * `apply()` runs before a persisted session necessarily has its live agent; resuming
 * eagerly can race that boot. A short bounded retry is enough, and a failed attempt
 * still removes the hand-off file so the next page load cannot send "继续" forever.
 * @param upgrade - upgrade service.
 */
export async function recoverWorkspaceUpgradeAfterBoot(upgrade: WorkspaceUpgrade): Promise<void> {
  let lastState: Awaited<ReturnType<typeof readWorkspaceUpgradeState>> = null
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = await readWorkspaceUpgradeState(upgrade.statePath)
    if (state === null) return
    lastState = state
    if (attempt > 0) await sleep(1500)
    try {
      const result = await upgrade.recover()
      // A session that failed to resume is still an attempted recovery; keeping the
      // file would only make the next boot send "继续" again without new information.
      // If every session was skipped, retry briefly in case session persistence was
      // still loading; the final attempt clears the file so it cannot loop forever.
      if (result.recovered > 0 || state.sessions.length === 0) {
        await upgrade.clearRecoveryState()
        return
      }
    } catch (error) {
      console.warn('[dataops-managed] workspace upgrade recovery failed:', error)
    }
  }
  if (lastState !== null) await upgrade.clearRecoveryState()
}
