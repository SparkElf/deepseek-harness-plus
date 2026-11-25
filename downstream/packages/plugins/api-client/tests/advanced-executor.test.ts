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

async function resources(store: ApiClientStore, origin: string) {
  const workspace = await store.saveWorkspace({ id: '', name: 'Test', description: '', collectionIds: [], environmentIds: [] })
  const collection = await store.saveCollection({ id: '', workspaceId: workspace.id, parentId: null, name: 'Requests', description: '', tags: [], requestIds: [] })
  const environment = await store.saveEnvironment({ id: '', workspaceId: workspace.id, name: 'Local', variables: [{ key: 'origin', value: origin, credentialId: null, enabled: true, secret: false }] })
  return { workspace, collection, environment }
}

describe('advanced API execution', () => {
  it('sends multipart parts and replays received cookies', async () => {
    const observed: Array<{ type: string; cookie: string; body: string }> = []
    const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); observed.push({ type: String(request.headers['content-type'] ?? ''), cookie: String(request.headers.cookie ?? ''), body: Buffer.concat(chunks).toString('utf8') }); response.setHeader('set-cookie', 'sid=abc; Path=/; HttpOnly'); response.end('ok') })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('server did not bind')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-api-multipart-'))
    const store = new ApiClientStore({ dataFile: join(directory, 'api.json'), vault: new WorkbenchVault({ directory }) })
    const { collection, environment } = await resources(store, 'http://127.0.0.1:' + address.port.toString())
    const request = await store.saveRequest({ id: '', collectionId: collection.id, name: 'Upload', description: '', method: 'POST', url: '{{origin}}/upload', query: [], headers: [], auth: { kind: 'none', credentialId: null, options: {} }, body: { kind: 'multipart', content: JSON.stringify([{ key: 'title', value: 'demo', enabled: true, type: 'text' }, { key: 'file', value: 'aGVsbG8=', enabled: true, type: 'file', fileName: 'hello.txt', contentType: 'text/plain', encoding: 'base64' }]) }, environmentId: environment.id })
    await executeApiRequest(store, request.id)
    await executeApiRequest(store, request.id)
    expect(observed[0]?.type.startsWith('multipart/form-data; boundary=')).toBe(true)
    expect(observed[0]?.body).toContain('name="title"')
    expect(observed[0]?.body).toContain('filename="hello.txt"')
    expect(observed[1]?.cookie).toBe('sid=abc')
    const binary = await store.saveRequest({ ...request, id: '', name: 'Binary', body: { kind: 'binary', content: Buffer.from('binary-data').toString('base64') } })
    await executeApiRequest(store, binary.id)
    expect(observed[2]?.body).toBe('binary-data')
  })
})
