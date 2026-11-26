// @ts-nocheck
/**
 * A write must finish the retrieval pipeline, not just put bytes on disk.
 *
 * The regression this pins was measured on the local 3000 workspace: a model copied
 * four PDFs into the mounted view with `cp`, `kb_file_extract` answered "no such
 * document", and the next `kb_sync` deleted the files as unregistered orphans. A
 * document is only a knowledge document once it is in the authoritative tree and in
 * the index, so these tests cover both halves:
 *
 * - the `kb_file_write` tool: Markdown/text is indexed immediately, an extractable
 *   format is queued for extraction (and NOT indexed twice);
 * - `syncView` adoption: a file that exists only in a view is imported instead of
 *   pruned, and the import is a real hardlink pair.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Config,
  adoptViewFile,
  apply,
} from '../src/index.ts'
import {
  createKnowledgeFileTools,
  type KnowledgeFileToolHost,
  type KnowledgeToolCaller,
} from '../src/knowledgeTools.ts'
import { syncView } from '../src/views.ts'
import { documentIndexStatus, indexPathFor } from '../src/ftsIndex.ts'

const fakeExec = {} as never

const temporaryDirectories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }).catch(() => undefined)))
})

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'kb-write-pipeline-'))
  temporaryDirectories.push(root)
  return root
}

const toolFor = (host: KnowledgeFileToolHost, name: string) => {
  const definition = createKnowledgeFileTools(host).find(tool => tool.name === name)
  if (definition === undefined) throw new Error(`missing tool ${name}`)
  return definition
}

const execute = async (host: KnowledgeFileToolHost, name: string, args: Record<string, unknown>) => (
  toolFor(host, name).execute(args, fakeExec) as Promise<Record<string, any>>
)

const caller: KnowledgeToolCaller = { userId: 'u1', label: 'Tester' }

interface FakeCalls {
  created: Array<{ relPath: string; options: Record<string, unknown> }>
  overwrittenText: string[]
  overwrittenBytes: string[]
  enqueued: Array<{ relPath: string; replaceSibling?: boolean }>
  indexed: string[]
}

function fakeHost(options: {
  existing?: boolean
  indexResult?: { status: string; docId?: number; chunks?: number }
  indexThrows?: boolean
} = {}): { host: KnowledgeFileToolHost; calls: FakeCalls } {
  const calls: FakeCalls = { created: [], overwrittenText: [], overwrittenBytes: [], enqueued: [], indexed: [] }
  const host: KnowledgeFileToolHost = {
    resolveCaller: async () => caller,
    canRead: async () => true,
    canWrite: async () => true,
    list: async () => [],
    search: async () => [],
    readAuthorized: async () => ({ kind: 'text', content: '', truncated: false }),
    statEntry: async () => (options.existing === true ? { kind: 'file', size: 3 } : undefined),
    createEntry: async (relPath, createOptions) => {
      calls.created.push({ relPath, options: createOptions as unknown as Record<string, unknown> })
      return { relPath, kind: 'file' }
    },
    overwriteFile: async relPath => { calls.overwrittenText.push(relPath) },
    overwriteFileBytes: async relPath => { calls.overwrittenBytes.push(relPath) },
    moveEntry: async (from, to) => ({ from, to }),
    deleteToTrash: async () => undefined,
    refreshView: async () => ({}),
    readSettings: async () => ({ reviewRequired: false, mineruBaseUrl: '' }),
    parkWrite: async () => undefined,
    enqueueExtraction: async (relPath, _caller, enqueueOptions) => {
      calls.enqueued.push({ relPath, ...(enqueueOptions?.replaceSibling === true ? { replaceSibling: true } : {}) })
      return { outcome: 'queued', task: { relPath, state: 'pending' } }
    },
    listExtractCandidates: async () => [],
    viewDir: userId => '/views/' + userId,
    appendAudit: async () => undefined,
    isExtractable: relPath => /\.(pdf|docx?|xlsx?|pptx?)$/iu.test(relPath),
    indexAfterWrite: async relPath => {
      calls.indexed.push(relPath)
      if (options.indexThrows === true) throw new Error('index unavailable')
      return options.indexResult ?? { status: 'indexed', docId: 7, chunks: 3 }
    },
    now: () => new Date('2026-11-16T00:00:00.000Z'),
  }
  return { host, calls }
}

describe('kb_file_write completes the pipeline', () => {
  it('indexes Markdown immediately and reports the row', async () => {
    const { host, calls } = fakeHost()
    const result = await execute(host, 'kb_file_write', { path: 'global/运维/手册.md', content: '# 手册\n\n正文' })

    expect(result).toMatchObject({ ok: true, created: true, index: { status: 'indexed', docId: 7, chunks: 3 } })
    expect(calls.indexed).toEqual(['global/运维/手册.md'])
    // A text format has nothing to extract, so the extraction queue must not run.
    expect(calls.enqueued).toEqual([])
  })

  it('indexes CSV directly instead of asking a parser to extract it', async () => {
    const { host, calls } = fakeHost()
    const result = await execute(host, 'kb_file_write', { path: 'global/data/表.csv', content: 'a,b\n1,2' })

    expect(result.index?.status).toBe('indexed')
    expect(calls.indexed).toEqual(['global/data/表.csv'])
    expect(calls.enqueued).toEqual([])
  })

  it('queues an extractable format and does not index the binary twice', async () => {
    const { host, calls } = fakeHost()
    const result = await execute(host, 'kb_file_write', { path: 'global/能汇集团/报告.docx', content: 'x' })

    expect(result.extraction).toMatchObject({ outcome: 'queued', task: { state: 'pending' } })
    expect(result.index?.status).toBe('pending-extraction')
    expect(calls.enqueued).toEqual([{ relPath: 'global/能汇集团/报告.docx' }])
    expect(calls.indexed).toEqual([])
  })

  it('writes a base64 PDF as bytes and queues extraction', async () => {
    const { host, calls } = fakeHost()
    const payload = Buffer.from('%PDF-1.4 fixture').toString('base64')
    const result = await execute(host, 'kb_file_write', {
      path: 'global/能汇集团/扫描件.pdf',
      content: payload,
      encoding: 'base64',
    })

    expect(result).toMatchObject({ ok: true, encoding: 'base64', bytes: payload.length === 0 ? 0 : Buffer.from('%PDF-1.4 fixture').byteLength })
    const written = calls.created[0]
    expect(written?.options.bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(written.options.bytes as Uint8Array).toString('utf8')).toBe('%PDF-1.4 fixture')
    expect(result.extraction?.outcome).toBe('queued')
  })

  it('rejects an invalid base64 payload instead of writing a broken file', async () => {
    const { host, calls } = fakeHost()
    await expect(execute(host, 'kb_file_write', {
      path: 'global/x.pdf',
      content: 'not base64!!',
      encoding: 'base64',
    })).rejects.toMatchObject({ code: 'invalid' })
    expect(calls.created).toEqual([])
  })

  it('re-extracts when an extractable document is overwritten', async () => {
    const { host, calls } = fakeHost({ existing: true })
    const result = await execute(host, 'kb_file_write', {
      path: 'global/报告.docx',
      content: Buffer.from('pk').toString('base64'),
      encoding: 'base64',
      overwrite: true,
    })

    expect(result.overwritten).toBe(true)
    expect(calls.overwrittenBytes).toEqual(['global/报告.docx'])
    expect(calls.enqueued).toEqual([{ relPath: 'global/报告.docx', replaceSibling: true }])
  })

  it('reports an index failure without failing the write', async () => {
    const { host } = fakeHost({ indexThrows: true })
    const result = await execute(host, 'kb_file_write', { path: 'global/a.md', content: 'x' })

    expect(result.ok).toBe(true)
    expect(result.index).toEqual({ status: 'failed', reason: 'index unavailable' })
  })
})

describe('a file that exists only in a view is adopted, not pruned', () => {
  const viewOptions = (root: string) => ({
    actualRoot: join(root, 'actual'),
    viewRoot: join(root, 'views'),
    userId: 'u-1',
  })

  const placeOrphan = async (root: string, relPath: string): Promise<string> => {
    const full = join(root, 'views', 'u-1', relPath)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, 'orphan bytes', 'utf8')
    return full
  }

  it('imports the orphan through adoptViewFile and keeps the hardlink pair', async () => {
    const root = await makeRoot()
    const options = viewOptions(root)
    await mkdir(join(options.actualRoot, 'global'), { recursive: true })
    const viewFile = await placeOrphan(root, 'global/能汇集团/报告.pdf')

    // Team deployment so the view path has an authoritative spelling; the permission
    // answer is stubbed because this test is about the filesystem transaction.
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: 'u-1', displayName: 'Tester' } }), { status: 200 })
      }
      if (url.includes('/resource-permissions/resolve')) {
        return new Response(JSON.stringify({ canRead: true, canWrite: true }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch)

    const config = Config({
      baseUrl: 'http://dataops.test',
      actualRoot: options.actualRoot,
      viewRoot: options.viewRoot,
      mountPoint: join(root, 'actual'),
      indexDir: join(root, 'index'),
    } as never) as never
    const ctx = { credentials: { resolve: async () => ({ value: 't', source: 'test' }) } } as never

    const result = await adoptViewFile(ctx, config, 'global/能汇集团/报告.pdf', { caller: { userId: 'u-1' } })

    expect(result).toMatchObject({ adopted: true, actualRelPath: 'global/能汇集团/报告.pdf' })
    const authoritative = join(options.actualRoot, 'global/能汇集团/报告.pdf')
    expect(await readFile(authoritative, 'utf8')).toBe('orphan bytes')
    // The view entry must be the authoritative inode, or the next sync would keep a
    // shadow copy in front of the real document.
    expect((await stat(authoritative)).ino).toBe((await stat(viewFile)).ino)
  })

  it('does not overwrite a different authoritative file with the same name', async () => {
    const root = await makeRoot()
    const options = viewOptions(root)
    await mkdir(join(options.actualRoot, 'global'), { recursive: true })
    await writeFile(join(options.actualRoot, 'global/x.pdf'), 'authoritative', 'utf8')
    await placeOrphan(root, 'global/x.pdf')

    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({ user: { id: 'u-1' }, canRead: true, canWrite: true }), { status: 200 })) as unknown as typeof fetch)
    const config = Config({
      baseUrl: 'http://dataops.test',
      actualRoot: options.actualRoot,
      viewRoot: options.viewRoot,
      mountPoint: join(root, 'actual'),
      indexDir: join(root, 'index'),
    } as never) as never
    const ctx = { credentials: { resolve: async () => ({ value: 't', source: 'test' }) } } as never

    const result = await adoptViewFile(ctx, config, 'global/x.pdf', { caller: { userId: 'u-1' } })
    expect(result.adopted).toBe(false)
    expect(await readFile(join(options.actualRoot, 'global/x.pdf'), 'utf8')).toBe('authoritative')
  })

  it('syncView keeps an adopted path and still unlinks an unadoptable one', async () => {
    const root = await makeRoot()
    const options = viewOptions(root)
    await mkdir(options.actualRoot, { recursive: true })
    await writeFile(join(options.actualRoot, 'known.md'), 'known', 'utf8')
    const kept = await placeOrphan(root, 'global/kept.pdf')
    const dropped = await placeOrphan(root, 'global/dropped.bin')

    const delta = await syncView(
      {
        ...options,
        fullScan: true,
        adoptOrphan: async (_relPath, full) => full === kept,
      },
      [{ relPath: 'known.md' }],
    )

    expect(delta.adopted).toEqual(['global/kept.pdf'])
    expect(delta.unlinked).toEqual(['global/dropped.bin'])
    expect((await stat(kept)).isFile()).toBe(true)
    await expect(stat(dropped)).rejects.toBeDefined()
  })
})

describe('an applied tool writes a searchable document end to end', () => {
  it('kb_file_write on Markdown creates a kb_docs row with chunks', async () => {
    const root = await makeRoot()
    const actualRoot = join(root, 'actual')
    const indexDir = join(root, 'index')
    const config = Config({
      baseUrl: '',
      storageMode: 'local',
      actualRoot,
      mountPoint: actualRoot,
      viewRoot: join(root, 'views'),
      indexDir,
    } as never) as never

    const tools = new Map<string, { execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }>()
    const ctx = {
      inject() {},
      effect: (factory: () => () => unknown) => factory(),
      credentials: { resolve: async () => ({ value: 't', source: 'test' }) },
      webServer: { register: () => () => undefined },
      tools: { register: (definition: { name: string }) => { tools.set(definition.name, definition as never); return () => undefined } },
      logger: { info() {}, warn() {} },
    }

    apply(ctx as never, config as never)

    const write = tools.get('kb_file_write')
    expect(write).toBeDefined()
    const result = await write!.execute({
      path: 'global/索引验收/写入即索引.md',
      content: '# 写入即索引\n\n这是通过 kb_file_write 写入的正文，必须能被检索到。',
    }, fakeExec) as Record<string, any>

    expect(result.ok).toBe(true)
    expect(result.index?.status).toBe('indexed')
    expect(result.index?.chunks).toBeGreaterThan(0)

    const row = documentIndexStatus(indexPathFor(indexDir), 'global/索引验收/写入即索引.md')
    expect(row.found).toBe(true)
    expect(row.chunks).toBeGreaterThan(0)
  })
})
