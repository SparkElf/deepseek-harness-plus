/**
 * Standalone DataOps MCP integration. It owns one persistent DSH target
 * identity, the browser Authorization Code + PKCE handoff, token refresh,
 * and a generic authenticated MCP client for the target's immutable principal.
 * @module @deepseek-ai/dsh-mcp-dataops
 */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

/** Cordis plugin name for the standalone DataOps integration. */
export const name = 'mcp-dataops'
/** Services required by the standalone authorization and MCP composition. */
export const inject = ['credentials', 'webServer', 'tools']

const CLIENT_ID = 'deepseek-harness-plus'
const SCOPE = 'openid dataops.mcp'
const INTEGRATION_PATH = '/integrations/dataops'
const STATUS_PATH = `${INTEGRATION_PATH}/status`
const CONNECT_PATH = `${INTEGRATION_PATH}/connect`
const CALLBACK_PATH = `${INTEGRATION_PATH}/callback`
const DISCONNECT_PATH = `${INTEGRATION_PATH}/disconnect`
const PENDING_TTL_MS = 10 * 60 * 1000
const TARGET_REF_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u

type DataOpsTargetRef = Branded<'DataOpsTargetRef'>

/** Configuration for one standalone DataOps target and delegated MCP connection. */
export interface Config {
  /** DataOps origin, for example `https://dataops.example.com`. */
  baseUrl: string
  /** Local MCP tool namespace. */
  serverName: string
  /** Access-token credential reference for the standalone DataOps grant. */
  credentialRef: string
  /** Refresh-token credential reference for the same grant. */
  refreshCredentialRef: string
  /** Persistent DSH target identity credential; generated once and never cleared by disconnect. */
  targetCredentialRef: string
  /** Explicit HTTP or HTTPS DSH browser origin for non-loopback Web deployments. */
  callbackOrigin?: string
  /** Per-MCP-tool timeout forwarded to the generic mcp-client. */
  toolCallTimeoutMs: number
  /** Whether an immediately attempted MCP connection failure rejects this plugin. */
  failOnStartupError: boolean
}

