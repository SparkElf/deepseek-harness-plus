import { describe, expect, it } from 'vitest'
import type { PrivateChatHost } from '../../src/connector/private-chat.ts'
import type { GroupHistoryProvider } from '../../src/connector/history-sync.ts'
import {
  GroupChatRouter,
  groupChatSessionStatus,
  isPublicCandidate,
  type GroupChatState,
  type GroupHarness,
  type GroupMessage,
} from '../../src/connector/group-chat.ts'
import type {
  GroupBranchLifecycle,
  GroupBranchMeta,
} from '../../src/connector/group-branch-lifecycle.ts'
import {
  createDshGroupTurnActors,
  installGroupCredentialScope,
  type GroupSessionBranches,
  type GroupTurnActorGateway,
} from '../../src/connector/group-turn-actor.ts'

interface FetchCall {
  readonly path: string
  readonly body: Record<string, unknown>
  readonly token?: string
}

/** 记录每轮 ask 时共享/分支 session 上的 actor；用 it 断言没有串线。 */
class FakeActors implements GroupTurnActorGateway {
  readonly active = new Map<string, { userId: string; token: string }>()
  readonly events: string[] = []
  /** undefined 表示所有 session 都 live；测试可用空集合模拟持久化但未 resume。 */
  liveSessions: Set<string> | undefined = undefined

  async ensurePlaceholder(sessionId: string): Promise<void> {
    this.active.delete(sessionId)
    this.events.push(`placeholder:${sessionId}`)
  }

  async activate(sessionId: string, actor: unknown, token: string): Promise<void> {
    const userId = String((actor as { userId?: unknown }).userId)
    this.events.push(`activate:${sessionId}:${userId}`)
    this.active.set(sessionId, { userId, token })
  }

  async clear(sessionId: string): Promise<void> {
    this.events.push(`clear:${sessionId}`)
    this.active.delete(sessionId)
  }

  isSessionLive(sessionId: string): boolean {
    return this.liveSessions === undefined ? true : this.liveSessions.has(sessionId)
  }
}

class FakeHarness implements GroupHarness {
  readonly created: string[] = []
  readonly titles = new Map<string, string>()
  readonly asked: { sessionId: string; prompt: string; userId?: string; token?: string }[] = []
  /** 测试注入：ask 时依次回调给 onUpdate 的原始事件。 */
  updates: unknown[] = []
  private next = 0

  constructor(
    private readonly actors: FakeActors,
    private readonly answer: (index: number) => string = index => `answer-${index}`,
    private readonly onCreate?: (sessionId: string) => void,
  ) {}

  async createSession(): Promise<string> {
    this.next += 1
    const id = `session-${this.next}`
    this.created.push(id)
    this.onCreate?.(id)
    return id
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    return this.created.includes(sessionId)
  }

  async renameSession(sessionId: string, title: string): Promise<unknown> {
    this.titles.set(sessionId, title)
    return { title }
  }

  async ask(sessionId: string, prompt: string, options?: { onUpdate?: (update: unknown) => void }): Promise<string> {
    const active = this.actors.active.get(sessionId)
    this.asked.push({
      sessionId,
      prompt,
      ...(active === undefined ? {} : { userId: active.userId, token: active.token }),
    })
    for (const update of this.updates) options?.onUpdate?.(update)
    return this.answer(this.asked.length)
  }
}

/** fork 返回确定性 child id，并记录 source/boundary。 */
class FakeBranches implements GroupSessionBranches {
  readonly forks: { source: string; boundary?: number; child: string }[] = []
  readonly discarded: { sessionId: string; title: string }[] = []
  readonly seqs = new Map<string, number | undefined>()
  private next = 0

  async fork(source: string, boundary?: number): Promise<string> {
    this.next += 1
    const child = `fork-${this.next}`
    this.forks.push({ source, ...(boundary === undefined ? {} : { boundary }), child })
    return child
  }

  lastSeq(sessionId: string): number | undefined {
    return this.seqs.get(sessionId)
  }

  async markDiscarded(sessionId: string, title: string): Promise<void> {
    this.discarded.push({ sessionId, title })
  }
}

class FakeLifecycle implements GroupBranchLifecycle {
  readonly retired: { sessionId: string; meta: GroupBranchMeta }[] = []

