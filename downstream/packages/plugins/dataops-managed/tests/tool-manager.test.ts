/**
 * Scope-driven tool disclosure.
 *
 * These cases pin the contract that replaced unconditional tool registration: a workspace with
 * no capability gets no skill/review tool, a role change disposes what the role lost and
 * registers what it gained without dropping tools it kept, and the API-reference tool is
 * reserved for the DataOps 超级管理员 role — an administrator holding `developer:openapi:read`
 * still does not see it.
 *
 * @module tests/tool-manager.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiToolManager } from '../src/tool-manager.ts'
import { noteExpired, resetAuthState } from '../src/auth-state.ts'

type Tool = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }

const managers: AiToolManager[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
  resetAuthState()
})

/** Build a manager over an in-memory registry and a path-routed ReviewApi double. */
function harness() {
  const tools = new Map<string, Tool>()
  const disposed: string[] = []
  const viewers: Array<{ role?: string; permissions?: readonly string[] }> = []
  const ctx = {
    tools: {
      register: (tool: Tool) => {
        tools.set(tool.name, tool)
        return () => { tools.delete(tool.name); disposed.push(tool.name) }
      },
    },
    approval: { request: async () => 'allowed-once' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    skills: {
      snapshot: async () => ({ skills: [] }),
      get: async () => undefined,
      useViewer: (viewer: { role?: string; permissions?: readonly string[] }) => {
        viewers.push(viewer)
        return () => {}
      },
    },
  }
  const responses = new Map<string, { status: number; body: unknown }>()
  const request = vi.fn(async (path: string) => responses.get(path) ?? { status: 404, body: { error: 'not found' } })
  const manager = new AiToolManager(ctx as never, { request } as never, { subscribe: () => () => undefined } as never)
  managers.push(manager)
  return { tools, disposed, viewers, responses, request, manager }
}

const SUPER_ADMIN = {
  userId: 'super',
  roleCodes: ['超级管理员'],
  primaryRole: '超级管理员',
  permissions: [] as string[],
}

const ADMIN = {
  userId: 'admin',
  roleCodes: ['管理员'],
  primaryRole: '管理员',
  permissions: ['skill:capability:read', 'skill:capability:manage'],
  canReview: true,
}

const ORDINARY = {
  userId: 'user',
  roleCodes: ['应用人员'],
  primaryRole: '应用人员',
  permissions: [] as string[],
}

const READER = {
  userId: 'user',
  roleCodes: ['应用人员'],
  primaryRole: '应用人员',
  permissions: ['skill:capability:read'],
}

const NOTIFICATION_TOOLS = ['dataops_open_resource_tab', 'review_notifications_list', 'review_notifications_read']

describe('no scope, no tools', () => {
  it('registers no tool when the permission list is empty', async () => {
    const f = harness()
    f.responses.set('/api/ai/review/context', { status: 200, body: ORDINARY })
    await f.manager.refresh()

    expect([...f.tools.keys()].sort()).toEqual(NOTIFICATION_TOOLS)
  })

  it('registers no tool when the stored credential is rejected', async () => {
    const f = harness()
    f.responses.set('/api/ai/review/context', { status: 401, body: { error: 'expired' } })
    await f.manager.refresh()

    expect([...f.tools.keys()]).toEqual([])
  })

  it('does not guess ordinary capabilities for a context with no roles', async () => {
    const f = harness()
    f.responses.set('/api/ai/review/context', { status: 200, body: { roleCodes: [] } })
    await f.manager.refresh()

    expect([...f.tools.keys()].sort()).toEqual(NOTIFICATION_TOOLS)
  })

  it('accepts the backend capability spelling without registering manage tools', async () => {
    const f = harness()
    f.responses.set('/api/ai/review/context', { status: 200, body: READER })
    await f.manager.refresh()

    expect(f.tools.has('skill_list')).toBe(true)
    expect(f.tools.has('skill_get')).toBe(true)
    expect(f.tools.has('skill_enable')).toBe(false)
    expect(f.tools.has('skill_manage')).toBe(false)
  })

  it('accepts the short skill:read spelling used by the disclosure contract', async () => {
    const f = harness()
    f.responses.set('/api/ai/review/context', { status: 200, body: { ...READER, permissions: ['skill:read'] } })
    await f.manager.refresh()

    expect(f.tools.has('skill_list')).toBe(true)
    expect(f.tools.has('skill_submit')).toBe(false)
  })
})

describe('role changes reconcile the registry', () => {
  const EDITOR = {
    ...ORDINARY,
    roleCodes: ['部门管理员'],
    primaryRole: '部门管理员',
    permissions: ['skill:capability:read', 'skill:capability:manage'],
    canReview: true,
  }

  it('re-registers when the role itself changes', async () => {
    const f = harness()
    f.responses.set('/api/ai/review/context', { status: 200, body: { ...ORDINARY, permissions: undefined } })
    await f.manager.refresh()
    expect(f.tools.has('skill_list')).toBe(true)
    expect(f.tools.has('skill_enable')).toBe(false)

    f.responses.set('/api/ai/review/context', {
      status: 200,
      body: { ...ADMIN, permissions: undefined },
    })
    await f.manager.refresh()
    expect(f.tools.has('skill_enable')).toBe(true)
    expect(f.tools.has('review_decide')).toBe(true)
  })

  it('disposes tools the role lost and registers tools it gained', async () => {
    const f = harness()
    f.responses.set('/api/ai/review/context', { status: 200, body: EDITOR })
    await f.manager.refresh()

    expect(f.tools.has('skill_enable')).toBe(true)
    expect(f.tools.has('skill_install')).toBe(false)
    expect(f.tools.has('review_scan')).toBe(true)
    expect(f.tools.has('review_decide')).toBe(false)

    // The role loses manage and gains install. Skill list/get stay registered because the role
    // still holds skill:read; only what changed should be disposed.
    f.responses.set('/api/ai/review/context', {
      status: 200,
      body: {
        ...EDITOR,
        permissions: ['skill:capability:read', 'skill:capability:install'],
      },
    })
    await f.manager.refresh()

    expect(f.tools.has('skill_enable')).toBe(false)
    expect(f.tools.has('skill_install')).toBe(true)
    expect(f.tools.has('skill_uninstall')).toBe(true)
    expect(f.tools.has('skill_list')).toBe(true)
    expect(f.disposed).toContain('skill_enable')
    expect(f.disposed).not.toContain('skill_list')
  })

  it('disposes everything except notifications when the role loses every capability', async () => {
    const f = harness()
    f.responses.set('/api/ai/review/context', { status: 200, body: EDITOR })
    await f.manager.refresh()
    expect(f.disposed).toEqual([])

    f.responses.set('/api/ai/review/context', { status: 200, body: ORDINARY })
    await f.manager.refresh()

    expect([...f.tools.keys()].sort()).toEqual(NOTIFICATION_TOOLS)
    expect(f.disposed).toContain('skill_enable')
    expect(f.disposed).toContain('review_scan')
  })

  it('drops the tool set as soon as a DataOps call observes an expired session', () => {
    const f = harness()
    f.manager.applyContext(EDITOR)
    expect(f.tools.has('skill_enable')).toBe(true)

    noteExpired()
    resetAuthState()

    expect([...f.tools.keys()]).toEqual([])
    expect(f.disposed).toContain('skill_enable')
  })

  it('accepts a review-context answer directly and applies a role change without a fetch', async () => {
    const f = harness()
    f.manager.observeContext({ status: 200, body: EDITOR })
    expect(f.tools.has('skill_enable')).toBe(true)

    f.manager.observeContext({ status: 200, body: ORDINARY })
    expect(f.tools.has('skill_enable')).toBe(false)
    expect(f.request).not.toHaveBeenCalled()
  })

  it('a forced read supersedes a scope read that started before the credential changed', async () => {
    const f = harness()
    const pending: Array<(value: { status: number; body: unknown }) => void> = []
    f.request.mockImplementation(() => new Promise(resolve => { pending.push(resolve) }))

    const stale = f.manager.refresh()
    const fresh = f.manager.refresh(true)
    expect(pending).toHaveLength(2)

    pending[1]!({ status: 200, body: EDITOR })
    await fresh
    expect(f.tools.has('skill_enable')).toBe(true)

    // The older read answers for the previous principal. It must not change the registry.
    pending[0]!({ status: 200, body: ORDINARY })
    await stale
    expect(f.tools.has('skill_enable')).toBe(true)
  })
})

describe('api docs is super-admin only', () => {
  it('registers dataops_api_docs for 超级管理员 even with an empty permission list', () => {
    const f = harness()
    f.manager.applyContext(SUPER_ADMIN)
    expect(f.tools.has('dataops_api_docs')).toBe(true)
  })

  it('does not register dataops_api_docs for an administrator holding developer:openapi:read', () => {
    const f = harness()
    f.manager.applyContext({
      ...ADMIN,
      permissions: [...(ADMIN.permissions as string[]), 'developer:openapi:read'],
    })
    expect(f.tools.has('dataops_api_docs')).toBe(false)
  })

  it('does not register dataops_api_docs for an ordinary user', () => {
    const f = harness()
    f.manager.applyContext(ORDINARY)
    expect(f.tools.has('dataops_api_docs')).toBe(false)
  })
})

const OPENAPI_FIXTURE = {
  openapi: '3.0.3',
  info: { title: 'DataOps Admin API', version: '2026.10' },
  paths: {
    '/api/ai/review/context': {
      get: {
        operationId: 'getReviewContext',
        summary: 'Read the caller review context',
        tags: ['ai-review'],
        parameters: [
          { name: 'verbose', in: 'query', required: false, schema: { type: 'boolean' } },
        ],
        security: [{ bearer: [] }],
      },
    },
    '/api/ai/review/decide': {
      post: {
        operationId: 'decideReview',
        summary: 'Decide skills or workflows',
        tags: ['ai-review'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ReviewDecision' },
            },
          },
        },
      },
    },
    '/api/system/departments/{code}': {
      patch: {
        operationId: 'updateDepartment',
        summary: 'Update a department',
        tags: ['system-department'],
        parameters: [{ $ref: '#/components/parameters/DepartmentCode' }],
        security: [{ bearer: [] }],
      },
    },
  },
  components: {
    parameters: {
      DepartmentCode: { name: 'code', in: 'path', required: true, schema: { type: 'string' } },
    },
    schemas: {
      ReviewDecision: {
        type: 'object',
        required: ['decision'],
        properties: {
          decision: { type: 'string' },
          note: { type: 'string' },
          skillIds: { type: 'array', items: { type: 'number' } },
        },
      },
    },
  },
}

