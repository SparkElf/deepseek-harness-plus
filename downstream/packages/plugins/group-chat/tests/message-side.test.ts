/**
 * Which side a message belongs on, and — the part that matters most — that an ordinary
 * Session is never wrapped at all.
 */
import { describe, expect, it } from 'vitest'
import { messageSide } from '../src/client/MessageSide.tsx'

const SELF = 'user-self'

/** A message the Host admitted to a room. */
const room = (over: Record<string, unknown> = {}): { source: Record<string, unknown> } => ({
  source: { kind: 'user', roomId: 'room-1', memberId: SELF, authorKind: 'human', ...over },
})

describe('消息落在哪一侧', () => {
  it('把本工作区自己的消息放在右侧', () => {
    expect(messageSide(room(), SELF)).toBe('self')
  })

  it('把其他成员的消息放在左侧', () => {
    expect(messageSide(room({ memberId: 'someone-else' }), SELF)).toBe('other')
  })

  it('把 agent 的消息放在左侧', () => {
    // An agent is never the operator, even when the room is a one-person room where the
    // agent answers the operator's own prompt.
    expect(messageSide(room({ authorKind: 'agent' }), SELF)).toBe('other')
  })

  it('身份未知时不认领消息', () => {
    // Claiming another member's words as the operator's would misattribute them on screen
    // and is the one failure mode that cannot be noticed by looking at the row.
    expect(messageSide(room(), undefined)).toBe('other')
    expect(messageSide(room({ memberId: 'someone-else' }), undefined)).toBe('other')
  })

  it('不是群聊消息时不介入', () => {
    // This is acceptance criterion ④ at the renderer: an ordinary Session's message has no
    // room source, so the wrapper renders the official view untouched. The `kind` and `rpcId`
    // fields an ordinary message really carries are part of the fixture because their absence
    // is not what makes this case ordinary — the missing `roomId` is.
    expect(messageSide({ source: { kind: 'user', rpcId: 'rpc-1', clientTimeZone: 'Asia/Shanghai' } as never }, SELF))
      .toBeUndefined()
    expect(messageSide(undefined, SELF)).toBeUndefined()
    expect(messageSide({}, SELF)).toBeUndefined()
    expect(messageSide({ source: null }, SELF)).toBeUndefined()
  })

  it('roomId 为空串时也不算群聊消息', () => {
    // A present-but-empty id would otherwise be read as a room and wrap an ordinary message.
    expect(messageSide(room({ roomId: '' }), SELF)).toBeUndefined()
  })

  it('roomId 不是字符串时不算群聊消息', () => {
    expect(messageSide({ source: { roomId: 42 } }, SELF)).toBeUndefined()
  })
})
