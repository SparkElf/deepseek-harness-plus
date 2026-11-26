import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CreateGuardianAgentInput,
  GuardianAgentRef,
  GuardianSessionHost,
} from '../src/guardianSession.ts'
import {
  IDLE_DEBOUNCE_MS,
  installMemoryTriggers,
  type MemoryTriggerEvent,
  type MemoryTriggerSession,
  type MemoryTriggerTimers,
} from '../src/memoryTriggers.ts'

/** Deterministic timer queue: time only moves when a test advances it. */
class ManualTimers implements MemoryTriggerTimers {
  private nextId = 1
  private readonly tasks = new Map<number, { at: number; callback: () => void }>()
  now = 0

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId
    this.nextId += 1
    this.tasks.set(id, { at: this.now + ms, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number)
  }

  get size(): number {
    return this.tasks.size
  }

  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      let dueId: number | undefined
      let dueAt = Number.POSITIVE_INFINITY
      for (const [id, task] of this.tasks) {
        if (task.at <= target && task.at < dueAt) {
          dueAt = task.at
          dueId = id
        }
      }
      if (dueId === undefined) break
      const task = this.tasks.get(dueId)!
      this.tasks.delete(dueId)
      this.now = task.at
      task.callback()
    }
    this.now = target
  }
}

class FakeEvents {
  private readonly listeners = new Set<(session: MemoryTriggerSession, event: MemoryTriggerEvent) => void>()

  onSessionEvent(listener: (session: MemoryTriggerSession, event: MemoryTriggerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(id: string, event: MemoryTriggerEvent): void {
    for (const listener of [...this.listeners]) listener({ id }, event)
  }

  get size(): number {
    return this.listeners.size
  }
}

class FakeGuardianHost implements GuardianSessionHost {
  readonly usersRoot: string
  cwd = '/workspace'
  readonly agents = new Map<string, GuardianAgentRef>()
  readonly deliveries: Array<{ sessionId: string; text: string }> = []
  readonly created: CreateGuardianAgentInput[] = []

  constructor(usersRoot: string) {
    this.usersRoot = usersRoot
  }

  getAgent(sessionId: string): GuardianAgentRef | undefined {
    return this.agents.get(sessionId)
  }

  async createAgent(input: CreateGuardianAgentInput): Promise<GuardianAgentRef> {
    this.created.push(input)
    const agent: GuardianAgentRef = { id: input.sessionId, status: 'idle' }
    this.agents.set(input.sessionId, agent)
    return agent
  }

  async resumeAgent(input: { sessionId: string }): Promise<GuardianAgentRef> {
    const agent: GuardianAgentRef = { id: input.sessionId, status: 'idle' }
    this.agents.set(input.sessionId, agent)
    return agent
  }

  async deliverText(agent: GuardianAgentRef, text: string): Promise<{ delivered: boolean; queued: boolean }> {
    this.deliveries.push({ sessionId: agent.id, text })
    return { delivered: true, queued: false }
  }

  newSessionId(): string {
    return 'session-guardian-1'
  }

  get messages(): string[] {
    return this.deliveries.map(item => item.text)
  }
}

/** Let real filesystem I/O from guardian.json settle (trigger timers stay injected). */
const settle = async (ms = 25): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await settle(10)
  }
}

interface Harness {
  root: string
  timers: ManualTimers
  events: FakeEvents
  guardian: FakeGuardianHost
  dispose: () => void
}

async function makeHarness(options: {
  guardianSessions?: string[]
  idleMs?: number
  isGuardianSession?: (sessionId: string) => Promise<boolean>
  resolveUserId?: () => Promise<string>
  isEnabled?: (userId: string) => Promise<boolean> | boolean
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'kb-memory-triggers-'))
  const timers = new ManualTimers()
  const events = new FakeEvents()
  const guardian = new FakeGuardianHost(join(root, 'users'))
  const guardianSessions = new Set(options.guardianSessions ?? [])
  const dispose = installMemoryTriggers({
    resolveUserId: options.resolveUserId ?? (async () => 'u1'),
    ...(options.isEnabled === undefined ? {} : { isEnabled: options.isEnabled }),
    isGuardianSession: options.isGuardianSession ?? (async sessionId => guardianSessions.has(sessionId)),
    onSessionEvent: listener => events.onSessionEvent(listener),
    guardian,
    timers,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  })
  return { root, timers, events, guardian, dispose }
}

