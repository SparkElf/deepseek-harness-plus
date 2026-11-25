import { describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_CHANGED_EVENT,
  OCR_SETTINGS_ROLES,
  installConditionalSection,
  isOcrSettingsVisible,
  type VisibilityWindow,
} from '../src/client/sectionVisibility.ts'

/** The smallest window the visibility controller touches. */
class FakeWindow implements VisibilityWindow {
  __DATAOPS_USER__: { readonly name?: unknown } | null = null
  private readonly listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }
  count(type: string): number { return this.listeners.get(type)?.size ?? 0 }
}

describe('which roles may configure document recognition', () => {
  it('admits exactly the two administrator role names', () => {
    expect(OCR_SETTINGS_ROLES).toEqual(['超级管理员', '管理员'])
    expect(isOcrSettingsVisible('超级管理员')).toBe(true)
    expect(isOcrSettingsVisible('管理员')).toBe(true)
  })

  it('refuses ordinary roles, absent identity, and names that only look similar', () => {
    expect(isOcrSettingsVisible('运营人员')).toBe(false)
    expect(isOcrSettingsVisible('应用人员')).toBe(false)
    expect(isOcrSettingsVisible('部门管理员')).toBe(false)
    expect(isOcrSettingsVisible('管理员助理')).toBe(false)
    expect(isOcrSettingsVisible(' 管理员 ')).toBe(false)
    expect(isOcrSettingsVisible(undefined)).toBe(false)
    expect(isOcrSettingsVisible(null)).toBe(false)
  })
})

describe('conditional Settings registration', () => {
  it('does not register before an authorized identity arrives, then follows the event', () => {
    const window = new FakeWindow()
    const register = vi.fn(() => vi.fn())
    const dispose = installConditionalSection({ window, register })
    expect(register).not.toHaveBeenCalled()
    window.__DATAOPS_USER__ = { name: '管理员' }
    window.dispatch(ACCOUNT_CHANGED_EVENT)
    expect(register).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('disposes and re-registers when the role changes', () => {
    const window = new FakeWindow()
    window.__DATAOPS_USER__ = { name: '超级管理员' }
    const first = vi.fn()
    const second = vi.fn()
    const register = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const dispose = installConditionalSection({ window, register })
    expect(register).toHaveBeenCalledTimes(1)
    window.__DATAOPS_USER__ = { name: '运营人员' }
    window.dispatch(ACCOUNT_CHANGED_EVENT)
    expect(first).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledTimes(1)
    window.__DATAOPS_USER__ = { name: '管理员' }
    window.dispatch(ACCOUNT_CHANGED_EVENT)
    expect(register).toHaveBeenCalledTimes(2)
    dispose()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('removes the listener on dispose, so later role changes cannot revive the section', () => {
    const window = new FakeWindow()
    window.__DATAOPS_USER__ = { name: '管理员' }
    const register = vi.fn(() => vi.fn())
    const dispose = installConditionalSection({ window, register })
    dispose()
    expect(window.count(ACCOUNT_CHANGED_EVENT)).toBe(0)
    window.dispatch(ACCOUNT_CHANGED_EVENT)
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('treats the extra observer as another sync signal', () => {
    const window = new FakeWindow()
    let sync: (() => void) | undefined
    const register = vi.fn(() => vi.fn())
    const disposeObserver = vi.fn()
    const dispose = installConditionalSection({
      window,
      register,
      observe: (callback) => { sync = callback; return disposeObserver },
    })
    expect(register).not.toHaveBeenCalled()
    window.__DATAOPS_USER__ = { name: '管理员' }
    sync?.()
    expect(register).toHaveBeenCalledTimes(1)
    dispose()
    expect(disposeObserver).toHaveBeenCalledTimes(1)
  })

  it('reports a rejected registration instead of taking the plugin down', () => {
    const window = new FakeWindow()
    window.__DATAOPS_USER__ = { name: '管理员' }
    const error = new Error('slot occupied')
    const onError = vi.fn()
    const dispose = installConditionalSection({ window, register: () => { throw error }, onError })
    expect(onError).toHaveBeenCalledWith(error)
    dispose()
  })
})
