import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { createCredentialApiHandler, createCredentialHostMethods } from '../src/index.ts'
import { CredentialManagerStore, type CredentialRecordProvider } from '../src/store.ts'

function provider(): CredentialRecordProvider {
  const records = new Map<string, CredentialRecord>()
  return {
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

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credential-api-'))
  const store = new CredentialManagerStore({ dataFile: join(dir, 'credentials.json'), credentials: provider() })
  return { store, methods: createCredentialHostMethods(store) }
}

const savePayload = {
  credential: {
    name: 'DataOps Production',
    type: 'dataops',
    authKind: 'bearer',
    config: { baseUrl: 'https://dataops.example.com', tenant: 'default' },
  },
  secret: { token: 'api-secret-token' },
}

describe('credential Host API methods', () => {
  it('saves, lists, toggles, tests, and deletes through the same mapping the browser uses', async () => {
    const { store, methods } = await fixture()
    expect(Object.keys(methods)).not.toContain('credentials.secret')

    const saved = await methods['credentials.save']?.(savePayload as unknown as Record<string, unknown>)
    const credentialId = (saved as { id: string }).id
    expect(JSON.stringify(saved)).not.toContain('api-secret-token')

    const state = await methods.state?.({})
    expect(JSON.stringify(state)).not.toContain('api-secret-token')
    expect((state as { credentials: unknown[] }).credentials).toHaveLength(1)

    await expect(methods['credentials.save']?.(savePayload as unknown as Record<string, unknown>)).rejects.toThrow(/already exists/)

    const toggled = await methods['credentials.toggle']?.({ credentialId, enabled: false })
    expect((toggled as { enabled: boolean }).enabled).toBe(false)

    const tested = await methods['credentials.test']?.({ credentialId })
    expect((tested as { ok: boolean }).ok).toBe(true)
    expect((tested as { networkAttempted: boolean }).networkAttempted).toBe(false)

    await expect(methods['credentials.delete']?.({ credentialId, confirmName: 'DataOps Production' })).rejects.toThrow(/confirm=true/)
    await expect(methods['credentials.delete']?.({ credentialId, confirm: false, confirmName: 'DataOps Production' })).rejects.toThrow(/confirm=true/)
    await expect(methods['credentials.delete']?.({ credentialId, confirm: true, confirmName: 'Wrong' })).rejects.toThrow(/does not match/)
    expect((await store.state()).credentials).toHaveLength(1)

    const deleted = await methods['credentials.delete']?.({ credentialId, confirm: true, confirmName: 'DataOps Production' })
    expect(deleted).toEqual({ deleted: true, secretCleanup: 'deleted' })
    expect((await store.state()).credentials).toEqual([])
  })

  it('updates an existing credential when the draft carries an id', async () => {
    const { store, methods } = await fixture()
    const saved = await methods['credentials.save']?.(savePayload as unknown as Record<string, unknown>) as { id: string }
    const updated = await methods['credentials.save']?.({
      credential: {
        id: saved.id,
        name: 'DataOps Renamed',
        type: 'dataops',
        authKind: 'bearer',
        config: { baseUrl: 'https://dataops.example.com', tenant: 'analytics' },
      },
      secret: {},
    } as unknown as Record<string, unknown>)
    expect((updated as { name: string }).name).toBe('DataOps Renamed')
    expect((updated as { configuredSecretFields: string[] }).configuredSecretFields).toEqual(['token'])
    expect((await store.state()).credentials).toHaveLength(1)
  })

  it('exposes templates without values', async () => {
    const { methods } = await fixture()
    const result = await methods.templates?.({})
    expect((result as { templates: unknown[] }).templates).toHaveLength(6)
    expect(JSON.stringify(result)).not.toContain('api-secret-token')
  })
})
describe('credential HTTP route', () => {
  it('serves the same-origin API and never leaks a secret in a response', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-credential-http-'))
    const store = new CredentialManagerStore({ dataFile: join(dir, 'credentials.json'), credentials: provider() })
    const server = createServer(createCredentialApiHandler(store))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not bind a port')
    const base = 'http://127.0.0.1:' + String(address.port) + '/dsh-credential-manager/api'
    const post = async (method: string, body: string) => await fetch(base + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    try {
      const saved = await post('credentials.save', JSON.stringify(savePayload))
      expect(saved.status).toBe(200)
      const savedBody = await saved.text()
      expect(savedBody).not.toContain('api-secret-token')

      const state = await post('state', '{}')
      expect(state.status).toBe(200)
      expect(await state.text()).not.toContain('api-secret-token')

      const duplicate = await post('credentials.save', JSON.stringify(savePayload))
      expect(duplicate.status).toBe(409)
      const duplicateBody = await duplicate.text()
      expect(duplicateBody).not.toContain('api-secret-token')
      expect(duplicateBody).toContain('already exists')

      const missingConfirm = await post('credentials.delete', JSON.stringify({ credentialId: 'x', confirmName: 'x' }))
      expect(missingConfirm.status).toBe(400)
      expect(await missingConfirm.text()).toContain('confirm=true')

      const invalidJson = await post('state', '{')
      expect(invalidJson.status).toBe(400)

      const unknown = await post('credentials.secret', '{}')
      expect(unknown.status).toBe(404)

      const tooLarge = await post('state', JSON.stringify({ padding: 'x'.repeat(1_100_000) }))
      expect(tooLarge.status).toBe(413)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
