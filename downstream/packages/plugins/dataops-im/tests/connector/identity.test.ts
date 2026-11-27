import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WecomIdentityBridge, scopedCredentialRef } from '../../src/connector/identity.ts'

type Listener = (payload: unknown) => void

/**
 * Minimal Host double: event bus, credential map and in-memory Sessions.
 */
function host(options: { token?: string; dshIm?: unknown } = {}) {
  const listeners = new Map<string, Set<Listener>>()
  const credentials = new Map<string, string>()
  if (options.token !== undefined) credentials.set('DATAOPS_ACCESS_TOKEN', options.token)
  const sessions = new Map<string, { id: string; actor?: unknown }>()
  const ctx = {
    on(name: string, listener: Listener) {
      const set = listeners.get(name) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(name, set)
      return () => set.delete(listener)
    },
    credentials: {
      async resolve(ref: string) {
        const value = credentials.get(ref)
        return value === undefined ? undefined : { value, source: 'memory' }
      },
      async set(ref: string, value: string) { credentials.set(ref, value) },
      async unset(ref: string) { credentials.delete(ref) },
    },
    sessions: {
      get(id: string) { return sessions.get(id) },
    },
    get(name: string) { return name === 'dshIm' ? options.dshIm : undefined },
  } as unknown as Context
  return {
    ctx,
    credentials,
    sessions,
    emit(name: string, payload: unknown) {
      for (const listener of listeners.get(name) ?? []) listener(payload)
    },
    closed: () => listeners.size === 0,
  }
}

