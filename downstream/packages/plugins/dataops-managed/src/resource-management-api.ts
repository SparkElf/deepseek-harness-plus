/**
 * DataOps resource-management transport: pending approval tasks, existing access grants,
 * batch grant/revoke, and approval decisions. Disclosure is handled by tool-scope; this file
 * only speaks to the existing DataOps APIs.
 */
import { randomUUID } from 'node:crypto'
import type { ReviewApi, ReviewApiResult } from './review-api.ts'

export type ResourceGrantTargetType = 'USER' | 'ROLE' | 'DEPARTMENT' | 'APPLICATION'
export type ResourceGrantPermission = 'READ' | 'WRITE' | 'MANAGE'
export type ResourceGrantType = 'REGULAR' | 'TEMPORARY'

export interface ResourceGrantInput {
  targetType: ResourceGrantTargetType
  targetId: string
  permission?: ResourceGrantPermission
  grantType?: ResourceGrantType
  applicationId?: number
}

export interface PendingTaskDecision {
  taskId: number
  userTaskId: string
  decision: 'approve' | 'reject'
  comment?: string
  expectedVersion?: number
  /** Optional replay key; omit for a fresh generated key. */
  idempotencyKey?: string
}

const reasonOf = (body: unknown): string => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return ''
  const record = body as { error?: unknown; message?: unknown; details?: unknown }
  if (typeof record.error === 'string') return record.error
  if (typeof record.message === 'string') return record.message
  const details = record.details as { errors?: unknown } | undefined
  return Array.isArray(details?.errors) ? details.errors.filter((v): v is string => typeof v === 'string').join('; ') : ''
}

const unwrap = <T>(result: ReviewApiResult, operation: string): T => {
  if (result.status < 200 || result.status >= 300) {
    const reason = reasonOf(result.body)
    throw new Error(operation + ' failed: HTTP ' + result.status.toString() + (reason ? ': ' + reason : ''))
  }
  return result.body as T
}

/** Thin typed wrapper over the existing DataOps REST endpoints. */
export class ResourceManagementApi {
  constructor(private readonly reviewApi: ReviewApi) {}

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    return unwrap(await this.reviewApi.request(path, init), path)
  }

  async listPendingTasks(query = '', limit = 20): Promise<Record<string, unknown>[]> {
    // ListTasksDto intentionally has no pageSize (the task centre fixes its own page),
    // so fetch the server page and apply the tool's smaller limit locally.
    const params = new URLSearchParams({ status: 'pending', page: '1' })
    const keyword = query.trim()
    if (keyword) params.set('keyword', keyword)
    const body = await this.call('/api/tasks?' + params.toString(), { method: 'GET' })
    const rows = (body as { tasks?: unknown }).tasks
    return Array.isArray(rows)
      ? rows
        .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
        .slice(0, Math.max(1, Math.min(100, limit)))
      : []
  }

  async listGrants(resourceId: number): Promise<Record<string, unknown>[]> {
    const body = await this.call('/api/resources/' + resourceId.toString() + '/access-grants', { method: 'GET' })
    const rows = (body as { grants?: unknown }).grants
    return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null) : []
  }

  async listApplications(): Promise<Record<string, unknown>[]> {
    const body = await this.call('/api/tasks/asset-access-applications', { method: 'GET' })
    const rows = (body as { applications?: unknown }).applications
    return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null) : []
  }

  async replaceGrants(resourceId: number, grants: ResourceGrantInput[]): Promise<unknown> {
    return this.call('/api/resources/' + resourceId.toString() + '/access-grants', {
      method: 'PUT',
      body: JSON.stringify({ grants }),
    })
  }

  async getTask(taskId: number): Promise<Record<string, unknown>> {
    const body = await this.call('/api/tasks/' + taskId.toString(), { method: 'GET' })
    const task = (body as { task?: unknown }).task
    if (typeof task !== 'object' || task === null) throw new Error('task detail is unavailable')
    return task as Record<string, unknown>
  }

  async decideTask(decision: PendingTaskDecision): Promise<unknown> {
    const action = decision.decision === 'approve' ? 'complete' : 'reject'
    return this.call(
      '/api/tasks/' + decision.taskId.toString() + '/user-tasks/' + encodeURIComponent(decision.userTaskId) + '/' + action,
      {
        method: 'POST',
        headers: {
          // The task command API enforces a per-attempt replay key. Reusing it with the
          // identical command is how a timed-out request is safely retried.
          'idempotency-key': decision.idempotencyKey?.trim() || 'dataops-managed-' + randomUUID(),
        },
        body: JSON.stringify({
          expectedVersion: decision.expectedVersion ?? 0,
          comment: decision.comment?.trim() || (decision.decision === 'approve' ? '同意' : '驳回'),
        }),
      },
    )
  }
}
