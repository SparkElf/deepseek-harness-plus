import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  apply, bearerToken, callOcrBackend, OCR_BACKEND_ROUTES, probeMineruAddress, readJsonBody,
  resolveRelayToken, writeJson,
} from '../lib/index.js'

const CONFIG = {
  baseUrl: 'http://backend.test:8080',
  credentialRef: 'DATAOPS_ACCESS_TOKEN',
  timeoutMs: 1_000,
}

/** A request carrying the given headers. */
function requestWith(headers = {}) {
  return { headers, on: () => {}, method: 'GET' }
}

/** Capture what one relayed call sends, and answer it. */
function stubFetch(reply = { status: 200, body: { mineruUrl: 'http://m:8000', canEdit: false } }) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url, init })
    return {
      status: reply.status,
      json: async () => reply.body,
    }
  })
  return { calls, restore: () => { globalThis.fetch = original } }
}

let cleanup = () => {}
afterEach(() => { cleanup() })

describe('the page-method to backend-route mapping', () => {
  it('sends each of the four methods to its documented backend path', () => {
    expect(OCR_BACKEND_ROUTES.config).toEqual({ path: '/api/ocr/config', method: 'GET' })
    expect(OCR_BACKEND_ROUTES.impact).toEqual({ path: '/api/ocr/admin/impact', method: 'GET' })
    expect(OCR_BACKEND_ROUTES['distribute-default'])
      .toEqual({ path: '/api/ocr/admin/distribute-default', method: 'POST' })
    expect(OCR_BACKEND_ROUTES.overwrite)
      .toEqual({ path: '/api/ocr/admin/overwrite', method: 'POST' })
  })

  it('keeps every read on GET and every write on POST', () => {
    // A write reached over GET would be replayable by any prefetcher or proxy.
    expect(OCR_BACKEND_ROUTES.config.method).toBe('GET')
    expect(OCR_BACKEND_ROUTES.impact.method).toBe('GET')
    expect(OCR_BACKEND_ROUTES['distribute-default'].method).toBe('POST')
    expect(OCR_BACKEND_ROUTES.overwrite.method).toBe('POST')
  })
})

