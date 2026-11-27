import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCredentialHostService } from '../src/service.ts'
import { CredentialManagerStore, type EncryptedVault } from '../src/store.ts'

function memoryVault(): EncryptedVault {
  const values = new Map<string, Record<string, unknown>>()
  return {
    async has(namespace: string, id: string) { return values.has(namespace + '/' + id) },
    async get<T extends Record<string, unknown>>(namespace: string, id: string) {
      return values.get(namespace + '/' + id) as T | undefined
    },
    async set(namespace: string, id: string, value: Record<string, unknown>) { values.set(namespace + '/' + id, value) },
    async delete(namespace: string, id: string) { values.delete(namespace + '/' + id) },
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credential-service-'))
  const store = new CredentialManagerStore({
    dataFile: join(dir, 'credentials.json'),
    vault: memoryVault(),
  })
  const http = await store.create({
    name: 'CRM 登录',
    type: 'http',
    authKind: 'basic',
    config: { baseUrl: 'https://crm.example.com/login', username: 'alice' },
  }, { password: 'crm-secret-value' })
  const disabled = await store.create({
    name: 'CRM 停用',
    type: 'http',
    authKind: 'basic',
    config: { baseUrl: 'https://crm.example.com/login', username: 'disabled' },
    enabled: false,
  }, { password: 'disabled-secret' })
  await store.create({
    name: '其他站点',
    type: 'http',
    authKind: 'basic',
    config: { baseUrl: 'https://other.example.com/', username: 'bob' },
  }, { password: 'other-secret' })
  const custom = await store.create({
    name: '自定义驾驶舱',
    type: 'custom',
    config: { endpoint: 'https://custom.example.com/app' },
  }, { secret: 'custom-secret-value' })
  return { store, service: createCredentialHostService(store), http, custom, disabled }
}

describe('credential manager Host service', () => {
  it('lists only enabled credentials of the queried type and exact origin', async () => {
    const { service } = await fixture()
    const options = await service.listForSite({ type: 'http', origin: 'https://crm.example.com' })
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      name: 'CRM 登录',
      type: 'http',
      authKind: 'basic',
      username: 'alice',
      origin: 'https://crm.example.com',
      secretConfigured: true,
    })
    expect(JSON.stringify(options)).not.toContain('crm-secret-value')
    expect(JSON.stringify(options)).not.toContain('disabled-secret')
  })

  it('lists custom credentials by endpoint origin', async () => {
    const { service } = await fixture()
    const options = await service.listForSite({ type: 'custom', origin: 'https://custom.example.com' })
    expect(options).toHaveLength(1)
    expect(options[0]?.name).toBe('自定义驾驶舱')
    expect(JSON.stringify(options)).not.toContain('custom-secret-value')
  })

  it('refuses a credential that does not match the site query', async () => {
    const { service, http, custom } = await fixture()
    await expect(service.describeForSite(http.id, { type: 'http', origin: 'https://other.example.com' }))
      .rejects.toThrow('does not match')
    await expect(service.describeForSite(custom.id, { type: 'http', origin: 'https://custom.example.com' }))
      .rejects.toThrow('does not match')
  })

  it('refuses an HTTP site origin and reads secrets only through the Host method', async () => {
    const { service, http, disabled } = await fixture()
    await expect(service.listForSite({ type: 'http', origin: 'http://crm.example.com' }))
      .rejects.toThrow('HTTPS')
    const secret = await service.readSecret(http.id)
    expect(secret).toEqual({ password: 'crm-secret-value' })
    await expect(service.readSecret(disabled.id)).rejects.toThrow('disabled')
    const described = await service.describeForSite(http.id, { type: 'http', origin: 'https://crm.example.com' })
    expect(JSON.stringify(described)).not.toContain('crm-secret-value')
  })
})