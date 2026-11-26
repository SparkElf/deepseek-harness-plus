/**
 * Runtime memory context: what the model may see from one user's personal graph.
 *
 * The personal graph is a projection, not a second copy:
 *
 * - a `subscribe` binding is resolved LIVE from the current department/global
 *   graph. The resolver reads the document body from disk on every call and
 *   prefers the live frontmatter, so a published change reaches the model
 *   without waiting for the guardian or for a binding refresh;
 * - an `internalize` binding is read from the user's own branch at
 *   `<usersRoot>/<userId>/memory/<graphId>/<sourceId>.md`. That branch does not
 *   follow the source; `stale` / `revoked` come from the binding so the runtime
 *   can down-rank or hide it;
 * - visibility is decided per graph through `canViewGraph`. A graph, node or
 *   edge the viewer cannot see is omitted, never partially projected;
 * - approved department/global shared memory (`记忆共享/` + `shared-memory`
 *   graph) is read directly. It needs no binding; it stays advisory and yields
 *   to redline/canonical entries;
 * - redlines are marked `nonOverridable` with an explicit marker. The character
 *   budget drops advisory material first and never drops a redline;
 * - pausing personal memory removes the caller's own store and internalized
 *   branches, not department/global policy or shared memory.
 *
 * Ordering is deterministic (priority tier, graph id, source type, source id),
 * so two identical inputs produce the same prompt prefix.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-context
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { GraphManifest, LoadedGraph, MemoryAuthority, MemoryOrigin, MemoryReviewStatus } from './graphModel.ts'
import { canViewGraph, type GraphScopeDescriptor, type GraphViewer } from './graphPolicy.ts'
import {
  BindingStore,
  memoryFilePath,
  parseSimpleYaml,
  type BindingSourceType,
  type BindingStatus,
  type PersonalBinding,
} from './memoryBindings.ts'
import { MemoryStore, type ListedMemoryEntry } from './memoryStore.ts'
import { memoryEntryContent, memoryEntryTitle, memoryEntryUpdatedAt } from './memoryDisplay.ts'
import { PERSONAL_MEMORY_GRAPH_ID } from './memoryGraphWriter.ts'
import { readSharedMemoryCandidates, type SharedMemoryCandidate } from './memoryShared.ts'
import { SHARED_MEMORY_GRAPH_ID } from './memoryPromotion.ts'
import type { Privacy } from './memoryTypes.ts'
import { splitFrontMatter } from './memoryGuardian.ts'

/** Default prompt budget for the resolved context. */
export const DEFAULT_MEMORY_CONTEXT_MAX_CHARS = 8000

/** Marker the runtime must treat as above personal memory and preferences. */
export const SYSTEM_POLICY_MARKER = 'system policy overrides personal memory'

/**
 * How a memory entry reaches the personal graph.
 *
 * `personal` is the user's own `MemoryStore` snapshot (`偏好.md`, `踩坑.md`,
 * `事实.md`, `SOP/`, daily logs). It has no binding and no graph-side authority:
 * it is always advisory, so it can never outrank a department/global redline.
 *
 * `shared` is an approved department/global promotion read from the scope's
 * `记忆共享/` graph. It needs no binding either, but unlike personal memory it is
 * published policy-shaped content: still advisory, still below redline/canonical,
 * yet kept when the user pauses personal memory.
 */
export type MemoryContextMode = 'subscribe' | 'internalize' | 'personal' | 'shared'

/** Where one resolved context entry came from. */
export type MemoryContextSourceType = BindingSourceType | 'entry'

/** One resolved node/edge/memory the runtime may inject. */
export interface MemoryContextEntry {
  mode: MemoryContextMode
  graphId: string
  sourceType: MemoryContextSourceType
  sourceId: string
  title: string
  /** Node type, relation type, or memory type. */
  type: string
  authority: MemoryAuthority
  origin: MemoryOrigin
  reviewStatus: MemoryReviewStatus
  /** True for a redline (direct or inherited): personal memory must not override it. */
  nonOverridable: boolean
  /** Set together with `nonOverridable`. */
  policyNote?: string
  status: BindingStatus
  sourceVersion: number
  sourceCommit?: string
  /** Live source path for a proxy; personal branch path for an internalized copy. */
  path?: string
  /** Relation endpoints, when the source is an edge. */
  from?: string
  to?: string
  /** Personal-memory privacy label; absent on graph bindings. */
  privacy?: Privacy
  /** `global` or `department:<code>` for a shared-memory document. */
  scope?: string
  /** Last update of a personal entry; absent on graph bindings. */
  updatedAt?: string
  body: string
  /** Budget cost used by this resolver (title + body + fixed metadata overhead). */
  chars: number
}

