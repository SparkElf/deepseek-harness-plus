/**
 * Administrator user tools: lookup, create and role assignment.
 *
 * These cases drive the tool bodies directly so the approval, request shape and response
 * projection are pinned without depending on a live DataOps. Disclosure is tested separately
 * below because it is a scope decision, not an execution decision.
 *
 * @module tests/user-tools.test
 */

import { describe, expect, it } from 'vitest'
import { buildAiManagementTools } from '../src/tools.ts'
import { isToolVisible, type DataOpsScope } from '../src/tool-scope.ts'

type Tool = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }

const ADMIN: DataOpsScope = {
  userId: 'admin-user',
  username: 'admin',
  roleCodes: ['管理员'],
  primaryRole: '管理员',
  permissions: ['system:user:read', 'system:user:create', 'system:user:update'],
}

const DEPARTMENT_ADMIN: DataOpsScope = {
  userId: 'dept-admin',
  username: 'dept',
  roleCodes: ['部门管理员'],
  primaryRole: '部门管理员',
  permissions: ['system:user:read', 'system:user:update'],
}

const MEMBER: DataOpsScope = {
  userId: 'member',
  roleCodes: ['应用人员'],
  primaryRole: '应用人员',
  permissions: [],
}

function setup(routes: Record<string, unknown> = {}, outcome = 'allowed-once') {
  const calls: Array<{ path: string; method: string; body?: string }> = []
  const approvals: Array<{ toolName: string; reason: string }> = []
  const audits: string[] = []
  const api = {
    request: async (path: string, init: RequestInit = {}) => {
      calls.push({
        path,
        method: init.method ?? 'GET',
        ...(typeof init.body === 'string' ? { body: init.body } : {}),
      })
      return routes[path] ?? routes['*'] ?? { status: 404, body: { error: 'not found' } }
    },
  }
  const ctx = {
    approval: {
      request: async (input: { toolName: string; reason: string }) => {
        approvals.push(input)
        return outcome
      },
    },
    logger: { info: (line: string) => { audits.push(line) }, warn: () => {}, error: () => {} },
  }
  const tools = new Map<string, Tool>(
    buildAiManagementTools(ctx as never, api as never, () => ADMIN, { subscribe: () => () => undefined } as never)
      .map(tool => [tool.name, tool.definition as unknown as Tool]),
  )
  const exec = { agent: { session: { id: 's1' } }, callId: 'call-1', signal: new AbortController().signal }
  return { tools, calls, approvals, audits, exec }
}

describe('dataops_user_lookup', () => {
  it('queries by WeCom userid and projects only the promised fields', async () => {
    const f = setup({
      '/api/system/users?wecomUserId=wecom-001&page=1&pageSize=100': {
        status: 200,
        body: {
          items: [{
            id: 'u-1',
            username: 'employee.one',
            displayName: '员工一',
            email: 'one@example.com',
            phone: '+86 138-0000-0001',
            enabled: true,
            department: { code: 'data-platform', name: '数据平台' },
            roles: [{ code: '应用人员', name: '应用人员' }],
            permissions: ['secret:not:returned'],
            passwordHash: 'must-not-leak',
          }],
          total: 1,
        },
      },
    })
    const value = await f.tools.get('dataops_user_lookup')!.execute({ wecom_user_id: 'wecom-001' }, f.exec) as {
      users: Array<Record<string, unknown>>
      count: number
    }
    expect(value.count).toBe(1)
    expect(value.users[0]).toMatchObject({
      id: 'u-1',
      username: 'employee.one',
      displayName: '员工一',
      email: 'one@example.com',
      mobile: '+86 138-0000-0001',
      enabled: true,
      departments: [{ code: 'data-platform', name: '数据平台' }],
      roles: [{ code: '应用人员', name: '应用人员' }],
    })
    expect(JSON.stringify(value)).not.toContain('passwordHash')
    expect(JSON.stringify(value)).not.toContain('must-not-leak')
    expect(JSON.stringify(value)).not.toContain('secret:not:returned')
    expect(f.approvals).toHaveLength(0)
  })

  it('filters by username, email, mobile and display name', async () => {
    const f = setup({
      '*': {
        status: 200,
        body: {
          items: [
            { id: 'u-1', username: 'alice', displayName: 'Alice Zhang', email: 'alice@example.com', phone: '+86 138-0000-0001', enabled: true, roles: [] },
            { id: 'u-2', username: 'bob', displayName: 'Bob Li', email: 'bob@example.com', phone: '13900000002', enabled: false, roles: [] },
          ],
        },
      },
    })
    const lookup = async (args: Record<string, unknown>) => {
      const value = await f.tools.get('dataops_user_lookup')!.execute(args, f.exec) as { users: Array<{ id: string }>; count: number }
      return value.users.map(user => user.id)
    }
    expect(await lookup({ username: 'ALICE' })).toEqual(['u-1'])
    expect(await lookup({ email: 'alice@example.com' })).toEqual(['u-1'])
    expect(await lookup({ mobile: '13800000001' })).toEqual(['u-1'])
    expect(await lookup({ display_name: 'zhang' })).toEqual(['u-1'])
    expect(await lookup({ mobile: '13900000002', enabled_only: true })).toEqual([])
  })

  it('requires at least one lookup criterion', async () => {
    const f = setup()
    await expect(f.tools.get('dataops_user_lookup')!.execute({}, f.exec)).rejects.toThrow(/at least one/)
    expect(f.calls).toHaveLength(0)
  })
})