  async retire(sessionId: string, meta: GroupBranchMeta): Promise<void> {
    this.retired.push({ sessionId, meta })
  }

  async sweep(): Promise<number> {
    return 0
  }
}

function fakeState(initial: Record<string, string> = {}): GroupChatState & {
  hasSeen(id: string): boolean
  markSeen(id: string): Promise<void>
  snapshot(): Record<string, string>
} {
  const sessions = new Map(Object.entries(initial))
  const seen = new Set<string>()
  return {
    sessionFor: (key: string) => sessions.get(key) ?? null,
    setSession: async (key: string, sessionId: string) => { sessions.set(key, sessionId); return true },
    clearSession: async (key: string) => { sessions.delete(key); return true },
    hasSeen: (id: string) => seen.has(id),
    markSeen: async (id: string) => { seen.add(id); return undefined },
    snapshot: () => Object.fromEntries(sessions),
  }
}

function fakeHistory(): GroupHistoryProvider & { refreshCalls: { chatId: string; lookback?: number }[] } {
  const refreshCalls: { chatId: string; lookback?: number }[] = []
  const messages = [
    { chatId: 'chat-1', sendTime: '2026-11-19 10:00:00', sendTimeMs: 1, userId: 'u0', userName: '王五', msgType: 'text', text: '会议纪要：本周完成接入验证', textHash: 'h1', sameSecondOrdinal: 0, dedupKey: 'd1', source: 'cli' as const },
  ]
  return {
    refreshCalls,
    hasLiveMessage: () => false,
    rememberLiveMessage: () => undefined,
    dedupKey: () => 'dedup-live',
    buildPrompt: (_chatId, question) => [
      `以下是本企业微信群最近 ${String(messages.length)} 条消息：`,
      '[2026-11-19 10:00:00] 王五：会议纪要：本周完成接入验证',
      '',
      `当前用户 @ 你并提问：${question}`,
    ].join('\n'),
    refresh: async () => undefined,
    refreshRecent: async (chatId, lookbackMinutes) => { refreshCalls.push({ chatId, ...(lookbackMinutes === undefined ? {} : { lookback: lookbackMinutes }) }) },
    messageCount: () => messages.length,
    chatName: () => undefined,
  }
}

function fakeHost(calls: FetchCall[], options: {
  ingestDeduplicated?: boolean
  identityUnboundFirst?: boolean
} = {}): PrivateChatHost {
  let identityCalls = 0
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>
    const authorization = init?.headers === undefined
      ? ''
      : new Headers(init.headers).get('authorization') ?? ''
    calls.push({
      path,
      body,
      ...(authorization.startsWith('Bearer ') ? { token: authorization.slice(7) } : {}),
    })
    if (path === '/api/im/identity/resolve') {
      identityCalls += 1
      if (options.identityUnboundFirst === true && identityCalls === 1) {
        return json({ decision: 'unmapped', reason: 'IDENTITY_NOT_BOUND', message: '未绑定' })
      }
      const senderId = String(body.senderId)
      return json({
        decision: 'bound',
        user: { id: `dataops-${senderId}` },
        actor: { userId: `dataops-${senderId}`, permissions: ['resource:read'] },
        token: `jwt-${senderId}-${String(body.sessionId)}`,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      })
    }
    if (path === '/api/im/private-sessions/resolve') {
      return json({ decision: 'bound', userId: 'dataops-provisioned', workspaceId: 1, dshSessionId: 'private-session-1', title: '与万相机器人的会话', token: 'private-token', expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() })
    }
    if (path === '/api/ai/chat/external/ingest') {
      return json({ roomId: 'room-1', deduplicated: options.ingestDeduplicated === true })
    }
    if (path === '/api/ai/chat/external/replies') {
      const audience = body.audience === 'room_safe' ? 'room_safe' : 'sender_only'
      return json({
        roomId: 'room-1',
        audience,
        deliveredToRoom: audience === 'room_safe',
        ...(audience === 'sender_only' ? { ack: '结果涉及个人数据，已私聊发送' } : {}),
      })
    }
    return json({ message: `unexpected ${path}` }, 500)
  }
  return {
    ctx: { credentials: { resolve: async (ref: unknown) => String(ref) === 'DATAOPS_ACCESS_TOKEN' ? { value: 'service-jwt' } : undefined } } as never,
    baseUrl: 'http://dataops.test',
    credentialRef: 'DATAOPS_ACCESS_TOKEN',
    logger: { warn: () => undefined, info: () => undefined },
    fetchImpl: fetchImpl as typeof fetch,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function message(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    frame: {},
    messageId: 'msg-1',
    chatId: 'chat-1',
    senderId: 'sender-a',
    senderName: '张三',
    text: '用 list_resources 查询我能看到的数据资源',
    ...overrides,
  }
}

