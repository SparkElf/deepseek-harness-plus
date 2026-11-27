import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  createDshGroupSessionBranches,
  createDshGroupTurnActors,
  GROUP_PENDING_ACTOR,
  installGroupCredentialScope,
  resolveServiceCredential,
} from '../../src/connector/group-turn-actor.ts'

interface FakeSession {
  id: string
  actor?: unknown
  header?: { parentSession?: unknown }
  log?: { seq: number }[]
}

/** 最小 DSH 上下文：credentials + sessions + agents.currentInitiator。 */
function fakeContext(options: { initiator?: string; sessions?: FakeSession[]; values?: Record<string, string> } = {}): {
  ctx: Context
  credentials: {
    resolve(ref: unknown): Promise<{ value: string; source: string } | undefined>
    set(ref: unknown, value: string): Promise<void>
    unset(ref: unknown): Promise<void>
    values: Map<string, string>
  }
  sessions: Map<string, FakeSession>
  setInitiator(id: string | undefined): void
} {
  const values = new Map(Object.entries(options.values ?? { DATAOPS_ACCESS_TOKEN: 'bot-workspace-jwt' }))
  const credentials = {
    values,
    async resolve(ref: unknown) {
      const value = values.get(String(ref))
      return value === undefined ? undefined : { value, source: 'test' }
    },
    async set(ref: unknown, value: string) { values.set(String(ref), value) },
    async unset(ref: unknown) { values.delete(String(ref)) },
  }
  const sessions = new Map((options.sessions ?? [{ id: 'shared-1' }]).map(session => [session.id, session]))
  let initiator = options.initiator
  const ctx = {
    credentials,
    sessions: {
      get: (id: unknown) => sessions.get(String(id)),
      fork: (source: unknown, boundary?: number) => {
        const parent = sessions.get(String(source))
        const id = `fork-${sessions.size + 1}`
        const child: FakeSession = {
          id,
          log: parent?.log === undefined ? [] : parent.log.slice(0, (boundary ?? parent.log.length - 1) + 1),
          ...(parent === undefined ? {} : { header: { parentSession: parent.id } }),
        }
        sessions.set(id, child)
        return child
      },
    },
    sessionTitle: { rename: () => undefined },
    agents: { currentInitiator: () => initiator === undefined ? undefined : { session: sessions.get(initiator) } },
  } as unknown as Context
  return {
    ctx,
    credentials,
    sessions,
    setInitiator(id: string | undefined) { initiator = id },
  }
}

