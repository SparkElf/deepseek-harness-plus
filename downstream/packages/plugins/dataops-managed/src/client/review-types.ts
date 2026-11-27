/**
 * Shared vocabulary for the review, permission and notification surfaces.
 *
 * The backend contract is landing in parallel; every field that a legacy row cannot carry
 * yet is optional here and normalized to the product default (approved/global) rather than
 * guessed per component. Keeping the rules in one place is what lets the skill plaza, the
 * permission centre and the notification bell agree on what "pending" means.
 */

/** Review state of a shared skill or workflow. */
export type ReviewStatus = 'pending' | 'approved' | 'rejected'

/** Who may see a shared resource outside its owner. */
export type ResourceVisibility = 'global' | 'department' | 'private'

/** The skill-plaza filter tabs, in display order. */
export type ReviewTab = 'approved' | 'pending' | 'all'

/** The four DataOps roles the permission centre knows. */
export type PortalRole = 'SUPER_ADMIN' | 'ADMIN' | 'DEPT_ADMIN' | 'APP_USER'

/** One node of a department ancestry path. */
export interface DepartmentPathEntry {
  code: string
  name: string
}

/** A department as a card tag needs it: code, label, and the ancestry for the tooltip. */
export interface DepartmentSummary {
  code: string
  name: string
  /** Root-first path, in either the legacy string form or the backend object form. */
  path?: readonly (string | DepartmentPathEntry)[]
}

/** One AI risk finding. */
export interface RiskFinding {
  category: string
  severity: 'low' | 'medium' | 'high'
  evidence?: string
  recommendation?: string
}

/** The AI report attached to a pending resource. */
export interface RiskReport {
  score?: number
  /** Overall severity, which is wider than a single finding's severity. */
  severity?: 'low' | 'medium' | 'high' | 'critical'
  summary?: string
  findings: readonly RiskFinding[]
  scannedAt?: string
}

/** The caller's review permissions, as the Host reports them. */
export interface ReviewContext {
  userId?: string
  role: PortalRole
  departmentCode?: string
  departmentPath?: readonly string[]
  canReview: boolean
  canManagePermissions: boolean
}

/** One notification row. */
export interface ReviewNotification {
  id: string
  type: string
  title: string
  body?: string
  resourceKind?: string
  resourceId?: string | number
  read: boolean
  createdAt: string
}

/** A reviewable row as the cards read it. */
export interface ReviewableSummary {
  reviewStatus?: ReviewStatus
  visibility?: ResourceVisibility
  departmentCode?: string | null
  departmentName?: string
  departmentPath?: readonly (string | DepartmentPathEntry)[]
  riskReport?: RiskReport | null
  reviewNote?: string | null
  submittedAt?: string
}

/** Treat a missing status as approved: rows written before the review state existed were live. */
export function normalizeReviewStatus(value: unknown): ReviewStatus {
  return value === 'pending' || value === 'rejected' || value === 'approved' ? value : 'approved'
}

/** Treat a missing visibility as global: a shared row with no scope was visible to everyone. */
export function normalizeVisibility(value: unknown): ResourceVisibility {
  return value === 'department' || value === 'private' ? value : 'global'
}

/** The resource-scope facts the permission centre needs to decide button availability. */
export interface ResourceScopeSubject {
  kind: 'skill' | 'workflow' | 'builtin'
  visibility: 'global' | 'department' | 'private' | 'unshared'
  departmentCode?: string | null
}

/**
 * Whether this actor may edit one resource-scope row.
 *
 * Mirrors the backend policy: built-in skills are super-administrator only, global skills
 * belong to administrators, and a department administrator edits department rows in their
 * subtree (the list itself is already narrowed to that subtree).
 * @param subject - the row's kind and current scope.
 * @param actorRole - the caller's portal role.
 * @returns the decision and, when denied, the reason shown on the disabled control.
 */
