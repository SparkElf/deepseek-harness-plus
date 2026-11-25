import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, type SFTPWrapper } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryCredentialRecords } from './credential-records.ts'
import { downloadSftpFile, listSftpFiles, uploadSftpFile } from '../src/sftp.ts'
import { SshManagerStore } from '../src/store.ts'
import { testSshHost } from '../src/transport.ts'
import type { SshHost } from '../src/types.ts'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })

function installSftp(sftp: SFTPWrapper, files: Map<string, Buffer>): void {
  const handles = new Map<string, { path: string; directory: boolean; read: boolean }>()
  let next = 1
  const attrs = (path: string) => ({ mode: files.has(path) ? 0o100644 : 0o040755, uid: 0, gid: 0, size: files.get(path)?.byteLength ?? 0, atime: 1_700_000_000, mtime: 1_700_000_000 })
  const openHandle = (path: string, directory: boolean): Buffer => { const handle = Buffer.from((next++).toString()); handles.set(handle.toString('hex'), { path, directory, read: false }); return handle }
  sftp.on('OPENDIR', (id, path) => { if (path !== '/') { sftp.status(id, 2); return } sftp.handle(id, openHandle(path, true)) })
  sftp.on('READDIR', (id, handle) => { const entry = handles.get(handle.toString('hex')); if (entry === undefined || !entry.directory) { sftp.status(id, 4); return } if (entry.read) { sftp.status(id, 1); return } entry.read = true; sftp.name(id, [...files.keys()].map(path => ({ filename: path.slice(1), longname: path.slice(1), attrs: attrs(path) }))) })
  sftp.on('OPEN', (id, path) => { if (!files.has(path)) files.set(path, Buffer.alloc(0)); sftp.handle(id, openHandle(path, false)) })
  sftp.on('FSTAT', (id, handle) => { const entry = handles.get(handle.toString('hex')); if (entry === undefined) sftp.status(id, 4); else sftp.attrs(id, attrs(entry.path)) })
  sftp.on('STAT', (id, path) => { if (path === '/' || files.has(path)) sftp.attrs(id, attrs(path)); else sftp.status(id, 2) })
  sftp.on('LSTAT', (id, path) => { if (path === '/' || files.has(path)) sftp.attrs(id, attrs(path)); else sftp.status(id, 2) })
  sftp.on('READ', (id, handle, offset, length) => { const entry = handles.get(handle.toString('hex')); const file = entry === undefined ? undefined : files.get(entry.path); if (file === undefined) { sftp.status(id, 4); return } if (offset >= file.byteLength) { sftp.status(id, 1); return } sftp.data(id, file.subarray(offset, offset + length)) })
  sftp.on('WRITE', (id, handle, offset, data) => { const entry = handles.get(handle.toString('hex')); if (entry === undefined) { sftp.status(id, 4); return } const current = files.get(entry.path) ?? Buffer.alloc(0); const nextFile = Buffer.alloc(Math.max(current.byteLength, offset + data.byteLength)); current.copy(nextFile); data.copy(nextFile, offset); files.set(entry.path, nextFile); sftp.status(id, 0) })
  sftp.on('CLOSE', (id, handle) => { handles.delete(handle.toString('hex')); sftp.status(id, 0) })
}

describe('SSH SFTP operations', () => {
  it('lists, downloads, and uploads remote files', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
    const files = new Map<string, Buffer>([['/hello.txt', Buffer.from('hello')]])
    const server = new Server({ hostKeys: [pair.privateKey] }, client => { client.on('error', () => {}); client.on('authentication', context => { if (context.method === 'password' && context.password === 'secret') context.accept(); else context.reject() }); client.on('ready', () => { client.on('session', accept => { const session = accept(); session.on('sftp', acceptSftp => { installSftp(acceptSftp(), files) }) }) }) })
    server.on('error', () => {}); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('SSH server did not bind')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-sftp-'))
    const store = new SshManagerStore({ dataFile: join(directory, 'ssh.json'), credentials: new MemoryCredentialRecords() })
    const base: SshHost = { id: '', name: 'SFTP', description: '', tags: [], clusterId: null, environment: 'testing', hostname: '127.0.0.1', port: address.port, username: 'user', authKind: 'password', credentialId: null, credentialConfigured: false, jumpHostId: null, knownHostFingerprint: 'SHA256:wrong', keepAliveSeconds: 0 }
    let host = await store.saveHost(base, { password: 'secret' }); let fingerprint = ''
    try { await testSshHost(store, host.id) } catch (error) { fingerprint = String(error).match(/Observed (SHA256:[A-Za-z0-9+/]+)/u)?.[1] ?? '' }
    host = await store.saveHost({ ...host, knownHostFingerprint: fingerprint })
    await expect(listSftpFiles(store, host.id, '/')).resolves.toMatchObject({ entries: [{ name: 'hello.txt', type: 'file', size: 5 }] })
    await expect(downloadSftpFile(store, host.id, '/hello.txt')).resolves.toMatchObject({ name: 'hello.txt', data: Buffer.from('hello').toString('base64') })
    await expect(uploadSftpFile(store, host.id, '/new.txt', Buffer.from('new content').toString('base64'))).resolves.toMatchObject({ path: '/new.txt', size: 11 })
    expect(files.get('/new.txt')?.toString()).toBe('new content')
  })
})
