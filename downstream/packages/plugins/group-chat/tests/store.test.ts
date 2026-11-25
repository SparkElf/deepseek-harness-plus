import { describe, expect, it, vi } from 'vitest'
import { createRoomStore, failureOf } from '../src/client/store.ts'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const room = (id: string, name: string) => ({
  id, name, ownerUserId: 'u1', invitePolicy: 'anyone', discoverability: 'discoverable',
  agentTrigger: 'mention', memberCount: 2, joined: true,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})

describe('room store', () => {
  it('starts unloaded, so the surfaces can tell loading from empty', () => {
    // `undefined` is what makes the sidebar render「正在加载」instead of「还没有群聊」on a
    // slow first read.
    expect(createRoomStore().getState().rooms).toBeUndefined()
  })

  it('returns a stable reference between changes', () => {
    // `useSyncExternalStore` re-renders while the snapshot changes identity, so a store
    // that built a fresh object per read would loop forever.
    const store = createRoomStore()
    expect(store.getState()).toBe(store.getState())
  })

  it('notifies subscribers when the list or the selection changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([room('r1', '产品讨论')])))
    const store = createRoomStore()
    const seen = vi.fn()
    const stop = store.subscribe(seen)
    await store.refresh()
    expect(store.getState().rooms?.map((r) => r.id)).toEqual(['r1'])
    store.open('r1')
    expect(store.getState().activeRoomId).toBe('r1')
    expect(seen).toHaveBeenCalledTimes(2)
    // A disposed subscriber must stop being called, or the sidebar leaks on unmount.
    stop()
    store.open('r2')
    expect(seen).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })

  it('records a failure instead of throwing, so one surface can render it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 503)))
    const store = createRoomStore()
    await store.refresh()
    expect(store.getState().failure).toBe('credentialMissing')
    // A later success clears it, so a recovered server stops showing the error.
    vi.stubGlobal('fetch', vi.fn(async () => json([room('r1', 'x')])))
    await store.refresh()
    expect(store.getState().failure).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('maps each distinguishable failure rather than collapsing them', () => {
    expect(failureOf(new Error('credentialMissing'))).toBe('credentialMissing')
    expect(failureOf(new Error('notConfigured'))).toBe('notConfigured')
    expect(failureOf(new Error('anything else'))).toBe('unreachable')
    expect(failureOf(undefined)).toBe('unreachable')
  })
})
