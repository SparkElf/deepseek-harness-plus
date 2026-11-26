import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GUARDIAN_SESSION_TITLE,
  GUARDIAN_SKILL_NAME,
  GuardianSessionStore,
  GuardianTimeoutError,
  renderGuardianMessage,
  resolveOrCreateGuardian,
  sendToGuardian,
  type CreateGuardianAgentInput,
  type GuardianAgentRef,
  type GuardianSessionHost,
  type GuardianSessionState,
} from '../src/guardianSession.ts'

class FakeGuardianHost implements GuardianSessionHost {
  readonly usersRoot: string
  cwd = '/workspace'
  readonly agents = new Map<string, GuardianAgentRef>()
  readonly created: CreateGuardianAgentInput[] = []
  readonly resumed: string[] = []
  readonly deliveries: Array<{ sessionId: string; text: string }> = []
  readonly titleCalls: string[] = []
  readonly titleLookups: string[] = []
  queued = false
  timeoutMs: number | undefined
  createHangs = false
  deliverHangs = false
  resumeFails = false
  nextSessionId = 'session-guardian-1'
  findByTitleResult: string | undefined

  constructor(usersRoot: string) {
    this.usersRoot = usersRoot
  }

  getAgent(sessionId: string): GuardianAgentRef | undefined {
    return this.agents.get(sessionId)
  }

  async createAgent(input: CreateGuardianAgentInput): Promise<GuardianAgentRef> {
    this.created.push(input)
    if (this.createHangs) return new Promise(() => {})
    const agent: GuardianAgentRef = { id: input.sessionId, status: 'idle' }
    this.agents.set(input.sessionId, agent)
    return agent
  }

  async resumeAgent(input: { sessionId: string }): Promise<GuardianAgentRef> {
    this.resumed.push(input.sessionId)
    if (this.resumeFails) throw new Error('session persistence was deleted')
    const agent: GuardianAgentRef = { id: input.sessionId, status: 'idle' }
    this.agents.set(input.sessionId, agent)
    return agent
  }

  async deliverText(agent: GuardianAgentRef, text: string): Promise<{ delivered: boolean; queued: boolean }> {
    this.deliveries.push({ sessionId: agent.id, text })
    if (this.deliverHangs) return new Promise(() => {})
    return { delivered: true, queued: this.queued }
  }

  async findByTitle(title: string): Promise<string | undefined> {
    this.titleLookups.push(title)
    return this.findByTitleResult
  }

  newSessionId(): string {
    return this.nextSessionId
  }

  async setTitle(_agent: GuardianAgentRef, title: string): Promise<void> {
    this.titleCalls.push(title)
  }
}

function state(userId: string, sessionId: string): GuardianSessionState {
  return {
    version: 1,
    userId,
    sessionId,
    title: GUARDIAN_SESSION_TITLE,
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
  }
}

describe('GuardianSessionStore', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-guardian-session-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('round-trips guardian.json and refuses unsafe user ids', async () => {
    const store = new GuardianSessionStore(root)
    const expected = state('u1', 'session-g1')
    await store.write(expected)

    expect(store.filePath('u1')).toBe(join(root, 'u1', 'guardian.json'))
    expect(await store.read('u1')).toEqual(expected)
    const raw = JSON.parse(await readFile(store.filePath('u1'), 'utf8')) as Record<string, unknown>
    expect(raw.sessionId).toBe('session-g1')
    expect(raw.title).toBe(GUARDIAN_SESSION_TITLE)

    await expect(store.write(state('../escape', 'session-x'))).rejects.toThrow()
    await store.remove('u1')
    expect(await store.read('u1')).toBeUndefined()
    await expect(store.remove('u1')).resolves.toBeUndefined()
  })

  it('finds a session id across users and forgets removed ones', async () => {
    const store = new GuardianSessionStore(root)
    await store.write(state('u1', 'session-g1'))
    await store.write(state('u2', 'session-g2'))

    expect(await store.isGuardianSession('session-g1')).toBe(true)
    expect(await store.isGuardianSession('session-g2')).toBe(true)
    expect(await store.isGuardianSession('session-other')).toBe(false)

    await store.remove('u2')
    expect(await store.isGuardianSession('session-g2')).toBe(false)
  })
})

