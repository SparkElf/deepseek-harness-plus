/**
 * Behavior the phone socket depends on: the session cookie must survive the scheme the deployment
 * is served over, and a request without a session must be distinguishable from a revoked device.
 *
 * The phone service worker opens `/ws/client` with no token and authenticates from that cookie
 * alone, so a cookie the browser will not return is a phone that cannot connect at all.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { createBridgeServer } from './server.ts'
import { UserStore } from './store.ts'

const open: Array<{ close: () => void }> = []
afterEach(() => { for (const entry of open.splice(0)) entry.close() })

/** Start the real server on an ephemeral port. */
const startServer = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'))
  const store = new UserStore(join(dir, 'users.json'), 'test-secret-at-least-16-chars')
  const server = createBridgeServer(store, {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const close = () => { server.close(); rmSync(dir, { recursive: true, force: true }) }
  open.push({ close })
  return { server, store, base: 'http://127.0.0.1:' + String(port), wsBase: 'ws://127.0.0.1:' + String(port) }
}

const identities = () => ({ bridgeId: randomBytes(16).toString('hex'), bridgeToken: randomBytes(32).toString('hex') })

/** Pair a desktop, then log a phone in so the response carries a session cookie. */
const pairPhone = async (base: string, wsBase: string, forwardedProto?: string) => {
  const identity = identities()
  const started = await fetch(base + '/bridge/api/bridge/start', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(identity),
  })
  const ticket = await started.json() as { code: string; refreshToken: string }
  const desktop = new WebSocket(wsBase + '/ws/bridge?bridgeId=' + identity.bridgeId, {
    headers: { authorization: 'Bearer ' + ticket.refreshToken },
  })
  await new Promise<void>((resolve, reject) => { desktop.on('open', () => resolve()); desktop.on('error', reject) })
  open.push({ close: () => desktop.close() })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (forwardedProto !== undefined) headers['x-forwarded-proto'] = forwardedProto
  const login = await fetch(base + '/bridge/api/login/bridge', {
    method: 'POST', headers, body: JSON.stringify({ code: ticket.code }),
  })
  return { desktop, login, cookie: login.headers.get('set-cookie') ?? '', body: await login.json() as { token: string } }
}

describe('session cookie', () => {
  it('omits Secure over HTTP, so the service worker can still present it', async () => {
    const { base, wsBase } = await startServer()
    const { login, cookie } = await pairPhone(base, wsBase)
    expect(login.status).toBe(200)
    expect(cookie).not.toContain('Secure')
  })

  it('keeps Secure when a proxy reports HTTPS', async () => {
    const { base, wsBase } = await startServer()
    const { login, cookie } = await pairPhone(base, wsBase, 'https')
    expect(login.status).toBe(200)
    expect(cookie).toContain('Secure')
  })

  it('accepts the phone socket from the cookie alone, without a token', async () => {
    const { base, wsBase } = await startServer()
    const { cookie } = await pairPhone(base, wsBase)
    const phone = new WebSocket(wsBase + '/ws/client', { headers: { cookie: cookie.split(';')[0] } })
    const outcome = await new Promise<string>(resolve => {
      phone.on('open', () => resolve('open'))
      phone.on('close', (code, reason) => resolve(String(code) + ' ' + String(reason)))
      phone.on('error', error => resolve('error ' + String(error).slice(0, 40)))
    })
    expect(outcome).toBe('open')
    phone.close()
  })

  it('names a missing session as pairing required rather than a revoked device', async () => {
    const { wsBase } = await startServer()
    const phone = new WebSocket(wsBase + '/ws/client')
    const outcome = await new Promise<string>(resolve => {
      phone.on('close', (code, reason) => resolve(String(code) + ' ' + String(reason)))
      phone.on('error', error => resolve('error ' + String(error).slice(0, 40)))
    })
    // 4004 means pair again; 4003 would tell the worker its pairing was revoked and stop it retrying.
    expect(outcome).toBe('4004 pairing required')
  })
})