import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  DELIVERY_INGRESS_PATH,
  IM_TOOL_NAMES,
  installAdminRoutes,
  installImToolGate,
  installManagementRpcGate,
  isSessionAuthorized,
  type RegistrationOptionsLike,
  type SessionLike,
  type ToolDefinitionLike,
  type ToolRegistryLike,
} from '../../src/gating.ts'

/** Minimal registry double that records registrations, options and filters. */
class RegistryStub implements ToolRegistryLike {
  readonly entries = new Map<string, { definition: ToolDefinitionLike; options: RegistrationOptionsLike }>()
  readonly filters: { appliesTo: (tool: ToolDefinitionLike) => boolean; hidden: (session: SessionLike | undefined, tool: ToolDefinitionLike) => boolean }[] = []

  register(definition: ToolDefinitionLike, options: RegistrationOptionsLike = {}): () => void {
    this.entries.set(definition.name, { definition, options })
    return () => { this.entries.delete(definition.name) }
  }

  addVisibilityFilter(filter: { appliesTo: (tool: ToolDefinitionLike) => boolean; hidden: (session: SessionLike | undefined, tool: ToolDefinitionLike) => boolean }): () => void {
    this.filters.push(filter)
    return () => {
      const index = this.filters.indexOf(filter)
      if (index >= 0) this.filters.splice(index, 1)
    }
  }
}

function definition(name: string): ToolDefinitionLike {
  return {
    name,
    description: name,
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
    execute: vi.fn(async () => 'ok'),
  } as unknown as ToolDefinitionLike
}

function host(registry: RegistryStub): Context {
  return { tools: registry, logger: { warn: vi.fn() } } as unknown as Context
}

describe('isSessionAuthorized', () => {
  it('admits an administrator workspace and a host-issued IM actor only', () => {
    expect(isSessionAuthorized(undefined, { registerTools: false, isAdmin: () => false })).toBe(false)
    expect(isSessionAuthorized({}, { registerTools: false, isAdmin: () => false })).toBe(false)
    expect(isSessionAuthorized({}, { registerTools: false, isAdmin: () => true })).toBe(true)
    expect(isSessionAuthorized({ actor: { roleCodes: ['应用人员'] } }, { registerTools: false, isAdmin: () => false })).toBe(true)
    expect(isSessionAuthorized({ actor: { unrelated: true } }, { registerTools: false, isAdmin: () => false })).toBe(false)
    expect(isSessionAuthorized({}, { registerTools: true, isAdmin: () => false })).toBe(true)
  })
})

describe('installImToolGate', () => {
  it('registers dsh-im tools behind a step condition and execution guard', async () => {
    const registry = new RegistryStub()
    let admin = false
    const dispose = installImToolGate(host(registry), { registerTools: false, isAdmin: () => admin })
    registry.register(definition('dsh_im_group_history'))
    registry.register(definition('dsh_im_group_file'))
    registry.register(definition('dsh_im_return_file'))
    registry.register(definition('read'))

    expect([...registry.entries.keys()].sort()).toEqual(['dsh_im_group_file', 'dsh_im_group_history', 'dsh_im_return_file', 'read'])
    const entry = registry.entries.get('dsh_im_group_history')!
    expect(await entry.options.when?.({ agent: { session: {} } })).toBe(false)
    admin = true
    expect(await entry.options.when?.({ agent: { session: {} } })).toBe(true)

    const execution = { agent: { session: {} } }
    admin = false
    await expect(entry.definition.execute({}, execution)).rejects.toThrow(/restricted to administrators/)
    admin = true
    await expect(entry.definition.execute({}, execution)).resolves.toBe('ok')

    expect(registry.filters).toHaveLength(1)
    admin = false
    expect(registry.filters[0]!.hidden({}, entry.definition)).toBe(true)
    admin = true
    expect(registry.filters[0]!.hidden({}, entry.definition)).toBe(false)

    dispose()
    expect([...registry.entries.keys()]).toEqual(['read'])
    expect(registry.filters).toHaveLength(0)
    expect(IM_TOOL_NAMES.has('dsh_im_return_file')).toBe(true)
  })

  it('passes non-IM registrations through untouched', () => {
    const registry = new RegistryStub()
    const dispose = installImToolGate(host(registry), { registerTools: false, isAdmin: () => false })
    const read = definition('read')
    registry.register(read)
    expect(registry.entries.get('read')?.definition).toBe(read)
    dispose()
  })
})

