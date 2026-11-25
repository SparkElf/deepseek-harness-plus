import { describe, expect, it } from 'vitest'
import { isLocalUserMessage, isRuntimeInjectedData } from '../src/index.ts'

/**
 * 成员说的话要广播到房间，运行时自己的簿记不能广播。
 *
 * 两条判据合起来决定一条 `user/message` 是否发布：
 *  - 不是从房间轮询进来的（否则每条都发两遍）；
 *  - 不是运行时注入的（否则群成员会看到工作区指令、技能清单、状态快照）。
 *
 * 第二个判据是实测出来的：第一版只做了第一个，房间历史里随即出现了
 * `<system-reminder>` 和 `Current runtime context` 这类文本。
 */
describe('isLocalUserMessage', () => {
  it('发布成员自己发的话', () => {
    expect(isLocalUserMessage({ id: 'm1', content: [{ type: 'text', text: '你好' }] })).toBe(true)
  })

  it('发布带图片的消息', () => {
    expect(isLocalUserMessage({
      id: 'm2',
      content: [
        { type: 'text', text: '这张图是什么' },
        { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      ],
    })).toBe(true)
  })

  it('不发布从房间轮询进来的消息', () => {
    // 轮询进来的一条已经带 source.roomId，再发一次就是重复。
    expect(isLocalUserMessage({
      id: 'm3',
      content: [{ type: 'text', text: '别人说的话' }],
      source: { roomId: 'room-1' },
    })).toBe(false)
  })

  it('空内容不算消息', () => {
    expect(isLocalUserMessage({ content: [] })).toBe(false)
    expect(isLocalUserMessage({})).toBe(false)
    expect(isLocalUserMessage(null)).toBe(false)
  })
})

describe('isRuntimeInjectedData', () => {
  it('识别 system-reminder', () => {
    expect(isRuntimeInjectedData({
      content: [{ type: 'text', text: '<system-reminder>\n技能目录已更新\n</system-reminder>' }],
    })).toBe(true)
  })

  it('识别运行时上下文快照', () => {
    expect(isRuntimeInjectedData({
      content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes…' }],
    })).toBe(true)
  })

  it('识别时间采样行', () => {
    expect(isRuntimeInjectedData({
      content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: …' }],
    })).toBe(true)
  })

  it('成员自己打的字不会被误判', () => {
    expect(isRuntimeInjectedData({
      content: [{ type: 'text', text: '帮我看看营收数据' }],
    })).toBe(false)
  })

  it('只有图片的消息不是注入的', () => {
    expect(isRuntimeInjectedData({
      content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }],
    })).toBe(false)
  })
})
