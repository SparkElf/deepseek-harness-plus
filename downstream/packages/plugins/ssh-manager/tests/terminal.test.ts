import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryCredentialRecords } from './credential-records.ts'
import { SshManagerStore } from '../src/store.ts'
import { SshTerminalManager, type SshTerminalEvent } from '../src/terminal.ts'
import { testSshHost } from '../src/transport.ts'
import type { SshHost } from '../src/types.ts'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })

async function waitFor(events: SshTerminalEvent[], text: string): Promise<void> {
  for (let index = 0; index < 100; index++) { if (events.some(event => event.type === 'data' && event.data.includes(text))) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('terminal output not observed: ' + text)
}

describe('SshTerminalManager', () => {
  it('streams, replays, resizes, scopes, and closes a remote shell', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
    const sizes: Array<{ rows: number; cols: number }> = []
    const server = new Server({ hostKeys: [pair.privateKey] }, client => {
      client.on('error', () => {})
      client.on('authentication', context => { if (context.method === 'password' && context.password === 'secret') context.accept(); else context.reject() })
      client.on('ready', () => { client.on('session', accept => { const session = accept(); session.on('pty', (acceptPty, _reject, info) => { sizes.push({ rows: info.rows, cols: info.cols }); acceptPty() }); session.on('window-change', (acceptResize, _reject, info) => { sizes.push({ rows: info.rows, cols: info.cols }); acceptResize?.() }); session.on('shell', acceptShell => { const stream = acceptShell(); stream.write('ready\r\n'); stream.on('data', (data: Buffer) => { const text = data.toString(); stream.write('echo:' + text); if (text.includes('exit')) { stream.exit(0); stream.end() } }) }) }) })
    })
    server.on('error', () => {})
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('SSH server did not bind')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-terminal-'))
    const store = new SshManagerStore({ dataFile: join(directory, 'ssh.json'), credentials: new MemoryCredentialRecords() })
    const base: SshHost = { id: '', name: 'Terminal', description: '', tags: [], clusterId: null, environment: 'testing', hostname: '127.0.0.1', port: address.port, username: 'user', authKind: 'password', credentialId: null, credentialConfigured: false, jumpHostId: null, knownHostFingerprint: 'SHA256:wrong', keepAliveSeconds: 0 }
    let host = await store.saveHost(base, { password: 'secret' })
    let fingerprint = ''
    try { await testSshHost(store, host.id) } catch (error) { fingerprint = String(error).match(/Observed (SHA256:[A-Za-z0-9+/]+)/u)?.[1] ?? '' }
    host = await store.saveHost({ ...host, knownHostFingerprint: fingerprint })
    const manager = new SshTerminalManager(store)
    const terminal = await manager.open('session-a', host.id, 80, 24)
    const events: SshTerminalEvent[] = []
    const detach = manager.attach('session-a', terminal.id, event => { events.push(event) })
    await waitFor(events, 'ready')
    manager.write('session-a', terminal.id, 'hello\r')
    await waitFor(events, 'echo:hello')
    manager.resize('session-a', terminal.id, 100, 30)
    for (let index = 0; index < 100 && !sizes.some(size => size.rows === 30 && size.cols === 100); index++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(sizes).toContainEqual({ rows: 24, cols: 80 })
    expect(sizes).toContainEqual({ rows: 30, cols: 100 })
    expect(manager.list('session-a')).toHaveLength(1)
    expect(manager.list('session-b')).toEqual([])
    manager.write('session-a', terminal.id, 'exit\r')
    for (let index = 0; index < 100 && !events.some(event => event.type === 'exit'); index++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(manager.list('session-a')[0]?.exited).toBe(true)
    await manager.reconnect('session-a', terminal.id, 90, 28)
    await waitFor(events, '[reconnected]')
    expect(manager.list('session-a')[0]).toMatchObject({ exited: false, state: 'connected' })
    expect(() => manager.write('session-b', terminal.id, 'denied')).toThrow(/not found/)
    detach()
    manager.close('session-a', terminal.id)
    expect(manager.list('session-a')).toEqual([])
  })
})
