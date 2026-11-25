import { randomUUID } from 'node:crypto'
import type { ApiAuthSecretInput, ApiClientState, ApiCollection, ApiEnvironment, ApiEnvironmentVariable, ApiKeyValue, ApiMethod, ApiMultipartPart, ApiRequest, ApiWorkspace } from './types.ts'

export type ApiExchangeFormat = 'postman' | 'openapi'
export interface ApiImportBundle {
  workspace: ApiWorkspace
  collections: ApiCollection[]
  environments: ApiEnvironment[]
  requests: ApiRequest[]
  authSecrets: Record<string, ApiAuthSecretInput>
}
export interface ApiExportDocument { fileName: string; mimeType: 'application/json'; document: Record<string, unknown> }

type JsonObject = Record<string, unknown>
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const

function object(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Import document must be a JSON object')
  return value as JsonObject
}

function optionalObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function text(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback }
function bool(value: unknown, fallback = true): boolean { return typeof value === 'boolean' ? value : fallback }
function description(value: unknown): string { return typeof value === 'string' ? value : text(optionalObject(value)?.content) }
function slug(value: string): string { return value.trim().replace(/[^a-z0-9._-]+/giu, '-').replace(/^-|-$/gu, '').toLowerCase() || 'api' }
function keyValues(value: unknown): ApiKeyValue[] {
  return array(value).flatMap(item => {
    const entry = optionalObject(item)
    return entry === undefined || typeof entry.key !== 'string' ? [] : [{ key: entry.key, value: text(entry.value), enabled: entry.disabled !== true, description: description(entry.description) || undefined }]
  })
}

function postmanUrl(value: unknown): { raw: string; query: ApiKeyValue[] } {
  const raw = typeof value === 'string' ? value : text(optionalObject(value)?.raw)
  const query = keyValues(optionalObject(value)?.query)
  if (query.length > 0) return { raw: raw.split('?')[0] ?? raw, query }
  const separator = raw.indexOf('?')
  if (separator < 0) return { raw, query: [] }
  const params = new URLSearchParams(raw.slice(separator + 1))
  return { raw: raw.slice(0, separator), query: [...params].map(([key, itemValue]) => ({ key, value: itemValue, enabled: true })) }
}

function postmanAuth(value: unknown): { auth: ApiRequest['auth']; secret?: ApiAuthSecretInput } {
  const auth = optionalObject(value)
  const type = text(auth?.type, 'none')
  if (type === 'noauth') return { auth: { kind: 'none', credentialId: null, options: {} } }
  if (type === 'inherit') return { auth: { kind: 'inherit', credentialId: null, options: {} } }
  const entries = new Map(keyValues(auth?.[type]).map(entry => [entry.key.toLowerCase(), entry.value]))
  if (type === 'basic') return { auth: { kind: 'basic', credentialId: null, options: {} }, secret: { username: entries.get('username'), password: entries.get('password') } }
  if (type === 'bearer' || type === 'oauth2') return { auth: { kind: type === 'bearer' ? 'bearer' : 'oauth2', credentialId: null, options: {} }, secret: { token: entries.get('token') ?? entries.get('accesstoken') } }
  if (type === 'apikey') return { auth: { kind: 'api-key', credentialId: null, options: { name: entries.get('key') ?? '', location: entries.get('in') === 'query' ? 'query' : 'header' } }, secret: { key: entries.get('value') } }
  return { auth: { kind: 'none', credentialId: null, options: {} } }
}

function postmanBody(value: unknown, headers: ApiKeyValue[]): ApiRequest['body'] {
  const body = optionalObject(value)
  const mode = text(body?.mode, 'none')
  if (mode === 'raw') {
    const language = text(optionalObject(optionalObject(body?.options)?.raw)?.language)
    const contentType = headers.find(header => header.key.toLowerCase() === 'content-type')?.value ?? ''
    const kind = language === 'json' || contentType.includes('json') ? 'json' : language === 'xml' || contentType.includes('xml') ? 'xml' : 'text'
    return { kind, content: text(body?.raw) }
  }
  if (mode === 'urlencoded') {
    const values = keyValues(body?.urlencoded)
    return { kind: 'form', content: values.filter(item => item.enabled).map(item => encodeURIComponent(item.key) + '=' + encodeURIComponent(item.value)).join('&') }
  }
  if (mode === 'formdata') {
    const parts: ApiMultipartPart[] = array(body?.formdata).flatMap(item => {
      const part = optionalObject(item)
      if (part === undefined || typeof part.key !== 'string') return []
      const fileName = Array.isArray(part.src) ? text(part.src[0]) : text(part.src)
      return [{ key: part.key, value: part.type === 'file' ? '' : text(part.value), enabled: part.disabled !== true, type: part.type === 'file' ? 'file' : 'text', fileName: fileName === '' ? undefined : fileName.split(/[\/]/u).at(-1), contentType: text(part.contentType) || undefined, encoding: part.type === 'file' ? 'base64' : undefined }]
    })
    return { kind: 'multipart', content: JSON.stringify(parts, null, 2) }
  }
  if (mode === 'graphql') return { kind: 'graphql', content: text(optionalObject(body?.graphql)?.query) }
  if (mode === 'file') return { kind: 'binary', content: '' }
  return { kind: 'none', content: '' }
}

