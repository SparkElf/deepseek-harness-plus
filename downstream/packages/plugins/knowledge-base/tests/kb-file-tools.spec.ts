// @ts-nocheck
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  KB_FILE_TOOL_GUIDANCE,
  KnowledgeToolError,
  asKnowledgeToolError,
  assertToolPath,
  createKnowledgeFileTools,
  type KnowledgeFileEntry,
  type KnowledgeFileHit,
  type KnowledgeFileToolHost,
  type KnowledgeToolCaller,
} from '../src/knowledgeTools.ts'
import { checkLocalPath, readAuthorized } from '../src/index.ts'

const fakeExec = {} as never

const toolFor = (host: KnowledgeFileToolHost, name: string) => {
  const definition = createKnowledgeFileTools(host).find(tool => tool.name === name)
  if (definition === undefined) throw new Error(`missing tool ${name}`)
  return definition
}

const execute = async (host: KnowledgeFileToolHost, name: string, args: Record<string, unknown>) => (
  toolFor(host, name).execute(args, fakeExec) as Promise<Record<string, any>>
)

interface FakeOptions {
  canRead?: (relPath: string) => boolean
  canWrite?: (relPath: string) => boolean
  statEntry?: KnowledgeFileToolHost['statEntry']
  readAuthorized?: KnowledgeFileToolHost['readAuthorized']
  list?: (relPath: string, caller: KnowledgeToolCaller) => Promise<KnowledgeFileEntry[]>
  search?: (scope: string, query: string, limit: number) => Promise<KnowledgeFileHit[]>
  readSettings?: () => Promise<{ reviewRequired?: boolean; mineruBaseUrl?: string }>
  auditThrows?: boolean
  searchIndex?: KnowledgeFileToolHost['searchIndex']
  chunkGet?: KnowledgeFileToolHost['chunkGet']
  outline?: KnowledgeFileToolHost['outline']
  outlineSave?: KnowledgeFileToolHost['outlineSave']
  vectorize?: KnowledgeFileToolHost['vectorize']
}

