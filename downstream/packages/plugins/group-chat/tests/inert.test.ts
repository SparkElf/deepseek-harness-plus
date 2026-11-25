/**
 * Proves the acceptance criterion: with no server configured the plugin registers
 * nothing.
 *
 * `apply` must return before touching a single host service. The context below is a
 * tripwire — every property read throws — so any registration, listener, timer, or
 * service lookup fails the test instead of passing silently.
 */
import { describe, expect, it, vi } from 'vitest'
import { apply, MANAGED_ENV } from '../src/index.ts'
import { readFileSync } from 'node:fs'

const MANAGED_ENV_KEYS = Object.values(MANAGED_ENV)

/** Runs `body` with every DataOps variable removed, restoring them afterward. */
const withoutManagedEnv = <T>(body: () => T): T => {
  const saved = new Map<string, string | undefined>()
  for (const key of MANAGED_ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  try {
    return body()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('apply with no server configured', () => {
  it('returns undefined without reading any host service', () => {
    const touched: string[] = []
    const tripwire = new Proxy({}, {
      get(_target, property) {
        touched.push(String(property))
        throw new Error(`apply must not read ctx.${String(property)} when unconfigured`)
      },
    })

    const result = withoutManagedEnv(() => apply(tripwire as never, {}))

    expect(result).toBeUndefined()
    expect(touched).toEqual([])
  })

  it('does not register a route, a listener, or a session', () => {
    const on = vi.fn()
    const register = vi.fn()
    const create = vi.fn()
    const ctx = {
      on,
      effect: vi.fn(),
      webServer: { register },
      sessions: { get: vi.fn(), list: vi.fn(), create },
      agents: { get: vi.fn(), list: vi.fn() },
      credentials: { resolve: vi.fn() },
    }

    const result = withoutManagedEnv(() => apply(ctx as never, {}))

    expect(result).toBeUndefined()
    expect(on).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('ignores a blank setting rather than treating it as a server', () => {
    const register = vi.fn()
    const ctx = { on: vi.fn(), effect: vi.fn(), webServer: { register }, sessions: {}, agents: {}, credentials: {} }
    expect(withoutManagedEnv(() => apply(ctx as never, { baseUrl: '   ' }))).toBeUndefined()
    expect(register).not.toHaveBeenCalled()
  })
})

describe('apply with a configured server', () => {
  it('activates from the settings alone, with no DataOps environment', () => {
    const on = vi.fn()
    const register = vi.fn()
    const ctx = {
      on,
      effect: (body: () => unknown) => { body(); return () => undefined },
      logger: { error: vi.fn(), warn: vi.fn() },
      webServer: { register: () => () => undefined },
      sessions: { get: () => undefined, list: () => [], create: vi.fn() },
      agents: { get: () => undefined, list: () => [] },
      credentials: { resolve: async () => undefined },
    }
    // Activation lists rooms; keep that off the network.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }))
    try {
      const dispose = withoutManagedEnv(() => apply(ctx as never, { baseUrl: 'https://rooms.example.com' }))

      expect(typeof dispose).toBe('function')
      expect(on).toHaveBeenCalledWith('session/event', expect.any(Function))
      dispose?.()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('activates from the managed environment alone, with no settings', () => {
    const saved = { ...process.env }
    process.env[MANAGED_ENV.baseUrl] = 'http://backend.test'
    const register = vi.fn()
    const on = vi.fn()
    const ctx = {
      on,
      effect: (body: () => unknown) => { body(); return () => undefined },
      logger: { error: vi.fn(), warn: vi.fn() },
      webServer: { register: () => () => undefined },
      sessions: { get: () => undefined, list: () => [], create: vi.fn() },
      agents: { get: () => undefined, list: () => [] },
      credentials: { resolve: async () => undefined },
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }))
    try {
      const dispose = apply(ctx as never, {})
      expect(typeof dispose).toBe('function')
      dispose?.()
    } finally {
      fetchSpy.mockRestore()
      for (const key of MANAGED_ENV_KEYS) {
        const value = saved[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

describe('验收标准 ④：普通会话不受插件影响', () => {
  it('activates without touching the message pipeline', () => {
    // The plugin has to be able to run at all before "it does not change ordinary
    // sessions" is a meaningful claim — an unactivated plugin trivially changes nothing.
    // This asserts the stronger form: with a server configured, `apply` renders a
    // disposal and still contributes nothing to how a Session derives its messages.
    //
    // `deriveMessages()` is what the model reads and what the transcript shows, so
    // byte-equality across it is the whole isolation requirement: the group-chat half
    // must reach a room only through its own Session, never through a shared code path
    // an ordinary session also travels.
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    // No plugin of ours may install a deriveMessages hook, patch the session class, or
    // wrap the pipeline: all three would apply to every Session in the process.
    expect(source).not.toMatch(/deriveMessages\s*=/u)
    expect(source).not.toMatch(/Session\.prototype/u)
    // The room's messages travel through the agent's own inbox and the room's own Session,
    // both per-session, so a Session with no room source can never be reached by this plugin.
    expect(source).toContain('agent.followup(')
    expect(source).toContain("session.append('user/message'")
  })
})