function importPostman(input: JsonObject): ApiImportBundle {
  const info = object(input.info)
  if (!text(info.schema).includes('schema.getpostman.com')) throw new Error('Only Postman Collection v2.x JSON is supported')
  const workspaceId = randomUUID()
  const workspace: ApiWorkspace = { id: workspaceId, name: text(info.name, 'Imported Postman collection'), description: description(info.description), collectionIds: [], environmentIds: [] }
  const collections: ApiCollection[] = []
  const requests: ApiRequest[] = []
  const authSecrets: Record<string, ApiAuthSecretInput> = {}
  const inheritedAuth = input.auth

  const visit = (items: unknown[], parentId: string | null, fallbackName: string): void => {
    let requestCollectionId = parentId
    for (const itemValue of items) {
      const item = optionalObject(itemValue)
      if (item === undefined) continue
      if (Array.isArray(item.item)) {
        const collection: ApiCollection = { id: randomUUID(), workspaceId, parentId, name: text(item.name, 'Folder'), description: description(item.description), tags: [], requestIds: [] }
        collections.push(collection)
        visit(item.item, collection.id, collection.name)
        continue
      }
      const source = optionalObject(item.request)
      if (source === undefined) continue
      if (requestCollectionId === null) {
        const collection: ApiCollection = { id: randomUUID(), workspaceId, parentId: null, name: fallbackName, description: '', tags: [], requestIds: [] }
        collections.push(collection)
        requestCollectionId = collection.id
      }
      const url = postmanUrl(source.url)
      const headers = keyValues(source.header)
      const authResult = postmanAuth(source.auth ?? inheritedAuth)
      const id = randomUUID()
      const request: ApiRequest = {
        id,
        collectionId: requestCollectionId,
        name: text(item.name, text(source.name, 'Imported request')),
        description: description(item.description) || description(source.description),
        method: text(source.method, 'GET').toUpperCase() as ApiMethod,
        url: url.raw,
        query: url.query,
        headers,
        auth: authResult.auth,
        body: postmanBody(source.body, headers),
        environmentId: null,
      }
      requests.push(request)
      collections.find(collection => collection.id === requestCollectionId)?.requestIds.push(id)
      if (authResult.secret !== undefined && Object.values(authResult.secret).some(Boolean)) authSecrets[id] = authResult.secret
    }
  }
  visit(array(input.item), null, workspace.name)
  const extensionEnvironments = array(input['x-dsh-environments'])
  const environments: ApiEnvironment[] = extensionEnvironments.flatMap(value => {
    const source = optionalObject(value)
    if (source === undefined) return []
    const variables: ApiEnvironmentVariable[] = array(source.variables).flatMap(entryValue => {
      const entry = optionalObject(entryValue)
      if (entry === undefined || typeof entry.key !== 'string') return []
      return [{ key: entry.key, value: entry.secret === true ? null : text(entry.value), credentialId: null, enabled: bool(entry.enabled), secret: entry.secret === true }]
    })
    return [{ id: randomUUID(), workspaceId, name: text(source.name, 'Environment'), variables }]
  })
  workspace.collectionIds = collections.map(collection => collection.id)
  workspace.environmentIds = environments.map(environment => environment.id)
  return { workspace, collections, environments, requests, authSecrets }
}

function schemaExample(schemaValue: unknown): unknown {
  const schema = optionalObject(schemaValue)
  if (schema === undefined) return ''
  if ('example' in schema) return schema.example
  if ('default' in schema) return schema.default
  if (schema.type === 'object' || optionalObject(schema.properties) !== undefined) return Object.fromEntries(Object.entries(optionalObject(schema.properties) ?? {}).map(([key, value]) => [key, schemaExample(value)]))
  if (schema.type === 'array') return [schemaExample(schema.items)]
  if (schema.type === 'boolean') return false
  if (schema.type === 'integer' || schema.type === 'number') return 0
  return ''
}