/** Schemastery parser for standalone DataOps integration configuration. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
  serverName: z.string().default('dataops'),
  credentialRef: z.string().role('credential-ref').required(),
  refreshCredentialRef: z.string().role('credential-ref').required(),
  targetCredentialRef: z.string().role('credential-ref').required(),
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
  scope: typeof SCOPE
}>

type AccountResponse = Readonly<{
  username: string
  displayName: string
  email: string
}>

type CredentialState = Readonly<{
  configured: boolean
  writable: boolean
}>

function normalizeBaseUrl(value: string): string {
  if (!URL.canParse(value)) throw new Error('mcp-dataops: baseUrl must be an absolute http(s) origin')
  const url = new URL(value)
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
  if (!URL.canParse(value)) throw new Error('mcp-dataops: callbackOrigin must be an absolute browser origin')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== '') {
    throw new Error('mcp-dataops: callbackOrigin must be an HTTP or HTTPS origin without path, query, credentials, or fragment')
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

function requireSameOriginBrowser(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.headers['sec-fetch-site'] === 'same-origin') return true
  response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('DataOps authorization management accepts only same-origin DSH browser requests.')
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
    'referrer-policy': 'no-referrer',
  })
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>DataOps</title></head><body><script>if(window.opener){window.opener.postMessage(${payload},window.location.origin);window.close()}else{window.location.replace('/')}</script></body></html>`)
}

function callbackOriginOf(request: IncomingMessage, response: ServerResponse): string | undefined {
  const requestUrl = new URL(request.url ?? CONNECT_PATH, 'http://dsh.local')
  const rawOrigin = requestUrl.searchParams.get('origin') ?? ''
  if (!URL.canParse(rawOrigin)) {
    sendJson(response, 400, { error: 'The DSH browser origin is invalid.' })
    return undefined
  }
  const candidate = new URL(rawOrigin)
  const loopback = candidate.hostname === '127.0.0.1'
    || candidate.hostname === 'localhost'
    || candidate.hostname === '[::1]'
  const requestHost = request.headers.host?.trim().toLowerCase() ?? ''
  if (!['http:', 'https:'].includes(candidate.protocol)
    || candidate.username !== ''
    || candidate.password !== ''
    || candidate.pathname !== '/'
    || candidate.search !== ''
    || candidate.hash !== ''
    || !loopback
    || candidate.host.toLowerCase() !== requestHost) {
    sendJson(response, 400, { error: 'The DSH browser origin does not match this DSH host.' })
    return undefined
  }
  return candidate.origin
}

function parseTargetRef(value: string): DataOpsTargetRef {
  if (!TARGET_REF_PATTERN.test(value)) {
    throw new Error('mcp-dataops: target credential must contain a 32-128 character base64url identifier')
  }
  return value as DataOpsTargetRef
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!value || typeof value !== 'object') throw new Error('DataOps token endpoint returned an invalid response')
  const record = value as Record<string, unknown>
  if (typeof record.access_token !== 'string' || record.access_token.length === 0
    || record.token_type !== 'Bearer'
    || typeof record.expires_in !== 'number' || !Number.isInteger(record.expires_in) || record.expires_in <= 0
    || record.expires_in * 1000 > MAX_TIMER_DELAY_MS
    || typeof record.refresh_token !== 'string' || record.refresh_token.length === 0
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
  if (typeof record.preferred_username !== 'string'
    || typeof record.name !== 'string'
    || typeof record.email !== 'string') {
    throw new Error('DataOps userinfo endpoint returned an invalid response')
  }
  return {
    username: record.preferred_username,
    displayName: record.name,
    email: record.email,
  }
}

/**
 * Compose the DataOps browser authorization routes and generic MCP child.
 * @param ctx - Cordis context with credentials, Web routes, and tool registry.
 * @param config - Standalone DataOps origin, credential references, and MCP settings.
 * @returns Startup readiness after the persistent target and stored grant are accepted.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  const callbackOrigin = config.callbackOrigin === undefined
    ? undefined
    : normalizeCallbackOrigin(config.callbackOrigin)
  const accessRef: CredentialRef = credentialRef(config.credentialRef)
  const refreshRef: CredentialRef = credentialRef(config.refreshCredentialRef)
  const targetRefKey: CredentialRef = credentialRef(config.targetCredentialRef)
  // The target credential belongs to this DSH_HOME; disconnecting OAuth tokens must not delete or replace it.
  const targetState = await ctx.credentials.describe(targetRefKey)
  if (!targetState.configured) {
    if (!targetState.writable) {
      throw new Error('mcp-dataops: targetCredentialRef must be configured or use a writable credential source')
    }
    await ctx.credentials.set(targetRefKey, randomBytes(32).toString('base64url'))
  }
  const resolvedTarget = await ctx.credentials.resolve(targetRefKey)
  if (resolvedTarget === undefined) {
    throw new Error('mcp-dataops: target credential could not be resolved after initialization')
  }
  const targetRef = parseTargetRef(resolvedTarget.value)

  const pending = new Map<string, PendingAuthorization>()
  const lifecycleAbort = new AbortController()
  const activeOperations = new Set<Promise<unknown>>()
  let mcpFiber: Fiber | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let refreshOperation: Promise<void> | undefined
  let grantGeneration = 0
  let nominalAccessTtlSeconds: number | undefined

  const assertActive = (): void => {
    if (lifecycleAbort.signal.aborted) throw new Error('mcp-dataops: plugin lifecycle is disposed')
  }

  const assertGrantCurrent = (expectedGeneration: number): void => {
    if (grantGeneration !== expectedGeneration) throw new Error('mcp-dataops: delegated grant operation was superseded')
  }

  const trackOperation = <T>(operation: Promise<T>): Promise<T> => {
    activeOperations.add(operation)
    void operation.then(
      () => { activeOperations.delete(operation) },
      () => { activeOperations.delete(operation) },
    )
    return operation
  }

  const trackHandler = (
    handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  ) => (request: IncomingMessage, response: ServerResponse): Promise<void> => trackOperation(handler(request, response))

  const mcpConfig = (): McpClient.StreamableHttpConfig => ({
    transport: 'streamable-http',
    serverName: config.serverName,
    url: `${baseUrl}/api/ai/data-query/mcp`,
    headers: {},
    bearerTokenRef: accessRef,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    failOnStartupError: config.failOnStartupError,
  })

  // Mount MCP tools only after authorization credentials are available; credential loss disposes the entire child fiber.
  const isMcpMounted = (): boolean => mcpFiber !== undefined && mcpFiber.uid !== null

  const ensureMcpMounted = async (): Promise<void> => {
    assertActive()
    if (isMcpMounted()) return
    const fiber = ctx.plugin(McpClient, mcpConfig())
    mcpFiber = fiber
    try {
      await fiber.await()
      assertActive()
    } catch (error) {
      ctx.logger.error('mcp-dataops: MCP client mount failed')
      ctx.logger.error(error)
      if (mcpFiber === fiber) mcpFiber = undefined
      try {
        await fiber.dispose()
      } catch (cleanupError) {
        ctx.logger.error('mcp-dataops: MCP mount failure cleanup failed')
        ctx.logger.error(cleanupError)
        throw new AggregateError([error, cleanupError], 'DataOps MCP mount and cleanup failed')
      }
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
    lifecycleAbort.abort()
    await Promise.allSettled([...activeOperations])
    await unmountMcp()
  }, 'mcp-dataops: authorization lifecycle')

  const credentialState = async (): Promise<CredentialState> => {
    const access = await ctx.credentials.describe(accessRef)
    const refresh = await ctx.credentials.describe(refreshRef)
    return {
      configured: access.configured && refresh.configured,
      writable: access.writable && refresh.writable,
    }
  }

  const fetchAccount = async (accessToken: string): Promise<AccountResponse | null> => {
    const response = await fetch(new URL('/api/auth/dsh/userinfo', baseUrl), {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: lifecycleAbort.signal,
    })
    if (response.status === 401 || response.status === 403) return null
    if (!response.ok) throw new Error(`DataOps userinfo lookup failed with HTTP ${String(response.status)}`)
    return parseAccountResponse(await response.json())
  }

  const currentAccount = async () => {
    const state = await credentialState()
    if (!state.configured) {
      return { credential: state, account: null, authorizationAccepted: false }
    }
    const resolved = await ctx.credentials.resolve(accessRef)
    if (resolved === undefined) {
      throw new Error('DataOps access credential is described as configured but cannot be resolved')
    }
    const account = await fetchAccount(resolved.value)
    return {
      credential: state,
      account,
      authorizationAccepted: account !== null && isMcpMounted(),
    }
  }

  const requestRevocation = async (token: string): Promise<void> => {
    const response = await fetch(new URL('/api/auth/dsh/revoke', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: lifecycleAbort.signal,
    })
    if (!response.ok) throw new Error(`DataOps token revocation failed with HTTP ${String(response.status)}`)
  }

  const revokeTokenResponse = async (token: TokenResponse): Promise<void> => {
    await requestRevocation(token.refresh_token)
    await requestRevocation(token.access_token)
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
      signal: lifecycleAbort.signal,
    })
    if (!response.ok) throw new Error(`DataOps token refresh failed with HTTP ${String(response.status)}`)
    return parseTokenResponse(await response.json())
  }

  const restoreCredential = async (ref: CredentialRef, previous: ResolvedCredential | undefined): Promise<void> => {
    if (previous === undefined) {
      await ctx.credentials.unset(ref)
    } else {
      await ctx.credentials.set(ref, previous.value)
    }
  }

  const restoreAuthorization = async (
    previousAccess: ResolvedCredential | undefined,
    previousRefresh: ResolvedCredential | undefined,
  ): Promise<void> => {
    await restoreCredential(refreshRef, previousRefresh)
    await restoreCredential(accessRef, previousAccess)
  }

  // Write the access token last; commit authorization only after the complete grant and MCP child both succeed.
  const storeAuthorization = async (
    token: TokenResponse,
    expectedGeneration: number,
  ): Promise<() => Promise<void>> => {
    assertActive()
    assertGrantCurrent(expectedGeneration)
    const [previousAccess, previousRefresh] = await Promise.all([
      ctx.credentials.resolve(accessRef),
      ctx.credentials.resolve(refreshRef),
    ])
    assertActive()
    assertGrantCurrent(expectedGeneration)
    try {
      await ctx.credentials.set(refreshRef, token.refresh_token)
      assertActive()
      assertGrantCurrent(expectedGeneration)
      await ctx.credentials.set(accessRef, token.access_token)
      assertActive()
      assertGrantCurrent(expectedGeneration)
    } catch (error) {
      ctx.logger.error('mcp-dataops: DataOps credential replacement failed')
      ctx.logger.error(error)
      try {
        await restoreAuthorization(previousAccess, previousRefresh)
      } catch (rollbackError) {
        ctx.logger.error('mcp-dataops: DataOps credential rollback failed')
        ctx.logger.error(rollbackError)
        throw new AggregateError([error, rollbackError], 'DataOps credential replacement and rollback failed')
      }
      throw error
    }
    return () => restoreAuthorization(previousAccess, previousRefresh)
  }

  const scheduleRefresh = (token: TokenResponse, resetLifetime: boolean): void => {
    clearRefreshTimer()
    if (resetLifetime || nominalAccessTtlSeconds === undefined) {
      nominalAccessTtlSeconds = token.expires_in
    } else if (token.expires_in < nominalAccessTtlSeconds) {
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        nominalAccessTtlSeconds = undefined
        void trackOperation(unmountMcp().catch((error: unknown) => {
          ctx.logger.warn('mcp-dataops: DataOps final access-token expiry unmount failed')
          ctx.logger.warn(error)
        }))
      }, token.expires_in * 1000)
      return
    } else {
      nominalAccessTtlSeconds = token.expires_in
    }
    const delayMs = token.expires_in * 1000 / 2
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      const operation = refreshAuthorization().catch(async (error: unknown) => {
        ctx.logger.warn('mcp-dataops: DataOps token refresh failed; MCP connection was unmounted')
        ctx.logger.warn(error)
        try {
          await unmountMcp()
        } catch (cleanupError) {
          ctx.logger.warn('mcp-dataops: failed refresh MCP cleanup failed')
          ctx.logger.warn(cleanupError)
        }
      })
      refreshOperation = operation
      void trackOperation(operation.then(() => {
        if (refreshOperation === operation) refreshOperation = undefined
      }))
    }, delayMs)
  }

  const acceptAuthorization = async (
    token: TokenResponse,
    resetRefreshLifetime: boolean,
    expectedGeneration: number,
  ): Promise<void> => {
    const restore = await storeAuthorization(token, expectedGeneration)
    try {
      await ensureMcpMounted()
      scheduleRefresh(token, resetRefreshLifetime)
    } catch (error) {
      ctx.logger.error('mcp-dataops: DataOps authorization commit failed')
      ctx.logger.error(error)
      clearRefreshTimer()
      try {
        await restore()
      } catch (rollbackError) {
        ctx.logger.error('mcp-dataops: DataOps authorization rollback failed')
        ctx.logger.error(rollbackError)
        throw new AggregateError([error, rollbackError], 'DataOps authorization commit and rollback failed')
      }
      throw error
    }
  }

  async function refreshAuthorization(): Promise<void> {
    const expectedGeneration = grantGeneration
    const resolved = await ctx.credentials.resolve(refreshRef)
    if (resolved === undefined) throw new Error('DataOps refresh credential is not configured')
    const token = await requestRefresh(resolved.value)
    try {
      const account = await fetchAccount(token.access_token)
      if (account === null) throw new Error('DataOps refreshed access token was rejected by userinfo')
      await acceptAuthorization(token, false, expectedGeneration)
    } catch (error) {
      ctx.logger.warn('mcp-dataops: refreshed DataOps grant could not be accepted')
      ctx.logger.warn(error)
      try {
        await revokeTokenResponse(token)
      } catch (revocationError) {
        ctx.logger.warn('mcp-dataops: rejected refreshed DataOps grant revocation failed')
        ctx.logger.warn(revocationError)
        throw new AggregateError([error, revocationError], 'Refreshed DataOps grant acceptance and revocation failed')
      }
      throw error
    }
  }

  const startupCredential = await credentialState()
  if (startupCredential.configured) {
    try {
      if (startupCredential.writable) {
        await refreshAuthorization()
      } else {
        const access = await ctx.credentials.resolve(accessRef)
        if (access === undefined || await fetchAccount(access.value) === null) {
          throw new Error('Administrator-managed DataOps access credential was rejected by userinfo')
        }
        await ensureMcpMounted()
      }
    } catch (error) {
      ctx.logger.warn('mcp-dataops: stored DataOps authorization could not be accepted')
      ctx.logger.warn(error)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: trackHandler(async (request, response) => {
      if (!requireLoopback(request, response)
        || !requireSameOriginBrowser(request, response)
        || !requireMethod(request, response, 'GET')) return
      try {
        const accountState = await currentAccount()
        sendJson(response, 200, {
          baseUrl,
          serverName: config.serverName,
          credentialConfigured: accountState.credential.configured,
          credentialWritable: accountState.credential.writable,
          authorizationAccepted: accountState.authorizationAccepted,
          account: accountState.account,
        })
      } catch (error) {
        ctx.logger.warn('mcp-dataops: integration status lookup failed')
        ctx.logger.warn(error)
        sendJson(response, 502, { error: 'Unable to read DataOps connection status.' })
      }
    }),
  }), 'mcp-dataops: status route')


  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONNECT_PATH,
    handler: trackHandler(async (request, response) => {
      if (!requireLoopback(request, response)
        || !requireSameOriginBrowser(request, response)
        || !requireMethod(request, response, 'GET')) return
      clearRefreshTimer()
      if (refreshOperation !== undefined) await refreshOperation
      clearRefreshTimer()
      const state = await credentialState()
      assertActive()
      if (!state.writable) {
        sendJson(response, 409, { error: 'DataOps access and refresh credentials must both use writable credential sources.' })
        return
      }
      pending.clear()
      const browserOrigin = callbackOrigin ?? callbackOriginOf(request, response)
      if (browserOrigin === undefined) return
      const stateValue = randomBytes(32).toString('base64url')
      const verifier = randomBytes(32).toString('base64url')
      const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
      const redirectUri = `${browserOrigin}${CALLBACK_PATH}`
      pending.set(stateValue, { verifier, redirectUri, createdAt: Date.now() })
      const authorize = new URL('/api/auth/dsh/authorize', baseUrl)
      authorize.searchParams.set('client_id', CLIENT_ID)
      authorize.searchParams.set('target_ref', targetRef)
      authorize.searchParams.set('redirect_uri', redirectUri)
      authorize.searchParams.set('response_type', 'code')
      authorize.searchParams.set('state', stateValue)
      authorize.searchParams.set('code_challenge', challenge)
      authorize.searchParams.set('code_challenge_method', 'S256')
      authorize.searchParams.set('scope', SCOPE)
      authorize.searchParams.set('prompt', 'select_account')
      response.writeHead(303, {
        location: authorize.toString(),
        'referrer-policy': 'no-referrer',
      })
      response.end()
    }),
  }), 'mcp-dataops: connect route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CALLBACK_PATH,
    handler: trackHandler(async (request, response) => {
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
      const expectedGeneration = grantGeneration
      let token: TokenResponse | undefined
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
          signal: lifecycleAbort.signal,
        })
        if (!tokenResponse.ok) throw new Error(`DataOps token exchange failed with HTTP ${String(tokenResponse.status)}`)
        token = parseTokenResponse(await tokenResponse.json())
        const account = await fetchAccount(token.access_token)
        if (account === null) throw new Error('DataOps access token was rejected by userinfo')
        await acceptAuthorization(token, true, expectedGeneration)
      } catch (error) {
        ctx.logger.warn('mcp-dataops: DataOps authorization callback failed')
        ctx.logger.warn(error)
        if (token !== undefined) {
          try {
            await revokeTokenResponse(token)
          } catch (revocationError) {
            ctx.logger.warn('mcp-dataops: rejected DataOps authorization grant revocation failed')
            ctx.logger.warn(revocationError)
          }
        }
        popupBridge(response, 'failed')
        return
      }
      popupBridge(response, 'connected')
    }),
  }), 'mcp-dataops: callback route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DISCONNECT_PATH,
    handler: trackHandler(async (request, response) => {
      if (!requireLoopback(request, response)
        || !requireSameOriginBrowser(request, response)
        || !requireMethod(request, response, 'POST')) return
      clearRefreshTimer()
      if (refreshOperation !== undefined) await refreshOperation
      clearRefreshTimer()
      const state = await credentialState()
      assertActive()
      if (!state.writable) {
        sendJson(response, 409, { error: 'DataOps access and refresh credentials must both use writable credential sources.' })
        return
      }
      grantGeneration += 1
      pending.clear()
      try {
        const [access, refresh] = await Promise.all([
          ctx.credentials.resolve(accessRef),
          ctx.credentials.resolve(refreshRef),
        ])
        assertActive()
        clearRefreshTimer()
        await unmountMcp()
        if (refresh !== undefined) await requestRevocation(refresh.value)
        if (access !== undefined) await requestRevocation(access.value)
        await ctx.credentials.unset(accessRef)
        await ctx.credentials.unset(refreshRef)
        nominalAccessTtlSeconds = undefined
        sendJson(response, 200, { disconnected: true })
      } catch (error) {
        ctx.logger.warn('mcp-dataops: DataOps disconnect failed')
        ctx.logger.warn(error)
        sendJson(response, 502, { error: 'Unable to disconnect DataOps.' })
      }
    }),
  }), 'mcp-dataops: disconnect route')

}
