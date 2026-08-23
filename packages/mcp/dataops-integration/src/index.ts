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
const STATUS_PATH = `${INTEGRATION_PATH}/status`
const CONNECT_PATH = `${INTEGRATION_PATH}/connect`
const CALLBACK_PATH = `${INTEGRATION_PATH}/callback`
const DISCONNECT_PATH = `${INTEGRATION_PATH}/disconnect`
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

type AccountResponse = Readonly<{
  account: Readonly<{
    username: string
    displayName: string
    email: string
  }>
}>

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

function requireMethod(
  request: IncomingMessage,
  response: ServerResponse,
  method: 'GET' | 'POST',
): boolean {
  if (request.method === method) return true
  response.writeHead(405, { allow: method })
  response.end()
  return false
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

function popupBridge(response: ServerResponse, result: 'connected' | 'cancelled' | 'failed'): void {
  const payload = JSON.stringify({ type: 'dsh:dataops-oauth', result })
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>DataOps</title></head><body><script>if(window.opener){window.opener.postMessage(${payload},window.location.origin);window.close()}else{window.location.replace('/')}</script></body></html>`)
}

function callbackOriginOf(request: IncomingMessage, response: ServerResponse): string | undefined {
  const requestUrl = new URL(request.url ?? CONNECT_PATH, 'http://dsh.local')
  const rawOrigin = requestUrl.searchParams.get('origin') ?? ''
  let candidate: URL
  try {
    candidate = new URL(rawOrigin)
  } catch {
    sendJson(response, 400, { error: 'The DSH browser origin is invalid.' })
    return undefined
  }
  const requestHost = request.headers.host?.trim().toLowerCase() ?? ''
  if (!['http:', 'https:'].includes(candidate.protocol)
    || candidate.username !== ''
    || candidate.password !== ''
    || candidate.pathname !== '/'
    || candidate.search !== ''
    || candidate.hash !== ''
    || candidate.host.toLowerCase() !== requestHost) {
    sendJson(response, 400, { error: 'The DSH browser origin does not match this DSH host.' })
    return undefined
  }
  return candidate.origin
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

function parseAccountResponse(value: unknown): AccountResponse {
  if (!value || typeof value !== 'object' || !('account' in value)) {
    throw new Error('DataOps account endpoint returned an invalid response')
  }
  const account = (value as { account?: unknown }).account
  if (!account || typeof account !== 'object') {
    throw new Error('DataOps account endpoint returned an invalid response')
  }
  const record = account as Record<string, unknown>
  if (typeof record.username !== 'string'
    || typeof record.displayName !== 'string'
    || typeof record.email !== 'string') {
    throw new Error('DataOps account endpoint returned an invalid response')
  }
  return { account: {
    username: record.username,
    displayName: record.displayName,
    email: record.email,
  } }
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
      await fiber.await()
    } catch (error) {
      if (mcpFiber === fiber) mcpFiber = undefined
      await fiber.dispose()
      throw error
    }
  }

  const unmountMcp = async (): Promise<void> => {
    const fiber = mcpFiber
    mcpFiber = undefined
    if (fiber !== undefined && fiber.uid !== null) await fiber.dispose()
  }

  const prunePending = (): void => {
    const cutoff = Date.now() - PENDING_TTL_MS
    for (const [state, authorization] of pending) {
      if (authorization.createdAt < cutoff) pending.delete(state)
    }
  }

  const currentAccount = async () => {
    if (ref === undefined) return { credential: null, account: null, authorizationAccepted: null }
    const info = await credentials!.describe(ref)
    if (!info.configured) {
      return { credential: info, account: null, authorizationAccepted: false }
    }
    const resolved = await credentials!.resolve(ref)
    if (resolved === undefined) {
      return { credential: info, account: null, authorizationAccepted: false }
    }
    const response = await fetch(new URL('/api/auth/dsh/account', baseUrl), {
      headers: { authorization: `Bearer ${resolved.value}` },
    })
    if (response.status === 401 || response.status === 403) {
      return { credential: info, account: null, authorizationAccepted: false }
    }
    if (!response.ok) throw new Error(`DataOps account lookup failed with HTTP ${String(response.status)}`)
    return {
      credential: info,
      account: parseAccountResponse(await response.json()).account,
      authorizationAccepted: true,
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (request, response) => {
      if (!requireLoopback(request, response) || !requireMethod(request, response, 'GET')) return
      try {
        const accountState = await currentAccount()
        sendJson(response, 200, {
          baseUrl,
          serverName: config.serverName,
          mode: ref === undefined ? 'anonymous' : 'oauth',
          credentialConfigured: accountState.credential?.configured ?? null,
          credentialWritable: accountState.credential?.writable ?? null,
          authorizationAccepted: accountState.authorizationAccepted,
          account: accountState.account,
        })
      } catch (error) {
        ctx.logger.warn('mcp-dataops: integration status lookup failed')
        ctx.logger.warn(error)
        sendJson(response, 502, { error: 'Unable to read DataOps connection status.' })
      }
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
      if (!requireLoopback(request, response) || !requireMethod(request, response, 'GET')) return
      prunePending()
      const callbackOrigin = callbackOriginOf(request, response)
      if (callbackOrigin === undefined) return
      const state = randomBytes(32).toString('base64url')
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
      const redirectUri = `${callbackOrigin}${CALLBACK_PATH}`
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
      if (!requireLoopback(request, response) || !requireMethod(request, response, 'GET')) return
      const callback = new URL(request.url ?? CALLBACK_PATH, 'http://127.0.0.1')
      const state = callback.searchParams.get('state') ?? ''
      const authorization = pending.get(state)
      pending.delete(state)
      if (authorization === undefined || Date.now() - authorization.createdAt > PENDING_TTL_MS) {
        popupBridge(response, 'failed')
        return
      }
      if (callback.searchParams.get('error') !== null) {
        popupBridge(response, 'cancelled')
        return
      }
      const code = callback.searchParams.get('code') ?? ''
      if (code === '') {
        popupBridge(response, 'failed')
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
        popupBridge(response, 'connected')
      } catch (error) {
        ctx.logger.warn('mcp-dataops: DataOps authorization callback failed')
        ctx.logger.warn(error)
        popupBridge(response, 'failed')
      }
    },
  }), 'mcp-dataops: callback route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DISCONNECT_PATH,
    handler: async (request, response) => {
      if (!requireLoopback(request, response) || !requireMethod(request, response, 'POST')) return
      const info = await credentials!.describe(ref)
      if (!info.writable) {
        sendJson(response, 409, { error: 'This DataOps credential is managed by a read-only credential source.' })
        return
      }
      await credentials!.unset(ref)
      await unmountMcp()
      sendJson(response, 200, { disconnected: true })
    },
  }), 'mcp-dataops: disconnect route')

  if ((await credentials!.describe(ref)).configured) await ensureMcpMounted()
}
