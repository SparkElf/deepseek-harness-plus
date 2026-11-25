/**
 * The workspace-upgrade route reads `ctx.agents`, so the plugin must declare `agents` in its
 * Cordis `inject` list.
 *
 * Cordis resolves a service through the context proxy only for declared dependencies: an
 * undeclared read throws `cannot get property "<name>" without inject`, the route handler turns
 * that into `502 {"error":...}`, and the portal shows a Bad Gateway instead of the upgrade
 * prompt. `49d8887` dropped `agents` from `inject` while adding an unrelated artifact-app
 * feature, so this file pins both halves of the contract: the declaration and the route answer.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, WORKSPACE_UPGRADE_PATH } from '../src/index.ts'
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

/** The running session the route is expected to report. */
const runningAgent = {
  id: 'session-a',
  status: 'running' as const,
  session: { id: 'session-a', header: { title: '升级中的会话', cwd: '/workspace' } },
  followup: vi.fn(),
}

/**
 * A context that stands in for the DSH Host and enforces the one Cordis rule under test.
 *
 * Core context members live on the target. Services live in `services`, and reading one that
 * the plugin did not declare in `inject` throws the same message Cordis produces. Without this
 * guard a plain object would hand back `undefined` and the regression would pass silently.
 */
function contextWithAgents() {
  const routes: RegisteredRoute[] = []
  const services: Record<string, unknown> = {
    credentials: { resolve: vi.fn(async () => ({ value: 'jwt' })) },
    webServer: {
      register: (route: RegisteredRoute) => { routes.push(route); return () => undefined },
    },
    settings: { describe: () => [], update: async () => undefined },
    skills: { list: () => [], registerProvider: () => () => undefined },
    tools: { register: () => undefined },
    agents: { list: () => [runningAgent], get: vi.fn(), resume: vi.fn() },
  }
  const declared = new Set<string>(inject)
  const target = {
    effect: (factory: () => unknown) => { factory(); return () => undefined },
    on: () => undefined,
    plugin: () => ({
      uid: 1,
      await: async () => undefined,
      dispose: async () => undefined,
    }),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  }
  const context = new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'string' && property in services) {
        if (!declared.has(property)) throw new Error(`cannot get property "${property}" without inject`)
        return services[property]
      }
      return Reflect.get(object, property, receiver)
    },
  })
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

describe('workspace-upgrade route', () => {
  let directory = ''
  const previousDshHome = process.env.DSH_HOME

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dataops-inject-test-'))
    process.env.DSH_HOME = directory
  })

  afterEach(async () => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
  })

  it('declares the agents service it reads', () => {
    expect(inject).toContain('agents')
  })

  it('answers the preview with the running sessions instead of a 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        workspace: { imageStatus: 'UPDATE_AVAILABLE', configuredImage: 'dataops-ai-workspace:local' },
        activeTasks: [{ id: 'task-1' }],
      }),
    })))

    const { context, routes } = contextWithAgents()
    await apply(context as never, CONFIG)
    const route = routes.find(item => item.path === WORKSPACE_UPGRADE_PATH)
    expect(route).toBeDefined()

    const { response, written } = responseRecorder()
    await route!.handler({ method: 'GET' }, response)

    expect(written[0]?.status).toBe(200)
    expect(JSON.parse(written[0]!.body)).toMatchObject({
      imageStatus: 'UPDATE_AVAILABLE',
      activeSessions: [{ sessionId: 'session-a', title: '升级中的会话', cwd: '/workspace' }],
    })
  })
})