/**
 * Promotion of a personal memory or SOP into department/global memory.
 *
 * Personal memory is private by construction. Sharing it with a department or the
 * whole platform is not a copy the guardian makes on its own: it is a product
 * decision that needs a second pair of eyes (design §17.4, §21.2, §22). This module
 * owns that decision and its audit trail:
 *
 * - a promotion is a durable record with a **pending → approved | rejected**
 *   lifecycle; a rejected or approved record is never silently rewritten;
 * - only a caller who already holds review authority for the target scope may
 *   create or decide one — `kb:config:manage` for global, the department review
 *   scope for `department:<code>`;
 * - a request can never be approved by the person who made it. An administrator
 *   who wants their own memory shared uses the explicit `confirm` path, which is a
 *   different, separately-audited action;
 * - only `privacy: normal` content is promotable. `private`, `sensitive` and
 *   `secret` memories are refused rather than downgraded, because a promotion is
 *   an irreversible widening of who can read them;
 * - approval writes a real shared memory document and a graph node under the
 *   target scope, so the existing knowledge-base permissions (not this module)
 *   decide who can read it.
 *
 * The store is product metadata (a review queue), not knowledge content: it lives
 * beside the per-user binding state, never inside a document tree, and holds one
 * JSON file committed by atomic rename.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-promotion
 */
import { randomUUID } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { writeFileAtomic } from './memoryBindings.ts'
import type { AnyMemoryEntry, MemoryType, Privacy } from './memoryTypes.ts'
import type { ListedMemoryEntry } from './memoryStore.ts'

/** The two scopes a personal memory may be promoted into. */
export const PROMOTION_TARGET_SCOPES = ['department', 'global'] as const
export type PromotionTargetScope = typeof PROMOTION_TARGET_SCOPES[number]

/** Review lifecycle. `approved` and `rejected` are terminal. */
export const PROMOTION_STATUSES = ['pending', 'approved', 'rejected'] as const
export type PromotionStatus = typeof PROMOTION_STATUSES[number]

/** Graph id that owns promoted department/global memory inside one scope. */
export const SHARED_MEMORY_GRAPH_ID = 'shared-memory'

/** Folder (relative to the scope root) that holds one document per promotion. */
export const SHARED_MEMORY_FOLDER = '记忆共享'

/** Display name per graph scope. */
export function sharedMemoryGraphName(scope: PromotionTargetScope): string {
  return scope === 'global' ? '全局共享记忆' : '部门共享记忆'
}

/** A structured refusal the route maps to a status code. */
export class MemoryPromotionError extends Error {
  override readonly name = 'MemoryPromotionError'

  constructor(
    readonly code:
      | 'invalid'
      | 'forbidden'
      | 'not-found'
      | 'conflict'
      | 'privacy'
      | 'invalid-graph'
      | 'io',
    message: string,
  ) {
    super(message)
  }
}

/** One actor in the promotion audit trail. */
export interface PromotionActor {
  readonly id: string
  readonly name: string
}

/** One durable step in a promotion's history. */
export interface PromotionAuditEntry {
  readonly at: string
  readonly actorId: string
  readonly actorName: string
  readonly action: 'requested' | 'confirmed' | 'approved' | 'rejected'
  readonly detail?: Record<string, unknown>
}

/** The personal entry a promotion was made from. */
export interface PromotionSource {
  readonly userId: string
  readonly userName?: string
  readonly memoryId: string
  readonly memoryType: MemoryType
  readonly title: string
  readonly content: string
  readonly privacy: Privacy
  readonly sourceLabel?: string
}

/** Where the promotion lands. `departmentPath` is snapshotted at request time. */
export interface PromotionTarget {
  readonly scope: PromotionTargetScope
  readonly departmentCode?: string
  readonly departmentName?: string
  readonly departmentPath?: readonly string[]
  readonly graphId: typeof SHARED_MEMORY_GRAPH_ID
  readonly graphName: string
  /** Scope-relative document path (`记忆共享/<id>.md`). */
  readonly docPath: string
}

/** One promotion as stored. */
export interface MemoryPromotionRecord {
  readonly id: string
  readonly status: PromotionStatus
  readonly source: PromotionSource
  readonly target: PromotionTarget
  readonly requestedBy: PromotionActor
  readonly requestedAt: string
  readonly reviewedBy?: PromotionActor
  readonly reviewedAt?: string
  readonly reviewNote?: string
  /** True when an administrator applied it directly instead of the review queue. */
  readonly confirmed: boolean
  readonly appliedAt?: string
  readonly audit: readonly PromotionAuditEntry[]
}

