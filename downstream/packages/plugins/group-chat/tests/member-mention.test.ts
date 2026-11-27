import { beforeEach, describe, expect, it, vi } from 'vitest'
import { declaredMentions } from '../src/routing.ts'
import { MEMBER_MENTION_SOURCE } from '../src/reference-ids.ts'

const listMembers = vi.fn()
vi.mock('../src/client/api.ts', () => ({
  listMembers: (roomId: string) => listMembers(roomId),
}))

const { registerMemberSource } = await import('../src/client/memberReference.ts')

/** The slice of the trigger service a plugin registers into. */
interface Registered {
  readonly trigger: string
  readonly name: string
  readonly order?: number
  readonly showGroupTitle?: boolean
  candidates(session: unknown, request: { query: string; signal: AbortSignal }): Promise<readonly Record<string, unknown>[]>
  onPick(pick: { candidate: Record<string, unknown> }): unknown
  codec: { clipboardText(ref: string): string; serialize(ref: string): Promise<string> }
}

const capture = (activeRoomId: string | undefined) => {
  const registered: Registered[] = []
  const inputTriggers = { registerSource(source: unknown) { registered.push(source as Registered); return () => {} } }
  const store = { getState: () => ({ activeRoomId }) } as never
  registerMemberSource(inputTriggers as never, store)
  return registered[0]!
}

const signal = () => new AbortController().signal

describe('roster mention source', () => {
  beforeEach(() => {
    listMembers.mockReset()
    listMembers.mockResolvedValue([
      { userId: 'u-owner', displayName: '张三', owner: true, joinedAt: '2026-01-01T00:00:00Z' },
      { userId: 'u-guest', displayName: '李四', owner: false, joinedAt: '2026-01-02T00:00:00Z' },
    ])
  })

  it('registers as its own @ group above room messages', () => {
    const source = capture('room-1')
    expect(source.trigger).toBe('@')
    expect(source.name).toBe(MEMBER_MENTION_SOURCE)
    expect(source.showGroupTitle).toBe(true)
    // A member is the more common address, so its group sits above the message group (30).
    expect(source.order).toBeLessThan(30)
  })

  it('answers nothing outside a room, so ordinary sessions keep their menu', async () => {
    const source = capture(undefined)
    await expect(source.candidates({}, { query: '', signal: signal() })).resolves.toEqual([])
    expect(listMembers).not.toHaveBeenCalled()
  })

  it('answers nothing in a session that is not the open room', async () => {
    const source = capture('room-1')
    // Visiting a room leaves `activeRoomId` set; the Session being composed is what decides, so an
    // ordinary conversation never inherits the roster.
    await expect(source.candidates({ sessionId: 'session-ordinary' }, { query: '', signal: signal() })).resolves.toEqual([])
    const room = await source.candidates({ sessionId: 'group-room-room-1' }, { query: '', signal: signal() })
    expect(room.map(row => row.value)).toEqual(['u-owner', 'u-guest'])
  })

  it('lists the roster as mention rows and filters by query', async () => {
    const source = capture('room-1')
    const all = await source.candidates({}, { query: '', signal: signal() })
    expect(listMembers).toHaveBeenCalledWith('room-1')
    expect(all.map(row => row.value)).toEqual(['u-owner', 'u-guest'])
    expect(all[0]).toMatchObject({ name: '张三', icon: 'mention', description: '群主' })
    expect(all[1]).not.toHaveProperty('description')

    const filtered = await source.candidates({}, { query: '李', signal: signal() })
    expect(filtered.map(row => row.value)).toEqual(['u-guest'])
  })

  it('picks into a mention chip whose words match the clipboard', async () => {
    const source = capture('room-1')
    const [row] = await source.candidates({}, { query: '', signal: signal() })
    const outcome = source.onPick({ candidate: row! }) as {
      insert: { source: string; ref: string; label: string; appearance: string; clipboardText: string }
    }
    expect(outcome.insert).toEqual({
      source: MEMBER_MENTION_SOURCE,
      ref: 'u-owner',
      // The chip label, the clipboard projection, and the model text are one string: the prompt
      // text and the declared ids cannot disagree about who was addressed.
      label: '张三',
      appearance: 'mention',
      clipboardText: '@张三',
    })
    await expect(source.codec.serialize('u-owner')).resolves.toBe('@张三')
    expect(source.codec.clipboardText('u-owner')).toBe('@张三')
  })
})

describe('declared mentions on the prompt source', () => {
  it('keeps only roster ids, in pick order, without duplicates', () => {
    expect(declaredMentions({
      mentions: [
        { sourceId: MEMBER_MENTION_SOURCE, itemId: 'u-owner', displayName: '张三' },
        { sourceId: 'some-file-source', itemId: 'src/a.ts', displayName: 'a.ts' },
        { sourceId: MEMBER_MENTION_SOURCE, itemId: 'u-guest', displayName: '李四' },
        { sourceId: MEMBER_MENTION_SOURCE, itemId: 'u-owner', displayName: '张三' },
        { sourceId: MEMBER_MENTION_SOURCE, itemId: '', displayName: '空' },
      ],
    })).toEqual(['u-owner', 'u-guest'])
  })

  it('answers nothing for a prompt composed before mentions existed', () => {
    expect(declaredMentions(undefined)).toEqual([])
    expect(declaredMentions({})).toEqual([])
    expect(declaredMentions({ mentions: 'u-owner' })).toEqual([])
  })
})