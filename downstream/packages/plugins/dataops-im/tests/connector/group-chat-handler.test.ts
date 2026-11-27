import { describe, expect, it } from 'vitest'
import { createGroupChatHandler, groupChatFrameStatus } from '../../src/connector/group-chat.ts'

interface GroupEvent {
  readonly content: string
  readonly streamId: string
  readonly finish: boolean
}

/** 记录群流式事件；`sendMessage` 走独立数组，便于区分流式更新和最终普通消息。 */
function createClient(options: { failStream?: boolean } = {}): {
  groupStreams: GroupEvent[]
  groupMessages: string[]
  directMessages: string[]
  client: {
    replyStream(frame: unknown, streamId: string, content: string, finish: boolean): Promise<unknown>
    sendMessage(chatId: string, content: unknown): Promise<unknown>
  }
} {
  const groupStreams: GroupEvent[] = []
  const groupMessages: string[] = []
  const directMessages: string[] = []
  return {
    groupStreams,
    groupMessages,
    directMessages,
    client: {
      replyStream: async (_frame, streamId, content, finish) => {
        if (options.failStream === true) throw new Error('stream unavailable')
        groupStreams.push({ streamId, content, finish })
        return {}
      },
      sendMessage: async (chatId, content) => {
        const text = (content as { markdown?: { content?: string } })?.markdown?.content ?? String(content)
        if (chatId === 'chat-1') groupMessages.push(text)
        else directMessages.push(`${chatId}:${text}`)
        return {}
      },
    },
  }
}

function frame(messageId: string): unknown {
  return {
    body: {
      chattype: 'group',
      chatid: 'chat-1',
      msgid: messageId,
      msgtype: 'text',
      from: { userid: 'user-1', name: '张三' },
      text: { content: '@万相专家 总结本周的会议纪要' },
    },
  }
}

function state(): {
  hasSeen: () => boolean
  markSeen: () => Promise<void>
  sessionFor: () => null
  setSession: () => Promise<void>
} {
  return {
    hasSeen: () => false,
    markSeen: async () => undefined,
    sessionFor: () => null,
    setSession: async () => undefined,
  }
}

describe('createGroupChatHandler', () => {
  it('shows a progress card, then finishes the same stream with room_safe text', async () => {
    const recorder = createClient()
    const handler = createGroupChatHandler({
      client: recorder.client,
      state: state(),
      router: {
        process: async (_message, hooks) => {
          hooks?.onProgress?.('正在执行…')
          return { deduplicated: false, audience: 'room_safe', text: '本周会议纪要总结' }
        },
      },
      logger: { warn: () => undefined },
    })
    await handler.handle(frame('msg-1'))
    expect(recorder.groupStreams.map(event => event.content)).toEqual([
      '已收到，正在处理…',
      '正在执行…',
      '本周会议纪要总结',
    ])
    expect(recorder.groupStreams.every(event => event.streamId === recorder.groupStreams[0]!.streamId)).toBe(true)
    expect(recorder.groupStreams.map(event => event.finish)).toEqual([false, false, true])
    expect(recorder.directMessages).toEqual([])
    expect(groupChatFrameStatus().at(-1)?.textChars).toBe(9)
  })

  it('keeps sender_only private and only finishes the group card with the ack', async () => {
    const recorder = createClient()
    const handler = createGroupChatHandler({
      client: recorder.client,
      state: state(),
      router: {
        process: async () => ({ deduplicated: false, audience: 'sender_only', text: '明细', ack: '结果涉及个人数据，已私聊发送' }),
      },
      logger: { warn: () => undefined },
    })
    await handler.handle(frame('msg-2'))
    expect(recorder.groupStreams.at(-1)).toMatchObject({ content: '结果涉及个人数据，已私聊发送', finish: true })
    expect(recorder.groupMessages).toEqual([])
    expect(recorder.directMessages).toEqual(['user-1:明细'])
  })

  it('falls back to start + at most 3 phase messages + final when the stream is unavailable', async () => {
    const recorder = createClient({ failStream: true })
    const handler = createGroupChatHandler({
      client: recorder.client,
      state: state(),
      router: {
        process: async (_message, hooks) => {
          for (const phase of ['正在查询数据资源', '正在执行 SQL', '正在检索知识库', '正在处理文档', '正在调用 tool']) {
            hooks?.onProgress?.(phase)
          }
          return { deduplicated: false, audience: 'room_safe', text: '最终回答' }
        },
      },
      logger: { warn: () => undefined },
    })
    await handler.handle(frame('msg-fallback'))
    expect(recorder.groupStreams).toEqual([])
    expect(recorder.groupMessages).toEqual([
      '已收到，正在处理…',
      '正在查询数据资源',
      '正在执行 SQL',
      '正在检索知识库',
      '最终回答',
    ])
  })

  it('falls back to one plain group message when the stream is unavailable', async () => {
    const recorder = createClient({ failStream: true })
    const handler = createGroupChatHandler({
      client: recorder.client,
      state: state(),
      router: {
        process: async () => ({ deduplicated: false, audience: 'room_safe', text: '最终回答' }),
      },
      logger: { warn: () => undefined },
    })
    await handler.handle(frame('msg-3'))
    expect(recorder.groupStreams).toEqual([])
    expect(recorder.groupMessages).toEqual(['已收到，正在处理…', '最终回答'])
  })
})