import { describe, expect, it, vi } from 'vitest'
import { eventAuthor, eventText, GC_API, RoomError, listRooms, sendMessage, updateRoom } from '../src/client/api.ts'

describe('client transport', () => {
  it('calls the Host plugin route, never the server directly', async () => {
    // The browser must not know the server's address or hold a credential: the Host
    // forwards under the workspace identity, so both halves agree on who the caller is.
    expect(GC_API).toBe('/dsh-group-chat/api')
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchImpl)
    await listRooms()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.startsWith(GC_API)).toBe(true)
    // Same-origin credentials, so the request carries the browser session the Host
    // route is fenced to.
    expect(init.credentials).toBe('same-origin')
    vi.unstubAllGlobals()
  })

  it('sends the idempotency key so a retry cannot post twice', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchImpl)
    await sendMessage('room-1', 'hello', 'rpc-42')
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ content: 'hello', rpcId: 'rpc-42' })
    vi.unstubAllGlobals()
  })

  it('carries the third setting, which decides agent replies rather than access', async () => {
    // The three settings are independent: who may invite, who may find the room, and
    // what the room's agents answer. The third must reach the server or the container
    // keeps using the default and the toggle looks inert.
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchImpl)
    await updateRoom('room-1', { agentTrigger: 'always' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/rooms/room-1/update')
    expect(JSON.parse(String(init.body))).toEqual({ agentTrigger: 'always' })
    vi.unstubAllGlobals()
  })

  it('maps each failure to its own sentence rather than one generic error', async () => {
    // The Host answers 503 when it cannot resolve a credential, 404 when the server is
    // unset, and relays the server's 401 when the credential was refused. Each names a
    // different fix, so collapsing them would send the reader to the wrong place.
    const cases: readonly [number, string][] = [
      [503, 'credentialMissing'],
      [404, 'notConfigured'],
      [401, 'credentialRejected'],
      [403, 'credentialRejected'],
    ]
    for (const [status, message] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })))
      await expect(listRooms(), `status ${status}`).rejects.toMatchObject({ message })
    }
    vi.unstubAllGlobals()
  })

  it('reports a transport failure as unreachable instead of throwing the raw error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed to fetch') }))
    await expect(listRooms()).rejects.toBeInstanceOf(RoomError)
    vi.unstubAllGlobals()
  })
})

describe('event rendering helpers', () => {
  const record = (data: unknown) => ({ id: '1', event: { type: 'user/message', data } }) as never

  it('joins text blocks and ignores non-text ones', () => {
    expect(eventText(record({
      content: [
        { type: 'text', text: '你好' },
        { type: 'image', url: 'x' },
        { type: 'text', text: '，世界' },
      ],
    }))).toBe('你好，世界')
  })

  it('survives an event with no content at all', () => {
    expect(eventText(record({}))).toBe('')
    expect(eventText(record(undefined))).toBe('')
  })

  it('marks an agent reply so the page can distinguish it from a person', () => {
    expect(eventAuthor(record({ source: { authorKind: 'agent', memberName: '张三', isSelf: true } })))
      .toEqual({ name: '张三', isAgent: true, isSelf: true })
    expect(eventAuthor(record({ source: { authorKind: 'user', memberName: '李四' } })))
      .toEqual({ name: '李四', isAgent: false, isSelf: false })
  })

  it('names an unattributed event rather than rendering undefined', () => {
    expect(eventAuthor(record({})).name).toBe('—')
  })
})
