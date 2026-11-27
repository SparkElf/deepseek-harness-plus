import { generateKeyPairSync } from 'node:crypto'
import { connect } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryCredentialRecords } from './credential-records.ts'
import { SshManagerStore } from '../src/store.ts'
import { executeSshCommand, fingerprintFromHash, sshConnectConfig, testSshHost } from '../src/transport.ts'
import type { SshHost } from '../src/types.ts'

const host: SshHost = { id: 'host', name: 'Host', description: '', tags: [], clusterId: null, environment: 'testing', hostname: 'localhost', port: 22, username: 'user', authKind: 'password', credentialId: 'host', credentialConfigured: true, jumpHostId: null, knownHostFingerprint: 'SHA256:AQID', keepAliveSeconds: 30 }
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })

async function createServer(forwarding = false): Promise<{ server: Server; port: number }> {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
  const server = new Server({ hostKeys: [pair.privateKey] }, client => {
    client.on('error', () => {})
    client.on('authentication', context => { if (context.method === 'password' && context.username === 'user' && context.password === 'secret') context.accept(); else context.reject() })
    client.on('ready', () => {
      client.on('session', accept => { const session = accept(); session.on('exec', (acceptExec, _reject, info) => { const stream = acceptExec(); stream.write('stdout: ' + info.command); stream.stderr.write('stderr'); stream.exit(0); stream.end() }) })
      if (forwarding) client.on('tcpip', (accept, _reject, info) => { const channel = accept(); const upstream = connect(info.destPort, info.destIP); channel.on('error', () => { upstream.destroy() }); upstream.on('error', () => { channel.close() }); channel.pipe(upstream).pipe(channel) })
    })
  })
  server.on('error', () => {})
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('SSH test server did not bind')
  return { server, port: address.port }
}

async function captureFingerprint(store: SshManagerStore, hostId: string): Promise<string> {
  try { await testSshHost(store, hostId) } catch (error) { return String(error).match(/Observed (SHA256:[A-Za-z0-9+/]+)/u)?.[1] ?? '' }
  return ''
}

describe('SSH transport policy', () => {
  it('formats OpenSSH SHA256 fingerprints', () => { expect(fingerprintFromHash('010203')).toBe('SHA256:AQID') })
  it('requires a credential and strict known-host fingerprint', () => {
    expect(sshConnectConfig(host, { password: 'secret' })).toMatchObject({ host: 'localhost', port: 22, username: 'user', password: 'secret', hostHash: 'sha256' })
    expect(() => sshConnectConfig({ ...host, knownHostFingerprint: null }, { password: 'secret' })).toThrow(/fingerprint is required/)
    expect(() => sshConnectConfig(host, undefined)).toThrow(/password is not configured/)
    expect(sshConnectConfig({ ...host, jumpHostId: 'jump' }, { password: 'secret' })).toMatchObject({ host: 'localhost' })
  })
  it('rejects an unknown host key and connects after the observed fingerprint is saved', async () => {
    const endpoint = await createServer()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-transport-'))
    const store = new SshManagerStore({ dataFile: join(directory, 'ssh.json'), credentials: new MemoryCredentialRecords() })
    const saved = await store.saveHost({ ...host, id: '', hostname: '127.0.0.1', port: endpoint.port, credentialId: null, credentialConfigured: false, knownHostFingerprint: 'SHA256:wrong' }, { password: 'secret' })
    const observed = await captureFingerprint(store, saved.id)
    expect(observed).toMatch(/^SHA256:/u)
    await store.saveHost({ ...saved, knownHostFingerprint: observed })
    await expect(testSshHost(store, saved.id)).resolves.toMatchObject({ hostId: saved.id, fingerprint: observed })
    await expect(executeSshCommand(store, saved.id, 'printf ok')).resolves.toMatchObject({ hostId: saved.id, exitCode: 0, stdout: 'stdout: printf ok', stderr: 'stderr', truncated: false })
  })
  it('verifies every hop and executes through direct-tcpip jump forwarding', async () => {
    const targetEndpoint = await createServer()
    const jumpEndpoint = await createServer(true)
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-jump-'))
    const store = new SshManagerStore({ dataFile: join(directory, 'ssh.json'), credentials: new MemoryCredentialRecords() })
    let jump = await store.saveHost({ ...host, id: '', name: 'Jump', hostname: '127.0.0.1', port: jumpEndpoint.port, credentialId: null, credentialConfigured: false, knownHostFingerprint: 'SHA256:wrong' }, { password: 'secret' })
    const jumpFingerprint = await captureFingerprint(store, jump.id)
    jump = await store.saveHost({ ...jump, knownHostFingerprint: jumpFingerprint })
    let target = await store.saveHost({ ...host, id: '', name: 'Target', hostname: '127.0.0.1', port: targetEndpoint.port, credentialId: null, credentialConfigured: false, jumpHostId: jump.id, knownHostFingerprint: 'SHA256:wrong' }, { password: 'secret' })
    const targetFingerprint = await captureFingerprint(store, target.id)
    target = await store.saveHost({ ...target, knownHostFingerprint: targetFingerprint })
    await expect(executeSshCommand(store, target.id, 'through jump')).resolves.toMatchObject({ exitCode: 0, stdout: 'stdout: through jump' })
  })
})
