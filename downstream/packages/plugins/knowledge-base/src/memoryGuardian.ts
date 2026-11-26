/**
 * The guardian pass for personal memory bindings.
 *
 * The guardian is the single writer of binding files. It does three things:
 *
 * 1. **Discovery** - every graph node/edge that a user has never seen gets a
 *    `pending` binding. The pass then resolves each pending binding: the safe
 *    default is `subscribe` (a live proxy; nothing is copied), while an
 *    explicit `requestedMode: 'internalize'` request is executed as a personal
 *    copy under `<usersRoot>/<userId>/memory/<graphId>/<sourceId>.md`.
 * 2. **Upstream tracking** - `markUpstreamUpdates()` advances `sourceVersion` /
 *    `sourceCommit`; subscribed proxies stay live and internalized branches
 *    become `stale` without their local body being overwritten.
 * 3. **Redline enforcement** - a redline (or `internalizable: false`) source
 *    cannot be copied. A pending internalize request is rejected and downgraded
 *    to a proxy; an already internalized branch is revoked. Edges inherit the
 *    policy of both endpoints, so one redline endpoint is enough to reject the
 *    relation.
 *
 * Input types are structural (`GuardianGraph`, below) rather than imports from
 * `graphModel.ts`, so this module can be implemented and tested before the
 * loader lands. The expected shape is the `LoadedGraph` contract:
 *
 * ```text
 * graph.root                       scope root; node `path` and edge `docPath`
 *                                  are relative to it (a graph-directory root
 *                                  `<scope>/.graphs/<id>` is also accepted)
 * graph.manifest.id               graph id
 * graph.manifest.version          business version
 * graph.manifest.status           draft | published | archived
 * graph.manifest.scope            global | department:<code>
 * graph.commit                    optional published git commit
 * graph.nodes[]                   { id, path, type?, title?, authority?,
 *                                   internalizable?, origin?, reviewStatus?,
 *                                   tags?, sourceRefs?, missing? }
 * graph.edges[]                   { id, from, to, docPath?, ...same attributes }
 * ```
 *
 * Nothing here reads global configuration; every path is injected.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-guardian
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  BindingStore,
  bindingKey,
  memoryFilePath,
  memoryRelativePath,
  stringifySimpleYaml,
  writeFileAtomic,
  type BindingSourceType,
  type PersonalBinding,
  type YamlRecord,
} from './memoryBindings.ts'

/** Node/edge authority, mirroring `graphModel.ts`. */
export type MemoryAuthority = 'canonical' | 'advisory' | 'redline'
/** Where the content came from. */
export type MemoryOrigin = 'human' | 'ai' | 'mixed'
/** Human review state. */
export type MemoryReviewStatus = 'draft' | 'reviewed' | 'approved'

/** A node as the guardian needs to see it. Attributes are optional; the loader defaults them. */
export interface GuardianSourceNode {
  id: string
  path: string
  type?: string
  title?: string
  authority?: MemoryAuthority
  internalizable?: boolean
  origin?: MemoryOrigin
  reviewStatus?: MemoryReviewStatus
  tags?: string[]
  sourceRefs?: string[]
  missing?: boolean
}

/** A relation. `docPath` points at the optional relation document in `.graphs/<id>/links/`. */
export interface GuardianSourceEdge {
  id: string
  from: string
  to: string
  docPath?: string
  type?: string
  title?: string
  authority?: MemoryAuthority
  internalizable?: boolean
  origin?: MemoryOrigin
  reviewStatus?: MemoryReviewStatus
  tags?: string[]
  sourceRefs?: string[]
  missing?: boolean
}

/** The manifest fields the guardian reads. Extra manifest fields are ignored. */
export interface GuardianGraphManifest {
  schemaVersion?: number
  id: string
  name?: string
  description?: string
  scope?: string
  version: number
  status?: string
  owner?: string
  createdAt?: string
  updatedAt?: string
  publishedAt?: string
  tags?: string[]
  visibility?: string
  commit?: string
  sourceCommit?: string
}

