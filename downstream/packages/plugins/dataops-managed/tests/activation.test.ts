/**
 * Activation must not depend on DataOps being reachable.
 *
 * A stored JWT that DataOps has since rejected, or an unreachable backend, is a state the
 * settings panel reports and recovers from. When the MCP connect ran before the routes were
 * registered, a failed connect aborted activation and the plugin mounted with no routes at
 * all: every settings request answered 404, so the browser showed a connection failure and
 * the panel could not even display the reason. These tests drive `apply` with a credential
 * service and MCP client that fail, and assert the routes still came up.
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** One route as the fake Web server received it. */
interface RegisteredRoute {
  path: string
  handler: (request: unknown, response: unknown) => Promise<void>
}

/** A Response double that records what the handler wrote. */
function responseRecorder() {
  const written: { status: number; body: string }[] = []
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
 * A context that stands in for the DSH Host.
 *
 * Only what `apply` touches is implemented: credential resolution, the Web server registry,
 * effects, and a logger. `plugin` reports a fiber whose `await` rejects, standing in for an
 * MCP connect that cannot complete.
 */
function contextWith(hasCredential: boolean) {
  const routes: RegisteredRoute[] = []
  const context = {
    credentials: { resolve: vi.fn(async () => (hasCredential ? { value: 'stale-jwt' } : undefined)) },
    webServer: {
      register: (route: RegisteredRoute) => { routes.push(route); return () => undefined },
    },
    effect: (factory: () => unknown) => { factory(); return () => undefined },
    on: () => undefined,
    plugin: () => ({
      uid: 1,
      await: async () => { throw new Error('MCP connect refused the stored JWT') },
      dispose: async () => undefined,
    }),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    settings: { describe: () => [], update: async () => undefined },
    skills: { list: () => [], registerProvider: () => () => undefined },
    tools: { register: () => undefined },
  }
  return { context, routes }
}

/** The smallest config the plugin accepts. */
const CONFIG = {
  baseUrl: 'http://dataops.test:3101',
  serverName: 'dataops',
  credentialRef: 'DATAOPS_ACCESS_TOKEN',
  toolCallTimeoutMs: 300_000,
  distributedSettingsNamespaces: [],
} as unknown as Config

describe('apply', () => {
  it('registers every settings route when the MCP connect fails', async () => {
    const { context, routes } = contextWith(true)

    await expect(apply(context as never, CONFIG)).resolves.toBeUndefined()
    expect(routes.map((route) => route.path).sort()).toEqual([
      '/api/dsh-skill-center/browser-bridge/installer',
      '/api/dsh-skill-center/connectors',
      '/integrations/dataops/auth-state',
      '/integrations/dataops/browser-bridge/auto-pair',
      '/integrations/dataops/departments',
      '/integrations/dataops/managed-auth',
      '/integrations/dataops/model-sync',
      '/integrations/dataops/open-resource/events',
      '/integrations/dataops/rbac',
      '/integrations/dataops/resource-tab/config',
      '/integrations/dataops/resources',
      '/integrations/dataops/review',
      '/integrations/dataops/review-context',
      '/integrations/dataops/review-notifications',
      '/integrations/dataops/review-settings',
      '/integrations/dataops/scoped-token',
      '/integrations/dataops/skill-plaza',
      '/integrations/dataops/tool-timeout',
      '/integrations/dataops/workspace-limits',
      '/integrations/dataops/workspace-upgrade',
    ])
  })

  it('registers the routes when no credential is stored', async () => {
    const { context, routes } = contextWith(false)

    await expect(apply(context as never, CONFIG)).resolves.toBeUndefined()
    // Five surfaces plus the auth-state read the sign-in prompt polls. Asserted by name rather
    // than only by count, so adding a route cannot silently displace one that a panel needs.
    expect(routes.map((route) => route.path).sort()).toEqual([
      '/api/dsh-skill-center/browser-bridge/installer',
      '/api/dsh-skill-center/connectors',
      '/integrations/dataops/auth-state',
      '/integrations/dataops/browser-bridge/auto-pair',
      '/integrations/dataops/departments',
      '/integrations/dataops/managed-auth',
      '/integrations/dataops/model-sync',
      '/integrations/dataops/open-resource/events',
      '/integrations/dataops/rbac',
      '/integrations/dataops/review',
      '/integrations/dataops/review-context',
      '/integrations/dataops/review-notifications',
      '/integrations/dataops/resource-tab/config',
      '/integrations/dataops/resources',
      '/integrations/dataops/review-settings',
      '/integrations/dataops/scoped-token',
      '/integrations/dataops/skill-plaza',
      '/integrations/dataops/tool-timeout',
      '/integrations/dataops/workspace-limits',
      '/integrations/dataops/workspace-upgrade',
    ].sort())
  })

  it('contributes the query skill with its document readable from the package', async () => {
    // The skill travels with the plugin, so activation must reach the catalog even when the
    // MCP connection is refused: a data question is answered by this guidance, not the tool.
    const registered: unknown[] = []
    const { context } = contextWith(true)
    ;(context as { skills: { registerProvider: (fn: () => unknown) => () => void } }).skills.registerProvider =
      (provider: () => unknown) => { registered.push(provider()); return () => undefined }

    await apply(context as never, CONFIG)

    expect((registered as Array<{ name: string }>).map((item) => item.name).sort())
      .toEqual(['api-connector-authoring', 'browser', 'dataops-collect', 'dataops-governance', 'dataops-metadata-optimizer', 'dataops-query', 'dataops-synonym-governance', 'prefect-script-authoring', 'skill-provisioning'])
    const provider = (registered as Array<{ name: string }>).find((item) => item.name === 'dataops-query') as unknown as {
      name: string
      list: () => Promise<{ name: string; locator: URL }[]>
      get: () => Promise<{ name: string; content: string }>
    }
    expect(provider.name).toBe('dataops-query')
    expect((await provider.list())[0]?.name).toBe('dataops-query')
    const skill = await provider.get()
    expect(skill.content).toContain('取数')
  })

  it('answers the limits route rather than failing when the credential was rejected', async () => {
    // The stored JWT is stale, so DataOps refuses it. That is the state that used to abort
    // activation; the route must still exist and must report "not connected".
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) })))
    const { context, routes } = contextWith(true)
    await apply(context as never, CONFIG)
    const limits = routes.find((route) => route.path === '/integrations/dataops/workspace-limits')
    expect(limits).toBeDefined()

    const { response, written } = responseRecorder()
    await limits!.handler({ method: 'GET' }, response)
    vi.unstubAllGlobals()

    // 503 is the panel's "not connected" state; a 404 would mean the route never registered.
    expect(written[0]?.status).toBe(503)
  })

  it('records why the connect failed instead of throwing it', async () => {
    const { context } = contextWith(true)
    await apply(context as never, CONFIG)
    expect(context.logger.warn).toHaveBeenCalled()
  })

  it('gates the skill-provisioning skill until the account holds skill:manage', async () => {
    // Activation with no scope must not advertise the provisioning playbook: the tools it drives
    // are disclosed by the same capability, so an account without it would only see dead guidance.
    const registered: Array<{ name: string; list: () => Promise<unknown[]>; get: () => Promise<unknown> }> = []
    const { context } = contextWith(true)
    ;(context as { skills: { registerProvider: (fn: () => unknown) => () => void } }).skills.registerProvider =
      (provider: () => unknown) => { registered.push(provider() as never); return () => undefined }

    await apply(context as never, CONFIG)

    const provisioning = registered.find((item) => item.name === 'skill-provisioning')
    expect(provisioning).toBeDefined()
    expect(await provisioning!.list()).toEqual([])
    await expect(provisioning!.get()).rejects.toThrow(/not available/)
  })

  it('serves one browser skill whose references carry the mode playbooks', async () => {
    // The workspace image also carries copies under /workspace/skills, but the skill center
    // lists providers only. One `browser` entry must route headless, companion, and the
    // legacy Chrome-install playbook through explicit relative reference links.
    const registered: Array<{
      name: string
      list: () => Promise<Array<{ name: string; source: string; resourceBase: { kind: string; path: string } }>>
      get: () => Promise<{ name: string; content: string }>
    }> = []
    const { context } = contextWith(true)
    ;(context as { skills: { registerProvider: (fn: () => unknown) => () => void } }).skills.registerProvider =
      (provider: () => unknown) => { registered.push(provider() as never); return () => undefined }

    await apply(context as never, CONFIG)

    const provider = registered.find((item) => item.name === 'browser')
    expect(provider).toBeDefined()
    const listed = await provider!.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ name: 'browser', source: 'bundled', resourceBase: { kind: 'directory' } })
    expect(listed[0]?.resourceBase.path.endsWith('/skills/browser/')).toBe(true)
    const skill = await provider!.get()
    expect(skill.name).toBe('browser')
    expect(skill.content).toContain('name: browser')
    for (const reference of ['references/headless.md', 'references/bridge.md', 'references/chrome-install.md']) {
      expect(skill.content).toContain(reference)
      const referencePath = new URL(reference, `file://${listed[0]!.resourceBase.path}`)
      expect(await readFile(referencePath, 'utf8')).not.toBe('')
    }
  })
})
