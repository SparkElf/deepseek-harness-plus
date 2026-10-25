import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentCancelCause, InboxTarget } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { registerScheduleTools } from '../src/tools.ts'
import type { ScheduleAccessConfig } from '../src/types.ts'

const signal = new AbortController().signal
const contexts: Context[] = []
const roots: string[] = []

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly followups: UserMessage[]
  readonly disposeTools: () => void
}

function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  return {
    id: session.id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: new Context(),
    send(_message: UserMessage, _target: InboxTarget, _wakeup: boolean) {},
    runMaintenance: task => task(signal),
    cancel(_cause: AgentCancelCause) {},
    whenIdle: () => Promise.resolve(),
    followup(message: UserMessage) { followups.push(message) },
    steer(_message: UserMessage) {},
    inject(_message: UserMessage) {},
  }
}

const followups: UserMessage[] = []

async function harness(
  options: {
    access?: ScheduleAccessConfig
    approval?: 'allow' | 'reject' | 'none'
    persistence?: boolean
  } = {},
): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  ctx.on('session/flush', async () => {})
  if (options.persistence === true) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-management-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  }
  const approval = options.approval ?? 'allow'
  if (approval !== 'none') {
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>(
      approval === 'allow' ? 'allowed-once' : 'rejected',
    ))
  }
  const agent = stubAgent(ctx, `schedule-management-${Math.random()}`)
  ctx.agents.register(agent)
  agent.session.append('turn/start', { turn: 1 })
  const disposeTools = registerScheduleTools(ctx, ctx, agent, () => {}, options.access ?? {})
  return { ctx, agent, followups, disposeTools }
}

