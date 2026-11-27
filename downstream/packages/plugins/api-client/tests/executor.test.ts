import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchVault } from '@sparkelf/dsh-workbench-vault'
import { executeApiRequest } from '../src/executor.ts'
import { ApiClientStore } from '../src/store.ts'

const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })

describe('executeApiRequest', () => {
  it('interpolates environment values, applies auth, and stores bounded history', async () => {
    let observed = { url: '', authorization: '', body: '' }
    const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); observed = { url: request.url ?? '', authorization: String(request.headers.authorization ?? ''), body: Buffer.concat(chunks).toString('utf8') }; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true })) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('server did not bind')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-api-executor-'))
    const store = new ApiClientStore({ dataFile: join(directory, 'api.json'), vault: new WorkbenchVault({ directory }) })
    const workspace = await store.saveWorkspace({ id: '', name: 'Test', description: '', collectionIds: [], environmentIds: [] })
    const collection = await store.saveCollection({ id: '', workspaceId: workspace.id, parentId: null, name: 'Requests', description: '', tags: [], requestIds: [] })
    const environment = await store.saveEnvironment({ id: '', workspaceId: workspace.id, name: 'Local', variables: [{ key: 'origin', value: 'http://127.0.0.1:' + address.port.toString(), credentialId: null, enabled: true, secret: false }] })
    const request = await store.saveRequest({ id: '', collectionId: collection.id, name: 'Create', description: '', method: 'POST', url: '{{origin}}/items', query: [{ key: 'page', value: '2', enabled: true }], headers: [], auth: { kind: 'bearer', credentialId: null, options: {} }, body: { kind: 'json', content: '{"name":"demo"}' }, environmentId: environment.id }, { token: 'private-token' })
    const result = await executeApiRequest(store, request.id)
    expect(result.status).toBe(200)
    expect(result.body).toContain('"ok":true')
    expect(observed).toEqual({ url: '/items?page=2', authorization: 'Bearer private-token', body: '{"name":"demo"}' })
    const state = await store.state()
    expect(state.history[0]?.id).toBe(result.id)
    expect(JSON.stringify(state)).not.toContain('private-token')
  })
})

describe('executeApiRequest cancellation', () => {
  it('reports a cancelled request as a decision, not a transport failure', async () => {
    const server = createServer((_request, response) => {
      // Hold the response open long enough that the caller can cancel first.
      setTimeout(() => { response.setHeader('content-type', 'application/json'); response.end('{"late":true}') }, 400)
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('server did not bind')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-api-cancel-'))
    const store = new ApiClientStore({ dataFile: join(directory, 'api.json'), vault: new WorkbenchVault({ directory }) })
    const workspace = await store.saveWorkspace({ id: '', name: 'Test', description: '', collectionIds: [], environmentIds: [] })
    const collection = await store.saveCollection({ id: '', workspaceId: workspace.id, parentId: null, name: 'Requests', description: '', tags: [], requestIds: [] })
    const request = await store.saveRequest({ id: '', collectionId: collection.id, name: 'Slow', description: '', method: 'GET', url: 'http://127.0.0.1:' + address.port.toString() + '/slow', query: [], headers: [], auth: { kind: 'none', credentialId: null, options: {} }, body: { kind: 'none', content: '' }, environmentId: null })
    const controller = new AbortController()
    const pending = executeApiRequest(store, request.id, controller.signal)
    setTimeout(() => { controller.abort() }, 50)
    await expect(pending).rejects.toThrow(/cancelled/u)
    expect((await store.state()).history).toHaveLength(0)
  })
})
