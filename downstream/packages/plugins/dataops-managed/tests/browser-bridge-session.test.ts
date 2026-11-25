/**
 * The browser bridge state machine and its wire parsing.
 *
 * These tests drive the session without a DataOps host: `fetch` is a router and the MCP client
 * is a pair of spies. The point is the lifecycle contract — one MCP client per session, retry
 * after an offline companion, refresh without reconnecting, and release only on `closed`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserBridgeSession,
  describeError,
  expiresSoon,
  parseRefreshAnswer,
  parseSessionAnswer,
  parseStatusAnswer,
  redactMcpUrl,
  redactUrls,
  REFRESH_AHEAD_MS,
  type BrowserBridgeMcpHandle,
  type BrowserBridgeSessionDeps,
} from '../src/browser-bridge-session.ts'
import { currentAuthState, resetAuthState } from '../src/auth-state.ts'

/** A fixed clock keeps expiry arithmetic exact. */
const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const SESSION_ID = 'session-1'
const MCP_URL = `http://dataops.test:3101/api/ai/browser-bridge/mcp/${SESSION_ID}?ticket=secret-ticket`
const TOKEN = 'bridge-token-1'

/** One JSON answer with the gateway's content type. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** An active session answer. */
function sessionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    deviceId: 'device-1',
    mcpUrl: MCP_URL,
    bridgeToken: TOKEN,
    expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
    gatewayInstanceId: 'gw-1',
    tunnelGeneration: 1,
    ...overrides,
  }
}

/** A session status answer, with or without the tunnel identity fields. */
function statusBody(status: 'active' | 'closed', identity: {
  gatewayInstanceId?: string
  tunnelGeneration?: number
} = {}): Record<string, unknown> {
  return {
    status,
    ...(identity.gatewayInstanceId === undefined ? {} : { gatewayInstanceId: identity.gatewayInstanceId }),
    ...(identity.tunnelGeneration === undefined ? {} : { tunnelGeneration: identity.tunnelGeneration }),
  }
}

/** A fetch double that records every request and answers through one router. */
function fetchRouter(route: (url: string, init: RequestInit | undefined) => Response): {
  fetch: typeof fetch
  calls: { url: string; method: string }[]
} {
  const calls: { url: string; method: string }[] = []
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() })
    return route(url, init)
  })
  return { fetch: impl as unknown as typeof fetch, calls }
}

/**
 * A session whose MCP clients are observable.
 *
 * Each successful connect returns a fresh handle, because a rebuild must dispose the previous
 * client and initialize a new one; returning one shared object would hide that.
 */
function sessionWith(fetchImpl: typeof fetch, options: {
  enabled?: boolean
  token?: () => string | undefined
} = {}) {
  const handles: BrowserBridgeMcpHandle[] = []
  const connectMcp = vi.fn(async () => {
    let alive = true
    const handle: BrowserBridgeMcpHandle = {
      alive: () => alive,
      dispose: vi.fn(async () => { alive = false }),
    }
    handles.push(handle)
    return handle
  })
  const logger = { warn: vi.fn() }
  const deps: BrowserBridgeSessionDeps = {
    baseUrl: 'http://dataops.test:3101',
    resolveToken: async () => (options.token === undefined ? 'dataops-jwt' : options.token()),
    isEnabled: async () => options.enabled ?? true,
    connectMcp,
    logger,
    now: () => NOW,
    fetch: fetchImpl,
  }
  return { bridge: new BrowserBridgeSession(deps), handles, connectMcp, logger }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetAuthState()
})

afterEach(() => {
  vi.useRealTimers()
  resetAuthState()
})

