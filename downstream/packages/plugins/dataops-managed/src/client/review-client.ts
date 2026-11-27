/**
 * Browser calls for review, notifications, the permission centre, and review settings.
 *
 * Every request goes through this plugin's same-origin bridge, which holds the DataOps JWT.
 * A 503/404 means the Host or DataOps has not shipped that endpoint yet; callers render their
 * "waiting for the backend" state instead of treating an unfinished feature as a failure.
 */

import type {
  PortalRole,
  ReviewContext,
  ReviewNotification,
  RiskReport,
  ReviewStatus,
  ResourceVisibility,
} from './review-types.ts'

/** Caller identity and review capability. */
export const REVIEW_CONTEXT_PATH = 'integrations/dataops/review-context'
/** Notification list and read receipts. */
export const NOTIFICATIONS_PATH = 'integrations/dataops/review-notifications'
/** AI scan and the human decision. */
export const REVIEW_ACTION_PATH = 'integrations/dataops/review'
/** Role matrix, members, departments, and resource scopes. */
export const RBAC_PATH = 'integrations/dataops/rbac'
/** The three plaza-review switches in the DataOps settings panel. */
export const REVIEW_SETTINGS_PATH = 'integrations/dataops/review-settings'
/** Department CRUD bridge (task-67). */
export const DEPARTMENTS_PATH = 'integrations/dataops/departments'

/** One permission point in the role matrix. */
export interface PermissionPoint {
  key: string
  name: string
  group: string
  /** Backend scope metadata for the DSH capability catalogue (task-70). */
  scope?: 'department' | 'global' | string
  /** Chinese presentation note (task-76). */
  description?: string
}

/** One role row in the matrix. */
export interface RoleMatrixRow {
  code: string
  name: string
  systemKey?: string
  dataScope: 'ALL' | 'DEPARTMENT' | 'SELF' | 'CUSTOM_DEPARTMENTS' | 'DEPARTMENT_TREE'
  permissions: readonly string[]
}

/** One member and their role assignment. */
export interface MemberRow {
  userId: string
  username: string
  displayName: string
  roleCodes: readonly string[]
  departmentCode?: string
  departmentPath?: readonly { code: string; name: string }[]
  dataScope?: string
}

/** One department in the tree. */
export interface DepartmentRow {
  code: string
  name: string
  parentCode?: string
  path?: readonly { code: string; name: string }[]
  memberCount?: number
  deptAdmins?: readonly { userId: string; username: string; displayName: string }[]
  description?: string
  owner?: string
  enabled?: boolean
  updatedAt?: string
}

/** A resource scope value; `unshared` only applies to a platform built-in skill. */
export type ResourceScopeVisibility = ResourceVisibility | 'unshared'

/** One plaza skill/workflow or platform built-in skill and its visibility scope. */
export interface ResourceScopeRow {
  kind: 'skill' | 'workflow' | 'builtin'
  id: string | number
  name: string
  ownerId?: string | null
  ownerName?: string | null
  departmentCode?: string | null
  visibility: ResourceScopeVisibility
  reviewStatus?: ReviewStatus | 'unshared'
  updatedAt?: string
}

/** Everything the permission centre renders in one read. */
export interface RbacOverview {
  matrix: { roles: readonly RoleMatrixRow[]; permissions: readonly PermissionPoint[] }
  members: readonly MemberRow[]
  departments: readonly DepartmentRow[]
  resources: readonly ResourceScopeRow[]
}

/** One plaza review switch. */
export interface ReviewSettings {
  skillPlaza: boolean
  workflowPlaza: boolean
  knowledgeBase: boolean
}

/** The product defaults, used until DataOps returns its own value. */
export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  skillPlaza: true,
  workflowPlaza: true,
  knowledgeBase: true,
}

/**
 * Whether the page was opened with the demo fixture.
 *
 * The fixture exists so the review dialog and the permission matrix can be reviewed before the
 * backend contract is deployed; every fixture row is labelled and the mode is never the default.
 */
export function reviewDemoMode(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('dataopsReviewDemo') === '1'
      || window.localStorage.getItem('dataopsReviewDemo') === '1'
  } catch {
    return false
  }
}

/** Read JSON, mapping "not active" and "backend not ready" answers to null. */
async function readJson<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  })
  if (response.status === 503 || response.status === 404 || response.status === 501) return null
  if (!response.ok) throw new Error('DataOps review request failed with HTTP ' + String(response.status))
  return await response.json() as T
}

/** The backend's review-context row. */
interface ReviewContextResponse {
  userId?: string
  username?: string
  displayName?: string
  roleCodes?: string[]
  primaryRole?: string
  roles?: { code?: string; name?: string; systemKey?: string }[]
  departmentCode?: string | null
  departmentPath?: { code: string; name: string }[]
  dataScope?: { all?: boolean; self?: boolean; departmentCodes?: string[] }
  review?: { canReview?: boolean; canReviewGlobal?: boolean; canManagePermissions?: boolean; departments?: string[] }
  settings?: ReviewSettings
}

