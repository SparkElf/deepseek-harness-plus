import { describe, expect, it } from 'vitest'
import { buildCurlCommand } from '../src/curl-command.ts'
import { parseCurl, shellQuote, tokenizeShell, undefinedVariables } from '../src/curl.ts'
import { findUndefinedVariables, jsonPathLabel, validateJsonBody } from '../src/client/model.ts'
import type { ApiRequest } from '../src/types.ts'

describe('cURL import', () => {
  it('reads a plain GET and its headers', () => {
    const parsed = parseCurl("curl 'http://127.0.0.1:8080/api/health' -H 'Accept: application/json'")
    expect(parsed.method).toBe('GET')
    expect(parsed.url).toBe('http://127.0.0.1:8080/api/health')
    expect(parsed.headers).toEqual([{ key: 'Accept', value: 'application/json', enabled: true }])
    expect(parsed.body.kind).toBe('none')
  })

  it('reads a JSON body and infers POST', () => {
    const parsed = parseCurl("curl 'http://api.test/items' -H 'Content-Type: application/json' -d '{\"name\":\"demo\"}'")
    expect(parsed.method).toBe('POST')
    expect(parsed.body).toEqual({ kind: 'json', content: '{"name":"demo"}' })
  })

  it('supports --json and an explicit method', () => {
    const parsed = parseCurl("curl --json '{\"a\":1}' -X PUT 'http://api.test/items/1'")
    expect(parsed.method).toBe('PUT')
    expect(parsed.body.kind).toBe('json')
    expect(parsed.body.content).toBe('{"a":1}')
  })

  it('turns -u into Basic auth', () => {
    const parsed = parseCurl("curl -u 'alice:secret' 'http://api.test/me'")
    expect(parsed.auth.kind).toBe('basic')
    expect(parsed.authSecret).toEqual({ username: 'alice', password: 'secret' })
  })

  it('keeps a quoted URL intact and joins line continuations', () => {
    const parsed = parseCurl("curl \\\n  'http://api.test/search?q=a b&page=1'")
    expect(parsed.url).toBe('http://api.test/search?q=a b&page=1')
  })

  it('refuses a non-curl paste and an unsupported method', () => {
    expect(() => parseCurl('wget http://api.test')).toThrow(/not a curl command/u)
    expect(() => parseCurl("curl -X TRACE 'http://api.test'")).toThrow(/unsupported HTTP method/u)
  })

  it('tokenizes quotes and escapes', () => {
    expect(tokenizeShell(`curl 'a b' "c\\"d" e\\ f`)).toEqual(['curl', 'a b', 'c"d', 'e f'])
  })
})

describe('cURL export', () => {
  const request: ApiRequest = {
    id: 'request-1', collectionId: 'collection-1', name: 'Create', description: '', method: 'POST',
    url: '{{baseUrl}}/items', query: [{ key: 'page', value: '2', enabled: true }, { key: 'skip', value: '1', enabled: false }],
    headers: [{ key: 'X-Env', value: '{{env}}', enabled: true }], auth: { kind: 'bearer', credentialId: 'cred', options: {} },
    body: { kind: 'json', content: '{"name":"demo"}' }, environmentId: 'environment-1',
  }

  it('resolves variables, auth, query, headers and body', () => {
    const command = buildCurlCommand(request, { baseUrl: 'http://api.test', env: 'prod' }, { token: 'tok' }, '')
    expect(command).toContain('curl -X POST http://api.test/items?page=2')
    expect(command).toContain("-H 'X-Env: prod'")
    expect(command).toContain("-H 'Authorization: Bearer tok'")
    expect(command).toContain('--data-raw \'{"name":"demo"}\'')
    expect(command).not.toContain('skip=1')
  })

  it('quotes values a shell would split', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})

describe('response and variable helpers', () => {
  it('validates JSON without throwing', () => {
    expect(validateJsonBody('{"a":1}').valid).toBe(true)
    expect(validateJsonBody('').valid).toBe(true)
    expect(validateJsonBody('{broken').valid).toBe(false)
  })

  it('labels JSON paths in code notation', () => {
    expect(jsonPathLabel([])).toBe('$')
    expect(jsonPathLabel(['data', 0, 'b-c'])).toBe('$.data[0]["b-c"]')
  })

  it('finds undefined names across URL, params, headers and body', () => {
    const draft: ApiRequest = {
      id: 'draft', collectionId: 'collection-1', name: 'Draft', description: '', method: 'GET',
      url: '{{baseUrl}}/items', query: [], headers: [{ key: 'X', value: '{{token}}', enabled: true }],
      auth: { kind: 'none', credentialId: null, options: {} }, body: { kind: 'json', content: '{"at":"{{now}}"}' }, environmentId: null,
    }
    expect(findUndefinedVariables(draft, { baseUrl: '' })).toEqual(['token', 'now'])
    expect(undefinedVariables('{{a}} {{a}} {{b}}', {})).toEqual(['a', 'b'])
  })
})
