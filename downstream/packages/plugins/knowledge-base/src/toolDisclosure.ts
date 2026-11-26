/**
 * Permission-based disclosure of the model-facing knowledge-base tools.
 *
 * A tool the caller may never use should not be in the model's tool list at all.
 * Registering every tool and refusing inside `execute()` wastes a schema slot,
 * invites a call that will fail, and hides the real capability from the surface
 * that decides what to offer. Disclosure is therefore decided ONCE per permission
 * context: the coordinator registers the tools a context allows and disposes the
 * rest. Execution never re-reads the full permission tree; the backend remains the
 * final authority for every request the tools then make.
 *
 * ## What is decided where
 *
 * - **Disclosure (this module).** A tool's group and its required permission keys
 *   or role capability. Evaluated from the caller's `/api/ai/review/context`
 *   projection (`ManagementContext`), the same object the Settings panel and route
 *   gate already read.
 * - **Data filtering (the tools themselves).** Path-level `canRead` / `canWrite`
 *   calls stay in `execute()`: they decide WHICH rows a visible tool may touch, not
 *   whether the tool exists. The same holds for department-scope filtering of
 *   grants, audit entries and review queues.
 * - **Final authorization (DataOps).** Every backend route the tools call enforces
 *   the JWT's current roles and grants. A stale tool registration can therefore
 *   cause a refusal, never an unauthorized read or write.
 *
 * ## Groups
 *
 * `read` tools exist for a caller with the knowledge-base read key; `write` tools
 * for the editors; `manage` for the administrator/reviewer surfaces; `publish` for
 * workflow publication. Groups exist so a permission change can be applied as a
 * set, and so a fault in one group is reflected in one place rather than in every
 * tool body.
 *
 * @module @sparkelf/dsh-knowledge-base/toolDisclosure
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  hasPermission,
  isGlobalAdmin,
  type ManagementContext,
} from './managementTools.ts'

/** The four disclosure groups a knowledge-base tool can belong to. */
export const TOOL_GROUPS = ['read', 'write', 'manage', 'publish'] as const

/** One disclosure group. */
export type KnowledgeToolGroup = (typeof TOOL_GROUPS)[number]

/**
 * One tool's disclosure rule.
 *
 * `permissions` lists keys that must ALL be held. `capability` names a role
 * capability that must also be present; it is how the tools whose product
 * description is "reviewer only" or "global admin only" are filtered without
 * inventing a permission key the backend does not issue.
 */
export interface ToolAccessRule {
  /** Which group the tool is registered and disposed with. */
  readonly group: KnowledgeToolGroup
  /** Every permission key the caller must hold. */
  readonly permissions?: readonly string[]
  /** Reviewer/admin capability the caller must have, in addition to permissions. */
  readonly capability?: 'reviewer' | 'admin'
}

/**
 * Disclosure rules for every model-facing tool this package registers.
 *
 * The map is the single list of what exists; the coordinator rejects a tool
 * definition without a rule and a rule without a definition at construction time,
 * so a new tool cannot ship undisclosed or leave a stale policy behind.
 */