/** Structural stand-in for `LoadedGraph`. */
export interface GuardianGraph {
  manifest: GuardianGraphManifest
  root: string
  nodes: GuardianSourceNode[]
  edges: GuardianSourceEdge[]
  /** Published git commit for this graph version, when the caller has one. */
  commit?: string
}

/** Input for one guardian pass. */
export interface GuardianPassInput {
  graph: GuardianGraph
  usersRoot: string
  userIds: string[]
  /**
   * When provided, a `department:<code>` graph is only processed for that
   * department. `global` graphs and graphs without a department scope are
   * always eligible. The caller resolves the user's department.
   */
  departmentCode?: string
  /** Injectable clock for deterministic tests. Defaults to `new Date().toISOString()`. */
  now?: string
}

/** Input for a pure upstream-version pass. */
export interface MarkUpstreamUpdatesInput {
  graph: GuardianGraph
  usersRoot: string
  userIds: string[]
  /** Injectable clock used for `updatedAt` in tests. */
  now?: string
}

/** Counters returned by a guardian pass. */
export interface GuardianResult {
  /** Bindings created as `pending` during discovery (resolved in the same pass). */
  createdPending: number
  /** Bindings that ended up as a live `subscribe` proxy. */
  subscribed: number
  /** Bindings that copied a body into the personal memory tree. */
  internalized: number
  /** Internalize requests refused because of redline / `internalizable: false`. */
  rejectedRedline: number
  /** Bindings whose `sourceVersion` was refreshed (subscribe, pending, stale). */
  upstreamUpdates: number
  /** Previously internalized branches revoked after a redline upgrade. */
  revoked: number
}

interface SourcePolicy {
  authority: MemoryAuthority
  internalizable: boolean
  /** Both endpoints of an edge are present in the loaded graph. */
  endpointsPresent: boolean
}

const AUTHORITY_RANK: Record<MemoryAuthority, number> = { advisory: 0, canonical: 1, redline: 2 }

/**
 * Run one guardian pass: refresh versions, discover new sources for every
 * user, resolve pending bindings (nodes before edges so a relation can be
 * internalized in the same pass as its endpoints), and revoke branches whose
 * source became redline or non-internalizable.
 */
export async function runGuardianPass(input: GuardianPassInput): Promise<GuardianResult> {
  const result: GuardianResult = {
    createdPending: 0,
    subscribed: 0,
    internalized: 0,
    rejectedRedline: 0,
    upstreamUpdates: 0,
    revoked: 0,
  }

  const graph = input.graph
  if (!graph?.manifest?.id || typeof graph.manifest.version !== 'number') {
    throw new Error('memory-guardian: graph.manifest.id and graph.manifest.version are required')
  }
  if (graph.manifest.status === 'draft' || graph.manifest.status === 'archived') return result
  if (!eligibleForDepartment(graph.manifest.scope, input.departmentCode)) return result

  const now = input.now ?? new Date().toISOString()
  const version = graph.manifest.version
  const commit = sourceCommitOf(graph)
  const graphId = graph.manifest.id
  const users = [...new Set(input.userIds)]

  result.upstreamUpdates += await markUpstreamUpdates({ graph, usersRoot: input.usersRoot, userIds: users, now })

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]))

  for (const userId of users) {
    const store = new BindingStore(input.usersRoot)
    const existing = await store.list(userId)
    const known = new Set(existing.map((binding) => bindingKey(binding.sourceType, binding.sourceId)))

    // 1. Discovery: a source this user has never seen becomes pending. Pending
    //    is resolved in the same pass below, so new sources default to a live
    //    proxy and never accumulate as an unresolved queue.
    for (const node of graph.nodes) {
      if (node.missing === true) continue
      if (known.has(bindingKey('node', node.id))) continue
      await store.set(newPendingBinding(userId, 'node', node.id, graphId, version, commit, now))
      result.createdPending += 1
    }
    for (const edge of graph.edges) {
      if (edge.missing === true) continue
      if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue
      if (known.has(bindingKey('edge', edge.id))) continue
      await store.set(newPendingBinding(userId, 'edge', edge.id, graphId, version, commit, now))
      result.createdPending += 1
    }

    // 2. Pending nodes first; internalizing an edge requires its endpoints to
    //    be internalized already or in this same pass.
    const withNodes = await store.list(userId)
    for (const binding of withNodes) {
      if (binding.mode !== 'pending' || binding.sourceType !== 'node') continue
      const node = nodeById.get(binding.sourceId)
      if (!node) continue
      await resolvePendingNode({ store, usersRoot: input.usersRoot, binding, node, graph, version, commit, now, result })
    }

    // 3. Pending edges, checked against the binding state written above.
    const afterNodes = await store.list(userId)
    const bindingsByKey = new Map(afterNodes.map((binding) => [bindingKey(binding.sourceType, binding.sourceId), binding]))
    for (const binding of afterNodes) {
      if (binding.mode !== 'pending' || binding.sourceType !== 'edge') continue
      const edge = edgeById.get(binding.sourceId)
      if (!edge) continue
      await resolvePendingEdge({ store, usersRoot: input.usersRoot, binding, edge, nodeById, bindingsByKey, graph, version, commit, now, result })
    }

    // 4. Revoke internalized branches whose source is now redline or no longer
    //    internalizable. The local body is deliberately left on disk: revoking
    //    hides the branch, it does not destroy the user's edits.
    for (const binding of await store.list(userId)) {
      if (binding.mode !== 'internalize' || binding.status === 'revoked') continue
      if (binding.graphId !== graphId) continue
      const policy = policyForBinding(binding, nodeById, edgeById)
      if (!policy) continue
      if (policy.authority !== 'redline' && policy.internalizable) continue

      binding.mode = 'subscribe'
      binding.status = 'revoked'
      binding.sourceVersion = version
      setCommit(binding, commit)
      binding.updatedAt = now
      delete binding.requestedMode
      const proxy = proxyPathFor(binding, nodeById, edgeById, graph.root)
      if (proxy !== undefined) binding.localPath = proxy
      else delete binding.localPath
      // Keep lineage: it records what the branch was forked from.
      await store.set(binding)
      result.revoked += 1
    }
  }

  return result
}