describe('browser bridge wire parsing', () => {
  it('accepts an active session and rejects one missing its connection fields', () => {
    expect(parseSessionAnswer(200, sessionBody())).toEqual({
      kind: 'active',
      session: {
        sessionId: SESSION_ID,
        deviceId: 'device-1',
        mcpUrl: MCP_URL,
        bridgeToken: TOKEN,
        expiresAt: NOW + 15 * 60_000,
        gatewayInstanceId: 'gw-1',
        tunnelGeneration: 1,
      },
    })
    expect(parseSessionAnswer(200, { sessionId: SESSION_ID })).toMatchObject({ kind: 'error' })
    expect(parseSessionAnswer(200, sessionBody({ mcpUrl: 'file:///tmp/mcp' }))).toMatchObject({ kind: 'error' })
  })

  it('classifies 409, 401, and other refusals', () => {
    expect(parseSessionAnswer(409, { code: 'COMPANION_OFFLINE' })).toEqual({ kind: 'offline' })
    expect(parseSessionAnswer(401, null)).toEqual({ kind: 'unauthorized' })
    expect(parseSessionAnswer(500, { code: 'BOOM' })).toEqual({
      kind: 'error',
      message: 'session request failed (HTTP 500 BOOM)',
    })
  })

  it('classifies a token refresh answer', () => {
    const expiresAt = new Date(NOW + 15 * 60_000).toISOString()
    expect(parseRefreshAnswer(200, { bridgeToken: 'next', expiresAt })).toEqual({
      kind: 'refreshed',
      bridgeToken: 'next',
      expiresAt: NOW + 15 * 60_000,
    })
    expect(parseRefreshAnswer(409, { code: 'BRIDGE_SESSION_CLOSED' })).toEqual({ kind: 'closed' })
    expect(parseRefreshAnswer(401, null)).toEqual({ kind: 'unauthorized' })
    expect(parseRefreshAnswer(200, { bridgeToken: 'next' })).toMatchObject({ kind: 'error' })
  })

  it('classifies a session status answer', () => {
    expect(parseStatusAnswer(200, { status: 'active' })).toEqual({ kind: 'active' })
    expect(parseStatusAnswer(200, { status: 'active', gatewayInstanceId: 'gw-2', tunnelGeneration: 4 }))
      .toEqual({ kind: 'active', gatewayInstanceId: 'gw-2', tunnelGeneration: 4 })
    expect(parseStatusAnswer(200, { status: 'closed' })).toEqual({ kind: 'closed' })
    expect(parseStatusAnswer(401, null)).toEqual({ kind: 'unauthorized' })
    expect(parseStatusAnswer(200, {})).toMatchObject({ kind: 'error' })
  })

  it('refreshes only inside the five-minute window', () => {
    expect(expiresSoon(NOW + REFRESH_AHEAD_MS - 1, NOW)).toBe(true)
    expect(expiresSoon(NOW + REFRESH_AHEAD_MS, NOW)).toBe(false)
    expect(expiresSoon(NOW + 15 * 60_000, NOW)).toBe(false)
  })

  it('never echoes the session ticket from a URL or a diagnostic', () => {
    expect(redactMcpUrl(MCP_URL)).toBe(`http://dataops.test:3101/api/ai/browser-bridge/mcp/${SESSION_ID}`)
    const diagnostic = redactUrls(`connect failed for ${MCP_URL}: refused`)
    expect(diagnostic).not.toContain('ticket=')
    expect(diagnostic).toContain('refused')
    expect(describeError(new Error(`GET ${MCP_URL} failed`))).not.toContain('secret-ticket')
    expect(describeError({ token: 'hidden' })).toBe('unexpected failure')
  })
})