export const KB_TOOL_ACCESS: Readonly<Record<string, ToolAccessRule>> = Object.freeze({
  // Read: visible to any caller with the knowledge-base read key. Data rows remain
  // path-filtered by `canReadPath` inside the host seams.
  kb_search: { group: 'read', permissions: ['kb:file:read'] },
  kb_chunk_get: { group: 'read', permissions: ['kb:file:read'] },
  kb_outline: { group: 'read', permissions: ['kb:file:read'] },
  // Renderer-only, but it writes the generated INDEX.md; the backend still checks
  // read access to the source document, so disclosure follows that same key.
  kb_outline_rewrite: { group: 'read', permissions: ['kb:file:read'] },
  kb_vectorize: { group: 'read', permissions: ['kb:file:read'] },
  // Workflow listing is a read surface for ordinary users; only review/management
  // actions are gated to reviewers below.
  workflow_list: { group: 'read', permissions: ['workflow:read'] },

  // Write: the tool exists only when the matching editing key is held. The path's
  // own `canWrite` check still runs on every target.
  kb_file_write: { group: 'write', permissions: ['kb:file:write'] },
  kb_file_move: { group: 'write', permissions: ['kb:file:write'] },
  kb_file_delete: { group: 'write', permissions: ['kb:file:delete'] },
  kb_file_mkdir: { group: 'write', permissions: ['kb:file:write'] },
  kb_file_extract: { group: 'write', permissions: ['kb:file:extract'] },
  // Graph tools: read for get, write for add/set, delete for del. Path-level
  // `canWritePath` still runs on the graph folder before any write.
  kg_get: { group: 'read', permissions: ['kb:file:read'] },
  // Runtime memory context: a read surface over the caller's own bindings. The
  // resolver applies graph visibility itself and never writes.
  memory_context: { group: 'read', permissions: ['kb:file:read'] },
  // Any authenticated caller may notify their OWN guardian; the tool accepts no
  // user/target argument, so it is a read-surface action rather than management.
  memory_guardian_send: { group: 'read', permissions: ['kb:file:read'] },
  // Guardian-only write surface. The tools check the live session against the
  // guardian state; the permission gate keeps them off a reader's tool list.
  memory_record: { group: 'write', permissions: ['kb:file:write'] },
  memory_promote_sop: { group: 'write', permissions: ['kb:file:write'] },
  kg_add: { group: 'write', permissions: ['kb:file:write'] },
  kg_set: { group: 'write', permissions: ['kb:file:write'] },
  kg_del: { group: 'write', permissions: ['kb:file:delete'] },
  // A summary is written next to a document the caller must also be able to read.
  kb_outline_save: { group: 'write', permissions: ['kb:file:read', 'kb:file:write'] },

  // Manage: deployment configuration, grants, audit, review and index upkeep.
  kb_config_get: { group: 'manage', permissions: ['kb:config:manage'] },
  kb_config_update: { group: 'manage', permissions: ['kb:config:manage'] },
  kb_grant_list: { group: 'manage', permissions: ['kb:grant:manage'] },
  kb_grant_set: { group: 'manage', permissions: ['kb:grant:manage'] },
  kb_audit_list: { group: 'manage', permissions: ['kb:audit:read'] },
  kb_review_list: { group: 'manage', permissions: ['kb:review:decide'] },
  kb_review_decide: { group: 'manage', permissions: ['kb:review:decide'] },
  // The product description is "admin/reviewer only"; there is no dedicated backend
  // key for a view refresh, so the reviewed capability is the honest requirement.
  kb_sync: { group: 'manage', capability: 'reviewer' },
  // Rebuilding the index is a deployment-wide admin action.
  kb_index_rebuild: { group: 'manage', permissions: ['kb:config:manage'] },
  // The guardian pass mutates personal bindings on the caller's behalf, so it is
  // a configuration-management action rather than a read.
  memory_guardian_run: { group: 'manage', permissions: ['kb:config:manage'] },
  workflow_unpublish: { group: 'manage', permissions: ['workflow:manage'] },
  workflow_review_list: { group: 'manage', permissions: ['workflow:review:decide'] },
  workflow_review_scan: { group: 'manage', permissions: ['workflow:review:decide'] },
  workflow_review_decide: { group: 'manage', permissions: ['workflow:review:decide'] },

  // Publish: sharing a workflow is a normal-user action once the publish key is
  // held; the global-visibility scope check stays inside the tool because it is a
  // property of the individual call, not of the tool's existence.
  workflow_publish: { group: 'publish', permissions: ['workflow:publish'] },
  workflow_update: { group: 'publish', permissions: ['workflow:publish'] },
})

/** Tool names per group, derived from {@link KB_TOOL_ACCESS}. */
export const TOOL_GROUPS_OF: Readonly<Record<KnowledgeToolGroup, readonly string[]>> = Object.freeze({
  read: namesIn('read'),
  write: namesIn('write'),
  manage: namesIn('manage'),
  publish: namesIn('publish'),
})

