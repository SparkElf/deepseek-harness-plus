import { describe, expect, it, vi } from 'vitest'
import { GroupChatBackend } from '../src/backend.ts'
import { DEFAULT_CREDENTIAL_REF, type ServerTarget } from '../src/identity.ts'

/**
 * The browser-facing route dispatches to these methods. Sending a message, creating a
 * room, and leaving one were all unreachable until the route learned to read a body and
 * dispatch on the HTTP method, so each one is asserted here against the request it makes.
 */
const target: ServerTarget = { baseUrl: 'http://backend.test', credentialRef: DEFAULT_CREDENTIAL_REF }

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const spy = (): { fetchImpl: typeof fetch; calls: [string, RequestInit][] } => {
  const calls: [string, RequestInit][] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push([url, init])
    return json({ id: '1', name: 'r', event: {}, deduplicated: false })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const client = (fetchImpl: typeof fetch) =>
  new GroupChatBackend(target, async () => 'token', { fetchImpl })

describe('upstream room operations', () => {
  it('posts a message with its idempotency key', async () => {
    const { fetchImpl, calls } = spy()
    await client(fetchImpl).sendMessage('room-1', { content: '你好', rpcId: 'rpc-9' })
    const [url, init] = calls[0]
    expect(url).toBe('http://backend.test/api/ai/chat/rooms/room-1/messages')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ content: '你好', rpcId: 'rpc-9' })
  })

  it('posts a room with its creation-time execution scope', async () => {
    // `cwd` and the preset decide what the room's agent may touch, so they must reach the
    // server at creation rather than being collected and dropped.
    const { fetchImpl, calls } = spy()
    await client(fetchImpl).createRoom('产品讨论', { cwd: '/workspace/api', agentPreset: 'default' })
    const [url, init] = calls[0]
    expect(url).toBe('http://backend.test/api/ai/chat/rooms')
    expect(JSON.parse(String(init.body))).toEqual({
      name: '产品讨论',
      cwd: '/workspace/api',
      agentPreset: 'default',
    })
  })

  it('omits the execution scope entirely when none was given', async () => {
    // An empty object would send `cwd: undefined` and read as an explicit blank rather
    // than as "use the server default".
    const { fetchImpl, calls } = spy()
    await client(fetchImpl).createRoom('room')
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ name: 'room' })
  })

  it('posts a policy patch to the update route', async () => {
    const { fetchImpl, calls } = spy()
    await client(fetchImpl).updateRoom('room-1', { agentTrigger: 'always' })
    expect(calls[0][0]).toBe('http://backend.test/api/ai/chat/rooms/room-1/update')
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ agentTrigger: 'always' })
  })

  it('posts the member list to invite', async () => {
    const { fetchImpl, calls } = spy()
    await client(fetchImpl).inviteMembers('room-1', ['u2', 'u3'])
    expect(calls[0][0]).toBe('http://backend.test/api/ai/chat/rooms/room-1/members')
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ userIds: ['u2', 'u3'] })
  })

  it('leaves a room with DELETE on the caller’s own membership', async () => {
    const { fetchImpl, calls } = spy()
    await client(fetchImpl).leaveRoom('room-1')
    expect(calls[0][0]).toBe('http://backend.test/api/ai/chat/rooms/room-1/members/me')
    expect(calls[0][1].method).toBe('DELETE')
  })

  it('carries the bearer credential on every upstream operation', async () => {
    // The Host forwards under the workspace identity, so a missing header here would fail
    // every write while reads still looked healthy.
    const { fetchImpl, calls } = spy()
    const c = client(fetchImpl)
    await c.sendMessage('r', { content: 'x', rpcId: '1' })
    await c.createRoom('n')
    await c.inviteMembers('r', ['u'])
    for (const [, init] of calls) {
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer token')
    }
  })
})