/** One entry omitted only because the character budget ran out. */
export interface MemoryContextDrop {
  graphId: string
  sourceType: MemoryContextSourceType
  sourceId: string
  mode: MemoryContextMode
  chars: number
  reason: 'budget'
}

/** The resolver output. */
export interface MemoryContextResult {
  userId: string
  entries: MemoryContextEntry[]
  dropped: MemoryContextDrop[]
  charCount: number
  maxChars: number
  redlineCount: number
  /** Number of selected entries that came from the caller's own `MemoryStore`. */
  personalCount: number
  /** Number of selected entries read from a department/global `记忆共享/` graph. */
  sharedCount: number
  /** Non-empty when at least one redline is present. */
  systemPolicy: string
}

/** Resolver input. All roots and graphs are injected; no global config is read. */
export interface MemoryContextInput {
  viewer: GraphViewer
  usersRoot: string
  userId: string
  graphs: LoadedGraph[]
  /** Pre-read bindings, for callers that already listed them. Omit to rebuild from disk. */
  bindings?: PersonalBinding[]
  /**
   * Absolute root of the caller's own personal memory tree
   * (`<actualRoot>/personal/<userId>/个人记忆图谱`).
   *
   * The Host builds this from the authenticated user id; this resolver never
   * searches sibling user roots. Omit to keep bindings-only behavior (for
   * example a paused memory setting).
   */
  personalMemoryRoot?: string
  /**
   * Personal memory is paused for this caller.
   *
   * Design §22.2: pausing stops personal memory from influencing answers, but
   * department/global policy — and every redline — still applies. The resolver
   * therefore skips the caller's internalized branches and personal store while
   * keeping department/global subscriptions and shared memory.
   */
  paused?: boolean
  /** Prompt budget; defaults to {@link DEFAULT_MEMORY_CONTEXT_MAX_CHARS}. */
  maxChars?: number
}

interface DocumentText {
  frontMatter: string | null
  body: string
}

interface DocumentAttributes {
  title?: string
  type?: string
  authority?: MemoryAuthority
  origin?: MemoryOrigin
  reviewStatus?: MemoryReviewStatus
}

/** The fixed per-entry metadata overhead included in `chars`. */
const ENTRY_METADATA_CHARS = 32
const AUTHORITY_RANK: Record<MemoryAuthority, number> = { advisory: 0, canonical: 1, redline: 2 }
const AUTHORITIES: readonly MemoryAuthority[] = ['canonical', 'advisory', 'redline']
const ORIGINS: readonly MemoryOrigin[] = ['human', 'ai', 'mixed']
const REVIEW_STATUSES: readonly MemoryReviewStatus[] = ['draft', 'reviewed', 'approved']

/**
 * Adapt a loaded graph manifest to the visibility descriptor `canViewGraph`
 * expects. `scope` is the machine scope (`global`, `department:<code>`,
 * `personal:<uid>`); `owner` is the private-graph owner when present.
 */
export function graphScopeDescriptor(manifest: GraphManifest): GraphScopeDescriptor {
  const scope = manifest.scope ?? ''
  const departmentPrefix = 'department:'
  const personalPrefix = 'personal:'
  const departmentCode = scope.startsWith(departmentPrefix) ? scope.slice(departmentPrefix.length) : undefined
  const ownerId = manifest.visibility === 'private'
    ? manifest.owner ?? (scope.startsWith(personalPrefix) ? scope.slice(personalPrefix.length) : undefined)
    : undefined
  return { visibility: manifest.visibility, ownerId, departmentCode }
}

/**
 * Resolve the caller's personal memory context.
 *
 * @param input - viewer, roots, user id, loaded graphs and optional budget.
 * @returns Priority-ordered entries, budget drops and redline counters.
 */
