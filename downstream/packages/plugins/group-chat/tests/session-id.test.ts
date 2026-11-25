import { describe, expect, it } from 'vitest'
import {
  ROOM_SESSION_PREFIX,
  roomIdOfSession,
  roomIdOfSessionId,
  roomSessionId,
} from '../src/session-id.ts'

/**
 * 房间与会话的绑定。
 *
 * 两个入口必须都认：composer 的 seat 交给组件的是**裸 session id 字符串**，而 session 事件
 * 交给宿主的是会话对象。早先只实现了对象版，字符串传进去第一行就返回 `undefined`
 * ——座位注册成功了，但引用条永远画不出来，而且没有任何报错。
 */
describe('session id 的两种形态', () => {
  it('对象形态按 id 解析', () => {
    expect(roomIdOfSession({ id: 'group-room-abc' })).toBe('abc')
  })

  it('字符串形态也能解析', () => {
    expect(roomIdOfSessionId('group-room-abc')).toBe('abc')
  })

  it('普通会话两种形态都返回 undefined', () => {
    expect(roomIdOfSession({ id: 'session-1' })).toBe(undefined)
    expect(roomIdOfSessionId('session-1')).toBe(undefined)
  })

  it('空房间号返回 undefined', () => {
    expect(roomIdOfSessionId('group-room-')).toBe(undefined)
    expect(roomIdOfSession({ id: 'group-room-' })).toBe(undefined)
  })

  it('非字符串/非对象输入不抛错', () => {
    expect(roomIdOfSession(undefined)).toBe(undefined)
    expect(roomIdOfSession('group-room-abc')).toBe(undefined)
  })
})

describe('构造与解析互逆', () => {
  it('roomSessionId 的结果能被两个解析入口读回', () => {
    const roomId = 'e5974ae7-35a2-4e35-a50b-007eda8d528f'
    const sessionId = roomSessionId(roomId)
    expect(sessionId.startsWith(ROOM_SESSION_PREFIX)).toBe(true)
    expect(roomIdOfSessionId(sessionId)).toBe(roomId)
    expect(roomIdOfSession({ id: sessionId })).toBe(roomId)
  })
})