/**
 * Advance `sourceVersion` / `sourceCommit` for every binding of this graph.
 *
 * - `subscribe` and `pending` stay active and immediately follow the graph;
 * - `internalize` becomes `stale`, keeps its local body untouched, and will not
 *   follow the source again until the user explicitly re-forks;
 * - `revoked` bindings are left alone.
 *
 * Returns the number of bindings that moved to a newer version.
 */
export async function markUpstreamUpdates(input: MarkUpstreamUpdatesInput): Promise<number> {
  const graph = input.graph
  if (!graph?.manifest?.id || typeof graph.manifest.version !== 'number') {
    throw new Error('memory-guardian: graph.manifest.id and graph.manifest.version are required')
  }
  const version = graph.manifest.version
  const commit = sourceCommitOf(graph)
  const now = input.now ?? new Date().toISOString()
  const users = [...new Set(input.userIds)]
  let updated = 0

  for (const userId of users) {
    const store = new BindingStore(input.usersRoot)
    for (const binding of await store.list(userId)) {
      if (binding.graphId !== graph.manifest.id) continue
      if (binding.status === 'revoked') continue
      if (binding.sourceVersion >= version) continue

      binding.sourceVersion = version
      setCommit(binding, commit)
      binding.updatedAt = now
      if (binding.mode === 'internalize') binding.status = 'stale'
      await store.set(binding)
      updated += 1
    }
  }

  return updated
}

// ---------------------------------------------------------------------------
// Pending resolution
// ---------------------------------------------------------------------------

interface ResolveContext {
  store: BindingStore
  usersRoot: string
  graph: GuardianGraph
  version: number
  commit: string | undefined
  now: string
  result: GuardianResult
}