async function execute(
  test: Harness,
  name: string,
  args: unknown,
  agent: Agent = test.agent,
): Promise<ToolExecutionResult> {
  return test.ctx.agents.withInitiator(agent, () => test.ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${Math.random()}`),
    name,
    arguments: args,
    agent,
  }))
}

function value(result: ToolExecutionResult): unknown {
  if (result.isError) throw new Error('tool error: ' + JSON.stringify(result.content))
  expect(result.isError).toBe(false)
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected deterministic text content')
  expect(JSON.parse(block.text)).toEqual(result.value)
  return result.value
}

async function storeSession(
  ctx: Context,
  id: string,
  events: Array<{ type: 'schedule/change'; data: unknown }>,
): Promise<void> {
  const session = ctx.sessions.create(SessionId(id))
  for (const event of events) session.append(event.type, event.data as never)
  const handle = await ctx.sessionPersistence.create(session.header)
  await handle.append(session.snapshotEvents())
  await handle.flush()
  await handle.close()
}

/** Every durable schedule operation in the caller's log. */
function operations(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'schedule/change')
    .map(event => (event.data as { operation: string }).operation)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'))
  followups.length = 0
})

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('Schedule management lifecycle', () => {
  it('runs create, get, update, pause, resume, run_now, logs, and delete with audit receipts', async () => {
    const test = await harness()
    const created = value(await execute(test, 'schedule_create', {
      prompt: 'check logs',
      every_seconds: 600,
    })) as { id: string; enabled: boolean }
    expect(created.enabled).toBe(true)

    const got = value(await execute(test, 'schedule_get', { id: created.id })) as {
      id: string
      lastRun?: unknown
      enabled: boolean
    }
    expect(got).toMatchObject({ id: created.id, enabled: true })
    expect(got.lastRun).toBeUndefined()

    const updated = value(await execute(test, 'schedule_update', {
      id: created.id,
      prompt: 'check metrics',
      every_seconds: 900,
    })) as { prompt: string; everySeconds: number; enabled: boolean }
    expect(updated).toMatchObject({ prompt: 'check metrics', everySeconds: 900, enabled: true })

    const paused = value(await execute(test, 'schedule_pause', { id: created.id })) as { enabled: boolean }
    expect(paused.enabled).toBe(false)
    const resumed = value(await execute(test, 'schedule_resume', { id: created.id })) as { enabled: boolean }
    expect(resumed.enabled).toBe(true)

    const receipt = value(await execute(test, 'schedule_run_now', { id: created.id })) as {
      runId: string
      status: string
    }
    expect(receipt.status).toBe('triggered')
    expect(test.followups).toHaveLength(1)
    expect(JSON.stringify(test.followups[0])).toContain('check metrics')

    const logs = value(await execute(test, 'schedule_logs', { id: created.id })) as Array<{
      runId: string
      status: string
      trigger: string
      durationMs?: number
    }>
    expect(logs).toEqual([expect.objectContaining({
      runId: receipt.runId,
      status: 'triggered',
      trigger: 'manual',
    })])
    expect(logs[0]?.durationMs).toBeTypeOf('number')

    const afterRun = value(await execute(test, 'schedule_get', { id: created.id })) as { lastRun?: { runId: string } }
    expect(afterRun.lastRun?.runId).toBe(receipt.runId)

    value(await execute(test, 'schedule_delete', { id: created.id }))
    expect(value(await execute(test, 'schedule_get', { id: created.id }))).toMatchObject({
      code: 'schedule_not_found',
    })
    const ops = operations(test.agent)
    expect(ops.filter(operation => operation === 'audit')).toHaveLength(4)
    const audits = test.agent.session.snapshotEvents()
      .filter(event => event.type === 'schedule/change'
        && (event.data as { operation: string }).operation === 'audit')
      .map(event => (event.data as { audit: { action: string; outcome: string } }).audit)
    expect(audits.map(audit => `${audit.action}:${audit.outcome}`)).toEqual([
      'update:allowed',
      'pause:allowed',
      'resume:allowed',
      'run_now:allowed',
    ])
  })

  it('rejects a write when the approver denies it and records the rejection', async () => {
    const test = await harness({ approval: 'reject' })
    const created = value(await execute(test, 'schedule_create', {
      prompt: 'guarded', every_seconds: 300,
    })) as { id: string }
    expect(value(await execute(test, 'schedule_pause', { id: created.id }))).toMatchObject({
      code: 'approval_rejected',
    })
    expect(operations(test.agent)).toEqual(['create', 'audit'])
    const audit = test.agent.session.snapshotEvents().at(-1)
      ?.data as { operation: string; audit: { action: string; outcome: string } }
    expect(audit.audit).toMatchObject({ action: 'pause', outcome: 'rejected' })
  })

  it('fails closed when no approval service is composed', async () => {
    const test = await harness({ approval: 'none' })
    const created = value(await execute(test, 'schedule_create', {
      prompt: 'guarded', every_seconds: 300,
    })) as { id: string }
    expect(value(await execute(test, 'schedule_update', { id: created.id, prompt: 'changed' })))
      .toMatchObject({ code: 'approval_unavailable' })
    expect(operations(test.agent)).toEqual(['create', 'audit'])
  })
})

describe('Schedule cross-session administration', () => {
  const deptOwner = {
    sessionId: 'dept-session', userId: 'lin', userName: '林工',
    departmentCode: 'D1', departmentName: '研发部',
  }
  const otherOwner = {
    sessionId: 'other-session', userId: 'zhou', userName: '周工',
    departmentCode: 'D2', departmentName: '产品部',
  }

  async function withStoredSessions(access: ScheduleAccessConfig): Promise<Harness> {
    const test = await harness({ access, persistence: true })
    const record = (id: string): unknown => ({
      version: 1,
      operation: 'create',
      schedule: {
        id,
        kind: 'every',
        prompt: `reminder ${id}`,
        everySeconds: 300,
        scheduledAt: '2026-08-05T12:05:00.000Z',
      },
    })
    await storeSession(test.ctx, 'dept-session', [{ type: 'schedule/change', data: record('schedule-a') }])
    await storeSession(test.ctx, 'other-session', [{ type: 'schedule/change', data: record('schedule-b') }])
    return test
  }

  it('denies an ordinary user and a department administrator outside their department', async () => {
    const user = await withStoredSessions({
      role: 'user',
      owner: { userId: 'me', departmentCode: 'D1' },
      sessionOwners: [deptOwner, otherOwner],
    })
    expect(value(await execute(user, 'schedule_list_all', {}))).toMatchObject({ code: 'forbidden' })

    const dept = await withStoredSessions({
      role: 'dept_admin',
      owner: { userId: 'lin', departmentCode: 'D1' },
      sessionOwners: [deptOwner, otherOwner],
    })
    expect(value(await execute(dept, 'schedule_list_all', { department: 'D2' })))
      .toMatchObject({ code: 'forbidden' })
    const ownRows = value(await execute(dept, 'schedule_list_all', {})) as Array<{
      sessionId: string
      owner: { departmentCode: string }
      schedule: { id: string }
    }>
    expect(ownRows.map(row => row.sessionId)).toEqual(['dept-session'])
    expect(ownRows[0]?.owner.departmentCode).toBe('D1')
  })

  it('lets an administrator filter by department and user', async () => {
    const admin = await withStoredSessions({
      role: 'admin',
      owner: { userId: 'root', departmentCode: 'D0' },
      sessionOwners: [deptOwner, otherOwner],
    })
    const all = value(await execute(admin, 'schedule_list_all', {})) as Array<{ sessionId: string }>
    expect(all.map(row => row.sessionId).sort()).toEqual(['dept-session', 'other-session'])
    const byDepartment = value(await execute(admin, 'schedule_list_all', { department: 'D2' })) as Array<{ sessionId: string }>
    expect(byDepartment.map(row => row.sessionId)).toEqual(['other-session'])
    const byUser = value(await execute(admin, 'schedule_list_all', { user: 'lin' })) as Array<{ sessionId: string }>
    expect(byUser.map(row => row.sessionId)).toEqual(['dept-session'])
  })

  it('limits cross-session log reads to the administrator scope', async () => {
    const dept = await withStoredSessions({
      role: 'dept_admin',
      owner: { userId: 'lin', departmentCode: 'D1' },
      sessionOwners: [deptOwner, otherOwner],
    })
    expect(value(await execute(dept, 'schedule_logs', { session_id: 'other-session' })))
      .toMatchObject({ code: 'forbidden' })
    expect(value(await execute(dept, 'schedule_logs', { session_id: 'dept-session' }))).toEqual([])
  })
})