export async function resolveMemoryContext(input: MemoryContextInput): Promise<MemoryContextResult> {
  const maxChars = normalizeMaxChars(input.maxChars)
  const graphById = new Map<string, LoadedGraph>()
  for (const graph of input.graphs) {
    if (!graphById.has(graph.manifest.id)) graphById.set(graph.manifest.id, graph)
  }

  const bindings = input.bindings ?? await new BindingStore(input.usersRoot).list(input.userId)
  const entries: MemoryContextEntry[] = []
  const bindingIds = new Set<string>()
  const bindingContent = new Set<string>()
  const paused = input.paused === true

  for (const binding of bindings) {
    if (binding.userId !== input.userId) continue
    if (binding.mode !== 'subscribe' && binding.mode !== 'internalize') continue
    // A paused user keeps department/global subscriptions (including redlines) but
    // loses every personal copy. The branch under `usersRoot/<uid>/memory/…` is
    // personal memory even when its source is a department document.
    if (paused && binding.mode === 'internalize') continue
    const graph = graphById.get(binding.graphId)
    if (graph === undefined) continue
    // Fail closed: an invisible graph contributes nothing, even if a binding exists.
    if (!canViewGraph(input.viewer, graphScopeDescriptor(graph.manifest))) continue

    const entry = binding.mode === 'subscribe'
      ? await resolveSubscribedEntry(binding, graph)
      : await resolveInternalizedEntry(binding, graph, input.usersRoot)
    if (entry === undefined) continue
    entries.push(entry)
    bindingIds.add(entry.sourceId)
    bindingContent.add(contentFingerprint(entry.title, entry.body))
  }

  // Department/global shared memory has no binding: a promotion publishes it for
  // the whole scope. It is read from the visible `shared-memory` graphs the Host
  // loaded (own department chain plus global), never by scanning sibling scopes.
  // Global and department shared graphs share the graph id, so identity is
  // scope + root rather than id.
  const seenSharedGraphs = new Set<string>()
  for (const graph of input.graphs) {
    const graphKey = `${graph.manifest.scope ?? ''}\u0000${graph.root}`
    if (seenSharedGraphs.has(graphKey)) continue
    if (!canViewGraph(input.viewer, graphScopeDescriptor(graph.manifest))) continue
    const candidates = await readSharedMemoryCandidates(graph)
    if (candidates.length === 0) continue
    seenSharedGraphs.add(graphKey)
    for (const candidate of candidates) {
      const fingerprint = contentFingerprint(candidate.title, candidate.body)
      if (bindingIds.has(candidate.id) || bindingContent.has(fingerprint)) continue
      bindingIds.add(candidate.id)
      bindingContent.add(fingerprint)
      entries.push(finalizeSharedEntry(candidate))
    }
  }

  // The caller's own `MemoryStore` is a second, binding-free source. It is read
  // only when the Host supplies the caller's root; a paused setting passes no
  // root, so personal memory stays out while department/global policy remains.
  const personalMemoryRoot = input.personalMemoryRoot?.trim() ?? ''
  if (!paused && personalMemoryRoot !== '') {
    entries.push(...await resolvePersonalMemoryEntries(personalMemoryRoot, bindingIds, bindingContent))
  }

  entries.sort(compareEntries)
  const selected: MemoryContextEntry[] = []
  const dropped: MemoryContextDrop[] = []
  let charCount = 0

  for (const entry of entries) {
    // A redline is never dropped. It may exceed the budget; correctness beats size.
    const protectedEntry = entry.nonOverridable || entry.authority === 'redline'
    if (!protectedEntry && charCount + entry.chars > maxChars) {
      dropped.push({
        graphId: entry.graphId,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        mode: entry.mode,
        chars: entry.chars,
        reason: 'budget',
      })
      continue
    }
    selected.push(entry)
    charCount += entry.chars
  }

  const redlineCount = selected.filter(entry => entry.nonOverridable).length
  const personalCount = selected.filter(entry => entry.mode === 'personal').length
  const sharedCount = selected.filter(entry => entry.mode === 'shared').length
  return {
    userId: input.userId,
    entries: selected,
    dropped,
    charCount,
    maxChars,
    redlineCount,
    personalCount,
    sharedCount,
    systemPolicy: redlineCount > 0 ? SYSTEM_POLICY_MARKER : '',
  }
}