describe('browser bridge session lifecycle', () => {
  it('does not touch the network while the connector is disabled', async () => {
    const { fetch, calls } = fetchRouter(() => json(200, sessionBody()))
    const { bridge, connectMcp } = sessionWith(fetch, { enabled: false })

    await bridge.start()

    expect(calls).toEqual([])
    expect(connectMcp).not.toHaveBeenCalled()
    expect(bridge.status()).toMatchObject({ phase: 'disabled', enabled: false, connected: false })
  })

  it('connects once from the returned mcpUrl and reports the live session', async () => {
    const { fetch, calls } = fetchRouter(() => json(200, sessionBody()))
    const { bridge, connectMcp } = sessionWith(fetch)

    await bridge.start()

    expect(calls).toEqual([{ url: 'http://dataops.test:3101/api/ai/browser-bridge/session', method: 'POST' }])
    expect(connectMcp).toHaveBeenCalledTimes(1)
    expect(connectMcp).toHaveBeenCalledWith(MCP_URL, TOKEN)
    expect(bridge.status()).toMatchObject({
      phase: 'connected',
      enabled: true,
      connected: true,
      sessionId: SESSION_ID,
      deviceId: 'device-1',
    })
  })

  it('keeps one MCP client and one set of clocks when start is called twice', async () => {
    const { fetch, calls } = fetchRouter((url, init) => init?.method === 'POST' && !url.endsWith('/session')
      ? json(200, { bridgeToken: 'next', expiresAt: new Date(NOW + 15 * 60_000).toISOString() })
      : json(200, sessionBody()))
    const { bridge, connectMcp } = sessionWith(fetch)

    await bridge.start()
    await bridge.start()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(connectMcp).toHaveBeenCalledTimes(1)
    // One status poll, not two: the second `start` added no interval.
    expect(calls.filter(call => call.method === 'GET')).toHaveLength(1)
    // And no second `POST /session`: a connected session is left untouched.
    expect(calls.filter(call => call.method === 'POST' && call.url.endsWith('/session'))).toHaveLength(1)
  })

  it('keeps one pending retry when several failures land in the same minute', async () => {
    const { fetch, calls } = fetchRouter(() => json(409, { code: 'COMPANION_OFFLINE' }))
    const { bridge, connectMcp } = sessionWith(fetch)

    await bridge.start()
    // A second trigger while the retry is pending must not stack another timer.
    await bridge.start()
    expect(calls).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(3)
    expect(connectMcp).not.toHaveBeenCalled()
  })

  it('resumes an expired session on a new JWT without reopening or rebuilding MCP', async () => {
    let status: number = 401
    const { fetch, calls } = fetchRouter((url, init) => {
      if (init?.method === 'GET') return json(status, status === 200 ? { status: 'active' } : null)
      return json(200, sessionBody())
    })
    const { bridge, connectMcp, handles } = sessionWith(fetch)

    await bridge.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(bridge.status().phase).toBe('expired')
    expect(handles[0]?.dispose).not.toHaveBeenCalled()

    status = 200
    await bridge.onCredentialRefresh()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(bridge.status()).toMatchObject({ phase: 'connected', connected: true })
    expect(connectMcp).toHaveBeenCalledTimes(1)
    expect(calls.filter(call => call.method === 'POST' && call.url.endsWith('/session'))).toHaveLength(1)
  })

  it('keeps the MCP client when the gateway tunnel identity is unchanged', async () => {
    const { fetch, calls } = fetchRouter((url, init) => {
      if (init?.method === 'GET') {
        return json(200, statusBody('active', { gatewayInstanceId: 'gw-1', tunnelGeneration: 1 }))
      }
      return json(200, sessionBody())
    })
    const { bridge, connectMcp, handles } = sessionWith(fetch)

    await bridge.start()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(connectMcp).toHaveBeenCalledTimes(1)
    expect(handles[0]?.dispose).not.toHaveBeenCalled()
    expect(calls.filter(call => call.method === 'POST' && call.url.endsWith('/session'))).toHaveLength(1)
    expect(bridge.status().connected).toBe(true)
  })

  it('rebuilds once when the gateway instance changes', async () => {
    let identity = { gatewayInstanceId: 'gw-1', tunnelGeneration: 1 }
    const { fetch, calls } = fetchRouter((url, init) => {
      if (init?.method === 'GET') return json(200, statusBody('active', identity))
      return json(200, sessionBody(identity))
    })
    const { bridge, connectMcp, handles } = sessionWith(fetch)

    await bridge.start()
    identity = { gatewayInstanceId: 'gw-2', tunnelGeneration: 1 }
    await vi.advanceTimersByTimeAsync(30_000)

    expect(handles[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(connectMcp).toHaveBeenCalledTimes(2)
    expect(calls.filter(call => call.method === 'POST' && call.url.endsWith('/session'))).toHaveLength(2)
    expect(bridge.status().connected).toBe(true)

    // The new identity is recorded: the next poll must not rebuild again.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(connectMcp).toHaveBeenCalledTimes(2)
    expect(calls.filter(call => call.method === 'POST' && call.url.endsWith('/session'))).toHaveLength(2)
  })

  it('rebuilds once when the companion tunnel generation changes', async () => {
    let identity = { gatewayInstanceId: 'gw-1', tunnelGeneration: 1 }
    const { fetch } = fetchRouter((url, init) => {
      if (init?.method === 'GET') return json(200, statusBody('active', identity))
      return json(200, sessionBody(identity))
    })
    const { bridge, connectMcp, handles } = sessionWith(fetch)

    await bridge.start()
    identity = { gatewayInstanceId: 'gw-1', tunnelGeneration: 2 }
    await vi.advanceTimersByTimeAsync(30_000)

    expect(handles[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(connectMcp).toHaveBeenCalledTimes(2)
    expect(bridge.status().connected).toBe(true)
  })

  it('does not rebuild when an older backend omits both identity fields', async () => {
    const legacySession = sessionBody()
    delete legacySession['gatewayInstanceId']
    delete legacySession['tunnelGeneration']
    const { fetch, calls } = fetchRouter((url, init) => {
      if (init?.method === 'GET') return json(200, statusBody('active'))
      return json(200, legacySession)
    })
    const { bridge, connectMcp, handles } = sessionWith(fetch)

    await bridge.start()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(connectMcp).toHaveBeenCalledTimes(1)
    expect(handles[0]?.dispose).not.toHaveBeenCalled()
    expect(calls.filter(call => call.method === 'POST' && call.url.endsWith('/session'))).toHaveLength(1)
  })

  it('retries a failed tunnel rebuild with one pending retry', async () => {
    let identity = { gatewayInstanceId: 'gw-1', tunnelGeneration: 1 }
    let creates = 0
    const { fetch, calls } = fetchRouter((url, init) => {
      if (init?.method === 'GET') return json(200, statusBody('active', identity))
      creates += 1
      if (creates === 2) return json(409, { code: 'COMPANION_OFFLINE' })
      return json(200, sessionBody(identity))
    })
    const { bridge, connectMcp, handles } = sessionWith(fetch)

    await bridge.start()
    identity = { gatewayInstanceId: 'gw-2', tunnelGeneration: 1 }
    await vi.advanceTimersByTimeAsync(30_000)

    expect(handles[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(connectMcp).toHaveBeenCalledTimes(1)
    expect(creates).toBe(2)
    expect(bridge.status().phase).toBe('offline')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(creates).toBe(3)
    expect(connectMcp).toHaveBeenCalledTimes(2)
    expect(bridge.status().connected).toBe(true)
    // The successful rebuild cleared the retry clock; one more minute adds no POST.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(creates).toBe(3)
    expect(calls.filter(call => call.method === 'POST' && call.url.endsWith('/session'))).toHaveLength(3)
  })

  it('retries after COMPANION_OFFLINE without creating an MCP client', async () => {
    let attempt = 0
    const { fetch, calls } = fetchRouter(() => {
      attempt += 1
      return attempt === 1 ? json(409, { code: 'COMPANION_OFFLINE' }) : json(200, sessionBody())
    })
    const { bridge, connectMcp } = sessionWith(fetch)

    await bridge.start()
    expect(bridge.status()).toMatchObject({ phase: 'offline', connected: false })
    expect(connectMcp).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(2)
    expect(connectMcp).toHaveBeenCalledTimes(1)
    expect(bridge.status()).toMatchObject({ phase: 'connected', connected: true })
  })

  it('rotates the control token without touching the MCP connection', async () => {
    const { fetch, calls } = fetchRouter((url, init) => {
      if (url.endsWith('/refresh') && init?.method === 'POST') {
        return json(200, { bridgeToken: 'bridge-token-2', expiresAt: new Date(NOW + 20 * 60_000).toISOString() })
      }
      if (init?.method === 'GET') {
        return json(200, statusBody('active', { gatewayInstanceId: 'gw-1', tunnelGeneration: 1 }))
      }
      return json(200, sessionBody({ expiresAt: new Date(NOW + 60_000).toISOString() }))
    })
    const { bridge, connectMcp, handles } = sessionWith(fetch)

    await bridge.start()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(calls.some(call => call.url.endsWith(`/session/${SESSION_ID}/refresh`))).toBe(true)
    expect(connectMcp).toHaveBeenCalledTimes(1)
    expect(handles[0]?.dispose).not.toHaveBeenCalled()
    expect(bridge.status().expiresAt).toBe(new Date(NOW + 20 * 60_000).toISOString())
  })

  it('records an expired login on 401 but keeps the existing MCP connection', async () => {
    const { fetch } = fetchRouter((url, init) => {
      if (init?.method === 'GET') return json(401, null)
      return json(200, sessionBody())
    })
    const { bridge, handles } = sessionWith(fetch)

    await bridge.start()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(currentAuthState()).toBe('expired')
    expect(bridge.status()).toMatchObject({ phase: 'expired', sessionId: SESSION_ID, connected: false })
    expect(handles[0]?.dispose).not.toHaveBeenCalled()
  })

  it('disposes the MCP client only when the gateway reports the session closed', async () => {
    const { fetch } = fetchRouter((url, init) => {
      if (init?.method === 'GET') return json(200, { status: 'closed' })
      return json(200, sessionBody())
    })
    const { bridge, handles } = sessionWith(fetch)

    await bridge.start()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(handles[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(bridge.status()).toMatchObject({ phase: 'closed', connected: false })
    expect(bridge.status().sessionId).toBeUndefined()
  })

  it('closes the session best-effort and clears its clocks on dispose', async () => {
    const { fetch, calls } = fetchRouter((url, init) => {
      if (url.endsWith('/close')) return json(200, { closed: true })
      if (init?.method === 'GET') return json(200, { status: 'active' })
      return json(200, sessionBody())
    })
    const { bridge, handles } = sessionWith(fetch)

    await bridge.start()
    await bridge.dispose()

    expect(calls.some(call => call.url.endsWith(`/session/${SESSION_ID}/close`))).toBe(true)
    expect(handles[0]?.dispose).toHaveBeenCalledTimes(1)
    const afterDispose = calls.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(calls).toHaveLength(afterDispose)
  })

  it('opens a session when the connector is enabled at runtime and closes it when disabled', async () => {
    const { fetch, calls } = fetchRouter((url) => url.endsWith('/close')
      ? json(200, { closed: true })
      : json(200, sessionBody()))
    const { bridge, connectMcp, handles } = sessionWith(fetch, { enabled: false })

    await bridge.start()
    expect(calls).toEqual([])

    await bridge.setEnabled(true)
    expect(connectMcp).toHaveBeenCalledTimes(1)
    expect(bridge.status().connected).toBe(true)

    await bridge.setEnabled(false)
    expect(calls.some(call => call.url.endsWith(`/session/${SESSION_ID}/close`))).toBe(true)
    expect(handles[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(bridge.status()).toMatchObject({ phase: 'disabled', enabled: false, connected: false })
  })
})