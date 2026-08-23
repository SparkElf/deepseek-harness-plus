import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { credentialRef, type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import * as DataOps from '../src/index.ts'

type Fixture = {
  server: Server
  baseUrl: string
  mcpAuthorization: Array<string | undefined>
  mcpInitializations: Array<string | undefined>
  userinfoAuthorization: Array<string | undefined>
  tokenRequests: URLSearchParams[]
}

const contexts: Context[] = []
const fixtures: Fixture[] = []

const profiles = {
  alice: {
    sub: 'user-alice',
    preferred_username: 'alice',
    name: 'Alice',
    email: 'alice@example.com',
  },
  bob: {
    sub: 'user-bob',
    preferred_username: 'bob',
    name: 'Bob',
    email: 'bob@example.com',
  },
} as const

type Profile = (typeof profiles)[keyof typeof profiles]

const accessProfiles = new Map<string, Profile>([
  ['alice-access', profiles.alice],
  ['alice-access-2', profiles.alice],
  ['alice-refreshed-access', profiles.alice],
  ['bob-access', profiles.bob],
])

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(fixtures.splice(0).map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function tokenResult(accessToken: string, refreshToken: string) {
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refreshToken,
    id_token: 'fixture-id-token',
    scope: 'openid dataops.mcp',
  }
}

async function fixture(): Promise<Fixture> {
  const mcpAuthorization: Array<string | undefined> = []
  const mcpInitializations: Array<string | undefined> = []
  const userinfoAuthorization: Array<string | undefined> = []
  const tokenRequests: URLSearchParams[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/api/ai/data-query/mcp') {
        const authorization = typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined
        mcpAuthorization.push(authorization)
        const message = JSON.parse(await requestBody(request)) as {
          jsonrpc?: unknown
          id?: unknown
          method?: unknown
          params?: { protocolVersion?: unknown }
        }
        if (message.method === 'initialize') {
          mcpInitializations.push(authorization)
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: typeof message.params?.protocolVersion === 'string'
                ? message.params.protocolVersion
                : '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'dataops-fixture', version: '1.0.0' },
            },
          }))
          return
        }
        if (message.method === 'notifications/initialized') {
          response.writeHead(202)
          response.end()
          return
        }
        if (message.method === 'tools/list') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }))
          return
        }
        response.writeHead(400)
        response.end('unexpected MCP request')
        return
      }
      if (url.pathname === '/api/auth/dsh/userinfo') {
        const authorization = typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined
        userinfoAuthorization.push(authorization)
        const token = authorization?.startsWith('Bearer ') === true
          ? authorization.slice('Bearer '.length)
          : ''
        const profile = accessProfiles.get(token)
        if (profile === undefined) {
          response.writeHead(401)
          response.end('unauthorized')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(profile))
        return
      }
      if (url.pathname === '/api/auth/dsh/token' && request.method === 'POST') {
        const params = new URLSearchParams(await requestBody(request))
        tokenRequests.push(params)
        let result: ReturnType<typeof tokenResult> | undefined
        if (params.get('grant_type') === 'authorization_code') {
          if (params.get('code') === 'alice-code') result = tokenResult('alice-access', 'alice-refresh')
          if (params.get('code') === 'alice-code-2') result = tokenResult('alice-access-2', 'alice-refresh-2')
          if (params.get('code') === 'bob-code') result = tokenResult('bob-access', 'bob-refresh')
        }
        if (params.get('grant_type') === 'refresh_token' && params.get('refresh_token') === 'alice-refresh') {
          result = tokenResult('alice-refreshed-access', 'alice-refresh')
        }
        if (result === undefined) {
          response.writeHead(400)
          response.end('invalid grant')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(result))
        return
      }
      response.writeHead(404)
      response.end()
    })().catch((error: unknown) => {
      response.writeHead(500)
      response.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind TCP')
  const result = {
    server,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    mcpAuthorization,
    mcpInitializations,
    userinfoAuthorization,
    tokenRequests,
  }
  fixtures.push(result)
  return result
}

async function baseContext() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  return ctx
}

class MemoryCredentials {
  readonly values = new Map<CredentialRef, string>()

  constructor(private readonly writable = true) {}

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = this.values.has(ref)
    return Promise.resolve({
      configured,
      ...(configured ? { source: 'memory' } : {}),
      writable: this.writable,
    })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    if (!this.writable) throw new Error('read-only credentials')
    this.values.set(ref, value)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    if (!this.writable) throw new Error('read-only credentials')
    this.values.delete(ref)
    return Promise.resolve()
  }
}

