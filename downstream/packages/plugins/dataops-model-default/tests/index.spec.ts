/** Unit coverage for the selection projection and the debounced default write. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  apply, isTopLevelSession, PERSIST_DELAY_MS, sameSelection, selectionOf,
  type Selection, type SessionEventLike, type SessionLike,
} from '../src/index.ts'

/** A context stand-in: records the listener, exposes looked-up services, runs effects. */
function harness(services: Record<string, unknown>) {
  let listener: ((session: SessionLike, event: SessionEventLike) => void) | undefined
  const disposers: Array<() => void> = []
  const ctx = {
    get: (name: string) => services[name],
    on: (name: string, next: (session: SessionLike, event: SessionEventLike) => void) => {
      if (name === 'session/event') listener = next
      return () => { if (listener === next) listener = undefined }
    },
    effect: (setup: () => () => void) => { disposers.push(setup()) },
    logger: { info: vi.fn(), warn: vi.fn() },
  }
  return {
    ctx: ctx as unknown as Context,
    logger: ctx.logger,
    emit: (session: SessionLike, event: SessionEventLike) => listener?.(session, event),
    hasListener: () => listener !== undefined,
    dispose: () => { for (const off of disposers) off() },
  }
}

const top: SessionLike = { header: {} }
const child: SessionLike = { header: { parentSession: 'parent' } }
const selection = (model: string): SessionEventLike => ({ type: 'model/selection', data: { provider: 'p', model } })

afterEach(() => { vi.useRealTimers() })

describe('selectionOf', () => {
  it('reads a complete selection and keeps an absent effort absent', () => {
    expect(selectionOf({ type: 'model/selection', data: { provider: 'p', model: 'm' } })).toEqual({ provider: 'p', model: 'm' })
    expect(selectionOf({ type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'high' } }))
      .toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })

  it('rejects other events and malformed selections', () => {
    expect(selectionOf({ type: 'user/message', data: { provider: 'p', model: 'm' } })).toBeUndefined()
    expect(selectionOf({ type: 'model/selection' })).toBeUndefined()
    expect(selectionOf({ type: 'model/selection', data: null })).toBeUndefined()
    expect(selectionOf({ type: 'model/selection', data: ['p'] })).toBeUndefined()
    expect(selectionOf({ type: 'model/selection', data: { provider: '', model: 'm' } })).toBeUndefined()
    expect(selectionOf({ type: 'model/selection', data: { provider: 'p' } })).toBeUndefined()
    expect(selectionOf({ type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: '' } })).toBeUndefined()
  })
})

describe('sameSelection', () => {
  it('compares provider, model and effort, treating an absent effort as absent', () => {
    expect(sameSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' })).toBe(true)
    expect(sameSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }, { provider: 'p', model: 'm' })).toBe(false)
    expect(sameSelection({ provider: 'p', model: 'm' }, { provider: 'q', model: 'm' })).toBe(false)
  })
})

describe('isTopLevelSession', () => {
  it('accepts a session without parent lineage and rejects subagent/fork children', () => {
    expect(isTopLevelSession({})).toBe(true)
    expect(isTopLevelSession({ header: {} })).toBe(true)
    expect(isTopLevelSession(child)).toBe(false)
  })
})

describe('apply', () => {
  it('persists the last selection of a burst through saveSelection', async () => {
    vi.useFakeTimers()
    const current: { value: Selection } = { value: { provider: 'p', model: 'old' } }
    const saveSelection = vi.fn(async (next: Selection) => { current.value = next })
    const h = harness({ agentDefaultModel: { currentSelection: () => current.value, saveSelection } })
    apply(h.ctx)

    h.emit(top, selection('first'))
    h.emit(top, selection('second'))
    await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS - 1)
    expect(saveSelection).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(saveSelection).toHaveBeenCalledTimes(1)
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'p', model: 'second' })
    expect(h.logger.info).toHaveBeenCalled()
  })

  it('ignores subagent sessions and non-selection events', async () => {
    vi.useFakeTimers()
    const saveSelection = vi.fn(async () => {})
    const h = harness({ agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'old' }), saveSelection } })
    apply(h.ctx)

    h.emit(child, selection('child-model'))
    h.emit(top, { type: 'user/message', data: { provider: 'p', model: 'm' } })
    await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS * 4)
    expect(saveSelection).not.toHaveBeenCalled()
  })

  it('skips a write when the live default already holds the selection', async () => {
    vi.useFakeTimers()
    const saveSelection = vi.fn(async () => {})
    const h = harness({ agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'same' }), saveSelection } })
    apply(h.ctx)

    h.emit(top, selection('same'))
    await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS * 2)
    expect(saveSelection).not.toHaveBeenCalled()
  })

  it('falls back to the settings namespace when saveSelection leaves the default unchanged', async () => {
    vi.useFakeTimers()
    const update = vi.fn(async () => {})
    const h = harness({
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'old' }), saveSelection: vi.fn(async () => {}) },
      settings: { update },
    })
    apply(h.ctx)

    h.emit(top, { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'max' } })
    await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS)
    expect(update).toHaveBeenCalledWith('agent-default-model', { provider: 'p', model: 'm', reasoningEffort: 'max' })
  })

  it('reports a missing write path once and keeps the listener alive', async () => {
    vi.useFakeTimers()
    const h = harness({})
    apply(h.ctx)

    h.emit(top, selection('a'))
    await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS)
    h.emit(top, selection('b'))
    await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS)
    expect(h.logger.warn).toHaveBeenCalledTimes(2)
    expect(h.hasListener()).toBe(true)
  })

  it('removes the listener and the pending timer on dispose', async () => {
    vi.useFakeTimers()
    const saveSelection = vi.fn(async () => {})
    const h = harness({ agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'old' }), saveSelection } })
    apply(h.ctx)

    h.emit(top, selection('late'))
    h.dispose()
    await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS * 2)
    expect(h.hasListener()).toBe(false)
    expect(saveSelection).not.toHaveBeenCalled()
  })
})