import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ApiRequest, ApiResponse } from '../src/types.ts'
import { filterSelectOptions, Select } from '../src/client/Dropdown.tsx'
import { I18nProvider, translate } from '../src/client/i18n.tsx'
import { cloneRequest, formatResponseBody, requestFingerprint, responseCookies } from '../src/client/model.ts'

const request: ApiRequest = {
  id: 'request-1',
  collectionId: 'collection-1',
  name: 'List users',
  description: '',
  method: 'GET',
  url: '{{baseUrl}}/users',
  query: [{ key: 'page', value: '1', enabled: true }],
  headers: [],
  auth: { kind: 'bearer', credentialId: 'credential-1', options: {} },
  body: { kind: 'none', content: '' },
  environmentId: 'environment-1',
}

describe('API client presentation model', () => {
  it('clones nested request fields and detects draft changes by fingerprint', () => {
    const draft = cloneRequest(request)
    expect(requestFingerprint(draft)).toBe(requestFingerprint(request))
    draft.query[0]!.value = '2'
    draft.auth.options.scope = 'read'
    expect(request.query[0]!.value).toBe('1')
    expect(request.auth.options.scope).toBeUndefined()
    expect(requestFingerprint(draft)).not.toBe(requestFingerprint(request))
  })

  it('prettifies JSON while preserving non-JSON response bodies', () => {
    expect(formatResponseBody('{"ok":true,"items":[1]}')).toBe(JSON.stringify({ ok: true, items: [1] }, null, 2))
    expect(formatResponseBody('<status>ok</status>')).toBe('<status>ok</status>')
  })

  it('extracts cookies from Set-Cookie response headers', () => {
    const response: ApiResponse = { id: 'response-1', requestId: 'request-1', status: 200, statusText: 'OK', durationMs: 12, sizeBytes: 2, body: '{}', bodyTruncated: false, receivedAt: 1, headers: [
      { key: 'content-type', value: 'application/json', enabled: true },
      { key: 'set-cookie', value: 'session=abc; Path=/; HttpOnly', enabled: true },
    ] }
    expect(responseCookies(response)).toEqual([{ name: 'session', value: 'abc', attributes: 'Path=/; HttpOnly' }])
  })
})

describe('Select', () => {
  const options = [
    { value: 'dev', label: 'Development', description: 'Local API' },
    { value: 'prod', label: 'Production', description: 'Primary region' },
  ]

  it('filters labels and descriptions without changing option order', () => {
    expect(filterSelectOptions(options, 'primary')).toEqual([options[1]])
    expect(filterSelectOptions(options, '')).toEqual(options)
  })

  it('renders an accessible combobox trigger with the selected label', () => {
    const ctx = { locale: { getSnapshot: () => ({ active: 'en-US' }), subscribe: () => () => undefined } } as unknown as Context
    const markup = renderToStaticMarkup(createElement(I18nProvider, { ctx, children: createElement(Select, { label: 'Environment', value: 'prod', options, onChange: () => undefined }) }))
    expect(markup).toContain('role="combobox"')
    expect(markup).toContain('aria-label="Environment"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('Production')
    const zh = { locale: { getSnapshot: () => ({ active: 'zh-CN' }), subscribe: () => () => undefined } } as unknown as Context
    expect(translate(zh, 'select.search')).toBe('搜索')
  })
})