/** The whole store file. */
export interface MemoryPromotionStore {
  readonly version: 1
  readonly promotions: readonly MemoryPromotionRecord[]
}

/** The caller projection a promotion decision needs. */
export interface PromotionReviewer {
  readonly userId: string
  readonly name: string
  /** Administrator/super administrator: sees and manages every scope. */
  readonly isGlobalAdmin: boolean
  /** Holds the DataOps `kb:config:manage` permission. */
  readonly canManageConfig: boolean
  readonly departmentCode?: string
  readonly departmentName?: string
  readonly departmentPathCodes?: readonly string[]
  /** Departments whose review queue this caller may decide. */
  readonly reviewDepartments: readonly string[]
  /** Extra departments the backend's data scope grants. */
  readonly visibleDepartmentCodes?: readonly string[]
}

/** A scope decision, with the department path the write will use. */
export type PromotionScopeDecision =
  | { readonly ok: true; readonly departmentCode?: string; readonly departmentPath?: readonly string[] }
  | { readonly ok: false; readonly code: 'forbidden' | 'invalid'; readonly message: string }

/** The submitter may request a promotion only inside a scope they can review. */
export function decidePromotionScope(
  reviewer: PromotionReviewer,
  scope: PromotionTargetScope,
  departmentCode?: string,
): PromotionScopeDecision {
  if (scope === 'global') {
    if (!reviewer.isGlobalAdmin || !reviewer.canManageConfig) {
      return { ok: false, code: 'forbidden', message: '只有管理员/超级管理员可以把记忆晋升到全局。' }
    }
    return { ok: true }
  }
  const code = (departmentCode ?? reviewer.departmentCode ?? '').trim()
  if (code === '') {
    return { ok: false, code: 'invalid', message: '晋升到部门必须指定部门。' }
  }
  // Cross-department promotion needs the target department's own path, which this
  // request cannot resolve safely. Restricting to the caller's department keeps the
  // write inside a path they already administer; a platform admin moves the record
  // to another department by promoting from that department's own context.
  if (reviewer.departmentCode === undefined || code !== reviewer.departmentCode) {
    return { ok: false, code: 'forbidden', message: '只能晋升到当前账号所属部门。' }
  }
  if (!reviewer.isGlobalAdmin && !reviewer.reviewDepartments.includes(code)) {
    return { ok: false, code: 'forbidden', message: '只能晋升到本部门管理范围内的记忆。' }
  }
  const path = reviewer.departmentPathCodes !== undefined && reviewer.departmentPathCodes.length > 0
    ? [...reviewer.departmentPathCodes]
    : [code]
  return { ok: true, departmentCode: code, departmentPath: path }
}

/** Whether one reviewer may decide a promotion aimed at its target scope. */
export function canReviewPromotion(reviewer: PromotionReviewer, target: PromotionTarget): boolean {
  if (target.scope === 'global') return reviewer.isGlobalAdmin
  const code = target.departmentCode ?? ''
  if (code === '') return false
  return reviewer.isGlobalAdmin || reviewer.reviewDepartments.includes(code)
}

/**
 * Whether one approved promotion is visible to a viewer.
 *
 * A department promotion is visible to the viewer whose organization path contains
 * that department (own department and its ancestors) or whose data scope names it.
 * The source owner always keeps seeing their own approved memory.
 */
export function isPromotionVisibleTo(
  record: MemoryPromotionRecord,
  viewer: PromotionReviewer,
): boolean {
  if (record.target.scope === 'global') return true
  if (record.source.userId === viewer.userId) return true
  if (viewer.isGlobalAdmin) return true
  const code = record.target.departmentCode ?? ''
  if (code === '') return false
  if (viewer.departmentCode === code) return true
  if (viewer.departmentPathCodes?.includes(code) === true) return true
  if (viewer.visibleDepartmentCodes?.includes(code) === true) return true
  return viewer.reviewDepartments.includes(code)
}

/**
 * The scope root one target writes under, WITHOUT a trailing slash.
 *
 * DataOps grants are matched against this exact resource id (a trailing slash is a
 * different id and matches nothing), so every permission question must use this
 * spelling. Directory joining adds the slash separately.
 */
