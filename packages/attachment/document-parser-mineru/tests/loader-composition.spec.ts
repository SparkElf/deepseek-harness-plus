/** Real Loader composition for the provider-neutral parser plus MinerU provider. */
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import DocumentParserRuntime from '@deepseek-ai/dsh-document-parser'
import * as MinerUParser from '@deepseek-ai/dsh-document-parser-mineru'

let root: string | undefined
let context: Context | undefined
let server: Server | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() =>{  resolve() }))
    server = undefined
  }
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function mineruServer(): Promise<{
  endpoint: string
  requests: Array<{ url: string; contentType: string; body: string }>
}> {
  const requests: Array<{ url: string; contentType: string; body: string }> = []
  const archive = Buffer.from(zipSync({
    'sample.md': strToU8('# Parsed\n\nLoader composition body.'),
    'sample_content_list.json': strToU8('[{"type":"text","page_idx":0}]'),
    'images/figure.png': Uint8Array.of(1, 2, 3),
  }))
  server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      requests.push({
        url: request.url ?? '',
        contentType: request.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('latin1'),
      })
      response.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': String(archive.byteLength),
      })
      response.end(archive)
    })
  })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('MinerU test server has no port')
  return { endpoint: `http://127.0.0.1:${address.port}/file_parse`, requests }
}

async function loadComposition(endpoint: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-mineru-composition-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: document-parser',
    "  name: 'test-document-parser-service'",
    '  config:',
    '    provider: mineru',
    '    maxDirectMarkdownBytes: 4096',
    '- id: document-parser-mineru',
    "  name: '@deepseek-ai/dsh-document-parser-mineru'",
    '  config:',
    `    endpoint: ${JSON.stringify(endpoint)}`,
    '    timeoutMs: 5000',
    '    maxResponseBytes: 1048576',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-document-parser-service', DocumentParserRuntime],
    ['@deepseek-ai/dsh-document-parser-mineru', MinerUParser],
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

describe('MinerU document parser real Loader composition', () => {
  it('boots from cordis.yml and parses through the externally mocked /file_parse endpoint', async () => {
    const external = await mineruServer()
    const ctx = await loadComposition(external.endpoint)
    const original = new TextEncoder().encode('%PDF-')

    const parsed = await ctx.documentParser.parse({
      attachment: {
        attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
        mediaType: 'application/pdf',
        bytes: original.byteLength,
        name: 'sample.pdf',
      },
      data: original,
    })

    expect(parsed.parser).toBe('mineru')
    expect(new TextDecoder().decode(parsed.result.markdown)).toBe('# Parsed\n\nLoader composition body.')
    expect(JSON.parse(new TextDecoder().decode(parsed.result.contentList))).toEqual([{ type: 'text', page_idx: 0 }])
    expect(parsed.result.images).toEqual([{
      name: 'figure.png',
      mediaType: 'image/png',
      data: Uint8Array.of(1, 2, 3),
    }])
    expect(external.requests).toHaveLength(1)
    expect(external.requests[0]?.url).toBe('/file_parse')
    expect(external.requests[0]?.contentType).toContain('multipart/form-data; boundary=')
    expect(external.requests[0]?.body).toContain('name="files"; filename="sample.pdf"')
    expect(external.requests[0]?.body).toContain('name="return_md"')
    expect(external.requests[0]?.body).toContain('name="return_content_list"')
    expect(external.requests[0]?.body).toContain('name="return_images"')
    expect(external.requests[0]?.body).toContain('name="response_format_zip"')
  })
})