interface Rig {
  readonly group: GroupChatRouter
  readonly harness: FakeHarness
  readonly actors: FakeActors
  readonly branches: FakeBranches
  readonly lifecycle: FakeLifecycle
  readonly state: ReturnType<typeof fakeState>
  readonly calls: FetchCall[]
}

function rig(options: {
  calls: FetchCall[]
  answer?: (index: number) => string
  state?: ReturnType<typeof fakeState>
  history?: GroupHistoryProvider
  ingestDeduplicated?: boolean
  identityUnboundFirst?: boolean
  sharedSessionId?: string
} = { calls: [] }): Rig {
  const calls = options.calls
  const actors = new FakeActors()
  const harness = new FakeHarness(actors, options.answer)
  const branches = new FakeBranches()
  const lifecycle = new FakeLifecycle()
  const state = options.state ?? fakeState()
  if (options.sharedSessionId !== undefined) branches.seqs.set(options.sharedSessionId, 7)
  const group = new GroupChatRouter({
    host: fakeHost(calls, {
      ...(options.ingestDeduplicated === undefined ? {} : { ingestDeduplicated: options.ingestDeduplicated }),
      ...(options.identityUnboundFirst === undefined ? {} : { identityUnboundFirst: options.identityUnboundFirst }),
    }),
    botId: 'bot-1',
    state,
    ...(options.history === undefined ? {} : { history: options.history }),
    harness,
    actors,
    branches,
    lifecycle,
  })
  return { group, harness, actors, branches, lifecycle, state, calls }
}

const weekly = (overrides: Partial<GroupMessage> = {}): GroupMessage =>
  message({ text: '请生成本周周报', ...overrides })