/** Every model-facing tool name this package discloses. */
export const KNOWLEDGE_TOOL_NAMES: readonly string[] = Object.freeze(Object.keys(KB_TOOL_ACCESS))

function namesIn(group: KnowledgeToolGroup): readonly string[] {
  return Object.freeze(Object.entries(KB_TOOL_ACCESS)
    .filter(([, rule]) => rule.group === group)
    .map(([name]) => name))
}

/** One tool's disclosure decision. */
export interface ToolAccessDecision {
  /** Whether the tool may be registered for this context. */
  readonly allowed: boolean
  /** The tool's group, when a rule exists. */
  readonly group?: KnowledgeToolGroup
  /**
   * What the context lacks, as permission keys (`kb:file:write`) or capability
   * labels (`reviewer`, `admin`, `permission-context`). Empty when allowed.
   */
  readonly missing: readonly string[]
}

/**
 * Decide whether one tool is visible for a permission context.
 *
 * An absent context is a denial: disclosure happens before execution, so an
 * unresolved permission tree must withhold the surface rather than expose it.
 * Unknown tool names are denied too; the coordinator rejects them at construction,
 * and this function keeps the same fail-closed answer if one reaches it anyway.
 *
 * @param name - model-facing tool name.
 * @param context - the caller's review context, or undefined while it is unavailable.
 * @returns the decision and the requirements the context did not satisfy.
 */
export function decideToolAccess(
  name: string,
  context: ManagementContext | undefined,
): ToolAccessDecision {
  const rule = KB_TOOL_ACCESS[name]
  if (rule === undefined) {
    return { allowed: false, missing: ['disclosure-policy'] }
  }
  if (context === undefined) {
    return { allowed: false, group: rule.group, missing: ['permission-context'] }
  }
  const missing: string[] = []
  for (const permission of rule.permissions ?? []) {
    if (!hasPermission(context, permission)) missing.push(permission)
  }
  if (rule.capability === 'reviewer' && !(isGlobalAdmin(context) || context.review.canReview === true)) {
    missing.push('reviewer')
  }
  if (rule.capability === 'admin' && !isGlobalAdmin(context)) {
    missing.push('admin')
  }
  return {
    allowed: missing.length === 0,
    group: rule.group,
    missing,
  }
}

/** One withheld tool and the requirements that withheld it. */
export interface ToolDenial {
  readonly name: string
  readonly group?: KnowledgeToolGroup
  readonly missing: readonly string[]
}

/** The disclosure state after one pass. */
export interface ToolDisclosureSnapshot {
  /** Tool names registered after this pass, in definition order. */
  readonly registered: readonly string[]
  /** Tools withheld from the model, with the unsatisfied requirement per tool. */
  readonly denied: readonly ToolDenial[]
  /** Groups that currently have at least one registered tool. */
  readonly activeGroups: readonly KnowledgeToolGroup[]
  /** Set when the permission context could not be resolved; every tool is disposed. */
  readonly error?: string
}

/** The tool registry seam this coordinator needs. */
export interface ToolRegistryLike {
  /** Register one tool; returns the exact disposer that unregisters it. */
  register(definition: ToolDefinition): () => void
}

/** Construction options for a {@link ToolDisclosureCoordinator}. */
export interface ToolDisclosureOptions {
  /** Every model-facing tool this plugin can register. */
  readonly tools: readonly ToolDefinition[]
  /** The host registry to register into and dispose from. */
  readonly registry: ToolRegistryLike
  /**
   * Resolve the caller's current review context. Called on an explicit refresh,
   * never from a tool's `execute()`.
   */
  readonly resolveContext: () => Promise<ManagementContext>
  /** Diagnostic sink; a failed refresh is reported here instead of thrown. */
  readonly log?: (message: string) => void
}

