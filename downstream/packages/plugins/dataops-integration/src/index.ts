/**
 * Standalone DataOps integration for DSH. The plugin owns browser authorization,
 * one connection-scoped target identity, one delegated access credential, and generic
 * Streamable HTTP MCP composition.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'dataops-integration'
/** Host services required by the integration. */
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

declare const DATAOPS_TARGET_REF: unique symbol
type DataOpsTargetRef = string & { readonly [DATAOPS_TARGET_REF]: true }

/** Configuration for one standalone DataOps connection. */
export interface Config {
  /** Unified DataOps browser and API origin. */
  baseUrl: string
  /** Local namespace for discovered DataOps MCP tools. */
  serverName: string
  /** Credential reference that stores the delegated access token. */
  credentialRef: string
  /** Target identity credential for this DSH home. */
  targetCredentialRef: string
  /** Explicit DSH browser origin for non-loopback deployments. */
  callbackOrigin?: string
  /** Per-tool call timeout forwarded to the generic MCP client. */
  toolCallTimeoutMs: number
  /** Whether initial generic MCP connection failure rejects the plugin. */
  failOnStartupError: boolean
}

/** Schemastery parser for standalone DataOps configuration. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().default('http://127.0.0.1:3000'),
  serverName: z.string().default('dataops'),
  credentialRef: z.string().role('credential-ref').default('DATAOPS_MCP_TOKEN'),
  targetCredentialRef: z.string().role('credential-ref').default('DATAOPS_DSH_TARGET'),
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

function normalizeOrigin(value: string, field: 'baseUrl' | 'callbackOrigin'): string {
  if (!URL.canParse(value)) throw new Error(`dataops-integration: ${field} must be an absolute browser origin`)
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== '') {
    throw new Error(`dataops-integration: ${field} must be an HTTP or HTTPS origin without path, query, credentials, or fragment`)
  }
  return url.origin
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
    throw new Error('dataops-integration: target credential must contain a 32-128 character base64url identifier')
  }
  return value as DataOpsTargetRef
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!value || typeof value !== 'object') throw new Error('DataOps token endpoint returned an invalid response')
  const record = value as Record<string, unknown>
  if (typeof record.access_token !== 'string' || record.access_token.length === 0
    || record.token_type !== 'Bearer'
    || typeof record.expires_in !== 'number' || !Number.isInteger(record.expires_in) || record.expires_in <= 0
    || record.scope !== SCOPE) {
    throw new Error('DataOps token endpoint returned an invalid response')
  }
  return record as unknown as TokenResponse
}

function parseAccountResponse(value: unknown): AccountResponse {
  if (!value || typeof value !== 'object') throw new Error('DataOps userinfo endpoint returned an invalid response')
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
 * Register standalone authorization routes, Settings state, and the generic MCP child.
 * @param ctx - Cordis context with credentials, Web routes, and tools.
 * @param config - DataOps origin and local credential configuration.
 * @returns Startup readiness after the persistent target and stored access grant are checked.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const baseUrl = normalizeOrigin(config.baseUrl, 'baseUrl')
  const callbackOrigin = config.callbackOrigin === undefined
    ? undefined
    : normalizeOrigin(config.callbackOrigin, 'callbackOrigin')
  const accessRef: CredentialRef = credentialRef(config.credentialRef)
  const targetRefKey: CredentialRef = credentialRef(config.targetCredentialRef)

  // standalone target使用可写credential；Disconnect后换新target，管理员注入的只读target保持不变。
  const targetState = await ctx.credentials.describe(targetRefKey)
  if (!targetState.configured) {
    if (!targetState.writable) {
      throw new Error('dataops-integration: targetCredentialRef must be configured or use a writable source')
    }
    await ctx.credentials.set(targetRefKey, randomBytes(32).toString('base64url'))
  }
  const resolvedTarget = await ctx.credentials.resolve(targetRefKey)
  if (resolvedTarget === undefined) throw new Error('dataops-integration: target credential could not be resolved')
  let targetRef = parseTargetRef(resolvedTarget.value)

  const pending = new Map<string, PendingAuthorization>()
  let mcpFiber: Fiber | undefined

  const isMcpMounted = (): boolean => mcpFiber !== undefined && mcpFiber.uid !== null

  const unmountMcp = async (): Promise<void> => {
    const fiber = mcpFiber
    mcpFiber = undefined
    if (fiber !== undefined && fiber.uid !== null) {
      ctx.logger.info('dataops-integration: mcp.dispose.started')
      await fiber.dispose()
      ctx.logger.info('dataops-integration: mcp.dispose.complete')
    }
  }

  // 用户显式授权时只重挂一次DataOps child，不做后台轮换或周期remount。
  const mountMcp = async (accessToken: string): Promise<void> => {
    await unmountMcp()
    const fiber = ctx.plugin(McpClient, {
      transport: 'streamable-http',
      serverName: config.serverName,
      url: `${baseUrl}/api/ai/data-query/mcp`,
      headers: { Authorization: `Bearer ${accessToken}` },
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      failOnStartupError: config.failOnStartupError,
    })
    mcpFiber = fiber
    try {
      await fiber.await()
    } catch (error) {
      ctx.logger.error('dataops-integration: MCP child mount failed')
      ctx.logger.error(error)
      if (mcpFiber === fiber) mcpFiber = undefined
      await fiber.dispose()
      throw error
    }
  }

  ctx.effect(() => async () => {
    pending.clear()
    await unmountMcp()
  }, 'dataops-integration: authorization lifecycle')

  const credentialState = async (): Promise<CredentialState> => {
    const access = await ctx.credentials.describe(accessRef)
    return { configured: access.configured, writable: access.writable }
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
    const state = await credentialState()
    if (!state.configured) return { credential: state, account: null, authorizationAccepted: false }
    const resolved = await ctx.credentials.resolve(accessRef)
    if (resolved === undefined) throw new Error('Configured DataOps access credential could not be resolved')
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
    })
    if (!response.ok) throw new Error(`DataOps token revocation failed with HTTP ${String(response.status)}`)
  }

  const startupAccess = await ctx.credentials.resolve(accessRef)
  if (startupAccess !== undefined) {
    try {
      if (await fetchAccount(startupAccess.value) !== null) await mountMcp(startupAccess.value)
    } catch (error) {
      ctx.logger.warn('dataops-integration: stored DataOps authorization could not be accepted')
      ctx.logger.warn(error)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (request, response) => {
      if (!requireMethod(request, response, 'GET')) return
      try {
        const state = await currentAccount()
        sendJson(response, 200, {
          credentialConfigured: state.credential.configured,
          credentialWritable: state.credential.writable,
          disconnectReleasesAccount: targetState.writable,
          authorizationAccepted: state.authorizationAccepted,
          account: state.account,
        })
      } catch (error) {
        ctx.logger.warn('dataops-integration: status lookup failed')
        ctx.logger.warn(error)
        sendJson(response, 502, { error: 'Unable to read DataOps connection status.' })
      }
    },
  }), 'dataops-integration: status route')

  // Connect只创建一次有时限的PKCE事务，账号选择和批准全部留在DataOps原生页面。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONNECT_PATH,
    handler: async (request, response) => {
      if (!requireMethod(request, response, 'GET')) return
      const state = await credentialState()
      if (!state.writable) {
        sendJson(response, 409, { error: 'The DataOps access credential must use a writable source.' })
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
      response.writeHead(303, { location: authorize.toString(), 'referrer-policy': 'no-referrer' })
      response.end()
    },
  }), 'dataops-integration: connect route')

  // callback成功后替换access credential并重挂一次child；没有后台refresh或周期remount。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CALLBACK_PATH,
    handler: async (request, response) => {
      if (!requireMethod(request, response, 'GET')) return
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
        if (await fetchAccount(token.access_token) === null) {
          throw new Error('DataOps access token was rejected by userinfo')
        }
        await ctx.credentials.set(accessRef, token.access_token)
        await mountMcp(token.access_token)
        popupBridge(response, 'connected')
      } catch (error) {
        ctx.logger.warn('dataops-integration: authorization callback failed')
        ctx.logger.warn(error)
        popupBridge(response, 'failed')
      }
    },
  }), 'dataops-integration: callback route')

  // Disconnect先释放DataOps grant，再卸载工具、清access并为standalone home换新target。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DISCONNECT_PATH,
    handler: async (request, response) => {
      if (!requireMethod(request, response, 'POST')) return
      const state = await credentialState()
      if (!state.writable) {
        sendJson(response, 409, { error: 'The DataOps access credential must use a writable source.' })
        return
      }
      try {
        const access = await ctx.credentials.resolve(accessRef)
        if (access !== undefined) await requestRevocation(access.value)
        ctx.logger.info('dataops-integration: disconnect.revoke.complete')
        await unmountMcp()
        await ctx.credentials.unset(accessRef)
        ctx.logger.info('dataops-integration: disconnect.access-unset.complete')
        if (targetState.writable) {
          const nextTargetRef = randomBytes(32).toString('base64url')
          await ctx.credentials.set(targetRefKey, nextTargetRef)
          targetRef = parseTargetRef(nextTargetRef)
          ctx.logger.info('dataops-integration: disconnect.target-rotate.complete')
        }
        pending.clear()
        sendJson(response, 200, { disconnected: true })
      } catch (error) {
        ctx.logger.warn('dataops-integration: disconnect failed')
        ctx.logger.warn(error)
        sendJson(response, 502, { error: 'Unable to disconnect DataOps.' })
      }
    },
  }), 'dataops-integration: disconnect route')
}
