import { describe, expect, it } from 'vitest'
import {
  checkSuperAdmin, interpretLogin, isSessionExpired, readRoleNames, REQUIRED_ROLE,
} from '../scripts/lib/auth.mjs'

describe('interpreting a login response', () => {
  it('reads the access token out of a success', () => {
    const outcome = interpretLogin(200, { accessToken: 'abc.def.ghi', user: { username: 'admin' } })
    expect(outcome.kind).toBe('ok')
    expect(outcome.accessToken).toBe('abc.def.ghi')
    expect(outcome.user.username).toBe('admin')
  })

  it('treats an MFA challenge as its own outcome, not a success', () => {
    // A 200 carrying `mfaRequired` has NO token: proceeding would use undefined.
    const outcome = interpretLogin(200, { mfaRequired: true, methods: ['totp'] })
    expect(outcome.kind).toBe('mfa')
    expect(outcome.methods).toEqual(['totp'])
  })

  it('survives an MFA response that omits the method list', () => {
    const outcome = interpretLogin(200, { mfaRequired: true })
    expect(outcome.kind).toBe('mfa')
    expect(outcome.methods).toEqual([])
  })

  it('refuses a 200 that carries no token', () => {
    const outcome = interpretLogin(200, { user: { username: 'x' } })
    expect(outcome.kind).toBe('rejected')
    expect(outcome.message).toContain('accessToken')
  })

  it('surfaces the backend message on a rejection', () => {
    const outcome = interpretLogin(401, { message: '账号或密码错误' })
    expect(outcome.kind).toBe('rejected')
    expect(outcome.message).toBe('账号或密码错误')
  })

  it('joins an array-shaped validation message', () => {
    const outcome = interpretLogin(400, { message: ['password must be longer', 'account required'] })
    expect(outcome.message).toBe('password must be longer; account required')
  })

  it('falls back to the status when there is no body', () => {
    expect(interpretLogin(502, undefined).message).toBe('HTTP 502')
  })
})

describe('reading role names off a session', () => {
  it('accepts objects with a name', () => {
    expect(readRoleNames({ roles: [{ name: REQUIRED_ROLE }] })).toEqual([REQUIRED_ROLE])
  })

  it('accepts objects with only a code', () => {
    expect(readRoleNames({ roles: [{ code: REQUIRED_ROLE }] })).toEqual([REQUIRED_ROLE])
  })

  it('accepts a plain string array', () => {
    expect(readRoleNames({ roles: [REQUIRED_ROLE] })).toEqual([REQUIRED_ROLE])
  })

  it('accepts the roleCodes field as well', () => {
    expect(readRoleNames({ roleCodes: [REQUIRED_ROLE] })).toEqual([REQUIRED_ROLE])
  })

  it('deduplicates and tolerates a missing user', () => {
    expect(readRoleNames({ roles: [REQUIRED_ROLE, REQUIRED_ROLE] })).toEqual([REQUIRED_ROLE])
    expect(readRoleNames(undefined)).toEqual([])
  })
})

describe('the super-admin gate', () => {
  it('allows 超级管理员', () => {
    const result = checkSuperAdmin({ roles: [{ name: REQUIRED_ROLE }] })
    expect(result.allowed).toBe(true)
  })

  it('refuses 管理员 even though the backend grants it the same permissions', () => {
    // This is the user's requirement, which is narrower than the backend's policy.
    const result = checkSuperAdmin({ roles: [{ name: '管理员' }] })
    expect(result.allowed).toBe(false)
    expect(result.message).toContain('管理员')
    expect(result.message).toContain(REQUIRED_ROLE)
  })

  it('names the role it found so the refusal is actionable', () => {
    const result = checkSuperAdmin({ roles: [{ name: '运营人员' }] })
    expect(result.allowed).toBe(false)
    expect(result.message).toContain('运营人员')
  })

  it('explains when the found role is a management role the script still refuses', () => {
    const result = checkSuperAdmin({ roles: [{ name: '管理员' }] })
    expect(result.message).toContain('后端也有管理权限')
  })

  it('refuses an account that reports no roles at all', () => {
    const result = checkSuperAdmin({})
    expect(result.allowed).toBe(false)
    expect(result.message).toContain('未报告角色')
  })

  it('allows a super admin who holds other roles too', () => {
    const result = checkSuperAdmin({ roles: [{ name: '运营人员' }, { name: REQUIRED_ROLE }] })
    expect(result.allowed).toBe(true)
  })
})

describe('expired-session detection', () => {
  it('flags 401 so the caller reports instead of retrying', () => {
    // Repeating a password login on every 401 looks like spraying to the rate limiter.
    expect(isSessionExpired(401)).toBe(true)
    expect(isSessionExpired(403)).toBe(false)
    expect(isSessionExpired(200)).toBe(false)
  })
})