export function canEditResourceScopeRow(
  subject: ResourceScopeSubject,
  actorRole: PortalRole,
): { allowed: boolean; reason?: string } {
  if (subject.kind === 'builtin') {
    return actorRole === 'SUPER_ADMIN'
      ? { allowed: true }
      : { allowed: false, reason: '只有超级管理员可以修改内置技能的可见范围。' }
  }
  if (actorRole === 'SUPER_ADMIN' || actorRole === 'ADMIN') return { allowed: true }
  if (actorRole !== 'DEPT_ADMIN') return { allowed: false, reason: '没有修改资源范围的权限。' }
  if (subject.visibility !== 'department' || subject.departmentCode === null || subject.departmentCode === undefined) {
    return { allowed: false, reason: '部门管理员只能修改本部门的技能。' }
  }
  return { allowed: true }
}

/** Whether the caller may see and act on the review queue. */
export function canReview(context: ReviewContext | null | undefined): boolean {
  if (context === null || context === undefined) return false
  return context.canReview || context.role === 'SUPER_ADMIN' || context.role === 'ADMIN' || context.role === 'DEPT_ADMIN'
}

/** Whether the caller may open the permission centre's write controls. */
export function canManagePermissions(context: ReviewContext | null | undefined): boolean {
  if (context === null || context === undefined) return false
  return context.canManagePermissions || context.role === 'SUPER_ADMIN' || context.role === 'ADMIN'
}

/**
 * The tabs this caller may see.
 *
 * A department administrator sees the queue too, but the Host narrows it to their subtree;
 * an ordinary user gets only the approved list, and no tab strip at all when there is one tab.
 */
export function reviewTabsFor(context: ReviewContext | null | undefined): readonly ReviewTab[] {
  if (!canReview(context)) return ['approved']
  return ['approved', 'pending', 'all']
}

/** Filter rows by the selected review tab. */
export function filterByReview<T extends ReviewableSummary>(rows: readonly T[], tab: ReviewTab): readonly T[] {
  if (tab === 'all') return rows
  return rows.filter(row => normalizeReviewStatus(row.reviewStatus) === tab)
}

/** Counts for the tab labels. */
export function reviewCounts(rows: readonly ReviewableSummary[]): Record<ReviewTab, number> {
  const counts: Record<ReviewTab, number> = { approved: 0, pending: 0, all: rows.length }
  for (const row of rows) {
    const status = normalizeReviewStatus(row.reviewStatus)
    if (status === 'pending') counts.pending += 1
    else if (status === 'rejected') counts.all += 0
    else counts.approved += 1
  }
  return counts
}

/** The status badge shown on a local skill card. */
export function reviewStatusLabel(status: ReviewStatus): string {
  switch (status) {
    case 'pending': return '待审核'
    case 'rejected': return '已驳回'
    default: return '已上架'
  }
}

/**
 * The visibility tag in a card's top-right corner.
 *
 * A department tag names the department and keeps the full path in the tooltip; a global tag
 * is one word because it is the default and should not compete with the skill name.
 */
/** Read a department path from either the legacy string form or the backend object form. */
export function departmentPathNames(path: ReviewableSummary['departmentPath']): string[] {
  if (path === undefined) return []
  return path.map(entry => typeof entry === 'string' ? entry : entry.name)
}

export function visibilityTag(row: ReviewableSummary): { label: string; detail: string } {
  const visibility = normalizeVisibility(row.visibility)
  if (visibility === 'private') return { label: '私有', detail: '仅自己可见' }
  if (visibility === 'global') return { label: '全局', detail: '所有已登录用户可见' }
  const path = departmentPathNames(row.departmentPath)
  const name = row.departmentName ?? path.at(-1) ?? row.departmentCode ?? '部门'
  return { label: name + '部门专属', detail: path.length === 0 ? name : path.join(' / ') }
}

/** Unread count for a bell badge. */
export function unreadCount(items: readonly ReviewNotification[]): number {
  return items.reduce((total, item) => total + (item.read ? 0 : 1), 0)
}

/** Newest first. Read state never reorders rows, so marking one read cannot move it to another page. */
export function sortNotifications(items: readonly ReviewNotification[]): readonly ReviewNotification[] {
  return [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

/** The tab a notification should open, when its resource has one. */
export function notificationTab(item: ReviewNotification): ReviewTab | undefined {
  if (item.type === 'submitted' || item.type === 'review_pending' || item.type === 'ai_report_ready' || item.type === 'ai_report') return 'pending'
  if (item.type === 'approved' || item.type === 'published' || item.type === 'shared') return 'approved'
  return undefined
}