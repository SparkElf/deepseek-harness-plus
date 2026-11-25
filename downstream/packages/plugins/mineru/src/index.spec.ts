import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as MinerU from './index.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** A temporary PDF whose path stands in for the uploaded-file path. */
async function pdfFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mineru-'))
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'report.pdf')
  await writeFile(filePath, '%PDF fixture')
  return filePath
}

type ToolResult = Awaited<ReturnType<Context['tools']['execute']>>

function text(result: ToolResult): string {
  return result.content.filter(block => block.type === 'text').map(block => (block as { text?: string }).text ?? '').join('')
}

/** Boot the plugin with a scripted MinerU response and run the tool on one fixture. */
async function runTool(
  filePath: string,
  respond: (url: URL, form: FormData) => Response | Promise<Response>,
  config: { endpoint?: string; tier?: string } = {},
) {
  const calls: { url: URL; form: FormData }[] = []
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const form = init?.body as FormData
    calls.push({ url, form })
    return respond(url, form)
  })
  vi.stubGlobal('fetch', fetchMock)

  const ctx = new Context()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  await ctx.plugin(MinerU, {
    endpoint: config.endpoint ?? 'http://mineru.test/file_parse',
    ...(config.tier === undefined ? {} : { tier: config.tier }),
  } as never).await()
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: 'mineru-1' as never,
    name: 'mineru_parse_pdf',
    arguments: { file_path: filePath },
  })
  await ctx.fiber.dispose()
  return { result, calls, fetchMock }
}

/** A 4.x synchronous JSON result. */
function v4Payload(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    task_id: 'abc',
    status: 'completed',
    tier: 'basic',
    progress: { completed: 1, failed: 0, total: 1 },
    files: [{
      name: 'report.pdf',
      status: 'completed',
      parse: { duration_ms: 2026, parser_version: '4.0.12' },
      output_files: { markdown: { bytes: 18 }, structured_content: { bytes: 34 } },
      content: {
        markdown: '# Parsed report',
        structured_content: [{ type: 'text', text: 'Parsed report' }],
      },
    }],
    ...overrides,
  }), { headers: { 'content-type': 'application/json' } })
}

