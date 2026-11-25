import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { capabilityResponse, registerAdminProxy } from '../../src/admin/proxy.ts'

/** The subset of `ServerResponse` the proxy touches, with the written body retained. */
interface CapturedResponse {
  status: number
  headers: Record<string, string | number>
  body: string
}

/** One registered prefix route plus the fake host required to register it. */
function harness(): {
  ctx: Context
  route: () => { handler: (request: any, response: any) => Promise<void> }
} {
  let registered: { handler: (request: any, response: any) => Promise<void> } | undefined
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    webServer: {
      register: (value: { handler: (request: any, response: any) => Promise<void> }) => {
        registered = value
        return () => {}
      },
    },
    logger: { warn: vi.fn() },
  } as unknown as Context
  return {
    ctx,
    route: () => {
      if (registered === undefined) throw new Error('proxy route was not registered')
      return registered
    },
  }
}

/** Invoke the registered handler with a minimal IncomingMessage/ServerResponse pair. */
async function callProxy(route: { handler: (request: any, response: any) => Promise<void> }, path: string): Promise<CapturedResponse> {
  const request = Readable.from([]) as any
  request.method = 'GET'
  request.url = path
  request.headers = { authorization: 'Bearer test-token' }
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' }
  const response = {
    writeHead(status: number, headers?: Record<string, string | number>) {
      captured.status = status
      captured.headers = headers ?? {}
    },
    end(chunk?: string | Buffer) {
      captured.body = chunk === undefined ? '' : String(chunk)
    },
  }
  await route.handler(request, response)
  return captured
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('capabilityResponse', () => {
  it('passes through a supported deployment', () => {
    expect(capabilityResponse(200, '{"allowed":true}')).toEqual({
      status: 200,
      body: { available: true, allowed: true },
    })
    expect(capabilityResponse(200, '{"allowed":false}')).toEqual({
      status: 200,
      body: { available: true, allowed: false },
    })
  })

  it.each([404, 500, 502, 503])('turns HTTP %i into an unavailable 200', (status) => {
    const result = capabilityResponse(status, 'not found')
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ available: false, allowed: false })
    expect(result.body.reason).toContain(String(status))
  })

  it('keeps 401/403 as present-but-forbidden', () => {
    expect(capabilityResponse(401, '{}')).toEqual({
      status: 200,
      body: { available: true, allowed: false, reason: 'unauthenticated' },
    })
    expect(capabilityResponse(403, '{}')).toEqual({
      status: 200,
      body: { available: true, allowed: false, reason: 'forbidden' },
    })
  })

  it('treats an unparseable 200 as unavailable', () => {
    expect(capabilityResponse(200, '<html>bad gateway</html>').body).toMatchObject({
      available: false,
      allowed: false,
    })
  })
})

describe('registerAdminProxy capability route', () => {
  it('returns 200 {available:false} when the backend has no capability route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"not found"}', { status: 404 })))
    const { ctx, route } = harness()
    await registerAdminProxy(ctx, { baseUrl: 'http://backend.test:3101' })
    const response = await callProxy(route(), '/integrations/dataops/im/capability')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ available: false, allowed: false })
  })

  it('returns 200 {available:false} when the proxy cannot reach DataOps', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED') }))
    const { ctx, route } = harness()
    await registerAdminProxy(ctx, { baseUrl: 'http://backend.test:3101' })
    const response = await callProxy(route(), '/integrations/dataops/im/capability')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      available: false,
      allowed: false,
      reason: 'DataOps 后端不可达',
    })
  })

  it('keeps capability=true when DataOps serves it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"allowed":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    const { ctx, route } = harness()
    await registerAdminProxy(ctx, { baseUrl: 'http://backend.test:3101' })
    const response = await callProxy(route(), '/integrations/dataops/im/capability')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ available: true, allowed: true })
  })

  it('does not change the bots route: a dead backend still answers 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED') }))
    const { ctx, route } = harness()
    await registerAdminProxy(ctx, { baseUrl: 'http://backend.test:3101' })
    const response = await callProxy(route(), '/integrations/dataops/im/bots')
    expect(response.status).toBe(502)
  })
})