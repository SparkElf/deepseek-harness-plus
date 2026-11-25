import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  type OfficeKitBridgeHandle,
  type OfficeKitConversionRequest,
  startOfficeKitBridge,
} from '../src/office-kit-bridge.js'

const run = promisify(execFile)

/** Smallest byte sequence a PDF reader accepts as "a PDF"; the bridge only enforces non-empty output. */
const PDF_BYTES = Buffer.from('%PDF-1.4\n% officecli-pdf test fixture\n%%EOF\n', 'utf8')

interface FakeOfficeKit {
  convert: (request: OfficeKitConversionRequest, signal?: AbortSignal) => Promise<{ pdf: Uint8Array; missingFonts: readonly string[] }>
  calls: OfficeKitConversionRequest[]
  generation: { id: string }
}

function fakeContext(officeKit: FakeOfficeKit | undefined): { ctx: Context; disposers: Array<() => Promise<void>> } {
  const disposers: Array<() => Promise<void>> = []
  const ctx = {
    get: (name: string) => (name === 'officeKit' ? officeKit : undefined),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    effect: (factory: () => () => Promise<void>) => {
      disposers.push(factory())
      return () => undefined
    },
  } as unknown as Context
  return { ctx, disposers }
}

function fakeOfficeKit(): FakeOfficeKit {
  const calls: OfficeKitConversionRequest[] = []
  return {
    calls,
    generation: { id: 'test-generation' },
    convert: async (request, signal) => {
      calls.push(request)
      if (request.source.key.includes('broken.docx')) throw Object.assign(new Error('renderer exploded'), { code: 'invalid-document' })
      if (request.source.key.includes('timeout.docx')) throw Object.assign(new Error('conversion deadline exceeded'), { code: 'timeout' })
      const { bytes } = await request.source.read(signal ?? new AbortController().signal, 100 * 1024 * 1024)
      if (bytes.byteLength === 0) throw Object.assign(new Error('empty'), { code: 'invalid-document' })
      return { pdf: PDF_BYTES, missingFonts: [] }
    },
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.once('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        rejectPort(new Error('no port'))
        return
      }
      const { port } = address
      probe.close(() => resolvePort(port))
    })
  })
}

async function post(handle: OfficeKitBridgeHandle, token: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${handle.url}/internal/office-kit/convert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dataops-internal-token': token },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

let root = ''
let handle: OfficeKitBridgeHandle | undefined
let kit: FakeOfficeKit
let token = ''

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'office-kit-bridge-test-'))
  kit = fakeOfficeKit()
  const { ctx } = fakeContext(kit)
  handle = await startOfficeKitBridge(ctx, {
    configPath: path.join(root, 'dsh', 'office-kit-bridge.json'),
    workspaceRoots: [root],
    port: await freePort(),
    token: 'test-token-0123456789abcdefghijklmnopqrstuvwxyz',
    timeoutMs: 30_000,
    concurrency: 2,
    maxQueued: 2,
  })
  const config = JSON.parse(await readFile(handle.configPath, 'utf8')) as { token: string }
  token = config.token
})

afterAll(async () => {
  await handle?.close()
  await rm(root, { recursive: true, force: true })
})