describe('memory triggers', () => {
  const harnesses: Harness[] = []

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      harness.dispose()
      await settle()
      await rm(harness.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    }
  })

  async function setup(options: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> {
    const harness = await makeHarness(options)
    harnesses.push(harness)
    return harness
  }

  it('resolves the owner when the session event arrives, not when the idle timer fires', async () => {
    let calls = 0
    const { timers, events, guardian } = await setup({
      idleMs: 1000,
      resolveUserId: async () => {
        calls += 1
        return 'u1'
      },
    })

    events.emit('session-a', { type: 'turn/end' })
    await settle()
    // The owner is resolved while the request still has caller context.
    expect(calls).toBe(1)
    expect(guardian.messages).toHaveLength(0)

    timers.advance(1000)
    await settle()
    await waitFor(() => guardian.messages.length === 2, 'seed + idle message')
    expect(calls).toBe(1)
    expect(guardian.messages[1]).toContain('reason=idle')
  })

  it('does not send idle or compaction messages while memory is paused', async () => {
    const { timers, events, guardian } = await setup({
      idleMs: 1000,
      isEnabled: async () => false,
    })
    events.emit('session-a', { type: 'turn/end' })
    await settle()
    timers.advance(1000)
    await settle()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(guardian.messages).toHaveLength(0)

    events.emit('session-a', { type: 'compaction/start', data: { compactionId: 'c1' } })
    await settle()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(guardian.messages).toHaveLength(0)
  })

  it('debounces idle: turn/end arms 30 minutes, activity clears and rearms', async () => {
    const { timers, events, guardian } = await setup()

    events.emit('session-a', { type: 'turn/end' })
    await settle()
    expect(timers.size).toBe(1)

    // Activity after turn/end clears the timer: not idle any more.
    timers.advance(10 * 60 * 1000)
    await settle()
    expect(guardian.messages).toHaveLength(0)
    events.emit('session-a', { type: 'turn/start' })
    await settle()
    expect(timers.size).toBe(0)
    timers.advance(31 * 60 * 1000)
    await settle()
    expect(guardian.messages).toHaveLength(0)

    // A later turn/end arms a fresh 30-minute window.
    events.emit('session-a', { type: 'turn/end' })
    await settle()
    timers.advance(IDLE_DEBOUNCE_MS - 60 * 1000)
    await settle()
    expect(guardian.messages).toHaveLength(0)
    timers.advance(2 * 60 * 1000)
    await settle()

    await waitFor(() => guardian.messages.length === 2, 'seed + idle message')
    expect(guardian.messages[1]).toContain('reason=idle')
    expect(guardian.messages[1]).toContain('sourceSession: session-a')

    // One message per idle window; there is no cron and no repeating timer.
    timers.advance(4 * 60 * 60 * 1000)
    await settle()
    expect(guardian.messages).toHaveLength(2)
    expect(timers.size).toBe(0)
  })

  it('keeps independent timers per ordinary session', async () => {
    const { timers, events, guardian } = await setup({ idleMs: 1000 })
    events.emit('session-a', { type: 'turn/end' })
    events.emit('session-b', { type: 'turn/end' })
    await settle()
    expect(timers.size).toBe(2)

    timers.advance(1000)
    await waitFor(
      () => guardian.messages.filter(text => text.includes('reason=idle')).length === 2,
      'two idle messages',
    )
    expect(guardian.messages.some(text => text.includes('sourceSession: session-a'))).toBe(true)
    expect(guardian.messages.some(text => text.includes('sourceSession: session-b'))).toBe(true)
  })

  it('ignores guardian sessions', async () => {
    const { timers, events, guardian } = await setup({ guardianSessions: ['session-guardian-1'], idleMs: 1000 })

    events.emit('session-guardian-1', { type: 'turn/end' })
    await settle()
    expect(timers.size).toBe(0)

    timers.advance(2 * 60 * 60 * 1000)
    await settle()
    expect(guardian.messages).toHaveLength(0)

    // Compaction of the guardian must not wake the guardian either.
    events.emit('session-guardian-1', { type: 'compaction/start', data: { compactionId: 'c1', turn: null } })
    await settle()
    expect(guardian.messages).toHaveLength(0)
  })

  it('sends one compaction message per compaction id without blocking', async () => {
    const { timers, events, guardian } = await setup()

    events.emit('session-a', { type: 'compaction/start', data: { compactionId: 'compaction-1', turn: 4 } })
    await waitFor(() => guardian.messages.length === 2, 'seed + compaction message')
    expect(guardian.messages[1]).toContain('reason=compaction')
    expect(guardian.messages[1]).toContain('compactionId: compaction-1')
    expect(guardian.messages[1]).toContain('sourceSession: session-a')

    // A repeated event with the same id is not sent twice.
    events.emit('session-a', { type: 'compaction/start', data: { compactionId: 'compaction-1', turn: 4 } })
    await settle()
    expect(guardian.messages).toHaveLength(2)

    events.emit('session-a', { type: 'compaction/start', data: { compactionId: 'compaction-2', turn: 5 } })
    await waitFor(() => guardian.messages.length === 3, 'second compaction message')

    // Compaction is activity, so an idle timer was armed but not fired yet.
    expect(timers.size).toBe(1)
    timers.advance(IDLE_DEBOUNCE_MS)
    await waitFor(() => guardian.messages.length === 4, 'post-compaction idle message')
    expect(guardian.messages[3]).toContain('reason=idle')
  })

  it('fails closed when guardian identity cannot be checked', async () => {
    const { timers, events, guardian } = await setup({
      idleMs: 1000,
      isGuardianSession: async () => { throw new Error('state unreadable') },
    })
    events.emit('session-a', { type: 'turn/end' })
    await settle()
    expect(timers.size).toBe(0)
    timers.advance(60 * 60 * 1000)
    await settle()
    expect(guardian.messages).toHaveLength(0)
  })

  it('dispose clears timers and unsubscribes', async () => {
    const harness = await setup({ idleMs: 1000 })
    harness.events.emit('session-a', { type: 'turn/end' })
    await settle()
    expect(harness.timers.size).toBe(1)

    harness.dispose()
    expect(harness.timers.size).toBe(0)
    expect(harness.events.size).toBe(0)

    harness.timers.advance(60 * 60 * 1000)
    await settle()
    expect(harness.guardian.messages).toHaveLength(0)

    // Disposing twice is harmless.
    harness.dispose()
  })
})