function boundBody(actorUserId = 'user-a') {
  return {
    decision: 'bound',
    user: { id: actorUserId, username: 'a', displayName: 'A' },
    actor: {
      userId: actorUserId,
      roleCodes: ['应用人员'],
      permissions: ['data:resource:read'],
      primaryRole: '应用人员',
      source: 'wecom',
    },
    token: 'scoped-token-value',
    expiresAt: '2026-11-18T11:00:00.000Z',
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('scopedCredentialRef', () => {
  it('matches the mcp-credentials fold exactly', () => {
    expect(scopedCredentialRef('DATAOPS_ACCESS_TOKEN', 'session-b0ea8d06-bca2-4e1b-93fa-5e67f7d72762'))
      .toBe('DATAOPS_ACCESS_TOKEN_S_SESSION_B0EA8D06_BCA2_4E1B_93FA_5E67F7D72762')
    expect(scopedCredentialRef('DATAOPS_ACCESS_TOKEN', 'group-room-b1b6ed22-740f'))
      .toBe('DATAOPS_ACCESS_TOKEN_S_GROUP_ROOM_B1B6ED22_740F')
  })
})

describe('WecomIdentityBridge', () => {
  it('stores the scoped credential and the real actor on a bound sender', async () => {
    const h = host({ token: 'workspace-token' })
    const fetchImpl = vi.fn(async () => jsonResponse(boundBody()))
    const bridge = new WecomIdentityBridge(h.ctx, {
      baseUrl: 'http://dataops.test',
      credentialRef: 'DATAOPS_ACCESS_TOKEN',
      logger: { warn: vi.fn() },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const dispose = bridge.start()
    h.sessions.set('session-1', { id: 'session-1' })

    h.emit('dsh-im/session-pre-bind', {
      channel: 'wecom', botId: 'bot-1', sessionId: 'session-1', senderId: 'zhangsan',
    })

    await vi.waitFor(() => expect(bridge.status('session-1')?.status).toBe('bound'))
    expect(h.credentials.get('DATAOPS_ACCESS_TOKEN_S_SESSION_1')).toBe('scoped-token-value')
    expect(h.sessions.get('session-1')?.actor).toMatchObject({ userId: 'user-a', roleCodes: ['应用人员'] })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('fails closed on an unmapped sender: placeholder actor, no scoped credential', async () => {
    const h = host({ token: 'workspace-token' })
    const bridge = new WecomIdentityBridge(h.ctx, {
      baseUrl: 'http://dataops.test',
      credentialRef: 'DATAOPS_ACCESS_TOKEN',
      logger: { warn: vi.fn() },
      fetchImpl: (async () => jsonResponse({
        decision: 'unmapped', reason: 'IDENTITY_NOT_BOUND', message: 'not bound',
      })) as unknown as typeof fetch,
    })
    const dispose = bridge.start()
    h.sessions.set('session-2', { id: 'session-2' })

    h.emit('dsh-im/session-pre-bind', {
      channel: 'wecom', botId: 'bot-1', sessionId: 'session-2', senderId: 'nobody',
    })

    await vi.waitFor(() => expect(bridge.status('session-2')?.status).toBe('unmapped'))
    expect(h.credentials.has('DATAOPS_ACCESS_TOKEN_S_SESSION_2')).toBe(false)
    const actor = h.sessions.get('session-2')?.actor as Record<string, unknown>
    expect(actor).toEqual({ identityPending: true, source: 'wecom' })
    // Placeholder has no DataOps scope key, so tool disclosure must treat it as not-this-user.
    expect('userId' in actor).toBe(false)
    dispose()
  })

  it('fails closed when the service credential is missing', async () => {
    const h = host()
    const bridge = new WecomIdentityBridge(h.ctx, {
      baseUrl: 'http://dataops.test',
      credentialRef: 'DATAOPS_ACCESS_TOKEN',
      logger: { warn: vi.fn() },
    })
    const dispose = bridge.start()
    h.sessions.set('session-3', { id: 'session-3' })
    h.emit('dsh-im/session-pre-bind', {
      channel: 'wecom', botId: 'bot-1', sessionId: 'session-3', senderId: 'zhangsan',
    })
    await vi.waitFor(() => expect(bridge.status('session-3')?.status).toBe('unavailable'))
    expect(h.credentials.has('DATAOPS_ACCESS_TOKEN_S_SESSION_3')).toBe(false)
    dispose()
  })

  it('applies the resolved actor when session/created arrives after the resolve', async () => {
    const h = host({ token: 'workspace-token' })
    const bridge = new WecomIdentityBridge(h.ctx, {
      baseUrl: 'http://dataops.test',
      credentialRef: 'DATAOPS_ACCESS_TOKEN',
      logger: { warn: vi.fn() },
      fetchImpl: (async () => jsonResponse(boundBody())) as unknown as typeof fetch,
    })
    const dispose = bridge.start()
    h.emit('dsh-im/session-pre-bind', {
      channel: 'wecom', botId: 'bot-1', sessionId: 'session-4', senderId: 'zhangsan',
    })
    await vi.waitFor(() => expect(bridge.status('session-4')?.status).toBe('bound'))

    // dsh-im 的 pre-bind 在 session.create 之前；两种顺序都必须落到同一个 actor。
    h.sessions.set('session-4', { id: 'session-4' })
    h.emit('session/created', { id: 'session-4' })

    expect(h.sessions.get('session-4')?.actor).toMatchObject({ userId: 'user-a' })
    dispose()
  })

  it('retries resolve for the same sender after a failed binding', async () => {
    const h = host({ token: 'workspace-token' })
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call += 1
      return call === 1
        ? jsonResponse({ decision: 'unmapped', reason: 'IDENTITY_NOT_BOUND', message: 'not bound' })
        : jsonResponse(boundBody())
    })
    const bridge = new WecomIdentityBridge(h.ctx, {
      baseUrl: 'http://dataops.test',
      credentialRef: 'DATAOPS_ACCESS_TOKEN',
      logger: { warn: vi.fn() },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const dispose = bridge.start()
    h.sessions.set('session-retry', { id: 'session-retry' })
    const event = { channel: 'wecom', botId: 'bot-1', sessionId: 'session-retry', senderId: 'zhangsan' }
    h.emit('dsh-im/session-pre-bind', event)
    await vi.waitFor(() => expect(bridge.status('session-retry')?.status).toBe('unmapped'))
    h.emit('dsh-im/session-pre-bind', event)
    await vi.waitFor(() => expect(bridge.status('session-retry')?.status).toBe('bound'))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(h.credentials.has('DATAOPS_ACCESS_TOKEN_S_SESSION_RETRY')).toBe(true)
    dispose()
  })

  it('reconciles a restored Session that has no pending pre-bind event', async () => {
    const h = host({
      token: 'workspace-token',
      dshIm: {
        async describeConversation(id: string) {
          return id === 'session-restored'
            ? { channel: 'wecom', botId: 'bot-1', sessionId: id, senderId: 'zhangsan', senderName: 'Z' }
            : null
        },
      },
    })
    const bridge = new WecomIdentityBridge(h.ctx, {
      baseUrl: 'http://dataops.test',
      credentialRef: 'DATAOPS_ACCESS_TOKEN',
      logger: { warn: vi.fn() },
      fetchImpl: (async () => jsonResponse(boundBody())) as unknown as typeof fetch,
    })
    const dispose = bridge.start()
    h.sessions.set('session-restored', { id: 'session-restored' })
    // 重启后不会重放 pre-bind；session/created 对账必须补上 actor 与 scoped 槽。
    h.emit('session/created', { id: 'session-restored' })
    await vi.waitFor(() => expect(bridge.status('session-restored')?.status).toBe('bound'))
    expect(h.credentials.has('DATAOPS_ACCESS_TOKEN_S_SESSION_RESTORED')).toBe(true)
    expect(h.sessions.get('session-restored')?.actor).toMatchObject({ userId: 'user-a' })
    dispose()
  })

  it('removes the scoped credential on unbind', async () => {
    const h = host({ token: 'workspace-token' })
    const bridge = new WecomIdentityBridge(h.ctx, {
      baseUrl: 'http://dataops.test',
      credentialRef: 'DATAOPS_ACCESS_TOKEN',
      logger: { warn: vi.fn() },
      fetchImpl: (async () => jsonResponse(boundBody())) as unknown as typeof fetch,
    })
    const dispose = bridge.start()
    h.sessions.set('session-5', { id: 'session-5' })
    h.emit('dsh-im/session-pre-bind', {
      channel: 'wecom', botId: 'bot-1', sessionId: 'session-5', senderId: 'zhangsan',
    })
    await vi.waitFor(() => expect(h.credentials.has('DATAOPS_ACCESS_TOKEN_S_SESSION_5')).toBe(true))

    h.emit('dsh-im/session-unbind', { channel: 'wecom', botId: 'bot-1', sessionId: 'session-5' })
    await vi.waitFor(() => expect(h.credentials.has('DATAOPS_ACCESS_TOKEN_S_SESSION_5')).toBe(false))
    dispose()
  })

  it('lists unmapped senders with senderName, status and a masked id for administrators', async () => {
    const h = host({ token: 'workspace-token' })
    const bridge = new WecomIdentityBridge(h.ctx, {
      baseUrl: 'http://dataops.test',
      credentialRef: 'DATAOPS_ACCESS_TOKEN',
      logger: { warn: vi.fn() },
      fetchImpl: (async () => jsonResponse({
        decision: 'unmapped', reason: 'IDENTITY_NOT_BOUND', message: 'not bound',
      })) as unknown as typeof fetch,
    })
    const dispose = bridge.start()
    h.sessions.set('session-pending-1', { id: 'session-pending-1' })
    h.emit('dsh-im/session-pre-bind', {
      channel: 'wecom',
      botId: 'bot-1',
      sessionId: 'session-pending-1',
      senderId: 'zhangsan',
      senderName: '张三',
      chatType: 'single',
    })
    await vi.waitFor(() => expect(bridge.status('session-pending-1')?.status).toBe('unmapped'))

    const [item] = bridge.listPending()
    expect(item).toMatchObject({
      sessionId: 'session-pending-1',
      botId: 'bot-1',
      senderId: 'zhangsan',
      senderName: '张三',
      status: 'unmapped',
      bound: false,
      unmapped: true,
      reason: 'IDENTITY_NOT_BOUND',
    })
    expect(item?.senderIdMasked).toBe('zh****an')
    expect(item?.senderIdMasked).not.toBe('zhangsan')
    // 记录只含绑定输入与状态，不含身份服务返回的 token。
    expect(JSON.stringify(item)).not.toContain('scoped-token')
    dispose()
  })

  it('maps the dsh-im internal wecom botId to the remote botId before resolve', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-identity-bot-'))
    await mkdir(join(home, 'integrations', 'dsh-wecom'), { recursive: true })
    await writeFile(join(home, 'integrations', 'dsh-wecom', 'config.json'), JSON.stringify({
      bots: [{ botId: 'wecom_internal', remoteBotId: 'aibv_remote' }],
    }))
    const h = host({ token: 'workspace-token' })
    let sent: { botId?: string } = {}
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body ?? '{}')) as { botId?: string }
      return jsonResponse({ decision: 'unmapped', reason: 'IDENTITY_NOT_BOUND', message: 'not bound' })
    })
    const bridge = new WecomIdentityBridge(h.ctx, {
      baseUrl: 'http://dataops.test',
      credentialRef: 'DATAOPS_ACCESS_TOKEN',
      logger: { warn: vi.fn() },
      dshHome: home,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const dispose = bridge.start()
    h.sessions.set('session-remote-bot', { id: 'session-remote-bot' })
    h.emit('dsh-im/session-pre-bind', {
      channel: 'wecom', botId: 'wecom_internal', sessionId: 'session-remote-bot', senderId: 'zhangsan',
    })
    await vi.waitFor(() => expect(bridge.status('session-remote-bot')?.status).toBe('unmapped'))
    expect(sent.botId).toBe('aibv_remote')
    expect(bridge.listPending()[0]?.remoteBotId).toBe('aibv_remote')
    dispose()
    await rm(home, { recursive: true, force: true })
  })

  it('updates a sender to bound after resolve and caps the admin list at 50', async () => {
    const h = host({ token: 'workspace-token' })
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { senderId?: string }
      return payload.senderId === 'zhangsan'
        ? jsonResponse(boundBody('user-a'))
        : jsonResponse({ decision: 'unmapped', reason: 'IDENTITY_NOT_BOUND', message: 'not bound' })
    })
    const bridge = new WecomIdentityBridge(h.ctx, {
      baseUrl: 'http://dataops.test',
      credentialRef: 'DATAOPS_ACCESS_TOKEN',
      logger: { warn: vi.fn() },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const dispose = bridge.start()
    h.sessions.set('session-bound', { id: 'session-bound' })
    h.emit('dsh-im/session-pre-bind', {
      channel: 'wecom', botId: 'bot-1', sessionId: 'session-bound', senderId: 'zhangsan', senderName: '张三',
    })
    await vi.waitFor(() => expect(bridge.status('session-bound')?.status).toBe('bound'))

    const bound = bridge.listPending().find((item) => item.senderId === 'zhangsan')
    expect(bound).toMatchObject({ status: 'bound', bound: true, unmapped: false, actorUserId: 'user-a' })

    for (let index = 0; index < 55; index += 1) {
      const sessionId = `session-bulk-${index}`
      h.sessions.set(sessionId, { id: sessionId })
      h.emit('dsh-im/session-pre-bind', {
        channel: 'wecom', botId: 'bot-1', sessionId, senderId: `unmapped-${index}`,
      })
    }
    await vi.waitFor(() => expect(bridge.listPending(1000).length).toBe(50))
    expect(bridge.listPending(1)).toHaveLength(1)
    dispose()
  })
})