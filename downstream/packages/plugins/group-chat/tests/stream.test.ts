import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The stream is the push half of delivery: the poll is the fallback, so a socket that
 * silently stays down degrades latency rather than correctness. These assertions cover
 * the parts that failure mode depends on.
 */
const SOURCE = readFileSync(new URL('../src/stream.ts', import.meta.url), 'utf8')
const HOST = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

describe('room event stream', () => {
  it('targets the namespace and path the gateway serves', () => {
    // Mismatched here is invisible: the socket simply never connects, and the poll covers
    // it, so nothing looks broken while push delivery is entirely absent.
    expect(SOURCE).toContain("'/ai/chat/rooms/stream'")
    expect(SOURCE).toContain("'/ai-chat-rooms-stream-ws'")
  })

  it('re-follows every room after a reconnect', () => {
    // Membership is per socket on the server, so a reconnect starts a socket that follows
    // nothing. Re-sending on `connect` is what keeps push delivery alive past a blip.
    expect(SOURCE).toMatch(/on\('connect'[\s\S]{0,200}emit\('follow'/u)
  })

  it('ignores a malformed frame instead of delivering it', () => {
    // A frame without these fields would enter the tracker as an event with no id, and
    // the tracker de-duplicates on the id.
    expect(SOURCE).toMatch(/typeof payload\?\.id !== 'string'[\s\S]{0,120}return/u)
  })

  it('delivers into the same path the poll uses', () => {
    // Both faces call one sink, so the tracker sees each event once regardless of how it
    // arrived.
    expect(HOST).toContain('onEvent: (pushed) => deliver(')
  })

  it('follows a room before its session is built', () => {
    // An event that lands while the room is still opening would otherwise be dropped
    // before any runtime exists to receive it.
    const follow = HOST.indexOf('stream.follow(room.id)')
    const session = HOST.indexOf('sessions.ensure(')
    expect(follow).toBeGreaterThan(-1)
    expect(follow).toBeLessThan(session)
  })

  it('closes the socket when the plugin unloads', () => {
    // Left open, it keeps a connection and a reconnect timer alive past dispose, and
    // delivers into runtimes that no longer exist.
    expect(HOST).toMatch(/stream\.close\(\)[\s\S]{0,200}clearInterval/u)
  })

  it('shares one credential path with the REST client', () => {
    // A second credential mechanism would be a second thing to keep in step.
    expect(HOST).toContain('token: credential')
    expect(HOST).toContain('new GroupChatBackend(target, credential)')
  })
})

describe('host bundle carries its own dependencies', () => {
  it('does not import the socket library at runtime', () => {
    // The profile ships the platform's modules but not this package's dependencies, so an
    // external import fails at load — and a plugin that throws on load is absent rather
    // than visibly broken.
    const bundle = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    expect(bundle).not.toContain('from "socket.io-client"')
    expect(bundle).not.toContain("require('socket.io-client')")
  })
})
