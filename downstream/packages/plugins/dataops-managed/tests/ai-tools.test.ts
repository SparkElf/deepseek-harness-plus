/**
 * Tool behaviour after the scope-based disclosure rewrite.
 *
 * Registration now happens in `AiToolManager`; these cases drive that manager with a fixed
 * scope and then exercise the registered tool bodies. They cover the semantics that must not
 * regress — catalogue merge, approval, audit, uninstall/unshare/delete distinctions — while the
 * disclosure itself (what is registered for which role) is pinned in `tool-manager.test.ts`.
 *
 * @module tests/ai-tools.test
 */

import { afterEach, describe, expect, it } from 'vitest'
import { AiToolManager } from '../src/tool-manager.ts'
import type { DataOpsScope } from '../src/tool-scope.ts'

type Tool = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }

/** Managers subscribe to the auth-state observer; dispose them so cases do not leak. */
const managers: AiToolManager[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
})

function setup(context: DataOpsScope, options: { outcome?: string; routes?: Record<string, unknown> } = {}) {
  const tools = new Map<string, Tool>()
  const approvals: Array<{ toolName: string; reason: string }> = []
  const audits: string[] = []
  const calls: Array<{ path: string; method: string; body?: string }> = []
  const routes: Record<string, unknown> = {
    '/api/ai/skill-plaza/skills?scope=mine': { status: 200, body: [{ id: 1, name: 'mine', reviewStatus: 'pending', sharedByMe: true, departmentCode: 'd1' }] },
    '/api/ai/skill-plaza/skills': { status: 200, body: [{ id: 2, name: 'public', reviewStatus: 'approved', sharedByMe: false, departmentCode: 'd1' }] },
    '/api/ai/skill-plaza/admin/skills': { status: 200, body: { skills: [{ id: 1, name: 'mine', reviewStatus: 'pending', enabled: false, sharedByMe: true, departmentCode: 'd1' }] } },
    '/api/ai/review-notifications?unreadOnly=true&limit=5': { status: 200, body: { items: [{ id: 'n1', read: false }], unread: 1 } },
    '/api/ai/review/decide': { status: 200, body: { decided: true } },
    '/api/ai/review/scan': { status: 200, body: { risk: 'low' } },
    '/api/ai/skill-plaza/skills/16/install': { status: 200, body: { uninstalled: true, removed: 1 } },
    '/api/ai/skill-plaza/skills/16': { status: 200, body: { success: true } },
    '/api/ai/skill-plaza/skills/16/permanent': { status: 200, body: { deleted: true } },
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
    approval: { request: async (input: { toolName: string; reason: string }) => { approvals.push(input); return options.outcome ?? 'allowed-once' } },
    logger: { info: (line: string) => { audits.push(line) }, warn: () => {}, error: () => {} },
    skills: { snapshot: async () => ({ skills: [] }), get: async () => undefined },
  }
  const manager = new AiToolManager(ctx as never, api as never, { subscribe: () => () => undefined } as never)
  managers.push(manager)
  manager.applyContext(context)
  const exec = { agent: { session: { id: 's1' } }, callId: 'call-1', signal: new AbortController().signal }
  return { tools, approvals, audits, calls, exec, manager }
}

const ORDINARY = { userId: 'u1', roleCodes: ['普通用户'], primaryRole: '普通用户', departmentCode: 'd1', review: { canReview: false } }
const ADMIN = { userId: 'a1', roleCodes: ['管理员'], primaryRole: '管理员', departmentCode: 'd1', review: { canReview: true, canReviewGlobal: true } }
const DEPT = { userId: 'd1', roleCodes: ['部门管理员'], primaryRole: '部门管理员', departmentCode: 'd1', dataScope: { departmentCodes: ['d1'] }, review: { canReview: true } }

describe('skill catalogue scope', () => {
  it('merges own pending rows with approved public rows for an ordinary user', async () => {
    const f = setup(ORDINARY)
    const value = await f.tools.get('skill_list')!.execute({ include_local: false }, f.exec) as { catalog: { pending: unknown[]; approved: unknown[] }; isAdmin: boolean }
    expect(value.catalog.pending).toHaveLength(1)
    expect(value.catalog.approved).toHaveLength(1)
    expect(value.isAdmin).toBe(false)
    expect(f.calls.some(call => call.path === '/api/ai/skill-plaza/admin/skills')).toBe(false)
  })

  it('reads the admin catalogue for an administrator', async () => {
    const f = setup(ADMIN)
    const value = await f.tools.get('skill_list')!.execute({ include_local: false }, f.exec) as { isAdmin: boolean }
    expect(value.isAdmin).toBe(true)
    expect(f.calls.some(call => call.path === '/api/ai/skill-plaza/admin/skills')).toBe(true)
  })
})

