import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkbenchVault } from '@sparkelf/dsh-workbench-vault'
import { ApiClientStore } from '../src/store.ts'

function storeAt(directory: string) { return new ApiClientStore({ dataFile: join(directory, 'api-client.json'), vault: new WorkbenchVault({ directory }) }) }

describe('ApiClientStore', () => {
  it('persists collections and resolves secret environments only inside Host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-api-store-'))
    const vault = new WorkbenchVault({ directory })
    const store = new ApiClientStore({ dataFile: join(directory, 'api-client.json'), vault })
    const workspace = await store.saveWorkspace({ id: '', name: 'Operations', description: '', collectionIds: [], environmentIds: [] })
    const collection = await store.saveCollection({ id: '', workspaceId: workspace.id, parentId: null, name: 'Health', description: '', tags: ['prod'], requestIds: [] })
    const environment = await store.saveEnvironment({ id: '', workspaceId: workspace.id, name: 'Production', variables: [{ key: 'baseUrl', value: 'https://api.example.com', credentialId: null, enabled: true, secret: false }, { key: 'token', value: 'environment-secret', credentialId: null, enabled: true, secret: true }] })
    const request = await store.saveRequest({ id: '', collectionId: collection.id, name: 'Status', description: '', method: 'GET', url: '{{baseUrl}}/status', query: [], headers: [], auth: { kind: 'bearer', credentialId: null, options: {} }, body: { kind: 'none', content: '' }, environmentId: environment.id }, { token: 'auth-secret' })
    const state = await store.state()
    expect(JSON.stringify(state)).not.toContain('environment-secret')
    expect(JSON.stringify(state)).not.toContain('auth-secret')
    expect(await store.environmentValues(environment.id)).toEqual({ baseUrl: 'https://api.example.com', token: 'environment-secret' })
    expect(await store.authSecret(request)).toEqual({ token: 'auth-secret' })
    expect(await readFile(join(directory, 'api-client.json'), 'utf8')).not.toContain('environment-secret')
    expect(await readFile(join(directory, 'workbench-vault.json'), 'utf8')).not.toContain('environment-secret')
    const environmentCredential = environment.variables.find(variable => variable.secret)?.credentialId
    expect(environmentCredential).toBeTruthy()
    expect(request.auth.credentialId).toBeTruthy()
    await store.deleteWorkspace(workspace.id)
    expect(await store.state()).toEqual({ workspaces: [], collections: [], environments: [], requests: [], history: [] })
    await expect(vault.has('api-environment', environmentCredential as string)).resolves.toBe(false)
    await expect(vault.has('api-auth', request.auth.credentialId as string)).resolves.toBe(false)
  })

  it('validates resource ownership and retains bounded history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-api-links-'))
    const store = storeAt(directory)
    await expect(store.saveCollection({ id: '', workspaceId: 'missing', parentId: null, name: 'Invalid', description: '', tags: [], requestIds: [] })).rejects.toThrow(/workspace not found/)
    for (let index = 0; index < 105; index++) await store.addHistory({ id: String(index), requestId: 'request', status: 200, statusText: 'OK', durationMs: 1, sizeBytes: 0, headers: [], body: '', bodyTruncated: false, receivedAt: index })
    // The panel's history tab promises the recent 20, so the store keeps exactly that many.
    expect((await store.state()).history).toHaveLength(20)
    expect((await store.state()).history[0]?.id).toBe('104')
  })
})