/** Read the caller's role and review capability. */
export async function fetchReviewContext(): Promise<ReviewContext | null> {
  if (reviewDemoMode()) {
    return {
      role: 'ADMIN', departmentCode: 'dept-rd', departmentPath: ['万相', '研发部'],
      canReview: true, canManagePermissions: true,
    }
  }
  const body = await readJson<ReviewContextResponse>(REVIEW_CONTEXT_PATH)
  if (body === null) return null
  const codes = Array.isArray(body.roleCodes) ? body.roleCodes : []
  // DataOps role codes are display labels ("超级管理员"); the stable key is `roles[].systemKey`.
  const primaryKey = body.roles?.find(role => role.code === body.primaryRole)?.systemKey
    ?? body.roles?.find(role => role.code !== undefined && codes.includes(role.code))?.systemKey
  const role: PortalRole = primaryKey === 'SUPER_ADMIN' || codes.includes('超级管理员')
    ? 'SUPER_ADMIN'
    : primaryKey === 'ADMIN' || codes.includes('管理员')
      ? 'ADMIN'
      : primaryKey === 'DEPT_ADMIN' || codes.includes('部门管理员')
        ? 'DEPT_ADMIN'
        : 'APP_USER'
  return {
    userId: body.userId,
    role,
    departmentCode: body.departmentCode ?? undefined,
    departmentPath: body.departmentPath?.map(entry => entry.name),
    canReview: body.review?.canReview === true || role === 'SUPER_ADMIN' || role === 'ADMIN' || role === 'DEPT_ADMIN',
    canManagePermissions: body.review?.canManagePermissions === true || role === 'SUPER_ADMIN' || role === 'ADMIN',
  }
}

/** Read the current user's notifications. */
export async function fetchNotifications(): Promise<{ items: readonly ReviewNotification[]; unread: number } | null> {
  const body = await readJson<{ items?: ReviewNotification[]; unread?: number }>(NOTIFICATIONS_PATH)
  if (body === null || !Array.isArray(body.items)) return null
  return {
    items: body.items,
    unread: typeof body.unread === 'number' ? body.unread : body.items.filter(item => !item.read).length,
  }
}

/** Mark some notifications, or every one, as read. */
export async function markNotificationsRead(ids: 'all' | readonly string[]): Promise<boolean> {
  const response = await fetch(NOTIFICATIONS_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(ids === 'all' ? { all: true } : { ids }),
  })
  return response.ok && response.status !== 503
}

/** Run the AI review for one or more resources. */
export async function scanReview(kind: 'skill' | 'workflow', ids: readonly (string | number)[]): Promise<RiskReport | null> {
  const body = await readJson<{ reports?: RiskReport[] }>(REVIEW_ACTION_PATH, {
    method: 'POST',
    body: JSON.stringify({ action: 'scan', skills: kind === 'skill' ? ids : [], workflows: kind === 'workflow' ? ids : [] }),
  })
  const report = body?.reports?.[0]
  return report !== undefined && Array.isArray(report.findings) ? report : null
}

/** Record the administrator's decision. The backend enforces the authorization flag too. */
export async function decideReview(
  kind: 'skill' | 'workflow',
  ids: readonly (string | number)[],
  decision: 'approve' | 'reject',
  note: string,
): Promise<boolean> {
  const response = await fetch(REVIEW_ACTION_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      action: 'decide',
      skills: kind === 'skill' ? ids : [],
      workflows: kind === 'workflow' ? ids : [],
      decision,
      note,
      authorization: { confirmed: true, reason: 'permission-center' },
    }),
  })
  return response.ok && response.status !== 503
}

/** Read the permission centre. */
export async function fetchRbacOverview(): Promise<RbacOverview | null> {
  if (reviewDemoMode()) {
    const { demoRbacOverview } = await import('./review-demo.ts')
    return demoRbacOverview()
  }
  const [matrix, members, departments, resources] = await Promise.all([
    readJson<{ roles?: RoleMatrixRow[]; permissions?: PermissionPoint[] }>(RBAC_PATH + '?section=matrix&scope=dsh'),
    readJson<{ items?: MemberRow[] }>(RBAC_PATH + '?section=members'),
    readJson<{ items?: DepartmentRow[] }>(RBAC_PATH + '?section=departments'),
    readJson<{ items?: ResourceScopeRow[] }>(RBAC_PATH + '?section=resources'),
  ])
  if (matrix === null || members === null || departments === null || resources === null) return null
  return {
    matrix: { roles: matrix.roles ?? [], permissions: matrix.permissions ?? [] },
    members: members.items ?? [],
    departments: departments.items ?? [],
    resources: resources.items ?? [],
  }
}