describe('write gates', () => {
  it('does not register skill_enable when the context carries no skill:manage key', () => {
    const f = setup({ ...DEPT, permissions: ['skill:capability:read'] })
    expect(f.tools.has('skill_enable')).toBe(false)
    expect(f.tools.has('skill_disable')).toBe(false)
  })

  it('requires authorization.confirmed=true for review_decide', async () => {
    const f = setup(ADMIN)
    await expect(f.tools.get('review_decide')!.execute({ skills: [1], decision: 'approve', confirmed: false }, f.exec)).rejects.toThrow(/confirmed=true/)
    expect(f.approvals).toHaveLength(0)
    expect(f.calls.some(call => call.path === '/api/ai/review/decide')).toBe(false)
  })

  it('does not register review_decide for an ordinary user', () => {
    const f = setup(ORDINARY)
    expect(f.tools.has('review_decide')).toBe(false)
  })

  it('stops before DataOps when the user denies approval', async () => {
    const f = setup(ADMIN, { outcome: 'denied' })
    await expect(f.tools.get('review_decide')!.execute({ skills: [1], decision: 'approve', confirmed: true }, f.exec)).rejects.toThrow(/approval was denied/)
    expect(f.calls.some(call => call.path === '/api/ai/review/decide')).toBe(false)
  })

  it('audits a successful decision without any secret', async () => {
    const f = setup(ADMIN)
    await f.tools.get('review_decide')!.execute({ skills: [1], decision: 'approve', confirmed: true, note: 'ok' }, f.exec)
    expect(f.approvals).toHaveLength(1)
    expect(f.audits[0]).toContain('review_decide')
    expect(f.audits[0]).not.toMatch(/password|token|secret/i)
  })
})

describe('notifications and scan', () => {
  it('passes unread_only and limit to the notification endpoint', async () => {
    const f = setup(ORDINARY)
    const value = await f.tools.get('review_notifications_list')!.execute({ unread_only: true, limit: 5 }, f.exec) as { unread: number }
    expect(value.unread).toBe(1)
    expect(f.calls.some(call => call.path.includes('unreadOnly=true'))).toBe(true)
  })

  it('does not register review_scan for an ordinary user', () => {
    const f = setup(ORDINARY)
    expect(f.tools.has('review_scan')).toBe(false)
  })
})

describe('uninstall / unshare / delete semantics', () => {
  it('uninstall only removes the caller installation and never touches the plaza entry', async () => {
    const f = setup(ADMIN)
    const value = await f.tools.get('skill_uninstall')!.execute({ skill_id: 16 }, f.exec) as Record<string, unknown>
    expect(value).toEqual({ uninstalled: true, removed: 1 })
    expect(f.calls.some(call => call.path === '/api/ai/skill-plaza/skills/16/install' && call.method === 'DELETE')).toBe(true)
    expect(f.calls.some(call => call.path === '/api/ai/skill-plaza/skills/16' && call.method === 'DELETE')).toBe(false)
  })

  it('unshare soft-unpublishes the entry', async () => {
    const f = setup(ADMIN)
    const value = await f.tools.get('skill_unshare')!.execute({ skill_id: 16 }, f.exec) as Record<string, unknown>
    expect(value).toEqual({ unshared: 16, effect: 'plaza-sharing-disabled' })
    expect(f.calls.some(call => call.path === '/api/ai/skill-plaza/skills/16' && call.method === 'DELETE')).toBe(true)
  })

  it('delete needs confirm=true and calls the permanent endpoint', async () => {
    const f = setup(ADMIN)
    await expect(f.tools.get('skill_delete')!.execute({ skill_id: 16, confirm: false }, f.exec)).rejects.toThrow(/confirm=true/)
    expect(f.calls.some(call => call.path.endsWith('/permanent'))).toBe(false)
    const value = await f.tools.get('skill_delete')!.execute({ skill_id: 16, confirm: true }, f.exec) as Record<string, unknown>
    expect(value).toEqual({ deleted: 16, permanent: true })
    expect(f.calls.some(call => call.path === '/api/ai/skill-plaza/skills/16/permanent' && call.method === 'DELETE')).toBe(true)
    expect(f.audits.some(line => line.includes('"permanent":true'))).toBe(true)
  })

  it('passes a 409 conflict through with the backend reason', async () => {
    const f = setup(ADMIN, { routes: { '/api/ai/skill-plaza/skills/16/permanent': { status: 409, body: { error: 'skill still has 2 installations' } } } })
    await expect(f.tools.get('skill_delete')!.execute({ skill_id: 16, confirm: true }, f.exec)).rejects.toThrow(/Conflict \(409\).*installations/)
  })
})

describe('scope-based disclosure', () => {
  it('registers only the notification tools when the permission list is empty', () => {
    const f = setup({ ...ADMIN, permissions: [] })
    expect([...f.tools.keys()].sort()).toEqual(['dataops_open_resource_tab', 'review_notifications_list', 'review_notifications_read'])
  })

  it('registers review_decide for a department reviewer and leaves resource scope to DataOps', async () => {
    const f = setup({ ...DEPT, permissions: ['skill:capability:read', 'skill:review:decide'] })
    expect(f.tools.has('review_decide')).toBe(true)
    const value = await f.tools.get('review_decide')!.execute({ skills: [16], decision: 'approve', confirmed: true }, f.exec) as Record<string, unknown>
    expect(value).toEqual({ decided: true })
  })

  it('registers every skill tool for an administrator without a permission list', () => {
    const f = setup(ADMIN)
    expect(f.tools.has('skill_enable')).toBe(true)
    expect(f.tools.has('skill_delete')).toBe(true)
    expect(f.tools.has('review_scan')).toBe(true)
    expect(f.tools.has('dataops_api_docs')).toBe(false)
  })

  it('never reads the scope during a tool call', async () => {
    const f = setup(ADMIN)
    await f.tools.get('skill_list')!.execute({ include_local: false }, f.exec)
    await f.tools.get('review_notifications_list')!.execute({ unread_only: true, limit: 5 }, f.exec)
    expect(f.calls.some(call => call.path === '/api/ai/review/context')).toBe(false)
  })
})