/**
 * The rule that decides which discovered rooms are offered as joinable.
 *
 * This guarded a real defect: the discovery read and the sidebar's own list arrive from two
 * separate requests, so the same room can be in both for a moment. Offering a Join button on a
 * room the account is already in is not a cosmetic duplicate — the button can only fail or
 * silently do nothing, and either way it reads as a broken feature rather than a stale list.
 *
 * @module tests/discover.test
 */

import { describe, expect, it } from 'vitest'
import { joinableRooms } from '../src/client/rows.ts'
import type { RoomSummary } from '../src/client/api.ts'

const room = (id: string, joined: boolean): RoomSummary => ({
  id,
  name: id,
  ownerUserId: 'owner',
  invitePolicy: 'anyone',
  discoverability: 'discoverable',
  agentTrigger: 'mention',
  cwd: null,
  agentPreset: null,
  memberCount: 3,
  joined,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

describe('可加入房间过滤', () => {
  it('只保留未加入的房间', () => {
    const rows = joinableRooms([room('a', false), room('b', true)], new Set())
    expect(rows.map((r) => r.id)).toEqual(['a'])
  })

  it('已在侧栏列表里的房间不再作为可加入项出现', () => {
    // 服务端说 joined=false，但侧栏已经列出了它 —— 这正是两个请求不同步的那一瞬。
    const rows = joinableRooms([room('a', false), room('b', false)], new Set(['b']))
    expect(rows.map((r) => r.id)).toEqual(['a'])
  })

  it('两者同时命中时也不会重复', () => {
    const rows = joinableRooms([room('a', true)], new Set(['a']))
    expect(rows).toEqual([])
  })

  it('没有可加入的房间时返回空列表而不是 undefined', () => {
    // 调用方用空数组表示「搜过了，没有可加入的」，用 undefined 表示「还没搜」。
    expect(joinableRooms([], new Set())).toEqual([])
  })

  it('保持服务端返回的顺序', () => {
    const rows = joinableRooms([room('z', false), room('a', false)], new Set())
    expect(rows.map((r) => r.id)).toEqual(['z', 'a'])
  })
})
