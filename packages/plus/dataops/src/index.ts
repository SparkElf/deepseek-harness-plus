/**
 * Standalone DataOps MCP integration. It owns one persistent DSH target
 * identity, the browser Authorization Code + PKCE handoff, and a generic
 * authenticated MCP client for the target's immutable principal.
 * @module @sparkelf/dsh-plugin-dataops
 */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  Config as McpClientConfig,
  apply as applyMcpClient,
  inject as mcpClientInject,
  name as mcpClientName,
  type StreamableHttpConfig,
} from '@sparkelf/dsh-plugin-mcp-credentials'

const McpClient = {
  name: mcpClientName,
  inject: mcpClientInject,
  Config: McpClientConfig,
  apply: applyMcpClient,
}

/** Cordis plugin name for the standalone DataOps integration. */
export const name = 'mcp-dataops'
/** Services required by the standalone authorization and MCP composition. */
export const inject = ['connection', 'credentials', 'webServer', 'tools']

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

function normalizeHttpOrigin(value: string, invalidMessage: string, componentMessage: string): string {
  if (!URL.canParse(value)) throw new Error(invalidMessage)
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== '') {
    throw new Error(componentMessage)
  }
  return url.origin
}

function normalizeBaseUrl(value: string): string {
  return normalizeHttpOrigin(
    value,
    'mcp-dataops: baseUrl must be an absolute http(s) origin',
    'mcp-dataops: baseUrl must be an http(s) origin without path, query, credentials, or fragment',
  )
}

