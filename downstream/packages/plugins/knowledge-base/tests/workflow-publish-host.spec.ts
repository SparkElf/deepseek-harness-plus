// @ts-nocheck
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, type Config } from '../src/index.ts'

const BASE: Config = {
  baseUrl: '',
  credentialRef: 'DATAOPS_ACCESS_TOKEN',
  timeoutMs: 1_000,
  storageMode: 'local',
  storageProtocol: 'sshfs',
  mountPoint: '/tmp/kb-not-used',
  actualRoot: '/tmp/kb-not-used',
  viewRoot: '/tmp/kb-not-used',
  permitted: '',
  nfsServer: '',
  sshHost: '',
  sshUser: '',
  sshPort: 22,
  sshKeyRef: '',
  sshRemotePath: '',
  sshMountOptions: '',
  mineruTier: 'basic',
  mineruBackend: 'onnx',
  mineruPort: 8000,
  mineruBaseUrl: '',
  mineruMemoryMaxMiB: 4096,
  publishDir: '',
}

const fakeHost = (fetchImpl: typeof fetch) => {
  const tools: Array<{ name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }> = []
  const routes: Array<{ path?: string; handler: (req: unknown, res: unknown) => Promise<void> | void }> = []
  const disposers: Array<() => unknown> = []
  const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/auth/me')) return new Response(JSON.stringify({ user: { id: 'u-1', displayName: 'Tester' } }), { status: 200 })
    if (url.includes('/api/ai/review/context')) return new Response(JSON.stringify({ userId: 'u-1', displayName: 'Tester', permissions: ['kb:file:read', 'kb:file:write', 'kb:file:delete', 'kb:file:extract', 'kb:review:decide', 'kb:grant:manage', 'kb:config:manage', 'kb:audit:read', 'workflow:read', 'workflow:publish', 'workflow:manage'], roles: [{ systemKey: 'APP_USER' }] }), { status: 200 })
    return fetchImpl(input, init)
  }) as typeof fetch
  vi.stubGlobal('fetch', wrappedFetch)
  const ctx = {
    effect(factory: () => () => unknown) { disposers.push(factory()) },
    inject() {},
    credentials: { async resolve() { return { value: 'token' } } },
    webServer: {
      register(route: { handler: (req: unknown, res: unknown) => Promise<void> | void }) {
        routes.push(route)
        return () => undefined
      },
    },
    tools: {
      register(definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) {
        tools.push(definition)
        return () => undefined
      },
    },
  }
  return { ctx, tools, routes }
}

