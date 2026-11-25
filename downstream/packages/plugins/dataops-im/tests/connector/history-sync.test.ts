import { describe, expect, it } from 'vitest'
import {
  assignSameSecondOrdinals,
  buildHistoryPrompt,
  formatWecomTime,
  historyDedupKey,
  historyMessageId,
  historyTextHash,
  normalizeCliMessage,
  normalizeHistoryText,
  parseCliJson,
  readCliGroups,
  readCliMessages,
  type StoredHistoryMessage,
} from '../../src/connector/history-sync.ts'
import { decideAudience, refreshGroupHistory } from '../../src/connector/group-chat.ts'

function stored(overrides: Partial<StoredHistoryMessage> = {}): StoredHistoryMessage {
  const base = {
    chatId: 'chat-1',
    sendTime: '2026-11-19 10:00:00',
    sendTimeMs: Date.parse('2026-11-19T10:00:00+08:00'),
    userId: 'user-1',
    userName: '张三',
    msgType: 'text',
    text: '你好',
    textHash: historyTextHash('你好'),
    sameSecondOrdinal: 0,
    source: 'cli' as const,
    ...overrides,
  }
  return {
    ...base,
    dedupKey: historyDedupKey({
      chatId: base.chatId, sendTime: base.sendTime, userId: base.userId,
      msgType: base.msgType, textHash: base.textHash, sameSecondOrdinal: base.sameSecondOrdinal,
    }),
  }
}

describe('normalizeHistoryText', () => {
  it('strips one leading @mention and trims', () => {
    expect(normalizeHistoryText('  @万相专家 请看会议纪要  ')).toBe('请看会议纪要')
  })

  it('keeps @mentions that are not at the start', () => {
    expect(normalizeHistoryText('请看 @张三 的纪要')).toBe('请看 @张三 的纪要')
  })

  it('strips a known bot mention even without a space, without eating the question', () => {
    expect(normalizeHistoryText('@万相专家你好，请总结会议纪要')).toBe('你好，请总结会议纪要')
    expect(normalizeHistoryText('@万相专家 你好')).toBe('你好')
  })
})

describe('assignSameSecondOrdinals', () => {
  it('numbers duplicate tuples in batch order and builds a stable dedup key', () => {
    const base = {
      chatId: 'chat-1',
      sendTime: '2026-11-19 10:00:00',
      sendTimeMs: Date.parse('2026-11-19T10:00:00+08:00'),
      userId: 'user-1',
      msgType: 'text',
      text: '收到',
      textHash: historyTextHash('收到'),
    }
    const first = assignSameSecondOrdinals([base])
    const second = assignSameSecondOrdinals([base, base])
    expect(first[0]!.sameSecondOrdinal).toBe(0)
    expect(second.map(item => item.sameSecondOrdinal)).toEqual([0, 1])
    expect(second[0]!.dedupKey).toBe(first[0]!.dedupKey)
    expect(second[1]!.dedupKey).not.toBe(second[0]!.dedupKey)
    expect(second[0]!.messageId).toBe(historyMessageId(second[0]!.dedupKey))
  })
})

describe('normalizeCliMessage', () => {
  it('reads text and parses the fixed +08:00 send_time', () => {
    const message = normalizeCliMessage('chat-1', {
      userid: 'u1', user_name: '张三', send_time: '2026-11-19 10:00:00', msg_type: 'text',
      text: { content: '@万相专家 帮我总结' },
    })
    expect(message?.text).toBe('帮我总结')
    expect(message?.sendTimeMs).toBe(Date.parse('2026-11-19T10:00:00+08:00'))
  })

  it('keeps mixed text fragments and hashes media-only messages by media id', () => {
    const mixed = normalizeCliMessage('chat-1', {
      userid: 'u1', send_time: '2026-11-19 10:00:00', msg_type: 'mixed',
      mixed: { items: [{ msg_type: 'text', text: { content: '见附件' } }, { msg_type: 'image', image: { media_id: 'm1' } }] },
    })
    expect(mixed?.text).toBe('见附件')
    const image = normalizeCliMessage('chat-1', {
      userid: 'u1', send_time: '2026-11-19 10:00:00', msg_type: 'image', image: { media_id: 'm1' },
    })
    expect(image?.text).toBe('')
    expect(image?.textHash).toBe(historyTextHash('image:m1'))
  })

  it('drops rows without id/time/type or a parseable time', () => {
    expect(normalizeCliMessage('chat-1', { msg_type: 'text', send_time: '2026-11-19 10:00:00' })).toBeUndefined()
    expect(normalizeCliMessage('chat-1', { userid: 'u1', msg_type: 'text', send_time: 'not-a-time' })).toBeUndefined()
  })
})

describe('CLI response readers', () => {
  it('keeps only messages and pagination, dropping security_notice/extra_identity_context', () => {
    const parsed = readCliMessages({
      messages: [{ userid: 'u1', send_time: '2026-11-19 10:00:00', msg_type: 'text', text: { content: 'hi' } }],
      messages_count: 1,
      has_more: true,
      next_cursor: 'c1',
      security_notice: { hint: 'do not leak' },
      extra_identity_context: { bot: 'secret-ish' },
    })
    expect(parsed.messages).toHaveLength(1)
    expect(parsed.nextCursor).toBe('c1')
    expect(parsed).not.toHaveProperty('security_notice')
    expect(parsed).not.toHaveProperty('extra_identity_context')
  })

  it('keeps chat_id/chat_name and ignores other top-level fields', () => {
    const parsed = readCliGroups({
      chats: [{ chat_id: 'chat-1', chat_name: '项目群', last_msg_time: '2026-11-19 10:00:00', msg_count: 3 }],
      chats_count: 1,
      security_notice: 'x',
    })
    expect(parsed.chats).toEqual([{ chatId: 'chat-1', chatName: '项目群', lastMsgTime: '2026-11-19 10:00:00', msgCount: 3 }])
  })
})

