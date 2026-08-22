/**
 * The summary blank bit means no model turn or durable command history.
 * Passive plugin state does not flip it; `command/run` and `turn/start` do,
 * preventing New Session from reusing a Session with durable command history.
 * The host/session-added frame shares the same predicate function.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Side-effect type imports: the knob-event SessionEventMap merges.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApiProxy, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`blank-${String(nextRpc++)}`), payload }
}

async function harness(): Promise<{ ctx: Context; api: ApiProxy; attach: (session: Session) => void }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  return {
    ctx,
    api: createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }),
    attach: (session) => {
      ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    },
  }
}

/** Append passive plugin state that does not create visible command history. */
function appendPassiveState(session: Session): void {
  session.append('plan/mode', { active: true })
  session.append('session/title', {
    title: 'standalone title', messageSeqs: [], source: { kind: 'fallback' },
  })
  session.append('permission/preset', { preset: 'danger-full-access' })
  session.append('sandbox/mode', { mode: 'danger-full-access' })
  session.append('approval/policy', { policy: 'never' })
}

/** Append the durable start of one user command. */
function appendCommandRun(session: Session): void {
  session.append('command/run', {
    commandId: CommandId('blank-cmd-1'), name: 'plan', args: '', source: { kind: 'user' },
  })
}

async function listBlank(api: ApiProxy, id: string): Promise<boolean | undefined> {
  const response = await api.sessions.list(request({}))
  if (!response.result.ok) throw new Error('list failed')
  return response.result.value.items.find(item => item.sessionId === id)?.blank
}

describe('summary blank = no turn or command history', () => {
  it('passive plugin state keeps the session blank', async () => {
    const { ctx, api, attach } = await harness()
    const session = ctx.sessions.create()
    attach(session)
    expect(await listBlank(api, session.id)).toBe(true)
    appendPassiveState(session)
    expect(await listBlank(api, session.id)).toBe(true)
  })

  it('the first command clears blank before a model turn', async () => {
    const { ctx, api, attach } = await harness()
    const session = ctx.sessions.create()
    attach(session)
    appendCommandRun(session)
    expect(await listBlank(api, session.id)).toBe(false)
  })

  it('the first turn clears blank', async () => {
    const { ctx, api, attach } = await harness()
    const session = ctx.sessions.create()
    attach(session)
    appendPassiveState(session)
    session.append('turn/start', { turn: 0 })
    expect(await listBlank(api, session.id)).toBe(false)
  })
})