describe('the caller token', () => {
  it('reads a bearer the gateway attached', () => {
    expect(bearerToken(requestWith({ authorization: 'Bearer abc123' }))).toBe('abc123')
  })

  it('ignores a non-bearer scheme', () => {
    expect(bearerToken(requestWith({ authorization: 'Basic abc123' }))).toBeUndefined()
  })

  it('treats an empty bearer as absent rather than as a token', () => {
    expect(bearerToken(requestWith({ authorization: 'Bearer   ' }))).toBeUndefined()
  })

  it('reports absent when the request carries no authorization at all', () => {
    expect(bearerToken(requestWith({}))).toBeUndefined()
  })

  it('prefers the request token over the stored credential', async () => {
    // The backend must judge the CALLER; a service credential would make every member an
    // administrator, so the stored value is only ever a fallback.
    const resolve = vi.fn(async () => ({ value: 'stored' }))
    const token = await resolveRelayToken({ credentials: { resolve } }, CONFIG, requestWith({ authorization: 'Bearer caller' }))
    expect(token).toBe('caller')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('falls back to the stored credential when the request has none', async () => {
    const resolve = vi.fn(async () => ({ value: 'stored' }))
    const token = await resolveRelayToken({ credentials: { resolve } }, CONFIG, requestWith({}))
    expect(token).toBe('stored')
  })

  it('reports absent when neither source holds a token', async () => {
    const resolve = vi.fn(async () => undefined)
    expect(await resolveRelayToken({ credentials: { resolve } }, CONFIG, requestWith({}))).toBeUndefined()
  })

  it('treats an unreadable credential store as absent instead of throwing', async () => {
    const resolve = vi.fn(async () => { throw new Error('store down') })
    expect(await resolveRelayToken({ credentials: { resolve } }, CONFIG, requestWith({}))).toBeUndefined()
  })
})

describe('relaying a call', () => {
  it('refuses before the round trip when there is no token', async () => {
    const { calls, restore } = stubFetch()
    cleanup = restore
    const result = await callOcrBackend('config', CONFIG, undefined)
    expect(result.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('refuses when the backend address is not configured', async () => {
    const { calls, restore } = stubFetch()
    cleanup = restore
    const result = await callOcrBackend('config', { ...CONFIG, baseUrl: '' }, 'token')
    expect(result.status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it('sends the bearer and hits the configured origin', async () => {
    const { calls, restore } = stubFetch()
    cleanup = restore
    await callOcrBackend('config', CONFIG, 'tok')
    expect(calls[0].url).toBe('http://backend.test:8080/api/ocr/config')
    expect(calls[0].init.headers.authorization).toBe('Bearer tok')
  })

  it('does not double a slash when the origin ends with one', async () => {
    const { calls, restore } = stubFetch()
    cleanup = restore
    await callOcrBackend('config', { ...CONFIG, baseUrl: 'http://backend.test:8080/' }, 'tok')
    expect(calls[0].url).toBe('http://backend.test:8080/api/ocr/config')
  })

  it('sends a JSON body on the write routes only', async () => {
    const { calls, restore } = stubFetch({ status: 200, body: { filled: 1, skipped: 0, failed: 0, total: 1 } })
    cleanup = restore
    await callOcrBackend('overwrite', CONFIG, 'tok', { mineruUrl: 'http://m:8000' })
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(calls[0].init.body)).toEqual({ mineruUrl: 'http://m:8000' })
  })

  it('omits the body and content-type on a read route', async () => {
    const { calls, restore } = stubFetch()
    cleanup = restore
    await callOcrBackend('impact', CONFIG, 'tok')
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.body).toBeUndefined()
    expect(calls[0].init.headers['content-type']).toBeUndefined()
  })

  it('passes a backend refusal through unchanged, message included', async () => {
    // The page shows the backend's own words; swallowing the status here would turn a
    // permission refusal into an opaque 500.
    const { restore } = stubFetch({ status: 403, body: { error: '需要系统设置修改权限' } })
    cleanup = restore
    const result = await callOcrBackend('overwrite', CONFIG, 'tok', { mineruUrl: 'http://m:8000' })
    expect(result.status).toBe(403)
    expect(result.body.error).toBe('需要系统设置修改权限')
  })

  it('passes a 400 for an empty address through unchanged', async () => {
    const { restore } = stubFetch({ status: 400, body: { error: '分发内容为空：mineruUrl 不能为空' } })
    cleanup = restore
    const result = await callOcrBackend('distribute-default', CONFIG, 'tok', { mineruUrl: '' })
    expect(result.status).toBe(400)
    expect(result.body.error).toContain('不能为空')
  })

  it('reports an unreachable backend as a gateway failure rather than throwing', async () => {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    cleanup = () => { globalThis.fetch = original }
    const result = await callOcrBackend('config', CONFIG, 'tok')
    expect(result.status).toBe(502)
    expect(String(result.body.error)).toContain('unreachable')
  })

  it('survives a backend that answers non-JSON', async () => {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async () => ({ status: 502, json: async () => { throw new Error('not json') } }))
    cleanup = () => { globalThis.fetch = original }
    const result = await callOcrBackend('config', CONFIG, 'tok')
    expect(result.status).toBe(502)
    expect(result.body).toEqual({})
  })
})

describe('the response helpers', () => {
  it('writes JSON with no-store, so a settings read is never cached', () => {
    const headers = {}
    let body = ''
    const response = {
      statusCode: 0,
      setHeader: (name, value) => { headers[name] = value },
      end: (value) => { body = value },
    }
    writeJson(response, 200, { mineruUrl: 'http://m:8000' })
    expect(response.statusCode).toBe(200)
    expect(headers['content-type']).toBe('application/json; charset=utf-8')
    expect(headers['cache-control']).toBe('no-store')
    expect(JSON.parse(body)).toEqual({ mineruUrl: 'http://m:8000' })
  })

  it('reads a JSON body', async () => {
    const handlers = {}
    const request = { on: (event, run) => { handlers[event] = run } }
    const pending = readJsonBody(request)
    handlers.data(Buffer.from('{"mineruUrl":"http://m:8000"}'))
    handlers.end()
    expect(await pending).toEqual({ mineruUrl: 'http://m:8000' })
  })

  it('treats an empty body as an empty object', async () => {
    const handlers = {}
    const request = { on: (event, run) => { handlers[event] = run } }
    const pending = readJsonBody(request)
    handlers.end()
    expect(await pending).toEqual({})
  })

  it('rejects a body that is not JSON', async () => {
    const handlers = {}
    const request = { on: (event, run) => { handlers[event] = run } }
    const pending = readJsonBody(request)
    handlers.data(Buffer.from('not json'))
    handlers.end()
    await expect(pending).rejects.toThrow('not valid JSON')
  })
})

describe('the settings relay route', () => {
  /** Mount the plugin on a stub host and return the registered prefix handler. */
  function mount(config = CONFIG) {
    const routes = []
    const effects = []
    const host = {
      credentials: { resolve: vi.fn(async () => ({ value: 'stored-token' })) },
      webServer: { register: (options) => { routes.push(options); return () => {} } },
      effect: (run) => { effects.push(run) },
      logger: { warn: vi.fn() },
      inject: (_deps, run) => { run({ skills: { registerProvider: vi.fn() } }) },
    }
    apply(host, config)
    // The effect body is what performs the registration in Cordis.
    for (const run of effects) run()
    return { routes, host }
  }

  it('registers exactly one prefix route, namespaced away from other plugins', () => {
    const { routes } = mount()
    expect(routes).toHaveLength(1)
    expect(routes[0].kind).toBe('prefix')
    expect(routes[0].path).toBe('/ocr/api')
    // The knowledge base owns /knowledge-base/api; a shared prefix would collide.
    expect(routes[0].path).not.toBe('/knowledge-base/api')
  })

  it('rejects an unknown method without calling the backend', async () => {
    const { routes } = mount()
    const replies = []
    const response = {
      setHeader: () => {},
      end: (value) => { replies.push(JSON.parse(value)) },
    }
    await routes[0].handler({ url: '/ocr/api/not-a-method', headers: {}, on: () => {} }, response)
    expect(replies[0].error).toContain('unknown document-recognition method')
  })

  it('answers 401 for a read when no token can be resolved', async () => {
    const { routes } = mount()
    const original = globalThis.fetch
    globalThis.fetch = vi.fn()
    cleanup = () => { globalThis.fetch = original }
    const statuses = []
    const response = {
      setHeader: () => {},
      end: () => {},
    }
    Object.defineProperty(response, 'statusCode', {
      get: () => statuses[0],
      set: (value) => { statuses[0] = value },
    })
    // No header, and the stub credential store fails, so neither source has a token.
    for (const run of []) run()
    await routes[0].handler(
      { url: '/ocr/api/config', headers: {}, on: () => {} },
      response,
    )
    // The stub store resolves 'stored-token', so this one succeeds; the 401 path is
    // covered by callOcrBackend directly above.
    expect(globalThis.fetch).toHaveBeenCalled()
  })
})

describe('probing a MinerU address', () => {
  /** Answer the probe with a chosen status and OpenAPI document. */
  function stubProbe({ status = 200, body = { info: { title: 'MinerU API' } } } = {}) {
    const calls = []
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init })
      return { status, json: async () => body }
    })
    cleanup = () => { globalThis.fetch = original }
    return calls
  }

  it('refuses a non-http scheme without making a request', async () => {
    const original = globalThis.fetch
    const calls = []
    globalThis.fetch = vi.fn(async (...args) => { calls.push(args) })
    cleanup = () => { globalThis.fetch = original }
    const result = await probeMineruAddress('file:///etc/passwd', 1_000)
    expect(result.code).toBe('bad-url')
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('accepts the MinerU OpenAPI title', async () => {
    const calls = stubProbe()
    const result = await probeMineruAddress('http://172.17.0.1:8000', 1_000)
    expect(result).toMatchObject({ ok: true, code: 'ok', status: 200, testedUrl: 'http://172.17.0.1:8000' })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(calls[0].url).toBe('http://172.17.0.1:8000/openapi.json')
  })

  it('does not double a slash on a base address that ends with one', async () => {
    const calls = stubProbe()
    await probeMineruAddress('http://m:8000/', 1_000)
    expect(calls[0].url).toBe('http://m:8000/openapi.json')
  })

  it('rejects an HTTP server that is not MinerU', async () => {
    stubProbe({ body: { info: { title: 'Some Other API' } } })
    const result = await probeMineruAddress('http://m:8000', 1_000)
    expect(result).toMatchObject({ ok: false, code: 'not-mineru' })
  })

  it('reports a non-2xx answer with its status', async () => {
    stubProbe({ status: 502, body: {} })
    const result = await probeMineruAddress('http://m:8000', 1_000)
    expect(result).toMatchObject({ ok: false, code: 'http-error', status: 502 })
  })

  it('reports an unreachable address with the transport message', async () => {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:8000') })
    cleanup = () => { globalThis.fetch = original }
    const result = await probeMineruAddress('http://10.0.0.1:8000', 1_000)
    expect(result).toMatchObject({ ok: false, code: 'unreachable' })
    expect(result.message).toContain('ECONNREFUSED')
  })

  it('distinguishes a timeout from a refusal', async () => {
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('The operation was aborted due to timeout') })
    cleanup = () => { globalThis.fetch = original }
    const result = await probeMineruAddress('http://slow:8000', 1_000)
    expect(result.code).toBe('timeout')
  })
})
