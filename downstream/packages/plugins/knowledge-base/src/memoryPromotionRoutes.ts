// @ts-nocheck
/**
 * HTTP seam for memory promotion and shared (department/global) memory.
 *
 * `memoryRoutes.ts` owns the caller's personal page. This module owns the one
 * operation that crosses a scope boundary — promoting a personal memory into a
 * department or global memory — plus the review queue and the read-only shared
 * list. It is separate because the trust question is different: the personal page
 * acts on the caller's own tree, while every promotion decision needs a reviewer
 * projection and a DataOps write/read decision for the TARGET path.
 *
 * Authorization has two layers, on purpose:
 *
 * 1. the product layer ({@link decidePromotionScope}, {@link canReviewPromotion})
 *    answers "is this reviewer's product scope the one this record targets", which
 *    is what makes the queue and the 403 messages understandable;
 * 2. DataOps stays authoritative for the write and the read through the injected
 *    `canWrite` / `canRead` seams. A projection that disagrees with the backend
 *    therefore narrows access, never widens it.
 *
 * The submitter is never allowed to approve their own pending request. An
 * administrator who wants to share their own memory uses `confirm: true`, which is
 * recorded as a distinct `confirmed` audit action.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-promotion-routes
 */
import type { MemoryStore } from './memoryStore.ts'
import { MemoryStoreError } from './memoryStore.ts'
import {
  MemoryPromotionError,
  SHARED_MEMORY_FOLDER,
  SHARED_MEMORY_GRAPH_ID,
  applyPromotionToSharedMemory,
  canReviewPromotion,
  createPromotionRequest,
  decidePromotionScope,
  getPromotionRecord,
  isPromotionVisibleTo,
  listPromotionRecords,
  markPromotionApproved,
  markPromotionRejected,
  promotionContentOf,
  promotionTitleOf,
  sharedMemoryGraphName,
  targetScopePrefix,
  targetScopeRoot,
  type MemoryPromotionRecord,
  type PromotionActor,
  type PromotionReviewer,
  type PromotionTarget,
  type PromotionTargetScope,
} from './memoryPromotion.ts'

/** The methods this handler answers. */
export type MemoryPromotionMethod =
  | 'memory.promote'
  | 'memory.promotions'
  | 'memory.review-promotion'
  | 'memory.shared'

/** Injected filesystem/permission seams; tests use plain functions. */
export interface MemoryPromotionRouteInput {
  readonly method: MemoryPromotionMethod
  /** Parsed JSON body; methods without one may omit it. */
  readonly body?: unknown
  readonly actor: PromotionActor
  readonly reviewer: PromotionReviewer
  /** The caller's personal memory store; the source entry is read from here. */
  readonly store: Pick<MemoryStore, 'getEntry'>
  /** Absolute path of the promotion queue JSON file. */
  readonly queuePath: string
  /** Authoritative knowledge root (`/nas/kb/actual`). */
  readonly actualRoot: string
  /** DataOps write decision for one scope-relative path. */
  readonly canWrite?: (relPath: string) => Promise<boolean>
  /** DataOps read decision for one scope-relative path. */
  readonly canRead?: (relPath: string) => Promise<boolean>
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date
}

