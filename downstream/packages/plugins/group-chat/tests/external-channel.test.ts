/**
 * A room bridged to an external system.
 *
 * The bridge owns the transport; this plugin owns the shape. These cases pin that a room without a
 * channel is untouched, that a well-formed channel passes through creation for every platform the
 * plugin renders, and that an external message is recognised as foreign instead of being attributed
 * to the workspace.
 *
 * @module tests/external-channel.test
 */

import { describe, expect, it } from 'vitest'
import { externalSenderOf } from '../src/client/MessageSide.tsx'
import type { ExternalChannel } from '../src/backend.ts'

const CHANNEL: ExternalChannel = { kind: 'qqbot', externalGroupId: 'GROUP-OPENID-1', groupOpenid: 'GROUP-OPENID-1' }

describe('the external channel a room carries', () => {
  it('lets a room declare a QQ bridge', () => {
    // The type is the contract the backend stores verbatim; there is nothing to normalise here.
    expect(CHANNEL.externalGroupId).toBe('GROUP-OPENID-1')
    expect(CHANNEL.groupOpenid).toBe('GROUP-OPENID-1')
    expect(CHANNEL.kind).toBe('qqbot')
  })

  it('lets a room declare a WeCom or DingTalk bridge', () => {
    const wecom: ExternalChannel = {
      kind: 'wecom',
      externalGroupId: 'wrOgAAA',
      chatId: 'wrOgAAA',
      botId: 'aibvjjOfsZ2ZhoPhP4BNb_QIBphdsZ0h2hz',
    }
    const dingtalk: ExternalChannel = { kind: 'dingtalk', externalGroupId: 'cid-1', botId: 'ding-app-key' }
    expect(wecom.kind).toBe('wecom')
    expect(dingtalk.kind).toBe('dingtalk')
  })

  it('reads the sender the bridge stamped on a message', () => {
    const message = {
      source: { roomId: 'room-1', senderExternal: { kind: 'qqbot', openid: 'OPENID-1', nickname: ' 张三 ' } },
    }
    expect(externalSenderOf(message)).toEqual({ kind: 'qqbot', senderId: 'OPENID-1', senderName: '张三' })
  })

  it('reads the canonical sender fields a WeCom bridge writes', () => {
    const message = {
      source: {
        roomId: 'room-1',
        senderExternal: {
          kind: 'wecom',
          senderId: 'zhangsan',
          senderName: ' 张三 ',
          botId: 'aibvjjOfsZ2ZhoPhP4BNb_QIBphdsZ0h2hz',
          receivedAt: '2026-11-18T12:00:00.000Z',
        },
      },
    }
    expect(externalSenderOf(message)).toEqual({ kind: 'wecom', senderId: 'zhangsan', senderName: '张三' })
  })

  it('reads a DingTalk sender', () => {
    const message = {
      source: { roomId: 'room-1', senderExternal: { kind: 'dingtalk', senderId: 'staff-1', senderName: '李四' } },
    }
    expect(externalSenderOf(message)).toEqual({ kind: 'dingtalk', senderId: 'staff-1', senderName: '李四' })
  })

  it('leaves a native room message alone', () => {
    // No `senderExternal` means an ordinary member message: the wrapper draws the roster author.
    expect(externalSenderOf({ source: { roomId: 'room-1', memberId: 'u-1' } })).toBeUndefined()
    expect(externalSenderOf(undefined)).toBeUndefined()
  })

  it('ignores a malformed sender rather than guessing at one', () => {
    // A wrong badge would attribute somebody else's words to the workspace, so an unreadable value
    // is dropped and the message renders as an unlabelled room message.
    expect(externalSenderOf({ source: { roomId: 'room-1', senderExternal: { kind: 'qqbot', openid: '' } } })).toBeUndefined()
    expect(externalSenderOf({ source: { roomId: 'room-1', senderExternal: { kind: 'slack', openid: 'a', nickname: 'b' } } })).toBeUndefined()
    expect(externalSenderOf({ source: { roomId: 'room-1', senderExternal: 'nope' } })).toBeUndefined()
    // The id and the display name are both required: either one alone cannot draw an author.
    expect(externalSenderOf({ source: { roomId: 'room-1', senderExternal: { kind: 'wecom', senderId: 'x' } } })).toBeUndefined()
    expect(externalSenderOf({ source: { roomId: 'room-1', senderExternal: { kind: 'wecom', senderName: 'x' } } })).toBeUndefined()
  })
})

describe('the update route', () => {
  it('forwards a well-formed QQ channel and drops a malformed one', async () => {
    const { externalChannelOfForTest } = await import('../src/index.ts')
    expect(externalChannelOfForTest({ externalChannel: { kind: 'qqbot', groupOpenid: 'G-1' } }))
      .toEqual({ kind: 'qqbot', externalGroupId: 'G-1', groupOpenid: 'G-1' })
    expect(externalChannelOfForTest({ externalChannel: { kind: 'qqbot', groupOpenid: '  ' } })).toBeUndefined()
    expect(externalChannelOfForTest({})).toBeUndefined()
  })

  it('normalises a WeCom channel onto externalGroupId', async () => {
    const { externalChannelOfForTest } = await import('../src/index.ts')
    expect(externalChannelOfForTest({
      externalChannel: {
        kind: 'wecom',
        externalGroupId: ' wrOgAAA ',
        chatId: 'wrOgAAA',
        botId: ' aib1 ',
      },
    })).toEqual({ kind: 'wecom', externalGroupId: 'wrOgAAA', chatId: 'wrOgAAA', botId: 'aib1' })
    // `chatId` alone is enough: some platforms name the group only that way.
    expect(externalChannelOfForTest({ externalChannel: { kind: 'dingtalk', chatId: 'cid-1' } }))
      .toEqual({ kind: 'dingtalk', externalGroupId: 'cid-1', chatId: 'cid-1' })
    expect(externalChannelOfForTest({ externalChannel: { kind: 'wecom' } })).toBeUndefined()
    expect(externalChannelOfForTest({ externalChannel: { kind: 'slack', externalGroupId: 'x' } })).toBeUndefined()
  })
})