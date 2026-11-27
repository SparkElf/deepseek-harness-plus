import { generateKeyPairSync } from 'node:crypto'
import { connect, createServer } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryCredentialRecords } from './credential-records.ts'
import { SshPortForwardManager } from '../src/forward.ts'
import { SshManagerStore } from '../src/store.ts'
import { testSshHost } from '../src/transport.ts'
import type { SshHost } from '../src/types.ts'

const closers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())) })

describe('SshPortForwardManager', () => {
  it('forwards a local ephemeral port through direct-tcpip and scopes lifecycle', async () => {
    const target = createServer(socket => { socket.on('data', data => { socket.write('target:' + data.toString()) }) })
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise(resolve => target.close(() => resolve())))
    const targetAddress = target.address(); if (targetAddress === null || typeof targetAddress === 'string') throw new Error('target did not bind')
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
    const ssh = new Server({ hostKeys: [pair.privateKey] }, client => {
      client.on('error', () => {})
      client.on('authentication', context => { if (context.method === 'password' && context.password === 'secret') context.accept(); else context.reject() })
      client.on('ready', () => { client.on('tcpip', (accept, _reject, info) => { const channel = accept(); const upstream = connect(info.destPort, info.destIP); channel.on('error', () => { upstream.destroy() }); upstream.on('error', () => { channel.close() }); channel.pipe(upstream).pipe(channel) }) })
    })
    ssh.on('error', () => {})
    await new Promise<void>(resolve => ssh.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise(resolve => ssh.close(() => resolve())))
    const sshAddress = ssh.address(); if (sshAddress === null || typeof sshAddress === 'string') throw new Error('SSH server did not bind')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-forward-'))
    const store = new SshManagerStore({ dataFile: join(directory, 'ssh.json'), credentials: new MemoryCredentialRecords() })
    const base: SshHost = { id: '', name: 'Forward', description: '', tags: [], clusterId: null, environment: 'testing', hostname: '127.0.0.1', port: sshAddress.port, username: 'user', authKind: 'password', credentialId: null, credentialConfigured: false, jumpHostId: null, knownHostFingerprint: 'SHA256:wrong', keepAliveSeconds: 0 }
    let host = await store.saveHost(base, { password: 'secret' })
    let fingerprint = ''
    try { await testSshHost(store, host.id) } catch (error) { fingerprint = String(error).match(/Observed (SHA256:[A-Za-z0-9+/]+)/u)?.[1] ?? '' }
    host = await store.saveHost({ ...host, knownHostFingerprint: fingerprint })
    const manager = new SshPortForwardManager(store)
    const forward = await manager.open('session-a', { hostId: host.id, direction: 'local', bindHost: '127.0.0.1', bindPort: 0, targetHost: '127.0.0.1', targetPort: targetAddress.port })
    expect(forward).toMatchObject({ state: 'active', bindHost: '127.0.0.1' })
    expect(forward.bindPort).toBeGreaterThan(0)
    const reply = await new Promise<string>((resolve, reject) => { const socket = connect(forward.bindPort, '127.0.0.1', () => { socket.write('ping') }); socket.once('data', data => { resolve(data.toString()); socket.end() }); socket.once('error', reject) })
    expect(reply).toBe('target:ping')
    expect(manager.list('session-b')).toEqual([])
    expect(() => manager.close('session-b', forward.id)).toThrow(/not found/)
    manager.close('session-a', forward.id)
    expect(manager.list('session-a')).toEqual([])
  })
})
