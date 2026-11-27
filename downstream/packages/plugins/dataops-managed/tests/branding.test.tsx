import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HarnessBadge,
  WanxiangMark,
  WanxiangSidebarName,
  WanxiangWordmark,
} from '../src/client/WanxiangBrand.tsx'
import {
  DEFAULT_WANXIANG_BRANDING,
  setWanxiangBrandEnabled,
  setWanxiangBranding,
  wanxiangBrandPreference,
} from '../src/client/brand-store.ts'
import { brandDocumentTitle } from '../src/client/install-branding.tsx'

const CUSTOM_LOGO = 'data:image/png;base64,iVBORw0KGgo='

afterEach(() => {
  setWanxiangBrandEnabled(true)
  setWanxiangBranding(DEFAULT_WANXIANG_BRANDING)
})

describe('Wanxiang managed branding', () => {
  it('declares four linked SVG units without a text element', () => {
    const mark = WanxiangMark({ size: 34, animated: true })
    expect(mark.type).toBe('svg')
    expect(mark.props.viewBox).toBe('0 0 54 58')
    expect(mark.props.children).toHaveLength(4)
  })

  it('renders the platform wordmark as text and keeps seven official HARNESS paths', () => {
    const wordmark = WanxiangWordmark({ height: 16 })
    const badge = HarnessBadge({})
    const badgePaths = badge.props.children[1]
    const sidebar = WanxiangSidebarName()
    expect(wordmark.type).toBe('span')
    expect(wordmark.props.children).toBe('万相AI中台')
    expect(wordmark.props.style.fontSize).toBe(16)
    expect(badge.props.viewBox).toBe('129 5 53 15.5')
    expect(badgePaths).toHaveLength(7)
    expect(badgePaths[0].props.d).toContain('M132.848 8.93205')
    expect(sidebar.props.children).toHaveLength(2)
  })

  it('names the accessible wordmark 万相AI中台', () => {
    const wordmark = WanxiangWordmark({ height: 16, accessible: true })
    expect(wordmark.props.role).toBe('img')
    expect(wordmark.props['aria-label']).toBe('万相AI中台')
  })

  it('uses the custom portal name in the wordmark and document title', () => {
    setWanxiangBranding({ name: '星海数据中台' })
    const wordmark = WanxiangWordmark({ height: 16 })
    const accessible = WanxiangWordmark({ height: 16, accessible: true })
    expect(wordmark.props.children).toBe('星海数据中台')
    expect(accessible.props['aria-label']).toBe('星海数据中台')
    expect(brandDocumentTitle('星海数据中台')).toBe('星海数据中台 Harness')
  })

  it('prefers a custom logo image and keeps the size box', () => {
    setWanxiangBranding({ logo: CUSTOM_LOGO })
    const mark = WanxiangMark({ size: 24 })
    expect(mark.type).toBe('img')
    expect(mark.props.src).toBe(CUSTOM_LOGO)
    expect(mark.props.width).toBe(24)
    expect(mark.props.height).toBe((24 * 58) / 54)
    expect(mark.props['aria-hidden']).toBe('true')
  })

  it('falls back to the inline mark for an unusable logo value', () => {
    setWanxiangBranding({ logo: 'javascript:alert(1)' })
    const mark = WanxiangMark({ size: 24 })
    expect(mark.type).toBe('svg')
    expect(mark.props.viewBox).toBe('0 0 54 58')
  })

  it('defaults on and notifies every preference transition', () => {
    expect(wanxiangBrandPreference.getSnapshot().enabled).toBe(true)
    expect(wanxiangBrandPreference.getSnapshot().name).toBe('万相AI中台')
    expect(wanxiangBrandPreference.getSnapshot().logo).toBe('')
    const listener = vi.fn()
    const unsubscribe = wanxiangBrandPreference.subscribe(listener)
    setWanxiangBrandEnabled(false)
    expect(wanxiangBrandPreference.getSnapshot().enabled).toBe(false)
    expect(listener).toHaveBeenCalledOnce()
    setWanxiangBrandEnabled(true)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('keeps live branding while the brand toggle is off', () => {
    setWanxiangBranding({ name: '星海数据中台', logo: CUSTOM_LOGO })
    setWanxiangBrandEnabled(false)
    expect(wanxiangBrandPreference.getSnapshot()).toMatchObject({
      enabled: false,
      name: '星海数据中台',
      logo: CUSTOM_LOGO,
    })
    setWanxiangBrandEnabled(true)
    expect(WanxiangMark({ size: 24 }).type).toBe('img')
  })
})