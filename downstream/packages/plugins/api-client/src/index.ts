import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ApiContext } from './context.ts'
import { buildCurlForRequest, executeApiRequest } from './executor.ts'
import { exportApiDocument, importApiDocument, type ApiExchangeFormat } from './import-export.ts'
import { ApiClientStore } from './store.ts'
import type { ApiAuthSecretInput, ApiCollection, ApiEnvironment, ApiRequest, ApiWorkspace } from './types.ts'

export * from './types.ts'
export * from './import-export.ts'
export { ApiClientStore } from './store.ts'
export { buildCurlForRequest, executeApiRequest } from './executor.ts'
export const name = 'api-client'
export const inject = ['webServer', 'tools', 'approval', 'credentials']
type ToolJson = null | boolean | number | string | ToolJson[] | { [key: string]: ToolJson }
function toolJson<T>(value: T): Record<string, ToolJson> { return value as unknown as Record<string, ToolJson> }

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Uint8Array[] = []; for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk); return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }
function writeJson(res: ServerResponse, status: number, value: unknown): void { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(body) }
function sanitizedRequest(request: ApiRequest): Record<string, ToolJson> {
  // Omit credentialId entirely: an `undefined` own property is not lossless JSON and the
  // tool-output validator rejects it. Destructuring keeps the rest of the request intact.
  const { credentialId: _credentialId, ...auth } = request.auth
  return { ...request, auth } as unknown as Record<string, ToolJson>
}
function exchangeFormat(value: unknown): ApiExchangeFormat {
  if (value !== 'postman' && value !== 'openapi') throw new Error('API exchange format must be postman or openapi')
  return value
}

export type ApiClientHostMethods = Record<string, (payload: Record<string, unknown>) => Promise<unknown>>

export function createApiClientHostMethods(store: ApiClientStore): ApiClientHostMethods {
  /** In-flight executions, so the page's Cancel button can abort the one it started. */
  const running = new Map<string, AbortController>()
  return {
    state: () => store.state(),
    'workspaces.save': async payload => { await store.saveWorkspace(payload.workspace as ApiWorkspace); return store.state() },
    'workspaces.delete': async payload => { await store.deleteWorkspace(String(payload.workspaceId)); return store.state() },
    'collections.save': async payload => { await store.saveCollection(payload.collection as ApiCollection); return store.state() },
    'collections.delete': async payload => { await store.deleteCollection(String(payload.collectionId)); return store.state() },
    'environments.save': async payload => { await store.saveEnvironment(payload.environment as ApiEnvironment); return store.state() },
    'environments.delete': async payload => { await store.deleteEnvironment(String(payload.environmentId)); return store.state() },
    'requests.save': async payload => { await store.saveRequest(payload.request as ApiRequest, payload.authSecret as ApiAuthSecretInput | undefined); return store.state() },
    'requests.delete': async payload => { await store.deleteRequest(String(payload.requestId)); return store.state() },
    'requests.execute': async payload => {
      const requestId = String(payload.requestId)
      const controller = new AbortController()
      running.set(requestId, controller)
      try {
        const response = await executeApiRequest(store, requestId, controller.signal)
        return { response, state: await store.state() }
      } finally {
        running.delete(requestId)
      }
    },
    'requests.cancel': async payload => {
      const requestId = String(payload.requestId)
      const controller = running.get(requestId)
      if (controller === undefined) return { cancelled: false }
      controller.abort()
      return { cancelled: true }
    },
    'requests.curl': async payload => ({ curl: await buildCurlForRequest(store, String(payload.requestId)) }),
    'workspaces.import': async payload => {
      const bundle = importApiDocument(exchangeFormat(payload.format), payload.document)
      await store.saveWorkspace(bundle.workspace)
      for (const collection of bundle.collections) await store.saveCollection(collection)
      for (const environment of bundle.environments) await store.saveEnvironment(environment)
      for (const request of bundle.requests) await store.saveRequest(request, bundle.authSecrets[request.id])
      return { workspaceId: bundle.workspace.id, state: await store.state() }
    },
    'workspaces.export': async payload => exportApiDocument(exchangeFormat(payload.format), await store.state(), String(payload.workspaceId)),
  }
}

