import { describe, expect, it, vi } from 'vitest'
import { createRoomStore } from '../src/client/store.ts'

const ROOM = 'room-1'

/** The store the sidebar drives, with the catalog replaced by spies. */
const storeWith = (options: { openSession?: (roomId: string) => Promise<void> } = {}) =>
  createRoomStore({ openSession: options.openSession ?? (async () => {}) })

describe('selecting a room shows its session', () => {
  it('hands the room to the shell, which resolves the Session the main view follows', async () => {
    const openSession = vi.fn(async (_roomId: string) => {})
    const store = storeWith({ openSession })

    store.open(ROOM)
    await Promise.resolve()

    // The Host owns Session and workspace resolution, so the store passes the room id and the
    // shell selects what comes back; the highlight moves either way.
    expect(openSession).toHaveBeenCalledTimes(1)
    expect(openSession).toHaveBeenCalledWith(ROOM)
    expect(store.getState().activeRoomId).toBe(ROOM)
    expect(store.getState().openFailure).toBeUndefined()
  })

  it('asks again on every open; reuse is the Host\'s to guarantee', async () => {
    const openSession = vi.fn(async (_roomId: string) => {})
    const store = storeWith({ openSession })

    store.open(ROOM)
    store.open(ROOM)
    await Promise.resolve()

    // The store never creates anything, so a reader switching away and back cannot grow a second
    // Session; the Host resolves the same one.
    expect(openSession.mock.calls.map(([id]) => id)).toEqual([ROOM, ROOM])
  })

  it('does not pre-check the catalog, which pages its list', async () => {
    const openSession = vi.fn(async (_roomId: string) => {})
    const store = storeWith({ openSession })

    store.open(ROOM)
    await Promise.resolve()

    // A room whose Session exists can be absent from the page in hand; a pre-flight check would
    // have refused a room that is really there.
    expect(openSession).toHaveBeenCalledWith(ROOM)
    expect(store.getState().openFailure).toBeUndefined()
  })

  it('surfaces a refusal instead of leaving the previous view up', async () => {
    const store = storeWith({
      openSession: async () => { throw new Error('the Host refused to open the room') },
    })

    store.open(ROOM)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(store.getState().openFailure).toBe('roomOpenFailed')
  })

  it('clears the notice on the next successful open', async () => {
    let refuse = true
    const store = storeWith({
      openSession: async () => { if (refuse) throw new Error('the Host refused to open the room') },
    })

    store.open(ROOM)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.getState().openFailure).toBe('roomOpenFailed')

    refuse = false
    store.open(ROOM)
    await Promise.resolve()
    expect(store.getState().openFailure).toBeUndefined()
  })
})