async function resolvePendingNode(
  context: ResolveContext & { binding: PersonalBinding; node: GuardianSourceNode },
): Promise<void> {
  const { store, usersRoot, binding, node, graph, version, commit, now, result } = context
  const policy = policyForNode(node)
  const graphId = graph.manifest.id

  if (binding.requestedMode === 'internalize') {
    if (policy.authority === 'redline' || !policy.internalizable) {
      result.rejectedRedline += 1
      // The rejected request still leaves the only permitted representation:
      // a live proxy. A node without a resolvable path keeps a proxy with no
      // localPath instead of staying pending forever.
      applyProxy(binding, toGraphRelative(graph.root, node.path), version, commit, now)
      await store.set(binding)
      result.subscribed += 1
      return
    }
    if (node.missing === true) return

    const sourceFile = await resolveSourceFile(graph.root, node.path)
    if (!sourceFile) return // leave pending; the loader said the body is there but it is not readable yet

    const source = await readFile(sourceFile, 'utf8')
    const fields = nodeFrontMatter(node, policy, graphId, version, commit, now)
    const localPath = await internalizeDocument(usersRoot, binding.userId, graphId, node.id, fields, splitFrontMatter(source).body)

    binding.mode = 'internalize'
    binding.status = 'active'
    binding.localPath = localPath
    binding.sourceVersion = version
    setCommit(binding, commit)
    binding.lineage = {
      ...binding.lineage,
      forkedFromVersion: version,
      forkedAt: now,
      divergence: binding.lineage.divergence ?? [],
    }
    binding.updatedAt = now
    delete binding.requestedMode
    await store.set(binding)
    result.internalized += 1
    return
  }

  // Default resolution: live proxy. No body is copied and the runtime reads the
  // department document through `localPath`.
  const proxy = toGraphRelative(graph.root, node.path)
  if (proxy === undefined) return
  applyProxy(binding, proxy, version, commit, now)
  await store.set(binding)
  result.subscribed += 1
}

