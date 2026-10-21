/**
 * The reconnect decision for the credential-backed MCP client.
 *
 * The rule under test is the one that used to be wrong: a refused credential (401/403) is not
 * an outage. Spending it against the outage budget unregistered every tool after ten quick
 * retries and left the server unusable until the Host restarted, while the only thing that can
 * actually fix it — a fresh sign-in — arrives on a minutes-long timescale.
 */
import { describe, expect, it } from 'vitest'
import { resolveReconnectPolicy, planReconnect } from '../src/connection.ts'

const policy = resolveReconnectPolicy(undefined, 'mcp.reconnect')

/** The shape the MCP SDK throws for a non-2xx response: the status lives on `code`. */
const httpError = (code: number): Error => Object.assign(new Error(`Streamable HTTP error: ${code}`), { code })

describe('planReconnect', () => {
  it('treats a refused credential as its own curve, not as an outage', () => {
    const plan = planReconnect({
      cause: httpError(401),
      policy,
      established: false,
      failedAttempts: 0,
      credentialAttempts: 0,
    })

    expect(plan).toEqual({ kind: 'retry', credential: true, delayMs: 60_000 })
  })

  it('backs the credential curve off to a ceiling instead of giving up', () => {
    const at = (credentialAttempts: number) => planReconnect({
      cause: httpError(401),
      policy,
      established: false,
      failedAttempts: 0,
      credentialAttempts,
    })

    expect(at(0)).toMatchObject({ delayMs: 60_000 })
    expect(at(1)).toMatchObject({ delayMs: 120_000 })
    // The curve is bounded: a long outage must not push the check-back into the distant future.
    expect(at(9)).toMatchObject({ delayMs: 300_000 })
    expect(at(99)).toMatchObject({ delayMs: 300_000 })
  })

  it('never gives up on a refused credential, however many attempts have failed', () => {
    // This is the regression that mattered: the outage budget used to be spent here, and
    // exceeding it unregistered every tool.
    const plan = planReconnect({
      cause: httpError(403),
      policy,
      established: true,
      failedAttempts: policy.maxAttempts + 5,
      credentialAttempts: policy.maxAttempts + 5,
    })

    expect(plan.kind).toBe('retry')
  })

  it('keeps the outage backoff for a transport failure', () => {
    const first = planReconnect({
      cause: new Error('connect ECONNREFUSED'),
      policy,
      established: false,
      failedAttempts: 0,
      credentialAttempts: 0,
    })
    const second = planReconnect({
      cause: new Error('connect ECONNREFUSED'),
      policy,
      established: false,
      failedAttempts: 1,
      credentialAttempts: 0,
    })

    expect(first).toEqual({ kind: 'retry', credential: false, delayMs: 500 })
    expect(second).toEqual({ kind: 'retry', credential: false, delayMs: 1_000 })
  })

  it('still gives up when an outage outlasts the budget', () => {
    const plan = planReconnect({
      cause: new Error('connect ECONNREFUSED'),
      policy,
      established: false,
      failedAttempts: policy.maxAttempts,
      credentialAttempts: 0,
    })

    expect(plan).toEqual({ kind: 'giveup' })
  })

  it('starts a fresh outage budget after a stable connection', () => {
    const plan = planReconnect({
      cause: new Error('socket closed'),
      policy,
      established: true,
      failedAttempts: policy.maxAttempts,
      credentialAttempts: 0,
      stableForMs: policy.maxDelayMs,
    })

    expect(plan).toEqual({ kind: 'retry', credential: false, delayMs: 500 })
  })

  it('reports a disabled policy without inventing a retry', () => {
    const disabled = resolveReconnectPolicy({ enabled: false }, 'mcp.reconnect')

    expect(planReconnect({
      cause: new Error('socket closed'),
      policy: disabled,
      established: true,
      failedAttempts: 0,
      credentialAttempts: 0,
    })).toEqual({ kind: 'disabled', established: true })
  })
})
