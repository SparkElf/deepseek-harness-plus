/**
 * Real-composition guard: Loader + Include mount the standalone DataOps plugin
 * with the writable local credential provider, which creates one target identity
 * but does not contact MCP until delegated access and refresh credentials exist.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as DataOps from '../src/index.ts'

let root: string | undefined
let context: Context | undefined
let remote: Server | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (remote !== undefined) {
    const server = remote
    remote = undefined
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  }
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function startRemote(): Promise<{ baseUrl: string; requestCount: () => number }> {
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(500)
    response.end('MCP must not mount before authorization')
  })
  remote = server
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind TCP')
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requestCount: () => requests,
  }
}

async function loadComposition(baseUrl: string): Promise<{ ctx: Context; credentialsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-dataops-composition-'))
  const configPath = join(root, 'cordis.yml')
  const credentialsPath = join(root, '.credentials.yaml')
  await writeFile(configPath, [
    '- id: webserver',
    "  name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: tools',
    '  name: test-tools',
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentialsPath)}`,
    '    watch: false',
    '- id: dataops',
    "  name: '@deepseek-ai/dsh-mcp-dataops'",
    '  config:',
    `    baseUrl: ${JSON.stringify(baseUrl)}`,
    '    serverName: dataops-real-composition',
    '    credentialRef: DATAOPS_MCP_TOKEN',
    '    refreshCredentialRef: DATAOPS_MCP_REFRESH_TOKEN',
    '    targetCredentialRef: DATAOPS_DSH_TARGET',
    '    toolCallTimeoutMs: 1000',
    '    failOnStartupError: false',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const tools = {
    name: 'test-tools',
    apply(toolCtx: Context) {
      toolCtx.provide('tools', {} as never)
    },
  }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', CredentialsLocal],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-mcp-dataops', DataOps],
    ['test-tools', tools],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, credentialsPath }
}

describe('mcp-dataops real composition', () => {
  it('creates one target identity and waits for delegated credentials before MCP mount', async () => {
    const fixture = await startRemote()
    const { ctx, credentialsPath } = await loadComposition(fixture.baseUrl)
    const webServer = ctx.get('webServer')
    expect(webServer).toBeDefined()

    const status = await fetch(
      `http://127.0.0.1:${String(webServer!.port)}/integrations/dataops/status`,
      { headers: { 'sec-fetch-site': 'same-origin' } },
    )
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      baseUrl: fixture.baseUrl,
      serverName: 'dataops-real-composition',
      credentialConfigured: false,
      credentialWritable: true,
      authorizationAccepted: false,
      account: null,
    })
    expect(await readFile(credentialsPath, 'utf8')).toMatch(
      /^DATAOPS_DSH_TARGET: [A-Za-z0-9_-]{43}$/mu,
    )
    expect(fixture.requestCount()).toBe(0)
  })
})
