/**
 * Model-facing runtime memory tools: `memory_context` and `memory_guardian_run`.
 *
 * `memory_context` is read-only. It resolves the caller's personal binding
 * projection through {@link resolveMemoryContext}: live proxies for subscribed
 * sources, the user's own branch for internalized sources, the current entries
 * of the user's own `MemoryStore`, redlines marked non-overridable, and a
 * deterministic budget. It never writes.
 *
 * `memory_guardian_run` is the manual trigger for the guardian pass. It is a
 * maintenance action, not a read: it refreshes `sourceVersion`/`sourceCommit`,
 * resolves pending bindings, performs requested internalizations and revokes
 * branches whose source became redline. It is denied unless the Host reports the
 * `kb:config:manage` capability, and it only touches the caller's own bindings
 * root (`userIds: [caller.userId]`) plus graphs the caller may manage. The
 * scheduled guardian job remains the normal path; this tool exists for
 * operators and for a deployment without a scheduler.
 *
 * Both tools take the same injected host seam as the other knowledge tools: no
 * global config, no ambient session. The caller's viewer is resolved once per
 * call, and the backend remains the final authority for anything the tools then
 * read or write.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-tools
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { LoadedGraph } from './graphModel.ts'
import { canManageGraph, type GraphViewer } from './graphPolicy.ts'
import { asKnowledgeToolError, KnowledgeToolError } from './knowledgeTools.ts'
import {
  DEFAULT_MEMORY_CONTEXT_MAX_CHARS,
  graphScopeDescriptor,
  renderMemoryContextMarkdown,
  resolveMemoryContext,
  type MemoryContextResult,
} from './memoryContext.ts'
import { runGuardianPass, type GuardianResult } from './memoryGuardian.ts'

/** The Host operations the runtime memory tools compose. */
export interface MemoryToolHost {
  /** The authenticated caller, with the department/role projection already resolved. */
  resolveCaller(): Promise<GraphViewer>
  /** Root of `<usersRoot>/<userId>/bindings`; supplied by plugin configuration. */
  usersRoot: string
  /**
   * Absolute root of the caller's own personal `MemoryStore`
   * (`<actualRoot>/personal/<userId>/个人记忆图谱`). The Host builds it from the
   * authenticated user id; omitting it keeps a bindings-only context.
   */
  personalMemoryRoot?(viewer: GraphViewer): string
  /** Every graph the caller may read. Implementations must not return a denied graph. */
  loadGraphs(viewer: GraphViewer): Promise<LoadedGraph[]>
  /**
   * Department/global shared-memory graphs the caller may read (`shared-memory`
   * under the caller's own department chain and the global scope).
   *
   * This is a separate seam from {@link loadGraphs} so the guardian pass keeps its
   * existing graph scope: shared memory is runtime context, not a graph to bind.
   */
  loadSharedGraphs?(viewer: GraphViewer): Promise<LoadedGraph[]>
  /** Whether the caller holds the memory-management capability (`kb:config:manage`). */
  canManage(viewer: GraphViewer): Promise<boolean> | boolean
  /** Whether personal memory is enabled for this caller; a paused user gets no personal entries. */
  isMemoryEnabled?(viewer: GraphViewer): Promise<boolean> | boolean
}

/** Result of one `memory_context` call. */
export interface MemoryContextToolResult {
  ok: true
  format: 'markdown' | 'json'
  rendered: string
  context: MemoryContextResult
  /** True when the user paused memory; only non-personal policy/redlines remain. */
  paused?: boolean
}

/** Per-graph guardian outcome. */
export interface MemoryGuardianGraphResult extends GuardianResult {
  graphId: string
}

/** Result of one `memory_guardian_run` call. */
export interface MemoryGuardianToolResult {
  ok: true
  userId: string
  runAt: string
  graphs: MemoryGuardianGraphResult[]
  totals: GuardianResult
  note?: string
}

const ZERO_GUARDIAN_RESULT: GuardianResult = {
  createdPending: 0,
  subscribed: 0,
  internalized: 0,
  rejectedRedline: 0,
  upstreamUpdates: 0,
  revoked: 0,
}

/**
 * Canonical output renderer shared by the tools: prefer the `rendered` text the
 * tool prepared (markdown or JSON), fall back to pretty JSON.
 */
const textOutput = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => {
    const record = value as { rendered?: unknown } | null
    const text = record !== null && typeof record?.rendered === 'string'
      ? record.rendered
      : JSON.stringify(value, null, 2)
    return [{ type: 'text' as const, text }]
  },
}

// The tool registry types a canonical result as `Record<string, JsonValue>`.
// The runtime memory results are plain JSON-shaped objects; `any` keeps their
// named interfaces (used by the Host and the tests) without an index signature.
const run = async (operation: () => Promise<Record<string, any>>): Promise<Record<string, any>> => {
  try {
    return await operation()
  } catch (error) {
    throw asKnowledgeToolError(error)
  }
}

