import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HarnessBadge,
  WanxiangMark,
  WanxiangSidebarName,
  WanxiangWordmark,
} from '../src/client/WanxiangBrand.tsx'
import {
  setWanxiangBrandEnabled,
  wanxiangBrandPreference,
} from '../src/client/brand-store.ts'

afterEach(() => { setWanxiangBrandEnabled(true) })

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

  it('defaults on and notifies every preference transition', () => {
    expect(wanxiangBrandPreference.getSnapshot().enabled).toBe(true)
    const listener = vi.fn()
    const unsubscribe = wanxiangBrandPreference.subscribe(listener)
    setWanxiangBrandEnabled(false)
    expect(wanxiangBrandPreference.getSnapshot().enabled).toBe(false)
    expect(listener).toHaveBeenCalledOnce()
    setWanxiangBrandEnabled(true)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})