function openApiBody(value: unknown): ApiRequest['body'] {
  const requestBody = optionalObject(value)
  const content = optionalObject(requestBody?.content)
  if (content === undefined) return { kind: 'none', content: '' }
  const [contentType, mediaValue] = Object.entries(content)[0] ?? []
  if (contentType === undefined) return { kind: 'none', content: '' }
  const media = optionalObject(mediaValue)
  const example = media !== undefined && 'example' in media ? media.example : schemaExample(media?.schema)
  if (contentType.includes('multipart/form-data')) {
    const schema = optionalObject(media?.schema)
    const parts: ApiMultipartPart[] = Object.entries(optionalObject(schema?.properties) ?? {}).map(([key, propertyValue]) => {
      const property = optionalObject(propertyValue)
      const file = property?.format === 'binary'
      return { key, value: file ? '' : String(schemaExample(property)), enabled: true, type: file ? 'file' : 'text', fileName: file ? key : undefined, encoding: file ? 'base64' : undefined }
    })
    return { kind: 'multipart', content: JSON.stringify(parts, null, 2) }
  }
  if (contentType.includes('x-www-form-urlencoded')) {
    const source = optionalObject(example) ?? {}
    return { kind: 'form', content: new URLSearchParams(Object.entries(source).map(([key, item]) => [key, String(item)])).toString() }
  }
  if (contentType.includes('json')) return { kind: 'json', content: JSON.stringify(example, null, 2) }
  if (contentType.includes('xml')) return { kind: 'xml', content: typeof example === 'string' ? example : '' }
  return { kind: 'text', content: typeof example === 'string' ? example : JSON.stringify(example, null, 2) }
}

function openApiAuth(document: JsonObject, operation: JsonObject): ApiRequest['auth'] {
  const security = array(operation.security ?? document.security)
  const requirement = optionalObject(security[0])
  const schemeName = requirement === undefined ? undefined : Object.keys(requirement)[0]
  const schemes = optionalObject(optionalObject(optionalObject(document.components)?.securitySchemes)?.[schemeName ?? ''])
  if (schemes?.type === 'http' && schemes.scheme === 'basic') return { kind: 'basic', credentialId: null, options: {} }
  if (schemes?.type === 'http' && schemes.scheme === 'bearer') return { kind: 'bearer', credentialId: null, options: {} }
  if (schemes?.type === 'oauth2') return { kind: 'oauth2', credentialId: null, options: {} }
  if (schemes?.type === 'apiKey') return { kind: 'api-key', credentialId: null, options: { name: text(schemes.name), location: schemes.in === 'query' ? 'query' : 'header' } }
  return { kind: 'none', credentialId: null, options: {} }
}

