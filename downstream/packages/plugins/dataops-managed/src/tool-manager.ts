/**
 * Owns the managed tool set for the workspace's current DataOps principal.
 *
 * A DSH workspace belongs to exactly one DataOps user, so the model's tool list can be derived
 * from that user's current scope. The manager is the only writer of that list: it reads
 * `/api/ai/review/context` when the credential changes (the `credentials/reference-updated`
 * event, which is also what JWT adoption and `managed-auth` produce), on the first connect, and
 * when the review-context route observes a different role set. It then reconciles the registry:
 * newly allowed tools are registered, tools the role lost are disposed, and tools that remain
 * allowed keep their registration.
 *
 * The manager never runs inside a tool call. Execution-time authorization belongs to DataOps;
 * this is disclosure, so a scope sync that fails transiently keeps the current set rather than
 * flapping, while a definitive 401/403/404/503 clears it.
 *
 * @module tool-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { onAuthStateChange } from './auth-state.ts'
import type { ReviewApi, ReviewApiResult } from './review-api.ts'
import type { OpenResourceHub } from './resource-tab.ts'
import {
  AI_TOOL_NAMES,
  isAdmin,
  isDepartmentAdmin,
  isSuperAdmin,
  isToolVisible,
  isToolCapabilityEnabled,
  normalizeScope,
  type AiToolName,
  type DataOpsScope,
} from './tool-scope.ts'
import { readConnectorState, type DataOpsConnectorState } from './connector-state.ts'
import { buildAiManagementTools } from './tools.ts'
import { buildAdminWorkspaceTools } from './admin-workspace-tools.ts'

/** Structural view of the skill registry's viewer hook (newer DSH releases). */
interface SkillViewerLike {
  role?: 'user' | 'admin' | 'super-admin'
  permissions?: readonly string[]
}
interface SkillRegistryWithViewer {
  useViewer?(viewer: SkillViewerLike): () => void
}

/** A registered tool name and the exact disposer the registry returned. */
interface Registration {
  dispose: () => void
}

/**
 * Reconcile the managed tools with the current DataOps scope.
 *
 * Construct once per plugin activation. `refresh` is idempotent and coalesces concurrent calls;
 * the constructor also subscribes to the credential observation so an expired session removes
 * the tools without waiting for another explicit sync.
 */
