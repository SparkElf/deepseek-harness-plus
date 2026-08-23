/**
 * Optional DataOps MCP integration. Anonymous mode mounts the generic MCP
 * client without Authorization. Supplying access and refresh credential refs
 * additionally owns the browser Authorization Code + PKCE handoff, OIDC
 * identity lookup, token refresh, and principal-aware MCP remount lifecycle.
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
const SCOPE = 'openid dataops.mcp'
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
  /** Access-token credential reference. Omit both credential refs for anonymous MCP mode. */
  credentialRef?: string
  /** Refresh-token credential reference. Required together with `credentialRef`. */
  refreshCredentialRef?: string
  /** Canonical DSH browser origin for externally published Web deployments. */
  callbackOrigin?: string
  /** Per-MCP-tool timeout forwarded to the generic mcp-client. */
  toolCallTimeoutMs: number
  /** Whether an immediately attempted MCP connection failure rejects this plugin. */
  failOnStartupError: boolean
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
  serverName: z.string().default('dataops'),
  credentialRef: z.string().role('credential-ref'),
  refreshCredentialRef: z.string().role('credential-ref'),
  callbackOrigin: z.string(),
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
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  id_token: string
  scope: typeof SCOPE
}>

type AccountResponse = Readonly<{
  sub: string
  username: string
  displayName: string
  email: string
}>

type CredentialState = Readonly<{
  configured: boolean
  writable: boolean
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

function normalizeCallbackOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('mcp-dataops: callbackOrigin must be an absolute browser origin')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (!['http:', 'https:'].includes(url.protocol)
    || (url.protocol === 'http:' && !loopback)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== '') {
    throw new Error('mcp-dataops: callbackOrigin must be an HTTPS origin, except loopback HTTP for local DSH')
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
  response.end('DataOps authorization management accepts only DSH loopback ingress.')
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
    || typeof record.refresh_token !== 'string' || record.refresh_token.length === 0
    || typeof record.id_token !== 'string' || record.id_token.length === 0
    || record.scope !== SCOPE) {
    throw new Error('DataOps token endpoint returned an invalid response')
  }
  return record as unknown as TokenResponse
}

function parseAccountResponse(value: unknown): AccountResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('DataOps userinfo endpoint returned an invalid response')
  }
  const record = value as Record<string, unknown>
  if (typeof record.sub !== 'string' || record.sub.length === 0
    || typeof record.preferred_username !== 'string'
    || typeof record.name !== 'string'
    || typeof record.email !== 'string') {
    throw new Error('DataOps userinfo endpoint returned an invalid response')
  }
  return {
    sub: record.sub,
    username: record.preferred_username,
    displayName: record.name,
    email: record.email,
  }
}

