/**
 * Department and per-user skill provisioning.
 *
 * These tools hand a skill to somebody else's workspace, so the cases pin the two contracts that
 * matter at this layer: disclosure (all five need `skill:manage`, and a read-only principal gets
 * none) and the write shape (the API path/body, approval before the call, an audit line, and the
 * special confirm gate on `department_skill_apply`). DataOps still decides the caller's range.
 *
 * @module tests/skill-provisioning-tools.test
 */

import { afterEach, describe, expect, it } from 'vitest'
import { AiToolManager } from '../src/tool-manager.ts'
import { AI_TOOL_ACCESS, type AiToolName, type DataOpsScope } from '../src/tool-scope.ts'

type Tool = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }

const managers: AiToolManager[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
})

/**
 * A manager over an in-memory registry and a path-routed ReviewApi double.
 *
 * `routes` is keyed by the exact request path so a case can pin the query string as well as the
 * endpoint; anything else answers 404.
 */
function setup(context: DataOpsScope, options: { outcome?: string; routes?: Record<string, unknown> } = {}) {
  const tools = new Map<string, Tool>()
  const approvals: Array<{ toolName: string; reason: string }> = []
  const audits: string[] = []
  const calls: Array<{ path: string; method: string; body?: string }> = []
  const routes: Record<string, unknown> = {
    '/api/ai/skill-plaza/admin/install-for-users': {
      status: 200,
      body: { skillKey: 'demo-skill', results: [{ userId: 'u-1', status: 'installed' }] },
    },
    '/api/ai/skill-plaza/admin/department-skills/bind': { status: 200, body: { bound: true } },
    '/api/ai/skill-plaza/admin/department-skills/unbind': { status: 200, body: { unbound: true } },
    '/api/ai/skill-plaza/admin/department-skills/apply': {
      status: 200,
      body: { results: [{ userId: 'u-1', status: 'queued' }] },
    },
    '/api/ai/skill-plaza/admin/department-skills/preview?departmentCode=D%2F01&skillId=7': {
      status: 200,
      body: { departmentCode: 'D/01', includeDescendants: true, userCount: 2, users: [], conflicts: [] },
    },
    ...options.routes,
  }
  const api = {
    request: async (path: string, init: RequestInit = {}) => {
      calls.push({ path, method: init.method ?? 'GET', ...(typeof init.body === 'string' ? { body: init.body } : {}) })
      return routes[path] ?? { status: 404, body: { error: 'not found' } }
    },
  }
  const ctx = {
    tools: { register: (tool: Tool) => { tools.set(tool.name, tool); return () => { tools.delete(tool.name) } } },
    approval: {
      request: async (input: { toolName: string; reason: string }) => {
        approvals.push(input)
        return options.outcome ?? 'allowed-once'
      },
    },
    logger: { info: (line: string) => { audits.push(line) }, warn: () => {}, error: () => {} },
    skills: { snapshot: async () => ({ skills: [] }), get: async () => undefined },
  }
  const manager = new AiToolManager(ctx as never, api as never, { subscribe: () => () => undefined } as never)
  managers.push(manager)
  manager.applyContext(context)
  const exec = { agent: { session: { id: 's1' } }, callId: 'call-1', signal: new AbortController().signal }
  return { tools, approvals, audits, calls, exec }
}

const ADMIN: DataOpsScope = {
  userId: 'a1',
  roleCodes: ['管理员'],
  primaryRole: '管理员',
  permissions: ['skill:capability:manage'],
}

const DEPARTMENT: DataOpsScope = {
  userId: 'd1',
  roleCodes: ['部门管理员'],
  primaryRole: '部门管理员',
  departmentCode: 'D/01',
  permissions: ['skill:capability:manage'],
}

const MEMBER: DataOpsScope = {
  userId: 'u1',
  roleCodes: ['应用人员'],
  primaryRole: '应用人员',
  permissions: ['skill:capability:read'],
}

const PROVISIONING_TOOLS = [
  'skill_install_for_user',
  'department_skill_bind',
  'department_skill_unbind',
  'department_skill_apply',
  'department_skill_preview',
] as const satisfies readonly AiToolName[]

const executed = (f: ReturnType<typeof setup>, name: AiToolName) => f.tools.get(name)!

describe('skill provisioning disclosure', () => {
  it('declares every tool with the skill:manage capability', () => {
    for (const name of PROVISIONING_TOOLS) {
      expect(AI_TOOL_ACCESS[name]).toEqual({ permission: 'skill:manage' })
    }
  })

  it('registers the tools for a skill manager and hides them from a read-only member', () => {
    const admin = setup(ADMIN)
    const department = setup(DEPARTMENT)
    const member = setup(MEMBER)
    for (const name of PROVISIONING_TOOLS) {
      expect(admin.tools.has(name)).toBe(true)
      expect(department.tools.has(name)).toBe(true)
      expect(member.tools.has(name)).toBe(false)
    }
  })
})

