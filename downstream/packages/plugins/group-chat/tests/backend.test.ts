import { describe, expect, it, vi } from 'vitest'
import { BackendError, GroupChatBackend, isTransportFailure } from '../src/backend.ts'
import { DEFAULT_CREDENTIAL_REF, type ServerTarget } from '../src/identity.ts'

const target: ServerTarget = {
  baseUrl: 'http://backend.test',
  credentialRef: DEFAULT_CREDENTIAL_REF,
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const client = (fetchImpl: typeof fetch, overrides: Partial<ServerTarget> = {}, credential = 'token-abc') =>
  new GroupChatBackend(
    { ...target, ...overrides },
    async () => credential,
    { fetchImpl },
  )

describe('GroupChatBackend request shape', () => {
  it('sends the credential as a bearer token on every call', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]))
    await client(fetchImpl as unknown as typeof fetch).listRooms()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://backend.test/api/ai/chat/rooms')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-abc')
  })

  it('calls the same room routes the browser uses, not a parallel surface', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]))
    await client(fetchImpl as unknown as typeof fetch).listRooms()
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url).not.toContain('/internal/')
  })

  it('re-resolves the credential per request, so a rotation is picked up', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]))
    let current = 'first'
    const backend = new GroupChatBackend(target, async () => current, { fetchImpl: fetchImpl as unknown as typeof fetch })
    await backend.listRooms()
    current = 'second'
    await backend.listRooms()
    const tokenOf = (call: number) => {
      const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>
      return calls[call][1].headers as Record<string, string>
    }
    expect(tokenOf(0).authorization).toBe('Bearer first')
    expect(tokenOf(1).authorization).toBe('Bearer second')
  })

  it('refuses to send an anonymous request when no credential resolves', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]))
    const backend = new GroupChatBackend(target, async () => undefined, { fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(backend.listRooms()).rejects.toThrow(/no credential/u)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an HTML body instead of treating its characters as rooms', async () => {
    // A base URL pointing at a web app rather than its API answers 200 with the SPA
    // fallback. Iterating that string yields characters, and an unguarded caller opens
    // one session per character — which is what produced a `group-room-undefined`.
    const fetchImpl = vi.fn(async () => new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }))
    const backend = new GroupChatBackend(target, async () => 'token', { fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(backend.listRooms()).rejects.toThrow(/instead of a room list/u)
  })

  it('drops an entry with no usable id rather than opening a session for it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([
      { id: 'room-1', name: 'ok' },
      { name: 'no id' },
      null,
    ]))
    const backend = new GroupChatBackend(target, async () => 'token', { fetchImpl: fetchImpl as unknown as typeof fetch })
    const rooms = await backend.listRooms()
    expect(rooms.map((room) => room.id)).toEqual(['room-1'])
  })

  it('omits the query string when no cursor is given', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ events: [], nextCursor: null, hasMore: false }))
    await client(fetchImpl as unknown as typeof fetch).listEvents('room-1')
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url).toBe('http://backend.test/api/ai/chat/rooms/room-1/events')
  })

  it('passes the cursor through so a container resumes exactly once', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ events: [], nextCursor: '42', hasMore: false }))
    await client(fetchImpl as unknown as typeof fetch).listEvents('room-1', '42', 100)
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url).toContain('cursor=42')
    expect(url).toContain('limit=100')
  })

  it('encodes a room id rather than pasting it into the path', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]))
    await client(fetchImpl as unknown as typeof fetch).listMembers('room/../evil')
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url).toContain('room%2F..%2Fevil')
  })

  it('reuses the same rpcId on retry so the backend can deduplicate', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: '7', event: { type: 'user/message' }, deduplicated: false }))
    const backend = client(fetchImpl as unknown as typeof fetch)
    await backend.sendMessage('room-1', { content: 'hi', rpcId: 'rpc-1' })
    await backend.sendMessage('room-1', { content: 'hi', rpcId: 'rpc-1' })
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>
    const bodies = calls.map(([, init]) => JSON.parse(init.body as string))
    expect(bodies[0].rpcId).toBe('rpc-1')
    expect(bodies[1].rpcId).toBe('rpc-1')
  })
})

describe('GroupChatBackend error handling', () => {
  it('surfaces a backend refusal as BackendError with its status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: '你不是该群聊的成员。' }, 403))
    await expect(client(fetchImpl as unknown as typeof fetch).sendMessage('room-1', { content: 'x', rpcId: 'r' }))
      .rejects.toBeInstanceOf(BackendError)
  })

  it('treats a refused request as a decision, not a transport failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'nope' }, 404))
    const error = await client(fetchImpl as unknown as typeof fetch).listRooms().catch((e: unknown) => e)
    expect(isTransportFailure(error)).toBe(false)
  })

  it('treats an unreachable backend as a retryable transport failure', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') })
    const error = await client(fetchImpl as unknown as typeof fetch).listRooms().catch((e: unknown) => e)
    expect(isTransportFailure(error)).toBe(true)
  })

  it('does not blow up on a non-JSON error body', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>gateway</html>', { status: 502 }))
    const error = await client(fetchImpl as unknown as typeof fetch).listRooms().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BackendError)
    expect((error as BackendError).status).toBe(502)
  })
})


describe('whoami reads the account the server actually returns', () => {
  const jsonRes = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  it('unwraps the user envelope', async () => {
    // `/api/auth/me` answers `{ user: { id } }`. Reading `id` off the top level returns
    // undefined for every call, which leaves the workspace unidentified — and an
    // unidentified workspace records messages but never starts a turn, so the agent is
    // silent with nothing in the logs to explain it.
    const fetchImpl = (async () => jsonRes({ user: { id: 'u-1', displayName: 'Admin' } })) as unknown as typeof fetch
    const client = new GroupChatBackend(target, async () => 'token', { fetchImpl })
    // The name comes along because the browser shows it and the browser never talks to
    // DataOps itself — reading this route again from the client half would hand the page a
    // credential it is not supposed to hold.
    expect(await client.whoami()).toEqual({ id: 'u-1', displayName: 'Admin' })
  })

  it('reports the id alone when the server sends no name', async () => {
    // A missing name must not drop the identity: the side a message belongs on is decided
    // by id, and losing it would put the operator's own messages on the other side.
    const fetchImpl = (async () => jsonRes({ user: { id: 'u-1' } })) as unknown as typeof fetch
    const client = new GroupChatBackend(target, async () => 'token', { fetchImpl })
    expect(await client.whoami()).toEqual({ id: 'u-1' })
  })

  it('reports nothing when the envelope has no usable id', async () => {
    const fetchImpl = (async () => jsonRes({ user: {} })) as unknown as typeof fetch
    const client = new GroupChatBackend(target, async () => 'token', { fetchImpl })
    expect(await client.whoami()).toBeUndefined()
  })

  it('reports nothing rather than throwing when the call fails', async () => {
    // A failed identity lookup must not stop the workspace from recording messages.
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const client = new GroupChatBackend(target, async () => 'token', { fetchImpl })
    expect(await client.whoami()).toBeUndefined()
  })
})
