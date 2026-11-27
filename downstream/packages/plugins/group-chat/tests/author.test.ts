/**
 * The lookup that lets another author's message say who wrote it.
 *
 * A room message carries only its author's id; the name and the picture live on the roster, which
 * is a separate request. These cases pin the rule that a message is labelled only when the room
 * actually knows the author, because both ways of getting it wrong are visible to a reader: an
 * unlabelled bubble in a busy room is confusing, while a bubble labelled with an internal id
 * leaks one and attributes words to nobody.
 *
 * @module tests/author.test
 */

import { describe, expect, it } from 'vitest'
import { authorNameOf, authorOf } from '../src/client/MessageSide.tsx'
import type { RoomMember } from '../src/client/api.ts'

const ZHANG: RoomMember = {
  userId: 'user-zhang',
  displayName: '张三',
  owner: true,
  joinedAt: '2026-01-01T00:00:00.000Z',
  avatarUrl: 'https://example.test/zhang.png',
}

const LI: RoomMember = {
  userId: 'user-li',
  displayName: '李四',
  owner: false,
  joinedAt: '2026-01-01T00:00:00.000Z',
}

const messageFrom = (memberId: string | undefined) => ({
  source: { roomId: 'room-1', memberId, authorKind: 'human' },
})

describe('消息作者查找', () => {
  it('按 memberId 找到名册里的作者', () => {
    expect(authorOf(messageFrom('user-li'), [ZHANG, LI])).toBe(LI)
  })

  it('名册里有头像时一并带出，交给 Avatar 渲染', () => {
    expect(authorOf(messageFrom('user-zhang'), [ZHANG, LI])?.avatarUrl)
      .toBe('https://example.test/zhang.png')
  })

  it('名册还没读到时返回 undefined，而不是猜一个作者', () => {
    // 这是加载时序的真实状态：消息先到，名册后到。此时宁可气泡无名，也不能标错人。
    expect(authorOf(messageFrom('user-li'), undefined)).toBeUndefined()
  })

  it('作者已退群时返回 undefined', () => {
    expect(authorOf(messageFrom('user-gone'), [ZHANG, LI])).toBeUndefined()
  })

  it('消息没有 memberId 时不匹配任何人', () => {
    expect(authorOf(messageFrom(undefined), [ZHANG, LI])).toBeUndefined()
  })

  it('不是房间消息时返回 undefined', () => {
    expect(authorOf({ source: { roomId: 'room-1' } }, [ZHANG])).toBeUndefined()
    expect(authorOf(undefined, [ZHANG])).toBeUndefined()
  })
})

describe('作者昵称', () => {
  it('用名册里的显示名', () => {
    expect(authorNameOf(ZHANG)).toBe('张三')
  })

  it('显示名为空白时视为没有名字', () => {
    // 空白名会渲染成一个空标签，看起来像渲染坏了；宁可不出名字。
    expect(authorNameOf({ ...ZHANG, displayName: '   ' })).toBeUndefined()
  })

  it('作者未知时没有名字，也不会退回成 id', () => {
    // 退回 id 会把内部标识泄露到对话里，而且 u_7f3a91 这样的标签对读者毫无意义。
    expect(authorNameOf(undefined)).toBeUndefined()
  })
})
