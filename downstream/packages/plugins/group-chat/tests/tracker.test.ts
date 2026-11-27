import { describe, expect, it } from 'vitest'
import { RoomEventTracker, roomIdOfSession, roomSessionId, ROOM_SESSION_PREFIX } from '../src/index.ts'

describe('room session binding', () => {
  it('derives a stable session id from a room id', () => {
    expect(roomSessionId('room-1')).toBe(`${ROOM_SESSION_PREFIX}room-1`)
  })

  it('round-trips a room id through its session id', () => {
    expect(roomIdOfSession({ id: roomSessionId('room-abc') })).toBe('room-abc')
  })

  it('reports no room for an ordinary session, so the plugin never claims one', () => {
    expect(roomIdOfSession({ id: 'session-42' })).toBeUndefined()
    expect(roomIdOfSession({ id: 'session-f393a380-e73c' })).toBeUndefined()
  })

  it('treats a bare prefix with no room as no room', () => {
    expect(roomIdOfSession({ id: ROOM_SESSION_PREFIX })).toBeUndefined()
  })

  it('survives a missing or malformed session object', () => {
    expect(roomIdOfSession({})).toBeUndefined()
    expect(roomIdOfSession(null)).toBeUndefined()
    expect(roomIdOfSession({ id: 7 })).toBeUndefined()
  })
})

describe('RoomEventTracker', () => {
  it('accepts a first sighting and rejects a repeat', () => {
    const tracker = new RoomEventTracker()
    expect(tracker.accept('room-1', '10')).toBe(true)
    expect(tracker.accept('room-1', '10')).toBe(false)
    expect(tracker.has('room-1', '10')).toBe(true)
  })

  it('keeps rooms independent, so an id in one room does not mask another', () => {
    const tracker = new RoomEventTracker()
    expect(tracker.accept('room-1', '10')).toBe(true)
    expect(tracker.accept('room-2', '10')).toBe(true)
    expect(tracker.has('room-2', '10')).toBe(true)
  })

  it('reports the highest id as the resume cursor, not the last inserted', () => {
    const tracker = new RoomEventTracker()
    tracker.accept('room-1', '2')
    tracker.accept('room-1', '10')
    tracker.accept('room-1', '9')
    expect(tracker.cursorOf('room-1')).toBe('10')
  })

  it('compares ids by numeric magnitude, not string length alone', () => {
    const tracker = new RoomEventTracker()
    tracker.accept('room-1', '999')
    tracker.accept('room-1', '1000')
    expect(tracker.cursorOf('room-1')).toBe('1000')
  })

  it('never returns a non-numeric id as the resume cursor', () => {
    // The backend's `since` cursor is the row's global id. A string that is not that id
    // (older data, a hand-injected row) makes the backend answer with nothing, and the
    // poll would then break out of its loop forever instead of resuming.
    const tracker = new RoomEventTracker()
    tracker.accept('room-1', '49')
    tracker.accept('room-1', 'verify-2')
    expect(tracker.cursorOf('room-1')).toBe('49')
  })

  it('keeps ordering by numeric magnitude when a long non-numeric id is present', () => {
    const tracker = new RoomEventTracker()
    tracker.accept('room-1', 'verify-1')
    tracker.accept('room-1', '9')
    tracker.accept('room-1', '100')
    expect(tracker.cursorOf('room-1')).toBe('100')
  })

  it('has no cursor when every id seen is non-numeric, so the next sync re-reads the room', () => {
    const tracker = new RoomEventTracker()
    tracker.accept('room-1', 'verify-1')
    expect(tracker.cursorOf('room-1')).toBeUndefined()
  })

  it('has no cursor before any event, so a first sync asks for the whole room', () => {
    expect(new RoomEventTracker().cursorOf('room-1')).toBeUndefined()
  })

  it('seeds from a local session log so a restart resumes instead of re-appending', () => {
    const tracker = new RoomEventTracker()
    tracker.seedFromSession('room-1', [
      { type: 'user/message', seq: 0, time: 1, data: { source: { roomId: 'room-1', messageId: '5' } } },
      { type: 'user/message', seq: 1, time: 2, data: { source: { roomId: 'room-1', messageId: '7' } } },
      // Another room, and an ordinary session with no room: neither may seed this one.
      { type: 'user/message', seq: 2, time: 3, data: { source: { roomId: 'room-2', messageId: '99' } } },
      { type: 'user/message', seq: 3, time: 4, data: { source: { kind: 'user' } } },
    ] as never)
    expect(tracker.cursorOf('room-1')).toBe('7')
    expect(tracker.accept('room-1', '5')).toBe(false)
    expect(tracker.accept('room-1', '8')).toBe(true)
  })

  it('ignores seeded events whose identity is missing', () => {
    const tracker = new RoomEventTracker()
    tracker.seedFromSession('room-1', [
      { type: 'user/message', seq: 0, time: 1, data: { source: { roomId: 'room-1' } } },
    ] as never)
    expect(tracker.cursorOf('room-1')).toBeUndefined()
  })
})