function normalizeCallbackOrigin(value: string): string {
  return normalizeHttpOrigin(
    value,
    'mcp-dataops: callbackOrigin must be an absolute browser origin',
    'mcp-dataops: callbackOrigin must be an HTTP or HTTPS origin without path, query, credentials, or fragment',
  )
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function requireConnection(ctx: Context, request: IncomingMessage, response: ServerResponse): boolean {
  const rejection = ctx.connection.requestRejection(request)
  if (rejection === undefined) return true
  response.writeHead(rejection)
  response.end()
  return false
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

type OAuthFailureReason = 'pending-state' | 'missing-code' | 'token-request-rejected' | 'token-account-rejected' | 'token-service-failed' | 'token-response-invalid' | 'account-verification' | 'authorization-activation'

function popupBridge(
  response: ServerResponse,
  result: 'connected' | 'cancelled' | 'failed',
  reason?: OAuthFailureReason,
): void {
  const payload = JSON.stringify({ type: 'dsh:dataops-oauth', result, reason })
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
    || record.scope !== SCOPE) {
    throw new Error('DataOps token endpoint returned an invalid response')
  }
  return record as unknown as TokenResponse
}

function accessTokenExpiry(accessToken: string): number {
  const payload = accessToken.split('.')[1]
  if (payload === undefined) throw new Error('DataOps access token does not contain a JWT payload')
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch (error) {
    throw new Error('DataOps access token contains an invalid JWT payload', { cause: error })
  }
  if (!value || typeof value !== 'object') throw new Error('DataOps access token JWT payload must be an object')
  const expiresAt = (value as Record<string, unknown>).exp
  if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt)) {
    throw new Error('DataOps access token JWT payload must contain an integer exp')
  }
  const delay = expiresAt * 1000 - Date.now()
  if (delay <= 0 || delay > MAX_TIMER_DELAY_MS) throw new Error('DataOps access token exp is outside the supported timer range')
  return expiresAt * 1000
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
  let grantGeneration = 0
  let accessExpiresAt: number | null = null

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

  const mcpConfig = (): StreamableHttpConfig => ({
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

  ctx.effect(() => async () => {
    pending.clear()
    lifecycleAbort.abort()
    await Promise.allSettled([...activeOperations])
    await unmountMcp()
  }, 'mcp-dataops: authorization lifecycle')

  const credentialState = async (): Promise<CredentialState> => {
    const access = await ctx.credentials.describe(accessRef)
    return {
      configured: access.configured,
      writable: access.writable,
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

  const revokeTokenResponse = (token: TokenResponse): Promise<void> => requestRevocation(token.access_token)

  const restoreCredential = async (ref: CredentialRef, previous: ResolvedCredential | undefined): Promise<void> => {
    if (previous === undefined) {
      await ctx.credentials.unset(ref)
    } else {
      await ctx.credentials.set(ref, previous.value)
    }
  }

  // Preserve the previous access credential so an MCP mount failure can restore it.
  const storeAuthorization = async (
    token: TokenResponse,
    expectedGeneration: number,
  ): Promise<() => Promise<void>> => {
    assertActive()
    assertGrantCurrent(expectedGeneration)
    const previousAccess = await ctx.credentials.resolve(accessRef)
    const previousExpiresAt = accessExpiresAt
    assertActive()
    assertGrantCurrent(expectedGeneration)
    try {
      await ctx.credentials.set(accessRef, token.access_token)
      accessExpiresAt = accessTokenExpiry(token.access_token)
      assertActive()
      assertGrantCurrent(expectedGeneration)
    } catch (error) {
      ctx.logger.error('mcp-dataops: DataOps credential replacement failed')
      ctx.logger.error(error)
      try {
        await restoreCredential(accessRef, previousAccess)
        accessExpiresAt = previousExpiresAt
      } catch (rollbackError) {
        ctx.logger.error('mcp-dataops: DataOps credential rollback failed')
        ctx.logger.error(rollbackError)
        throw new AggregateError([error, rollbackError], 'DataOps credential replacement and rollback failed')
      }
      throw error
    }
    return async () => {
      await restoreCredential(accessRef, previousAccess)
      accessExpiresAt = previousExpiresAt
    }
  }

  const acceptAuthorization = async (
    token: TokenResponse,
    expectedGeneration: number,
  ): Promise<void> => {
    const restore = await storeAuthorization(token, expectedGeneration)
    try {
      await ensureMcpMounted()
    } catch (error) {
      ctx.logger.error('mcp-dataops: DataOps authorization commit failed')
      ctx.logger.error(error)
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

  const startupCredential = await credentialState()
  if (startupCredential.configured) {
    try {
      const access = await ctx.credentials.resolve(accessRef)
      if (access === undefined || await fetchAccount(access.value) === null) {
        throw new Error('Stored DataOps access credential was rejected by userinfo')
      }
      accessExpiresAt = accessTokenExpiry(access.value)
      await ensureMcpMounted()
    } catch (error) {
      ctx.logger.warn('mcp-dataops: stored DataOps authorization could not be accepted')
      ctx.logger.warn(error)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: trackHandler(async (request, response) => {
      if (!requireConnection(ctx, request, response)
        || !requireLoopback(request, response)
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
          expiresAt: accountState.authorizationAccepted ? accessExpiresAt : null,
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
      if (!requireConnection(ctx, request, response)
        || !requireLoopback(request, response)
        || !requireSameOriginBrowser(request, response)
        || !requireMethod(request, response, 'GET')) return
      const state = await credentialState()
      assertActive()
      if (!state.writable) {
        sendJson(response, 409, { error: 'DataOps access credential must use a writable credential source.' })
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
      if (!requireConnection(ctx, request, response)
        || !requireLoopback(request, response)
        || !requireMethod(request, response, 'GET')) return
      const callback = new URL(request.url ?? CALLBACK_PATH, 'http://127.0.0.1')
      const stateValue = callback.searchParams.get('state') ?? ''
      const authorization = pending.get(stateValue)
      pending.delete(stateValue)
      if (authorization === undefined || Date.now() - authorization.createdAt > PENDING_TTL_MS) {
        ctx.logger.warn('mcp-dataops: authorization callback rejected missing or expired pending state')
        popupBridge(response, 'failed', 'pending-state')
        return
      }
      if (callback.searchParams.get('error') !== null) {
        popupBridge(response, 'cancelled')
        return
      }
      const code = callback.searchParams.get('code') ?? ''
      if (code === '') {
        ctx.logger.warn('mcp-dataops: authorization callback rejected missing code')
        popupBridge(response, 'failed', 'missing-code')
        return
      }
      const expectedGeneration = grantGeneration
      let token: TokenResponse | undefined
      let failureReason: OAuthFailureReason = 'token-service-failed'
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
        if (!tokenResponse.ok) {
          if (tokenResponse.status === 400) {
            failureReason = 'token-request-rejected'
          } else if (tokenResponse.status === 401 || tokenResponse.status === 403) {
            failureReason = 'token-account-rejected'
          } else {
            failureReason = 'token-service-failed'
          }
          throw new Error(`DataOps token exchange failed with HTTP ${String(tokenResponse.status)}`)
        }
        failureReason = 'token-response-invalid'
        token = parseTokenResponse(await tokenResponse.json())
        failureReason = 'account-verification'
        const account = await fetchAccount(token.access_token)
        if (account === null) throw new Error('DataOps access token was rejected by userinfo')
        failureReason = 'authorization-activation'
        await acceptAuthorization(token, expectedGeneration)
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
        popupBridge(response, 'failed', failureReason)
        return
      }
      popupBridge(response, 'connected')
    }),
  }), 'mcp-dataops: callback route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DISCONNECT_PATH,
    handler: trackHandler(async (request, response) => {
      if (!requireConnection(ctx, request, response)
        || !requireLoopback(request, response)
        || !requireSameOriginBrowser(request, response)
        || !requireMethod(request, response, 'POST')) return
      const state = await credentialState()
      assertActive()
      if (!state.writable) {
        sendJson(response, 409, { error: 'DataOps access credential must use a writable credential source.' })
        return
      }
      grantGeneration += 1
      pending.clear()
      try {
        const access = await ctx.credentials.resolve(accessRef)
        assertActive()
        await unmountMcp()
        if (access !== undefined) await requestRevocation(access.value)
        await ctx.credentials.unset(accessRef)
        accessExpiresAt = null
        sendJson(response, 200, { disconnected: true })
      } catch (error) {
        ctx.logger.warn('mcp-dataops: DataOps disconnect failed')
        ctx.logger.warn(error)
        sendJson(response, 502, { error: 'Unable to disconnect DataOps.' })
      }
    }),
  }), 'mcp-dataops: disconnect route')

}
