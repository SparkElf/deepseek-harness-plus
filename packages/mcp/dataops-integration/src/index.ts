/**
 * Optional DataOps MCP integration. Anonymous mode mounts the generic MCP
 * client without Authorization. Supplying `credentialRef` additionally owns a
 * loopback browser OAuth + PKCE handoff that stores the resulting DataOps MCP
 * token through `ctx.credentials` before mounting the same generic client.
 * @module @deepseek-ai/dsh-mcp-dataops
 */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

export const name = 'mcp-dataops'
export const inject = ['webServer', 'tools']

const CLIENT_ID = 'deepseek-harness-plus'
const SCOPE = 'dataops.mcp'
const INTEGRATION_PATH = '/integrations/dataops'
const CONNECT_PATH = `${INTEGRATION_PATH}/connect`
const CALLBACK_PATH = `${INTEGRATION_PATH}/callback`
const PENDING_TTL_MS = 10 * 60 * 1000

export interface Config {
  /** DataOps origin, for example `https://dataops.example.com`. */
  baseUrl: string
  /** Local MCP tool namespace. */
  serverName: string
  /** Optional credential reference. Omit it to connect to DataOps anonymously. */
  credentialRef?: string
  /** Per-MCP-tool timeout forwarded to the generic mcp-client. */
  toolCallTimeoutMs: number
  /** Whether an immediately attempted MCP connection failure rejects this plugin. */
  failOnStartupError: boolean
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
  serverName: z.string().default('dataops'),
  credentialRef: z.string().role('credential-ref'),
  toolCallTimeoutMs: z.number().min(1).default(60_000),
  failOnStartupError: z.boolean().default(false),
})

type PendingAuthorization = Readonly<{
  verifier: string
  redirectUri: string
  createdAt: number
}>

type TokenResponse = Readonly<{
  access_token: string
  token_type: string
  expires_in: number
  scope: string
}>

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('mcp-dataops: baseUrl must be an absolute http(s) origin')
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== '') {
    throw new Error('mcp-dataops: baseUrl must be an http(s) origin without path, query, credentials, or fragment')
  }
  return url.origin
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function requireLoopback(request: IncomingMessage, response: ServerResponse): boolean {
  if (isLoopbackRequest(request)) return true
  response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('DataOps authorization is available only from the local DSH browser.')
  return false
}

function requireGet(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method === 'GET') return true
  response.writeHead(405, { allow: 'GET' })
  response.end()
  return false
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
}

function statusPage(input: { baseUrl: string; authConfigured: boolean; credentialConfigured: boolean | null }): string {
  const mode = input.authConfigured ? 'OAuth 授权模式' : '匿名 MCP 模式'
  const state = input.authConfigured
    ? input.credentialConfigured ? '已保存 DataOps MCP 授权凭证。' : '尚未授权 DataOps 账号。'
    : 'DSH 会在不发送 Authorization 的情况下尝试连接远端 MCP。'
  const action = input.authConfigured && !input.credentialConfigured
    ? `<p><a href="${CONNECT_PATH}">连接并选择 DataOps 账号</a></p>`
    : input.authConfigured
      ? `<p><a href="${CONNECT_PATH}">重新选择 DataOps 账号授权</a></p>`
      : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DataOps Integration</title></head><body><main><h1>DataOps Integration</h1><p>${mode}</p><p>${escapeHtml(state)}</p><p>DataOps: ${escapeHtml(input.baseUrl)}</p>${action}</main></body></html>`
}

function resultPage(ok: boolean, message: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DataOps Authorization</title></head><body><main><h1>${ok ? 'DataOps 已连接' : 'DataOps 授权失败'}</h1><p>${escapeHtml(message)}</p><p><a href="${INTEGRATION_PATH}">返回 DataOps Integration</a></p></main></body></html>`
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!value || typeof value !== 'object') throw new Error('DataOps token endpoint returned an invalid response')
  const record = value as Record<string, unknown>
  if (typeof record.access_token !== 'string' || record.access_token.length === 0
    || record.token_type !== 'Bearer'
    || typeof record.expires_in !== 'number' || !Number.isFinite(record.expires_in) || record.expires_in <= 0
    || record.scope !== SCOPE) {
    throw new Error('DataOps token endpoint returned an invalid response')
  }
  return record as unknown as TokenResponse
}