describe('office-kit bridge', () => {
  it('writes the sidecar config with loopback-only connection data', async () => {
    const config = JSON.parse(await readFile(handle!.configPath, 'utf8'))
    expect(config).toMatchObject({
      version: 1,
      host: '127.0.0.1',
      port: handle!.port,
      url: `http://127.0.0.1:${handle!.port}`,
      tokenExpiresAt: null,
      workspaceRoots: [root],
      timeoutMs: 30_000,
      concurrency: 2,
      maxInputBytes: 100 * 1024 * 1024,
    })
    expect(typeof config.token).toBe('string')
    expect(config.token.length).toBeGreaterThanOrEqual(32)
  })

  it('rejects a request without the internal token', async () => {
    const response = await fetch(`${handle!.url}/internal/office-kit/convert`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(401)
  })

  it('reports health only with the token', async () => {
    const unauthorized = await fetch(`${handle!.url}/internal/office-kit/health`)
    expect(unauthorized.status).toBe(401)
    const authorized = await fetch(`${handle!.url}/internal/office-kit/health`, {
      headers: { 'x-dataops-internal-token': token },
    })
    const body = await authorized.json()
    expect(body).toMatchObject({ ok: true, concurrency: 2, timeoutMs: 30_000 })
  })

  it('converts a docx inside the workspace and refuses to overwrite it', async () => {
    const source = path.join(root, 'report.docx')
    await writeFile(source, 'docx-bytes')
    const target = path.join(root, 'report.pdf')
    const first = await post(handle!, token, { source, target })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ ok: true, bytes: PDF_BYTES.byteLength })
    expect(await readFile(target, 'utf8')).toBe(PDF_BYTES.toString('utf8'))
    expect(kit.calls.at(-1)).toMatchObject({ extension: 'docx', priority: 'foreground' })

    const second = await post(handle!, token, { source, target })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('target_exists')

    const forced = await post(handle!, token, { source, target, force: true })
    expect(forced.status).toBe(200)
  })

  it('accepts xlsx and pptx sources', async () => {
    for (const extension of ['xlsx', 'pptx']) {
      const source = path.join(root, `book.${extension}`)
      await writeFile(source, `${extension}-bytes`)
      const result = await post(handle!, token, { source, target: path.join(root, `book-${extension}.pdf`) })
      expect(result.status).toBe(200)
    }
  })

  it('rejects a source outside the workspace and an unsupported extension', async () => {
    const outside = await post(handle!, token, { source: '/etc/passwd', target: path.join(root, 'x.pdf') })
    expect(outside.status).toBe(403)
    expect(outside.body.error.code).toBe('path_outside_workspace')

    const unsupported = path.join(root, 'legacy.doc')
    await writeFile(unsupported, 'doc')
    const rejected = await post(handle!, token, { source: unsupported, target: path.join(root, 'legacy.pdf') })
    expect(rejected.status).toBe(415)
    expect(rejected.body.error.code).toBe('unsupported_format')
  })

  it('rejects a target whose directory escapes the workspace through a symlink', async () => {
    const source = path.join(root, 'linked-source.docx')
    await writeFile(source, 'docx')
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'office-kit-outside-'))
    const link = path.join(root, 'escape')
    await import('node:fs/promises').then(async fs => await fs.symlink(outsideDir, link))
    try {
      const result = await post(handle!, token, { source, target: path.join(link, 'escape.pdf') })
      expect(result.status).toBe(403)
      expect(result.body.error.code).toBe('path_outside_workspace')
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('maps an officeKit timeout to HTTP 504 with the timeout code', async () => {
    const source = path.join(root, 'timeout.docx')
    await writeFile(source, 'slow')
    const result = await post(handle!, token, { source, target: path.join(root, 'timeout.pdf') })
    expect(result.status).toBe(504)
    expect(result.body.error).toMatchObject({ code: 'timeout' })
  })

  it('runs at most two conversions at once and queues the rest', async () => {
    let running = 0
    let peak = 0
    const original = kit.convert
    kit.convert = async (request, signal) => {
      running += 1
      peak = Math.max(peak, running)
      try {
        await new Promise((resolveWait) => setTimeout(resolveWait, 120))
        return await original(request, signal)
      } finally {
        running -= 1
      }
    }
    try {
      const results = await Promise.all([1, 2, 3, 4].map(async (index) => {
        const source = path.join(root, `parallel-${index}.docx`)
        await writeFile(source, `docx-${index}`)
        return await post(handle!, token, { source, target: path.join(root, `parallel-${index}.pdf`) })
      }))
      expect(results.every((result) => result.status === 200)).toBe(true)
      expect(peak).toBe(2)
    } finally {
      kit.convert = original
    }
  })

  it('propagates officeKit errors with their code', async () => {
    const source = path.join(root, 'broken.docx')
    await writeFile(source, 'broken')
    const result = await post(handle!, token, { source, target: path.join(root, 'broken.pdf') })
    expect(result.status).toBe(422)
    expect(result.body.error).toMatchObject({ code: 'invalid-document' })
  })
})

describe('officecli-pdf sidecar', () => {
  const sidecar = path.join(import.meta.dirname, '..', 'plugins', 'officecli-pdf', 'officecli-pdf')

  it('answers --info with the manifest from plugin.json', async () => {
    const { stdout } = await run(process.execPath, [sidecar, '--info'], { env: { ...process.env } })
    const manifest = JSON.parse(stdout)
    expect(manifest).toMatchObject({
      name: 'officecli-pdf',
      protocol: 1,
      kinds: ['exporter'],
      extensions: ['.pdf'],
      idle_timeout_seconds: { default: 120, verbs: { export: 660 } },
      supports: ['from:docx', 'from:xlsx', 'from:pptx'],
      limits: { maxFileSizeMb: 100 },
    })
  })

  it('exports through the bridge and refuses an existing target without --force', async () => {
    const source = path.join(root, 'sidecar.docx')
    await writeFile(source, 'docx')
    const target = path.join(root, 'sidecar.pdf')
    const env = {
      ...process.env,
      OFFICE_KIT_BRIDGE_URL: handle!.url,
      OFFICE_KIT_BRIDGE_TOKEN: token,
      OFFICE_KIT_BRIDGE_CONFIG: '',
    }
    const { stderr } = await run(process.execPath, [sidecar, 'export', source, '--out', target], { env })
    expect(stderr).toContain('exported')
    expect((await readFile(target)).byteLength).toBe(PDF_BYTES.byteLength)

    await expect(run(process.execPath, [sidecar, 'export', source, '--out', target], { env }))
      .rejects.toMatchObject({ code: 73, stderr: expect.stringContaining('target_exists') })
  })

  it('fails explicitly when no bridge config exists', async () => {
    const source = path.join(root, 'no-bridge.docx')
    await writeFile(source, 'docx')
    await expect(run(process.execPath, [sidecar, 'export', source, '--out', path.join(root, 'no-bridge.pdf')], {
      env: {
        ...process.env,
        OFFICE_KIT_BRIDGE_CONFIG: path.join(root, 'absent', 'office-kit-bridge.json'),
        OFFICE_KIT_BRIDGE_URL: '',
        OFFICE_KIT_BRIDGE_TOKEN: '',
        DSH_HOME: path.join(root, 'absent-home'),
        HOME: path.join(root, 'absent-home'),
      },
    })).rejects.toMatchObject({ code: 69, stderr: expect.stringContaining('office_kit_bridge_unavailable') })
  })
})