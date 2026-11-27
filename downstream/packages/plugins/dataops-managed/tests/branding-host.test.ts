import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRANDING_CACHE_TTL_MS,
  BRANDING_FAILURE_TTL_MS,
  DEFAULT_WORKSPACE_BRANDING,
  WorkspaceBrandingSource,
  resolveWorkspaceBrandLogo,
} from '../src/branding.ts'

const BASE_URL = 'http://dataops.test:3101'

const answer = (value: string | null) => ({
  ok: true,
  status: 200,
  json: async () => ({ setting: value === null ? null : { value } }),
}) as Response

/** A fetch double that answers the two public brand settings. */
function brandingFetch(values: {
  name?: string | null
  logo?: string | null
}) {
  return vi.fn(async (input: URL | string) => {
    const url = String(input)
    if (url.endsWith('/platform/brand_name')) return answer(values.name ?? null)
    if (url.endsWith('/platform/brand_logo')) return answer(values.logo ?? null)
    throw new Error(`unexpected URL ${url}`)
  })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('WorkspaceBrandingSource', () => {
  it('reads both public settings without a credential', async () => {
    const fetcher = brandingFetch({ name: '星海数据中台', logo: '/brands/custom.png' })
    const source = new WorkspaceBrandingSource(BASE_URL, { fetcher })
    await expect(source.read()).resolves.toEqual({ name: '星海数据中台', logo: '/brands/custom.png' })

    expect(fetcher).toHaveBeenCalledTimes(2)
    const urls = fetcher.mock.calls.map(([input]) => String(input)).sort()
    expect(urls).toEqual([
      `${BASE_URL}/api/system/settings/public/platform/brand_logo`,
      `${BASE_URL}/api/system/settings/public/platform/brand_name`,
    ])
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.headers).toEqual({ accept: 'application/json' })
      expect(init).not.toHaveProperty('authorization')
    }
  })

  it('returns the hardcoded default when a setting is unset', async () => {
    const source = new WorkspaceBrandingSource(BASE_URL, { fetcher: brandingFetch({ name: null, logo: null }) })
    await expect(source.read()).resolves.toEqual(DEFAULT_WORKSPACE_BRANDING)
  })

  it('keeps whichever setting the portal has set', async () => {
    const source = new WorkspaceBrandingSource(BASE_URL, {
      fetcher: brandingFetch({ name: '星海数据中台', logo: null }),
    })
    await expect(source.read()).resolves.toEqual({ name: '星海数据中台', logo: '' })
  })

  it('serves a successful read from cache until the short TTL expires', async () => {
    let now = 1_000
    const fetcher = brandingFetch({ name: '万相AI中台', logo: 'data:image/png;base64,AAAA' })
    const source = new WorkspaceBrandingSource(BASE_URL, { fetcher, now: () => now })

    await source.read()
    await source.read()
    expect(fetcher).toHaveBeenCalledTimes(2)

    now += BRANDING_CACHE_TTL_MS
    await source.read()
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('falls back to the default on failure and retries after the failure TTL', async () => {
    let now = 2_000
    let online = false
    const fetcher = vi.fn(async (input: URL | string) => {
      if (!online) throw new Error('connect ECONNREFUSED')
      return String(input).endsWith('/platform/brand_name')
        ? answer('恢复后的品牌')
        : answer(null)
    })
    const source = new WorkspaceBrandingSource(BASE_URL, { fetcher, now: () => now })

    await expect(source.read()).resolves.toEqual(DEFAULT_WORKSPACE_BRANDING)
    const failedCalls = fetcher.mock.calls.length
    await expect(source.read()).resolves.toEqual(DEFAULT_WORKSPACE_BRANDING)
    expect(fetcher).toHaveBeenCalledTimes(failedCalls)

    now += BRANDING_FAILURE_TTL_MS
    online = true
    await expect(source.read()).resolves.toEqual({ name: '恢复后的品牌', logo: '' })
  })

  it('falls back entirely when either setting answers outside the contract', async () => {
    const fetcher = vi.fn(async (input: URL | string) => {
      if (String(input).endsWith('/platform/brand_name')) return answer('星海')
      return { ok: true, status: 200, json: async () => ({ unexpected: true }) } as Response
    })
    const source = new WorkspaceBrandingSource(BASE_URL, { fetcher })
    await expect(source.read()).resolves.toEqual(DEFAULT_WORKSPACE_BRANDING)
  })
})

describe('resolveWorkspaceBrandLogo', () => {
  it('leaves data URLs and empty values unchanged', () => {
    expect(resolveWorkspaceBrandLogo('', 'http://portal.test:8080')).toBe('')
    expect(resolveWorkspaceBrandLogo('data:image/png;base64,AAAA', 'http://portal.test:8080'))
      .toBe('data:image/png;base64,AAAA')
  })

  it('prefixes a portal-relative path with the browser-facing origin', () => {
    expect(resolveWorkspaceBrandLogo('/brands/logo.png', 'http://portal.test:8080'))
      .toBe('http://portal.test:8080/brands/logo.png')
  })

  it('takes the first valid entry when webBaseUrl is a list', () => {
    expect(resolveWorkspaceBrandLogo('/brands/logo.png', ' , https://portal.test/a , http://other.test'))
      .toBe('https://portal.test/brands/logo.png')
  })

  it('keeps the path when no portal origin is configured', () => {
    expect(resolveWorkspaceBrandLogo('/brands/logo.png', undefined)).toBe('/brands/logo.png')
    expect(resolveWorkspaceBrandLogo('/brands/logo.png', '  ')).toBe('/brands/logo.png')
  })
})