/** Compose the DataOps browser authorization surface and generic MCP client. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  const callbackOrigin = config.callbackOrigin === undefined
    ? undefined
    : normalizeCallbackOrigin(config.callbackOrigin)
  const accessRef: CredentialRef | undefined = config.credentialRef === undefined
    ? undefined
    : credentialRef(config.credentialRef)
  const refreshRef: CredentialRef | undefined = config.refreshCredentialRef === undefined
    ? undefined
    : credentialRef(config.refreshCredentialRef)
  if ((accessRef === undefined) !== (refreshRef === undefined)) {
    throw new Error('mcp-dataops: credentialRef and refreshCredentialRef must be configured together')
  }
  const credentials = accessRef === undefined ? undefined : ctx.get('credentials')
  if (accessRef !== undefined && credentials === undefined) {
    throw new Error(`mcp-dataops: credentialRef "${accessRef}" requires the credentials service`)
  }

  const pending = new Map<string, PendingAuthorization>()
  let mcpFiber: Fiber | undefined
  let activePrincipalSub: string | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let nominalAccessTtlSeconds: number | undefined

  const mcpConfig = (): McpClient.StreamableHttpConfig => ({
    transport: 'streamable-http',
    serverName: config.serverName,
    url: `${baseUrl}/api/ai/data-query/mcp`,
    headers: {},
    ...(accessRef === undefined ? {} : { bearerTokenRef: accessRef }),
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

  const clearRefreshTimer = (): void => {
    if (refreshTimer === undefined) return
    clearTimeout(refreshTimer)
    refreshTimer = undefined
  }

  ctx.effect(() => async () => {
    clearRefreshTimer()
    pending.clear()
    await unmountMcp()
  }, 'mcp-dataops: authorization lifecycle')

  const prunePending = (): void => {
    const cutoff = Date.now() - PENDING_TTL_MS
    for (const [state, authorization] of pending) {
      if (authorization.createdAt < cutoff) pending.delete(state)
    }
  }

  const credentialState = async (): Promise<CredentialState | null> => {
    if (accessRef === undefined || refreshRef === undefined) return null
    const [access, refresh] = await Promise.all([
      credentials!.describe(accessRef),
      credentials!.describe(refreshRef),
    ])
    return {
      configured: access.configured && refresh.configured,
      writable: access.writable && refresh.writable,
    }
  }

  const fetchAccount = async (accessToken: string): Promise<AccountResponse | null> => {
    const response = await fetch(new URL('/api/auth/dsh/userinfo', baseUrl), {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (response.status === 401 || response.status === 403) return null
    if (!response.ok) throw new Error(`DataOps userinfo lookup failed with HTTP ${String(response.status)}`)
    return parseAccountResponse(await response.json())
  }

  const currentAccount = async () => {
    if (accessRef === undefined || refreshRef === undefined) {
      return { credential: null, account: null, authorizationAccepted: null }
    }
    const state = await credentialState()
    if (state === null || !state.configured) {
      return { credential: state, account: null, authorizationAccepted: false }
    }
    const resolved = await credentials!.resolve(accessRef)
    if (resolved === undefined) {
      return { credential: state, account: null, authorizationAccepted: false }
    }
    const account = await fetchAccount(resolved.value)
    return {
      credential: state,
      account,
      authorizationAccepted: account !== null,
    }
  }

  const requestRefresh = async (refreshToken: string): Promise<TokenResponse> => {
    const response = await fetch(new URL('/api/auth/dsh/token', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    })
    if (!response.ok) throw new Error(`DataOps token refresh failed with HTTP ${String(response.status)}`)
    return parseTokenResponse(await response.json())
  }

  const storeAuthorization = async (token: TokenResponse): Promise<void> => {
    await credentials!.set(refreshRef!, token.refresh_token)
    await credentials!.set(accessRef!, token.access_token)
  }

  let refreshAuthorization: () => Promise<void>

  const scheduleRefresh = (token: TokenResponse, resetLifetime: boolean): void => {
    clearRefreshTimer()
    if (resetLifetime || nominalAccessTtlSeconds === undefined) {
      nominalAccessTtlSeconds = token.expires_in
    } else if (token.expires_in < nominalAccessTtlSeconds) {
      return
    } else {
      nominalAccessTtlSeconds = token.expires_in
    }
    const delayMs = token.expires_in * 1000 / 2
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refreshAuthorization().catch(async (error: unknown) => {
        ctx.logger.warn('mcp-dataops: DataOps token refresh failed; MCP connection was unmounted')
        ctx.logger.warn(error)
        await unmountMcp()
      })
    }, delayMs)
  }

  const acceptAuthorization = async (
    token: TokenResponse,
    account: AccountResponse,
    resetRefreshLifetime = false,
  ): Promise<void> => {
    if (activePrincipalSub !== undefined && activePrincipalSub !== account.sub) {
      await unmountMcp()
    }
    await storeAuthorization(token)
    activePrincipalSub = account.sub
    scheduleRefresh(token, resetRefreshLifetime)
    await ensureMcpMounted()
  }

  refreshAuthorization = async (): Promise<void> => {
    const resolved = await credentials!.resolve(refreshRef!)
    if (resolved === undefined) throw new Error('DataOps refresh credential is not configured')
    const token = await requestRefresh(resolved.value)
    const account = await fetchAccount(token.access_token)
    if (account === null) throw new Error('DataOps refreshed access token was rejected by userinfo')
    await acceptAuthorization(token, account)
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
          mode: accessRef === undefined ? 'anonymous' : 'oidc',
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

  if (accessRef === undefined || refreshRef === undefined) {
    await ensureMcpMounted()
    return
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONNECT_PATH,
    handler: async (request, response) => {
      if (!requireLoopback(request, response) || !requireMethod(request, response, 'GET')) return
      const state = await credentialState()
      if (state === null || !state.writable) {
        sendJson(response, 409, { error: 'DataOps access and refresh credentials must both use writable credential sources.' })
        return
      }
      prunePending()
      const browserOrigin = callbackOrigin ?? callbackOriginOf(request, response)
      if (browserOrigin === undefined) return
      const stateValue = randomBytes(32).toString('base64url')
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
      const redirectUri = `${browserOrigin}${CALLBACK_PATH}`
      pending.set(stateValue, { verifier, redirectUri, createdAt: Date.now() })
      const authorize = new URL('/api/auth/dsh/authorize', baseUrl)
      authorize.searchParams.set('client_id', CLIENT_ID)
      authorize.searchParams.set('redirect_uri', redirectUri)
      authorize.searchParams.set('response_type', 'code')
      authorize.searchParams.set('state', stateValue)
      authorize.searchParams.set('code_challenge', challenge)
      authorize.searchParams.set('code_challenge_method', 'S256')
      authorize.searchParams.set('scope', SCOPE)
      authorize.searchParams.set('prompt', 'select_account')
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
      const stateValue = callback.searchParams.get('state') ?? ''
      const authorization = pending.get(stateValue)
      pending.delete(stateValue)
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
        const account = await fetchAccount(token.access_token)
        if (account === null) throw new Error('DataOps access token was rejected by userinfo')
        await acceptAuthorization(token, account, true)
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
      const state = await credentialState()
      if (state === null || !state.writable) {
        sendJson(response, 409, { error: 'DataOps access and refresh credentials must both use writable credential sources.' })
        return
      }
      clearRefreshTimer()
      await unmountMcp()
      await credentials!.unset(accessRef)
      await credentials!.unset(refreshRef)
      activePrincipalSub = undefined
      nominalAccessTtlSeconds = undefined
      sendJson(response, 200, { disconnected: true })
    },
  }), 'mcp-dataops: disconnect route')

  if ((await credentialState())?.configured) {
    try {
      await refreshAuthorization()
    } catch (error) {
      ctx.logger.warn('mcp-dataops: stored DataOps authorization could not be refreshed; reconnect DataOps')
      ctx.logger.warn(error)
    }
  }
}