/** One response the route switch can pass straight to `writeJson`. */
export interface MemoryPromotionRouteResponse {
  readonly status: number
  readonly body: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const ok = (body: Record<string, unknown>): MemoryPromotionRouteResponse => ({ status: 200, body })

const fail = (
  status: number,
  error: string,
  code?: string,
  extra?: Record<string, unknown>,
): MemoryPromotionRouteResponse => ({
  status,
  body: { error, ...(code === undefined ? {} : { code }), ...extra },
})

/** The externally visible shape of one promotion; never the source user id. */
export function publicPromotion(record: MemoryPromotionRecord, viewerId: string): Record<string, unknown> {
  return {
    id: record.id,
    memoryId: record.source.memoryId,
    title: record.source.title,
    type: record.source.memoryType,
    // The reviewer approves the CONTENT, not just a title; the queue row shows a
    // bounded preview and the full text travels with the request.
    content: record.source.content,
    status: record.status,
    targetScope: record.target.scope,
    ...(record.target.departmentCode === undefined ? {} : { departmentCode: record.target.departmentCode }),
    ...(record.target.departmentName === undefined ? {} : { departmentName: record.target.departmentName }),
    targetGraph: record.target.graphId,
    requestedAt: record.requestedAt,
    requestedByName: record.requestedBy.name,
    ...(record.reviewedAt === undefined ? {} : { reviewedAt: record.reviewedAt }),
    ...(record.reviewedBy === undefined ? {} : { reviewedByName: record.reviewedBy.name }),
    ...(record.reviewNote === undefined ? {} : { reviewNote: record.reviewNote }),
    confirmed: record.confirmed,
    selfApproval: record.requestedBy.id === viewerId,
  }
}

/** One read-only row of the department/global shared list. */
export interface SharedMemoryRow {
  id: string
  title: string
  type: string
  content: string
  scope: PromotionTargetScope
  departmentCode?: string
  departmentName?: string
  promotedAt: string
  promotedBy?: string
}

/** Build the row without any personal identifier or source session. */
export function sharedRowOf(record: MemoryPromotionRecord): SharedMemoryRow {
  return {
    id: record.id,
    title: record.source.title,
    type: record.source.memoryType,
    content: record.source.content,
    scope: record.target.scope,
    ...(record.target.departmentCode === undefined ? {} : { departmentCode: record.target.departmentCode }),
    ...(record.target.departmentName === undefined ? {} : { departmentName: record.target.departmentName }),
    promotedAt: record.appliedAt ?? record.reviewedAt ?? record.requestedAt,
    ...(record.reviewedBy === undefined ? {} : { promotedBy: record.reviewedBy.name }),
  }
}

/** Validate and normalize one `memory.promote` body. */
function readPromoteBody(body: Record<string, unknown>): {
  id: string
  scope: PromotionTargetScope
  departmentCode?: string
  confirm: boolean
  note?: string
} {
  if (Object.prototype.hasOwnProperty.call(body, 'userId') || Object.prototype.hasOwnProperty.call(body, 'sourceUserId')) {
    throw new MemoryPromotionError('invalid', 'the source user is resolved from the request, never the body')
  }
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (id === '' || id.length > 200 || /[\s/\\\u0000]/u.test(id)) {
    throw new MemoryPromotionError('invalid', 'a safe memory id is required')
  }
  const scope = body.targetScope
  if (scope !== 'department' && scope !== 'global') {
    throw new MemoryPromotionError('invalid', 'targetScope must be department or global')
  }
  const departmentCode = typeof body.departmentCode === 'string' ? body.departmentCode.trim() : undefined
  if (departmentCode !== undefined && (departmentCode === '' || departmentCode.length > 120)) {
    throw new MemoryPromotionError('invalid', 'departmentCode must be 1–120 characters')
  }
  if (body.confirm !== undefined && typeof body.confirm !== 'boolean') {
    throw new MemoryPromotionError('invalid', 'confirm must be a boolean')
  }
  const note = typeof body.note === 'string' ? body.note.trim() : undefined
  if (note !== undefined && note.length > 500) {
    throw new MemoryPromotionError('invalid', 'note is longer than 500 characters')
  }
  return {
    id,
    scope,
    ...(departmentCode === undefined ? {} : { departmentCode }),
    confirm: body.confirm === true,
    ...(note === undefined || note === '' ? {} : { note }),
  }
}

/** The target path/data for one promotion request. */
function buildTarget(
  scope: PromotionTargetScope,
  decision: { departmentCode?: string; departmentPath?: readonly string[] },
  departmentName?: string,
): Omit<PromotionTarget, 'docPath'> & { docPath: string } {
  const idPlaceholder = '<id>'
  const prefix = targetScopePrefix({
    scope,
    ...(decision.departmentCode === undefined ? {} : { departmentCode: decision.departmentCode }),
    ...(decision.departmentPath === undefined ? {} : { departmentPath: decision.departmentPath }),
    graphId: SHARED_MEMORY_GRAPH_ID,
    graphName: sharedMemoryGraphName(scope),
    docPath: '',
  })
  return {
    scope,
    ...(decision.departmentCode === undefined ? {} : { departmentCode: decision.departmentCode }),
    // A global promotion has no department, even when the reviewer belongs to one;
    // keeping the reviewer's department here would make the audit look like a
    // department-scoped promotion.
    ...(scope === 'department' && departmentName !== undefined ? { departmentName } : {}),
    ...(decision.departmentPath === undefined ? {} : { departmentPath: decision.departmentPath }),
    graphId: SHARED_MEMORY_GRAPH_ID,
    graphName: sharedMemoryGraphName(scope),
    docPath: `${SHARED_MEMORY_FOLDER}/${idPlaceholder}.md`,
  }
}

/** Map a typed failure to the status the page can act on. */
function failureOf(error: unknown): MemoryPromotionRouteResponse {
  if (error instanceof MemoryPromotionError) {
    const status = error.code === 'forbidden'
      ? 403
      : error.code === 'not-found'
        ? 404
        : error.code === 'conflict'
          ? 409
          : error.code === 'io' || error.code === 'invalid-graph'
            ? 500
            : 400
    return fail(status, error.message, error.code)
  }
  if (error instanceof MemoryStoreError) {
    const status = error.code === 'not-found' || error.code === 'sop-not-found' ? 404 : 400
    return fail(status, error.message, error.code)
  }
  throw error
}

/** DataOps is authoritative; an absent seam means a local deployment with no grants. */
async function allowed(check: ((relPath: string) => Promise<boolean>) | undefined, relPath: string): Promise<boolean> {
  return check === undefined ? true : check(relPath)
}

/** Apply an approved record after the target write path has been authorized. */
async function applyApproved(
  input: MemoryPromotionRouteInput,
  record: MemoryPromotionRecord,
  reviewer: PromotionActor,
  confirmed: boolean,
  note?: string,
): Promise<MemoryPromotionRecord> {
  const scopeRoot = targetScopeRoot(record.target)
  // Ask about the scope ROOT, not the document: DataOps matches grants by exact
  // resource id and a trailing slash is a different id, so a folder grant would never
  // cover the document if the question named the file (or the folder with a slash).
  if (!await allowed(input.canWrite, scopeRoot)) {
    throw new MemoryPromotionError('forbidden', '没有目标部门/全局记忆的写入权限。')
  }
  const applied = await applyPromotionToSharedMemory({
    record,
    scopeRoot: joinRoot(input.actualRoot, scopeRoot),
    now: (input.now?.() ?? new Date()).toISOString(),
  })
  return markPromotionApproved(
    input.queuePath,
    record.id,
    reviewer,
    scopeRoot + '/' + record.target.docPath,
    { confirmed, ...(note === undefined ? {} : { note }) },
    input.now,
  )
}

/** Join an absolute root with a scope-relative prefix that already ends in `/`. */
function joinRoot(root: string, prefix: string): string {
  return root.replace(/[\\/]+$/u, '') + '/' + prefix.replace(/^[\\/]+/u, '').replace(/[\\/]+$/u, '')
}

/**
 * Handle one promotion/shared-memory method.
 *
 * Expected failures are returned as status/body pairs. Unexpected errors are
 * rethrown so the route's outer handler reports a real 500 rather than a
 * misleading 400.
 */
export async function handleMemoryPromotionRoute(
  input: MemoryPromotionRouteInput,
): Promise<MemoryPromotionRouteResponse> {
  const { method, actor, reviewer } = input
  const body = isRecord(input.body) ? input.body : {}
  try {
    switch (method) {
      case 'memory.promote': {
        const parsed = readPromoteBody(body)
        const decision = decidePromotionScope(reviewer, parsed.scope, parsed.departmentCode)
        if (!decision.ok) {
          return fail(403, decision.message, decision.code === 'invalid' ? 'invalid' : 'PROMOTION_FORBIDDEN')
        }
        const entry = await input.store.getEntry(parsed.id)
        if (entry === undefined) return fail(404, 'memory entry not found', 'not-found')
        if (entry.privacy !== 'normal') {
          return fail(
            400,
            '只有隐私为「普通」的记忆可以晋升；仅自己、敏感和凭据引用不会被共享。',
            'PRIVACY_NOT_PROMOTABLE',
          )
        }
        const target = buildTarget(
          parsed.scope,
          decision as { departmentCode?: string; departmentPath?: readonly string[] },
          reviewer.departmentName,
        )
        const draft = {
          source: {
            userId: actor.id,
            userName: actor.name,
            memoryId: entry.id,
            memoryType: entry.type,
            title: promotionTitleOf(entry),
            content: promotionContentOf(entry),
            privacy: entry.privacy,
            ...(entry.sourceLabel === undefined ? {} : { sourceLabel: entry.sourceLabel }),
          },
          target,
        }
        const created = await createPromotionRequest(input.queuePath, draft, actor, input.now)
        // The stored path carries the real id; the draft only had a placeholder.
        if (created.duplicate) {
          return ok({ promotion: publicPromotion(created.record, actor.id), duplicate: true, applied: false })
        }
        if (!parsed.confirm) {
          return ok({ promotion: publicPromotion(created.record, actor.id), pending: true, applied: false })
        }
        // Explicit administrator confirmation: a separate, audited path that is not
        // the review queue. It is allowed for the submitter because the UI asked for
        // the wider scope and the caller already holds review authority for it.
        const approved = await applyApproved(
          input,
          created.record,
          { id: actor.id, name: actor.name },
          true,
          parsed.note,
        )
        return ok({
          promotion: publicPromotion(approved, actor.id),
          pending: false,
          applied: true,
        })
      }

      case 'memory.promotions': {
        const view = body.view === 'review' ? 'review' : 'mine'
        const records = await listPromotionRecords(input.queuePath)
        const mine = records
          .filter(record => record.requestedBy.id === actor.id)
          .map(record => publicPromotion(record, actor.id))
        const review = view !== 'review'
          ? []
          : records
            .filter(record => record.status === 'pending' && canReviewPromotion(reviewer, record.target))
            .map(record => ({
              promotion: publicPromotion(record, actor.id),
              selfApproval: record.requestedBy.id === actor.id,
            }))
        const canPromoteGlobal = decidePromotionScope(reviewer, 'global').ok
        const departmentCode = reviewer.departmentCode
        const canPromoteDepartment = departmentCode !== undefined
          && decidePromotionScope(reviewer, 'department', departmentCode).ok
        return ok({
          canPromote: {
            global: canPromoteGlobal,
            departments: canPromoteDepartment ? [departmentCode] : [],
          },
          canReview: reviewer.isGlobalAdmin || reviewer.reviewDepartments.length > 0,
          promotions: mine,
          reviewQueue: review,
          scopes: {
            global: canPromoteGlobal,
            departments: canPromoteDepartment ? [departmentCode] : [],
          },
        })
      }

      case 'memory.review-promotion': {
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (id === '') return fail(400, 'a promotion id is required', 'invalid')
        const decision = body.decision
        if (decision !== 'approve' && decision !== 'reject') {
          return fail(400, 'decision must be approve or reject', 'invalid')
        }
        const note = typeof body.note === 'string' ? body.note.trim() : undefined
        if (note !== undefined && note.length > 500) {
          return fail(400, 'note is longer than 500 characters', 'invalid')
        }
        const record = await getPromotionRecord(input.queuePath, id)
        if (record === undefined) return fail(404, 'promotion not found', 'not-found')
        if (record.status !== 'pending') {
          return fail(409, `promotion is already ${record.status}`, 'conflict')
        }
        if (!canReviewPromotion(reviewer, record.target)) {
          return fail(403, '没有该晋升目标范围的审核权限。', 'PROMOTION_FORBIDDEN')
        }
        if (decision === 'approve' && record.requestedBy.id === actor.id) {
          return fail(403, '不能审核通过自己提交的晋升；请联系另一位管理员。', 'SELF_APPROVAL_FORBIDDEN')
        }
        if (decision === 'reject') {
          const rejected = await markPromotionRejected(input.queuePath, id, actor, note, input.now)
          return ok({ promotion: publicPromotion(rejected, actor.id), applied: false })
        }
        const approved = await applyApproved(input, record, actor, false, note)
        return ok({ promotion: publicPromotion(approved, actor.id), applied: true })
      }

      case 'memory.shared': {
        const records = await listPromotionRecords(input.queuePath)
        const rows: SharedMemoryRow[] = []
        const readCache = new Map<string, boolean>()
        for (const record of records) {
          if (record.status !== 'approved') continue
          if (record.source.privacy !== 'normal') continue
          if (!isPromotionVisibleTo(record, reviewer)) continue
          const scopeRoot = targetScopeRoot(record.target)
          let readable = readCache.get(scopeRoot)
          if (readable === undefined) {
            readable = await allowed(input.canRead, scopeRoot)
            readCache.set(scopeRoot, readable)
          }
          if (!readable) continue
          rows.push(sharedRowOf(record))
        }
        rows.sort((left, right) => right.promotedAt.localeCompare(left.promotedAt))
        return ok({ entries: rows.slice(0, 100) })
      }

      default:
        return fail(404, `unknown memory promotion method: ${String(method)}`, 'not-found')
    }
  } catch (error) {
    return failureOf(error)
  }
}

/** Re-exported so the host can build the same target shape in its tests. */
export { SHARED_MEMORY_GRAPH_ID, SHARED_MEMORY_FOLDER, type PromotionTargetScope }
