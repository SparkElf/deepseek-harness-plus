import { describe, expect, it } from 'vitest'
import {
  createDirectChatHandler,
  type DirectChatDeps,
  type PrivateChatRouter,
} from '../../src/connector/private-chat.ts'
import type { RenderedReply } from '../../src/connector/render-policy.ts'
import type { PrivateChatHeartbeat } from '../../src/connector/private-chat.ts'

interface StreamEvent {
  readonly streamId: string
  readonly content: string
  readonly finish: boolean
  readonly msgItem?: unknown[]
}

function frame(messageId = 'msg-1'): unknown {
  return {
    body: {
      chattype: 'single',
      msgid: messageId,
      msgtype: 'text',
      from: { userid: 'user-1', name: '张三' },
      text: { content: '看一下本周概览' },
    },
  }
}

function createClient(options: { failInline?: boolean; failUpload?: boolean } = {}): {
  client: DirectChatDeps['client']
  streams: StreamEvent[]
  messages: string[]
  uploads: number[]
  media: { chatId: string; mediaType: string; mediaId: string }[]
} {
  const streams: StreamEvent[] = []
  const messages: string[] = []
  const uploads: number[] = []
  const media: { chatId: string; mediaType: string; mediaId: string }[] = []
  return {
    streams,
    messages,
    uploads,
    media,
    client: {
      replyStream: async (_frame, streamId, content, finish, msgItem) => {
        if (options.failInline === true && finish && msgItem !== undefined) throw new Error('stream expired')
        streams.push({ streamId, content, finish, ...(msgItem === undefined ? {} : { msgItem }) })
        return {}
      },
      sendMessage: async (_chatId, content) => {
        messages.push((content as { markdown?: { content?: string } })?.markdown?.content ?? String(content))
        return {}
      },
      uploadMedia: async (bytes) => {
        uploads.push(bytes.byteLength)
        if (options.failUpload === true) throw new Error('upload failed')
        return { media_id: 'media-1' }
      },
      sendMediaMessage: async (chatId, mediaType, mediaId) => {
        media.push({ chatId, mediaType, mediaId })
        return {}
      },
    },
  }
}

function handler(
  options: {
    answer: string
    rendered?: RenderedReply
    preview?: string
    heartbeat?: PrivateChatHeartbeat
    clientOptions?: { failInline?: boolean; failUpload?: boolean }
  },
): {
  handler: ReturnType<typeof createDirectChatHandler>
  client: DirectChatDeps['client']
  streams: StreamEvent[]
  messages: string[]
  uploads: number[]
  media: { chatId: string; mediaType: string; mediaId: string }[]
} {
  const fake = createClient(options.clientOptions)
  const deps: DirectChatDeps = {
    client: fake.client,
    state: { hasSeen: () => false, markSeen: async () => undefined },
    router: {
      ask: async (input) => {
        if (options.preview !== undefined) input.onUpdate?.(options.preview)
        if (options.heartbeat !== undefined) input.onHeartbeat?.(options.heartbeat)
        return options.answer
      },
    } as unknown as PrivateChatRouter,
    logger: { warn: () => undefined, info: () => undefined },
    ...(options.rendered === undefined
      ? {}
      : {
          renderReply: async () => options.rendered as RenderedReply,
        }),
  }
  return {
    handler: createDirectChatHandler(deps),
    client: fake.client,
    streams: fake.streams,
    messages: fake.messages,
    uploads: fake.uploads,
    media: fake.media,
  }
}

const calloutAnswer = [
  '先看结论。',
  '',
  '```dsh-ui',
  JSON.stringify({
    title: '本周概览',
    items: [{ type: 'callout', tone: 'info', title: '结论', content: '整体运行正常。' }],
  }),
  '```',
].join('\n')

