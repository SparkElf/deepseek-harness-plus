/**
 * The 万相 AI 中台管理 skill: who can see it, and what it ships.
 *
 * The provider is deliberately gated twice: the role must be 管理员 or 超级管理员, and an
 * administrator must also hold `system:admin:manage`. The role check matters because
 * `hasPermission` falls back to role names when a deployment's context predates permission keys —
 * a department administrator must not inherit an administrator-only playbook through that
 * fallback. A super administrator is a platform bypass role, so a partial permission list does
 * not hide the playbook from it.
 *
 * @module tests/wanxiang-ai-admin-skill.test
 */

import { readFile } from 'node:fs/promises'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply, type Config } from '../src/index.ts'

/** One registered skill provider as the fake registry captured it. */
interface CapturedProvider {
  name: string
  list: () => Promise<Array<Record<string, unknown>>>
  get: () => Promise<{ name: string; content: string; metadata?: Record<string, unknown> }>
}

const cleanups: Array<() => unknown> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      const result = cleanup()
      if (result instanceof Promise) void result.catch(() => undefined)
    } catch { /* best effort between cases */ }
  }
  vi.unstubAllGlobals()
})

/** A Response double sufficient for ReviewApi and the model-sync reads. */
function jsonResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

/**
 * Build the part of the Host context `apply` touches.
 *
 * `registerProvider` captures the provider objects so a case can call their `list`/`get` the way
 * the skill registry does. `tools.register` is captured for one reason: `dataops_open_resource_tab`
 * has no role policy, so its arrival proves the scope read finished and the disclosure ran.
 */
function harness() {
  const providers: CapturedProvider[] = []
  const tools = new Map<string, { name: string }>()
  const context = {
    credentials: { resolve: vi.fn(async () => ({ value: 'stored-jwt' })) },
    webServer: { register: () => () => undefined },
    effect: (factory: () => unknown) => {
      const result = factory()
      if (typeof result === 'function') cleanups.push(result as () => unknown)
      return () => undefined
    },
    on: () => () => undefined,
    plugin: () => ({ uid: 1, await: async () => undefined, dispose: async () => undefined }),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    settings: { describe: () => [], update: async () => undefined },
    skills: {
      registerProvider: (factory: () => unknown) => {
        providers.push(factory() as CapturedProvider)
        return () => undefined
      },
    },
    approval: { request: async () => 'allowed-once' },
    tools: {
      register: (tool: { name: string }) => {
        tools.set(tool.name, tool)
        return () => { tools.delete(tool.name) }
      },
      addVisibilityFilter: () => () => undefined,
    },
  }
  return { context, providers, tools }
}

/** The smallest config the plugin accepts. */
const CONFIG = {
  baseUrl: 'http://dataops.test:3101',
  serverName: 'dataops',
  credentialRef: 'DATAOPS_ACCESS_TOKEN',
  toolCallTimeoutMs: 300_000,
  distributedSettingsNamespaces: [],
} as unknown as Config

/** 超级管理员：平台旁路角色，权限列表为空也视为持有全部权限。 */
const SUPER_ADMIN = {
  userId: 'super',
  roleCodes: ['超级管理员'],
  primaryRole: '超级管理员',
  permissions: [],
}

/** 管理员：与超管一样持有 system:admin:manage。 */
const ADMIN = {
  userId: 'admin',
  roleCodes: ['管理员'],
  primaryRole: '管理员',
  permissions: ['system:admin:manage'],
}

/** 部门管理员：即使被显式授予同一个权限键，也不应看到管理员技能。 */
const DEPT_ADMIN_WITH_PERMISSION = {
  userId: 'dept',
  roleCodes: ['部门管理员'],
  primaryRole: '部门管理员',
  permissions: ['system:admin:manage'],
}

/** 旧上下文没有权限列表；hasPermission 的角色兜底会放行这个键，角色判定必须挡住。 */
const DEPT_ADMIN_WITHOUT_PERMISSION_LIST = {
  userId: 'dept-legacy',
  roleCodes: ['部门管理员'],
  primaryRole: '部门管理员',
}

/** 普通用户。 */
const ORDINARY = {
  userId: 'user',
  roleCodes: ['应用人员'],
  primaryRole: '应用人员',
  permissions: ['skill:capability:read'],
}

/** Mount `apply` with one stubbed scope answer. */
async function mount(scope: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.endsWith('/api/ai/review/context')) return jsonResponse(200, scope)
    return jsonResponse(404, { error: 'not found' })
  }))
  const f = harness()
  await apply(f.context as never, CONFIG)
  const provider = f.providers.find((entry) => entry.name === 'wanxiang-ai-admin')
  return { ...f, provider }
}