export function targetScopeRoot(target: PromotionTarget): string {
  if (target.scope === 'global') return 'global'
  const path = target.departmentPath !== undefined && target.departmentPath.length > 0
    ? target.departmentPath
    : (target.departmentCode === undefined ? [] : [target.departmentCode])
  return 'department/' + path.join('/')
}

/** The scope-relative prefix one target writes under (`global/`, `department/A/B/`). */
export function targetScopePrefix(target: PromotionTarget): string {
  return targetScopeRoot(target) + '/'
}

/** Where the review queue lives for one deployment's per-user memory root. */
export function promotionStorePath(memoryUsersRoot: string): string {
  return join(dirname(resolve(memoryUsersRoot)), 'promotions.json')
}

/** Map a stored memory type onto the graph's smaller node vocabulary. */
export function sharedNodeTypeOf(type: MemoryType): 'policy' | 'fact' | 'procedure' | 'case' | 'skill' | 'topic' {
  switch (type) {
    case 'preference': return 'topic'
    case 'pitfall': return 'case'
    case 'episodic': return 'case'
    case 'fact': return 'fact'
    case 'sop': return 'procedure'
  }
}

/** The text a promotion copies into the shared document. */
export function promotionContentOf(entry: AnyMemoryEntry): string {
  switch (entry.type) {
    case 'preference':
      return entry.value
    case 'pitfall':
      return ['现象：' + entry.errorSignature, '原因：' + entry.context, '解决：' + entry.solution].join('\n\n')
    case 'episodic':
      return entry.summary
    case 'fact':
      return entry.statement
    case 'sop': {
      const parts = ['触发条件：' + entry.trigger, entry.steps.map((step, index) => `${String(index + 1)}. ${step}`).join('\n')]
      if (entry.successCriteria !== undefined && entry.successCriteria.length > 0) {
        parts.push(entry.successCriteria.map(item => '- ' + item).join('\n'))
      }
      return parts.join('\n\n')
    }
  }
}

/** The short title a shared row shows; mirrors the personal page's rules. */
export function promotionTitleOf(entry: ListedMemoryEntry): string {
  if (typeof entry.displayTitle === 'string' && entry.displayTitle.trim() !== '') {
    return clipTitle(entry.displayTitle.trim())
  }
  switch (entry.type) {
    case 'preference':
      return looksTechnical(entry.value) ? '偏好记录' : clipTitle(entry.value)
    case 'pitfall':
      return looksTechnical(entry.errorSignature) ? '踩坑记录' : clipTitle(entry.errorSignature)
    case 'episodic': {
      if (entry.tags?.includes('SOP评估')) return '方法评估'
      if (entry.tags?.includes('SOP晋升')) return '方法晋升'
      if (entry.tags?.includes('idle')) return '空闲触发'
      if (entry.tags?.includes('compaction')) return '压缩触发'
      if (entry.tags?.includes('dream')) return '记忆整理'
      return '情景记录'
    }
    case 'fact':
      return looksTechnical(entry.key) ? '事实记录' : clipTitle(entry.key)
    case 'sop':
      return clipTitle(entry.title)
  }
}

/** Whitespace-collapsed, bounded title; never a technical identifier on its own. */
function clipTitle(value: string): string {
  const clean = value.replace(/\s+/gu, ' ').trim()
  return clean.length <= 40 ? clean : `${clean.slice(0, 39)}…`
}

/** A technical token that should not be the first thing a reader sees in a row. */
function looksTechnical(value: string): boolean {
  if (/[\\/]|session-|kb_[a-z]|\.md\b|\bSOP\b|[a-z]+_[a-z]+/iu.test(value)) return true
  return value.trim().length > 12 && /^[a-z0-9._-]+$/u.test(value.trim())
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const EMPTY_STORE: MemoryPromotionStore = { version: 1, promotions: [] }

const writeQueues = new Map<string, Promise<unknown>>()

/** Serialize mutations of one store path so two requests cannot overwrite each other. */
function serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  writeQueues.set(path, next.then(() => undefined, () => undefined))
  return next
}

