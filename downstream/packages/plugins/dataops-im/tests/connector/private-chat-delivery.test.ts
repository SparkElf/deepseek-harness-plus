import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrivateChatRouter, type PrivateChatHost } from '../../src/connector/private-chat.ts'

const FENCE = '```dsh-ui\n{"items":[{"type":"chart","kind":"bars","data":[{"label":"周一","value":3}]}]}\n```'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createHost(state: { messagePolls: number; assistantAt: number; withTool: boolean }): {
  host: PrivateChatHost
  heartbeats: { elapsedMs: number; polls: number; sawTool: boolean; toolName?: string }[]
} {
  const heartbeats: { elapsedMs: number; polls: number; sawTool: boolean; toolName?: string }[] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (url.pathname === '/api/im/private-sessions/resolve') {
      return json({
        decision: 'bound',
        userId: 'user-1',
        workspaceId: 1,
        dshSessionId: 'session-1',
        token: 'token-1',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
    }
    if (url.pathname === '/api/ai/sessions/session-1/messages' && method === 'POST') return json({})
    if (url.pathname === '/api/ai/sessions/session-1/messages') {
      if (url.searchParams.get('limit') === '1') return json({ messages: [] })
      state.messagePolls += 1
      const messages: unknown[] = [{ seq: 1, role: 'user', text: '你好' }]
      if (state.withTool && state.messagePolls >= 3) {
        messages.push({ seq: 2, role: 'tool', text: '', toolName: 'mcp__dataops__query_table' })
      }
      if (state.messagePolls >= state.assistantAt) {
        messages.push({ seq: 3, role: 'assistant', text: FENCE })
      }
      return json({ messages })
    }
    if (url.pathname === '/api/ai/sessions') {
      return json({ sessions: [{ sessionId: 'session-1', running: false }] })
    }
    return json({ message: `unexpected ${method} ${url.pathname}` }, 404)
  }
  const host: PrivateChatHost = {
    ctx: {
      credentials: { resolve: async () => ({ value: 'service-token' }) },
    } as unknown as PrivateChatHost['ctx'],
    baseUrl: 'http://dataops.test',
    credentialRef: 'DATAOPS_ACCESS_TOKEN',
    logger: { warn: () => undefined },
    fetchImpl: fetchImpl as typeof fetch,
  }
  return {
    host,
    heartbeats,
  }
}

describe('PrivateChatRouter delivery grace', () => {
  afterEach(() => vi.useRealTimers())

  it('turn 结束后 assistant 晚到，仍会等待并返回 fence-only 答案', async () => {
    vi.useFakeTimers()
    const state = { messagePolls: 0, assistantAt: 5, withTool: true }
    const { host, heartbeats } = createHost(state)
    const router = new PrivateChatRouter(host, 'bot-1')
    const promise = router.ask({
      senderId: 'user-1',
      text: '概览',
      onHeartbeat: info => heartbeats.push(info),
    })
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 0; index < 6; index += 1) await vi.advanceTimersByTimeAsync(1_500)
    await expect(promise).resolves.toBe(FENCE)
    expect(state.messagePolls).toBeGreaterThanOrEqual(5)
    expect(heartbeats.length).toBeGreaterThan(0)
    expect(heartbeats.some(info => info.toolName === 'mcp__dataops__query_table')).toBe(true)
  })

  it('空答案最多等 15s 再返回空，不会 3 轮就放弃', async () => {
    vi.useFakeTimers()
    const state = { messagePolls: 0, assistantAt: 999, withTool: false }
    const { host } = createHost(state)
    const router = new PrivateChatRouter(host, 'bot-1')
    const promise = router.ask({ senderId: 'user-1', text: '概览' })
    await vi.advanceTimersByTimeAsync(0)
    for (let index = 0; index < 12; index += 1) await vi.advanceTimersByTimeAsync(1_500)
    await expect(promise).resolves.toBe('')
    expect(state.messagePolls).toBeGreaterThanOrEqual(10)
  })
})
