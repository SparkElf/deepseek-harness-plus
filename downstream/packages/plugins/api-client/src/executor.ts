import { randomUUID } from 'node:crypto'
import type { ApiAuthSecretInput, ApiKeyValue, ApiMultipartPart, ApiRequest, ApiResponse } from './types.ts'
import { ApiClientStore } from './store.ts'
import { interpolate } from './curl.ts'
import { buildCurlCommand } from './curl-command.ts'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

function enabled(values: ApiKeyValue[], variables: Record<string, string>): ApiKeyValue[] {
  return values.filter(value => value.enabled).map(value => ({ ...value, key: interpolate(value.key, variables), value: interpolate(value.value, variables) }))
}

function applyAuth(headers: Headers, url: URL, request: ApiRequest, secret: ApiAuthSecretInput | undefined): void {
  const kind = request.auth.kind
  if (kind === 'none' || kind === 'inherit') return
  if (secret === undefined) throw new Error('API authorization credential is not configured')
  if (kind === 'basic') {
    headers.set('authorization', 'Basic ' + Buffer.from((secret.username ?? '') + ':' + (secret.password ?? '')).toString('base64'))
    return
  }
  if (kind === 'bearer' || kind === 'oauth2') {
    if (!secret.token) throw new Error('API bearer token is not configured')
    headers.set('authorization', 'Bearer ' + secret.token)
    return
  }
  if (kind === 'api-key') {
    const name = request.auth.options.name?.trim()
    if (!name || !secret.key) throw new Error('API key name and value are required')
    if (request.auth.options.location === 'query') url.searchParams.set(name, secret.key)
    else headers.set(name, secret.key)
    return
  }
  throw new Error('AWS SigV4 execution is not implemented yet')
}

export function parseMultipartContent(content: string): ApiMultipartPart[] {
  let parsed: unknown
  try { parsed = JSON.parse(content === '' ? '[]' : content) } catch { throw new Error('Multipart body must be a JSON array') }
  if (!Array.isArray(parsed)) throw new Error('Multipart body must be a JSON array')
  return parsed.map((value, index) => {
    if (typeof value !== 'object' || value === null) throw new Error('Multipart part ' + (index + 1).toString() + ' must be an object')
    const part = value as Partial<ApiMultipartPart>
    if (typeof part.key !== 'string' || typeof part.value !== 'string') throw new Error('Multipart part ' + (index + 1).toString() + ' requires string key and value')
    if (part.type !== undefined && part.type !== 'text' && part.type !== 'file') throw new Error('Multipart part ' + (index + 1).toString() + ' has an invalid type')
    if (part.encoding !== undefined && part.encoding !== 'plain' && part.encoding !== 'base64') throw new Error('Multipart part ' + (index + 1).toString() + ' has an invalid encoding')
    return {
      key: part.key,
      value: part.value,
      enabled: part.enabled !== false,
      description: typeof part.description === 'string' ? part.description : undefined,
      type: part.type ?? 'text',
      fileName: typeof part.fileName === 'string' ? part.fileName : undefined,
      contentType: typeof part.contentType === 'string' ? part.contentType : undefined,
      encoding: part.encoding,
    }
  })
}

function multipartBody(content: string, variables: Record<string, string>, headers: Headers): FormData {
  const form = new FormData()
  for (const part of parseMultipartContent(content)) {
    if (!part.enabled) continue
    const key = interpolate(part.key, variables)
    const value = interpolate(part.value, variables)
    if (part.type === 'text') form.append(key, value)
    else {
      const bytes = part.encoding === 'base64' ? Buffer.from(value, 'base64') : Buffer.from(value, 'utf8')
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      form.append(key, new Blob([arrayBuffer], { type: part.contentType || 'application/octet-stream' }), part.fileName || 'file')
    }
  }
  headers.delete('content-type')
  return form
}

