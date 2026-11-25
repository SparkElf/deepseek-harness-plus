/** Read and write the DataOps workspace limits this deployment enforces. */

import type { Context } from '@deepseek-ai/cordis'
import { noteAccepted, noteExpired } from './auth-state.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

/** The two byte ceilings one workspace size setting carries. */
export interface WorkspaceSizeLimits {
  /** Largest file a sidebar download or agent read may carry. */
  fileReadMaxBytes: number
  /** Largest file an upload may carry. */
  uploadMaxBytes: number
}

/** What the Settings panel reads. */
export interface WorkspaceLimitsStatus {
  /** Current ceilings. */
  limits: WorkspaceSizeLimits
  /** Whether the signed-in user may change them. */
  canWrite: boolean
  /** Why the limits are read-only, when they are. */
  readOnlyReason: string | null
}

/** Configuration the host half receives from the profile. */
export interface WorkspaceLimitsConfig {
  /** DataOps browser/API origin reachable from the DSH Host. */
  baseUrl: string
  /** DSH credential reference holding the current DataOps access JWT. */
  credentialRef: string
}

/** Narrow a value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Narrow a value to a positive integer. */
function asByteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * A rejection DataOps answered with, carrying its status and message.
 *
 * Without this the caller can only tell that something failed, and a value DataOps refused —
 * which the user can correct — is indistinguishable from a fault in the request path.
 */
export class WorkspaceLimitsRejection extends Error {
  constructor(
    /** HTTP status DataOps answered with. */
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceLimitsRejection'
  }
}

/** Read DataOps' own explanation from a failed response, falling back to the status line. */
async function rejectionMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = asRecord(await response.json())
    const message = body?.message
    if (typeof message === 'string' && message.trim() !== '') return message
    if (Array.isArray(message) && typeof message[0] === 'string') return message[0]
  } catch {
    // A body that is absent or not JSON leaves the fallback as the only explanation available.
  }
  return `${fallback} with HTTP ${String(response.status)}`
}

/**
 * The workspace limits an administrator sets in DataOps.
 *
 * The plugin holds the DataOps JWT, so the browser cannot read these itself; this class is the
 * only path from the Settings panel to that document.
 */
export class WorkspaceLimits {
  constructor(
    private readonly ctx: Context,
    private readonly config: WorkspaceLimitsConfig,
  ) {}

  /**
   * Read the DataOps JWT this workspace is currently authorized with.
   * @returns The token, or undefined when the workspace has no session yet.
   */
  private async token(): Promise<string | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.credentialRef))
    return resolved?.value
  }

  /** The DataOps API origin this workspace reports to. */
  private apiBase(): string {
    return new URL(this.config.baseUrl).origin
  }

  /**
   * Read the current ceilings.
   * @returns The status, or undefined when the workspace is not authorized.
   */
  async status(): Promise<WorkspaceLimitsStatus | undefined> {
    const token = await this.token()
    if (token === undefined) return undefined
    const response = await fetch(new URL('/api/ai/attachment-settings', this.apiBase()), {
      headers: { authorization: `Bearer ${token}` },
    })
    if (response.status === 401) {
      noteExpired()
      return undefined
    }
    noteAccepted()
    if (!response.ok) {
      throw new WorkspaceLimitsRejection(response.status, await rejectionMessage(response, 'Workspace limits read failed'))
    }
    const body = asRecord(await response.json())
    const settings = body === null ? null : asRecord(body.settings)
    const size = settings === null ? null : asRecord(settings.workspaceSize)
    const fileReadMaxBytes = size === null ? null : asByteCount(size.fileReadMaxBytes)
    const uploadMaxBytes = size === null ? null : asByteCount(size.uploadMaxBytes)
    if (fileReadMaxBytes === null || uploadMaxBytes === null) {
      throw new Error('Workspace limits read returned an unrecognized document')
    }
    return {
      limits: { fileReadMaxBytes, uploadMaxBytes },
      canWrite: true,
      readOnlyReason: null,
    }
  }

  /**
   * Write new ceilings.
   * @param limits - The ceilings to store.
   * @returns The stored status.
   */
  async save(limits: WorkspaceSizeLimits): Promise<WorkspaceLimitsStatus | undefined> {
    const token = await this.token()
    if (token === undefined) return undefined
    const response = await fetch(new URL('/api/ai/attachment-settings', this.apiBase()), {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceSize: limits }),
    })
    if (response.status === 401) {
      noteExpired()
      return undefined
    }
    noteAccepted()
    if (!response.ok) {
      throw new WorkspaceLimitsRejection(response.status, await rejectionMessage(response, 'Workspace limits write failed'))
    }
    return this.status()
  }
}

/** The live instance, so the Settings route can act on it after activation. */
let limitsRef: WorkspaceLimits | undefined

/** @param next - Instance to publish, or undefined to clear. */
export function setWorkspaceLimits(next: WorkspaceLimits | undefined): void {
  limitsRef = next
}

/** @returns The live workspace-limits instance, when the plugin activated. */
export function currentWorkspaceLimits(): WorkspaceLimits | undefined {
  return limitsRef
}