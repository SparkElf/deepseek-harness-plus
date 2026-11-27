/**
 * The credential observation that the sign-in prompt reads.
 *
 * The point of this module is that a 401 stops being silent: the calls that see one still return
 * their empty result, but the reason is recorded where the interface can find it. These cases pin
 * that contract, including the two easy ways to get it wrong — treating a transient read failure
 * as an outage, and treating a 403 as an ended session. Both would raise a prompt that tells the
 * operator to sign in when signing in is not what is needed.
 *
 * @module tests/auth-state.test
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { currentAuthState, noteAccepted, noteExpired, resetAuthState } from '../src/auth-state.ts'

describe('DataOps 凭证观测', () => {
  beforeEach(() => {
    resetAuthState()
  })

  it('在有任何调用之前是 unknown，而不是 expired', () => {
    // 未知不能当作过期：那会在工作区刚启动、还没请求过 DataOps 时弹出登录提示。
    expect(currentAuthState()).toBe('unknown')
  })

  it('401 记为 expired', () => {
    noteExpired()
    expect(currentAuthState()).toBe('expired')
  })

  it('被接受的调用记为 valid', () => {
    noteAccepted()
    expect(currentAuthState()).toBe('valid')
  })

  it('重新登录成功后能从 expired 恢复', () => {
    // 这是闭环的关键：提示出现后用户登录，下一次调用必须把状态拨回去，否则提示永不消失。
    noteExpired()
    expect(currentAuthState()).toBe('expired')
    noteAccepted()
    expect(currentAuthState()).toBe('valid')
  })

  it('只记录最后一次观测', () => {
    noteExpired()
    noteAccepted()
    noteExpired()
    expect(currentAuthState()).toBe('expired')
  })
})