describe('group credential scope', () => {
  it('returns the sender scoped token for native tools during a group turn', async () => {
    const { ctx, credentials, setInitiator } = fakeContext({ initiator: 'shared-1' })
    const actors = createDshGroupTurnActors(ctx, 'DATAOPS_ACCESS_TOKEN')
    await actors.ensurePlaceholder('shared-1')
    await actors.activate('shared-1', { userId: 'user-a' }, 'sender-a-jwt')
    const dispose = installGroupCredentialScope(ctx, 'DATAOPS_ACCESS_TOKEN')
    try {
      await expect(credentials.resolve('DATAOPS_ACCESS_TOKEN')).resolves.toEqual({ value: 'sender-a-jwt', source: 'group-turn-actor' })
      // 工作区凭据本身没有被改写，只在群 turn 的解析路径上被替换。
      expect(credentials.values.get('DATAOPS_ACCESS_TOKEN')).toBe('bot-workspace-jwt')
    } finally {
      dispose()
    }
    expect(credentials.values.get('DATAOPS_ACCESS_TOKEN')).toBe('bot-workspace-jwt')
  })

  it('fails closed as not_authorized when a group turn has no active sender credential', async () => {
    const { ctx, setInitiator } = fakeContext({ initiator: 'shared-1' })
    const actors = createDshGroupTurnActors(ctx, 'DATAOPS_ACCESS_TOKEN')
    await actors.ensurePlaceholder('shared-1')
    const dispose = installGroupCredentialScope(ctx, 'DATAOPS_ACCESS_TOKEN')
    try {
      await expect(ctx.credentials.resolve('DATAOPS_ACCESS_TOKEN' as never)).rejects.toThrow(/not_authorized/u)
    } finally {
      dispose()
    }
  })

  it('uses the group turn credential for a subagent whose parent chain reaches the group session', async () => {
    const { ctx, credentials, sessions, setInitiator } = fakeContext({
      initiator: 'subagent-1',
      sessions: [
        { id: 'shared-1' },
        { id: 'subagent-1', header: { parentSession: 'shared-1' } },
      ],
    })
    const actors = createDshGroupTurnActors(ctx, 'DATAOPS_ACCESS_TOKEN')
    await actors.ensurePlaceholder('shared-1')
    await actors.activate('shared-1', { userId: 'user-a' }, 'sender-a-jwt')
    const dispose = installGroupCredentialScope(ctx, 'DATAOPS_ACCESS_TOKEN')
    try {
      await expect(credentials.resolve('DATAOPS_ACCESS_TOKEN')).resolves.toMatchObject({ value: 'sender-a-jwt' })
    } finally {
      dispose()
    }
    expect(sessions.get('subagent-1')?.header?.parentSession).toBe('shared-1')
    setInitiator('shared-1')
  })

  it('keeps connector service calls on the bot token even inside a group session with no active actor', async () => {
    const { ctx, credentials } = fakeContext({ initiator: 'shared-1' })
    const actors = createDshGroupTurnActors(ctx, 'DATAOPS_ACCESS_TOKEN')
    await actors.ensurePlaceholder('shared-1')
    const dispose = installGroupCredentialScope(ctx, 'DATAOPS_ACCESS_TOKEN')
    try {
      // agent 工具路径：fail closed。
      await expect(credentials.resolve('DATAOPS_ACCESS_TOKEN')).rejects.toThrow(/not_authorized/u)
      // connector 服务路径：始终使用包装前的原始 resolve。
      await expect(resolveServiceCredential(ctx, 'DATAOPS_ACCESS_TOKEN')).resolves.toEqual({
        value: 'bot-workspace-jwt',
        source: 'test',
      })
    } finally {
      dispose()
    }
  })

  it('leaves ordinary web sessions on the workspace credential', async () => {
    const { ctx, credentials } = fakeContext({ initiator: 'web-session', sessions: [{ id: 'web-session' }] })
    const dispose = installGroupCredentialScope(ctx, 'DATAOPS_ACCESS_TOKEN')
    try {
      await expect(credentials.resolve('DATAOPS_ACCESS_TOKEN')).resolves.toMatchObject({ value: 'bot-workspace-jwt' })
    } finally {
      dispose()
    }
  })
})

describe('group session branches', () => {
  it('forks from the requested prefix and registers the child as a managed group session', async () => {
    const { ctx, sessions } = fakeContext({
      sessions: [{ id: 'shared-1', log: [{ seq: 0 }, { seq: 1 }, { seq: 2 }] }],
    })
    const branches = createDshGroupSessionBranches(ctx)
    expect(branches.lastSeq('shared-1')).toBe(2)
    const child = await branches.fork('shared-1', 1)
    expect(child).toBe('fork-2')
    expect(sessions.get(child)?.log?.map(event => event.seq)).toEqual([0, 1])
    expect(sessions.get(child)?.actor).toEqual(GROUP_PENDING_ACTOR)
  })

  it('fails closed when the DSH store has no fork seam', async () => {
    const { ctx } = fakeContext()
    ;(ctx as unknown as { sessions: { fork?: unknown } }).sessions.fork = undefined
    const branches = createDshGroupSessionBranches(ctx)
    await expect(branches.fork('shared-1')).rejects.toThrow(/fork/u)
  })
})