import { describe, expect, it } from 'vitest'
import { ACTIONS, API_PREFIX, findAction, planAction } from '../scripts/lib/actions.mjs'

describe('the action whitelist', () => {
  it('exposes exactly the five reviewed actions', () => {
    // A closed list is the point: no "send this request" escape hatch exists.
    expect(Object.keys(ACTIONS).sort()).toEqual([
      'create-user', 'list-roles', 'list-users', 'reset-password', 'set-roles',
    ])
  })

  it('has no delete action', () => {
    expect(Object.keys(ACTIONS).some(name => name.includes('delete'))).toBe(false)
  })

  it('marks reads and writes distinctly', () => {
    expect(ACTIONS['list-users'].kind).toBe('read')
    expect(ACTIONS['list-roles'].kind).toBe('read')
    expect(ACTIONS['create-user'].kind).toBe('write')
    expect(ACTIONS['set-roles'].kind).toBe('write')
    expect(ACTIONS['reset-password'].kind).toBe('write')
  })

  it('gives every action a summary naming its intent', () => {
    for (const action of Object.values(ACTIONS)) {
      expect(action.summary.length).toBeGreaterThan(10)
    }
  })

  it('refuses an unknown verb and lists what is available', () => {
    expect(() => findAction('delete-user')).toThrow(/未知动作/u)
    expect(() => findAction('delete-user')).toThrow(/list-users/u)
  })
})

describe('request planning matches the backend controllers', () => {
  it('uses the /api global prefix', () => {
    expect(API_PREFIX).toBe('/api')
  })

  it('lists users with no query when no filters are given', () => {
    expect(ACTIONS['list-users'].plan({})).toEqual({ method: 'GET', path: '/system/users' })
  })

  it('passes only the filters that were supplied', () => {
    const plan = ACTIONS['list-users'].plan({ search: '张', role: '管理员' })
    expect(plan.path).toContain('search=%E5%BC%A0')
    expect(plan.path).toContain(`roleCode=${encodeURIComponent('管理员')}`)
    expect(plan.path).not.toContain('departmentCode')
  })

  it('builds the create body with the required fields only', () => {
    const plan = ACTIONS['create-user'].plan({
      username: 'ops', 'display-name': 'Ops', email: 'o@e.invalid',
      department: 'data-platform', roles: ['管理员'], 'new-password': 'S3cret!Pass',
    })
    expect(plan.method).toBe('POST')
    expect(plan.path).toBe('/system/users')
    expect(plan.body).toEqual({
      username: 'ops',
      displayName: 'Ops',
      email: 'o@e.invalid',
      departmentCode: 'data-platform',
      roleCodes: ['管理员'],
      password: 'S3cret!Pass',
    })
    // Optional fields stay absent rather than being sent as null.
    expect('phone' in plan.body).toBe(false)
  })

  it('carries an optional phone when given', () => {
    const plan = ACTIONS['create-user'].plan({
      username: 'ops', 'display-name': 'Ops', email: 'o@e.invalid',
      department: 'd', roles: ['管理员'], 'new-password': 'S3cret!Pass', phone: '+86 138',
    })
    expect(plan.body.phone).toBe('+86 138')
  })

  it('names the missing flag instead of sending an incomplete body', () => {
    expect(() => ACTIONS['create-user'].plan({ username: 'ops' })).toThrow(/--display-name/u)
    expect(() => ACTIONS['set-roles'].plan({ 'user-id': 'u1' })).toThrow(/--roles/u)
  })

  it('refuses an empty role list', () => {
    expect(() => ACTIONS['set-roles'].plan({ 'user-id': 'u1', roles: [] })).toThrow(/--roles/u)
  })

  it('patches the user with a role array, as the controller expects', () => {
    const plan = ACTIONS['set-roles'].plan({ 'user-id': 'usr-42', roles: ['管理员', '运营人员'] })
    expect(plan.method).toBe('PATCH')
    expect(plan.path).toBe('/system/users/usr-42')
    expect(plan.body).toEqual({ roleCodes: ['管理员', '运营人员'] })
  })

  it('encodes a user id that needs escaping', () => {
    expect(ACTIONS['set-roles'].plan({ 'user-id': 'a/b', roles: ['x'] }).path).toBe('/system/users/a%2Fb')
  })

  it('posts the reset with the optimistic-lock stamp the backend requires', () => {
    const plan = ACTIONS['reset-password'].plan({
      'user-id': 'usr-42', 'new-password': 'An0ther!Pass', 'updated-at': '2026-10-22T03:00:00.000Z',
    })
    expect(plan.method).toBe('POST')
    expect(plan.path).toBe('/system/users/usr-42/password/reset')
    expect(plan.body).toEqual({ updatedAt: '2026-10-22T03:00:00.000Z', password: 'An0ther!Pass' })
  })

  it('requires the updated-at stamp rather than inventing one', () => {
    expect(() => ACTIONS['reset-password'].plan({ 'user-id': 'u1', 'new-password': 'x' }))
      .toThrow(/--updated-at/u)
  })
})

describe('the write-confirmation rule', () => {
  const createOptions = {
    username: 'ops', 'display-name': 'Ops', email: 'o@e.invalid',
    department: 'd', roles: ['管理员'], 'new-password': 'S3cret!Pass',
  }

  it('lets a read action run without --yes', () => {
    expect(planAction('list-users', {}, {}).confirmed).toBe(true)
  })

  it('holds a write action until --yes is given', () => {
    // The guard that makes an accidental create-user impossible.
    expect(planAction('create-user', createOptions, {}).confirmed).toBe(false)
    expect(planAction('create-user', createOptions, { yes: true }).confirmed).toBe(true)
  })

  it('still returns the plan when unconfirmed, so it can be previewed', () => {
    const planned = planAction('create-user', createOptions, {})
    expect(planned.plan.method).toBe('POST')
    expect(planned.plan.body.username).toBe('ops')
  })
})