function requestBody(request: ApiRequest, variables: Record<string, string>, headers: Headers): BodyInit | undefined {
  if (request.body.kind === 'none') return undefined
  if (request.body.kind === 'multipart') return multipartBody(request.body.content, variables, headers)
  const body = interpolate(request.body.content, variables)
  if (request.body.kind === 'json') { if (!headers.has('content-type')) headers.set('content-type', 'application/json'); JSON.parse(body); return body }
  if (request.body.kind === 'graphql') { if (!headers.has('content-type')) headers.set('content-type', 'application/json'); return JSON.stringify({ query: body }) }
  if (request.body.kind === 'form') { if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded'); return body }
  if (request.body.kind === 'xml') { if (!headers.has('content-type')) headers.set('content-type', 'application/xml'); return body }
  if (request.body.kind === 'text') { if (!headers.has('content-type')) headers.set('content-type', 'text/plain'); return body }
  if (request.body.kind === 'binary') return Buffer.from(body, 'base64')
  throw new Error('Unsupported API request body kind')
}

async function boundedBody(response: Response): Promise<{ body: string; bytes: number; truncated: boolean }> {
  if (response.body === null) return { body: '', bytes: 0, truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    const remaining = MAX_RESPONSE_BYTES - bytes
    if (remaining <= 0) { truncated = true; await reader.cancel(); break }
    chunks.push(value.byteLength <= remaining ? value : value.subarray(0, remaining))
    bytes += Math.min(value.byteLength, remaining)
    if (value.byteLength > remaining) { truncated = true; await reader.cancel(); break }
  }
  const body = new TextDecoder(response.headers.get('content-type')?.match(/charset=([^;]+)/iu)?.[1] ?? 'utf-8').decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
  return { body, bytes, truncated }
}

function responseCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  if (getSetCookie !== undefined) return getSetCookie.call(headers)
  const combined = headers.get('set-cookie')
  return combined === null ? [] : [combined]
}

export async function executeApiRequest(store: ApiClientStore, requestId: string, cancel?: AbortSignal): Promise<ApiResponse> {
  const request = await store.request(requestId)
  const variables = await store.environmentValues(request.environmentId)
  const url = new URL(interpolate(request.url, variables))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('API Client only supports HTTP and HTTPS URLs')
  if (url.username !== '' || url.password !== '') throw new Error('Credentials in API URLs are not allowed; use the authorization editor')
  for (const item of enabled(request.query, variables)) url.searchParams.append(item.key, item.value)
  const headers = new Headers(enabled(request.headers, variables).map(item => [item.key, item.value] as [string, string]))
  applyAuth(headers, url, request, await store.authSecret(request))
  const cookie = await store.cookieHeader(url)
  if (cookie !== '' && !headers.has('cookie')) headers.set('cookie', cookie)
  const body = requestBody(request, variables, headers)
  const started = performance.now()
  const timeout = AbortSignal.timeout(30_000)
  const signal = cancel === undefined ? timeout : AbortSignal.any([timeout, cancel])
  let response: Response
  try {
    response = await fetch(url, { method: request.method, headers, body, redirect: 'follow', signal })
  } catch (cause) {
    // A user cancellation is a decision, not a transport failure; saying so is what keeps
    // the panel from reporting "fetch failed" after the reader pressed Cancel.
    if (cancel?.aborted === true) throw new Error('API request cancelled')
    throw cause
  }
  await store.storeResponseCookies(url, responseCookies(response.headers))
  const payload = await boundedBody(response)
  const result: ApiResponse = {
    id: randomUUID(), requestId: request.id, status: response.status, statusText: response.statusText,
    durationMs: Math.round(performance.now() - started), sizeBytes: Number(response.headers.get('content-length') ?? payload.bytes),
    headers: [...response.headers.entries()].map(([key, value]) => ({ key, value, enabled: true })), body: payload.body, bodyTruncated: payload.truncated, receivedAt: Date.now(),
  }
  await store.addHistory(result)
  return result
}


/**
 * Build the copyable `curl` command for one saved request.
 *
 * Separate from {@link executeApiRequest} because the command must also be available from
 * a history row (the response is already stored; nothing is sent). It resolves the same
 * environment values and secrets the executor would use.
 * @param store - the API client store.
 * @param requestId - the saved request.
 * @returns the command text.
 */
export async function buildCurlForRequest(store: ApiClientStore, requestId: string): Promise<string> {
  const request = await store.request(requestId)
  const variables = await store.environmentValues(request.environmentId)
  const secret = await store.authSecret(request)
  const url = new URL(interpolate(request.url, variables))
  const cookie = await store.cookieHeader(url)
  return buildCurlCommand(request, variables, secret, cookie)
}
