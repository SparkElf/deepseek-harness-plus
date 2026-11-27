import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ArtifactApi } from '../src/api.ts'
import type { Config } from '../src/config.ts'
import { normalizeExternalLoginRecipe, type ExternalCockpitRow } from '../src/external.ts'
import type { ExternalLoginBroker } from '../src/external-broker.ts'
import { registerExternalCockpitRoutes } from '../src/external-routes.ts'

const cockpit: ExternalCockpitRow = {
  id: 'ext-1',
  name: '销售驾驶舱',
  description: null,
  url: 'https://cockpit.example/sales',
  icon: null,
  tags: [],
  ownerId: null,
  visibility: 'PRIVATE',
  credentialType: 'http',
  credentialHint: null,
  enabled: true,
  health: null,
  updatedAt: null,
}

const recipe = normalizeExternalLoginRecipe({
  version: 1,
  steps: [
    { action: 'goto', url: '{{url}}' },
    { action: 'fill', selector: '#user', value: '{{username}}' },
    { action: 'fill', selector: '#pass', value: '{{password}}' },
    { action: 'click', selector: 'button' },
  ],
  success: { selector: '[data-ready]' },
  timeoutMs: 10_000,
})!

interface FakeResponse {
  status: number
  headers: Record<string, string>
  body: string
  raw: Buffer | null
}

const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage => {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  return Object.assign(stream, {
    method,
    url: path,
    headers: { 'content-type': 'application/json', ...headers },
  }) as unknown as IncomingMessage
}

const response = (): FakeResponse & ServerResponse => {
  const state = {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    raw: null as Buffer | null,
    writeHead(status: number, headers: Record<string, string>) {
      state.status = status
      state.headers = headers
      return state
    },
    end(chunk?: unknown) {
      if (Buffer.isBuffer(chunk)) state.raw = chunk
      else if (chunk !== undefined) state.body = String(chunk)
      return state
    },
  }
  return state as FakeResponse & ServerResponse
}

async function fixture(options: { service?: boolean; recipe?: boolean } = {}) {
  const routes: Array<{ kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> = []
  const service = {
    listForSite: vi.fn(async () => [{
      id: 'cred-1',
      name: 'CRM 登录',
      type: 'http',
      authKind: 'basic',
      username: 'alice',
      origin: 'https://cockpit.example',
      tags: [],
      secretConfigured: true,
    }]),
    describeForSite: vi.fn(async () => ({
      id: 'cred-1',
      name: 'CRM 登录',
      type: 'http',
      authKind: 'basic',
      username: 'alice',
      origin: 'https://cockpit.example',
      tags: [],
      secretConfigured: true,
    })),
    readSecret: vi.fn(async () => ({ password: 'route-secret-value' })),
  }
  const api = {
    getExternalCockpitHostDetail: vi.fn(async () => ({
      cockpit,
      recipe: options.recipe === false ? null : recipe,
      recipeError: null,
      allowedOrigins: ['https://cockpit.example'],
    })),
    linkExternalCockpit: vi.fn(async () => ({
      id: 'ext-1',
      url: 'https://cockpit.example/sales',
      expiresAt: null,
      mode: 'stable',
    })),
  }
  const broker = {
    login: vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1234567890',
      cockpitId: 'ext-1',
      cockpitName: '销售驾驶舱',
      credentialId: 'cred-1',
      credentialName: 'CRM 登录',
      mode: 'headless',
      screenshotUrl: '/dsh-artifact-app/external-cockpits/ext-1/sessions/session-1234567890/screenshot?client=client-abcdefgh',
      finalOrigin: 'https://cockpit.example',
      expiresAt: '2026-11-26T23:00:00.000Z',
    })),
    screenshot: vi.fn(() => Buffer.from('png-bytes')),
    end: vi.fn(),
  }
  const ctx = {
    effect(callback: () => unknown) { callback(); return () => undefined },
    webServer: {
      register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) {
        routes.push(route)
        return () => undefined
      },
    },
    get(name: string) { return name === 'credentialManager' && options.service !== false ? service : undefined },
    logger: { error: vi.fn() },
  } as unknown as Context
  registerExternalCockpitRoutes({
    ctx,
    api: api as unknown as ArtifactApi,
    config: { externalLoginRecipes: {}, externalHeadedEnabled: true } as Config,
    broker: broker as unknown as ExternalLoginBroker,
  })
  const route = routes[0]
  if (route === undefined) throw new Error('external route was not registered')
  return { route, service, api, broker }
}

