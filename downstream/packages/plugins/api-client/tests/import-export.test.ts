import { describe, expect, it } from 'vitest'
import { exportApiDocument, importApiDocument } from '../src/import-export.ts'

describe('API import and export', () => {
  it('imports Postman collections and exports a secret-free document', () => {
    const bundle = importApiDocument('postman', { info: { name: 'Postman Demo', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, variable: [{ key: 'origin', value: 'https://example.com' }], item: [{ name: 'Folder', item: [{ name: 'Status', request: { method: 'GET', url: { raw: '{{origin}}/status?verbose=true' }, header: [{ key: 'Accept', value: 'application/json' }], auth: { type: 'bearer', bearer: [{ key: 'token', value: 'private-token' }] } } }] }] })
    expect(bundle.workspace.name).toBe('Postman Demo')
    expect(bundle.collections).toHaveLength(1)
    expect(bundle.requests[0]).toMatchObject({ name: 'Status', method: 'GET', url: '{{origin}}/status' })
    const state = { workspaces: [bundle.workspace], collections: bundle.collections, environments: bundle.environments, requests: bundle.requests, history: [], cookies: [] }
    const exported = exportApiDocument('postman', state, bundle.workspace.id)
    expect(JSON.stringify(exported.document)).not.toContain('private-token')
  })
  it('imports OpenAPI 3 paths and exports an OpenAPI document', () => {
    const bundle = importApiDocument('openapi', { openapi: '3.1.0', info: { title: 'OpenAPI Demo', version: '1.0.0' }, servers: [{ url: 'https://api.example.com' }], paths: { '/users/{id}': { get: { summary: 'Get user', tags: ['Users'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', example: '42' } }, { name: 'verbose', in: 'query', schema: { type: 'boolean', example: true } }] } } } })
    expect(bundle.requests[0]).toMatchObject({ name: 'Get user', method: 'GET', url: '{{baseUrl}}/users/{{id}}' })
    const state = { workspaces: [bundle.workspace], collections: bundle.collections, environments: bundle.environments, requests: bundle.requests, history: [], cookies: [] }
    const exported = exportApiDocument('openapi', state, bundle.workspace.id)
    expect(exported.document.openapi).toBe('3.0.3')
  })
})
