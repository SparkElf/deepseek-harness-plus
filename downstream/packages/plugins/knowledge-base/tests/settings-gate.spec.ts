import { describe, expect, it, vi } from 'vitest'
import {
  DATAOPS_ACCOUNT_CHANGED_EVENT,
  canSeeKnowledgeSettings,
  createSettingsGate,
} from '../src/client/settingsGate.ts'

describe('knowledge settings visibility gate', () => {
  it('allows exactly the platform administrator roles', () => {
    expect(canSeeKnowledgeSettings({ name: '超级管理员' })).toBe(true)
    expect(canSeeKnowledgeSettings({ name: '管理员' })).toBe(true)
    expect(canSeeKnowledgeSettings({ name: '部门管理员' })).toBe(false)
    expect(canSeeKnowledgeSettings({ name: '普通用户' })).toBe(false)
    expect(canSeeKnowledgeSettings(null)).toBe(false)
    expect(canSeeKnowledgeSettings(undefined)).toBe(false)
  })

  it('does not register until the role is authorized, then re-registers on promotion', () => {
    let identity: { name: string } | null = { name: '普通用户' }
    let emit: (() => void) | undefined
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const gate = createSettingsGate({
      register,
      readIdentity: () => identity,
      subscribe: (listener) => { emit = listener; return () => { emit = undefined } },
    })
    gate.start()
    expect(register).not.toHaveBeenCalled()

    identity = { name: '管理员' }
    emit?.()
    expect(register).toHaveBeenCalledTimes(1)
    expect(dispose).not.toHaveBeenCalled()

    // A second event with the same authorized role must not register twice.
    emit?.()
    expect(register).toHaveBeenCalledTimes(1)

    identity = { name: '部门管理员' }
    emit?.()
    expect(dispose).toHaveBeenCalledTimes(1)

    identity = { name: '超级管理员' }
    emit?.()
    expect(register).toHaveBeenCalledTimes(2)
    gate.stop()
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('reconciles the first identity through the dataset observer', () => {
    let identity: { name: string } | null = null
    let observed: (() => void) | undefined
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const gate = createSettingsGate({
      register,
      readIdentity: () => identity,
      subscribe: () => () => undefined,
      observe: (sync) => { observed = sync; return () => { observed = undefined } },
    })
    gate.start()
    expect(register).not.toHaveBeenCalled()
    // The account bridge writes __DATAOPS_USER__ and then the dataset attribute; the
    // observer is the fallback when no ``dataops-account:changed`` event was dispatched.
    identity = { name: '管理员' }
    observed?.()
    expect(register).toHaveBeenCalledTimes(1)
    gate.stop()
    expect(observed).toBeUndefined()
  })

  it('registers immediately when the page already has an administrator', () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const gate = createSettingsGate({
      register,
      readIdentity: () => ({ name: '超级管理员' }),
      subscribe: () => () => undefined,
    })
    gate.start()
    expect(register).toHaveBeenCalledTimes(1)
    gate.stop()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('uses the documented account event name', () => {
    expect(DATAOPS_ACCOUNT_CHANGED_EVENT).toBe('dataops-account:changed')
  })
})