/** Render a resolved context for a model-facing text tool result. */
export function renderMemoryContextMarkdown(result: MemoryContextResult): string {
  const lines: string[] = [
    `# Memory context (${result.userId})`,
    '',
    `- entries: ${result.entries.length}; chars: ${result.charCount}/${result.maxChars}; redlines: ${result.redlineCount}; personal: ${result.personalCount}; shared: ${result.sharedCount}`,
  ]
  if (result.systemPolicy !== '') lines.push(`- ${result.systemPolicy}`)

  for (const entry of result.entries) {
    const marker = entry.nonOverridable
      ? '[REDLINE] '
      : entry.mode === 'personal'
        ? '[PERSONAL] '
        : entry.mode === 'shared'
          ? '[SHARED] '
          : ''
    lines.push('', `## ${marker}${entry.title}`, '')
    if (entry.mode === 'personal') {
      // A personal entry has no binding, graph authority or source version. Show
      // only what the model needs to weigh it: type, privacy, and its document.
      lines.push(`- mode: personal; type: ${entry.type}; privacy: ${entry.privacy ?? 'private'}`)
      if (entry.path !== undefined) lines.push(`- path: ${entry.path}`)
    } else if (entry.mode === 'shared') {
      // A shared entry is published by the scope, not subscribed by the caller.
      // State where it applies and that it is still advisory.
      lines.push(`- mode: shared; scope: ${entry.scope ?? 'department'}; type: ${entry.type}; privacy: ${entry.privacy ?? 'normal'}`)
      lines.push(`- authority: ${entry.authority}; origin: ${entry.origin}; review: ${entry.reviewStatus}; source version: ${entry.sourceVersion}`)
      if (entry.path !== undefined) lines.push(`- path: ${entry.path}`)
    } else {
      lines.push(`- mode: ${entry.mode}; source: ${entry.sourceType} \`${entry.sourceId}\` in graph \`${entry.graphId}\``)
      lines.push(`- status: ${entry.status}; authority: ${entry.authority}; origin: ${entry.origin}; review: ${entry.reviewStatus}`)
      lines.push(`- source version: ${entry.sourceVersion}${entry.sourceCommit === undefined ? '' : ` (${entry.sourceCommit})`}`)
      if (entry.path !== undefined) lines.push(`- path: ${entry.path}`)
      if (entry.from !== undefined && entry.to !== undefined) lines.push(`- relation: ${entry.from} -> ${entry.to}`)
    }
    if (entry.nonOverridable) lines.push(`- ${SYSTEM_POLICY_MARKER}`)
    lines.push('', entry.body)
  }

  if (result.dropped.length > 0) {
    lines.push('', '## Dropped by budget')
    for (const drop of result.dropped) {
      lines.push(`- ${drop.mode} ${drop.sourceType} \`${drop.sourceId}\` in graph \`${drop.graphId}\` (${drop.chars} chars)`)
    }
  }

  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Entry resolution
// ---------------------------------------------------------------------------

async function resolveSubscribedEntry(
  binding: PersonalBinding,
  graph: LoadedGraph,
): Promise<MemoryContextEntry | undefined> {
  const graphId = graph.manifest.id
  const sourceVersion = graph.manifest.version
  const sourceCommit = graphCommit(graph) ?? binding.sourceCommit

  if (binding.sourceType === 'node') {
    const node = graph.nodes.find(candidate => candidate.id === binding.sourceId)
    if (node === undefined || node.missing) return undefined
    const document = await readGraphDocument(graph.root, node.path)
    if (document === undefined) return undefined
    const live = readDocumentAttributes(document.frontMatter)
    const title = live.title ?? node.title ?? node.id
    const body = document.body.trim()
    return finalizeEntry({
      mode: 'subscribe',
      graphId,
      sourceType: 'node',
      sourceId: node.id,
      title,
      type: live.type ?? node.type,
      authority: live.authority ?? node.authority,
      origin: live.origin ?? node.origin,
      reviewStatus: live.reviewStatus ?? node.reviewStatus,
      status: binding.status,
      sourceVersion,
      ...(sourceCommit === undefined ? {} : { sourceCommit }),
      path: node.path,
      body,
    })
  }

  const edge = graph.edges.find(candidate => candidate.id === binding.sourceId)
  if (edge === undefined || edge.missing) return undefined
  const from = graph.nodes.find(node => node.id === edge.from)
  const to = graph.nodes.find(node => node.id === edge.to)
  if (from === undefined || to === undefined) return undefined
  const document = await readGraphDocument(graph.root, edge.docPath)
  if (document === undefined) return undefined
  const live = readDocumentAttributes(document.frontMatter)
  // A relation inherits the stricter endpoint policy. The live frontmatter may
  // not downgrade an endpoint redline.
  const authority = strictestAuthority(live.authority ?? edge.authority, from.authority, to.authority)
  const body = document.body.trim()
  return finalizeEntry({
    mode: 'subscribe',
    graphId,
    sourceType: 'edge',
    sourceId: edge.id,
    title: live.title ?? edge.title ?? edge.id,
    type: live.type ?? edge.type,
    authority,
    origin: live.origin ?? edge.origin,
    reviewStatus: live.reviewStatus ?? edge.reviewStatus,
    status: binding.status,
    sourceVersion,
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
    ...(edge.docPath === undefined ? {} : { path: edge.docPath }),
    from: edge.from,
    to: edge.to,
    body,
  })
}

async function resolveInternalizedEntry(
  binding: PersonalBinding,
  graph: LoadedGraph,
  usersRoot: string,
): Promise<MemoryContextEntry | undefined> {
  let source: string
  try {
    source = await readFile(memoryFilePath(usersRoot, binding.userId, binding.graphId, binding.sourceId), 'utf8')
  } catch {
    // The binding points at a branch that is not on disk: fail closed.
    return undefined
  }

  const document = splitFrontMatter(source)
  const local = readDocumentAttributes(document.frontMatter)
  const current = currentSourcePolicy(binding, graph)

  // The branch content is the user's; its policy is the source's. A source that
  // became redline after the fork still makes every copy non-overridable.
  const authority = strictestAuthority(local.authority ?? 'advisory', current.authority)
  const body = document.body.trim()
  return finalizeEntry({
    mode: 'internalize',
    graphId: binding.graphId,
    sourceType: binding.sourceType,
    sourceId: binding.sourceId,
    title: local.title ?? current.title ?? binding.sourceId,
    type: local.type ?? current.type,
    authority,
    origin: local.origin ?? current.origin,
    reviewStatus: local.reviewStatus ?? current.reviewStatus,
    status: binding.status,
    sourceVersion: binding.sourceVersion,
    ...(binding.sourceCommit === undefined ? {} : { sourceCommit: binding.sourceCommit }),
    path: binding.localPath ?? `memory/${binding.graphId}/${binding.sourceId}.md`,
    ...(current.from === undefined ? {} : { from: current.from }),
    ...(current.to === undefined ? {} : { to: current.to }),
    body,
    nonOverridable: current.authority === 'redline',
  })
}

// ---------------------------------------------------------------------------
// Personal MemoryStore entries
// ---------------------------------------------------------------------------

/**
 * Privacy levels that may enter a model-facing context.
 *
 * The resolver only reads the caller's own root, so `normal` and `private` stay
 * owner-scoped. `sensitive` is deliberately excluded: the design says owner-only
 * *and* redacted in logs/telemetry, and a tool result is part of the session
 * transcript. `secret` is a credential pointer, not memory content; the model
 * does not need it. Both remain readable on the memory page.
 */
const CONTEXT_PRIVACY: ReadonlySet<Privacy> = new Set<Privacy>(['normal', 'private'])

/**
 * Resolve the caller's current `MemoryStore` entries as advisory context.
 *
 * Current aggregate snapshots and SOPs are the effective memory; daily-log
 * entries are included as episodic history but rank below the aggregates. An
 * entry that another entry `supersedes` is historical and is skipped, as is an
 * entry already represented by a binding.
 *
 * @param memoryRoot - the caller's own `<scope>/个人记忆图谱` directory.
 * @param bindingIds - source ids already resolved from bindings.
 * @param bindingContent - title+body fingerprints already resolved from bindings.
 */
async function resolvePersonalMemoryEntries(
  memoryRoot: string,
  bindingIds: ReadonlySet<string>,
  bindingContent: ReadonlySet<string>,
): Promise<MemoryContextEntry[]> {
  const store = new MemoryStore(memoryRoot)
  let listed: ListedMemoryEntry[]
  try {
    listed = await store.listEntries()
  } catch {
    // Fail soft: a broken personal tree must not hide department/global
    // redlines. The memory page still reports the parse issues.
    return []
  }

  // `listEntries` dedupes by id but keeps superseded history in daily logs. The
  // replacement names the old id, so drop the old value here.
  const superseded = new Set<string>()
  for (const entry of listed) {
    if (entry.supersedes !== undefined && entry.supersedes !== '') superseded.add(entry.supersedes)
  }

  const seenIds = new Set<string>(bindingIds)
  const seenContent = new Set<string>(bindingContent)
  const entries: MemoryContextEntry[] = []

  for (const entry of listed) {
    if (superseded.has(entry.id)) continue
    if (!CONTEXT_PRIVACY.has(entry.privacy)) continue
    // A promoted/dropped SOP is terminal and should not be re-injected.
    if (entry.type === 'sop' && (entry.status === 'dropped' || entry.status === 'promoted')) continue

    const title = memoryEntryTitle(entry)
    const body = personalEntryBody(entry)
    if (title.trim() === '' || body.trim() === '') continue

    const fingerprint = contentFingerprint(title, body)
    if (seenIds.has(entry.id) || seenContent.has(fingerprint)) continue
    seenIds.add(entry.id)
    seenContent.add(fingerprint)
    entries.push(finalizePersonalEntry(entry, title, body))
  }

  return entries
}

/** Map one store entry to the context shape; personal memory is always advisory. */
function finalizePersonalEntry(
  entry: ListedMemoryEntry,
  title: string,
  body: string,
): MemoryContextEntry {
  return {
    mode: 'personal',
    graphId: PERSONAL_MEMORY_GRAPH_ID,
    sourceType: 'entry',
    sourceId: entry.id,
    title,
    type: entry.type,
    authority: 'advisory',
    origin: entry.origin === 'explicit' ? 'mixed' : 'ai',
    reviewStatus: 'draft',
    status: 'active',
    sourceVersion: entry.type === 'sop' ? entry.version : 1,
    path: entry.path,
    privacy: entry.privacy,
    updatedAt: memoryEntryUpdatedAt(entry),
    body,
    nonOverridable: false,
    chars: title.length + body.length + ENTRY_METADATA_CHARS,
  }
}

/** Map one shared document to the context shape; the document keeps its authority. */
function finalizeSharedEntry(candidate: SharedMemoryCandidate): MemoryContextEntry {
  return {
    mode: 'shared',
    graphId: SHARED_MEMORY_GRAPH_ID,
    sourceType: 'node',
    sourceId: candidate.id,
    title: candidate.title,
    type: candidate.type,
    authority: candidate.authority,
    origin: candidate.origin,
    reviewStatus: candidate.reviewStatus,
    status: 'active',
    sourceVersion: candidate.version,
    path: candidate.path,
    privacy: candidate.privacy,
    scope: candidate.scope,
    body: candidate.body,
    nonOverridable: candidate.authority === 'redline',
    ...(candidate.authority === 'redline' ? { policyNote: SYSTEM_POLICY_MARKER } : {}),
    chars: candidate.title.length + candidate.body.length + ENTRY_METADATA_CHARS,
  }
}

/**
 * Model-facing body for one entry.
 *
 * Only user content is rendered: `sourceSession`, `evidence`, `credentialRef`
 * and other internal pointers are deliberately absent.
 */
function personalEntryBody(entry: ListedMemoryEntry): string {
  const content = memoryEntryContent(entry).trim()
  switch (entry.type) {
    case 'preference': {
      const lines: string[] = []
      if (entry.app !== undefined && entry.app !== '') lines.push(`app: ${entry.app}`)
      lines.push(`topic: ${entry.topic}`, content)
      return lines.join('\n')
    }
    case 'pitfall': {
      const lines = [
        `error: ${entry.errorSignature}`,
        `context: ${entry.context}`,
        `solution: ${content}`,
      ]
      if (entry.appliesTo !== undefined && entry.appliesTo.length > 0) {
        lines.push(`applies to: ${entry.appliesTo.join(', ')}`)
      }
      return lines.join('\n')
    }
    case 'fact': {
      const lines: string[] = []
      if (entry.scope !== undefined && entry.scope !== '') lines.push(`scope: ${entry.scope}`)
      lines.push(`key: ${entry.key}`, `statement: ${content}`)
      return lines.join('\n')
    }
    case 'episodic': {
      const lines = [`summary: ${content}`]
      if (entry.request !== undefined && entry.request !== '') lines.push(`request: ${entry.request}`)
      if (entry.outcome !== undefined && entry.outcome !== '') lines.push(`outcome: ${entry.outcome}`)
      return lines.join('\n')
    }
    case 'sop': {
      const lines = [
        `status: ${entry.status}; version: ${String(entry.version)}`,
        `trigger: ${entry.trigger}`,
        'steps:',
        content,
      ]
      if (entry.successCriteria !== undefined && entry.successCriteria.length > 0) {
        lines.push('success criteria:', ...entry.successCriteria.map(item => `- ${item}`))
      }
      if (entry.tools !== undefined && entry.tools.length > 0) lines.push(`tools: ${entry.tools.join(', ')}`)
      return lines.join('\n')
    }
  }
}

/** Identity of content used to avoid injecting the same memory twice. */
function contentFingerprint(title: string, body: string): string {
  const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim()
  return `${normalize(title)}\u0000${normalize(body)}`
}

interface CurrentSourcePolicy {
  authority: MemoryAuthority
  title?: string
  type: string
  origin: MemoryOrigin
  reviewStatus: MemoryReviewStatus
  from?: string
  to?: string
}

/** Current graph-side policy for a binding's source; absent source falls back to advisory. */
function currentSourcePolicy(binding: PersonalBinding, graph: LoadedGraph): CurrentSourcePolicy {
  if (binding.sourceType === 'node') {
    const node = graph.nodes.find(candidate => candidate.id === binding.sourceId)
    if (node === undefined) {
      return { authority: 'advisory', type: 'fact', origin: 'human', reviewStatus: 'draft' }
    }
    return {
      authority: node.authority,
      title: node.title,
      type: node.type,
      origin: node.origin,
      reviewStatus: node.reviewStatus,
    }
  }
  const edge = graph.edges.find(candidate => candidate.id === binding.sourceId)
  if (edge === undefined) {
    return { authority: 'advisory', type: 'relates_to', origin: 'human', reviewStatus: 'draft' }
  }
  const from = graph.nodes.find(node => node.id === edge.from)
  const to = graph.nodes.find(node => node.id === edge.to)
  return {
    authority: strictestAuthority(edge.authority, from?.authority, to?.authority),
    title: edge.title,
    type: edge.type,
    origin: edge.origin,
    reviewStatus: edge.reviewStatus,
    from: edge.from,
    to: edge.to,
  }
}

function finalizeEntry(input: {
  mode: MemoryContextMode
  graphId: string
  sourceType: BindingSourceType
  sourceId: string
  title: string
  type: string
  authority: MemoryAuthority
  origin: MemoryOrigin
  reviewStatus: MemoryReviewStatus
  status: BindingStatus
  sourceVersion: number
  sourceCommit?: string
  path?: string
  from?: string
  to?: string
  body: string
  nonOverridable?: boolean
}): MemoryContextEntry {
  const nonOverridable = input.nonOverridable ?? input.authority === 'redline'
  return {
    ...input,
    nonOverridable,
    ...(nonOverridable ? { policyNote: SYSTEM_POLICY_MARKER } : {}),
    chars: input.title.length + input.body.length + ENTRY_METADATA_CHARS,
  }
}

// ---------------------------------------------------------------------------
// Document reading
// ---------------------------------------------------------------------------

/** Read a graph-relative document body and frontmatter; missing bodies fail closed. */
async function readGraphDocument(root: string, relPath: string | undefined): Promise<DocumentText | undefined> {
  // A topology-only relation has no document and no body; that is not a failure.
  if (relPath === undefined || relPath === '') return { frontMatter: null, body: '' }

  const candidates: string[] = []
  if (isAbsolute(relPath)) {
    candidates.push(relPath)
  } else {
    if (relPath.split('/').some(segment => segment === '..' || segment === '')) return undefined
    candidates.push(join(root, relPath))
    // Also accept a graph-directory root (`<scope>/.graphs/<id>`).
    candidates.push(join(root, '..', '..', relPath))
  }

  for (const candidate of candidates) {
    try {
      return splitFrontMatter(await readFile(candidate, 'utf8'))
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

/** Parse the attributes the runtime injection reads, tolerating extra keys. */
function readDocumentAttributes(frontMatter: string | null): DocumentAttributes {
  if (frontMatter === null || frontMatter.trim() === '') return {}
  const record = parseSimpleYaml(frontMatter)
  const text = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const authority = text('authority')
  const origin = text('origin')
  const reviewStatus = text('reviewStatus')
  return {
    ...(text('title') === undefined ? {} : { title: text('title')! }),
    ...(text('type') === undefined ? {} : { type: text('type')! }),
    ...(authority !== undefined && AUTHORITIES.includes(authority as MemoryAuthority)
      ? { authority: authority as MemoryAuthority }
      : {}),
    ...(origin !== undefined && ORIGINS.includes(origin as MemoryOrigin)
      ? { origin: origin as MemoryOrigin }
      : {}),
    ...(reviewStatus !== undefined && REVIEW_STATUSES.includes(reviewStatus as MemoryReviewStatus)
      ? { reviewStatus: reviewStatus as MemoryReviewStatus }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Ordering and budget
// ---------------------------------------------------------------------------

/**
 * Priority tiers: redline, canonical, advisory proxies, personal effective
 * memory, shared advisory + personal episodic history, advisory internalized.
 *
 * Department/global canonical and advisory sources outrank personal memory so a
 * department rule or definition wins a conflict. Shared memory is published for
 * the whole scope but has no subscription and stays advisory; it ranks beside
 * raw personal episodic history and is one of the first tiers a tight prompt
 * budget gives up. A redline is never dropped.
 */
function entryTier(entry: MemoryContextEntry): number {
  if (entry.nonOverridable || entry.authority === 'redline') return 0
  if (entry.authority === 'canonical') return 1
  if (entry.mode === 'subscribe') return 2
  if (entry.mode === 'personal') return entry.type === 'episodic' ? 4 : 3
  if (entry.mode === 'shared') return 4
  return 5
}

/**
 * Inside the shared/episodic tier, keep curated department context before raw
 * personal history, so a budget that fits only one still keeps the published one.
 */
function sharedTierRank(entry: MemoryContextEntry): number {
  return entry.mode === 'shared' ? 0 : 1
}

function compareEntries(left: MemoryContextEntry, right: MemoryContextEntry): number {
  const leftTier = entryTier(left)
  const tier = leftTier - entryTier(right)
  if (tier !== 0) return tier
  if (leftTier === 4) {
    const rank = sharedTierRank(left) - sharedTierRank(right)
    if (rank !== 0) return rank
  }
  if (left.mode === 'personal' && right.mode === 'personal') {
    const type = personalTypeRank(left.type) - personalTypeRank(right.type)
    if (type !== 0) return type
    // Newest first inside one memory type, then id for determinism.
    const updated = compareText(right.updatedAt ?? '', left.updatedAt ?? '')
    if (updated !== 0) return updated
    return compareText(left.sourceId, right.sourceId)
  }
  const graph = compareText(left.graphId, right.graphId)
  if (graph !== 0) return graph
  const type = sourceTypeRank(left.sourceType) - sourceTypeRank(right.sourceType)
  if (type !== 0) return type
  return compareText(left.sourceId, right.sourceId)
}

/** Current effective memory first; raw episodic history last. */
function personalTypeRank(type: string): number {
  switch (type) {
    case 'preference':
      return 0
    case 'pitfall':
      return 1
    case 'fact':
      return 2
    case 'sop':
      return 3
    case 'episodic':
      return 4
    default:
      return 5
  }
}

function sourceTypeRank(sourceType: MemoryContextSourceType): number {
  if (sourceType === 'node') return 0
  if (sourceType === 'entry') return 1
  return 2
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MEMORY_CONTEXT_MAX_CHARS
  return Math.max(0, Math.floor(value))
}

function strictestAuthority(...values: Array<MemoryAuthority | undefined>): MemoryAuthority {
  let authority: MemoryAuthority = 'advisory'
  for (const value of values) {
    if (value !== undefined && AUTHORITY_RANK[value] > AUTHORITY_RANK[authority]) authority = value
  }
  return authority
}

function graphCommit(graph: LoadedGraph): string | undefined {
  const withCommit = graph as LoadedGraph & { commit?: string }
  if (typeof withCommit.commit === 'string' && withCommit.commit !== '') return withCommit.commit
  const manifest = graph.manifest as GraphManifest & { commit?: string; sourceCommit?: string }
  if (typeof manifest.commit === 'string' && manifest.commit !== '') return manifest.commit
  if (typeof manifest.sourceCommit === 'string' && manifest.sourceCommit !== '') return manifest.sourceCommit
  return undefined
}