/** Register API collection CRUD, explicit execution, import/export, history, and sanitized model tools. */
export function apply(ctx: ApiContext): void {
  const store = new ApiClientStore()
  const logger = ctx.logger as unknown as { error(...args: unknown[]): void }
  const methods = createApiClientHostMethods(store)
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-api-client/api', handler: async (req, res) => {
    const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice('/dsh-api-client/api/'.length)
    try { const handler = methods[method]; if (handler === undefined) throw new Error('Unknown API Client method: ' + method); writeJson(res, 200, await handler(await readBody(req))) }
    catch (error) { logger.error('[dsh-api-client] API request failed', error); writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) }) }
  } }), 'dsh-api-client: HTTP API')
  const open = { type: 'object', additionalProperties: true } as const
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'api_list_requests', description: 'List API workspaces, collections, environments, and requests without secret values.', parameters: {}, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async () => { const state = await store.state(); return toolJson({ workspaces: state.workspaces, collections: state.collections, environments: state.environments, requests: state.requests.map(sanitizedRequest) }) } })), 'dsh-api-client: list requests tool')
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'api_get_request', description: 'Read one saved API request without authorization secrets.', parameters: { request_id: { type: 'string', required: true } }, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args: { request_id: string }) => sanitizedRequest(await store.request(args.request_id)) })), 'dsh-api-client: get request tool')
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'api_prepare_request', description: 'Prepare but do not execute a saved API request for user review in the API Client.', parameters: { request_id: { type: 'string', required: true } }, output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute: async (args: { request_id: string }) => toolJson({ request: sanitizedRequest(await store.request(args.request_id)), executable: false, reason: 'Open the API Client and explicitly send the request.' }) })), 'dsh-api-client: prepare request tool')

  const approve = async (tool: string, exec: { agent?: unknown; callId: string; signal: AbortSignal }, reason: string): Promise<void> => {
    if (exec.agent === undefined) throw new Error(tool + ' requires an initiating agent')
    const outcome = await ctx.approval.request({ agent: exec.agent, toolName: tool, callId: exec.callId, signal: exec.signal, reason })
    if (outcome !== 'allowed-once') throw new Error(tool + ' approval was ' + outcome)
  }
  const resolveSecret = async (tool: string, ref: string): Promise<string> => {
    const resolved = await ctx.credentials.resolve(ref)
    if (resolved?.value === undefined || resolved.value === '') throw new Error(tool + ': credentialRef is not configured: ' + ref)
    return resolved.value
  }
  const audit = (tool: string, exec: { agent?: unknown; callId: string }, detail: Record<string, unknown>): void => {
    try {
      const agent = exec.agent as { session?: { id?: string } } | undefined
      ctx.logger.info('[audit] ' + tool + ' ' + JSON.stringify({ sessionId: agent?.session?.id ?? null, callId: exec.callId, ...detail }))
    } catch { /* audit must not fail the tool */ }
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'api_save_request',
    description: 'Create or update an API Client request (workspace/collection/name/method/url/query/headers/body). Authorization takes a credential_ref naming a DSH credential, never a plaintext token; configure secrets in the DSH Credentials UI. The write requires user approval and is audited; the returned request has no secret values.',
    parameters: {
      request_id: { type: 'string', description: 'Existing request id to update; omit to create.' },
      workspace_id: { type: 'string', description: 'Workspace id; required when collection_id is omitted.' },
      collection_id: { type: 'string', description: 'Collection id. When omitted, the first collection of workspace_id is used.' },
      name: { type: 'string', required: true, description: 'Request name.' },
      method: { type: 'string', description: 'GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS.' },
      url: { type: 'string', required: true, description: 'URL, may contain {{environment variables}}.' },
      query: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Query rows: key/value/enabled.' },
      headers: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Header rows: key/value/enabled.' },
      body_kind: { type: 'string', description: 'none/json/text/xml/form/graphql.' },
      body: { type: 'string', description: 'Body content (JSON bodies are validated by the client UI).' },
      environment_id: { type: 'string', description: 'Environment id; empty string clears it.' },
      auth_kind: { type: 'string', description: 'none/bearer/basic/api-key.' },
      credential_ref: { type: 'string', description: 'DSH credential reference holding the token/password/key. Never pass the secret itself.' },
      auth_username: { type: 'string', description: 'Username for basic auth.' },
      auth_header: { type: 'string', description: 'Header name for api-key auth; defaults to X-API-Key.' },
    },
    output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: async (args: {
      request_id?: string; workspace_id?: string; collection_id?: string; name: string; method?: string; url: string
      query?: Array<Record<string, unknown>>; headers?: Array<Record<string, unknown>>; body_kind?: string; body?: string
      environment_id?: string; auth_kind?: string; credential_ref?: string; auth_username?: string; auth_header?: string
    }, exec) => {
      const tool = 'api_save_request'
      await approve(tool, exec, 'Save API request ' + args.name)
      const state = await store.state()
      const existing = args.request_id === undefined ? undefined : await store.request(args.request_id)
      const collectionId = args.collection_id ?? existing?.collectionId ?? state.collections.find(item => item.workspaceId === args.workspace_id)?.id
      if (collectionId === undefined) throw new Error(tool + ': collection_id or a workspace with a collection is required')
      const rows = (input: Array<Record<string, unknown>> | undefined, fallback: ApiRequest['query']): ApiRequest['query'] =>
        input === undefined ? fallback.map(row => ({ ...row })) : input.map(row => ({
          key: String(row.key ?? ''), value: String(row.value ?? ''), enabled: row.enabled !== false,
          ...(typeof row.description === 'string' ? { description: row.description } : {}),
        }))
      const authKind = (args.auth_kind ?? existing?.auth.kind ?? 'none') as ApiRequest['auth']['kind']
      const options: Record<string, string> = { ...existing?.auth.options }
      if (args.auth_username !== undefined) options.username = args.auth_username
      if (args.auth_header !== undefined) options.header = args.auth_header
      let authSecret: ApiAuthSecretInput | undefined
      if (args.credential_ref !== undefined) {
        const secret = await resolveSecret(tool, args.credential_ref)
        authSecret = authKind === 'basic'
          ? { username: args.auth_username ?? existing?.auth.options.username ?? '', password: secret }
          : authKind === 'api-key' ? { key: secret } : { token: secret }
      }
      const request: ApiRequest = {
        id: args.request_id ?? '', collectionId, name: args.name, description: existing?.description ?? '',
        method: (args.method ?? existing?.method ?? 'GET') as ApiRequest['method'], url: args.url,
        query: rows(args.query, existing?.query ?? []), headers: rows(args.headers, existing?.headers ?? []),
        auth: { kind: authKind, credentialId: existing?.auth.credentialId ?? null, options },
        body: args.body_kind === undefined && args.body === undefined
          ? (existing?.body ?? { kind: 'none', content: '' })
          : { kind: (args.body_kind ?? existing?.body.kind ?? 'json') as ApiRequest['body']['kind'], content: args.body ?? existing?.body.content ?? '' },
        environmentId: args.environment_id === undefined ? existing?.environmentId ?? null : args.environment_id === '' ? null : args.environment_id,
      }
      const saved = await store.saveRequest(request, authSecret)
      audit(tool, exec, { requestId: saved.id, collectionId: saved.collectionId, authKind: saved.auth.kind, hasCredentialRef: args.credential_ref !== undefined })
      return sanitizedRequest(saved)
    },
  })), 'dsh-api-client: save request tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'api_save_environment',
    description: 'Create or update an API Client environment. Non-secret variables carry a value; secret variables take credential_ref naming a DSH credential and never a plaintext value. The write requires user approval and is audited; secret values are never returned.',
    parameters: {
      environment_id: { type: 'string', description: 'Existing environment id to update; omit to create.' },
      workspace_id: { type: 'string', required: true, description: 'Workspace id.' },
      name: { type: 'string', required: true, description: 'Environment name.' },
      variables: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true, description: 'Rows: key, value for plain, secret:true + credential_ref for secret, enabled.' },
    },
    output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: async (args: { environment_id?: string; workspace_id: string; name: string; variables: Array<Record<string, unknown>> }, exec) => {
      const tool = 'api_save_environment'
      await approve(tool, exec, 'Save API environment ' + args.name)
      const state = await store.state()
      const existing = args.environment_id === undefined ? undefined : state.environments.find(item => item.id === args.environment_id)
      const variables: ApiEnvironment['variables'] = []
      for (const row of args.variables) {
        const key = String(row.key ?? '').trim()
        if (key === '') continue
        const secret = row.secret === true
        const previous = existing?.variables.find(item => item.key === key)
        if (secret) {
          const ref = typeof row.credential_ref === 'string' ? row.credential_ref : undefined
          if (ref === undefined) {
            if (previous?.credentialId === null || previous?.credentialId === undefined) throw new Error(tool + ': secret variable ' + key + ' requires credential_ref')
            variables.push({ ...previous, enabled: row.enabled !== false, secret: true })
            continue
          }
          const value = await resolveSecret(tool, ref)
          variables.push({ key, value, credentialId: previous?.credentialId ?? null, enabled: row.enabled !== false, secret: true })
        } else {
          variables.push({ key, value: row.value === undefined || row.value === null ? '' : String(row.value), credentialId: null, enabled: row.enabled !== false, secret: false })
        }
      }
      const saved = await store.saveEnvironment({ id: args.environment_id ?? '', workspaceId: args.workspace_id, name: args.name, variables })
      audit(tool, exec, { environmentId: saved.id, workspaceId: saved.workspaceId, secrets: variables.filter(item => item.secret).map(item => item.key) })
      return { ...saved, variables: saved.variables.map(variable => ({ ...variable, value: variable.secret ? null : variable.value })) }
    },
  })), 'dsh-api-client: save environment tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'api_delete_request',
    description: 'Delete one saved API Client request and its stored authorization secret. Requires user approval; the result is audited.',
    parameters: { request_id: { type: 'string', required: true, description: 'Request id to delete.' } },
    output: { schema: open, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: async (args: { request_id: string }, exec) => {
      await approve('api_delete_request', exec, 'Delete API request ' + args.request_id)
      await store.deleteRequest(args.request_id)
      audit('api_delete_request', exec, { requestId: args.request_id })
      return { deleted: args.request_id }
    },
  })), 'dsh-api-client: delete request tool')

}