describe('skill_install_for_user', () => {
  it('posts the skill, de-duplicated users and overwrite, then audits the call', async () => {
    const f = setup(ADMIN)
    const value = await executed(f, 'skill_install_for_user').execute(
      { skill_id: 7, user_ids: ['u-1', ' u-2 ', 'u-1'], overwrite: true },
      f.exec,
    ) as { skillKey: string }

    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toMatchObject({ path: '/api/ai/skill-plaza/admin/install-for-users', method: 'POST' })
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ skillId: 7, userIds: ['u-1', 'u-2'], overwrite: true })
    expect(f.approvals).toHaveLength(1)
    expect(f.approvals[0]!.toolName).toBe('skill_install_for_user')
    expect(f.approvals[0]!.reason).toContain('2 user')
    expect(f.audits[0]).toContain('skill_install_for_user')
    expect(value.skillKey).toBe('demo-skill')
  })

  it('omits overwrite when the caller did not ask for it', async () => {
    const f = setup(ADMIN)
    await executed(f, 'skill_install_for_user').execute({ skill_id: 7, user_ids: ['u-1'] }, f.exec)
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ skillId: 7, userIds: ['u-1'] })
  })

  it('rejects an empty user list before approval or the API call', async () => {
    const f = setup(ADMIN)
    await expect(executed(f, 'skill_install_for_user').execute({ skill_id: 7, user_ids: [] }, f.exec))
      .rejects.toThrow(/non-empty/)
    expect(f.approvals).toHaveLength(0)
    expect(f.calls).toHaveLength(0)
  })

  it('passes a DataOps refusal through as a forbidden error', async () => {
    const f = setup(ADMIN, {
      routes: {
        '/api/ai/skill-plaza/admin/install-for-users': { status: 403, body: { error: 'user is outside the caller department' } },
      },
    })
    await expect(executed(f, 'skill_install_for_user').execute({ skill_id: 7, user_ids: ['u-1'] }, f.exec))
      .rejects.toThrow(/Forbidden \(403\): user is outside the caller department/)
  })
})

describe('department_skill_bind and department_skill_unbind', () => {
  it('binds a department default and never auto-applies it', async () => {
    const f = setup(ADMIN)
    await executed(f, 'department_skill_bind').execute({ department_code: 'D/01', skill_id: 7 }, f.exec)

    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toMatchObject({ path: '/api/ai/skill-plaza/admin/department-skills/bind', method: 'POST' })
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ departmentCode: 'D/01', skillId: 7, enabled: true })
    expect(f.calls.some(call => call.path.endsWith('/apply'))).toBe(false)
    expect(f.audits[0]).toContain('"spread":false')
  })

  it('carries enabled=false when the binding is disabled', async () => {
    const f = setup(ADMIN)
    await executed(f, 'department_skill_bind').execute({ department_code: 'D/01', skill_id: 7, enabled: false }, f.exec)
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ departmentCode: 'D/01', skillId: 7, enabled: false })
  })

  it('unbinds with only the department and skill', async () => {
    const f = setup(ADMIN)
    await executed(f, 'department_skill_unbind').execute({ department_code: 'D/01', skill_id: 7 }, f.exec)
    expect(f.calls[0]).toMatchObject({ path: '/api/ai/skill-plaza/admin/department-skills/unbind', method: 'POST' })
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ departmentCode: 'D/01', skillId: 7 })
  })

  it('stops before DataOps when the user denies approval', async () => {
    const f = setup(ADMIN, { outcome: 'denied' })
    await expect(executed(f, 'department_skill_bind').execute({ department_code: 'D/01', skill_id: 7 }, f.exec))
      .rejects.toThrow(/approval was denied/)
    expect(f.calls).toHaveLength(0)
  })
})

describe('department_skill_preview', () => {
  it('reads the department preview with an encoded query and no approval', async () => {
    const f = setup(ADMIN)
    const value = await executed(f, 'department_skill_preview').execute({ department_code: 'D/01', skill_id: 7 }, f.exec) as {
      userCount: number
    }

    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toEqual({
      path: '/api/ai/skill-plaza/admin/department-skills/preview?departmentCode=D%2F01&skillId=7',
      method: 'GET',
    })
    expect(f.approvals).toHaveLength(0)
    expect(value.userCount).toBe(2)
  })
})

describe('department_skill_apply', () => {
  it('requires confirm=true before approval', async () => {
    const f = setup(ADMIN)
    await expect(executed(f, 'department_skill_apply').execute({ department_code: 'D/01', confirm: false }, f.exec))
      .rejects.toThrow(/confirm=true/)
    expect(f.approvals).toHaveLength(0)
    expect(f.calls).toHaveLength(0)
  })

  it('requires a department or an explicit user list', async () => {
    const f = setup(ADMIN)
    await expect(executed(f, 'department_skill_apply').execute({ confirm: true }, f.exec))
      .rejects.toThrow(/department_code or a non-empty user_ids/)
    expect(f.calls).toHaveLength(0)
  })

  it('applies a department without descendants when asked', async () => {
    const f = setup(ADMIN)
    await executed(f, 'department_skill_apply').execute(
      { department_code: 'D/01', include_descendants: false, confirm: true },
      f.exec,
    )

    expect(f.calls[0]).toMatchObject({ path: '/api/ai/skill-plaza/admin/department-skills/apply', method: 'POST' })
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ departmentCode: 'D/01', includeDescendants: false })
    expect(f.approvals).toHaveLength(1)
    expect(f.approvals[0]!.reason).toContain('D/01')
    expect(f.audits[0]).toContain('"confirmed":true')
  })

  it('applies an explicit user list without a department', async () => {
    const f = setup(ADMIN)
    await executed(f, 'department_skill_apply').execute({ user_ids: ['u-1', 'u-2'], confirm: true }, f.exec)
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ userIds: ['u-1', 'u-2'] })
    expect(f.approvals[0]!.reason).toContain('2 user')
  })
})