/** Build the read-only `memory_context` tool. */
function createMemoryContextTool(host: MemoryToolHost): ToolDefinition {
  return defineTool({
    name: 'memory_context',
    description: 'Read the caller\'s memory context. Returns the caller\'s own remembered preferences, pitfalls, '
      + 'facts, methods and recent episodic memory from the memory store, approved department/global shared memory '
      + 'published for the caller\'s department (privacy normal/private only), live proxies for subscribed '
      + 'department/global memory sources, the caller\'s own internalized branches (marked stale/revoked when they '
      + 'diverged), and redline policy entries marked nonOverridable. Permission-denied graphs are omitted and other '
      + 'users\' memory or other departments\' shared memory is never read. Ordering is deterministic and a character '
      + 'budget drops shared/advisory and personal history before canonical or redline entries; redlines are never '
      + 'dropped. When personal memory is paused, personal entries and internalized copies are omitted but '
      + 'department/global policy, shared memory and redlines still apply. Read-only: this tool never writes bindings '
      + 'or documents.',
    parameters: {
      format: { type: 'string', description: 'markdown (default) or json.' },
      maxChars: {
        type: 'number',
        description: `Prompt budget in characters; default ${DEFAULT_MEMORY_CONTEXT_MAX_CHARS}.`,
      },
    },
    output: textOutput,
    execute: async (args: { format?: string; maxChars?: number }) => run(async () => {
      const viewer = await host.resolveCaller()
      const enabled = host.isMemoryEnabled === undefined ? true : await host.isMemoryEnabled(viewer)
      const allGraphs = await host.loadGraphs(viewer)
      // Shared memory is published by the department/global scope, not learned by
      // the user; pausing personal memory does not remove it (design §22.2 keeps
      // department/global policy while personal memory is off).
      // A shared-memory read failure must not hide department/global redlines or
      // the caller's own memory: fail soft to an empty shared set.
      const sharedGraphs = host.loadSharedGraphs === undefined
        ? []
        : await host.loadSharedGraphs(viewer).catch(() => [])
      // Pausing personal memory drops personal graphs, personal internalized
      // branches and the personal store root. Department/global subscriptions and
      // shared memory remain, so a redline still applies (design §22.2).
      const graphs = enabled
        ? [...allGraphs, ...sharedGraphs]
        : [
            ...allGraphs.filter(graph => {
              const scope = graph.manifest.scope ?? ''
              return scope !== 'personal' && !scope.startsWith('personal:')
            }),
            ...sharedGraphs,
          ]
      const personalMemoryRoot = enabled ? host.personalMemoryRoot?.(viewer) : undefined
      const context = await resolveMemoryContext({
        viewer,
        usersRoot: host.usersRoot,
        userId: viewer.userId,
        graphs,
        ...(enabled ? {} : { paused: true }),
        ...(personalMemoryRoot === undefined ? {} : { personalMemoryRoot }),
        ...(args.maxChars === undefined ? {} : { maxChars: args.maxChars }),
      })
      const format: 'markdown' | 'json' = args.format === 'json' ? 'json' : 'markdown'
      const pausedNote = enabled
        ? ''
        : 'Personal memory is paused. Personal memories are not used; department/global policy and redlines still apply.\n\n'
      const rendered = format === 'json'
        ? JSON.stringify({ ...context, ...(enabled ? {} : { paused: true }) }, null, 2)
        : pausedNote + renderMemoryContextMarkdown(context)
      return { ok: true as const, format, rendered, context, ...(enabled ? {} : { paused: true }) }
    }),
  })
}

/** Build the manage-gated `memory_guardian_run` tool. */
function createMemoryGuardianRunTool(host: MemoryToolHost): ToolDefinition {
  return defineTool({
    name: 'memory_guardian_run',
    description: 'Run the personal memory guardian pass for the caller. It discovers new graph nodes/edges, resolves '
      + 'pending bindings, performs requested internalizations, refreshes sourceVersion/sourceCommit and revokes '
      + 'internalized branches whose source became redline. It writes only under the caller\'s bindings/memory root and '
      + 'only for graphs the caller may manage. Requires the kb:config:manage capability; the scheduled guardian job is '
      + 'the normal trigger, this tool is the manual operator path.',
    parameters: {},
    output: textOutput,
    execute: async () => run(async () => {
      const viewer = await host.resolveCaller()
      if (viewer.userId.trim() === '') {
        throw new KnowledgeToolError('unauthorized', 'an authenticated caller is required')
      }
      if (!await host.canManage(viewer)) {
        throw new KnowledgeToolError('forbidden', 'memory_guardian_run requires the kb:config:manage capability')
      }

      const graphs = await host.loadGraphs(viewer)
      const manageable = graphs.filter(graph => canManageGraph(viewer, graphScopeDescriptor(graph.manifest)))
      const runAt = new Date().toISOString()
      const results: MemoryGuardianGraphResult[] = []
      const totals: GuardianResult = { ...ZERO_GUARDIAN_RESULT }

      for (const graph of manageable) {
        const result = await runGuardianPass({
          graph,
          usersRoot: host.usersRoot,
          userIds: [viewer.userId],
          ...(viewer.departmentCode === undefined ? {} : { departmentCode: viewer.departmentCode }),
          now: runAt,
        })
        results.push({ graphId: graph.manifest.id, ...result })
        totals.createdPending += result.createdPending
        totals.subscribed += result.subscribed
        totals.internalized += result.internalized
        totals.rejectedRedline += result.rejectedRedline
        totals.upstreamUpdates += result.upstreamUpdates
        totals.revoked += result.revoked
      }

      const response: MemoryGuardianToolResult = {
        ok: true,
        userId: viewer.userId,
        runAt,
        graphs: results,
        totals,
      }
      if (manageable.length === 0) {
        response.note = 'no readable graph is manageable for this caller; nothing was run'
      }
      // The rendered text is JSON: operators want the exact counters.
      return { ...response, rendered: JSON.stringify(response, null, 2) }
    }),
  })
}

/**
 * Build both runtime memory tools.
 *
 * @param host - the injected caller/graph/root seam.
 * @returns Tool definitions for the disclosure coordinator.
 */
export function createMemoryTools(host: MemoryToolHost): ToolDefinition[] {
  return [createMemoryContextTool(host), createMemoryGuardianRunTool(host)]
}
