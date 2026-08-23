import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { credentialRef, type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import * as DataOps from '../src/index.ts'

type Fixture = {
  server: Server
  baseUrl: string
  mcpAuthorization: Array<string | undefined>
  accountAuthorization: Array<string | undefined>
  tokenRequests: URLSearchParams[]
}

const contexts: Context[] = []
const fixtures: Fixture[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(fixtures.splice(0).map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function fixture(): Promise<Fixture> {
  const mcpAuthorization: Array<string | undefined> = []
  const accountAuthorization: Array<string | undefined> = []
  const tokenRequests: URLSearchParams[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/ai/data-query/mcp') {
      mcpAuthorization.push(typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined)
      response.writeHead(401)
      response.end('unauthorized')
      return
    }
    if (url.pathname === '/api/auth/dsh/account') {
      const authorization = typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined
      accountAuthorization.push(authorization)
      if (authorization !== 'Bearer fixture-mcp-token') {
        response.writeHead(401)
        response.end('unauthorized')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        account: {
          username: 'alice',
          displayName: 'Alice',
          email: 'alice@example.com',
        },
      }))
      return
    }
    if (url.pathname === '/api/auth/dsh/token' && request.method === 'POST') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        tokenRequests.push(new URLSearchParams(body))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          access_token: 'fixture-mcp-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'dataops.mcp',
        }))
      })
      return
    }
    response.writeHead(404)
    response.end()
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
    accountAuthorization,
    tokenRequests,
  }
  fixtures.push(result)
  return result
}

async function baseContext() {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('tools', {} as never)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  return ctx
}

class MemoryCredentials {
  readonly values = new Map<CredentialRef, string>()

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.values.has(ref), source: this.values.has(ref) ? 'memory' : undefined, writable: true })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
    return Promise.resolve()
  }
}

describe('mcp-dataops integration', () => {
  it('omits Authorization and reports anonymous mode when credentialRef is absent', async () => {
    const dataops = await fixture()
    const ctx = await baseContext()

    await ctx.plugin(DataOps, {
      baseUrl: dataops.baseUrl,
      serverName: 'dataops-anon',
      toolCallTimeoutMs: 1000,
      failOnStartupError: false,
    })

    expect(dataops.mcpAuthorization[0]).toBeUndefined()
    const status = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}/integrations/dataops/status`)
    expect(await status.json()).toMatchObject({
      mode: 'anonymous',
      baseUrl: dataops.baseUrl,
      credentialConfigured: null,
      authorizationAccepted: null,
      account: null,
    })
  })

  it('uses PKCE browser authorization, reports the selected account, and disconnects only this MCP identity', async () => {
    const dataops = await fixture()
    const ctx = await baseContext()
    const credentials = new MemoryCredentials()
    ctx.provide('credentials', credentials as never)
    const ref = credentialRef('DATAOPS_MCP_TOKEN')

    await ctx.plugin(DataOps, {
      baseUrl: dataops.baseUrl,
      serverName: 'dataops-auth',
      credentialRef: ref,
      toolCallTimeoutMs: 1000,
      failOnStartupError: false,
    })

    expect(dataops.mcpAuthorization).toEqual([])
    const localPort = ctx.webServer.port
    const initialStatus = await fetch(`http://127.0.0.1:${String(localPort)}/integrations/dataops/status`)
    expect(await initialStatus.json()).toMatchObject({
      mode: 'oauth',
      credentialConfigured: false,
      authorizationAccepted: false,
      account: null,
    })

    const dshOrigin = `http://127.0.0.1:${String(localPort)}`
      const connect = await fetch(`${dshOrigin}/integrations/dataops/connect?origin=${encodeURIComponent(dshOrigin)}`, { redirect: 'manual' })
    expect(connect.status).toBe(303)
    const authorize = new URL(connect.headers.get('location')!)
    expect(authorize.origin).toBe(dataops.baseUrl)
    expect(authorize.pathname).toBe('/api/auth/dsh/authorize')
    expect(authorize.searchParams.get('client_id')).toBe('deepseek-harness-plus')
    expect(authorize.searchParams.get('scope')).toBe('dataops.mcp')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')

    const state = authorize.searchParams.get('state')!
    const challenge = authorize.searchParams.get('code_challenge')!
    const redirectUri = authorize.searchParams.get('redirect_uri')!
    const callback = new URL(redirectUri)
    callback.searchParams.set('code', 'fixture-code')
    callback.searchParams.set('state', state)
    const completed = await fetch(callback)

    expect(completed.status).toBe(200)
    expect(await completed.text()).toContain('dsh:dataops-oauth')
    expect(credentials.values.get(ref)).toBe('fixture-mcp-token')
    expect(dataops.tokenRequests).toHaveLength(1)
    const tokenRequest = dataops.tokenRequests[0]!
    expect(tokenRequest.get('code')).toBe('fixture-code')
    expect(tokenRequest.get('redirect_uri')).toBe(redirectUri)
    const verifier = tokenRequest.get('code_verifier')!
    expect(createHash('sha256').update(verifier, 'ascii').digest('base64url')).toBe(challenge)
    expect(dataops.mcpAuthorization[0]).toBe('Bearer fixture-mcp-token')

    const connectedStatus = await fetch(`http://127.0.0.1:${String(localPort)}/integrations/dataops/status`)
    expect(await connectedStatus.json()).toMatchObject({
      mode: 'oauth',
      credentialConfigured: true,
      credentialWritable: true,
      authorizationAccepted: true,
      account: {
        username: 'alice',
        displayName: 'Alice',
        email: 'alice@example.com',
      },
    })
    expect(dataops.accountAuthorization.at(-1)).toBe('Bearer fixture-mcp-token')

    const disconnected = await fetch(`http://127.0.0.1:${String(localPort)}/integrations/dataops/disconnect`, { method: 'POST' })
    expect(disconnected.status).toBe(200)
    expect(credentials.values.has(ref)).toBe(false)
  })
})
