/**
 * Visibility choices for publishing a skill to the plaza.
 *
 * DataOps owns roles and department membership; this module only maps the
 * review-context answer to the options a given account may pick, and remembers
 * the last choice per user. The backend still enforces every rule.
 *
 * @module @sparkelf/dsh-client-ui-skill-center/client/scope
 */

/** Plaza visibility. */
export type PlazaVisibility = 'global' | 'department' | 'private'

/** Presentation-only DataOps identity used for the per-user memory key. */
export interface AccountIdentity {
  id?: string
  username?: string
  displayName?: string
}

/** Read the identity the dataops-account plugin publishes. */
export function readAccountIdentity(): AccountIdentity | undefined {
  if (typeof window === 'undefined') return undefined
  const fromWindow = (window as { __DATAOPS_USER__?: AccountIdentity }).__DATAOPS_USER__
  if (fromWindow !== undefined) return fromWindow
  if (typeof document === 'undefined') return undefined
  const dataset = document.documentElement.dataset
  if (dataset.dataopsAccountId === undefined && dataset.dataopsAccountName === undefined) return undefined
  const identity: AccountIdentity = {}
  if (dataset.dataopsAccountId !== undefined) identity.id = dataset.dataopsAccountId
  if (dataset.dataopsAccountName !== undefined) identity.displayName = dataset.dataopsAccountName
  return identity
}

/** One department node. */
export interface Department {
  code: string
  name: string
  parentCode?: string | null
}

/** The subset of `/api/ai/review/context` this panel reads. */
export interface ReviewScope {
  canReview?: boolean
  canReviewGlobal?: boolean
  departmentCode?: string | null
  departmentPath?: readonly Department[]
  roleCodes?: readonly string[]
  primaryRole?: string
}

/** Who is publishing, from the backend's point of view. */
export type ScopeRole = 'admin' | 'dept-admin' | 'user'

/** The remembered visibility choice. */
export interface SavedScope {
  visibility: PlazaVisibility
  departmentCode?: string
}

/** Classify the caller: global review means super admin/admin; review means department admin. */
export function scopeRole(scope: ReviewScope | undefined): ScopeRole {
  if (scope?.canReviewGlobal === true) return 'admin'
  if (scope?.canReview === true) return 'dept-admin'
  return 'user'
}

/** Visibilities this caller may select. */
export function allowedVisibilities(scope: ReviewScope | undefined): PlazaVisibility[] {
  const role = scopeRole(scope)
  if (role === 'admin') return ['global', 'department', 'private']
  if (hasDepartment(scope)) return ['department', 'private']
  return ['private']
}

/** Whether the caller belongs to a department (needed for department visibility). */
export function hasDepartment(scope: ReviewScope | undefined): boolean {
  return typeof scope?.departmentCode === 'string' && scope.departmentCode !== ''
}

/** First-run default: admins publish globally, everyone else to their department, else private. */
export function defaultVisibility(scope: ReviewScope | undefined): PlazaVisibility {
  const role = scopeRole(scope)
  if (role === 'admin') return 'global'
  return hasDepartment(scope) ? 'department' : 'private'
}

/** The caller's own department code. */
export function ownDepartment(scope: ReviewScope | undefined): string | undefined {
  const code = scope?.departmentCode
  return typeof code === 'string' && code !== '' ? code : undefined
}

/**
 * Coerce a remembered choice into one this caller may still make.
 *
 * A saved global choice is dropped for a non-admin; a saved department code is
 * kept only when it is the caller's own department (department admins/users)
 * or still present in the admin's fetched department list.
 */
export function sanitizeChoice(
  saved: SavedScope | undefined,
  scope: ReviewScope | undefined,
  departments: readonly Department[] = [],
): SavedScope {
  const allowed = allowedVisibilities(scope)
  const visibility = saved !== undefined && allowed.includes(saved.visibility)
    ? saved.visibility
    : defaultVisibility(scope)
  if (visibility !== 'department') return { visibility }
  const role = scopeRole(scope)
  if (role === 'admin') {
    const savedCode = saved?.departmentCode
    if (savedCode !== undefined && departments.some(department => department.code === savedCode)) {
      return { visibility, departmentCode: savedCode }
    }
    const code = ownDepartment(scope) ?? departments[0]?.code
    return code === undefined ? { visibility } : { visibility, departmentCode: code }
  }
  const code = ownDepartment(scope)
  return code === undefined ? { visibility } : { visibility, departmentCode: code }
}

/** localStorage key, per DataOps user. */
export function scopeStorageKey(identity: { id?: string; username?: string } | undefined): string {
  return 'dsh-skill-center:plaza-scope:' + (identity?.id ?? identity?.username ?? 'anonymous')
}

/** Read a remembered choice (invalid JSON is treated as no choice). */
export function readSavedScope(storage: Pick<Storage, 'getItem'>, key: string): SavedScope | undefined {
  try {
    const raw = storage.getItem(key)
    if (raw === null || raw === '') return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const value = parsed as { visibility?: unknown; departmentCode?: unknown }
    if (value.visibility !== 'global' && value.visibility !== 'department' && value.visibility !== 'private') return undefined
    return {
      visibility: value.visibility,
      ...(typeof value.departmentCode === 'string' && value.departmentCode !== '' ? { departmentCode: value.departmentCode } : {}),
    }
  } catch {
    return undefined
  }
}

/** Persist one choice. */
export function writeSavedScope(storage: Pick<Storage, 'setItem'>, key: string, choice: SavedScope): void {
  try { storage.setItem(key, JSON.stringify(choice)) } catch { /* private mode/quota: remembering is best-effort */ }
}