describe('dataops_user_create', () => {
  it('previews with dry_run and writes nothing', async () => {
    const f = setup()
    const value = await f.tools.get('dataops_user_create')!.execute({
      username: 'new.member',
      display_name: '新成员',
      email: 'new.member@example.com',
      dry_run: true,
      confirm: true,
    }, f.exec) as { dryRun: boolean; wouldCreate: { roles: string[]; directResourceGrants: number } }
    expect(value.dryRun).toBe(true)
    expect(value.wouldCreate.roles).toEqual(['应用人员', '初级权限', 'AI 工作区成员'])
    expect(value.wouldCreate.directResourceGrants).toBe(0)
    expect(f.calls).toHaveLength(0)
    expect(f.approvals).toHaveLength(0)
  })

  it('requires confirm before a real create', async () => {
    const f = setup()
    await expect(f.tools.get('dataops_user_create')!.execute({
      username: 'new.member',
      display_name: '新成员',
      email: 'new.member@example.com',
    }, f.exec)).rejects.toThrow(/confirm must be true/)
    expect(f.calls).toHaveLength(0)
  })

  it('writes nothing when the user denies approval', async () => {
    const f = setup({}, 'denied')
    await expect(f.tools.get('dataops_user_create')!.execute({
      username: 'new.member',
      display_name: '新成员',
      email: 'new.member@example.com',
      confirm: true,
    }, f.exec)).rejects.toThrow(/approval was denied/)
    expect(f.calls).toHaveLength(0)
  })

  it('creates an enabled ordinary account with default roles and returns the initial password once', async () => {
    const f = setup({
      '/api/system/users': {
        status: 201,
        body: {
          user: {
            id: 'u-new',
            username: 'new.member',
            displayName: '新成员',
            email: 'new.member@example.com',
            phone: '13800000002',
            enabled: true,
            department: { code: 'unassigned', name: '待分配部门' },
            roles: [
              { code: '应用人员', name: '应用人员' },
              { code: '初级权限', name: '初级权限' },
              { code: 'AI 工作区成员', name: 'AI 工作区成员' },
            ],
          },
        },
      },
    })
    const value = await f.tools.get('dataops_user_create')!.execute({
      username: 'new.member',
      display_name: '新成员',
      email: 'new.member@example.com',
      mobile: '13800000002',
      confirm: true,
    }, f.exec) as { created: boolean; user: { id: string; enabled: boolean }; defaultRoles: string[]; credential: { mode: string }; initialPassword: string; directResourceGrants: number }

    expect(f.approvals).toHaveLength(1)
    expect(f.approvals[0]!.toolName).toBe('dataops_user_create')
    const body = JSON.parse(f.calls.find(call => call.method === 'POST')!.body!) as Record<string, unknown>
    expect(body).toMatchObject({
      username: 'new.member',
      displayName: '新成员',
      email: 'new.member@example.com',
      phone: '13800000002',
      departmentCode: 'unassigned',
      roleCodes: ['应用人员', '初级权限', 'AI 工作区成员'],
    })
    expect(typeof body.password).toBe('string')
    const password = body.password as string
    expect(password.length).toBeGreaterThanOrEqual(12)
    expect(value.user).toMatchObject({ id: 'u-new', enabled: true })
    expect(value.defaultRoles).toEqual(['应用人员', '初级权限', 'AI 工作区成员'])
    expect(value.directResourceGrants).toBe(0)
    expect(value.credential.mode).toBe('one_time_reveal')
    expect(value.initialPassword).toBe(password)
    expect(f.audits.join('\n')).not.toContain(password)
  })
})

