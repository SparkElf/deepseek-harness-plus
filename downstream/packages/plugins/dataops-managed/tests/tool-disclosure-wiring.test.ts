/**
 * The plugin wiring that connects credential/role changes to tool disclosure.
 *
 * `tool-manager.test.ts` drives the manager directly. These cases go through `apply` so the two
 * host integration points are covered as well: the initial connect reads the stored JWT's scope,
 * the `credentials/reference-updated` event re-syncs after JWT adoption, and the same-origin
 * review-context route applies a role change without another scope fetch.
 *
 * @module tests/tool-disclosure-wiring.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/index.ts'

type Tool = { name: string }
type Route = { path: string; handler: (request: unknown, response: unknown) => Promise<void> }
/** One disclosure rule as the Host registry hands it back. */
type Filter = {
  appliesTo: (tool: Tool) => boolean
  hidden: (session: { actor?: unknown } | undefined, tool: Tool) => boolean
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { cleanup() } catch { /* best effort between cases */ }
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

/** A response double that records what a route wrote. */
function responseRecorder() {
  const written: Array<{ status: number; body: string }> = []
  return {
    written,
    response: {
      writeHead: (status: number) => { written.push({ status, body: '' }) },
      end: (body?: string) => { if (body !== undefined && written.length > 0) written[written.length - 1]!.body = body },
      setHeader: () => undefined,
    },
  }
}

/**
 * Build the part of the Host context `apply` touches.
 *
 * The credential event listener is captured so a test can simulate the committed update that
 * JWT adoption produces in production; effects are captured so each case disposes its plugin
 * instance and does not leave a manager observing later cases.
 */
function harness() {
  const routes = new Map<string, Route>()
  const tools = new Map<string, Tool>()
  const filters: Filter[] = []
  const disposed: string[] = []
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const context = {
    credentials: { resolve: vi.fn(async () => ({ value: 'stored-jwt' })) },
    webServer: {
      register: (route: Route) => { routes.set(route.path, route); return () => undefined },
    },
    effect: (factory: () => unknown) => {
      const result = factory()
      if (typeof result === 'function') cleanups.push(result as () => void)
      return () => undefined
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
    },
    plugin: () => ({ uid: 1, await: async () => undefined, dispose: async () => undefined }),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    settings: { describe: () => [], update: async () => undefined },
    skills: { snapshot: async () => ({ skills: [] }), get: async () => undefined, registerProvider: () => () => undefined },
    approval: { request: async () => 'allowed-once' },
    tools: {
      register: (tool: Tool) => {
        tools.set(tool.name, tool)
        return () => { tools.delete(tool.name); disposed.push(tool.name) }
      },
      addVisibilityFilter: (filter: Filter) => {
        filters.push(filter)
        return () => {
          const index = filters.indexOf(filter)
          if (index >= 0) filters.splice(index, 1)
        }
      },
    },
  }
  return { context, routes, tools, filters, disposed, listeners }
}

/** Simulate the committed credential write that fans out to configured listeners. */
function announceCredential(reference: string, listeners: Map<string, Array<(...args: unknown[]) => void>>): void {
  for (const listener of listeners.get('credentials/reference-updated') ?? []) listener(reference)
}

const ORDINARY = {
  userId: 'u1',
  roleCodes: ['应用人员'],
  primaryRole: '应用人员',
  permissions: ['skill:capability:read', 'skill:capability:install'],
}

const EDITOR = {
  userId: 'u1',
  roleCodes: ['部门管理员'],
  primaryRole: '部门管理员',
  permissions: ['skill:capability:read', 'skill:capability:manage'],
  canReview: true,
}

const WITHOUT_CAPABILITIES = {
  userId: 'u1',
  roleCodes: ['应用人员'],
  primaryRole: '应用人员',
  permissions: [],
}

const CONFIG = {
  baseUrl: 'http://dataops.test:3101',
  serverName: 'dataops',
  credentialRef: 'DATAOPS_ACCESS_TOKEN',
  toolCallTimeoutMs: 300_000,
  distributedSettingsNamespaces: [],
} as unknown as Config

describe('apply wires disclosure to the existing auth paths', () => {
  it('registers the scope on initial connect and re-syncs when the credential event fires', async () => {
    let scope: unknown = ORDINARY
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/api/ai/review/context')) return jsonResponse(200, scope)
      return jsonResponse(404, { error: 'not found' })
    }))
    const f = harness()

    await apply(f.context as never, CONFIG)
    await vi.waitFor(() => expect(f.tools.has('skill_list')).toBe(true))
    expect(f.tools.has('skill_enable')).toBe(false)

    // The new token belongs to a principal with more capabilities.
    scope = EDITOR
    announceCredential('DATAOPS_ACCESS_TOKEN', f.listeners)
    await vi.waitFor(() => expect(f.tools.has('skill_enable')).toBe(true))

    // A later credential event discovers a demotion and disposes what the role lost.
    scope = WITHOUT_CAPABILITIES
    announceCredential('DATAOPS_ACCESS_TOKEN', f.listeners)
    await vi.waitFor(() => expect(f.tools.has('skill_enable')).toBe(false))
    expect(f.disposed).toContain('skill_enable')
  })

  it('applies a role change from the review-context route without fetching it twice', async () => {
    let scope: unknown = EDITOR
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/api/ai/review/context')) return jsonResponse(200, scope)
      return jsonResponse(404, { error: 'not found' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const f = harness()

    await apply(f.context as never, CONFIG)
    await vi.waitFor(() => expect(f.tools.has('skill_enable')).toBe(true))
    const contextCalls = () => fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter(url => url.endsWith('/api/ai/review/context'))
      .length
    const callsBefore = contextCalls()

    scope = WITHOUT_CAPABILITIES
    const route = f.routes.get('/integrations/dataops/review-context')
    expect(route).toBeDefined()
    const { response, written } = responseRecorder()
    await route!.handler({ method: 'GET' }, response)

    expect(written[0]?.status).toBe(200)
    expect(f.tools.has('skill_enable')).toBe(false)
    // The route answer was reused, so it added exactly the one fetch the route itself makes.
    expect(contextCalls()).toBe(callsBefore + 1)
  })

  it('claims the declared workflow MCP tools and hides them from a member actor', async () => {
    const superAdmin = {
      userId: 'super',
      roleCodes: ['超级管理员'],
      primaryRole: '超级管理员',
      permissions: ['skill:read'],
    }
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/api/ai/review/context')) return jsonResponse(200, superAdmin)
      return jsonResponse(404, { error: 'not found' })
    }))
    const f = harness()

    await apply(f.context as never, CONFIG)
    await vi.waitFor(() => expect(f.tools.has('skill_list')).toBe(true))
    expect(f.filters).toHaveLength(1)
    const filter = f.filters[0]!

    // The filter claims the plugin's own tools and exactly the MCP tools the table declares.
    expect(filter.appliesTo({ name: 'dataops_api_docs' })).toBe(true)
    expect(filter.appliesTo({ name: 'mcp__dataops__workflow_query' })).toBe(true)
    expect(filter.appliesTo({ name: 'mcp__dataops__query' })).toBe(false)
    expect(filter.appliesTo({ name: 'another_plugin_tool' })).toBe(false)

    const workflowQuery = { name: 'mcp__dataops__workflow_query' }
    // A room acting for a member hides it even though the workspace registered it.
    expect(filter.hidden({ actor: { roleCodes: ['应用人员'], permissions: [] } }, workflowQuery)).toBe(true)
    // A super-administrator actor keeps it, and an ordinary Session follows the workspace scope.
    expect(filter.hidden({ actor: superAdmin }, workflowQuery)).toBe(false)
    expect(filter.hidden(undefined, workflowQuery)).toBe(false)
  })
})
