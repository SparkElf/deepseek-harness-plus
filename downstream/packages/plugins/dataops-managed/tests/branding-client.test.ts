import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRANDING_PATH, fetchWanxiangBranding } from '../src/client/branding-client.ts'

const respond = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response

afterEach(() => { vi.unstubAllGlobals() })

describe('fetchWanxiangBranding', () => {
  it('reads the Host route and normalizes the portal brand', async () => {
    const fetchMock = vi.fn(async () => respond(200, { name: '  星海数据中台  ', logo: '/brands/custom.png' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchWanxiangBranding({ origin: 'http://dsh.test' })).resolves.toEqual({
      name: '星海数据中台',
      logo: '/brands/custom.png',
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`http://dsh.test${BRANDING_PATH}`)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', credentials: 'same-origin' })
  })

  it('keeps the default logo when the Host reports an empty value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { name: '万相AI中台', logo: '' })))
    await expect(fetchWanxiangBranding({ origin: 'http://dsh.test' })).resolves.toEqual({
      name: '万相AI中台',
      logo: '',
    })
  })

  it('returns null instead of a default so a caller keeps its current brand', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(503, { error: 'unavailable' })))
    await expect(fetchWanxiangBranding({ origin: 'http://dsh.test' })).resolves.toBeNull()
  })

  it('returns null when the request throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await expect(fetchWanxiangBranding({ origin: 'http://dsh.test' })).resolves.toBeNull()
  })

  it('rejects a payload outside the route contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { unexpected: true })))
    await expect(fetchWanxiangBranding({ origin: 'http://dsh.test' })).resolves.toBeNull()
  })

  it('accepts an absolute logo URL resolved by the Host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, {
      name: '星海数据中台',
      logo: 'http://portal.test:8080/brands/logo.png',
    })))
    await expect(fetchWanxiangBranding({ origin: 'http://dsh.test' })).resolves.toEqual({
      name: '星海数据中台',
      logo: 'http://portal.test:8080/brands/logo.png',
    })
  })

  it('rejects a non-image custom logo and keeps the inline mark', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { name: '万相', logo: 'javascript:alert(1)' })))
    await expect(fetchWanxiangBranding({ origin: 'http://dsh.test' })).resolves.toEqual({
      name: '万相',
      logo: '',
    })
  })
})