const makeHost = (options: FakeOptions = {}) => {
  const audits: Array<{ viewDir: string; entry: Record<string, unknown> }> = []
  const calls = {
    createEntry: [] as Array<{ relPath: string; options: { directory: boolean; content?: string } }>,
    overwritten: [] as string[],
    moves: [] as Array<{ from: string; to: string }>,
    trashed: [] as Array<{ relPath: string; kind: string }>,
    parked: [] as Array<{ relPath: string; content: string }>,
    enqueued: [] as string[],
  }
  const caller: KnowledgeToolCaller = { userId: 'u1', label: '超级管理员' }
  const host: KnowledgeFileToolHost = {
    ...(options.searchIndex === undefined ? {} : { searchIndex: options.searchIndex }),
    ...(options.chunkGet === undefined ? {} : { chunkGet: options.chunkGet }),
    ...(options.outline === undefined ? {} : { outline: options.outline }),
    ...(options.outlineSave === undefined ? {} : { outlineSave: options.outlineSave }),
    ...(options.vectorize === undefined ? {} : { vectorize: options.vectorize }),
    resolveCaller: async () => caller,
    canRead: async relPath => options.canRead?.(relPath) ?? true,
    canWrite: async relPath => options.canWrite?.(relPath) ?? true,
    list: options.list ?? (async (relPath) => ([{
      relPath: relPath === '' ? 'a.md' : relPath + '/a.md',
      name: 'a.md',
      isDir: false,
      size: 4,
    }])),
    search: options.search ?? (async (scope) => ([{
      relPath: scope === '' ? 'a.md' : scope + '/a.md',
      name: 'a.md',
      inContent: true,
      line: 'hello',
      lineNumber: 1,
    }])),
    readAuthorized: options.readAuthorized ?? (async (relPath) => {
      if (!(options.canRead?.(relPath) ?? true)) {
        throw new KnowledgeToolError('forbidden', 'read access is required for this path', relPath)
      }
      return { kind: 'text', content: 'hello', truncated: false }
    }),
    statEntry: options.statEntry ?? (async () => undefined),
    createEntry: async (relPath, createOptions) => {
      calls.createEntry.push({ relPath, options: createOptions })
      return { relPath, kind: createOptions.directory ? 'directory' : 'file' }
    },
    overwriteFile: async (relPath) => { calls.overwritten.push(relPath) },
    moveEntry: async (from, to) => {
      calls.moves.push({ from, to })
      return { from, to }
    },
    deleteToTrash: async (_caller, relPath, kind) => { calls.trashed.push({ relPath, kind }) },
    refreshView: async () => ({}),
    readSettings: options.readSettings ?? (async () => ({ reviewRequired: false, mineruBaseUrl: '' })),
    parkWrite: async (_caller, relPath, content) => { calls.parked.push({ relPath, content }) },
    enqueueExtraction: async (relPath) => {
      calls.enqueued.push(relPath)
      return { outcome: 'queued', task: { relPath, state: 'pending' } }
    },
    listExtractCandidates: async () => ['a.pdf', 'b.docx'],
    viewDir: userId => '/views/' + userId,
    appendAudit: async (viewDir, entry) => {
      if (options.auditThrows === true) throw new Error('audit disk full')
      audits.push({ viewDir, entry: entry as unknown as Record<string, unknown> })
    },
    isExtractable: relPath => relPath.endsWith('.pdf'),
    now: () => new Date('2026-10-23T00:00:00.000Z'),
  }
  return { host, audits, calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('kb_file tool surface', () => {
  it('registers the file and search tools without colliding with DataOps kb_read', () => {
    const names = createKnowledgeFileTools(makeHost().host).map(tool => tool.name).sort()
    expect(names).toEqual([
      'kb_chunk_get',
      'kb_file_delete',
      'kb_file_extract',
      'kb_file_mkdir',
      'kb_file_move',
      'kb_file_write',
      'kb_outline',
      'kb_outline_rewrite',
      'kb_outline_save',
      'kb_search',
      'kb_vectorize',
    ])
    for (const forbidden of ['kb_read', 'kb_explore']) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('tells the model not to use shell writes and distinguishes DataOps doc retrieval', () => {
    const tools = createKnowledgeFileTools(makeHost().host)
    for (const tool of tools.filter(item => item.name.startsWith('kb_file_'))) {
      expect(tool.description).toContain('do NOT create, modify, move or delete knowledge files with shell commands')
      expect(tool.description).toContain('kb_read/kb_context')
    }
    const searchDescription = tools.find(tool => tool.name === 'kb_search')?.description ?? ''
    expect(searchDescription).toContain('rg inside /workspace/kb')
    expect(searchDescription).toContain('do NOT walk directories with ls')
    expect(searchDescription).toContain('write that token body verbatim')
    expect(searchDescription).toContain('Never write a line number')
    expect(KB_FILE_TOOL_GUIDANCE).toContain('kb_file_*')
    expect(KB_FILE_TOOL_GUIDANCE).toContain('never write a line number')
  })

  it('maps filesystem errors to an actionable tool code', () => {
    expect(asKnowledgeToolError(Object.assign(new Error('gone'), { code: 'ENOENT' })).code).toBe('not-found')
    expect(asKnowledgeToolError(Object.assign(new Error('denied'), { code: 'EACCES' })).code).toBe('forbidden')
  })

  it('reports the four LocalPathRefusal codes and agrees with checkLocalPath', () => {
    for (const relPath of ['', '/abs/x', 'a/../b', 'a/\0b']) {
      const expected = checkLocalPath(relPath)?.code
      expect(expected).toBeDefined()
      try {
        assertToolPath(relPath)
        throw new Error('expected refusal for ' + JSON.stringify(relPath))
      } catch (error) {
        expect((error as { code?: string }).code).toBe(expected)
      }
    }
  })
})

describe('kb_file_write / mkdir', () => {
  it('creates a new document and records a create audit entry', async () => {
    const { host, audits, calls } = makeHost()
    const result = await execute(host, 'kb_file_write', { path: 'dept/x/a.md', content: '# hello' })
    expect(result).toMatchObject({ ok: true, created: true, bytes: 7, audit: { written: true } })
    expect(calls.createEntry[0]).toEqual({ relPath: 'dept/x/a.md', options: { directory: false, content: '# hello' } })
    expect(audits[0]).toMatchObject({
      viewDir: '/views/u1',
      entry: { action: 'create', relPath: 'dept/x/a.md', actor: 'u1', outcome: 'applied' },
    })
  })

  it('refuses an existing path unless overwrite is true', async () => {
    const { host } = makeHost({ statEntry: async () => ({ kind: 'file', size: 1 }) })
    await expect(execute(host, 'kb_file_write', { path: 'dept/x/a.md', content: 'x' }))
      .rejects.toMatchObject({ code: 'exists' })
  })

  it('overwrites in place and records an edit audit entry', async () => {
    const { host, audits, calls } = makeHost({ statEntry: async () => ({ kind: 'file', size: 1 }) })
    const result = await execute(host, 'kb_file_write', { path: 'dept/x/a.md', content: 'new', overwrite: true })
    expect(result).toMatchObject({ ok: true, created: false, overwritten: true })
    expect(calls.overwritten).toEqual(['dept/x/a.md'])
    expect(audits[0]?.entry.action).toBe('edit')
  })

  it('parks a create when review is required', async () => {
    const { host, calls } = makeHost({ readSettings: async () => ({ reviewRequired: true }) })
    const result = await execute(host, 'kb_file_write', { path: 'dept/x/a.md', content: 'pending' })
    expect(result).toMatchObject({ ok: true, pending: true, reviewRequired: true })
    expect(calls.parked).toEqual([{ relPath: 'dept/x/a.md', content: 'pending' }])
  })

  it('reports a failed audit without pretending the write failed', async () => {
    const { host } = makeHost({ auditThrows: true })
    const result = await execute(host, 'kb_file_write', { path: 'dept/x/a.md', content: 'x' })
    expect(result.ok).toBe(true)
    expect(result.audit).toEqual({ written: false, reason: 'audit disk full' })
  })

  it('creates a directory with a create audit entry', async () => {
    const { host, calls, audits } = makeHost()
    const result = await execute(host, 'kb_file_mkdir', { path: 'dept/x/new' })
    expect(result).toMatchObject({ ok: true, kind: 'directory' })
    expect(calls.createEntry[0]?.options.directory).toBe(true)
    expect(audits[0]?.entry.action).toBe('create')
  })
})

describe('kb_file_move / delete', () => {
  it('moves into an existing directory using the source name', async () => {
    const { host, calls, audits } = makeHost({
      statEntry: async (relPath) => (relPath === 'dept/target' ? { kind: 'directory' } : undefined),
    })
    const result = await execute(host, 'kb_file_move', { from: 'dept/a.md', to: 'dept/target' })
    expect(result).toMatchObject({ ok: true, from: 'dept/a.md', to: 'dept/target/a.md' })
    expect(calls.moves).toEqual([{ from: 'dept/a.md', to: 'dept/target/a.md' }])
    expect(audits[0]?.entry).toMatchObject({ action: 'move', toRelPath: 'dept/target/a.md' })
  })

  it('renames when the destination is a full path', async () => {
    const { host, calls } = makeHost()
    await execute(host, 'kb_file_move', { from: 'dept/a.md', to: 'dept/b.md' })
    expect(calls.moves).toEqual([{ from: 'dept/a.md', to: 'dept/b.md' }])
  })

  it('refuses a move when the destination is not writable', async () => {
    const { host, calls } = makeHost({
      canWrite: relPath => relPath !== 'dept/target',
      statEntry: async () => ({ kind: 'directory' }),
    })
    await expect(execute(host, 'kb_file_move', { from: 'dept/a.md', to: 'dept/target' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect(calls.moves).toEqual([])
  })

  it('records a tombstone delete without destroying bytes, with a delete audit entry', async () => {
    const { host, calls, audits } = makeHost({ statEntry: async () => ({ kind: 'file', size: 4 }) })
    const result = await execute(host, 'kb_file_delete', { path: 'dept/a.md' })
    expect(result).toMatchObject({ ok: true, trash: true, scope: 'caller-view', bytesDestroyed: false })
    expect(calls.trashed).toEqual([{ relPath: 'dept/a.md', kind: 'file' }])
    expect(audits[0]?.entry.action).toBe('delete')
  })

  it('refuses to delete a path it may not write', async () => {
    const { host, calls } = makeHost({
      canWrite: () => false,
      statEntry: async () => ({ kind: 'file' }),
    })
    await expect(execute(host, 'kb_file_delete', { path: 'dept/a.md' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect(calls.trashed).toEqual([])
  })
})

describe('kb_file_extract', () => {
  it('enqueues an extractable document', async () => {
    const { host, calls } = makeHost()
    const result = await execute(host, 'kb_file_extract', { path: 'dept/a.pdf' })
    expect(result).toMatchObject({ ok: true, path: 'dept/a.pdf', outcome: 'queued' })
    expect(calls.enqueued).toEqual(['dept/a.pdf'])
  })

  it('reports an unsupported format without enqueueing', async () => {
    const { host, calls } = makeHost()
    const result = await execute(host, 'kb_file_extract', { path: 'dept/a.md' })
    expect(result).toMatchObject({ ok: true, outcome: 'unsupported' })
    expect(calls.enqueued).toEqual([])
  })

  it('scan mode skips candidates the caller may not write', async () => {
    const { host, calls } = makeHost({ canWrite: relPath => relPath !== 'b.docx' })
    const result = await execute(host, 'kb_file_extract', {})
    expect(result.queued).toEqual([{ path: 'a.pdf', task: { relPath: 'a.pdf', state: 'pending' } }])
    expect(result.skipped).toBe(1)
    expect(calls.enqueued).toEqual(['a.pdf'])
  })
})

describe('readAuthorized kept for the UI read route', () => {
  it('fails closed when the permission answer is no, before reading the mount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-read-auth-'))
    try {
      await mkdir(join(root, 'dept'), { recursive: true })
      await writeFile(join(root, 'dept', 'a.md'), 'secret')
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ canRead: false })) as never))
      const ctx = { credentials: { resolve: async () => ({ value: 'token' }) } }
      await expect(readAuthorized(ctx as never, {
        baseUrl: 'https://dataops.example',
        credentialRef: 'KB_TOKEN',
        timeoutMs: 1_000,
        mountPoint: root,
      } as never, 'dept/a.md')).rejects.toMatchObject({ code: 'forbidden' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads in a personal deployment without calling any backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-read-auth-'))
    try {
      await mkdir(join(root, 'dept'), { recursive: true })
      await writeFile(join(root, 'dept', 'a.md'), 'personal')
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)
      const result = await readAuthorized({} as never, {
        baseUrl: '',
        credentialRef: 'KB_TOKEN',
        timeoutMs: 1_000,
        mountPoint: root,
      } as never, 'dept/a.md')
      expect(result).toMatchObject({ kind: 'text', content: 'personal' })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads after the permission answer is yes and keeps the view-relative path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-read-auth-'))
    try {
      await mkdir(join(root, 'dept'), { recursive: true })
      await writeFile(join(root, 'dept', 'a.md'), 'hello')
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ canRead: true })) as never))
      const ctx = { credentials: { resolve: async () => ({ value: 'token' }) } }
      const result = await readAuthorized(ctx as never, {
        baseUrl: 'https://dataops.example',
        credentialRef: 'KB_TOKEN',
        timeoutMs: 1_000,
        mountPoint: root,
      } as never, 'dept/a.md')
      expect(result).toMatchObject({ kind: 'text', content: 'hello' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('permission disclosure boundary', () => {
  it('keeps the path-level write check without a per-call permission oracle', async () => {
    const { host, calls } = makeHost({ canWrite: () => false })
    await expect(execute(host, 'kb_file_write', { path: 'a.md', content: 'x' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect(calls.createEntry).toHaveLength(0)
  })
})


describe('kb_search', () => {
  it('returns a citation token per hit', async () => {
    const searchIndex = vi.fn(async () => ({
      hits: [{
        path: 'global/制度.md', markdownPath: 'global/制度.md', line: 3,
        snippet: '[差旅]住宿标准', score: 1.2, quote: '差旅住宿标准', docId: 1, chunkId: 2,
        chunkKey: 'e63b7f9eda2d86cb',
      }],
      relaxed: false,
      queries: ['差旅'],
    }))
    const allowed = makeHost({ searchIndex })
    const result = await execute(allowed.host, 'kb_search', { query: '差旅', topK: 5 })
    expect(result).toMatchObject({ ok: true, count: 1, relaxed: false, queries: ['差旅'] })
    expect(result.hits[0]).not.toHaveProperty('markdownPath')
    expect(result.hits[0]).toMatchObject({
      citation: 'kb://doc/1/chunk/e63b7f9eda2d86cb',
      quote: '差旅住宿标准',
    })
    // Line fields are deliberately absent: they are what tempted the model to author
    // `path:line` / `:193`. The stable chunk token is the only citation handle.
    expect(result.hits[0]).not.toHaveProperty('line')
    expect(Object.keys(result.hits[0] ?? {}).sort()).toEqual([
      'chunkId', 'chunkKey', 'citation', 'docId', 'path', 'quote', 'score', 'snippet',
    ])
    expect(searchIndex).toHaveBeenCalledWith({ query: '差旅', topK: 5 })
  })

  it('rejects an empty query before touching the index', async () => {
    const searchIndex = vi.fn(async () => ({ hits: [], relaxed: false, queries: [] }))
    const { host } = makeHost({ searchIndex })
    await expect(execute(host, 'kb_search', { query: '   ' })).rejects.toMatchObject({ code: 'empty-path' })
    expect(searchIndex).not.toHaveBeenCalled()
  })

  it('passes section fields and navigation-only summary matches through', async () => {
    const searchIndex = vi.fn(async () => ({
      hits: [{
        path: 'global/制度.docx', markdownPath: 'global/制度.docx.md', line: 3,
        snippet: '[三分之二]通过', score: 1.2, quote: '三分之二以上同意',
        docId: 49, chunkId: 335, chunkKey: '1fe09e0dbfb4184d',
        sectionId: 's49-7', sectionPath: '第二章 表决 > 第五条', sectionSummary: '特别决议需三分之二以上同意。',
        sectionLevel: 2, docSummary: '《董事会议事规则》共两章。',
      }],
      relaxed: false,
      queries: ['三分之二'],
      relatedSections: [{
        docId: 49, kind: 'section_summary', sectionId: 's49-7',
        path: 'global/制度.docx', sectionPath: '第二章 表决',
        summary: '特别决议需三分之二以上同意。', sourceChunkIds: [335], score: 0.5,
      }],
    }))
    const { host } = makeHost({ searchIndex })
    const result = await execute(host, 'kb_search', { query: '三分之二' })
    expect(result.hits[0]).toMatchObject({
      sectionId: 's49-7',
      sectionPath: '第二章 表决 > 第五条',
      sectionSummary: '特别决议需三分之二以上同意。',
      sectionLevel: 2,
      docSummary: '《董事会议事规则》共两章。',
      citation: 'kb://doc/49/chunk/1fe09e0dbfb4184d',
    })
    expect(result.relatedSections).toEqual([expect.objectContaining({
      sectionId: 's49-7',
      sectionPath: '第二章 表决',
      navigationOnly: true,
    })])
    expect(result.relatedSections[0]).not.toHaveProperty('citation')
  })
})


describe('kb_outline', () => {
  const outline = {
    docId: 49,
    path: 'global/制度.docx',
    displayPath: '全局/制度.docx',
    summary: '《董事会议事规则》共两章，规定普通决议与特别决议的表决门槛。',
    summaryKind: 'llm' as const,
    summaryStatus: 'ready' as const,
    summaryVersion: 'llm-v1:abc123456789:def456789012',
    sourceChunkIds: [334, 335],
    toc: [{
      sectionId: 's49-7', title: '第二章 表决', headingPath: '第二章 表决',
      level: 1, chunkIds: [335], sourceChunkIds: [335],
    }],
    sections: [{
      sectionId: 's49-7', sectionPath: '第二章 表决', level: 1,
      summary: '特别决议需三分之二以上同意。',
      keyFacts: [{ fact: '第五条', value: '特别决议应当经全体董事三分之二以上同意。', chunkId: 335 }],
      chunkIds: [335], sourceChunkIds: [335],
    }],
    indexPath: '/nas/kb/index/md/49.INDEX.md',
  }

  it('returns summary/TOC/sections for a docId and for a full citation token', async () => {
    const resolver = vi.fn(async () => outline)
    const { host } = makeHost({ outline: resolver })
    const byId = await execute(host, 'kb_outline', { docId: 49 })
    expect(resolver).toHaveBeenCalledWith({ docId: 49 })
    expect(byId).toMatchObject({
      ok: true,
      navigationOnly: true,
      docId: 49,
      path: 'global/制度.docx',
      summary: outline.summary,
      summaryKind: 'llm',
      summaryStatus: 'ready',
      indexPath: '/nas/kb/index/md/49.INDEX.md',
    })
    expect(byId.sections[0]).toMatchObject({
      sectionPath: '第二章 表决',
      keyFacts: [{ value: '特别决议应当经全体董事三分之二以上同意。' }],
    })

    await execute(host, 'kb_outline', { citation: 'kb://doc/49/chunk/1fe09e0dbfb4184d?terms=x' })
    expect(resolver).toHaveBeenLastCalledWith({ docId: 49 })
  })

  it('reports a missing summary as a hint instead of fabricating one', async () => {
    const missing = {
      ...outline,
      summary: '',
      summaryKind: 'none' as const,
      summaryStatus: 'missing' as const,
      hint: '按 knowledge-base 技能的摘要流程生成摘要',
      sourceChunkIds: [],
      sections: outline.sections.map(section => ({ ...section, summary: '', keyFacts: [] })),
    }
    const { host } = makeHost({ outline: async () => missing })
    const result = await execute(host, 'kb_outline', { docId: 49 })
    expect(result).toMatchObject({
      ok: true,
      navigationOnly: true,
      summary: '',
      summaryKind: 'none',
      summaryStatus: 'missing',
      hint: '按 knowledge-base 技能的摘要流程生成摘要',
    })
  })

  it('rejects an invalid or missing docId before calling the host', async () => {
    const resolver = vi.fn(async () => outline)
    const { host } = makeHost({ outline: resolver })
    await expect(execute(host, 'kb_outline', {})).rejects.toMatchObject({ code: 'invalid-citation' })
    await expect(execute(host, 'kb_outline', { docId: 0 })).rejects.toMatchObject({ code: 'invalid-citation' })
    await expect(execute(host, 'kb_outline', { citation: 'kb://doc/not-a-number/chunk/x' }))
      .rejects.toMatchObject({ code: 'invalid-citation' })
    expect(resolver).not.toHaveBeenCalled()
  })

  it('preserves the host 403 for a document the caller cannot read', async () => {
    const forbidden = makeHost({
      outline: vi.fn(async () => { throw new KnowledgeToolError('forbidden', 'read access is required') }),
    })
    await expect(execute(forbidden.host, 'kb_outline', { docId: 49 })).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('kb_chunk_get', () => {
  it('resolves 49/335 to the original path and quote', async () => {
    const chunkGet = vi.fn(async () => ({
      docId: 49,
      chunkId: 335,
      path: 'global/rag-eval-fixtures/制度.docx',
      quote: '董事会 表决 通过 需要 三分之二',
      heading: '第二十五条',
      paragraph: 3,
      paragraphText: '第二十五条 董事会会议',
      boxes: [],
      snippet: '董事会 表决 通过 需要 三分之二',
    }))
    const { host } = makeHost({ chunkGet })
    const result = await execute(host, 'kb_chunk_get', { docId: 49, chunkId: 335 })
    expect(result).toMatchObject({
      ok: true,
      docId: 49,
      chunkId: 335,
      citation: 'kb://doc/49/chunk/335',
      path: 'global/rag-eval-fixtures/制度.docx',
      quote: '董事会 表决 通过 需要 三分之二',
      heading: '第二十五条',
    })
    expect(result).not.toHaveProperty('markdownPath')
    expect(chunkGet).toHaveBeenCalledWith({ docId: 49, chunkId: 335 })
  })

  it('accepts a full citation token and its stable chunk_key', async () => {
    const chunkGet = vi.fn(async () => ({
      docId: 49,
      chunkId: 25865,
      chunkKey: '1fe09e0dbfb4184d',
      path: 'global/rag-eval-fixtures/制度.docx',
      chunkOrdinal: 6,
      boxes: [],
      snippet: '第十五条 会议审议事项',
    }))
    const { host } = makeHost({ chunkGet })
    const result = await execute(host, 'kb_chunk_get', { citation: 'kb://doc/49/chunk/1fe09e0dbfb4184d?terms=%E8%A1%A8%E5%86%B3' })
    expect(chunkGet).toHaveBeenCalledWith({ docId: 49, chunkId: '1fe09e0dbfb4184d' })
    expect(result).toMatchObject({
      ok: true,
      citation: 'kb://doc/49/chunk/1fe09e0dbfb4184d',
      chunkOrdinal: 6,
    })
  })

  it('preserves a host not-found and a host forbidden refusal', async () => {
    const chunkGet = vi.fn(async () => { throw new KnowledgeToolError('not-found', 'no such document chunk') })
    await expect(execute(makeHost({ chunkGet }).host, 'kb_chunk_get', { docId: 49, chunkId: 335 }))
      .rejects.toMatchObject({ code: 'not-found' })
    const forbidden = makeHost({
      chunkGet: async () => { throw new KnowledgeToolError('forbidden', 'read access is required') },
    })
    await expect(execute(forbidden.host, 'kb_chunk_get', { docId: 49, chunkId: 335 }))
      .rejects.toMatchObject({ code: 'forbidden' })
  })
})


describe('kb_outline_save', () => {
  it('preserves the host read/write refusal for the source document', async () => {
    const { host } = makeHost({
      outlineSave: async () => {
        throw new KnowledgeToolError('forbidden', 'write access is required to save a summary for this document')
      },
    })
    await expect(execute(host, 'kb_outline_save', { docId: 1, summary: '摘要' }))
      .rejects.toMatchObject({ code: 'forbidden' })
  })

  it('passes validation failures back without pretending the save succeeded', async () => {
    const { host } = makeHost({
      outlineSave: async () => ({
        ok: false,
        docId: 1,
        summaryKind: 'none',
        written: { docSummary: false, sections: 0, sectionSummaries: 0, keyFacts: 0, summaryChunks: 0, indexPath: '/nas/kb/index/md/1.INDEX.md' },
        rejected: [{ field: 'summary', reason: '数字/比例/条款号在 source chunks 中找不到：3/4', missing: ['3/4'] }],
      }),
    })
    const result = await execute(host, 'kb_outline_save', {
      docId: 1,
      summary: '需要四分之三同意。',
      sections: [],
    })
    expect(result).toMatchObject({ ok: false, navigationOnly: false, rejected: [{ field: 'summary' }] })
  })

  it('returns write statistics on success and requires the saver host seam', async () => {
    const { host } = makeHost({
      outlineSave: async input => ({
        ok: true,
        docId: input.docId,
        summaryVersion: 'llm-v1:abc:def',
        summaryKind: 'llm',
        written: { docSummary: true, sections: 3, sectionSummaries: 2, keyFacts: 4, summaryChunks: 3, indexPath: '/nas/kb/index/md/1.INDEX.md' },
        rejected: [],
      }),
    })
    const result = await execute(host, 'kb_outline_save', {
      docId: 1,
      summary: '摘要',
      sections: [{ sectionId: 's1-1', summary: '章节摘要' }],
    })
    expect(result).toMatchObject({ ok: true, summaryKind: 'llm', written: { sections: 3 } })

    const { host: noSaver } = makeHost()
    await expect(execute(noSaver, 'kb_outline_save', { docId: 1, summary: '摘要' }))
      .rejects.toMatchObject({ code: 'not-configured' })
  })
})

describe('kb_vectorize explicit tool', () => {
  it('forwards exactly one target and reports the host result', async () => {
    let seen: Record<string, unknown> | undefined
    const { host } = makeHost({
      vectorize: async input => {
        seen = input as Record<string, unknown>
        return { ok: true, documents: [{ docId: 4, embedded: 2, skipped: 1, failed: 0 }], totals: { embedded: 2 } }
      },
    })
    const result = await execute(host, 'kb_vectorize', { docId: 4, dryRun: true })
    expect(seen).toEqual({ docId: 4, dryRun: true })
    expect(result).toMatchObject({ ok: true, documents: [{ docId: 4, embedded: 2 }] })
  })

  it('refuses when the feature is disabled instead of falling back', async () => {
    const { host } = makeHost()
    await expect(execute(host, 'kb_vectorize', { path: 'personal' }))
      .rejects.toMatchObject({ code: 'not-configured' })
  })

  it('requires exactly one target', async () => {
    const { host: allowed } = makeHost({ vectorize: async () => ({ ok: true }) })
    await expect(execute(allowed, 'kb_vectorize', {})).rejects.toMatchObject({ code: 'invalid' })
    await expect(execute(allowed, 'kb_vectorize', { docId: 1, path: 'a' })).rejects.toMatchObject({ code: 'invalid' })
  })
})