/** Read the queue, treating absence as empty and quarantining corrupt JSON. */
export async function readPromotionStore(path: string): Promise<MemoryPromotionStore> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return EMPTY_STORE
    throw new MemoryPromotionError('io', `could not read ${path}: ${String(error)}`)
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
    const candidate = parsed as { version?: unknown; promotions?: unknown }
    if (candidate.version !== 1 || !Array.isArray(candidate.promotions)) throw new Error('wrong shape')
    return { version: 1, promotions: candidate.promotions as readonly MemoryPromotionRecord[] }
  } catch {
    // Keep the bytes: a corrupt queue is evidence, not something to erase silently.
    await rename(path, `${path}.corrupt-${String(Date.now())}`).catch(() => undefined)
    return EMPTY_STORE
  }
}

/** Commit the queue atomically. */
export async function writePromotionStore(path: string, store: MemoryPromotionStore): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(store, null, 2) + '\n')
}

/** Read every promotion, oldest first. */
export async function listPromotionRecords(path: string): Promise<readonly MemoryPromotionRecord[]> {
  return (await readPromotionStore(path)).promotions
}

/** The validated pieces of a new request, before an id or timestamps are assigned. */
export interface PromotionDraft {
  readonly source: PromotionSource
  readonly target: PromotionTarget
}

const MAX_TITLE = 200
const MAX_CONTENT = 20_000

/** Reject a request that cannot be shared safely or written to a graph. */
export function normalizePromotionDraft(draft: PromotionDraft): PromotionDraft {
  if (draft.source.privacy !== 'normal') {
    throw new MemoryPromotionError(
      'privacy',
      '只有隐私为「普通」的记忆可以晋升；仅自己、敏感和凭据引用不会被共享。',
    )
  }
  const title = draft.source.title.trim()
  if (title === '' || title.length > MAX_TITLE) {
    throw new MemoryPromotionError('invalid', `a promotion title must be 1–${String(MAX_TITLE)} characters`)
  }
  const content = draft.source.content.trim()
  if (content === '' || content.length > MAX_CONTENT) {
    throw new MemoryPromotionError('invalid', `a promotion body must be 1–${String(MAX_CONTENT)} characters`)
  }
  if (draft.target.scope === 'department' && (draft.target.departmentCode ?? '').trim() === '') {
    throw new MemoryPromotionError('invalid', 'a department promotion needs a department code')
  }
  return {
    source: { ...draft.source, title, content },
    target: draft.target,
  }
}

/** Create one pending request, or return the identical pending one. */
export async function createPromotionRequest(
  path: string,
  draft: PromotionDraft,
  actor: PromotionActor,
  now: () => Date = () => new Date(),
): Promise<{ record: MemoryPromotionRecord; duplicate: boolean }> {
  const normalized = normalizePromotionDraft(draft)
  return serialize(path, async () => {
    const store = await readPromotionStore(path)
    const duplicate = store.promotions.find(item => item.status === 'pending'
      && item.source.userId === normalized.source.userId
      && item.source.memoryId === normalized.source.memoryId
      && item.target.scope === normalized.target.scope
      && (item.target.departmentCode ?? '') === (normalized.target.departmentCode ?? ''))
    if (duplicate !== undefined) return { record: duplicate, duplicate: true }

    const at = now().toISOString()
    const id = 'mp-' + randomUUID()
    const record: MemoryPromotionRecord = {
      id,
      status: 'pending',
      source: normalized.source,
      // The canonical document path is derived from the id the store just minted, so
      // a caller cannot point the write at another promotion's document.
      target: { ...normalized.target, docPath: `${SHARED_MEMORY_FOLDER}/${id}.md` },
      requestedBy: actor,
      requestedAt: at,
      confirmed: false,
      audit: [{
        at,
        actorId: actor.id,
        actorName: actor.name,
        action: 'requested',
        detail: {
          scope: normalized.target.scope,
          ...(normalized.target.departmentCode === undefined ? {} : { departmentCode: normalized.target.departmentCode }),
          targetGraph: normalized.target.graphId,
          memoryId: normalized.source.memoryId,
        },
      }],
    }
    await writePromotionStore(path, { version: 1, promotions: [...store.promotions, record] })
    return { record, duplicate: false }
  })
}

/** Load one promotion by id. */
export async function getPromotionRecord(
  path: string,
  id: string,
): Promise<MemoryPromotionRecord | undefined> {
  return (await readPromotionStore(path)).promotions.find(item => item.id === id)
}