/**
 * Register and dispose knowledge-base tools as the caller's permission context changes.
 *
 * The coordinator owns every tool registration. A pass computes one decision per
 * tool, registers the newly allowed ones, disposes the newly denied ones and
 * leaves unchanged tools untouched, so an unchanged context causes no registry
 * churn. Concurrent refreshes share one in-flight context read; a pass that is
 * superseded by a newer context never applies its stale answer.
 *
 * On a context-resolution failure every gated tool is disposed. That is the
 * fail-closed direction: an unavailable permission tree cannot prove a capability,
 * and a tool surface that outlives its proof is exactly the leak disclosure exists
 * to prevent.
 */
export class ToolDisclosureCoordinator {
  private readonly definitions: ReadonlyMap<string, ToolDefinition>
  /** Registered tools and their exact registry disposers. */
  private readonly disposers = new Map<string, () => void>()
  private readonly options: ToolDisclosureOptions
  /** Monotonic pass counter; a slower older read must not overwrite a newer one. */
  private generation = 0
  private inFlight?: Promise<ToolDisclosureSnapshot>
  private disposed = false
  private snapshot?: ToolDisclosureSnapshot

  constructor(options: ToolDisclosureOptions) {
    this.options = options
    this.definitions = new Map(options.tools.map(definition => [definition.name, definition]))
    assertCompleteDisclosure(this.definitions.keys())
  }

  /** Tool names currently registered, in definition order. */
  get registeredTools(): readonly string[] {
    return [...this.definitions.keys()].filter(name => this.disposers.has(name))
  }

  /** The most recent disclosure pass, if one has completed. */
  get lastSnapshot(): ToolDisclosureSnapshot | undefined {
    return this.snapshot
  }

  /**
   * Recompute the tool surface.
   *
   * @param context - a context already read by the caller (a route gate or status
   *   request). Passing it avoids a second backend round trip. Omit it to resolve
   *   one through {@link ToolDisclosureOptions.resolveContext}.
   * @returns the resulting snapshot; a context failure is reported in `error`
   *   rather than thrown, because a refresh must never fail the request that
   *   triggered it.
   */
  syncToolDisclosure(context?: ManagementContext): Promise<ToolDisclosureSnapshot> {
    if (this.disposed) {
      return Promise.resolve(this.emptySnapshot('tool disclosure is disposed'))
    }
    if (context !== undefined) {
      this.generation += 1
      try {
        return Promise.resolve(this.apply(context))
      } catch (error) {
        return Promise.resolve(this.fail(error))
      }
    }
    if (this.inFlight !== undefined) return this.inFlight
    const generation = ++this.generation
    const run: Promise<ToolDisclosureSnapshot> = Promise.resolve()
      .then(() => this.options.resolveContext())
      .then(resolved => (
        generation === this.generation
          ? this.apply(resolved)
          : (this.snapshot ?? this.emptySnapshot('a newer disclosure pass superseded this one'))
      ))
      .catch((error: unknown) => (
        generation === this.generation
          ? this.fail(error)
          : (this.snapshot ?? this.emptySnapshot('a newer disclosure pass superseded this one'))
      ))
      .finally(() => {
        if (this.inFlight === run) this.inFlight = undefined
      })
    this.inFlight = run
    return run
  }

  /** Dispose every tool this coordinator registered; later refreshes are no-ops. */
  dispose(): void {
    this.disposed = true
    this.disposeRegistered()
  }

