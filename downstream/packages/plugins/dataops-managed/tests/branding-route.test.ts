/**
 * The branding route must exist without a DataOps credential: the workspace shell renders its
 * name, logo, title and favicon before the user has a session, and every upstream failure has to
 * answer the hardcoded default instead of breaking the shell.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, BRANDING_PATH, inject } from '../src/index.ts'
import { BRANDING_PATH as CLIENT_BRANDING_PATH } from '../src/client/branding-client.ts'
import type { Config } from '../src/index.ts'

interface RegisteredRoute {
  path: string
  handler: (request: unknown, response: unknown) => Promise<void>
}

function responseRecorder() {
  const written: { status: number; body: string }[] = []
  return {
    written,
    response: {
      writeHead: (status: number) => { written.push({ status, body: '' }) },
      end: (body?: string) => {
        if (body !== undefined && written.length > 0) written[written.length - 1]!.body = body
      },
      setHeader: () => undefined,
    },
  }
}

function answer(value: string | null) {
  return { ok: true, status: 200, json: async () => ({ setting: value === null ? null : { value } }) } as Response
}

/**
 * A context that stands in for the DSH Host and enforces the Cordis inject rule.
 */
function contextWithHost() {
  const routes: RegisteredRoute[] = []
  const services: Record<string, unknown> = {
    credentials: { resolve: vi.fn(async () => ({ value: 'jwt' })) },
    webServer: {
      register: (route: RegisteredRoute) => { routes.push(route); return () => undefined },
    },
    settings: { describe: () => [], update: async () => undefined },
    skills: { list: () => [], registerProvider: () => () => undefined },
    tools: { register: () => undefined },
    agents: { list: () => [], get: vi.fn(), resume: vi.fn() },
    approval: {},
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

const CONFIG = {
  baseUrl: 'http://dataops.test:3101',
  serverName: 'dataops',
  credentialRef: 'DATAOPS_ACCESS_TOKEN',
  toolCallTimeoutMs: 300_000,
  distributedSettingsNamespaces: [],
} as unknown as Config

const CONFIG_WITH_PORTAL = {
  ...CONFIG,
  webBaseUrl: 'http://portal.test:8080',
} as unknown as Config

describe('branding route', () => {
  it('keeps the Host and client route strings identical', () => {
    expect(CLIENT_BRANDING_PATH).toBe(BRANDING_PATH)
  })

  let directory = ''
  const previousDshHome = process.env.DSH_HOME

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dataops-branding-test-'))
    process.env.DSH_HOME = directory
  })

  afterEach(async () => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
  })

  it('answers the AI workspace brand from the three public settings', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      const url = String(input)
      if (url.endsWith('/platform/workspace_brand_name')) return answer('星海 AI 工作区')
      if (url.endsWith('/platform/brand_name')) return answer('星海数据中台')
      if (url.endsWith('/platform/brand_logo')) return answer('data:image/png;base64,AAAA')
      return answer(null)
    }))

    const { context, routes } = contextWithHost()
    await apply(context as never, CONFIG)
    const route = routes.find(item => item.path === BRANDING_PATH)
    expect(route).toBeDefined()

    const { response, written } = responseRecorder()
    await route!.handler({ method: 'GET' }, response)

    expect(written[0]?.status).toBe(200)
    expect(JSON.parse(written[0]!.body)).toEqual({
      name: '星海 AI 工作区',
      logo: 'data:image/png;base64,AAAA',
    })
  })

  it('resolves a portal-relative logo against the browser-facing origin', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      const url = String(input)
      if (url.endsWith('/platform/workspace_brand_name')) return answer('星海 AI 工作区')
      if (url.endsWith('/platform/brand_logo')) return answer('/brands/custom.png')
      return answer(null)
    }))

    const { context, routes } = contextWithHost()
    await apply(context as never, CONFIG_WITH_PORTAL)
    const route = routes.find(item => item.path === BRANDING_PATH)

    const { response, written } = responseRecorder()
    await route!.handler({ method: 'GET' }, response)

    expect(JSON.parse(written[0]!.body)).toEqual({
      name: '星海 AI 工作区',
      logo: 'http://portal.test:8080/brands/custom.png',
    })
  })

  it('falls back to the hardcoded default when DataOps is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED') }))

    const { context, routes } = contextWithHost()
    await apply(context as never, CONFIG)
    const route = routes.find(item => item.path === BRANDING_PATH)
    expect(route).toBeDefined()

    const { response, written } = responseRecorder()
    await route!.handler({ method: 'GET' }, response)

    expect(written[0]?.status).toBe(200)
    expect(JSON.parse(written[0]!.body)).toEqual({ name: '万相AI中台', logo: '' })
  })

  it('only serves GET', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(null)))
    const { context, routes } = contextWithHost()
    await apply(context as never, CONFIG)
    const route = routes.find(item => item.path === BRANDING_PATH)

    const { response, written } = responseRecorder()
    await route!.handler({ method: 'POST' }, response)

    expect(written[0]?.status).toBe(405)
  })
})