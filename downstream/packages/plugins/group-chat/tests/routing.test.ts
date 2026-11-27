import { describe, expect, it } from 'vitest'
import type { RoomEvent, RoomMember } from '../src/backend.ts'
import {
  isAgentReply,
  isExternalAuthor,
  mentionsOf,
  messageId,
  senderId,
  shouldTriggerAgent,
  speakerPrefix,
  withSpeakerPrefix,
} from '../src/routing.ts'

const ZHANG = 'user-zhang'
const LI = 'user-li'

const members: readonly RoomMember[] = [
  { userId: ZHANG, displayName: '张三', owner: true, joinedAt: '2026-01-01T00:00:00.000Z' },
  { userId: LI, displayName: '李四', owner: false, joinedAt: '2026-01-01T00:00:00.000Z' },
]

const humanEvent = (input: {
  readonly sender?: string
  readonly mentions?: readonly string[]
  readonly text?: string
  readonly memberName?: string
}): RoomEvent => ({
  type: 'user/message',
  seq: 0,
  time: 1,
  data: {
    id: 'event-1',
    role: 'user',
    content: [{ type: 'text', text: input.text ?? '内容' }],
    source: {
      kind: 'user',
      roomId: 'room-1',
      memberId: input.sender ?? ZHANG,
      memberName: input.memberName ?? '张三',
      authorKind: 'human',
      messageId: '42',
      rpcId: 'rpc-1',
      ...input.mentions === undefined ? {} : { mentions: input.mentions },
    },
  },
  surfaceOp: 'append',
})

describe('event inspection', () => {
  it('reads sender, message id, and author kind off the source', () => {
    expect(senderId(humanEvent({}))).toBe(ZHANG)
    expect(messageId(humanEvent({}))).toBe('42')
    expect(isAgentReply(humanEvent({}))).toBe(false)
  })

  it('treats a malformed event as unattributed rather than throwing', () => {
    const broken: RoomEvent = { type: 'user/message', data: null }
    expect(senderId(broken)).toBeUndefined()
    expect(messageId(broken)).toBeUndefined()
    expect(mentionsOf(broken)).toEqual([])
    expect(shouldTriggerAgent(broken, ZHANG, members)).toBe(false)
  })

  it('rejects mentions that are not plain member-id strings', () => {
    const event = humanEvent({})
    const data = event.data as Record<string, unknown>
    const source = data['source'] as Record<string, unknown>
    source['mentions'] = [{ memberId: ZHANG }, 42, '', ZHANG]
    expect(mentionsOf(event)).toEqual([{ memberId: ZHANG, kind: 'member' }])
  })
})