describe('installManagementRpcGate', () => {
  it('answers 403 for a non-administrator and delegates for an administrator, leaving delivery ingress alone', async () => {
    const routes: { path: string; fetch: (request: Request) => Promise<Response> }[] = []
    const connection = {
      fetch: {
        register(route: { path: string; fetch: (request: Request) => Promise<Response> }) {
          routes.push(route)
          return async () => {}
        },
      },
    }
    let admin = false
    const resolver = { adopt: vi.fn(async () => {}), isAdmin: () => admin, current: () => undefined }
    const ctx = { connection, logger: { warn: vi.fn() } } as unknown as Context
    const dispose = installManagementRpcGate(ctx, { resolver: resolver as never })

    const inner = vi.fn(async () => new Response('ok'))
    // Simulate dsh-im registering one management channel and the delivery ingress.
    connection.fetch.register({ path: '/api/dsh-im/wecom', fetch: inner })
    connection.fetch.register({ path: DELIVERY_INGRESS_PATH, fetch: inner })

    const management = routes[0]!
    const delivery = routes[1]!
    const request = new Request('http://127.0.0.1/api/dsh-im/wecom', { headers: { authorization: 'Bearer test-token' } })

    const denied = await management.fetch(request)
    expect(denied.status).toBe(403)
    expect(inner).not.toHaveBeenCalled()
    expect(resolver.adopt).toHaveBeenCalledWith('test-token')

    admin = true
    const allowed = await management.fetch(request)
    expect(allowed.status).toBe(200)
    expect(inner).toHaveBeenCalled()

    expect(delivery.path).toBe(DELIVERY_INGRESS_PATH)
    expect(await delivery.fetch(request)).toBeInstanceOf(Response)
    dispose()
  })
})
describe('installAdminRoutes pending senders', () => {
  it('answers 403 for ordinary users and returns administrator-visible senders without tokens', async () => {
    const routes: { path: string; methods: string[]; fetch: (request: Request) => Promise<Response> }[] = []
    const connection = {
      fetch: {
        register(route: { path: string; methods: string[]; fetch: (request: Request) => Promise<Response> }) {
          routes.push(route)
          return async () => {}
        },
      },
    }
    let admin = false
    const resolver = { adopt: vi.fn(async () => {}), isAdmin: () => admin, current: () => undefined }
    const items = [{
      sessionId: 'session-1',
      botId: 'bot-1',
      senderId: 'zhangsan',
      senderIdMasked: 'zh****an',
      senderName: '张三',
      chatType: 'single',
      status: 'unmapped',
      bound: false,
      unmapped: true,
      updatedAt: 1_700_000_000_000,
    }]
    const ctx = { connection, logger: { warn: vi.fn() } } as unknown as Context
    const dispose = installAdminRoutes(ctx, {
      resolver: resolver as never,
      baseUrl: 'http://dataops.test',
      mode: 'connector',
      identityPending: () => items,
    })

    const route = routes.find((entry) => entry.path === '/api/dsh-dataops-im/identity/pending')!
    expect(route).toBeDefined()
    expect(route.methods).toEqual(['GET'])
    const request = new Request('http://127.0.0.1/api/dsh-dataops-im/identity/pending', {
      headers: { authorization: 'Bearer test-token' },
    })

    const denied = await route.fetch(request)
    expect(denied.status).toBe(403)
    expect(await denied.text()).not.toContain('zhangsan')
    expect(resolver.adopt).toHaveBeenCalledWith('test-token')

    admin = true
    const anonymous = await route.fetch(new Request('http://127.0.0.1/api/dsh-dataops-im/identity/pending'))
    expect(anonymous.status).toBe(403)

    const allowed = await route.fetch(request)
    expect(allowed.status).toBe(200)
    const body = await allowed.json() as { ok: boolean; items: { senderId: string; senderName: string; status: string }[] }
    expect(body.ok).toBe(true)
    expect(body.items[0]).toMatchObject({ senderId: 'zhangsan', senderName: '张三', status: 'unmapped' })
    expect(JSON.stringify(body)).not.toContain('token')
    for (const disposeRoute of dispose) await disposeRoute()
  })
})