describe('private chat GenUI delivery', () => {
  it('文本 GenUI 不把原始 JSON 发到企微', async () => {
    const run = handler({ answer: calloutAnswer })
    await run.handler.handle(frame())
    const delivered = [...run.streams.map(event => event.content), ...run.messages].join('\n')
    expect(delivered).toContain('先看结论')
    expect(delivered).toContain('整体运行正常')
    expect(delivered).not.toContain('```')
    expect(delivered).not.toContain('"type"')
    expect(delivered).not.toContain('dsh-ui')
  })

  it('图片统一走 uploadMedia + sendMediaMessage，最终帧不内联', async () => {
    const rendered: RenderedReply = {
      audience: 'sender_only',
      hadGenUI: true,
      segments: [
        { kind: 'text', text: '正文摘要' },
        { kind: 'image', png: new Uint8Array([1, 2, 3]), alt: '趋势图' },
      ],
    }
    const run = handler({ answer: 'ignored', rendered })
    await run.handler.handle(frame())
    const finals = run.streams.filter(event => event.finish)
    expect(finals).toHaveLength(1)
    expect(finals[0]!.content).toBe('正文摘要')
    expect(finals[0]!.msgItem).toBeUndefined()
    expect(run.uploads).toEqual([3])
    expect(run.media).toEqual([{ chatId: 'user-1', mediaType: 'image', mediaId: 'media-1' }])
  })

  it('纯图片回复先发“结果如下：”再主动发图', async () => {
    const rendered: RenderedReply = {
      audience: 'sender_only',
      hadGenUI: true,
      segments: [{ kind: 'image', png: new Uint8Array([1, 2, 3]), alt: '趋势图' }],
    }
    const run = handler({ answer: 'ignored', rendered })
    await run.handler.handle(frame())
    const finals = run.streams.filter(event => event.finish)
    expect(finals).toHaveLength(1)
    expect(finals[0]!.content).toBe('结果如下：')
    expect(finals[0]!.msgItem).toBeUndefined()
    expect(run.uploads).toEqual([3])
    expect(run.media).toEqual([{ chatId: 'user-1', mediaType: 'image', mediaId: 'media-1' }])
    const delivered = run.messages.join('\n')
    expect(delivered).not.toContain('没有返回文本')
  })

  it('上传失败退回图片 alt 文本，正文不丢', async () => {
    const rendered: RenderedReply = {
      audience: 'sender_only',
      hadGenUI: true,
      segments: [
        { kind: 'text', text: '正文摘要' },
        { kind: 'image', png: new Uint8Array([1, 2, 3]), alt: '趋势图' },
      ],
    }
    const run = handler({ answer: 'ignored', rendered, clientOptions: { failUpload: true } })
    await run.handler.handle(frame())
    const delivered = [...run.streams.map(event => event.content), ...run.messages].join('\n')
    expect(delivered).toContain('正文摘要')
    expect(delivered).toContain('【图片发送失败】趋势图')
  })

  it('渲染器整体抛错时保留删围栏后的正文', async () => {
    const run = handler({ answer: calloutAnswer })
    // 覆盖默认 renderReply：模拟渲染管线整体崩溃。
    const deps: DirectChatDeps = {
      client: run.client,
      state: { hasSeen: () => false, markSeen: async () => undefined },
      router: { ask: async () => calloutAnswer } as unknown as PrivateChatRouter,
      logger: { warn: () => undefined, info: () => undefined },
      renderReply: async () => {
        throw new Error('render boom')
      },
    }
    const own = createDirectChatHandler(deps)
    await own.handle(frame('msg-boom'))
    const delivered = [...run.streams.map(event => event.content), ...run.messages].join('\n')
    expect(delivered).toContain('先看结论')
    expect(delivered).not.toContain('```')
    expect(delivered).not.toContain('"type"')
    expect(delivered).not.toContain('处理失败')
  })

  it('工具切换时更新进度文案，且不含参数/工具名', async () => {
    const run = handler({
      answer: '最终回复',
      rendered: {
        audience: 'sender_only',
        hadGenUI: false,
        segments: [{ kind: 'text', text: '最终回复' }],
      },
      heartbeat: { elapsedMs: 6_000, polls: 4, sawTool: true, toolName: 'mcp__dataops__query_table' },
    })
    await run.handler.handle(frame())
    const progress = run.streams.filter(event => !event.finish).map(event => event.content)
    const delivered = progress.join('\n')
    expect(delivered).toContain('正在执行数据查询')
    expect(delivered).not.toContain('query_table')
    expect(delivered).not.toContain('mcp__')
    expect(delivered).not.toContain('select')
  })

  it('assistant 预览出现后，迟到的 heartbeat 不得覆盖内容', async () => {
    const run = handler({
      answer: '最终回复',
      preview: '最终内容',
      rendered: {
        audience: 'sender_only',
        hadGenUI: false,
        segments: [{ kind: 'text', text: '最终回复' }],
      },
      heartbeat: { elapsedMs: 8_000, polls: 5, sawTool: false },
    })
    await run.handler.handle(frame())
    const progress = run.streams.filter(event => !event.finish).map(event => event.content)
    expect(progress.at(-1)).toBe('最终内容')
    expect(progress.join('\n')).not.toMatch(/（已 \d+s）/)
    expect(run.streams.filter(event => event.finish)).toHaveLength(1)
  })

  it('流式预览不出现半截 dsh-ui JSON', async () => {
    const run = handler({
      answer: '最终回复',
      preview: '处理中\n```dsh-ui\n{"items":[{"type":"text"',
    })
    await run.handler.handle(frame())
    const previews = run.streams.filter(event => !event.finish).map(event => event.content)
    expect(previews.join('\n')).not.toContain('dsh-ui')
    expect(previews.join('\n')).not.toContain('"items"')
  })
})