  /** Register allowed tools and dispose denied ones for one resolved context. */
  private apply(context: ManagementContext): ToolDisclosureSnapshot {
    const denied: ToolDenial[] = []
    for (const [name, definition] of this.definitions) {
      const decision = decideToolAccess(name, context)
      if (decision.allowed) {
        if (!this.disposers.has(name)) {
          try {
            this.disposers.set(name, this.options.registry.register(definition))
          } catch (error) {
            this.options.log?.(`tool disclosure: could not register ${name}: ${messageOf(error)}`)
            denied.push({
              name,
              ...(decision.group === undefined ? {} : { group: decision.group }),
              missing: ['register-failed'],
            })
          }
        }
        continue
      }
      denied.push({
        name,
        ...(decision.group === undefined ? {} : { group: decision.group }),
        missing: decision.missing,
      })
      const dispose = this.disposers.get(name)
      if (dispose !== undefined) {
        try {
          dispose()
        } catch (error) {
          this.options.log?.(`tool disclosure: could not dispose ${name}: ${messageOf(error)}`)
        }
        this.disposers.delete(name)
      }
    }
    const registered = this.registeredTools
    const snapshot: ToolDisclosureSnapshot = {
      registered,
      denied,
      activeGroups: TOOL_GROUPS.filter(group => registered.some(name => KB_TOOL_ACCESS[name]?.group === group)),
    }
    const changed = this.snapshot === undefined
      || this.snapshot.registered.join('\u0000') !== registered.join('\u0000')
      || (this.snapshot.error === undefined) !== (snapshot.error === undefined)
    this.snapshot = snapshot
    if (changed) {
      this.options.log?.(`tool disclosure: registered ${String(registered.length)} tool(s) [${registered.join(', ')}]; withheld ${String(denied.length)}`)
    }
    return snapshot
  }

  /** Dispose everything and report why the surface is empty. */
  private fail(error: unknown): ToolDisclosureSnapshot {
    this.disposeRegistered()
    const message = messageOf(error)
    const denied = [...this.definitions.keys()].map((name): ToolDenial => ({
      name,
      ...(KB_TOOL_ACCESS[name] === undefined ? {} : { group: KB_TOOL_ACCESS[name].group }),
      missing: ['permission-context'],
    }))
    const snapshot: ToolDisclosureSnapshot = {
      registered: [],
      denied,
      activeGroups: [],
      error: message,
    }
    this.snapshot = snapshot
    this.options.log?.(`tool disclosure: permission context unavailable; withheld every gated tool: ${message}`)
    return snapshot
  }

  /** Dispose every registered tool; safe to call more than once. */
  private disposeRegistered(): void {
    for (const dispose of this.disposers.values()) {
      try {
        dispose()
      } catch (error) {
        this.options.log?.(`tool disclosure: could not dispose a tool: ${messageOf(error)}`)
      }
    }
    this.disposers.clear()
  }

  /** Snapshot for a pass that cannot run at all. */
  private emptySnapshot(reason: string): ToolDisclosureSnapshot {
    return {
      registered: [],
      denied: [...this.definitions.keys()].map((name): ToolDenial => ({
        name,
        ...(KB_TOOL_ACCESS[name] === undefined ? {} : { group: KB_TOOL_ACCESS[name].group }),
        missing: ['permission-context'],
      })),
      activeGroups: [],
      error: reason,
    }
  }
}

/**
 * Build a coordinator.
 *
 * @param options - the definitions, registry, context resolver and log sink.
 * @returns the coordinator the plugin stores and refreshes.
 */
export function createToolDisclosure(options: ToolDisclosureOptions): ToolDisclosureCoordinator {
  return new ToolDisclosureCoordinator(options)
}

/**
 * Reject a policy map that drifted from the tool set.
 *
 * Called by the constructor, so a missing rule or a stale rule fails at plugin
 * start rather than silently exposing or hiding a tool later.
 */
function assertCompleteDisclosure(names: Iterable<string>): void {
  const present = new Set(names)
  const unknown = [...present].filter(name => KB_TOOL_ACCESS[name] === undefined)
  const stale = Object.keys(KB_TOOL_ACCESS).filter(name => !present.has(name))
  if (unknown.length > 0 || stale.length > 0) {
    throw new Error(
      'knowledge-base tool disclosure is incomplete:'
      + (unknown.length === 0 ? '' : ` no policy for ${unknown.join(', ')};`)
      + (stale.length === 0 ? '' : ` policy without a tool for ${stale.join(', ')};`),
    )
  }
}

/** Error text safe to log from a contained refresh. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