/** Compose the DataOps browser authorization surface and generic MCP client. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  const ref: CredentialRef | undefined = config.credentialRef === undefined
    ? undefined
    : credentialRef(config.credentialRef)
  const credentials = ref === undefined ? undefined : ctx.get('credentials')
  if (ref !== undefined && credentials === undefined) {
    throw new Error(`mcp-dataops: credentialRef "${ref}" requires the credentials service`)
  }

  const pending = new Map<string, PendingAuthorization>()
  let mcpFiber: Fiber | undefined

  const mcpConfig = (): McpClient.StreamableHttpConfig => ({
    transport: 'streamable-http',
    serverName: config.serverName,
    url: `${baseUrl}/api/ai/data-query/mcp`,
    headers: {},
    ...(ref === undefined ? {} : { bearerTokenRef: ref }),
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    failOnStartupError: config.failOnStartupError,
  })

  const ensureMcpMounted = async (): Promise<void> => {
    if (mcpFiber !== undefined && mcpFiber.uid !== null) return
    const fiber = ctx.plugin(McpClient, mcpConfig())
    mcpFiber = fiber
    try {
      await fiber
    } catch (error) {
      if (mcpFiber === fiber) mcpFiber = undefined
      throw error
    }
  }

  const prunePending = (): void => {
    const cutoff = Date.now() - PENDING_TTL_MS
    for (const [state, authorization] of pending) {
      if (authorization.createdAt < cutoff) pending.delete(state)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: INTEGRATION_PATH,
    handler: async (request, response) => {
      if (!requireLoopback(request, response) || !requireGet(request, response)) return
      const credentialConfigured = ref === undefined
        ? null
        : (await credentials!.describe(ref)).configured
      sendHtml(response, 200, statusPage({ baseUrl, authConfigured: ref !== undefined, credentialConfigured }))
    },
  }), 'mcp-dataops: status route')

  if (ref === undefined) {
    await ensureMcpMounted()
    return
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONNECT_PATH,
    handler: (request, response) => {
      if (!requireLoopback(request, response) || !requireGet(request, response)) return
      prunePending()
      const state = randomBytes(32).toString('base64url')
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
      const redirectUri = `http://127.0.0.1:${String(ctx.webServer.port)}${CALLBACK_PATH}`
      pending.set(state, { verifier, redirectUri, createdAt: Date.now() })
      const authorize = new URL('/api/auth/dsh/authorize', baseUrl)
      authorize.searchParams.set('client_id', CLIENT_ID)
      authorize.searchParams.set('redirect_uri', redirectUri)
      authorize.searchParams.set('state', state)
      authorize.searchParams.set('code_challenge', challenge)
      authorize.searchParams.set('code_challenge_method', 'S256')
      authorize.searchParams.set('scope', SCOPE)
      response.writeHead(303, { location: authorize.toString() })
      response.end()
    },
  }), 'mcp-dataops: connect route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CALLBACK_PATH,
    handler: async (request, response) => {
      if (!requireLoopback(request, response) || !requireGet(request, response)) return
      const callback = new URL(request.url ?? CALLBACK_PATH, 'http://127.0.0.1')
      const state = callback.searchParams.get('state') ?? ''
      const authorization = pending.get(state)
      pending.delete(state)
      if (authorization === undefined || Date.now() - authorization.createdAt > PENDING_TTL_MS) {
        sendHtml(response, 400, resultPage(false, '授权请求不存在或已经过期，请重新连接。'))
        return
      }
      const oauthError = callback.searchParams.get('error')
      if (oauthError !== null) {
        sendHtml(response, 400, resultPage(false, 'DataOps 未完成本次授权。'))
        return
      }
      const code = callback.searchParams.get('code') ?? ''
      if (code === '') {
        sendHtml(response, 400, resultPage(false, 'DataOps 回调缺少 authorization code。'))
        return
      }
      try {
        const tokenResponse = await fetch(new URL('/api/auth/dsh/token', baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: CLIENT_ID,
            redirect_uri: authorization.redirectUri,
            code_verifier: authorization.verifier,
          }),
        })
        if (!tokenResponse.ok) throw new Error(`DataOps token exchange failed with HTTP ${String(tokenResponse.status)}`)
        const token = parseTokenResponse(await tokenResponse.json())
        await credentials!.set(ref, token.access_token)
        await ensureMcpMounted()
        sendHtml(response, 200, resultPage(true, '已保存所选 DataOps 账号的 MCP 授权，取数工具会使用该身份。'))
      } catch (error) {
        ctx.logger.warn('mcp-dataops: DataOps authorization callback failed')
        ctx.logger.warn(error)
        sendHtml(response, 502, resultPage(false, '无法完成 DataOps 授权，请返回后重新连接。'))
      }
    },
  }), 'mcp-dataops: callback route')

  if ((await credentials!.describe(ref)).configured) await ensureMcpMounted()
}