/** What a permission-centre write returned, including the backend's readable refusal. */
export interface RbacSaveResult {
  ok: boolean
  reason?: string
}

/** Persist one permission-centre section. */
export async function saveRbacSection(section: 'roles' | 'members' | 'departments' | 'resources', value: unknown): Promise<RbacSaveResult> {
  if (reviewDemoMode()) return { ok: true }
  const response = await fetch(RBAC_PATH, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ section, value }),
  })
  if (response.ok && response.status !== 503) return { ok: true }
  try {
    const body = await response.json() as { message?: unknown; details?: { reason?: unknown } }
    const reason = body.details?.reason ?? body.message
    return { ok: false, ...(typeof reason === 'string' ? { reason } : {}) }
  } catch {
    return { ok: false }
  }
}

/** Read the three plaza-review switches. */
export async function fetchReviewSettings(): Promise<ReviewSettings | null> {
  if (reviewDemoMode()) return DEFAULT_REVIEW_SETTINGS
  return await readJson<ReviewSettings>(REVIEW_SETTINGS_PATH)
}

/** Persist the three plaza-review switches. */
export async function saveReviewSettings(settings: ReviewSettings): Promise<boolean> {
  if (reviewDemoMode()) return true
  const response = await fetch(REVIEW_SETTINGS_PATH, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(settings),
  })
  return response.ok && response.status !== 503
}
/** Create one department through the same-origin bridge. */
export async function createDepartment(input: {
  code: string
  name: string
  parentCode?: string | null
  description?: string
  owner?: string
  enabled?: boolean
}): Promise<RbacSaveResult> {
  const response = await fetch(DEPARTMENTS_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(input),
  })
  return await resultOf(response)
}

/** Update one department; the Host fills `updatedAt` from the current row when omitted. */
export async function updateDepartment(input: {
  code: string
  name?: string
  parentCode?: string | null
  description?: string
  owner?: string
  enabled?: boolean
  updatedAt?: string
}): Promise<RbacSaveResult> {
  const response = await fetch(DEPARTMENTS_PATH, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(input),
  })
  return await resultOf(response)
}

/** Delete one department after the confirmation dialog. */
export async function deleteDepartment(code: string): Promise<RbacSaveResult> {
  const response = await fetch(DEPARTMENTS_PATH, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code }),
  })
  return await resultOf(response)
}

/** Map one bridge response to `{ok, reason}` so callers can show the backend text. */
async function resultOf(response: Response): Promise<RbacSaveResult> {
  if (response.ok && response.status !== 503) return { ok: true }
  try {
    const body = await response.json() as { message?: unknown; details?: { reason?: unknown } }
    const reason = body.details?.reason ?? body.message
    return { ok: false, ...(typeof reason === 'string' ? { reason } : {}) }
  } catch {
    return { ok: false }
  }
}

/** One role the caller may delegate, as `roles/visible` returns it. */
export interface VisibleRoleRow {
  code: string
  name: string
  systemKey?: string | null
  departmentScoped: boolean
  displayOrder: number
  level: number
}

/** The caller's delegation scope and the roles inside it. */
export interface VisibleRolesView {
  actorLevel: number
  departmentCodes: readonly string[]
  roles: readonly VisibleRoleRow[]
}

/** Roles the caller may grant or revoke. */
export async function fetchVisibleRoles(): Promise<VisibleRolesView | null> {
  return readJson<VisibleRolesView>(RBAC_PATH + '?section=visible-roles')
}


/** Write one RBAC mutation, surfacing the backend's reason on refusal. */
async function mutateRbac(section: string, value: Record<string, unknown>): Promise<RbacSaveResult> {
  if (reviewDemoMode()) return { ok: true }
  const response = await fetch(RBAC_PATH, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ section, value }),
  })
  if (response.ok && response.status !== 503) return { ok: true }
  try {
    const body = await response.json() as { message?: unknown; code?: unknown; details?: { reason?: unknown } }
    const reason = body.details?.reason ?? body.message ?? body.code
    return { ok: false, ...(typeof reason === 'string' ? { reason } : {}) }
  } catch {
    return { ok: false }
  }
}

/** Grant one role to a member (level/department rules are enforced by the backend). */
export async function grantMemberRole(userId: string, roleCode: string, departmentCode?: string | null): Promise<RbacSaveResult> {
  return mutateRbac('member-grant', { userId, roleCode, ...(departmentCode === undefined ? {} : { departmentCode }) })
}

/** Revoke one role from a member. */
export async function revokeMemberRole(userId: string, roleCode: string): Promise<RbacSaveResult> {
  return mutateRbac('member-revoke', { userId, roleCode })
}
