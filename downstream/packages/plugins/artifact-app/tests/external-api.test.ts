import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactApi } from '../src/api.ts'

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

const registryRow = {
  id: 'ext-1',
  name: '销售驾驶舱',
  description: '外部销售分析',
  url: 'https://cockpit.example/sales',
  icon: null,
  tags: ['sales', 'crm'],
  ownerId: 'user-1',
  visibility: 'DEPARTMENT',
  credentialType: 'http',
  credentialHint: '域账号',
  enabled: true,
  health: 'ok',
  updatedAt: '2026-11-26T10:00:00.000Z',
  // Fields the plugin must never forward to the model or browser.
  loginRecipe: { steps: [{ action: 'fill', selector: '#password', value: '{{password}}' }] },
  cookie: 'sid=secret-cookie',
  launchTicket: 'secret-ticket',
  allowedOrigins: ['https://cockpit.example'],
  password: 'hunter2',
}

const api = (): ArtifactApi => new ArtifactApi('https://dataops.example/', { resolve: async () => 'jwt-test' }, 5_000)

afterEach(() => { vi.unstubAllGlobals() })

describe('external cockpit API client', () => {
  it('lists with search, tag and paging, and strips backend-only fields', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [registryRow], total: 1, page: 2, pageSize: 10 }))
    vi.stubGlobal('fetch', fetchMock)

    const page = await api().searchExternalCockpits({ search: ' 销售 驾驶舱 ', tag: 'crm', page: 2, pageSize: 10 })
    expect(page.items).toEqual([{
      id: 'ext-1',
      name: '销售驾驶舱',
      description: '外部销售分析',
      url: 'https://cockpit.example/sales',
      icon: null,
      tags: ['sales', 'crm'],
      ownerId: 'user-1',
      visibility: 'DEPARTMENT',
      credentialType: 'http',
      credentialHint: '域账号',
      enabled: true,
      health: 'ok',
      updatedAt: '2026-11-26T10:00:00.000Z',
    }])
    expect(JSON.stringify(page)).not.toContain('secret')
    expect(Object.keys(page.items[0] ?? {})).not.toContain('loginRecipe')
    expect(Object.keys(page.items[0] ?? {})).not.toContain('cookie')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://dataops.example/api/external-cockpits?search=%E9%94%80%E5%94%AE+%E9%A9%BE%E9%A9%B6%E8%88%B1&tag=crm&page=2&pageSize=10')
    expect((init.headers as Headers).get('authorization')).toBe('Bearer jwt-test')
    expect((init.headers as Headers).get('accept')).toBe('application/json')
  })

  it('reads one registry row by encoded id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(registryRow))
    vi.stubGlobal('fetch', fetchMock)
    const row = await api().getExternalCockpit('abc-123')
    expect(row.name).toBe('销售驾驶舱')
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe('https://dataops.example/api/external-cockpits/abc-123')
  })

  it('rejects an id that is a URL or path before any request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(api().getExternalCockpit('../../etc/passwd')).rejects.toThrow('id 非法')
    await expect(api().getExternalCockpit('javascript:alert(1)')).rejects.toThrow('id 非法')
    await expect(api().linkExternalCockpit('https://evil.example')).rejects.toThrow('id 非法')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts for a stable link and never returns the launch ticket or cookie', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      url: 'https://cockpit.example/dashboard?x=1',
      expiresAt: '2026-11-26T11:00:00.000Z',
      launchTicket: 'secret-ticket',
      cookie: 'sid=secret-cookie',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const link = await api().linkExternalCockpit('ext-1')
    expect(link).toEqual({
      id: 'ext-1',
      url: 'https://cockpit.example/dashboard?x=1',
      expiresAt: '2026-11-26T11:00:00.000Z',
      mode: 'stable',
    })
    expect(JSON.stringify(link)).not.toContain('secret')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://dataops.example/api/external-cockpits/ext-1/link')
    expect(init.method).toBe('POST')
  })

  it('rejects non-HTTPS links and ticket-only responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ url: 'javascript:alert(1)' })))
    await expect(api().linkExternalCockpit('ext-1')).rejects.toThrow('HTTPS')

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ launchTicket: 'only-a-ticket' })))
    await expect(api().linkExternalCockpit('ext-1')).rejects.toThrow('M2')
  })

  it('drops a non-HTTPS registry URL instead of passing it through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...registryRow, url: 'javascript:alert(1)' })))
    const row = await api().getExternalCockpit('ext-1')
    expect(row.url).toBeNull()
  })
})