describe('dataops_api_docs search', () => {
  function superAdminWithDocs() {
    const f = harness()
    f.manager.applyContext(SUPER_ADMIN)
    f.responses.set('/api/openapi.json', { status: 200, body: OPENAPI_FIXTURE })
    return f
  }

  it('reports the document identity and a compact matching operation', async () => {
    const f = superAdminWithDocs()
    const value = await f.tools.get('dataops_api_docs')!.execute(
      { query: 'review context', method: 'get' },
      {},
    ) as {
      title: string
      version: string
      total: number
      returned: number
      results: Array<Record<string, unknown>>
    }

    expect(f.request).toHaveBeenCalledWith('/api/openapi.json')
    expect(value.title).toBe('DataOps Admin API')
    expect(value.version).toBe('2026.10')
    expect(value.total).toBe(1)
    expect(value.returned).toBe(1)
    expect(value.results[0]).toMatchObject({
      method: 'GET',
      path: '/api/ai/review/context',
      operationId: 'getReviewContext',
      summary: 'Read the caller review context',
      tags: ['ai-review'],
      parameters: [{ name: 'verbose', in: 'query', required: false, type: 'boolean' }],
      security: [{ bearer: [] }],
    })
  })

  it('summarizes a referenced request body and resolves referenced parameters', async () => {
    const f = superAdminWithDocs()
    const byOperationId = await f.tools.get('dataops_api_docs')!.execute(
      { operation_id: 'decideReview' },
      {},
    ) as { results: Array<{ requestBody: Record<string, unknown> }> }
    expect(byOperationId.results[0]?.requestBody).toMatchObject({
      required: true,
      contentTypes: ['application/json'],
      schema: {
        type: 'object',
        ref: 'ReviewDecision',
        required: ['decision'],
        properties: [
          { name: 'decision', type: 'string', required: true },
          { name: 'note', type: 'string', required: false },
          { name: 'skillIds', type: 'number[]', required: false },
        ],
      },
    })

    const byTag = await f.tools.get('dataops_api_docs')!.execute(
      { tag: 'system-department', path: '{code}' },
      {},
    ) as { results: Array<{ method: string; parameters: unknown[] }> }
    expect(byTag.results).toHaveLength(1)
    expect(byTag.results[0]?.method).toBe('PATCH')
    expect(byTag.results[0]?.parameters).toEqual([
      { name: 'code', in: 'path', required: true, type: 'string' },
    ])
  })

  it('returns no rows for a query that matches nothing', async () => {
    const f = superAdminWithDocs()
    const value = await f.tools.get('dataops_api_docs')!.execute({ query: 'no-such-operation' }, {}) as { total: number; results: unknown[] }
    expect(value.total).toBe(0)
    expect(value.results).toEqual([])
  })

  it('reports an expired session clearly', async () => {
    const f = superAdminWithDocs()
    f.responses.set('/api/openapi.json', { status: 401, body: { error: 'expired' } })
    await expect(f.tools.get('dataops_api_docs')!.execute({}, {})).rejects.toThrow(/^Unauthorized \(401\)/)
  })

  it('reports an unavailable document clearly', async () => {
    const f = superAdminWithDocs()
    f.responses.set('/api/openapi.json', { status: 404, body: { code: 'DATAOPS_OPENAPI_UNAVAILABLE' } })
    await expect(f.tools.get('dataops_api_docs')!.execute({}, {})).rejects.toThrow(/unavailable.*openapi\.json/)
  })
})
describe('skill viewer disclosure', () => {
  it('maps the current DataOps role and permissions to the skill registry viewer', async () => {
    const f = harness()
    f.responses.set('/api/ai/review/context', { status: 200, body: ADMIN })
    await f.manager.refresh()
    expect(f.viewers.at(-1)).toEqual({ role: 'admin', permissions: ADMIN.permissions })
  })

  it('maps the super administrator to the super-admin audience', async () => {
    const f = harness()
    f.responses.set('/api/ai/review/context', { status: 200, body: SUPER_ADMIN })
    await f.manager.refresh()
    expect(f.viewers.at(-1)?.role).toBe('super-admin')
  })

  it('resets to an unprivileged viewer when the credential is rejected', async () => {
    const f = harness()
    f.responses.set('/api/ai/review/context', { status: 200, body: ADMIN })
    await f.manager.refresh()
    f.responses.set('/api/ai/review/context', { status: 401, body: { error: 'expired' } })
    await f.manager.refresh(true)
    expect(f.viewers.at(-1)).toEqual({ role: 'user', permissions: [] })
  })
})