describe('mineru_parse_pdf', () => {
  it('sends the parse options as query parameters and returns the 4.x Markdown', async () => {
    const filePath = await pdfFixture()
    const { result, calls, fetchMock } = await runTool(filePath, () => v4Payload())

    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      sourcePath: filePath,
      markdown: '# Parsed report',
      contentList: JSON.stringify([{ type: 'text', text: 'Parsed report' }], null, 2),
      images: [],
    })
    expect(result.content).toEqual([{ type: 'text', text: `MinerU parsed ${filePath}.\n\n# Parsed report` }])
    expect(fetchMock).toHaveBeenCalledOnce()

    // The request body carries `files` and nothing else: MinerU 4.x reads parse options from
    // the query string and rejects a multipart body holding any second field with
    // "Too many fields. Maximum number of fields is 0."
    const [call] = calls
    expect([...call!.form.keys()]).toEqual(['files'])
    expect((call!.form.get('files') as File).name).toBe('report.pdf')
    expect(call!.url.searchParams.get('tier')).toBe('basic')
    expect(call!.url.searchParams.getAll('output_formats')).toEqual(['markdown', 'structured_content'])
  })

  it('names the requested tier and formats without dropping a query the endpoint already has', async () => {
    const filePath = await pdfFixture()
    const { calls } = await runTool(
      filePath,
      () => v4Payload(),
      { endpoint: 'http://mineru.test/v1/file_parse?token=t&output_formats=zip', tier: 'standard' },
    )

    const [call] = calls
    expect(call!.url.pathname).toBe('/v1/file_parse')
    expect(call!.url.searchParams.get('token')).toBe('t')
    expect(call!.url.searchParams.get('tier')).toBe('standard')
    // A tier the caller named replaces the endpoint's own, and formats are never duplicated.
    expect(call!.url.searchParams.getAll('output_formats')).toEqual(['markdown', 'structured_content'])
  })

  it('defaults to the basic tier instead of letting the server resolve its own', async () => {
    const filePath = await pdfFixture()
    const { calls } = await runTool(filePath, () => v4Payload())

    // The server's own default is `standard`, measured at 17.8 s against 2.0 s for `basic`
    // on the same one-page PDF.
    expect(calls[0]!.url.searchParams.get('tier')).toBe('basic')
  })

  it('rejects a tier MinerU 4.x does not know', () => {
    expect(() => MinerU.Config({ endpoint: 'http://mineru.test/file_parse', tier: 'turbo' } as never)).toThrow()
  })

  it('defaults the resolved tier to basic when the deployment names none', async () => {
    const filePath = await pdfFixture()
    // Booted without `tier`, so the schema leaves it to `apply` exactly as a profile would.
    const { calls } = await runTool(filePath, () => v4Payload(), { endpoint: 'http://mineru.test/file_parse' })

    expect(calls[0]!.url.searchParams.get('tier')).toBe('basic')
  })

  it('reads an archive result and keeps the legacy content-list name', async () => {
    const filePath = await pdfFixture()
    const archive = zipSync({
      'report/report.md': new TextEncoder().encode('# Parsed report'),
      'report/report_content_list.json': new TextEncoder().encode('[{"type":"text"}]'),
      'report/images/page-1.png': new Uint8Array([1, 2, 3]),
    })
    const { result } = await runTool(filePath, () => new Response(archive, {
      headers: { 'content-type': 'application/zip' },
    }))

    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      sourcePath: filePath,
      markdown: '# Parsed report',
      contentList: '[{"type":"text"}]',
      images: ['report/images/page-1.png'],
    })
  })

  it('reads an archive result named with the 4.x structured-content artifact', async () => {
    const filePath = await pdfFixture()
    const archive = zipSync({
      'report/report.md': new TextEncoder().encode('# Parsed report'),
      'report/report.structured_content.json': new TextEncoder().encode('[{"type":"text"}]'),
      'report/images/page-1.png': new Uint8Array([1, 2, 3]),
    })
    const { result } = await runTool(filePath, () => new Response(archive, {
      headers: { 'content-type': 'application/zip' },
    }))

    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      sourcePath: filePath,
      markdown: '# Parsed report',
      contentList: '[{"type":"text"}]',
      images: ['report/images/page-1.png'],
    })
  })

  it('reports the server explanation when the request is rejected', async () => {
    const filePath = await pdfFixture()
    const { result } = await runTool(filePath, () => new Response(JSON.stringify({
      error: { code: 'invalid_request', message: 'Too many fields. Maximum number of fields is 0.' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }))

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Too many fields. Maximum number of fields is 0.')
    expect(text(result)).toContain('400')
  })

  it('fails loudly when the task did not complete', async () => {
    const filePath = await pdfFixture()
    const { result } = await runTool(filePath, () => new Response(JSON.stringify({
      status: 'failed',
      tier: 'basic',
      files: [{ name: 'report.pdf', status: 'failed', error: { code: 'parse_error', message: 'engine crashed' } }],
    }), { headers: { 'content-type': 'application/json' } }))

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('engine crashed')
  })

  it('fails instead of returning empty Markdown when no output is present', async () => {
    const filePath = await pdfFixture()
    const { result } = await runTool(filePath, () => new Response(JSON.stringify({
      status: 'completed',
      tier: 'basic',
      files: [{ name: 'report.pdf', status: 'completed', content: {} }],
    }), { headers: { 'content-type': 'application/json' } }))

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Markdown')
  })

  it('still reads the 3.4.x inline result shape', async () => {
    const filePath = await pdfFixture()
    const { result } = await runTool(filePath, () => new Response(JSON.stringify({
      task_id: 'abc',
      status: 'completed',
      backend: 'pipeline',
      version: '3.4.5',
      results: { report: { md_content: '# Parsed report', content_list: '[{"type":"text"}]' } },
    }), { headers: { 'content-type': 'application/json' } }))

    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      sourcePath: filePath,
      markdown: '# Parsed report',
      contentList: '[{"type":"text"}]',
      images: [],
    })
  })
})