async function resolvePendingEdge(
  context: ResolveContext & {
    binding: PersonalBinding
    edge: GuardianSourceEdge
    nodeById: Map<string, GuardianSourceNode>
    bindingsByKey: Map<string, PersonalBinding>
  },
): Promise<void> {
  const { store, usersRoot, binding, edge, nodeById, bindingsByKey, graph, version, commit, now, result } = context
  const policy = policyForEdge(edge, nodeById)
  const graphId = graph.manifest.id

  if (binding.requestedMode === 'internalize') {
    if (policy.authority === 'redline' || !policy.internalizable) {
      result.rejectedRedline += 1
      // Topology-only relations have no docPath; they still become a proxy.
      applyProxy(binding, edgeProxyPath(graph.root, edge), version, commit, now)
      await store.set(binding)
      result.subscribed += 1
      return
    }
    // A relation is only as internal as its endpoints: both must already be
    // internalized (or have been internalized earlier in this same pass).
    if (!policy.endpointsPresent || !endpointsInternalized(edge, bindingsByKey)) return
    if (edge.missing === true) return

    const body = await readSourceBody(graph.root, edge.docPath)
    if (body === undefined) return // a declared relation doc that cannot be read stays pending

    const fields = edgeFrontMatter(edge, policy, graphId, version, commit, now)
    const localPath = await internalizeDocument(usersRoot, binding.userId, graphId, edge.id, fields, body)

    binding.mode = 'internalize'
    binding.status = 'active'
    binding.localPath = localPath
    binding.sourceVersion = version
    setCommit(binding, commit)
    binding.lineage = {
      ...binding.lineage,
      forkedFromVersion: version,
      forkedAt: now,
      divergence: binding.lineage.divergence ?? [],
    }
    binding.updatedAt = now
    delete binding.requestedMode
    await store.set(binding)
    result.internalized += 1
    return
  }

  const proxy = edgeProxyPath(graph.root, edge)
  applyProxy(binding, proxy, version, commit, now)
  await store.set(binding)
  result.subscribed += 1
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

function policyForNode(node: GuardianSourceNode): SourcePolicy {
  return {
    authority: node.authority ?? 'advisory',
    internalizable: node.internalizable !== false,
    endpointsPresent: true,
  }
}

/**
 * An edge inherits endpoint policy: redline/`internalizable:false` on either
 * endpoint applies to the relation, and a missing endpoint blocks copying.
 */
function policyForEdge(edge: GuardianSourceEdge, nodeById: Map<string, GuardianSourceNode>): SourcePolicy {
  let authority = edge.authority ?? 'advisory'
  let internalizable = edge.internalizable !== false
  let endpointsPresent = true
  for (const id of [edge.from, edge.to]) {
    const endpoint = nodeById.get(id)
    if (!endpoint) {
      endpointsPresent = false
      continue
    }
    const endpointAuthority = endpoint.authority ?? 'advisory'
    if (AUTHORITY_RANK[endpointAuthority] > AUTHORITY_RANK[authority]) authority = endpointAuthority
    if (endpoint.internalizable === false) internalizable = false
  }
  return { authority, internalizable, endpointsPresent }
}

function policyForBinding(
  binding: PersonalBinding,
  nodeById: Map<string, GuardianSourceNode>,
  edgeById: Map<string, GuardianSourceEdge>,
): SourcePolicy | undefined {
  if (binding.sourceType === 'node') {
    const node = nodeById.get(binding.sourceId)
    return node ? policyForNode(node) : undefined
  }
  const edge = edgeById.get(binding.sourceId)
  return edge ? policyForEdge(edge, nodeById) : undefined
}

function endpointsInternalized(edge: GuardianSourceEdge, bindingsByKey: Map<string, PersonalBinding>): boolean {
  for (const endpointId of [edge.from, edge.to]) {
    const binding = bindingsByKey.get(bindingKey('node', endpointId))
    if (!binding) return false
    if (binding.mode !== 'internalize') return false
    if (binding.status === 'revoked') return false
    if (!binding.localPath) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Binding mutation helpers
// ---------------------------------------------------------------------------

function newPendingBinding(
  userId: string,
  sourceType: BindingSourceType,
  sourceId: string,
  graphId: string,
  version: number,
  commit: string | undefined,
  now: string,
): PersonalBinding {
  const binding: PersonalBinding = {
    userId,
    sourceType,
    sourceId,
    graphId,
    mode: 'pending',
    sourceVersion: version,
    lineage: {},
    status: 'active',
    updatedAt: now,
  }
  if (commit !== undefined) binding.sourceCommit = commit
  return binding
}

function applyProxy(
  binding: PersonalBinding,
  localPath: string | undefined,
  version: number,
  commit: string | undefined,
  now: string,
): void {
  binding.mode = 'subscribe'
  binding.status = 'active'
  binding.sourceVersion = version
  setCommit(binding, commit)
  binding.updatedAt = now
  binding.lineage = { ...binding.lineage, subscribedAt: binding.lineage.subscribedAt ?? now }
  if (localPath !== undefined) binding.localPath = localPath
  else delete binding.localPath
  delete binding.requestedMode
}

function setCommit(binding: PersonalBinding, commit: string | undefined): void {
  if (commit !== undefined) binding.sourceCommit = commit
  else delete binding.sourceCommit
}

function toGraphRelative(root: string, path: string | undefined): string | undefined {
  if (path === undefined || path === '') return undefined
  if (!isAbsolute(path)) {
    const normalized = path.replace(/^\.\//, '')
    if (normalized.split('/').some((segment) => segment === '..' || segment === '')) return undefined
    return normalized
  }
  const absoluteRoot = resolve(root)
  const absolutePath = resolve(path)
  const rel = relative(absoluteRoot, absolutePath)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel.split(sep).join('/')
}

function edgeProxyPath(root: string, edge: GuardianSourceEdge): string | undefined {
  return toGraphRelative(root, edge.docPath)
}

function proxyPathFor(
  binding: PersonalBinding,
  nodeById: Map<string, GuardianSourceNode>,
  edgeById: Map<string, GuardianSourceEdge>,
  root: string,
): string | undefined {
  if (binding.sourceType === 'node') {
    const node = nodeById.get(binding.sourceId)
    return node ? toGraphRelative(root, node.path) : undefined
  }
  const edge = edgeById.get(binding.sourceId)
  return edge ? edgeProxyPath(root, edge) : undefined
}

// ---------------------------------------------------------------------------
// Internalized document
// ---------------------------------------------------------------------------

async function readSourceBody(root: string, docPath: string | undefined): Promise<string | undefined> {
  if (docPath === undefined || docPath === '') return '' // topology-only relation: no body to copy
  const sourceFile = await resolveSourceFile(root, docPath)
  if (!sourceFile) return undefined
  const source = await readFile(sourceFile, 'utf8')
  return splitFrontMatter(source).body
}

async function internalizeDocument(
  usersRoot: string,
  userId: string,
  graphId: string,
  sourceId: string,
  fields: YamlRecord,
  body: string,
): Promise<string> {
  const target = memoryFilePath(usersRoot, userId, graphId, sourceId)
  // A pending binding may be retried after a crash between the copy and the
  // binding write. Never overwrite an existing personal body: the user may
  // already have edited it.
  if (!(await fileExists(target))) {
    const normalizedBody = body === '' || body.endsWith('\n') ? body : `${body}\n`
    const content = `---\n${stringifySimpleYaml(fields)}---\n${normalizedBody}`
    await writeFileAtomic(target, content, { mode: 0o600 })
  }
  return memoryRelativePath(graphId, sourceId)
}

function nodeFrontMatter(node: GuardianSourceNode, policy: SourcePolicy, graphId: string, version: number, commit: string | undefined, now: string): YamlRecord {
  const fields: YamlRecord = {
    id: node.id,
    type: node.type ?? 'fact',
    title: node.title ?? node.id,
    authority: policy.authority,
    internalizable: policy.internalizable,
    origin: node.origin ?? 'human',
    reviewStatus: node.reviewStatus ?? 'draft',
    tags: node.tags ?? [],
    sourceRefs: node.sourceRefs ?? [],
    sourceGraph: graphId,
    sourceType: 'node',
    sourceVersion: version,
  }
  if (commit !== undefined) fields.sourceCommit = commit
  fields.forkedAt = now
  return fields
}

function edgeFrontMatter(edge: GuardianSourceEdge, policy: SourcePolicy, graphId: string, version: number, commit: string | undefined, now: string): YamlRecord {
  const fields: YamlRecord = {
    id: edge.id,
    type: edge.type ?? 'relates_to',
    title: edge.title ?? `${edge.from} -> ${edge.to}`,
    authority: policy.authority,
    internalizable: policy.internalizable,
    origin: edge.origin ?? 'human',
    reviewStatus: edge.reviewStatus ?? 'draft',
    tags: edge.tags ?? [],
    sourceRefs: edge.sourceRefs ?? [],
    from: edge.from,
    to: edge.to,
    sourceGraph: graphId,
    sourceType: 'edge',
    sourceVersion: version,
  }
  if (commit !== undefined) fields.sourceCommit = commit
  fields.forkedAt = now
  return fields
}

/** Split a Markdown document into its frontmatter block and body. */
export function splitFrontMatter(source: string): { frontMatter: string | null; body: string } {
  const lines = source.split('\n')
  if ((lines[0] ?? '').trim() !== '---') return { frontMatter: null, body: source }
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      return {
        frontMatter: lines.slice(1, index).join('\n'),
        body: lines.slice(index + 1).join('\n'),
      }
    }
  }
  return { frontMatter: null, body: source }
}

// ---------------------------------------------------------------------------
// File/path helpers
// ---------------------------------------------------------------------------

async function resolveSourceFile(root: string, path: string): Promise<string | undefined> {
  if (path === '') return undefined
  const candidates: string[] = []
  if (isAbsolute(path)) {
    candidates.push(path)
  } else {
    if (path.split('/').some((segment) => segment === '..')) return undefined
    // `root` is normally the scope root. When a caller passes the graph
    // directory instead (`<scope>/.graphs/<id>`), the same relative node path
    // still resolves two levels up.
    candidates.push(join(root, path))
    candidates.push(join(root, '..', '..', path))
  }
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function sourceCommitOf(graph: GuardianGraph): string | undefined {
  return graph.commit ?? graph.manifest.commit ?? graph.manifest.sourceCommit
}

function eligibleForDepartment(scope: string | undefined, departmentCode: string | undefined): boolean {
  if (departmentCode === undefined || departmentCode.trim() === '') return true
  if (scope === undefined || scope === '' || scope === 'global') return true
  if (!scope.startsWith('department:')) return true
  return scope.slice('department:'.length) === departmentCode
}