const call = async (
  routes: Array<{ handler: (req: unknown, res: unknown) => Promise<void> | void }>,
  method: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const route = routes[0]
  if (route === undefined) throw new Error('route missing')
  let reply: Record<string, unknown> = {}
  const req = {
    url: `/knowledge-base/api/${method}`,
    on(event: string, handler: (chunk?: Buffer) => void) {
      if (event === 'data') handler(Buffer.from(JSON.stringify(body)))
      if (event === 'end') handler()
      return req
    },
  }
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (text: string) => { reply = JSON.parse(text) as Record<string, unknown> },
  }
  await route.handler(req, res)
  return { status: res.statusCode, body: reply }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('workflow publish host surface', () => {
  it('publishes a pending workflow from the tool with source session and local author', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-publish-host-'))
    try {
      const { ctx, tools } = fakeHost(async () => new Response('{}', { status: 200 }))
      apply(ctx as never, { ...BASE, publishDir: dir })
      const tool = tools.find(item => item.name === 'workflow_publish')
      expect(tool).toBeDefined()
      const result = await tool!.execute({
        title: '会话发布测试',
        description: '验证发布到审核队列',
        instruction: '整理本周知识库变更并汇总。',
        cronHint: '0 9 * * 1',
        category: '测试',
      }, { agent: { session: { id: 'session-42' } } }) as Record<string, unknown>
      expect(result).toMatchObject({ status: 'pending', duplicate: false })
      const raw = JSON.parse(await readFile(join(dir, 'published.json'), 'utf8')) as {
        workflows: Array<Record<string, unknown>>
      }
      expect(raw.workflows[0]).toMatchObject({
        title: '会话发布测试',
        authorId: 'local',
        status: 'pending',
        sourceSessionId: 'session-42',
      })
      const second = await tool!.execute({
        title: '  会话发布测试  ',
        description: '重复',
        instruction: '重复',
      }, { agent: { session: { id: 'session-42' } } }) as Record<string, unknown>
      expect(second).toMatchObject({ status: 'pending', duplicate: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lists the caller’s own workflows with status/scope and supports unpublish', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-mine-host-'))
    try {
      const { ctx, tools, routes } = fakeHost(async () => new Response('{}', { status: 200 }))
      apply(ctx as never, { ...BASE, publishDir: dir })
      const tool = tools.find(item => item.name === 'workflow_publish')!
      await tool.execute({
        title: '部门共享测试',
        description: 'mine 路由测试',
        instruction: '整理部门文档。',
        visibility: 'private',
      }, { agent: { session: { id: 'session-mine' } } })
      const mine = await call(routes, 'workflow.mine', {})
      expect(mine.status).toBe(200)
      const workflows = mine.body.workflows as Array<Record<string, unknown>>
      expect(workflows).toHaveLength(1)
      expect(workflows[0]).toMatchObject({
        title: '部门共享测试',
        status: 'pending',
        visibility: 'private',
        ownerId: 'local',
      })
      const id = String(workflows[0]?.id)
      const unpublished = await call(routes, 'workflow.unpublish', { id })
      expect(unpublished.status).toBe(200)
      const after = await call(routes, 'workflow.mine', {})
      expect((after.body.workflows as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'unpublished' })
      const resubmitted = await call(routes, 'workflow.resubmit', { id })
      expect(resubmitted.status).toBe(200)
      const pendingAgain = await call(routes, 'workflow.mine', {})
      expect((pendingAgain.body.workflows as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'pending' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('proxies workflow.mine from the backend with the caller token', async () => {
    const calls: Array<{ url: string; auth: string | null }> = []
    const { ctx, routes } = fakeHost(async (input, init) => {
      calls.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
        auth: new Headers(init?.headers).get('authorization'),
      })
      return new Response(JSON.stringify({
        items: [{
          id: 'wf-team-1', title: '团队工作流', reviewStatus: 'pending', visibility: 'department',
          departmentCode: 'data-platform', updatedAt: '2026-10-23T01:00:00.000Z',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    apply(ctx as never, { ...BASE, baseUrl: 'https://dataops.example' })
    const mine = await call(routes, 'workflow.mine', {})
    expect(mine.status).toBe(200)
    expect((mine.body.workflows as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'wf-team-1', visibility: 'department',
    })
    const workflowCalls = calls.filter(call => call.url.includes('/api/ai/workflow-publications/mine'))
    expect(workflowCalls).toHaveLength(1)
    expect(workflowCalls[0]?.auth).toBe('Bearer token')
  })

  it('resubmits in place with PUT and never creates/deletes a second row', async () => {
    const calls: Array<{ method: string; url: string }> = []
    const { ctx, routes } = fakeHost(async (input, init) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      })
      return new Response(JSON.stringify({
        id: 'wf-same', title: '同 id 重提', reviewStatus: 'pending', visibility: 'department',
        departmentCode: 'data-platform', updatedAt: '2026-10-23T10:00:00.000Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    apply(ctx as never, { ...BASE, baseUrl: 'https://dataops.example' })
    const result = await call(routes, 'workflow.resubmit', { id: 'wf-same' })
    expect(result.status).toBe(200)
    expect((result.body.workflow as Record<string, unknown>).id).toBe('wf-same')
    const workflowCalls = calls.filter(call => call.url.includes('/api/ai/workflow-publications/wf-same'))
    expect(workflowCalls).toHaveLength(1)
    expect(workflowCalls[0]?.method).toBe('PUT')
    expect(calls.some(call => call.method === 'POST' || call.method === 'DELETE')).toBe(false)
  })

  it('refuses the review routes to a caller without grant-management access', async () => {
    const { ctx, routes } = fakeHost(async () => new Response('{"error":"denied"}', { status: 403 }))
    apply(ctx as never, { ...BASE, baseUrl: 'https://dataops.example' })
    const pending = await call(routes, 'workflow.pending', {})
    expect(pending.status).toBe(403)
    expect(pending.body).toMatchObject({ code: 'forbidden' })
    const review = await call(routes, 'workflow.review', { id: 'wf-1', decision: 'approve' })
    expect(review.status).toBe(403)
  })

  it('keeps the public route readable without review authority', async () => {
    const { ctx, routes } = fakeHost(async () => new Response('{"error":"denied"}', { status: 403 }))
    apply(ctx as never, { ...BASE, baseUrl: 'https://dataops.example', publishDir: '/tmp/kb-public-empty' })
    const publicRoute = await call(routes, 'workflow.public', {})
    expect(publicRoute.status).toBe(200)
    expect(publicRoute.body).toEqual({ workflows: [] })
  })
})