function importOpenApi(input: JsonObject): ApiImportBundle {
  if (!text(input.openapi).startsWith('3.')) throw new Error('Only OpenAPI 3.x JSON is supported')
  const info = object(input.info)
  const workspaceId = randomUUID()
  const workspace: ApiWorkspace = { id: workspaceId, name: text(info.title, 'Imported OpenAPI'), description: description(info.description), collectionIds: [], environmentIds: [] }
  const server = optionalObject(array(input.servers)[0])
  const serverUrl = text(server?.url)
  const environmentId = serverUrl === '' ? null : randomUUID()
  const variables: ApiEnvironmentVariable[] = serverUrl === '' ? [] : [{ key: 'baseUrl', value: serverUrl, credentialId: null, enabled: true, secret: false }]
  for (const [key, value] of Object.entries(optionalObject(server?.variables) ?? {})) {
    const variable = optionalObject(value)
    variables.push({ key, value: text(variable?.default), credentialId: null, enabled: true, secret: false })
  }
  const environments: ApiEnvironment[] = environmentId === null ? [] : [{ id: environmentId, workspaceId, name: 'Imported server', variables }]
  const collectionByTag = new Map<string, ApiCollection>()
  const requests: ApiRequest[] = []
  for (const [path, pathValue] of Object.entries(object(input.paths))) {
    const pathItem = optionalObject(pathValue)
    if (pathItem === undefined) continue
    for (const method of METHODS) {
      const operation = optionalObject(pathItem[method])
      if (operation === undefined) continue
      const tag = text(array(operation.tags)[0], 'Requests')
      let collection = collectionByTag.get(tag)
      if (collection === undefined) {
        collection = { id: randomUUID(), workspaceId, parentId: null, name: tag, description: '', tags: [], requestIds: [] }
        collectionByTag.set(tag, collection)
      }
      const parameters: JsonObject[] = [...array(pathItem.parameters), ...array(operation.parameters)].flatMap(value => {
        const parameter = optionalObject(value)
        return parameter === undefined ? [] : [parameter]
      })
      const pathVariables: ApiEnvironmentVariable[] = []
      const query: ApiKeyValue[] = []
      const headers: ApiKeyValue[] = []
      for (const parameter of parameters) {
        const location = text(parameter.in)
        const value = String(schemaExample(parameter.schema))
        if (location === 'query') query.push({ key: text(parameter.name), value, enabled: parameter.required === true, description: description(parameter.description) || undefined })
        else if (location === 'header') headers.push({ key: text(parameter.name), value, enabled: parameter.required === true, description: description(parameter.description) || undefined })
        else if (location === 'path' && environmentId !== null) pathVariables.push({ key: text(parameter.name), value, credentialId: null, enabled: true, secret: false })
      }
      environments[0]?.variables.push(...pathVariables.filter(candidate => !environments[0]?.variables.some(existing => existing.key === candidate.key)))
      const id = randomUUID()
      const request: ApiRequest = {
        id,
        collectionId: collection.id,
        name: text(operation.summary, text(operation.operationId, method.toUpperCase() + ' ' + path)),
        description: description(operation.description),
        method: method.toUpperCase() as ApiMethod,
        url: (serverUrl === '' ? '' : '{{baseUrl}}') + path.replace(/\{([^{}]+)\}/gu, '{{$1}}'),
        query,
        headers,
        auth: openApiAuth(input, operation),
        body: openApiBody(operation.requestBody),
        environmentId,
      }
      requests.push(request)
      collection.requestIds.push(id)
    }
  }
  const collections = [...collectionByTag.values()]
  workspace.collectionIds = collections.map(collection => collection.id)
  workspace.environmentIds = environments.map(environment => environment.id)
  return { workspace, collections, environments, requests, authSecrets: {} }
}

export function importApiDocument(format: ApiExchangeFormat, document: unknown): ApiImportBundle {
  const input = object(document)
  return format === 'postman' ? importPostman(input) : importOpenApi(input)
}

function postmanBodyFromRequest(request: ApiRequest): JsonObject | undefined {
  if (request.body.kind === 'none') return undefined
  if (request.body.kind === 'json' || request.body.kind === 'text' || request.body.kind === 'xml') return { mode: 'raw', raw: request.body.content, options: { raw: { language: request.body.kind === 'json' ? 'json' : request.body.kind === 'xml' ? 'xml' : 'text' } } }
  if (request.body.kind === 'graphql') return { mode: 'graphql', graphql: { query: request.body.content, variables: '' } }
  if (request.body.kind === 'form') return { mode: 'urlencoded', urlencoded: [...new URLSearchParams(request.body.content)].map(([key, value]) => ({ key, value, type: 'text' })) }
  if (request.body.kind === 'multipart') return { mode: 'formdata', formdata: (() => { try { return JSON.parse(request.body.content) as unknown[] } catch { return [] } })().flatMap(value => { const part = optionalObject(value); return part === undefined ? [] : [{ key: text(part.key), value: part.type === 'file' ? undefined : text(part.value), src: part.type === 'file' ? text(part.fileName) : undefined, type: part.type === 'file' ? 'file' : 'text', disabled: part.enabled === false }] }) }
  return { mode: 'file', file: {} }
}

function postmanAuthFromRequest(request: ApiRequest): JsonObject | undefined {
  if (request.auth.kind === 'none') return { type: 'noauth' }
  if (request.auth.kind === 'inherit') return undefined
  if (request.auth.kind === 'basic') return { type: 'basic', basic: [{ key: 'username', value: '', type: 'string' }, { key: 'password', value: '', type: 'string' }] }
  if (request.auth.kind === 'bearer' || request.auth.kind === 'oauth2') return { type: request.auth.kind, [request.auth.kind]: [{ key: 'token', value: '', type: 'string' }] }
  if (request.auth.kind === 'api-key') return { type: 'apikey', apikey: [{ key: 'key', value: request.auth.options.name ?? '', type: 'string' }, { key: 'value', value: '', type: 'string' }, { key: 'in', value: request.auth.options.location ?? 'header', type: 'string' }] }
  return undefined
}