export class AiToolManager {
  private readonly definitions: ReadonlyMap<AiToolName, ToolDefinition>
  private readonly registrations = new Map<AiToolName, Registration>()
  private readonly unsubscribeExpiry: () => void
  private disposeViewer: (() => void) | undefined
  private scope: DataOpsScope | undefined
  private connectorState: DataOpsConnectorState | undefined
  private revision = 0
  private inflight: Promise<void> | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly reviewApi: ReviewApi,
    private readonly collectHub: OpenResourceHub,
  ) {
    this.definitions = new Map(
      [
        ...buildAiManagementTools(ctx, reviewApi, () => this.scope, this.collectHub),
        ...buildAdminWorkspaceTools(reviewApi, () => this.scope),
      ].map(tool => [tool.name, tool.definition]),
    )
    this.unsubscribeExpiry = onAuthStateChange((state) => {
      // A 401 from any DataOps call means the stored JWT is no longer accepted. The next
      // successful adoption produces a credential event that re-reads the scope.
      if (state === 'expired') this.clear()
    })
  }

  /** The scope the current registration set was derived from, when one has been read. */
  currentScope(): DataOpsScope | undefined {
    return this.scope
  }

  /** The tool names currently registered, for diagnostics and tests. */
  registeredToolNames(): AiToolName[] {
    return AI_TOOL_NAMES.filter(name => this.registrations.has(name))
  }

  /**
   * Re-read the workspace's DataOps scope and reconcile the tool list.
   *
   * Definitive denials clear the list; transient failures (network, 5xx) keep what the last good
   * observation produced. The method never throws: sync happens in the background of a browser
   * request and must not fail that request.
   * @param force - Start a new read even when one is already in flight. Credential adoption uses
   *   this because an older read may have captured the previous token; its answer must not win
   *   over the scope the new token produces.
   */
  async refresh(force = false): Promise<void> {
    if (this.disposed) return
    if (this.inflight !== undefined && !force) return this.inflight
    const revision = ++this.revision
    const run = this.loadScope(revision)
      .catch((error: unknown) => {
        // The read has its own network/status handling; this is the last-resort containment so a
        // background refresh can never surface as an unhandled rejection.
        this.ctx.logger.warn('dataops-managed: tool disclosure refresh failed')
        this.ctx.logger.warn(error)
      })
      .finally(() => {
        if (this.inflight === run) this.inflight = undefined
      })
    this.inflight = run
    return run
  }

  /**
   * Apply a context answer already fetched by a same-origin route.
   *
   * The review-context route is how the UI learns about a role change, so its answer is also the
   * freshest scope this plugin will see. Reusing it avoids a second fetch on a page that polls.
   * @param result - The upstream status and parsed body.
   */
  observeContext(result: ReviewApiResult): void {
    if (result.status === 200) {
      this.applyContext(result.body)
      return
    }
    if (result.status === 401 || result.status === 403 || result.status === 404 || result.status === 503) {
      this.clear()
    }
  }

  /**
   * Apply one parsed context body without contacting DataOps.
   * @param body - Parsed `/api/ai/review/context` body.
   */
  applyContext(body: unknown): void {
    if (this.disposed) return
    this.revision += 1
    const scope = normalizeScope(body)
    this.applyScope(scope)
  }

  /** Drop every managed tool because no usable DataOps scope is known. */
  clear(): void {
    if (this.disposed) return
    this.revision += 1
    this.applyScope(undefined)
  }

  /** Dispose every tool this manager registered and stop observing auth state. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.revision += 1
    this.unsubscribeExpiry()
    this.disposeRegistrations()
    this.disposeViewer?.()
    this.disposeViewer = undefined
    this.scope = undefined
  }

  /**
   * Read the connector state that gates capability-owned tools.
   *
   * A missing or unreadable state file is not a permission decision: it means the connector has
   * never been enabled in this workspace, so capability-gated tools stay unregistered.
   * @returns The persisted connector state, or a disabled placeholder when it cannot be read.
   */
  private async readConnectorState(): Promise<DataOpsConnectorState> {
    try {
      return await readConnectorState()
    } catch (error) {
      this.ctx.logger.warn('dataops-managed: connector state could not be read for tool disclosure')
      this.ctx.logger.warn(error)
      return { enabled: false, capabilities: {} }
    }
  }

  /**
   * Re-reconcile after the connector's capability switches changed.
   *
   * The skill center writes the connector state; calling this keeps the registered tool set in
   * step with it without waiting for the next credential or role sync.
   */
  async refreshCapabilities(): Promise<void> {
    if (this.disposed) return
    const connectorState = await this.readConnectorState()
    if (this.disposed) return
    this.applyScope(this.scope, connectorState)
  }

  private async loadScope(revision: number): Promise<void> {
    let result: ReviewApiResult
    try {
      result = await this.reviewApi.request('/api/ai/review/context')
    } catch (error) {
      // DataOps being unreachable is not a permission decision; keep the last good disclosure.
      this.ctx.logger.warn('dataops-managed: tool disclosure could not read the DataOps scope')
      this.ctx.logger.warn(error)
      return
    }
    if (this.disposed || revision !== this.revision) return
    const connectorState = await this.readConnectorState()
    if (this.disposed || revision !== this.revision) return
    if (result.status === 200) {
      this.applyScope(normalizeScope(result.body), connectorState)
      return
    }
    if (result.status === 401 || result.status === 403 || result.status === 404 || result.status === 503) {
      this.applyScope(undefined, connectorState)
      return
    }
    // 5xx and unexpected answers are treated as transient: the next credential/role sync retries.
    this.ctx.logger.warn('dataops-managed: tool disclosure scope read failed with HTTP ' + result.status.toString())
  }

  /** Store the scope and make the registry match it. */
  private applyScope(scope: DataOpsScope | undefined, connectorState?: DataOpsConnectorState): void {
    this.scope = scope
    if (connectorState !== undefined) this.connectorState = connectorState
    if (this.disposed) return
    this.applyViewer(scope)
    const capabilities = this.connectorState ?? { enabled: false, capabilities: {} }
    const desired = new Set<AiToolName>(
      scope === undefined
        ? []
        : AI_TOOL_NAMES.filter(name => isToolVisible(name, scope) && isToolCapabilityEnabled(name, capabilities)),
    )

    for (const [name, registration] of this.registrations) {
      if (desired.has(name)) continue
      this.disposeRegistration(name, registration)
    }

    for (const name of AI_TOOL_NAMES) {
      if (!desired.has(name) || this.registrations.has(name)) continue
      const definition = this.definitions.get(name)
      if (definition === undefined) continue
      try {
        const dispose = this.ctx.tools.register(definition)
        this.registrations.set(name, { dispose })
      } catch (error) {
        this.ctx.logger.warn('dataops-managed: could not register tool ' + name)
        this.ctx.logger.warn(error)
      }
    }
  }


  /** Map one DataOps scope to the skill registry's audience filter. */
  private applyViewer(scope: DataOpsScope | undefined): void {
    this.disposeViewer?.()
    this.disposeViewer = undefined
    const viewer: SkillViewerLike = scope === undefined
      ? { role: 'user', permissions: [] }
      : {
          role: isSuperAdmin(scope) ? 'super-admin' : (isAdmin(scope) || isDepartmentAdmin(scope)) ? 'admin' : 'user',
          permissions: [...(scope.permissions ?? scope.permissionKeys ?? [])],
        }
    try {
      const skills = this.ctx.skills as unknown as SkillRegistryWithViewer
      if (typeof skills.useViewer !== 'function') return
      this.disposeViewer = skills.useViewer(viewer)
    } catch (error) {
      this.ctx.logger.warn('dataops-managed: could not apply the skill viewer')
      this.ctx.logger.warn(error)
    }
  }

  /** Dispose one registration, tolerating a disposer that has already run. */

  private disposeRegistration(name: AiToolName, registration: Registration): void {
    this.registrations.delete(name)
    try {
      registration.dispose()
    } catch (error) {
      this.ctx.logger.warn('dataops-managed: could not dispose tool ' + name)
      this.ctx.logger.warn(error)
    }
  }

  /** Dispose the whole current set. */
  private disposeRegistrations(): void {
    for (const [name, registration] of [...this.registrations]) this.disposeRegistration(name, registration)
  }
}