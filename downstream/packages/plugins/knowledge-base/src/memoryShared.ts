/**
 * Department/global shared memory for the runtime context.
 *
 * A promotion (design §17.4, §22) writes one approved document under
 * `<scope>/记忆共享/<promotion-id>.md` and registers it in
 * `<scope>/.graphs/shared-memory/graph.json`. Those documents have no personal
 * binding: the user never subscribed, the department published. The runtime
 * therefore reads the shared graph directly and treats each node as advisory
 * department/global context.
 *
 * Two boundaries keep that read safe:
 *
 * - the caller's scope roots are composed from the authenticated department
 *   chain (`global` plus `department/<chain>`), never from a graph id supplied by
 *   the browser. A graph in another department is never opened;
 * - `canViewGraph` still decides whether the manifest is readable, and the Host
 *   asks DataOps `canRead` for the scope root before the graph is loaded. The
 *   resolver re-checks visibility per graph, so a caller cannot be handed a
 *   graph and read a name it was not granted.
 *
 * Only `normal` / `private` shared documents enter a model-facing context.
 * `sensitive` / `secret` stay on the memory page, mirroring the personal rule in
 * §15.2. Promotions only ever copy `normal` content, so this is a fail-closed
 * guard for hand-written or future documents rather than the normal path.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-shared
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { LoadedGraph, MemoryAuthority, MemoryOrigin, MemoryReviewStatus } from './graphModel.ts'
import { parseSimpleYaml } from './memoryBindings.ts'
import { splitFrontMatter } from './memoryGuardian.ts'
import { SHARED_MEMORY_GRAPH_ID } from './memoryPromotion.ts'
import { PRIVACY_VALUES, type Privacy } from './memoryTypes.ts'

/** The caller fields the shared scope roots are derived from. */
export interface SharedMemoryCaller {
  departmentCode?: string
  departmentPathCodes?: readonly string[]
}

/** One scope root that may hold a shared-memory graph. */
export interface SharedMemoryScopeRoot {
  scope: 'global' | 'department'
  /** Scope-relative root without a trailing slash (`global`, `department/A/B`). */
  relPath: string
  /** Leaf department code for a department root. */
  departmentCode?: string
}

/**
 * The shared-memory scope roots a caller may own content under.
 *
 * `global` is always a candidate (subject to `canRead`); the department root is
 * the caller's own organization chain, never a sibling. Order is global first,
 * then department, so the rendered context is deterministic.
 *
 * @param caller - the authenticated caller's department projection.
 * @returns Scope roots in a stable order.
 */
export function sharedMemoryScopeRoots(caller: SharedMemoryCaller): SharedMemoryScopeRoot[] {
  const roots: SharedMemoryScopeRoot[] = [{ scope: 'global', relPath: 'global' }]
  const rawCodes = caller.departmentPathCodes !== undefined && caller.departmentPathCodes.length > 0
    ? [...caller.departmentPathCodes]
    : (caller.departmentCode === undefined || caller.departmentCode === ''
        ? []
        : [caller.departmentCode])
  // The codes come from the authenticated DataOps projection, but they become a
  // path segment here. A malformed value must truncate the chain, not escape the
  // knowledge root: `department/../..` would be a different tree entirely.
  const codes: string[] = []
  for (const value of rawCodes) {
    const code = typeof value === 'string' ? value.trim() : ''
    if (code === '' || code === '.' || code === '..' || code.includes('/') || code.includes('\\')) break
    codes.push(code)
  }
  if (codes.length > 0) {
    roots.push({
      scope: 'department',
      relPath: 'department/' + codes.join('/'),
      departmentCode: codes[codes.length - 1]!,
    })
  }
  return roots
}

/** One shared document a caller may inject, before context-level dedupe/sort. */
export interface SharedMemoryCandidate {
  /** Node id (`mem-mp-…`); also the dedupe key against a subscription binding. */
  id: string
  title: string
  /** Graph node type (`topic`, `fact`, `case`, `procedure`, `policy`, `skill`). */
  type: string
  authority: MemoryAuthority
  origin: MemoryOrigin
  reviewStatus: MemoryReviewStatus
  privacy: Privacy
  /** Scope-relative document path (`记忆共享/<id>.md`). */
  path: string
  /** `global` or `department:<code>` from the manifest. */
  scope: string
  status: 'active'
  version: number
  body: string
}

interface SharedDocumentAttributes {
  title?: string
  type?: string
  authority?: MemoryAuthority
  origin?: MemoryOrigin
  reviewStatus?: MemoryReviewStatus
  privacy?: Privacy
}

const AUTHORITIES: readonly MemoryAuthority[] = ['canonical', 'advisory', 'redline']
const ORIGINS: readonly MemoryOrigin[] = ['human', 'ai', 'mixed']
const REVIEW_STATUSES: readonly MemoryReviewStatus[] = ['draft', 'reviewed', 'approved']
const PRIVACY: readonly Privacy[] = PRIVACY_VALUES

