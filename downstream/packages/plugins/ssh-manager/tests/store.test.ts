import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkbenchVault } from '@sparkelf/dsh-workbench-vault'
import { SshManagerStore, sshCredentialKey } from '../src/store.ts'
import type { SshHost } from '../src/types.ts'
import { MemoryCredentialRecords } from './credential-records.ts'

function host(overrides: Partial<SshHost> = {}): SshHost { return { id: '', name: 'Primary', description: 'Production node', tags: ['prod', 'prod'], clusterId: null, environment: 'production', hostname: 'server.example.com', port: 22, username: 'deploy', authKind: 'password', credentialId: null, credentialConfigured: false, jumpHostId: null, knownHostFingerprint: null, keepAliveSeconds: 30, ...overrides } }

describe('SshManagerStore', () => {
  it('persists hosts and credentials in central cross-session records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-store-'))
    const credentials = new MemoryCredentialRecords()
    const store = new SshManagerStore({ dataFile: join(directory, 'ssh-manager.json'), credentials })
    const cluster = await store.saveCluster({ id: '', name: 'Production', description: '', tags: ['critical'], hostIds: [] })
    const saved = await store.saveHost(host({ clusterId: cluster.id }), { password: 'host-secret' })
    expect(saved.tags).toEqual(['prod'])
    expect(saved.credentialConfigured).toBe(true)
    expect(String(sshCredentialKey(saved.credentialId as string))).toMatch(/^ssh-manager\/host-[a-f0-9]{32}$/u)
    expect(await credentials.readRecord(sshCredentialKey(saved.credentialId as string))).toEqual({ kind: 'grant', payload: { password: 'host-secret' } })
    const state = await store.state()
    expect(state.clusters[0]?.hostIds).toEqual([saved.id])
    expect(JSON.stringify(state)).not.toContain('host-secret')
    expect(await store.credential(saved.id)).toEqual({ password: 'host-secret' })
    expect(await readFile(join(directory, 'ssh-manager.json'), 'utf8')).not.toContain('host-secret')
    await store.deleteHost(saved.id)
    expect(await credentials.readRecord(sshCredentialKey(saved.credentialId as string))).toBeUndefined()
  })

  it('migrates one legacy WorkbenchVault SSH record into central credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-migration-'))
    const legacyVault = new WorkbenchVault({ directory })
    await legacyVault.set('ssh', 'legacy-host', { privateKey: 'legacy-private-key', passphrase: 'legacy-passphrase' })
    const storedHost = host({ id: 'existing-host', credentialId: 'legacy-host' })
    const dataFile = join(directory, 'ssh-manager.json')
    await writeFile(dataFile, JSON.stringify({ version: 1, clusters: [], hosts: [storedHost] }))
    const credentials = new MemoryCredentialRecords()
    const store = new SshManagerStore({ dataFile, credentials, legacyVault })
    expect((await store.state()).hosts[0]?.credentialConfigured).toBe(true)
    expect(await store.credential('existing-host')).toEqual({ privateKey: 'legacy-private-key', passphrase: 'legacy-passphrase' })
    expect(await legacyVault.has('ssh', 'legacy-host')).toBe(false)
    expect(await credentials.readRecord(sshCredentialKey('legacy-host'))).toEqual({ kind: 'grant', payload: { privateKey: 'legacy-private-key', passphrase: 'legacy-passphrase' } })
  })

  it('validates jump hosts and clears references on delete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-links-'))
    const store = new SshManagerStore({ dataFile: join(directory, 'ssh-manager.json'), credentials: new MemoryCredentialRecords() })
    const jump = await store.saveHost(host({ name: 'Jump', hostname: 'jump.example.com' }))
    const target = await store.saveHost(host({ name: 'Target', hostname: 'target.example.com', jumpHostId: jump.id }))
    await expect(store.saveHost(host({ name: 'Invalid', jumpHostId: 'missing' }))).rejects.toThrow(/jump host not found/)
    await store.deleteHost(jump.id)
    expect((await store.host(target.id)).jumpHostId).toBeNull()
  })
})
