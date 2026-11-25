import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkbenchVault } from '@sparkelf/dsh-workbench-vault'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { CredentialManagerStore, type CredentialRecordProvider } from '../src/store.ts'

interface MemoryProvider extends CredentialRecordProvider {
  records: Map<string, CredentialRecord>
}

function memoryProvider(): MemoryProvider {
  const records = new Map<string, CredentialRecord>()
  return {
    records,
    async describeRecord(key: CredentialKey) { return { configured: records.has(String(key)) } },
    async readRecord(key: CredentialKey) { return records.get(String(key)) },
    async modifyRecord(key: CredentialKey, mutate) {
      const next = await mutate(records.get(String(key)))
      if (next !== undefined) records.set(String(key), next)
      return next
    },
    async deleteRecord(key: CredentialKey) { records.delete(String(key)) },
  }
}

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-credential-store-'))
}

function prefectDraft(name = 'Production Prefect') {
  return {
    name,
    type: 'prefect' as const,
    description: 'Main orchestration API',
    tags: ['production', 'prefect'],
    authKind: 'api-key',
    config: { apiUrl: 'https://prefect.example.com/api', workspace: 'default' },
  }
}

describe('CredentialManagerStore metadata CRUD', () => {
  it('creates, lists, updates, toggles, and deletes metadata without exposing the secret', async () => {
    const dir = await directory()
    const provider = memoryProvider()
    const store = new CredentialManagerStore({ dataFile: join(dir, 'credentials.json'), credentials: provider })

    const created = await store.create(prefectDraft(), { apiKey: 'super-secret-api-key' })
    expect(created.secretConfigured).toBe(true)
    expect(created.configuredSecretFields).toEqual(['apiKey'])

    const state = await store.state()
    expect(JSON.stringify(state)).not.toContain('super-secret-api-key')
    expect(JSON.stringify(await store.list())).not.toContain('super-secret-api-key')
    expect(JSON.stringify(await store.get(created.id))).not.toContain('super-secret-api-key')
    expect(await readFile(join(dir, 'credentials.json'), 'utf8')).not.toContain('super-secret-api-key')
    expect((await stat(join(dir, 'credentials.json'))).mode & 0o777).toBe(0o600)

    const updated = await store.update(created.id, { name: 'Prefect Prod', description: 'Rotated metadata', tags: ['prod'], enabled: false })
    expect(updated.name).toBe('Prefect Prod')
    expect(updated.tags).toEqual(['prod'])
    expect(updated.enabled).toBe(false)
    expect(updated.secretConfigured).toBe(true)
    expect(updated.configuredSecretFields).toEqual(['apiKey'])

    expect((await store.list({ search: 'prod' })).map(item => item.id)).toEqual([created.id])
    expect(await store.list({ type: 'database' })).toEqual([])
    expect((await store.list({ enabled: false })).map(item => item.id)).toEqual([created.id])

    const enabled = await store.setEnabled(created.id, true)
    expect(enabled.enabled).toBe(true)

    await expect(store.delete(created.id, { confirmed: false, name: 'Prefect Prod' })).rejects.toThrow(/explicit confirmation/)
    await expect(store.delete(created.id, { confirmed: true, name: 'Wrong' })).rejects.toThrow(/does not match/)
    expect((await store.state()).credentials).toHaveLength(1)

    const result = await store.delete(created.id, { confirmed: true, name: 'Prefect Prod' })
    expect(result).toEqual({ deleted: true, secretCleanup: 'deleted' })
    expect((await store.state()).credentials).toEqual([])
    expect(provider.records.size).toBe(0)
  })

  it('keeps the encrypted vault free of plaintext and reads it only through the Host-only path', async () => {
    const dir = await directory()
    const vault = new WorkbenchVault({ directory: dir })
    const store = new CredentialManagerStore({ dataFile: join(dir, 'credentials.json'), vault })

    const created = await store.create({
      name: 'Warehouse',
      type: 'database',
      authKind: 'password',
      config: { engine: 'postgres', host: 'db.internal', port: 5432, database: 'analytics', username: 'readonly', ssl: true },
    }, { password: 'warehouse-password' })

    expect(JSON.stringify(await store.state())).not.toContain('warehouse-password')
    expect(await readFile(join(dir, 'workbench-vault.json'), 'utf8')).not.toContain('warehouse-password')
    expect(await readFile(join(dir, 'credentials.json'), 'utf8')).not.toContain('warehouse-password')
    expect(await store.readSecret(created.id)).toEqual({ password: 'warehouse-password' })

    await store.update(created.id, { description: 'Rotated' }, { password: 'warehouse-password-2' })
    expect(await store.readSecret(created.id)).toEqual({ password: 'warehouse-password-2' })
    expect(JSON.stringify(await store.state())).not.toContain('warehouse-password-2')
  })

  it('prefers the encrypted vault when both backends are configured', async () => {
    const dir = await directory()
    const provider = memoryProvider()
    const vault = new WorkbenchVault({ directory: dir })
    const store = new CredentialManagerStore({ dataFile: join(dir, 'credentials.json'), credentials: provider, vault })
    const created = await store.create(prefectDraft(), { apiKey: 'vault-wins' })
    expect(provider.records.size).toBe(0)
    expect(await readFile(join(dir, 'workbench-vault.json'), 'utf8')).not.toContain('vault-wins')
    expect(await store.readSecret(created.id)).toEqual({ apiKey: 'vault-wins' })
  })

  it('rejects duplicate names and unknown records', async () => {
    const dir = await directory()
    const store = new CredentialManagerStore({ dataFile: join(dir, 'credentials.json'), credentials: memoryProvider() })
    await store.create(prefectDraft('Shared'), { apiKey: 'one' })
    await expect(store.create(prefectDraft('shared'), { apiKey: 'two' })).rejects.toThrow(/already exists/)
    await expect(store.get('missing')).rejects.toThrow(/not found/)
    await expect(store.update('missing', { name: 'x' })).rejects.toThrow(/not found/)
    await expect(store.delete('missing', { confirmed: true, name: 'x' })).rejects.toThrow(/not found/)
  })
})