/**
 * Privacy levels a shared document may enter a model-facing context with.
 *
 * `normal` and `private` are owner/scope-scoped; `sensitive` is redacted in logs
 * and telemetry, and a tool result is part of the transcript; `secret` is only a
 * credential pointer. Both are skipped, exactly like personal memory.
 */
const CONTEXT_PRIVACY: ReadonlySet<Privacy> = new Set<Privacy>(['normal', 'private'])

/**
 * The body without the promotion audit footer.
 *
 * Every promotion ends with `---` and `由 … 于 … 审核晋升。`, which is provenance,
 * not memory content. The audit trail stays in the document; the model sees the
 * statement only. Dropping it here also lets two re-promotions of the same
 * statement dedupe by title + body instead of appearing once per timestamp.
 */
function sharedBodyOf(body: string): string {
  return body.replace(/\n-{3,}\n+由[^\n]*审核晋升。\s*$/u, '').trim()
}

/** Read the attributes the shared injection reads, tolerating unknown keys. */
function readDocumentAttributes(frontMatter: string | null): SharedDocumentAttributes {
  if (frontMatter === null || frontMatter.trim() === '') return {}
  const record = parseSimpleYaml(frontMatter)
  const text = (key: string): string | undefined => {
    const value = record[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const authority = text('authority')
  const origin = text('origin')
  const reviewStatus = text('reviewStatus')
  const privacy = text('privacy')
  return {
    ...(text('title') === undefined ? {} : { title: text('title')! }),
    ...(text('type') === undefined ? {} : { type: text('type')! }),
    ...(authority !== undefined && (AUTHORITIES as readonly string[]).includes(authority)
      ? { authority: authority as MemoryAuthority }
      : {}),
    ...(origin !== undefined && (ORIGINS as readonly string[]).includes(origin)
      ? { origin: origin as MemoryOrigin }
      : {}),
    ...(reviewStatus !== undefined && (REVIEW_STATUSES as readonly string[]).includes(reviewStatus)
      ? { reviewStatus: reviewStatus as MemoryReviewStatus }
      : {}),
    ...(privacy !== undefined && (PRIVACY as readonly string[]).includes(privacy)
      ? { privacy: privacy as Privacy }
      : {}),
  }
}

/** A document path that stays inside the scope root. */
function isSafeDocumentPath(relPath: string): boolean {
  if (relPath === '' || isAbsolute(relPath)) return false
  return !relPath.split('/').some(segment => segment === '' || segment === '..' || segment === '.')
}

/**
 * Read every injectable node of one shared-memory graph.
 *
 * A missing or unreadable document is skipped (fail soft): one broken promotion
 * must not hide a redline or fail the whole context. A graph that is not the
 * shared-memory graph, or whose manifest scope is neither `global` nor
 * `department:<code>`, contributes nothing.
 *
 * @param graph - the loaded graph; its `root` must be the scope root.
 * @returns Candidates in manifest node order, already privacy-filtered.
 */
export async function readSharedMemoryCandidates(graph: LoadedGraph): Promise<SharedMemoryCandidate[]> {
  if (graph.manifest.id !== SHARED_MEMORY_GRAPH_ID) return []
  const scope = graph.manifest.scope ?? ''
  if (scope !== 'global' && !scope.startsWith('department:')) return []
  const version = Number.isFinite(graph.manifest.version) ? graph.manifest.version : 1
  const candidates: SharedMemoryCandidate[] = []

  for (const node of graph.nodes) {
    if (node.missing) continue
    if (!isSafeDocumentPath(node.path)) continue
    let text: string
    try {
      text = await readFile(join(graph.root, node.path), 'utf8')
    } catch {
      continue
    }
    const document = splitFrontMatter(text)
    const live = readDocumentAttributes(document.frontMatter)
    const privacy = live.privacy ?? 'normal'
    if (!CONTEXT_PRIVACY.has(privacy)) continue
    // A shared document that is still a draft has not been published to the
    // scope; the promoted path always writes `approved`. Missing frontmatter
    // falls back to the loader's `draft`, so an unlabelled document fails closed.
    const reviewStatus = live.reviewStatus ?? node.reviewStatus ?? 'draft'
    if (reviewStatus === 'draft') continue
    const body = sharedBodyOf(document.body)
    if (body === '') continue
    const title = (live.title ?? node.title ?? node.id).trim()
    if (title === '') continue
    candidates.push({
      id: node.id,
      title,
      type: live.type ?? node.type,
      authority: live.authority ?? node.authority ?? 'advisory',
      origin: live.origin ?? node.origin ?? 'human',
      reviewStatus,
      privacy,
      path: node.path,
      scope,
      status: 'active',
      version,
      body,
    })
  }
  return candidates
}
