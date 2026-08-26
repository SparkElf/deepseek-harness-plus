import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer, { normalizeWebBasePath } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(basePath: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-webserver-base-path-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    `    basePath: '${basePath}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier !== '@deepseek-ai/dsh-host-webserver') throw new Error(`unexpected Loader import: ${specifier}`)
      return HttpServer
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('reverse-proxy base path', () => {
  it('normalizes only canonical absolute prefixes', () => {
    expect(normalizeWebBasePath(undefined)).toBe('')
    expect(normalizeWebBasePath('')).toBe('')
    expect(normalizeWebBasePath('/')).toBe('')
    expect(normalizeWebBasePath('/api/ai/workbench/dsh/web')).toBe('/api/ai/workbench/dsh/web')
    for (const invalid of ['relative', '/trailing/', '/a//b', '/a/../b', '/a?x=1', '/a#fragment']) {
      expect(() => normalizeWebBasePath(invalid)).toThrow(/basePath/)
    }
  })

  it('strips the external prefix for HTTP and upgrade route owners', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition('/gateway/dsh')
    const server = loaded.webServer
    const port = server.port
    expect(server.basePath).toBe('/gateway/dsh')

    server.register({
      kind: 'prefix',
      path: '/api',
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(req.url ?? '')
      },
    })
    const routed = await fetch(`http://127.0.0.1:${String(port)}/gateway/dsh/api/probe?x=1`)
    expect(routed.status).toBe(200)
    expect(await routed.text()).toBe('/api/probe?x=1')

    const outside = await fetch(`http://127.0.0.1:${String(port)}/api/probe`)
    expect(outside.status).toBe(404)

    server.registerUpgrade({
      path: '/api/events.mux',
      handler: (req, socket) => {
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Connection: Upgrade',
          'Upgrade: dsh-test',
          `X-Logical-Url: ${req.url ?? ''}`,
          '',
          '',
        ].join('\r\n'))
      },
    })
    const socket = connect(port, '127.0.0.1')
    await once(socket, 'connect')
    const response = once(socket, 'data')
    socket.write([
      'GET /gateway/dsh/api/events.mux?stream=1 HTTP/1.1',
      `Host: 127.0.0.1:${String(port)}`,
      'Connection: Upgrade',
      'Upgrade: dsh-test',
      '',
      '',
    ].join('\r\n'))
    const [data] = await response as [Buffer]
    expect(String(data)).toContain('101 Switching Protocols')
    expect(String(data)).toContain('X-Logical-Url: /api/events.mux?stream=1')
    socket.destroy()
  })
})
