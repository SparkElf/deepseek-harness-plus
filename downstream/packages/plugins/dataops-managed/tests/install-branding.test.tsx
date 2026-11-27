// @vitest-environment jsdom
/**
 * The shell branding effect: it reads the Host at startup, applies the portal brand to the
 * document title and favicon, and leaves the DSH identity untouched while the toggle is off.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installWanxiangBranding } from '../src/client/install-branding.tsx'
import {
  DEFAULT_WANXIANG_BRANDING,
  setWanxiangBrandEnabled,
  setWanxiangBranding,
} from '../src/client/brand-store.ts'

const ORIGINAL_TITLE = 'DeepSeek Harness'

/** Install the effect and return its cleanup captured from `ctx.effect`. */
function install(): () => void {
  let cleanup: (() => void) | undefined
  const context = {
    effect: (factory: () => void | (() => void)) => {
      const result = factory()
      if (typeof result === 'function') cleanup = result
      return () => undefined
    },
    slots: {
      // The DOM assertions do not need slot contents; returning a disposer keeps the effect happy.
      inject: (_name: string, callback: () => unknown) => { callback(); return () => undefined },
      register: () => () => undefined,
    },
  }
  installWanxiangBranding(context as never)
  return () => { cleanup?.() }
}

const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response

beforeEach(() => {
  document.head.innerHTML = ''
  document.title = ORIGINAL_TITLE
  delete document.documentElement.dataset.dataopsBrand
  setWanxiangBrandEnabled(true)
  setWanxiangBranding(DEFAULT_WANXIANG_BRANDING)
})

afterEach(() => { vi.unstubAllGlobals() })

describe('installWanxiangBranding', () => {
  it('applies the portal name, logo and title at startup', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer({ name: '星海数据中台', logo: '/brands/custom.png' })))
    const cleanup = install()

    await vi.waitFor(() => {
      expect(document.title).toBe('星海数据中台 Harness')
    })
    const favicon = document.getElementById('dataops-wanxiang-favicon') as HTMLLinkElement
    expect(favicon.href).toContain('/brands/custom.png')
    expect(favicon.type).toBe('image/png')
    expect(document.documentElement.dataset.dataopsBrand).toBe('wanxiang')
    cleanup()
  })

  it('keeps the default brand when the Host read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const cleanup = install()

    await vi.waitFor(() => {
      expect(document.title).toBe('万相AI中台 Harness')
    })
    const favicon = document.getElementById('dataops-wanxiang-favicon') as HTMLLinkElement
    expect(favicon.href.startsWith('data:image/svg+xml,')).toBe(true)
    expect(favicon.type).toBe('image/svg+xml')
    cleanup()
  })

  it('does not overwrite a live DSH title when branding changes while the toggle is off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer({ name: '星海数据中台', logo: '' })))
    const cleanup = install()
    await vi.waitFor(() => { expect(document.title).toBe('星海数据中台 Harness') })

    setWanxiangBrandEnabled(false)
    document.title = '会话 A - DeepSeek Harness'
    setWanxiangBranding({ name: '另一个品牌' })
    expect(document.title).toBe('会话 A - DeepSeek Harness')
    cleanup()
  })

  it('restores the DSH identity when the brand toggle is off, then applies it again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer({ name: '星海数据中台', logo: '' })))
    const cleanup = install()
    await vi.waitFor(() => { expect(document.title).toBe('星海数据中台 Harness') })

    setWanxiangBrandEnabled(false)
    expect(document.title).toBe(ORIGINAL_TITLE)
    expect(document.getElementById('dataops-wanxiang-favicon')).toBeNull()
    expect(document.documentElement.dataset.dataopsBrand).toBeUndefined()

    setWanxiangBrandEnabled(true)
    expect(document.title).toBe('星海数据中台 Harness')
    expect(document.getElementById('dataops-wanxiang-favicon')).not.toBeNull()
    cleanup()
  })
})