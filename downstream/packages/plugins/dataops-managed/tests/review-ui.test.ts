import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canEditResourceScopeRow,
  canManagePermissions,
  canReview,
  filterByReview,
  normalizeReviewStatus,
  normalizeVisibility,
  notificationTab,
  reviewCounts,
  reviewTabsFor,
  sortNotifications,
  unreadCount,
  visibilityTag,
} from '../src/client/review-types.ts'
import type { ReviewContext, ReviewNotification } from '../src/client/review-types.ts'
import { canSeeManagedSettings, currentManagedSettingsRole } from '../src/client/settings-gate.ts'

const admin: ReviewContext = { role: 'ADMIN', canReview: true, canManagePermissions: true }
const deptAdmin: ReviewContext = { role: 'DEPT_ADMIN', canReview: true, canManagePermissions: false }
const user: ReviewContext = { role: 'APP_USER', canReview: false, canManagePermissions: false }

afterEach(() => { vi.unstubAllGlobals() })

describe('review state and permissions', () => {
  it('treats a row written before the state machine as approved and global', () => {
    expect(normalizeReviewStatus(undefined)).toBe('approved')
    expect(normalizeReviewStatus('pending')).toBe('pending')
    expect(normalizeVisibility(undefined)).toBe('global')
    expect(normalizeVisibility('private')).toBe('private')
  })

  it('gives administrators three tabs and ordinary users only the approved list', () => {
    expect(reviewTabsFor(admin)).toEqual(['approved', 'pending', 'all'])
    expect(reviewTabsFor(deptAdmin)).toEqual(['approved', 'pending', 'all'])
    expect(reviewTabsFor(user)).toEqual(['approved'])
    expect(canReview(deptAdmin)).toBe(true)
    expect(canReview(user)).toBe(false)
    expect(canManagePermissions(deptAdmin)).toBe(false)
    expect(canManagePermissions(admin)).toBe(true)
  })

  it('counts and filters without inventing a rejected tab', () => {
    const rows = [
      { reviewStatus: 'approved' as const },
      { reviewStatus: 'pending' as const },
      { reviewStatus: 'rejected' as const },
      {},
    ]
    expect(reviewCounts(rows)).toEqual({ approved: 2, pending: 1, all: 4 })
    expect(filterByReview(rows, 'approved')).toHaveLength(2)
    expect(filterByReview(rows, 'pending')).toHaveLength(1)
    expect(filterByReview(rows, 'all')).toHaveLength(4)
  })

  it('gates resource-scope editing by row category and role', () => {
    const builtin = { kind: 'builtin' as const, visibility: 'unshared' as const, departmentCode: null }
    expect(canEditResourceScopeRow(builtin, 'SUPER_ADMIN').allowed).toBe(true)
    expect(canEditResourceScopeRow(builtin, 'ADMIN').allowed).toBe(false)
    expect(canEditResourceScopeRow(builtin, 'DEPT_ADMIN').allowed).toBe(false)

    const global = { kind: 'skill' as const, visibility: 'global' as const, departmentCode: null }
    expect(canEditResourceScopeRow(global, 'SUPER_ADMIN').allowed).toBe(true)
    expect(canEditResourceScopeRow(global, 'ADMIN').allowed).toBe(true)
    expect(canEditResourceScopeRow(global, 'DEPT_ADMIN').allowed).toBe(false)

    const department = { kind: 'skill' as const, visibility: 'department' as const, departmentCode: 'crm-ops' }
    expect(canEditResourceScopeRow(department, 'DEPT_ADMIN').allowed).toBe(true)
    expect(canEditResourceScopeRow(department, 'APP_USER').allowed).toBe(false)
    // A department admin never edits a personal/private row.
    expect(canEditResourceScopeRow({ ...department, visibility: 'private' as const }, 'DEPT_ADMIN').allowed).toBe(false)
  })

  it('labels visibility with the department path in the tooltip', () => {
    expect(visibilityTag({ visibility: 'global' }).label).toBe('全局')
    expect(visibilityTag({ visibility: 'private' }).label).toBe('私有')
    const dept = visibilityTag({
      visibility: 'department',
      departmentPath: [{ code: 'root', name: '万相' }, { code: 'rd', name: '研发部' }],
    })
    expect(dept.label).toBe('研发部部门专属')
    expect(dept.detail).toBe('万相 / 研发部')
  })
})

describe('notification inbox', () => {
  const rows: ReviewNotification[] = [
    { id: 'read', type: 'approved', title: '已读', read: true, createdAt: '2026-10-22T10:00:00Z' },
    { id: 'unread-old', type: 'submitted', title: '未读旧', read: false, createdAt: '2026-10-21T10:00:00Z' },
    { id: 'unread-new', type: 'ai_report_ready', title: '未读新', read: false, createdAt: '2026-10-23T10:00:00Z' },
  ]

  it('counts unread and sorts unread first, newest first', () => {
    expect(unreadCount(rows)).toBe(2)
    expect(sortNotifications(rows).map(row => row.id)).toEqual(['unread-new', 'read', 'unread-old'])
  })

  it('maps a notification to the review tab it should open', () => {
    expect(notificationTab(rows[1]!)).toBe('pending')
    expect(notificationTab(rows[2]!)).toBe('pending')
    expect(notificationTab(rows[0]!)).toBe('approved')
  })
})

describe('managed settings role gate', () => {
  it('accepts exactly the two administrator labels', () => {
    vi.stubGlobal('window', { __DATAOPS_USER__: { name: '超级管理员' } })
    expect(canSeeManagedSettings()).toBe(true)
    vi.stubGlobal('window', { __DATAOPS_USER__: { name: '管理员' } })
    expect(canSeeManagedSettings()).toBe(true)
    vi.stubGlobal('window', { __DATAOPS_USER__: { name: '管理员助理' } })
    expect(canSeeManagedSettings()).toBe(false)
    vi.stubGlobal('window', { __DATAOPS_USER__: { name: '应用人员' } })
    expect(canSeeManagedSettings()).toBe(false)
    expect(currentManagedSettingsRole()).toBe('应用人员')
  })

  it('stays closed before the identity record arrives', () => {
    vi.stubGlobal('window', {})
    expect(canSeeManagedSettings()).toBe(false)
  })
})