describe('parseCliJson', () => {
  it('accepts pure JSON, a warning-prefixed object, and the last object in a mixed stream', () => {
    expect(parseCliJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseCliJson('warning: something\n{"a":1}')).toEqual({ a: 1 })
    expect(parseCliJson('noise {"a":1} tail')).toEqual({ a: 1 })
  })

  it('rejects empty and non-JSON output', () => {
    expect(() => parseCliJson('')).toThrow(/没有返回内容/u)
    expect(() => parseCliJson('not json')).toThrow(/非 JSON/u)
  })
})

describe('buildHistoryPrompt', () => {
  it('includes un-@ history, excludes the current message, and caps the number of lines', () => {
    const messages = [
      stored({ sendTime: '2026-11-19 09:58:00', text: '会议纪要：Q4 目标', userName: '李四' }),
      stored({ sendTime: '2026-11-19 09:59:00', text: '补充：预算 10 万', userName: '王五' }),
      stored({ sendTime: '2026-11-19 10:00:00', text: '根据最近群消息总结', userName: '张三' }),
    ]
    const prompt = buildHistoryPrompt({
      messages,
      question: '根据最近群消息总结',
      limit: 2,
      maxChars: 10_000,
      excludeDedupKey: messages[2]!.dedupKey,
    })
    expect(prompt).toContain('会议纪要：Q4 目标')
    expect(prompt).toContain('补充：预算 10 万')
    expect(prompt).not.toContain('[2026-11-19 10:00:00] 张三：根据最近群消息总结')
    expect(prompt).toContain('当前用户 @ 你并提问：根据最近群消息总结')
  })

  it('returns the question unchanged when there is no history', () => {
    expect(buildHistoryPrompt({ messages: [], question: '你好', limit: 50, maxChars: 10_000 })).toBe('你好')
  })

  it('respects maxChars by dropping the oldest lines', () => {
    const messages = [
      stored({ sendTime: '2026-11-19 09:58:00', text: 'A'.repeat(50) }),
      stored({ sendTime: '2026-11-19 09:59:00', text: 'B'.repeat(50) }),
    ]
    const prompt = buildHistoryPrompt({ messages, question: '总结', limit: 50, maxChars: 80 })
    expect(prompt).not.toContain('A'.repeat(50))
    expect(prompt).toContain('B'.repeat(50))
  })
})

describe('time helpers', () => {
  it('formats epoch millis as fixed +08:00 seconds', () => {
    expect(formatWecomTime(Date.parse('2026-11-19T02:00:00Z'))).toBe('2026-11-19 10:00:00')
  })
})

describe('decideAudience', () => {
  it('keeps weekly reports and meeting notes room_safe even with dsh-ui fences', () => {
    const answer = '本周会议纪要总结\n```dsh-ui\n{"title":"周报","items":[]}\n```\n涉及账号权限话题，但未输出任何凭据值。'
    expect(decideAudience('weekly_report', answer)).toBe('room_safe')
    expect(decideAudience('meeting_notes', answer)).toBe('room_safe')
  })

  it('still downgrades weekly reports that contain real resource ids or SQL', () => {
    expect(decideAudience('weekly_report', '结果：resource:table:ads_order_fact_day')).toBe('sender_only')
    expect(decideAudience('weekly_report', '```sql\nselect * from users\n```')).toBe('sender_only')
  })

  it('keeps data queries and account results sender_only', () => {
    expect(decideAudience('data_query', '普通聚合结果')).toBe('sender_only')
    expect(decideAudience('account', '账号列表')).toBe('sender_only')
  })
})


describe('refreshGroupHistory', () => {
  it('times out at the budget, logs HISTORY_REFRESH_TIMEOUT, and keeps the cached prompt count', async () => {
    const warnings: string[] = []
    const result = await refreshGroupHistory({
      history: {
        refreshRecent: () => new Promise<void>(() => undefined),
        messageCount: () => 26,
        hasLiveMessage: () => false,
        rememberLiveMessage: () => undefined,
        dedupKey: () => 'k',
        buildPrompt: (_chatId, question) => question,
      },
      chatId: 'chat-1',
      logger: { warn: message => warnings.push(message) },
      now: () => Date.now(),
      waitMs: 20,
    })
    expect(result.timedOut).toBe(true)
    expect(result.promptMessages).toBe(26)
    expect(warnings.some(message => message.includes('HISTORY_REFRESH_TIMEOUT'))).toBe(true)
  })

  it('returns without timing out when the delta refresh finishes in budget', async () => {
    const result = await refreshGroupHistory({
      history: {
        refreshRecent: async () => undefined,
        messageCount: () => 28,
        hasLiveMessage: () => false,
        rememberLiveMessage: () => undefined,
        dedupKey: () => 'k',
        buildPrompt: (_chatId, question) => question,
      },
      chatId: 'chat-1',
      logger: { warn: () => undefined },
      now: () => Date.now(),
      waitMs: 1_000,
    })
    expect(result.timedOut).toBe(false)
    expect(result.promptMessages).toBe(28)
  })
})
