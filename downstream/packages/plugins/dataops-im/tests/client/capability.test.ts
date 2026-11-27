import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchImCapability } from '../../src/client/api.ts'
import {
  canSeeImBotSettings,
  imBotSettingsVisibility,
  probeImBotSettings,
} from '../../src/client/visibility.ts'

/** One JSON response, matching the proxy's `content-type`. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchImCapability', () => {
  it('keeps capability=true on a deployment that supports IM', async () => {
    const fetchMock = vi.fn(async () => json({ allowed: true }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchImCapability()).resolves.toEqual({ available: true, allowed: true })
    expect(fetchMock).toHaveBeenCalledWith('/integrations/dataops/im/capability', expect.any(Object))
  })

  it('keeps capability=false for an authorized user without the permission', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ allowed: false })))
    await expect(fetchImCapability()).resolves.toEqual({ available: true, allowed: false })
  })

  it.each([404, 502, 503])('degrades HTTP %i without throwing', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unavailable' }, status)))
    const capability = await fetchImCapability()
    expect(capability.available).toBe(false)
    expect(capability.allowed).toBe(false)
    expect(capability.reason).toContain(String(status))
  })

  it('degrades a network error without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED') }))
    const capability = await fetchImCapability()
    expect(capability.available).toBe(false)
    expect(capability.allowed).toBe(false)
    expect(capability.reason).toBe('connect ECONNREFUSED')
  })

  it('degrades an unparseable 200 instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 200 })))
    const capability = await fetchImCapability()
    expect(capability.available).toBe(false)
    expect(capability.reason).toContain('HTTP 200')
  })

  it('treats a session failure as present-but-forbidden, not unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'missing session' }, 401)))
    await expect(fetchImCapability()).resolves.toEqual({
      available: true,
      allowed: false,
      reason: 'unauthenticated',
    })
  })
})

describe('imBotSettingsVisibility', () => {
  it('enables the full page for an available, permitted account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ allowed: true })))
    await expect(imBotSettingsVisibility()).resolves.toBe('enabled')
    await expect(canSeeImBotSettings()).resolves.toBe(true)
  })

  it('hides the entry for an available deployment without the permission', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ allowed: false })))
    await expect(imBotSettingsVisibility()).resolves.toBe('hidden')
    await expect(canSeeImBotSettings()).resolves.toBe(false)
  })

  it.each([404, 502, 503])('shows the unavailable notice on HTTP %i', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, status)))
    await expect(imBotSettingsVisibility()).resolves.toBe('unavailable')
    await expect(canSeeImBotSettings()).resolves.toBe(false)
  })

  it('shows the unavailable notice when the probe cannot reach the proxy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await expect(probeImBotSettings()).resolves.toMatchObject({ available: false })
    await expect(imBotSettingsVisibility()).resolves.toBe('unavailable')
    await expect(canSeeImBotSettings()).resolves.toBe(false)
  })
})