/** Mark one pending promotion approved after its shared document is on disk. */
export async function markPromotionApproved(
  path: string,
  id: string,
  reviewer: PromotionActor,
  appliedPath: string,
  options: { confirmed: boolean; note?: string },
  now: () => Date = () => new Date(),
): Promise<MemoryPromotionRecord> {
  return serialize(path, async () => {
    const store = await readPromotionStore(path)
    const record = store.promotions.find(item => item.id === id)
    if (record === undefined) throw new MemoryPromotionError('not-found', `no promotion with id ${id}`)
    if (record.status !== 'pending') {
      throw new MemoryPromotionError('conflict', `promotion ${id} is already ${record.status}`)
    }
    const at = now().toISOString()
    const next: MemoryPromotionRecord = {
      ...record,
      status: 'approved',
      reviewedBy: reviewer,
      reviewedAt: at,
      confirmed: options.confirmed,
      appliedAt: at,
      ...(options.note === undefined || options.note.trim() === '' ? {} : { reviewNote: options.note.trim() }),
      audit: [...record.audit, {
        at,
        actorId: reviewer.id,
        actorName: reviewer.name,
        action: options.confirmed ? 'confirmed' : 'approved',
        detail: { appliedPath, scope: record.target.scope },
      }],
    }
    await writePromotionStore(path, {
      version: 1,
      promotions: store.promotions.map(item => item.id === id ? next : item),
    })
    return next
  })
}

/** Mark one pending promotion rejected, keeping the reason. */
export async function markPromotionRejected(
  path: string,
  id: string,
  reviewer: PromotionActor,
  note: string | undefined,
  now: () => Date = () => new Date(),
): Promise<MemoryPromotionRecord> {
  return serialize(path, async () => {
    const store = await readPromotionStore(path)
    const record = store.promotions.find(item => item.id === id)
    if (record === undefined) throw new MemoryPromotionError('not-found', `no promotion with id ${id}`)
    if (record.status !== 'pending') {
      throw new MemoryPromotionError('conflict', `promotion ${id} is already ${record.status}`)
    }
    const at = now().toISOString()
    const next: MemoryPromotionRecord = {
      ...record,
      status: 'rejected',
      reviewedBy: reviewer,
      reviewedAt: at,
      ...(note === undefined || note.trim() === '' ? {} : { reviewNote: note.trim() }),
      audit: [...record.audit, {
        at,
        actorId: reviewer.id,
        actorName: reviewer.name,
        action: 'rejected',
        ...(note === undefined || note.trim() === '' ? {} : { detail: { note: note.trim() } }),
      }],
    }
    await writePromotionStore(path, {
      version: 1,
      promotions: store.promotions.map(item => item.id === id ? next : item),
    })
    return next
  })
}

// ---------------------------------------------------------------------------
// Shared document + graph
// ---------------------------------------------------------------------------

/** Quote a value for the hand-written YAML front matter. */
function yamlQuoted(value: string): string {
  return JSON.stringify(value.replace(/\s+/gu, ' ').trim())
}

/** Compose the shared document: front matter for the graph loader, then the body. */
export function renderSharedMemoryDocument(record: MemoryPromotionRecord, now: string): string {
  const tags = record.target.scope === 'global' ? ['记忆', '全局共享'] : ['记忆', '部门共享']
  return [
    '---',
    `id: mem-${record.id}`,
    `type: ${sharedNodeTypeOf(record.source.memoryType)}`,
    `title: ${yamlQuoted(record.source.title)}`,
    'authority: advisory',
    'internalizable: true',
    'origin: human',
    'reviewStatus: approved',
    `tags: [${tags.join(', ')}]`,
    `promotedAt: ${now}`,
    `promotionId: ${record.id}`,
    `scope: ${record.target.scope === 'global' ? 'global' : 'department:' + (record.target.departmentCode ?? '')}`,
    '---',
    '',
    `# ${record.source.title}`,
    '',
    record.source.content,
    '',
    '---',
    '',
    `由 ${record.reviewedBy?.name ?? record.requestedBy.name} 于 ${now} 审核晋升。`,
    '',
  ].join('\n')
}

/** One manifest node in the shared graph. */
interface SharedGraphNode { id: string; path: string }

