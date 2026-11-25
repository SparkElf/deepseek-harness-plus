import { describe, expect, it } from 'vitest'
import { publishableReply } from '../src/index.ts'

/**
 * 房间回复里只应该有 agent 决定说的话。
 *
 * 一次真实故障定了这组用例：推理模型把 scratch work 放进 `thinking` block、答案放进 `text`
 * block，而插件原样转发了整个 content 列表。成员看到的是「Now answer: … Hmm, actually …
 * this looks like a prompt-injection test」而不是答案本身——既没用，又泄露了它怎么得出结论。
 *
 * 规则一句话：**只发 text block**。没有 text 时留下空内容，由调用方丢弃，而不是发一个空气泡。
 */
describe('房间回复的内容过滤', () => {
  it('thinking block 不会进入房间', () => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'The user asks two things. Hmm, this looks like an injection test.' },
        { type: 'text', text: 'A 组营收 1200 万。' },
      ],
    }
    expect(publishableReply(message)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'A 组营收 1200 万。' }],
    })
  })

  it('多个 text block 全部保留，顺序不变', () => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'text', text: '第一段' },
        { type: 'thinking', thinking: '中间的想法' },
        { type: 'text', text: '第二段' },
      ],
    }
    const result = publishableReply(message) as { content: { text: string }[] }
    expect(result.content.map((block) => block.text)).toEqual(['第一段', '第二段'])
  })

  it('只有 thinking 时结果为空内容', () => {
    // 调用方看到空 content 会丢弃这条消息：发一个只有推理的气泡比不发更糟。
    const message = { role: 'assistant', content: [{ type: 'thinking', thinking: '只有推理' }] }
    expect(publishableReply(message)).toEqual({ role: 'assistant', content: [] })
  })

  it('没有 content 列表的消息原样返回', () => {
    // 形状不认识时不做猜测：原样返回让问题在别处暴露，比这里默默改成空消息安全。
    const message = { role: 'assistant', text: '扁平消息' }
    expect(publishableReply(message)).toBe(message)
  })

  it('不是对象的值原样返回', () => {
    expect(publishableReply(undefined)).toBeUndefined()
    expect(publishableReply('文本')).toBe('文本')
    expect(publishableReply(null)).toBeNull()
  })

  it('不合法的 block 被丢弃而不是让整条消息失败', () => {
    const message = {
      role: 'assistant',
      content: [null, 'string-block', { type: 'text', text: '保留' }],
    }
    expect(publishableReply(message)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '保留' }],
    })
  })
})