describe('external cockpit routes', () => {
  it('lists site-scoped credentials without the recipe or a secret', async () => {
    const { route, service } = await fixture()
    const res = response()
    await route.handler(request('GET', '/dsh-artifact-app/external-cockpits/ext-1/credentials'), res)

    expect(res.status).toBe(200)
    const payload = JSON.parse(res.body) as Record<string, unknown>
    expect(payload).toMatchObject({
      cockpitId: 'ext-1',
      credentialType: 'http',
      siteOrigin: 'https://cockpit.example',
      credentialServiceAvailable: true,
      recipeAvailable: true,
      headedEnabled: true,
    })
    expect(JSON.stringify(payload)).not.toContain('{{password}}')
    expect(JSON.stringify(payload)).not.toContain('route-secret-value')
    expect(service.listForSite).toHaveBeenCalledWith({ type: 'http', origin: 'https://cockpit.example' })
  })

  it('rejects a URL-shaped id before calling DataOps', async () => {
    const { route, api } = await fixture()
    const res = response()
    await route.handler(request('GET', '/dsh-artifact-app/external-cockpits/https%3A%2F%2Fevil.example'), res)
    expect(res.status).toBe(400)
    expect(api.getExternalCockpitHostDetail).not.toHaveBeenCalled()
  })

  it('requires an explicit matching credential for a credentialed cockpit', async () => {
    const { route, broker } = await fixture()
    const res = response()
    await route.handler(request('POST', '/dsh-artifact-app/external-cockpits/ext-1/login', {
      clientId: 'client-abcdefgh',
    }), res)
    expect(res.status).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: 'CREDENTIAL_UNAVAILABLE' })
    expect(broker.login).not.toHaveBeenCalled()
  })

  it('executes a headless login with the selected credential and returns a screenshot link only', async () => {
    const { route, broker } = await fixture()
    const res = response()
    await route.handler(request('POST', '/dsh-artifact-app/external-cockpits/ext-1/login', {
      clientId: 'client-abcdefgh',
      credentialId: 'cred-1',
      mode: 'headless',
    }), res)

    expect(res.status).toBe(200)
    const payload = JSON.parse(res.body) as Record<string, unknown>
    expect(payload).toMatchObject({ ok: true, sessionId: 'session-1234567890', mode: 'headless' })
    expect(payload.stableUrl).toBe('https://cockpit.example/sales')
    expect(JSON.stringify(payload)).not.toContain('route-secret-value')
    const input = (broker.login.mock.calls[0] as unknown as [{
      mode: string
      credential: { id: string; secret: Record<string, string> }
    }])[0]
    expect(input.mode).toBe('headless')
    expect(input.credential).toMatchObject({ id: 'cred-1', secret: { password: 'route-secret-value' } })
  })

  it('fails closed when the cockpit has no login recipe', async () => {
    const { route } = await fixture({ recipe: false })
    const res = response()
    await route.handler(request('POST', '/dsh-artifact-app/external-cockpits/ext-1/login', {
      clientId: 'client-abcdefgh',
      credentialId: 'cred-1',
    }), res)
    expect(res.status).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: 'RECIPE_MISSING' })
  })

  it('serves the session screenshot as PNG and ends the session', async () => {
    const { route, broker } = await fixture()
    const shot = response()
    await route.handler(request('GET', '/dsh-artifact-app/external-cockpits/ext-1/sessions/session-1234567890/screenshot?client=client-abcdefgh'), shot)
    expect(shot.status).toBe(200)
    expect(shot.headers['content-type']).toBe('image/png')
    expect(shot.raw?.toString()).toBe('png-bytes')

    const ended = response()
    await route.handler(request('DELETE', '/dsh-artifact-app/external-cockpits/ext-1/sessions/session-1234567890', undefined, {
      'x-dsh-cockpit-client': 'client-abcdefgh',
    }), ended)
    expect(ended.status).toBe(200)
    expect(broker.end).toHaveBeenCalledWith('ext-1', 'session-1234567890', 'client-abcdefgh')
  })

  it('reports a missing credential-manager instead of inventing a picker', async () => {
    const { route } = await fixture({ service: false })
    const res = response()
    await route.handler(request('GET', '/dsh-artifact-app/external-cockpits/ext-1/credentials'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ credentialServiceAvailable: false, credentials: [] })
  })
})