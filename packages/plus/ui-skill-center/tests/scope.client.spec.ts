/**
 * Visibility rules for publishing: admins may pick global/any department;
 * department admins and ordinary users may only use their own department or
 * private; a saved global choice is dropped for anyone without global rights.
 */
import { describe, expect, it } from 'vitest'
import {
  allowedVisibilities, defaultVisibility, readSavedScope, sanitizeChoice, scopeRole,
  scopeStorageKey, writeSavedScope, type ReviewScope,
} from '../src/client/scope.ts'

const admin: ReviewScope = { canReview: true, canReviewGlobal: true, departmentCode: 'D0', departmentPath: [{ code: 'D0', name: '总部' }] }
const deptAdmin: ReviewScope = { canReview: true, canReviewGlobal: false, departmentCode: 'D1', departmentPath: [{ code: 'D1', name: '数据部' }] }
const user: ReviewScope = { canReview: false, canReviewGlobal: false, departmentCode: 'D1', departmentPath: [{ code: 'D1', name: '数据部' }] }
const users = [admin, deptAdmin, user]
const departments = [{ code: 'D0', name: '总部' }, { code: 'D1', name: '数据部' }, { code: 'D2', name: '市场部' }]

describe('scope roles and options', () => {
  it('classifies admin / department admin / user from review context', () => {
    expect(users.map(scopeRole)).toEqual(['admin', 'dept-admin', 'user'])
  })

  it('shows global only to admins', () => {
    expect(allowedVisibilities(admin)).toEqual(['global', 'department', 'private'])
    expect(allowedVisibilities(deptAdmin)).toEqual(['department', 'private'])
    expect(allowedVisibilities(user)).toEqual(['department', 'private'])
    expect(allowedVisibilities({ canReviewGlobal: false, departmentCode: null })).toEqual(['private'])
  })

  it('defaults admins to global and others to their department', () => {
    expect(defaultVisibility(admin)).toBe('global')
    expect(defaultVisibility(deptAdmin)).toBe('department')
    expect(defaultVisibility(user)).toBe('department')
    expect(defaultVisibility({ canReview: false, departmentCode: null })).toBe('private')
  })
})

describe('saved choice', () => {
  it('drops a saved global choice for a non-admin and keeps their own department', () => {
    expect(sanitizeChoice({ visibility: 'global' }, deptAdmin, departments)).toEqual({
      visibility: 'department', departmentCode: 'D1',
    })
  })

  it('keeps an admin department only when it exists in the fetched tree', () => {
    expect(sanitizeChoice({ visibility: 'department', departmentCode: 'D2' }, admin, departments))
      .toEqual({ visibility: 'department', departmentCode: 'D2' })
    expect(sanitizeChoice({ visibility: 'department', departmentCode: 'gone' }, admin, departments))
      .toEqual({ visibility: 'department', departmentCode: 'D0' })
  })

  it('reads and writes per-user JSON safely', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
    const key = scopeStorageKey({ id: 'u1' })
    expect(readSavedScope(storage, key)).toBeUndefined()
    writeSavedScope(storage, key, { visibility: 'private' })
    expect(readSavedScope(storage, key)).toEqual({ visibility: 'private' })
    store.set(key, '{broken')
    expect(readSavedScope(storage, key)).toBeUndefined()
  })
})