describe('GroupChatRouter shared session', () => {
  it('keeps public turns in one shared session and switches actor per sender', async () => {
    const { group, harness, actors, state } = rig({
      calls: [],
      answer: () => '本周完成企微群聊接入验证。',
    })
    const first = await group.process(weekly({ messageId: 'msg-a', senderId: 'sender-a' }))
    const second = await group.process(weekly({ messageId: 'msg-b', senderId: 'sender-b', senderName: '李四' }))

    expect(first.deduplicated).toBe(false)
    expect(second.deduplicated).toBe(false)
    expect(harness.created).toEqual(['session-1'])
    expect(harness.asked.map(entry => entry.sessionId)).toEqual(['session-1', 'session-1'])
    expect(harness.asked.map(entry => entry.userId)).toEqual(['dataops-sender-a', 'dataops-sender-b'])
    expect(harness.asked[0]!.token).toContain('jwt-sender-a-session-1')
    expect(harness.asked[1]!.token).toContain('jwt-sender-b-session-1')
    expect(state.snapshot()).toMatchObject({ 'group-session:bot-1:chat-1': 'session-1' })
    expect(actors.events.filter(event => event.startsWith('activate:'))).toEqual([
      'activate:session-1:dataops-sender-a',
      'activate:session-1:dataops-sender-b',
    ])
    expect(actors.events).toContain('clear:session-1')
    expect(actors.active.size).toBe(0)
  })

  it('serializes A/B turns even when processes start concurrently', async () => {
    const calls: FetchCall[] = []
    const actors = new FakeActors()
    const harness = new FakeHarness(actors, () => '本周完成企微群聊接入验证。')
    const sessionOrder: (string | undefined)[] = []
    const originalAsk = harness.ask.bind(harness)
    harness.ask = async (sessionId, prompt) => {
      sessionOrder.push(actors.active.get(sessionId)?.userId)
      return originalAsk(sessionId, prompt)
    }
    const group = new GroupChatRouter({
      host: fakeHost(calls),
      botId: 'bot-1',
      state: fakeState(),
      harness,
      actors,
      branches: new FakeBranches(),
      lifecycle: new FakeLifecycle(),
    })
    await Promise.all([
      group.process(weekly({ messageId: 'msg-a', senderId: 'sender-a' })),
      group.process(weekly({ messageId: 'msg-b', senderId: 'sender-b' })),
    ])
    expect(sessionOrder).toEqual(['dataops-sender-a', 'dataops-sender-b'])
  })

  it('injects group history and counts it on both A/B prompts', async () => {
    const history = fakeHistory()
    const { group, harness } = rig({ calls: [], history, answer: () => '本周完成企微群聊接入验证。' })
    await group.process(weekly({ messageId: 'msg-a', senderId: 'sender-a' }))
    await group.process(weekly({ messageId: 'msg-b', senderId: 'sender-b' }))

    expect(history.refreshCalls).toEqual([
      { chatId: 'chat-1', lookback: 10 },
      { chatId: 'chat-1', lookback: 10 },
    ])
    expect(harness.asked[0]!.prompt).toContain('会议纪要：本周完成接入验证')
    expect(harness.asked[1]!.prompt).toContain('会议纪要：本周完成接入验证')
    expect(harness.asked[1]!.prompt).toContain('请生成本周周报')
    const trace = groupChatSessionStatus().filter(item => item.sessionId === 'session-1' && item.chatIdMasked === 'ch***-1').at(-1)
    expect(trace?.lastPromptHadHistory).toBe(true)
    expect(trace?.lastPromptMessages).toBe(1)
  })

  it('fails closed when the sender is unmapped and never falls back to the service account', async () => {
    const calls: FetchCall[] = []
    const actors = new FakeActors()
    const harness = new FakeHarness(actors)
    const groups = new GroupChatRouter({
      host: {
        ...fakeHost(calls),
        fetchImpl: (async (input: RequestInfo | URL) => {
          const path = new URL(String(input)).pathname
          if (path === '/api/im/identity/resolve') {
            return json({ decision: 'unmapped', reason: 'USER_DISABLED', message: '账号已停用' })
          }
          if (path === '/api/ai/chat/external/ingest') return json({ roomId: 'room-1', deduplicated: false })
          return json({ message: 'unexpected' }, 500)
        }) as typeof fetch,
      },
      botId: 'bot-1',
      state: fakeState(),
      harness,
      actors,
      branches: new FakeBranches(),
      lifecycle: new FakeLifecycle(),
    })
    await expect(groups.process(weekly({ messageId: 'msg-x' }))).rejects.toMatchObject({ code: 'USER_DISABLED' })
    expect(harness.asked).toEqual([])
    expect(actors.events.some(event => event.startsWith('activate:'))).toBe(false)
  })

  it('does not execute or reply when the backend ledger reports a duplicate', async () => {
    const { group, harness } = rig({ calls: [], ingestDeduplicated: true })
    const outcome = await group.process(weekly({ messageId: 'msg-dup' }))
    expect(outcome.deduplicated).toBe(true)
    expect(harness.asked).toEqual([])
  })

  it('never reuses a legacy per-sender state key', async () => {
    const state = fakeState({ 'group-session:bot-1:chat-1:sender-a': 'legacy-session' })
    const { group, harness } = rig({ calls: [], state, answer: () => '本周完成企微群聊接入验证。' })
    await group.process(weekly({ messageId: 'msg-a', senderId: 'sender-a' }))
    expect(harness.created).toEqual(['session-1'])
    expect(state.snapshot()).toMatchObject({
      'group-session:bot-1:chat-1': 'session-1',
      'group-session:bot-1:chat-1:sender-a': 'legacy-session',
    })
  })

  it('auto-provisions once for an unbound sender, then executes in the shared group session', async () => {
    const calls: FetchCall[] = []
    const { group, harness } = rig({ calls, identityUnboundFirst: true, answer: () => '本周完成企微群聊接入验证。' })
    await group.process(weekly({ messageId: 'msg-new', senderId: 'sender-new' }))
    const provision = calls.filter(call => call.path === '/api/im/private-sessions/resolve')
    expect(provision).toHaveLength(1)
    expect(provision[0]!.body).toMatchObject({ botId: 'bot-1', senderId: 'sender-new' })
    expect(harness.asked).toHaveLength(1)
    expect(harness.asked[0]!.sessionId).toBe('session-1')
    expect(harness.asked[0]!.userId).toBe('dataops-sender-new')
  })

  it('runs sender_only turns in a turn-private fork and archives it without touching the shared session', async () => {
    const { group, harness, branches, lifecycle, state } = rig({ calls: [], sharedSessionId: 'session-1' })
    const outcome = await group.process(message({ messageId: 'msg-detail', text: '查一下明细清单' }))
    expect(outcome.audience).toBe('sender_only')
    expect(branches.forks).toEqual([{ source: 'session-1', boundary: 7, child: 'fork-1' }])
    expect(harness.asked[0]!.sessionId).toBe('fork-1')
    expect(harness.asked[0]!.userId).toBe('dataops-sender-a')
    expect(lifecycle.retired.map(entry => entry.sessionId)).toEqual(['fork-1'])
    expect(lifecycle.retired[0]!.meta).toMatchObject({
      parentGroupSession: 'session-1',
      senderId: 'sender-a',
      turnId: 'msg-detail',
      reason: 'sender_only',
    })
    // 共享 session 绑定不变，私有 child 不 merge 回来。
    expect(state.snapshot()).toMatchObject({ 'group-session:bot-1:chat-1': 'session-1' })
    expect(harness.created).toEqual(['session-1'])
  })

  it('marks weekly reports room_safe and keeps them in the shared session', async () => {
    const { group, harness, lifecycle, branches } = rig({ calls: [], answer: () => '本周完成企微群聊接入验证。' })
    const outcome = await group.process(weekly({ messageId: 'msg-weekly' }))
    expect(outcome.audience).toBe('room_safe')
    expect(harness.asked[0]!.sessionId).toBe('session-1')
    expect(branches.forks).toEqual([])
    expect(lifecycle.retired).toEqual([])
  })

  it('isolates a public turn when the answer is downgraded to sender_only', async () => {
    const { group, harness, branches, lifecycle, state } = rig({
      calls: [],
      sharedSessionId: 'session-1',
      answer: () => 'resource:table:secret_table 明细如下',
    })
    const outcome = await group.process(weekly({ messageId: 'msg-downgrade' }))
    expect(outcome.audience).toBe('sender_only')
    expect(branches.forks).toEqual([{ source: 'session-1', boundary: 7, child: 'fork-1' }])
    expect(state.snapshot()).toMatchObject({ 'group-session:bot-1:chat-1': 'fork-1' })
    expect(lifecycle.retired.map(entry => entry.sessionId)).toContain('session-1')
    expect(harness.asked).toHaveLength(1)
  })

  it('emits only whitelisted tool phase text and never arguments/results', async () => {
    const { group, harness } = rig({ calls: [], answer: () => '本周完成企微群聊接入验证。' })
    harness.updates = [
      { type: 'tool', name: 'mcp__data-query__data_query', arguments: '{"sql":"select secret"}', callId: 'call-1' },
      { type: 'tool', name: 'execute_sql', arguments: '{"sql":"select * from secret_table"}' },
      { type: 'tool', name: 'mcp__knowledge__kb_search', text: 'secret result' },
      { type: 'tool', name: 'mcp__browser-bridge__browser_navigate', arguments: '{"url":"https://secret"}' },
      { type: 'tool-result', toolName: 'x', text: 'secret result' },
    ]
    const progress: string[] = []
    await group.process(weekly({ messageId: 'msg-tools' }), { onProgress: text => progress.push(text) })
    expect(progress).toContain('正在查询数据资源')
    expect(progress).toContain('正在执行 SQL')
    expect(progress).toContain('正在检索知识库')
    expect(progress).toContain('正在调用 browser_navigate')
    expect(progress.join('\n')).not.toMatch(/secret|select|https?:|\{|call-1/u)
  })

  it('uses the bot service token for ingest/identity/reply while tools use the sender token', async () => {
    const calls: FetchCall[] = []
    const values = new Map([['DATAOPS_ACCESS_TOKEN', 'bot-service-jwt']])
    const credentials = {
      values,
      async resolve(ref: unknown) {
        const value = values.get(String(ref))
        return value === undefined ? undefined : { value, source: 'test' }
      },
      async set(ref: unknown, value: string) { values.set(String(ref), value) },
      async unset(ref: unknown) { values.delete(String(ref)) },
    }
    const sessionStore = new Map<string, { id: string; actor?: unknown; header?: { parentSession?: string } }>([
      ['group-session-1', { id: 'group-session-1' }],
    ])
    const ctx = {
      credentials,
      sessions: {
        get: (id: unknown) => sessionStore.get(String(id)),
        fork: (source: unknown) => {
          const id = `fork-${sessionStore.size + 1}`
          const child = { id, header: { parentSession: String(source) } }
          sessionStore.set(id, child)
          return child
        },
      },
      sessionTitle: { rename: () => undefined },
      agents: { currentInitiator: () => ({ session: sessionStore.get('group-session-1') }) },
      workspaceRegistry: { archiveSession: async () => undefined, unarchiveSession: async () => undefined },
    }
    const rawGateway = createDshGroupTurnActors(ctx as never, 'DATAOPS_ACCESS_TOKEN')
    // 模拟“群 session 已登记但当前没有 active turn actor”。
    await rawGateway.ensurePlaceholder('group-session-1')
    const dispose = installGroupCredentialScope(ctx as never, 'DATAOPS_ACCESS_TOKEN')
    // Router 用 FakeActors 记录工具侧 actor；服务侧凭据由 raw resolver 验证。
    const actors = new FakeActors()
    try {
      const base = fakeHost(calls)
      const harness = new FakeHarness(actors, () => '本周完成企微群聊接入验证。', id => {
        sessionStore.set(id, { id })
      })
      const group = new GroupChatRouter({
        host: { ...base, ctx: ctx as never },
        botId: 'bot-1',
        state: fakeState(),
        harness,
        actors,
      })
      const outcome = await group.process(weekly({ messageId: 'msg-service', senderId: 'sender-a' }))
      expect(outcome.audience).toBe('room_safe')
      // connector 服务调用：始终 bot 服务账号 token，不抛 not_authorized。
      const serviceCalls = calls.filter(call => call.path === '/api/ai/chat/external/ingest'
        || call.path === '/api/im/identity/resolve'
        || call.path === '/api/ai/chat/external/replies')
      expect(serviceCalls.length).toBeGreaterThanOrEqual(3)
      expect(serviceCalls.every(call => call.token === 'bot-service-jwt')).toBe(true)
      // agent 工具：sender scoped token。
      expect(harness.asked[0]?.token).toContain('jwt-sender-a-')
      expect(values.get('DATAOPS_ACCESS_TOKEN')).toBe('bot-service-jwt')
    } finally {
      dispose()
    }
  })

  it('archives a persisted-but-not-live shared session and creates a new one', async () => {
    const calls: FetchCall[] = []
    const actors = new FakeActors()
    actors.liveSessions = new Set()
    const harness = new FakeHarness(actors, () => '本周完成企微群聊接入验证。')
    const originalExists = harness.sessionExists.bind(harness)
    harness.sessionExists = async sessionId => sessionId === 'stale-session' || originalExists(sessionId)
    const lifecycle = new FakeLifecycle()
    const state = fakeState({ 'group-session:bot-1:chat-1': 'stale-session' })
    const group = new GroupChatRouter({
      host: fakeHost(calls),
      botId: 'bot-1',
      state,
      harness,
      actors,
      lifecycle,
    })
    const outcome = await group.process(weekly({ messageId: 'msg-stale' }))
    expect(outcome.audience).toBe('room_safe')
    expect(harness.created).toEqual(['session-1'])
    expect(state.snapshot()).toMatchObject({ 'group-session:bot-1:chat-1': 'session-1' })
    expect(lifecycle.retired[0]?.sessionId).toBe('stale-session')
    expect(lifecycle.retired[0]?.meta.reason).toBe('superseded')
    expect(harness.asked[0]?.sessionId).toBe('session-1')
  })

  it('classifies only weekly/meeting/public requests as public candidates', () => {
    expect(isPublicCandidate('weekly_report')).toBe(true)
    expect(isPublicCandidate('meeting_notes')).toBe(true)
    expect(isPublicCandidate('public_knowledge')).toBe(true)
    expect(isPublicCandidate('data_query')).toBe(false)
    expect(isPublicCandidate('detail')).toBe(false)
    expect(isPublicCandidate('other')).toBe(false)
  })
})