/** Wait until the scope read finished and its tool set was reconciled. */
async function waitForScopeRead(tools: Map<string, { name: string }>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (tools.has('dataops_open_resource_tab')) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('the DataOps scope was never applied')
}

describe('wanxiang-ai-admin provider', () => {
  it('is visible to administrators and carries its declared permission', async () => {
    const { provider, tools } = await mount(ADMIN)
    expect(provider).toBeDefined()
    await waitForScopeRead(tools)

    const listed = await provider!.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      name: 'wanxiang-ai-admin',
      source: 'bundled',
      metadata: { permissions: ['system:admin:manage'] },
    })
    expect((listed[0]?.resourceBase as { path: string }).path.endsWith('/skills/wanxiang-ai-admin/')).toBe(true)

    const skill = await provider!.get()
    expect(skill.name).toBe('wanxiang-ai-admin')
    expect(skill.content).toContain('万相 AI 中台管理')
    expect(skill.content).toContain('dataops_api_docs')
  })

  it('is visible to super administrators even without a permission list', async () => {
    const { provider, tools } = await mount(SUPER_ADMIN)
    await waitForScopeRead(tools)
    expect(await provider!.list()).toHaveLength(1)
  })

  it('stays hidden from an administrator who does not hold system:admin:manage', async () => {
    const { provider, tools } = await mount({ ...ADMIN, permissions: ['skill:capability:read'] })
    await waitForScopeRead(tools)
    expect(await provider!.list()).toEqual([])
  })

  it('stays hidden from a department administrator who holds the same permission key', async () => {
    const { provider, tools } = await mount(DEPT_ADMIN_WITH_PERMISSION)
    await waitForScopeRead(tools)
    expect(await provider!.list()).toEqual([])
    await expect(provider!.get()).rejects.toThrow(/not available/)
  })

  it('stays hidden from a department administrator without a permission list', async () => {
    const { provider, tools } = await mount(DEPT_ADMIN_WITHOUT_PERMISSION_LIST)
    await waitForScopeRead(tools)
    expect(await provider!.list()).toEqual([])
  })

  it('stays hidden from an ordinary user', async () => {
    const { provider, tools } = await mount(ORDINARY)
    await waitForScopeRead(tools)
    expect(await provider!.list()).toEqual([])
    await expect(provider!.get()).rejects.toThrow(/not available/)
  })
})

describe('wanxiang-ai-admin documents', () => {
  const root = new URL('../skills/wanxiang-ai-admin/', import.meta.url)
  const references = ['00-index', 'users-roles', 'resources-grants', 'skills-workspaces', 'api-reference'] as const

  it('ships SKILL.md and every reference it links', async () => {
    const skill = await readFile(new URL('SKILL.md', root), 'utf8')
    expect(skill).toMatch(/^---\nname: wanxiang-ai-admin\ndescription: 万相 AI 中台管理：用户\/角色\/资源授权\/技能与工作区管理\nmetadata:\n  permissions:\n    - system:admin:manage\n---/u)
    for (const name of references) {
      expect(skill).toContain(`references/${name}.md`)
      const reference = await readFile(new URL(`references/${name}.md`, root), 'utf8')
      expect(reference.length).toBeGreaterThan(500)
    }
  })

  it('gives every group reference the required sections and routes field detail to dataops_api_docs', async () => {
    for (const name of ['users-roles', 'resources-grants', 'skills-workspaces'] as const) {
      const reference = await readFile(new URL(`references/${name}.md`, root), 'utf8')
      for (const heading of ['## 业务简介', '## 关键工具与接口', '## 所需权限', '## 审批与确认', '## 常见错误']) {
        expect(reference).toContain(heading)
      }
      expect(reference).toContain('dataops_api_docs')
    }
  })

  it('keeps the API reference to a query guide instead of copying the OpenAPI document', async () => {
    const reference = await readFile(new URL('references/api-reference.md', root), 'utf8')
    for (const group of ['system/users', 'system/roles', 'resources', 'skills', 'workspaces', 'automation', 'operations']) {
      expect(reference).toContain(group)
    }
    expect(reference).toContain('只读')
    expect(reference).toContain('403')
    expect(reference).toContain('dataops_api_docs')
    // A copied document would carry quoted path keys; this guide must not.
    expect(reference).not.toMatch(/^\s*"\/api\//mu)
    expect(reference.length).toBeLessThan(20_000)
  })
})