function exportPostman(state: ApiClientState, workspace: ApiWorkspace): ApiExportDocument {
  const collections = state.collections.filter(collection => collection.workspaceId === workspace.id)
  const requests = state.requests.filter(request => collections.some(collection => collection.id === request.collectionId))
  const items = (parentId: string | null): JsonObject[] => collections.filter(collection => collection.parentId === parentId).map(collection => ({
    name: collection.name,
    description: collection.description,
    item: [
      ...requests.filter(request => request.collectionId === collection.id).map(request => ({ name: request.name, description: request.description, request: { method: request.method, header: request.headers.map(header => ({ key: header.key, value: header.value, disabled: !header.enabled, description: header.description })), url: { raw: request.url + (request.query.length > 0 ? '?' + new URLSearchParams(request.query.filter(item => item.enabled).map(item => [item.key, item.value])).toString() : ''), query: request.query.map(item => ({ key: item.key, value: item.value, disabled: !item.enabled, description: item.description })) }, auth: postmanAuthFromRequest(request), body: postmanBodyFromRequest(request) } })),
      ...items(collection.id),
    ],
  }))
  const document = {
    info: { name: workspace.name, description: workspace.description, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: items(null),
    'x-dsh-environments': state.environments.filter(environment => environment.workspaceId === workspace.id).map(environment => ({ name: environment.name, variables: environment.variables.map(variable => ({ key: variable.key, value: variable.secret ? null : variable.value, enabled: variable.enabled, secret: variable.secret })) })),
  }
  return { fileName: slug(workspace.name) + '.postman_collection.json', mimeType: 'application/json', document }
}

function openApiRequestBody(request: ApiRequest): JsonObject | undefined {
  if (request.body.kind === 'none') return undefined
  const contentType = request.body.kind === 'json' || request.body.kind === 'graphql' ? 'application/json' : request.body.kind === 'xml' ? 'application/xml' : request.body.kind === 'form' ? 'application/x-www-form-urlencoded' : request.body.kind === 'multipart' ? 'multipart/form-data' : 'text/plain'
  let example: unknown = request.body.content
  if (request.body.kind === 'json') { try { example = JSON.parse(request.body.content) } catch { example = request.body.content } }
  return { content: { [contentType]: { example } } }
}

function exportOpenApi(state: ApiClientState, workspace: ApiWorkspace): ApiExportDocument {
  const collectionIds = new Set(state.collections.filter(collection => collection.workspaceId === workspace.id).map(collection => collection.id))
  const paths: JsonObject = {}
  for (const request of state.requests.filter(item => collectionIds.has(item.collectionId))) {
    const normalized = request.url.replace(/^\{\{baseUrl\}\}/u, '')
    let path = normalized
    try { path = new URL(normalized).pathname } catch { path = normalized.split('?')[0] ?? normalized }
    if (!path.startsWith('/')) path = '/' + path
    const pathItem = optionalObject(paths[path]) ?? {}
    const collection = state.collections.find(item => item.id === request.collectionId)
    pathItem[request.method.toLowerCase()] = {
      summary: request.name,
      description: request.description,
      tags: collection === undefined ? [] : [collection.name],
      parameters: [
        ...request.query.map(item => ({ name: item.key, in: 'query', required: item.enabled, description: item.description, schema: { type: 'string', example: item.value } })),
        ...request.headers.map(item => ({ name: item.key, in: 'header', required: item.enabled, description: item.description, schema: { type: 'string', example: item.value } })),
      ],
      requestBody: openApiRequestBody(request),
      responses: { default: { description: 'Response' } },
    }
    paths[path] = pathItem
  }
  const firstEnvironment = state.environments.find(environment => environment.workspaceId === workspace.id)
  const baseUrl = firstEnvironment?.variables.find(variable => variable.key === 'baseUrl' && !variable.secret)?.value
  const document: JsonObject = { openapi: '3.0.3', info: { title: workspace.name, description: workspace.description, version: '1.0.0' }, paths }
  if (baseUrl) document.servers = [{ url: baseUrl }]
  return { fileName: slug(workspace.name) + '.openapi.json', mimeType: 'application/json', document }
}

export function exportApiDocument(format: ApiExchangeFormat, state: ApiClientState, workspaceId: string): ApiExportDocument {
  const workspace = state.workspaces.find(item => item.id === workspaceId)
  if (workspace === undefined) throw new Error('API workspace not found: ' + workspaceId)
  return format === 'postman' ? exportPostman(state, workspace) : exportOpenApi(state, workspace)
}