describe('resolveOrCreateGuardian / sendToGuardian', () => {
  let root: string
  let host: FakeGuardianHost

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-guardian-send-'))
    host = new FakeGuardianHost(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('creates one standard-mode guardian lazily and reuses it for later messages', async () => {
    const first = await sendToGuardian(host, 'u1', { reason: 'idle', sessionId: 'session-a' })
    expect(first).toEqual({
      delivered: true,
      queued: false,
      sessionId: 'session-guardian-1',
      created: true,
    })

    // Exactly one session was created, with no agent preset in the seam input.
    expect(host.created).toEqual([{
      sessionId: 'session-guardian-1',
      cwd: '/workspace',
      title: GUARDIAN_SESSION_TITLE,
    }])
    // Seed first, then the actual trigger message.
    expect(host.deliveries).toHaveLength(2)
    expect(host.deliveries[0]?.text).toContain(GUARDIAN_SKILL_NAME)
    expect(host.deliveries[0]?.text).toContain('dream')
    expect(host.deliveries[1]?.text).toContain('reason=idle')
    expect(host.deliveries[1]?.text).toContain('sourceSession: session-a')
    expect(host.titleCalls).toEqual([GUARDIAN_SESSION_TITLE])

    const persisted = await new GuardianSessionStore(root).read('u1')
    expect(persisted?.sessionId).toBe('session-guardian-1')

    const second = await sendToGuardian(host, 'u1', { reason: 'dream' })
    expect(second.created).toBe(false)
    expect(second.sessionId).toBe('session-guardian-1')
    expect(host.created).toHaveLength(1) // never a new guardian per message
    expect(host.resumed).toHaveLength(0) // live agent reused directly
    expect(host.deliveries).toHaveLength(3)
  })

  it('resumes a persisted guardian instead of creating another', async () => {
    await new GuardianSessionStore(root).write(state('u1', 'session-existing'))

    const result = await sendToGuardian(host, 'u1', { reason: 'manual', note: 'check preferences' })
    expect(result).toMatchObject({ created: false, sessionId: 'session-existing', delivered: true })
    expect(host.resumed).toEqual(['session-existing'])
    expect(host.created).toEqual([])
    expect(host.deliveries).toHaveLength(1)
    expect(host.deliveries[0]?.text).toContain('reason=manual')
    expect(host.deliveries[0]?.text).toContain('note: check preferences')
  })

  it('recreates a stale/deleted session and updates guardian.json', async () => {
    await new GuardianSessionStore(root).write(state('u1', 'session-old'))
    host.resumeFails = true
    host.nextSessionId = 'session-new'

    const result = await sendToGuardian(host, 'u1', { reason: 'idle', sessionId: 'session-a' })
    expect(result).toMatchObject({ created: true, sessionId: 'session-new' })
    expect(host.resumed).toEqual(['session-old'])
    expect(host.created).toHaveLength(1)
    expect(host.created[0]?.sessionId).toBe('session-new')
    expect((await new GuardianSessionStore(root).read('u1'))?.sessionId).toBe('session-new')
    // The new session gets the seed and the trigger message.
    expect(host.deliveries.map(item => item.sessionId)).toEqual(['session-new', 'session-new'])
  })

  it('adopts a unique title match when guardian.json was lost', async () => {
    host.findByTitleResult = 'session-titled'

    const result = await sendToGuardian(host, 'u1', { reason: 'compaction', sessionId: 'session-a', compactionId: 'c1' })
    expect(result).toMatchObject({ created: false, sessionId: 'session-titled' })
    expect(host.titleLookups).toEqual([GUARDIAN_SESSION_TITLE])
    expect(host.resumed).toEqual(['session-titled'])
    expect(host.created).toEqual([])
    expect((await new GuardianSessionStore(root).read('u1'))?.sessionId).toBe('session-titled')
  })

  it('single-flights concurrent first messages so only one guardian is created', async () => {
    const [idle, compaction] = await Promise.all([
      sendToGuardian(host, 'u1', { reason: 'idle', sessionId: 'session-a' }),
      sendToGuardian(host, 'u1', { reason: 'compaction', sessionId: 'session-a', compactionId: 'c1' }),
    ])
    expect(host.created).toHaveLength(1)
    expect(idle.sessionId).toBe(compaction.sessionId)
    expect(idle.sessionId).toBe('session-guardian-1')
    // One seed, then one message per trigger.
    expect(host.deliveries.filter(item => item.text.includes('第一步：阅读'))).toHaveLength(1)
    expect(host.deliveries).toHaveLength(3)
  })

  it('reports queued delivery while the guardian is busy', async () => {
    host.queued = true
    const result = await sendToGuardian(host, 'u1', { reason: 'idle', sessionId: 'session-a' })
    expect(result.queued).toBe(true)
    expect(result.delivered).toBe(true)
  })

  it('renders compaction context without owning a second queue', () => {
    const text = renderGuardianMessage({
      reason: 'compaction',
      sessionId: 'session-a',
      compactionId: 'compaction-9',
      note: 'context shortened',
    })
    expect(text).toContain('reason=compaction')
    expect(text).toContain('sourceSession: session-a')
    expect(text).toContain('compactionId: compaction-9')
    expect(text).toContain('note: context shortened')
    expect(text).toContain(GUARDIAN_SKILL_NAME)
    expect(text).not.toContain('queue')
  })

  it('resolveOrCreateGuardian returns the live agent without resuming', async () => {
    host.agents.set('session-live', { id: 'session-live', status: 'running' })
    await new GuardianSessionStore(root).write(state('u1', 'session-live'))

    const resolved = await resolveOrCreateGuardian(host, 'u1')
    expect(resolved).toMatchObject({ created: false })
    expect(resolved.agent.id).toBe('session-live')
    expect(host.resumed).toHaveLength(0)
    expect(host.created).toHaveLength(0)
  })

  it('bounds a hung guardian creation with a structured timeout', async () => {
    host.timeoutMs = 20
    host.createHangs = true

    await expect(sendToGuardian(host, 'u1', { reason: 'idle', sessionId: 'session-a' }))
      .rejects.toBeInstanceOf(GuardianTimeoutError)
  })

  it('bounds a hung guardian delivery with a structured timeout', async () => {
    host.timeoutMs = 20
    host.agents.set('session-live', { id: 'session-live', status: 'idle' })
    await new GuardianSessionStore(root).write(state('u1', 'session-live'))
    host.deliverHangs = true

    await expect(sendToGuardian(host, 'u1', { reason: 'manual' }))
      .rejects.toMatchObject({ name: 'GuardianTimeoutError', code: 'unreachable' })
  })
})