async function mountAuthorized(ctx: Context, dataops: Fixture, credentials: MemoryCredentials, serverName: string) {
  ctx.provide('credentials', credentials as never)
  const accessRef = credentialRef('DATAOPS_MCP_TOKEN')
  const refreshRef = credentialRef('DATAOPS_MCP_REFRESH_TOKEN')
  const fiber = ctx.plugin(DataOps, {
    baseUrl: dataops.baseUrl,
    serverName,
    credentialRef: accessRef,
    refreshCredentialRef: refreshRef,
    toolCallTimeoutMs: 1000,
    failOnStartupError: false,
  })
  await fiber.await()
  return { accessRef, refreshRef }
}

async function beginAuthorization(localPort: number) {
  const dshOrigin = `http://127.0.0.1:${String(localPort)}`
  const connect = await fetch(`${dshOrigin}/integrations/dataops/connect?origin=${encodeURIComponent(dshOrigin)}`, { redirect: 'manual' })
  expect(connect.status).toBe(303)
  return new URL(connect.headers.get('location')!)
}

async function completeAuthorization(authorize: URL, code: string) {
  const callback = new URL(authorize.searchParams.get('redirect_uri')!)
  callback.searchParams.set('code', code)
  callback.searchParams.set('state', authorize.searchParams.get('state')!)
  return fetch(callback)
}