describe('CredentialManagerStore validation', () => {
  it('validates credential types and template fields', async () => {
    const dir = await directory()
    const store = new CredentialManagerStore({ dataFile: join(dir, 'credentials.json'), credentials: memoryProvider() })

    await expect(store.create({ name: 'Bad', type: 'smtp' as never }, {})).rejects.toThrow(/type must be one of/)
    await expect(store.create({
      name: 'Bad DB',
      type: 'database',
      authKind: 'password',
      config: { engine: 'postgres', port: 5432, database: 'x', username: 'u' },
    }, { password: 'p' })).rejects.toThrow(/config.host is required/)

    await expect(store.create({
      name: 'Bad HTTP',
      type: 'http',
      authKind: 'none',
      config: { baseUrl: 'ftp://example.com' },
    }, {})).rejects.toThrow(/http or https/)

    await expect(store.create({
      name: 'Leaky custom',
      type: 'custom',
      authKind: 'custom',
      config: { endpoint: 'https://example.com', password: 'not-allowed' },
    }, { secret: 's' })).rejects.toThrow(/Unknown config field/)

    await expect(store.create(prefectDraft('Wrong secret'), { password: 'nope' })).rejects.toThrow(/Unknown secret field/)
    await expect(store.create(prefectDraft('Missing secret'))).rejects.toThrow(/missing required secret fields: apiKey/)
    await expect(store.create({
      name: 'Prefect Basic',
      type: 'prefect',
      authKind: 'basic',
      config: { apiUrl: 'https://prefect.example.com/api' },
    }, { password: 'p' })).rejects.toThrow(/config.username is required for Prefect Basic/)
  })

  it('requires the selected authentication method and keeps type immutable', async () => {
    const dir = await directory()
    const store = new CredentialManagerStore({ dataFile: join(dir, 'credentials.json'), credentials: memoryProvider() })
    const created = await store.create({
      name: 'HTTP Basic',
      type: 'http',
      authKind: 'basic',
      config: { baseUrl: 'https://api.example.com', username: 'svc' },
    }, { password: 'secret' })

    await expect(store.update(created.id, { authKind: 'bearer' })).rejects.toThrow(/missing required secret fields: token/)
    const updated = await store.update(created.id, { authKind: 'bearer' }, { token: 'bearer-token' })
    expect(updated.authKind).toBe('bearer')
    expect(updated.configuredSecretFields).toEqual(['token'])

    await expect(store.update(created.id, { type: 'ssh' } as never)).rejects.toThrow(/cannot be changed/)
  })

  it('accepts a secret reference instead of a stored secret and validates its name', async () => {
    const dir = await directory()
    const store = new CredentialManagerStore({
      dataFile: join(dir, 'credentials.json'),
      credentials: memoryProvider(),
      describeReference: async ref => ({ configured: ref === 'PREFECT_API_KEY' }),
    })
    const created = await store.create({
      name: 'Referenced',
      type: 'prefect',
      authKind: 'api-key',
      config: { apiUrl: 'https://prefect.example.com/api' },
      secretRef: 'PREFECT_API_KEY',
    })
    expect(created.secretRef).toBe('PREFECT_API_KEY')
    expect(created.secretConfigured).toBe(false)
    const result = await store.test(created.id)
    expect(result.ok).toBe(true)
    expect(result.networkAttempted).toBe(false)
    await expect(store.create({
      name: 'Bad ref',
      type: 'prefect',
      authKind: 'api-key',
      config: { apiUrl: 'https://prefect.example.com/api' },
      secretRef: 'not a shell name',
    })).rejects.toThrow(/POSIX environment variable/)
  })
})