describe('shouldTriggerAgent', () => {
  it('runs the sender own agent when the sender mentions themselves', () => {
    expect(shouldTriggerAgent(humanEvent({ mentions: [ZHANG] }), ZHANG, members)).toBe(true)
  })

  it('does not run anyone when there is no mention', () => {
    expect(shouldTriggerAgent(humanEvent({}), ZHANG, members)).toBe(false)
  })

  it('does not run a member own agent when someone else mentions them', () => {
    const fromLiMentioningZhang = humanEvent({ sender: LI, mentions: [ZHANG], memberName: '李四' })
    expect(shouldTriggerAgent(fromLiMentioningZhang, ZHANG, members)).toBe(false)
    expect(shouldTriggerAgent(fromLiMentioningZhang, LI, members)).toBe(false)
  })

  it('runs the other member own agent when they mention themselves', () => {
    const fromLiMentioningSelf = humanEvent({ sender: LI, mentions: [LI], memberName: '李四' })
    expect(shouldTriggerAgent(fromLiMentioningSelf, LI, members)).toBe(true)
    expect(shouldTriggerAgent(fromLiMentioningSelf, ZHANG, members)).toBe(false)
  })

  it('defaults to the mention policy when the room states none', () => {
    // The default must reproduce the original rule exactly: an unmentioned message
    // starts nothing even though the sender is this workspace's member.
    expect(shouldTriggerAgent(humanEvent({}), ZHANG, members, undefined)).toBe(false)
    expect(shouldTriggerAgent(humanEvent({ mentions: [ZHANG] }), ZHANG, members, 'mention')).toBe(true)
  })

  it('answers every own message under the always policy, without a mention', () => {
    expect(shouldTriggerAgent(humanEvent({}), ZHANG, members, 'always')).toBe(true)
  })

  it('still refuses to re-trigger on an agent reply under the always policy', () => {
    // An agent answering its own reply is an infinite echo, so `always` cannot lift
    // that guard — it only widens which human messages qualify.
    const reply = {
      id: 'e-agent',
      type: 'assistant/message',
      data: { source: { authorKind: 'agent', agentOwnerId: ZHANG, memberName: '张三' } },
    } as never
    expect(shouldTriggerAgent(reply, ZHANG, members, 'always')).toBe(false)
  })

  it('starts nothing under the never policy, even for a self-mention', () => {
    // `never` is a room-level decision: recording continues, execution stops.
    expect(shouldTriggerAgent(humanEvent({ mentions: [ZHANG] }), ZHANG, members, 'never')).toBe(false)
    expect(shouldTriggerAgent(humanEvent({}), ZHANG, members, 'never')).toBe(false)
  })

  it('never triggers on a message another member wrote, under any policy', () => {
    // The rule that nobody can drive another member's agent holds for every policy.
    const fromLi = humanEvent({ sender: LI, memberName: '李四' })
    for (const policy of ['mention', 'always', 'never'] as const) {
      expect(shouldTriggerAgent(fromLi, ZHANG, members, policy)).toBe(false)
    }
  })

  it('never triggers on an @everyone-style mention', () => {
    const event = humanEvent({})
    const source = (event.data as Record<string, unknown>)['source'] as Record<string, unknown>
    source['mentions'] = ['all']
    expect(shouldTriggerAgent(event, ZHANG, members)).toBe(false)
  })

  it('never triggers on a mention of a non-member', () => {
    expect(shouldTriggerAgent(humanEvent({ mentions: ['user-ghost'] }), ZHANG, members)).toBe(false)
  })

  it('never triggers on an agent reply, which would echo forever', () => {
    const reply = humanEvent({ mentions: [ZHANG] })
    const source = (reply.data as Record<string, unknown>)['source'] as Record<string, unknown>
    source['authorKind'] = 'agent'
    expect(isAgentReply(reply)).toBe(true)
    expect(shouldTriggerAgent(reply, ZHANG, members)).toBe(false)
  })

  it('never runs an agent for an external author, even with a spoofed member id', () => {
    // External channels have no DataOps account. A bridge that stamped this workspace's own
    // member id on the event must still not make an external message look like a self-mention.
    const forwarded = humanEvent({ sender: ZHANG, mentions: [ZHANG] })
    const source = (forwarded.data as Record<string, unknown>)['source'] as Record<string, unknown>
    source['authorKind'] = 'external'
    source['senderExternal'] = { kind: 'wecom', senderId: 'zhangsan', senderName: '张三' }
    expect(isExternalAuthor(forwarded)).toBe(true)
    for (const policy of ['mention', 'always', 'never'] as const) {
      expect(shouldTriggerAgent(forwarded, ZHANG, members, policy)).toBe(false)
    }
  })
})

describe('speaker attribution', () => {
  it('prefers the live member name over the event snapshot', () => {
    const event = humanEvent({ sender: LI, memberName: '李四旧名' })
    expect(speakerPrefix(event, members)).toBe('李四：')
  })

  it('falls back to the event snapshot when the member has left', () => {
    const event = humanEvent({ sender: 'user-gone', memberName: '王五' })
    expect(speakerPrefix(event, members)).toBe('王五：')
  })

  it('marks an agent reply as belonging to its owner', () => {
    const reply = humanEvent({ sender: LI, memberName: '李四' })
    const source = (reply.data as Record<string, unknown>)['source'] as Record<string, unknown>
    source['authorKind'] = 'agent'
    expect(speakerPrefix(reply, members)).toBe('[李四 的 agent] ')
  })

  it('prefixes only text blocks and leaves other blocks untouched', () => {
    const event: RoomEvent = {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: '看下这个' }, { type: 'image', attachment: { id: 'x' } }],
        source: { memberId: LI },
      },
    }
    const prefixed = withSpeakerPrefix(event, '李四：')
    const content = (prefixed.data as { content: Array<Record<string, unknown>> }).content
    expect(content[0]).toEqual({ type: 'text', text: '李四：看下这个' })
    expect(content[1]).toEqual({ type: 'image', attachment: { id: 'x' } })
  })

  it('returns the event untouched when there is no prefix to add', () => {
    const event = humanEvent({})
    expect(withSpeakerPrefix(event, '')).toBe(event)
  })

  it('leaves an event without content blocks untouched', () => {
    const event: RoomEvent = { type: 'user/message', data: { source: { memberId: LI } } }
    expect(withSpeakerPrefix(event, '李四：')).toBe(event)
  })
})
