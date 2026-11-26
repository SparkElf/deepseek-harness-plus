import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KB_TOOL_ACCESS } from '../src/toolDisclosure.ts'
import {
  GUARDIAN_SESSION_TITLE,
  GuardianSessionStore,
  type CreateGuardianAgentInput,
  type GuardianAgentRef,
  type GuardianSessionHost,
} from '../src/guardianSession.ts'
import {
  createMemoryGuardianTools,
  type MemoryGuardianSendValue,
} from '../src/memoryGuardianTool.ts'

class FakeGuardianHost implements GuardianSessionHost {
  readonly usersRoot: string
  cwd = '/workspace'
  readonly agents = new Map<string, GuardianAgentRef>()
  readonly created: CreateGuardianAgentInput[] = []
  readonly deliveries: Array<{ sessionId: string; text: string }> = []
  queued = false
  nextSessionId = 'session-guardian-1'

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
    return { delivered: true, queued: this.queued }
  }

  newSessionId(): string {
    return this.nextSessionId
  }
}

const toolCall = {} as never

describe('memory_guardian_send tool', () => {
  let root: string
  let host: FakeGuardianHost

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-guardian-tool-'))
    host = new FakeGuardianHost(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('is disclosed to readers and requires only the knowledge-base read key', () => {
    expect(KB_TOOL_ACCESS.memory_guardian_send).toEqual({
      group: 'read',
      permissions: ['kb:file:read'],
    })
  })

  it('sends to the caller\'s own guardian and returns a short delivery result', async () => {
    const [tool] = createMemoryGuardianTools({ resolveCaller: async () => ({ userId: 'u1' }), guardian: host })
    expect(tool?.name).toBe('memory_guardian_send')

    const result = await tool!.execute(
      { reason: 'idle', sessionId: 'session-a', note: '17 minutes idle' },
      toolCall,
    ) as unknown as MemoryGuardianSendValue

    expect(result).toMatchObject({
      ok: true,
      reason: 'idle',
      delivered: true,
      queued: false,
      sessionId: 'session-guardian-1',
      created: true,
    })
    expect(JSON.parse(result.rendered)).toMatchObject({
      reason: 'idle',
      sessionId: 'session-guardian-1',
    })

    // The guardian truly belongs to the caller: state is under u1, never a target user.
    expect((await new GuardianSessionStore(root).read('u1'))?.sessionId).toBe('session-guardian-1')
    expect(await new GuardianSessionStore(root).read('u2')).toBeUndefined()
    expect(host.created).toHaveLength(1)
    expect(host.created[0]?.title).toBe(GUARDIAN_SESSION_TITLE)
    expect(host.deliveries.at(-1)?.text).toContain('sourceSession: session-a')
    expect(host.deliveries.at(-1)?.text).toContain('note: 17 minutes idle')
  })

  it('reports queued when the guardian is already running a turn', async () => {
    host.queued = true
    const [tool] = createMemoryGuardianTools({ resolveCaller: async () => ({ userId: 'u1' }), guardian: host })
    const result = await tool!.execute({ reason: 'dream' }, toolCall) as unknown as MemoryGuardianSendValue
    expect(result).toMatchObject({ delivered: true, queued: true, reason: 'dream' })
  })

  it('rejects requests while memory is paused', async () => {
    const [tool] = createMemoryGuardianTools({
      resolveCaller: async () => ({ userId: 'u1' }),
      guardian: host,
      isEnabled: async () => false,
    })
    await expect(tool!.execute({ reason: 'manual', note: '记住这个' }, toolCall)).rejects.toMatchObject({
      name: 'KnowledgeToolError',
      code: 'forbidden',
    })
    expect(host.created).toHaveLength(0)
  })

  it('rejects an unknown reason and an unauthenticated caller', async () => {
    const [tool] = createMemoryGuardianTools({ resolveCaller: async () => ({ userId: 'u1' }), guardian: host })
    await expect(tool!.execute({ reason: 'cron' }, toolCall)).rejects.toMatchObject({
      name: 'KnowledgeToolError',
      code: 'invalid',
    })
    expect(host.created).toHaveLength(0)

    const [anonymous] = createMemoryGuardianTools({ resolveCaller: async () => ({ userId: '  ' }), guardian: host })
    await expect(anonymous!.execute({ reason: 'manual' }, toolCall)).rejects.toMatchObject({
      name: 'KnowledgeToolError',
      code: 'unauthorized',
    })
    expect(host.created).toHaveLength(0)
  })

  it('validates optional context fields', async () => {
    const [tool] = createMemoryGuardianTools({ resolveCaller: async () => ({ userId: 'u1' }), guardian: host })
    await expect(tool!.execute({ reason: 'idle', sessionId: 'x'.repeat(201) }, toolCall)).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(tool!.execute({ reason: 'idle', note: 'x'.repeat(2001) }, toolCall)).rejects.toMatchObject({
      code: 'invalid',
    })
  })
})