describe('dataops_role_assign', () => {
  const userRoute = (id: string, roles: string[], updatedAt = '2026-11-19T00:00:00.000Z') => ({
    [`/api/system/users/${id}`]: {
      status: 200,
      body: {
        user: {
          id,
          username: 'user-' + id,
          updatedAt,
          department: { code: 'unassigned', name: '待分配部门' },
          roles: roles.map(code => ({ code, name: code })),
        },
      },
    },
  })

  it('merges roles on add and writes the full role set with the optimistic token', async () => {
    const f = setup({
      ...userRoute('u-1', ['应用人员', '初级权限']),
      '/api/system/users/u-1': {
        status: 200,
        body: { user: { id: 'u-1', username: 'user-u-1', updatedAt: '2026-11-19T00:00:00.000Z', roles: [{ code: '应用人员', name: '应用人员' }] } },
      },
    })
    // The PATCH answer is irrelevant; the route map returns the same GET body, which the tool ignores.
    const value = await f.tools.get('dataops_role_assign')!.execute({
      user_ids: ['u-1'],
      role_codes: ['初级权限'],
      action: 'add',
      confirm: true,
    }, f.exec) as { changed: number; results: Array<{ beforeRoles: string[]; afterRoles: string[] }> }

    expect(f.approvals).toHaveLength(1)
    const patch = f.calls.find(call => call.method === 'PATCH')!
    expect(JSON.parse(patch.body!)).toEqual({
      updatedAt: '2026-11-19T00:00:00.000Z',
      roleCodes: ['应用人员', '初级权限'],
    })
    expect(value.changed).toBe(1)
    expect(value.results[0]!.afterRoles).toEqual(['应用人员', '初级权限'])
  })

  it('subtracts roles on remove', async () => {
    const f = setup(userRoute('u-2', ['应用人员', '初级权限', 'AI 工作区成员']))
    const value = await f.tools.get('dataops_role_assign')!.execute({
      user_ids: ['u-2'],
      role_codes: ['AI 工作区成员'],
      action: 'remove',
      confirm: true,
    }, f.exec) as { results: Array<{ afterRoles: string[] }> }
    expect(value.results[0]!.afterRoles).toEqual(['应用人员', '初级权限'])
  })

  it('writes nothing when the user denies approval', async () => {
    const f = setup(userRoute('u-9', ['应用人员']), 'denied')
    await expect(f.tools.get('dataops_role_assign')!.execute({
      user_ids: ['u-9'],
      role_codes: ['初级权限'],
      confirm: true,
    }, f.exec)).rejects.toThrow(/approval was denied/)
    expect(f.calls.some(call => call.method === 'PATCH')).toBe(false)
  })

  it('refuses the super-administrator role before any request', async () => {
    const f = setup()
    await expect(f.tools.get('dataops_role_assign')!.execute({
      user_ids: ['u-1'],
      role_codes: ['超级管理员'],
      confirm: true,
    }, f.exec)).rejects.toThrow(/超级管理员/)
    expect(f.calls).toHaveLength(0)
  })

  it('requires confirm for a real change and previews with dry_run', async () => {
    const f = setup(userRoute('u-3', ['应用人员']))
    await expect(f.tools.get('dataops_role_assign')!.execute({
      user_ids: ['u-3'],
      role_codes: ['初级权限'],
    }, f.exec)).rejects.toThrow(/confirm must be true/)
    expect(f.calls.some(call => call.method === 'PATCH')).toBe(false)

    const preview = await f.tools.get('dataops_role_assign')!.execute({
      user_ids: ['u-3'],
      role_codes: ['初级权限'],
      dry_run: true,
    }, f.exec) as { dryRun: boolean; results: Array<{ afterRoles: string[] }> }
    expect(preview.dryRun).toBe(true)
    expect(preview.results[0]!.afterRoles).toEqual(['应用人员', '初级权限'])
    expect(f.calls.some(call => call.method === 'PATCH')).toBe(false)
  })

  it('never touches an existing super-administrator account', async () => {
    const f = setup(userRoute('u-root', ['超级管理员', '应用人员']))
    const value = await f.tools.get('dataops_role_assign')!.execute({
      user_ids: ['u-root'],
      role_codes: ['初级权限'],
      confirm: true,
    }, f.exec) as { results: Array<{ ok: boolean; error?: string }> }
    expect(value.results[0]!.ok).toBe(false)
    expect(value.results[0]!.error).toMatch(/超级管理员/)
    expect(f.calls.some(call => call.method === 'PATCH')).toBe(false)
  })
})

describe('user tool disclosure', () => {
  it('shows lookup to administrators and department administrators, mutations to administrators only', () => {
    expect(isToolVisible('dataops_user_lookup', ADMIN)).toBe(true)
    expect(isToolVisible('dataops_user_lookup', DEPARTMENT_ADMIN)).toBe(true)
    expect(isToolVisible('dataops_user_lookup', MEMBER)).toBe(false)

    expect(isToolVisible('dataops_user_create', ADMIN)).toBe(true)
    expect(isToolVisible('dataops_user_create', DEPARTMENT_ADMIN)).toBe(false)
    expect(isToolVisible('dataops_user_create', MEMBER)).toBe(false)

    expect(isToolVisible('dataops_role_assign', ADMIN)).toBe(true)
    expect(isToolVisible('dataops_role_assign', DEPARTMENT_ADMIN)).toBe(false)
    expect(isToolVisible('dataops_role_assign', MEMBER)).toBe(false)
  })
})