describe('mcp-dataops integration', () => {
  it('omits Authorization and reports anonymous mode when delegated credentials are absent', async () => {
    const dataops = await fixture()
    const ctx = await baseContext()
    const fiber = ctx.plugin(DataOps, {
      baseUrl: dataops.baseUrl,
      serverName: 'dataops-anon',
      toolCallTimeoutMs: 1000,
      failOnStartupError: false,
    })
    await fiber.await()

    expect(dataops.mcpInitializations).toEqual([undefined])
    const status = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}/integrations/dataops/status`)
    expect(await status.json()).toMatchObject({
      mode: 'anonymous',
      baseUrl: dataops.baseUrl,
      credentialConfigured: null,
      authorizationAccepted: null,
      account: null,
    })
  })

  it('uses OIDC Authorization Code + PKCE, stores access and refresh credentials, and disconnects both', async () => {
    const dataops = await fixture()
    const ctx = await baseContext()
    const credentials = new MemoryCredentials()
    const { accessRef, refreshRef } = await mountAuthorized(ctx, dataops, credentials, 'dataops-auth')

    expect(dataops.mcpInitializations).toEqual([])
    const localPort = ctx.webServer.port
    const initialStatus = await fetch(`http://127.0.0.1:${String(localPort)}/integrations/dataops/status`)
    expect(await initialStatus.json()).toMatchObject({
      mode: 'oidc',
      credentialConfigured: false,
      authorizationAccepted: false,
      account: null,
    })

    const authorize = await beginAuthorization(localPort)
    expect(authorize.origin).toBe(dataops.baseUrl)
    expect(authorize.pathname).toBe('/api/auth/dsh/authorize')
    expect(authorize.searchParams.get('client_id')).toBe('deepseek-harness-plus')
    expect(authorize.searchParams.get('response_type')).toBe('code')
    expect(authorize.searchParams.get('scope')).toBe('openid dataops.mcp')
    expect(authorize.searchParams.get('prompt')).toBe('select_account')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')

    const challenge = authorize.searchParams.get('code_challenge')!
    const redirectUri = authorize.searchParams.get('redirect_uri')!
    const completed = await completeAuthorization(authorize, 'alice-code')

    expect(completed.status).toBe(200)
    expect(await completed.text()).toContain('dsh:dataops-oauth')
    expect(credentials.values.get(accessRef)).toBe('alice-access')
    expect(credentials.values.get(refreshRef)).toBe('alice-refresh')
    expect(dataops.tokenRequests).toHaveLength(1)
    const tokenRequest = dataops.tokenRequests[0]!
    expect(tokenRequest.get('grant_type')).toBe('authorization_code')
    expect(tokenRequest.get('code')).toBe('alice-code')
    expect(tokenRequest.get('redirect_uri')).toBe(redirectUri)
    const verifier = tokenRequest.get('code_verifier')!
    expect(createHash('sha256').update(verifier, 'ascii').digest('base64url')).toBe(challenge)
    expect(dataops.mcpInitializations).toEqual(['Bearer alice-access'])

    const connectedStatus = await fetch(`http://127.0.0.1:${String(localPort)}/integrations/dataops/status`)
    expect(await connectedStatus.json()).toMatchObject({
      mode: 'oidc',
      credentialConfigured: true,
      credentialWritable: true,
      authorizationAccepted: true,
      account: {
        sub: 'user-alice',
        username: 'alice',
        displayName: 'Alice',
        email: 'alice@example.com',
      },
    })
    expect(dataops.userinfoAuthorization.at(-1)).toBe('Bearer alice-access')

    const disconnected = await fetch(`http://127.0.0.1:${String(localPort)}/integrations/dataops/disconnect`, { method: 'POST' })
    expect(disconnected.status).toBe(200)
    expect(credentials.values.has(accessRef)).toBe(false)
    expect(credentials.values.has(refreshRef)).toBe(false)
  })

  it('refreshes a stored grant before mounting MCP so stale access is never used', async () => {
    const dataops = await fixture()
    const ctx = await baseContext()
    const credentials = new MemoryCredentials()
    const accessRef = credentialRef('DATAOPS_MCP_TOKEN')
    const refreshRef = credentialRef('DATAOPS_MCP_REFRESH_TOKEN')
    credentials.values.set(accessRef, 'stale-access')
    credentials.values.set(refreshRef, 'alice-refresh')

    await mountAuthorized(ctx, dataops, credentials, 'dataops-refresh')

    expect(dataops.tokenRequests).toHaveLength(1)
    expect(dataops.tokenRequests[0]!.get('grant_type')).toBe('refresh_token')
    expect(dataops.tokenRequests[0]!.get('refresh_token')).toBe('alice-refresh')
    expect(credentials.values.get(accessRef)).toBe('alice-refreshed-access')
    expect(credentials.values.get(refreshRef)).toBe('alice-refresh')
    expect(dataops.mcpInitializations).toEqual(['Bearer alice-refreshed-access'])
    expect(dataops.mcpAuthorization).not.toContain('Bearer stale-access')
  })

  it('keeps the MCP child for the same OIDC sub and remounts it before switching to another sub', async () => {
    const dataops = await fixture()
    const ctx = await baseContext()
    const credentials = new MemoryCredentials()
    await mountAuthorized(ctx, dataops, credentials, 'dataops-principal')
    const localPort = ctx.webServer.port

    const alice = await beginAuthorization(localPort)
    await completeAuthorization(alice, 'alice-code')
    expect(dataops.mcpInitializations).toEqual(['Bearer alice-access'])

    const sameAlice = await beginAuthorization(localPort)
    await completeAuthorization(sameAlice, 'alice-code-2')
    expect(dataops.mcpInitializations).toEqual(['Bearer alice-access'])

    const bob = await beginAuthorization(localPort)
    await completeAuthorization(bob, 'bob-code')
    expect(dataops.mcpInitializations).toEqual(['Bearer alice-access', 'Bearer bob-access'])
  })

  it('uses a configured canonical HTTPS callback origin without trusting the request Host as public topology', async () => {
    const dataops = await fixture()
    const ctx = await baseContext()
    const credentials = new MemoryCredentials()
    ctx.provide('credentials', credentials as never)
    const fiber = ctx.plugin(DataOps, {
      baseUrl: dataops.baseUrl,
      serverName: 'dataops-public-callback',
      credentialRef: 'DATAOPS_MCP_TOKEN',
      refreshCredentialRef: 'DATAOPS_MCP_REFRESH_TOKEN',
      callbackOrigin: 'https://dsh.example.com',
      toolCallTimeoutMs: 1000,
      failOnStartupError: false,
    })
    await fiber.await()

    const authorize = await beginAuthorization(ctx.webServer.port)
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://dsh.example.com/integrations/dataops/callback')
  })

  it('rejects partial delegated-credential configuration and insecure non-loopback callback origins', async () => {
    const dataops = await fixture()
    const ctx = await baseContext()
    const credentials = new MemoryCredentials()
    ctx.provide('credentials', credentials as never)

    await expect(ctx.plugin(DataOps, {
      baseUrl: dataops.baseUrl,
      serverName: 'dataops-partial',
      credentialRef: 'DATAOPS_MCP_TOKEN',
      toolCallTimeoutMs: 1000,
      failOnStartupError: false,
    }).await()).rejects.toThrow(/credentialRef and refreshCredentialRef/)

    await expect(ctx.plugin(DataOps, {
      baseUrl: dataops.baseUrl,
      serverName: 'dataops-callback',
      credentialRef: 'DATAOPS_MCP_TOKEN',
      refreshCredentialRef: 'DATAOPS_MCP_REFRESH_TOKEN',
      callbackOrigin: 'http://dsh.example.com',
      toolCallTimeoutMs: 1000,
      failOnStartupError: false,
    }).await()).rejects.toThrow(/callbackOrigin must be an HTTPS origin/)
  })
})