describe('CredentialManagerStore local connection test', () => {
  it('passes a complete credential and never attempts a network connection', async () => {
    const dir = await directory()
    const store = new CredentialManagerStore({ dataFile: join(dir, 'credentials.json'), credentials: memoryProvider() })
    const created = await store.create(prefectDraft(), { apiKey: 'secret' })
    const result = await store.test(created.id)
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('validation')
    expect(result.networkAttempted).toBe(false)
    expect(result.checks.some(check => check.id === 'network')).toBe(true)
    const persisted = await store.get(created.id)
    expect(persisted.lastTest?.ok).toBe(true)
  })

  it('fails when the encrypted secret disappears', async () => {
    const dir = await directory()
    const provider = memoryProvider()
    const store = new CredentialManagerStore({ dataFile: join(dir, 'credentials.json'), credentials: provider })
    const created = await store.create(prefectDraft(), { apiKey: 'secret' })
    provider.records.clear()
    const result = await store.test(created.id)
    expect(result.ok).toBe(false)
    expect(result.checks.find(check => check.id === 'secret')?.ok).toBe(false)
  })
})

describe('CredentialManagerStore output hygiene', () => {
  it('drops sensitive-looking keys from a tampered metadata file', async () => {
    const dir = await directory()
    const dataFile = join(dir, 'credentials.json')
    await writeFile(dataFile, JSON.stringify({
      version: 1,
      credentials: [{
        id: 'legacy',
        name: 'Legacy',
        type: 'custom',
        authKind: 'custom',
        config: { endpoint: 'https://example.com', password: 'should-not-surface', apiKey: 'also-not' },
        tags: [],
        enabled: true,
        configuredSecretFields: [],
        secretRef: 'sk-live-secret',
        createdAt: 1,
        updatedAt: 1,
        lastTestedAt: null,
        lastTest: null,
      }],
    }))
    const store = new CredentialManagerStore({ dataFile, credentials: memoryProvider() })
    const state = await store.state()
    expect(JSON.stringify(state)).not.toContain('should-not-surface')
    expect(JSON.stringify(state)).not.toContain('also-not')
    expect(JSON.stringify(state)).not.toContain('sk-live-secret')
    expect(state.credentials[0]?.secretRef).toBeNull()
    expect(state.credentials[0]?.config).toEqual({ endpoint: 'https://example.com' })
  })
})