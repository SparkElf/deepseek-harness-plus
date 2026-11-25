import { describe, expect, it } from 'vitest'
import { isAdminScope, isScopeActor, normalizeScope } from '../../src/auth.ts'
import { sanitizeBotRecord } from '../../src/gating.ts'

describe('isAdminScope', () => {
  it('grants the explicit DataOps permission', () => {
    expect(isAdminScope({ roleCodes: ['应用人员'], permissions: ['system:im:manage'] })).toBe(true)
  })

  it('denies an ordinary permission set', () => {
    expect(isAdminScope({ roleCodes: ['应用人员'], permissions: [] })).toBe(false)
    expect(isAdminScope({ roleCodes: ['应用人员'], permissions: ['skill:read'] })).toBe(false)
  })

  it('accepts stable administrator role keys and display names', () => {
    expect(isAdminScope({ roleCodes: ['管理员'], permissions: [] })).toBe(true)
    expect(isAdminScope({ roleCodes: ['应用人员'], systemKeys: ['ADMIN'], permissions: [] })).toBe(true)
    expect(isAdminScope({ roleCodes: ['应用人员'], primaryRole: 'SUPER_ADMIN', permissions: [] })).toBe(true)
  })

  it('denies an absent scope', () => {
    expect(isAdminScope(undefined)).toBe(false)
  })
})

describe('normalizeScope', () => {
  it('requires roleCodes and carries permissions', () => {
    expect(normalizeScope({ roleCodes: ['管理员'], permissions: ['system:im:manage'], userId: 'u1' }))
      .toMatchObject({ roleCodes: ['管理员'], permissions: ['system:im:manage'], userId: 'u1' })
    expect(normalizeScope({ permissions: ['system:im:manage'] })).toBeUndefined()
    expect(normalizeScope(null)).toBeUndefined()
  })

  it('accepts the older permissionKeys spelling', () => {
    expect(normalizeScope({ roleCodes: [], permissionKeys: ['system:im:manage'] })?.permissions)
      .toEqual(['system:im:manage'])
  })
})

describe('isScopeActor', () => {
  it('recognizes a DataOps scope and rejects unrelated values', () => {
    expect(isScopeActor({ permissions: [] })).toBe(true)
    expect(isScopeActor({ userId: 'u1' })).toBe(true)
    expect(isScopeActor({ unrelated: true })).toBe(false)
    expect(isScopeActor(null)).toBe(false)
  })
})

describe('sanitizeBotRecord', () => {
  it('removes every credential-shaped field', () => {
    const record = sanitizeBotRecord({
      id: 'b1',
      name: 'bot',
      secret: 's3cret',
      botSecret: 's3cret',
      accessToken: 't',
      password: 'p',
      privateKey: 'k',
      secretConfigured: true,
    })
    expect(record).toEqual({ id: 'b1', name: 'bot', secretConfigured: true })
  })
})