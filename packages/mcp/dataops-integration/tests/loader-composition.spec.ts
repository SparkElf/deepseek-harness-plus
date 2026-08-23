/**
 * Real-composition guard: the optional DataOps integration boots from a
 * test-only cordis.yml through the actual Loader + Include path. With no
 * credentialRef configured it mounts the generic MCP client in anonymous mode,
 * exposes the browser status surface, and sends no Authorization header to the
 * remote MCP endpoint.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
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

async function startRemote(): Promise<{
  baseUrl: string
  authorization: Array<string | undefined>
}> {
  const authorization: Array<string | undefined> = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/api/ai/data-query/mcp') {
      response.writeHead(404)
      response.end()
      return
    }
    authorization.push(
      typeof request.headers.authorization === 'string'
        ? request.headers.authorization
        : undefined,
    )
    response.writeHead(401)
    response.end('unauthorized')
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
    authorization,
  }
}

async function loadComposition(baseUrl: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-dataops-composition-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: webserver',
    "  name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: tools',
    '  name: test-tools',
    '- id: dataops',
    "  name: '@deepseek-ai/dsh-mcp-dataops'",
    '  config:',
    `    baseUrl: ${JSON.stringify(baseUrl)}`,
    '    serverName: dataops-real-composition',
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
  return ctx
}

describe('mcp-dataops real composition', () => {
  it('boots anonymous DataOps MCP from cordis.yml without sending Authorization', async () => {
    const fixture = await startRemote()
    const ctx = await loadComposition(fixture.baseUrl)
    const webServer = ctx.get('webServer')
    expect(webServer).toBeDefined()

    const status = await fetch(
      `http://127.0.0.1:${String(webServer!.port)}/integrations/dataops/status`,
    )
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      baseUrl: fixture.baseUrl,
      serverName: 'dataops-real-composition',
      mode: 'anonymous',
      credentialConfigured: null,
      authorizationAccepted: null,
    })
    expect(fixture.authorization.length).toBeGreaterThan(0)
    expect(fixture.authorization.every(value => value === undefined)).toBe(true)
  })
})