/** The subset of `graph.json` this module reads and preserves. */
interface SharedGraphManifest {
  schemaVersion: 1
  id: string
  name: string
  description?: string
  scope: string
  version: number
  status: 'draft' | 'published' | 'archived'
  owner?: string
  createdAt: string
  updatedAt: string
  publishedAt?: string
  tags: string[]
  visibility: 'private' | 'department' | 'global'
  defaultView?: { layout?: string; direction?: string }
  topics?: Array<{ id: string; title: string; description?: string }>
  nodes: SharedGraphNode[]
  edges: Array<{ id: string; from: string; to: string; type: string; doc?: string }>
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

/** Read one shared graph, returning undefined when it has not been created yet. */
async function readSharedGraph(graphPath: string): Promise<SharedGraphManifest | undefined> {
  let raw: string
  try {
    raw = await readFile(graphPath, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return undefined
    throw new MemoryPromotionError('io', `could not read ${graphPath}: ${String(error)}`)
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.nodes)) {
      throw new Error('wrong shape')
    }
    return parsed as unknown as SharedGraphManifest
  } catch {
    throw new MemoryPromotionError('invalid-graph', `shared memory graph is not readable: ${graphPath}`)
  }
}

/** Compose a fresh manifest for one target scope. */
function newSharedGraph(
  record: MemoryPromotionRecord,
  now: string,
): SharedGraphManifest {
  return {
    schemaVersion: 1,
    id: SHARED_MEMORY_GRAPH_ID,
    name: sharedMemoryGraphName(record.target.scope),
    description: record.target.scope === 'global'
      ? '经审核晋升到全局的共享记忆；只读展示。'
      : '经审核晋升到本部门的共享记忆；只读展示。',
    scope: record.target.scope === 'global' ? 'global' : 'department:' + (record.target.departmentCode ?? ''),
    version: 1,
    status: 'published',
    owner: record.reviewedBy?.id ?? record.requestedBy.id,
    createdAt: now,
    updatedAt: now,
    publishedAt: now,
    tags: ['记忆', '共享'],
    visibility: record.target.scope,
    defaultView: { layout: 'hierarchy', direction: 'TB' },
    topics: [],
    nodes: [],
    edges: [],
  }
}

/** The result of materializing one approved promotion. */
export interface AppliedPromotion {
  readonly docPath: string
  readonly graphPath: string
  readonly graphId: string
}

/**
 * Write an approved promotion into the target scope and register it in the shared
 * memory graph.
 *
 * The document is written first and the manifest second: if the manifest write
 * fails, the next approval retries both and the orphan document is harmless (it is
 * not referenced). The reverse order would publish a broken node.
 */
export async function applyPromotionToSharedMemory(input: {
  record: MemoryPromotionRecord
  scopeRoot: string
  now?: string
}): Promise<AppliedPromotion> {
  const { record, scopeRoot } = input
  const now = input.now ?? new Date().toISOString()
  if (record.status !== 'pending') {
    throw new MemoryPromotionError('conflict', `promotion ${record.id} is already ${record.status}`)
  }
  const docRelPath = `${SHARED_MEMORY_FOLDER}/${record.id}.md`
  if (record.target.docPath !== docRelPath) {
    throw new MemoryPromotionError('invalid', 'the stored promotion path does not match its id')
  }
  const docPath = join(scopeRoot, SHARED_MEMORY_FOLDER, `${record.id}.md`)
  const graphPath = join(scopeRoot, '.graphs', SHARED_MEMORY_GRAPH_ID, 'graph.json')

  await writeFileAtomic(docPath, renderSharedMemoryDocument(record, now))

  // The manifest is read-modify-write. Two approvals can land at the same time (a
  // department reviewer and a platform administrator, for instance), so the graph
  // update is serialized per graph path; otherwise the later writer would drop the
  // other promotion's node even though both documents are on disk.
  await serialize(graphPath, async () => {
    const existing = await readSharedGraph(graphPath)
    const manifest = existing === undefined ? newSharedGraph(record, now) : {
      ...existing,
      version: (Number.isFinite(existing.version) ? existing.version : 0) + 1,
      updatedAt: now,
      publishedAt: now,
      status: 'published' as const,
      visibility: record.target.scope,
      scope: record.target.scope === 'global'
        ? 'global'
        : 'department:' + (record.target.departmentCode ?? ''),
      tags: [...new Set([...(existing.tags ?? []), '记忆', '共享'])],
    }
    const nodeId = 'mem-' + record.id
    if (!manifest.nodes.some(node => node.id === nodeId || node.path === docRelPath)) {
      manifest.nodes = [...manifest.nodes, { id: nodeId, path: docRelPath }]
    }
    await writeFileAtomic(graphPath, JSON.stringify(manifest, null, 2) + '\n')
  })
  return { docPath, graphPath, graphId: SHARED_MEMORY_GRAPH_ID }
}
