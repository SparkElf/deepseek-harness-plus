import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Config,
  apply,
  extractionOutcomeOf,
} from '../src/index.ts'

/**
 * Upload and extraction are two promises, and these tests pin that separation.
 *
 * The failure being prevented is not a wrong string: it is that a slow parse used to
 * hold the upload response open, so a large scanned PDF looked like a large failing
 * upload and never appeared in the tree until the parser finished. Every assertion
 * below is about ORDER -- what has already happened when the response is written.
 */

const CONFIG = Config({
  baseUrl: 'http://dataops.test',
  actualRoot: '/tmp/unused',
  viewRoot: '/tmp/unused-views',
  mountPoint: '/tmp/unused-mnt',
  indexDir: '/tmp/kb-test-index-unused',
} as never) as unknown as Record<string, unknown>

/** Directories created by this suite, removed after each test. */
const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }).catch(() => undefined)))
})

/** A root whose three trees are isolated per test. */
async function fixtureRoot(): Promise<{ root: string; config: typeof CONFIG }> {
  const root = await mkdtemp(join(tmpdir(), 'kb-extract-route-'))
  temporaryDirectories.push(root)
  await mkdir(join(root, 'actual'), { recursive: true })
  await mkdir(join(root, 'views', 'u-1'), { recursive: true })
  return {
    root,
    config: {
      ...CONFIG,
      actualRoot: join(root, 'actual'),
      viewRoot: join(root, 'views'),
      mountPoint: join(root, 'actual'),
    } as typeof CONFIG,
  }
}

/**
 * A Host stub covering the seams the routes touch.
 *
 * `fetchImpl` answers identity and permissions; the routes' own extraction goes
 * through `extractDocument`, which reaches for MinerU via `fetch` and for the local
 * authorities via child processes -- so an extraction that should produce nothing is
 * enough to prove the upload did not wait for it.
 */
function fakeHost(options: { fetchImpl: typeof fetch; mineruPort?: () => number }) {
  const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }> = []
  const disposers: Array<() => unknown> = []
  vi.stubGlobal('fetch', options.fetchImpl)
  disposers.push(() => { vi.unstubAllGlobals() })
  const ctx = {
    inject(_deps: readonly string[], _run: (scoped: unknown) => void) {},
    effect(factory: () => () => unknown) { disposers.push(factory()) },
    credentials: {
      // The routes need a bearer token for every DataOps call, so the stub must
      // resolve one: a `undefined` here turns every route into "not configured".
      async resolve() { return { value: 'test-token', source: 'test' } },
    },
    webServer: {
      register(route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) {
        routes.push(route)
        return () => undefined
      },
    },
    tools: {
      register() { return () => undefined },
    },
  }
  return { ctx, routes, disposers }
}

/** Drive one route and return the parsed reply plus the status it answered with. */
async function callRoute(
  routes: Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }>,
  method: string,
  body: Record<string, unknown>,
  // Accepted for readability at the call site: vitest's own test timeout is what
  // actually bounds a route that waits on extraction, and a real per-route deadline
  // would need the route to accept an abort signal it does not have.
  _routeTimeoutMs?: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = routes.find(candidate => candidate.path === '/knowledge-base/api')
  if (route === undefined) throw new Error('the settings route was never registered')
  let reply: Record<string, unknown> = {}
  let status = 0
  const req = {
    url: `/knowledge-base/api/${method}`,
    on(event: string, handler: (chunk?: Buffer) => void) {
      if (event === 'data') handler(Buffer.from(JSON.stringify(body)))
      if (event === 'end') handler()
      return req
    },
  }
  const res = {
    set statusCode(value: number) { status = value },
    get statusCode() { return status },
    setHeader: () => undefined,
    end(text: string) { reply = JSON.parse(text) as Record<string, unknown> },
  }
  await route.handler(req, res)
  return { status, body: reply }
}

/** Identity plus a per-path permission table. */
function permissionFetch(table: Record<string, { canRead?: boolean; canWrite?: boolean }> = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/auth/me')) {
      return new Response(JSON.stringify({ user: { id: 'u-1', displayName: 'Tester' } }), { status: 200 })
    }
    if (url.includes('/resource-permissions/resolve')) {
      const sent = JSON.parse(String(init?.body ?? '{}')) as { resourceId?: string }
      const answer = table[sent.resourceId ?? ''] ?? { canRead: true, canWrite: true }
      return new Response(JSON.stringify(answer), { status: 200 })
    }
    // Any other request -- notably a MinerU parse -- is unreachable in these tests.
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
}

/** Wait until the assertion holds, so a background task is given a chance to run. */
async function eventually(check: () => Promise<boolean> | boolean, attempts = 100): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

describe('an upload answers before extraction', () => {
  it('reports the document as written and the extraction as merely accepted', async () => {
    const { root, config } = await fixtureRoot()
    const { ctx, routes, disposers } = fakeHost({ fetchImpl: permissionFetch() })
    try {
      apply(ctx as never, config as never)
      // A `.docx` has a reader, so this really does schedule work; the point is that
      // the reply does not wait for it.
      const reply = await callRoute(routes, 'upload', {
        relPath: 'reports/report.docx',
        encoding: 'base64',
        content: Buffer.from('not a real docx').toString('base64'),
      })

      // The bytes are on disk before the response, which is what makes the file
      // visible in the tree and on the home page immediately. 207 is the same success
      // with a view-sync warning: this fixture builds no view to sync into, so the
      // route correctly reports that the tree could not be refreshed.
      expect([200, 207]).toContain(reply.status)
      await expect(stat(join(config.actualRoot as string, 'reports/report.docx'))).resolves.toBeDefined()
      // And the reply says the extraction is accepted, NOT that it finished.
      const extraction = reply.body.extraction as { state?: string } | undefined
      expect(extraction?.state).toBe('pending')
      // The old shape reported `markdown` inline; it must not be claimed before a run.
      expect(extraction).not.toHaveProperty('markdown')
      expect(root).toBeDefined()
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('does not hold the response open for a parse that never answers', async () => {
    const { config } = await fixtureRoot()
    // A MinerU that accepts the connection and then never settles is the worst case
    // the old synchronous path could not survive: the upload waited on it.
    const hangingFetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: 'u-1' } }), { status: 200 })
      }
      if (url.includes('/resource-permissions/resolve')) {
        return new Response(JSON.stringify({ canRead: true, canWrite: true }), { status: 200 })
      }
      return new Promise<Response>(() => { /* never settles */ })
    }) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ fetchImpl: hangingFetch })
    try {
      apply(ctx as never, config as never)
      // A PDF prefers MinerU, so this would previously have waited on the hang.
      const started = Date.now()
      const reply = await callRoute(routes, 'upload', {
        relPath: 'scan.pdf',
        encoding: 'base64',
        content: Buffer.from('%PDF-1.4 fixture').toString('base64'),
      })
      const elapsed = Date.now() - started

      expect([200, 207]).toContain(reply.status)
      // Generous bound: the assertion is that it did not wait for the parse at all.
      expect(elapsed).toBeLessThan(3000)
      await expect(stat(join(config.actualRoot as string, 'scan.pdf'))).resolves.toBeDefined()
    } finally {
      for (const dispose of disposers) dispose()
    }
  })
})

describe('extraction status is observable and never claims a phantom run', () => {
  it('reports a task as pending or running, then settles it', async () => {
    const { config } = await fixtureRoot()
    const { ctx, routes, disposers } = fakeHost({ fetchImpl: permissionFetch() })
    try {
      apply(ctx as never, config as never)
      await callRoute(routes, 'upload', {
        relPath: 'a.docx',
        encoding: 'base64',
        content: Buffer.from('bytes').toString('base64'),
      })

      const running = await eventually(async () => {
        const status = await callRoute(routes, 'extract.status', {})
        const tasks = status.body.tasks as Array<{ state?: string }> | undefined
        return tasks !== undefined && tasks.some(task => task.state === 'running' || task.state === 'pending')
      })
      expect(running).toBe(true)

      // With no reachable authority the run ends as failed, carrying its reason -- it
      // must not stay "running" for ever while the queue is actually empty.
      const settled = await eventually(async () => {
        const status = await callRoute(routes, 'extract.status', {})
        const tasks = status.body.tasks as Array<{ state?: string; reason?: string }> | undefined
        const task = tasks?.find(entry => entry.state !== 'pending' && entry.state !== 'running')
        if (task === undefined) return false
        // A terminal state must explain itself: success names the sibling, failure and
        // unsupported name a reason. A bare terminal state would be unauditable.
        return task.state === 'succeeded' || (typeof task.reason === 'string' && task.reason !== '')
      }, 600)
      expect(settled).toBe(true)

      const final = await callRoute(routes, 'extract.status', {})
      // Nothing is running once the queue drained: this is the check that stops a
      // restart (which empties the in-memory queue) from reading as "still working".
      expect(final.body.running).toBeUndefined()
      expect(final.body.size).toBe(0)
    } finally {
      for (const dispose of disposers) dispose()
    }
  }, 30_000)

  it('reports an empty queue for a file it never saw, without inventing a state', async () => {
    const { config } = await fixtureRoot()
    const { ctx, routes, disposers } = fakeHost({ fetchImpl: permissionFetch() })
    try {
      apply(ctx as never, config as never)
      const status = await callRoute(routes, 'extract.status', {})
      expect(status.body.running).toBeUndefined()
      expect(status.body.size).toBe(0)
      expect(status.body.tasks).toEqual([])
    } finally {
      for (const dispose of disposers) dispose()
    }
  })
})

describe('the manual retry route', () => {
  it('refuses a format with no reader, naming the reason', async () => {
    const { config } = await fixtureRoot()
    const { ctx, routes, disposers } = fakeHost({ fetchImpl: permissionFetch() })
    try {
      apply(ctx as never, config as never)
      // `.zip` is the shape this branch is about. It used to be tested with `.md`, which
      // is exactly the conflation that produced the reported defect: a reader's own
      // Markdown was reported as an unreadable format.
      await writeFile(join(config.actualRoot as string, 'bundle.zip'), 'PK')
      const reply = await callRoute(routes, 'extract.retry', { relPath: 'bundle.zip' })
      expect(reply.body.outcome).toBe('unsupported')
      expect(String(reply.body.message)).toContain('no extractor')
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('tells a Markdown document it needs no extraction instead of calling it unreadable', async () => {
    // 用户报的原始缺陷：两个 `.md` 文件在进度弹窗里都显示「该文件类型无解析器」。
    const { config } = await fixtureRoot()
    const { ctx, routes, disposers } = fakeHost({ fetchImpl: permissionFetch() })
    try {
      apply(ctx as never, config as never)
      await writeFile(join(config.actualRoot as string, 'notes.md'), '# hi')
      const reply = await callRoute(routes, 'extract.retry', { relPath: 'notes.md' })
      // A success-shaped answer, not a failure: nothing needed doing.
      expect(reply.body.outcome).toBe('already-markdown')
      expect(String(reply.body.message)).toContain('already Markdown')
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('records the Markdown request in the queue so the panel can show it', async () => {
    // 点了要有反馈：如果这次请求不留任何记录，弹窗里就没东西可显示，读者会以为按钮坏了。
    const { config } = await fixtureRoot()
    const { ctx, routes, disposers } = fakeHost({ fetchImpl: permissionFetch() })
    try {
      apply(ctx as never, config as never)
      await writeFile(join(config.actualRoot as string, 'notes.md'), '# hi')
      await callRoute(routes, 'extract.retry', { relPath: 'notes.md' })
      const status = await callRoute(routes, 'extract.status', {})
      const tasks = (status.body as { tasks?: Array<{ relPath: string; state: string }> }).tasks ?? []
      const task = tasks.find(entry => entry.relPath === 'notes.md')
      expect(task?.state).toBe('already-markdown')
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('reports an existing sibling instead of overwriting it', async () => {
    const { config } = await fixtureRoot()
    const { ctx, routes, disposers } = fakeHost({ fetchImpl: permissionFetch() })
    try {
      apply(ctx as never, config as never)
      await writeFile(join(config.actualRoot as string, 'report.docx'), 'bytes')
      await writeFile(join(config.actualRoot as string, 'report.docx.md'), '# hand written')
      const reply = await callRoute(routes, 'extract.retry', { relPath: 'report.docx' })
      expect(reply.body.outcome).toBe('exists')
      expect(reply.body.markdown).toBe('report.docx.md')
      // The hand-written sibling is untouched.
      await expect(readFile(join(config.actualRoot as string, 'report.docx.md'), 'utf8')).resolves.toBe('# hand written')
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('reports the extractor reason when no authority can read the document', async () => {
    const { config } = await fixtureRoot()
    const { ctx, routes, disposers } = fakeHost({ fetchImpl: permissionFetch() })
    try {
      apply(ctx as never, config as never)
      await writeFile(join(config.actualRoot as string, 'scan.pdf'), '%PDF-1.4 fixture')
      const reply = await callRoute(routes, 'extract.retry', { relPath: 'scan.pdf' })
      expect(reply.body.outcome).toBe('failed')
      // The reason is the extractor's own string, which is what a reader acts on.
      expect(String(reply.body.reason)).toContain('no-extractor-succeeded')
    } finally {
      for (const dispose of disposers) dispose()
    }
  }, 30_000)

  it('refuses a path the caller may not write', async () => {
    const { config } = await fixtureRoot()
    const { ctx, routes, disposers } = fakeHost({
      fetchImpl: permissionFetch({ 'locked.docx': { canRead: true, canWrite: false } }),
    })
    try {
      apply(ctx as never, config as never)
      await writeFile(join(config.actualRoot as string, 'locked.docx'), 'bytes')
      const reply = await callRoute(routes, 'extract.retry', { relPath: 'locked.docx' })
      expect(reply.status).toBe(403)
      expect(String(reply.body.error)).toContain('write access')
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('refuses a path that escapes the knowledge root', async () => {
    const { config } = await fixtureRoot()
    const { ctx, routes, disposers } = fakeHost({ fetchImpl: permissionFetch() })
    try {
      apply(ctx as never, config as never)
      const reply = await callRoute(routes, 'extract.retry', { relPath: '../outside.docx' })
      expect(reply.status).toBe(400)
      expect(String(reply.body.error)).toContain('escapes')
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('answers 404 for a file that is not there', async () => {
    const { config } = await fixtureRoot()
    const { ctx, routes, disposers } = fakeHost({ fetchImpl: permissionFetch() })
    try {
      apply(ctx as never, config as never)
      const reply = await callRoute(routes, 'extract.retry', { relPath: 'missing.docx' })
      expect(reply.status).toBe(404)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })
})

describe('mapping an extraction result to a queue state', () => {
  it('calls a written sibling a success and keeps the authority', () => {
    expect(extractionOutcomeOf({ markdown: 'a.docx.md', via: 'libreoffice' })).toEqual({
      state: 'succeeded',
      markdown: 'a.docx.md',
      via: 'libreoffice',
    })
  })

  it('calls a produced-but-unwritable sibling a failure with its reason', () => {
    // `markdown` set WITH `reason` means the text existed but the write was refused --
    // typically the sibling already exists. Reporting success would hide that.
    expect(extractionOutcomeOf({ markdown: 'a.docx.md', reason: 'a document already exists at a.docx.md' })).toEqual({
      state: 'failed',
      markdown: 'a.docx.md',
      reason: 'a document already exists at a.docx.md',
    })
  })

  it('calls an empty result a failure carrying the extractor reason', () => {
    expect(extractionOutcomeOf({ markdown: '', reason: 'no-extractor-succeeded: mineru,python,libreoffice' })).toEqual({
      state: 'failed',
      reason: 'no-extractor-succeeded: mineru,python,libreoffice',
    })
  })

  it('treats a format with no extractor at all as unsupported', () => {
    expect(extractionOutcomeOf(undefined)).toEqual({
      state: 'unsupported',
      reason: 'this file type has no extractor',
    })
  })
})

describe('the listing carries what an extract menu needs', () => {
  it('flags extractable files and those whose sibling already exists', async () => {
    const { config } = await fixtureRoot()
    const { ctx, routes, disposers } = fakeHost({ fetchImpl: permissionFetch() })
    try {
      apply(ctx as never, config as never)
      const actual = config.actualRoot as string
      // `mountPoint` is the tree the page reads, so the listing reads here.
      await writeFile(join(actual, 'report.docx'), 'bytes')
      await writeFile(join(actual, 'report.docx.md'), '# extracted')
      await writeFile(join(actual, 'pending.pdf'), '%PDF-1.4')
      await writeFile(join(actual, 'notes.md'), '# hand written')

      const reply = await callRoute(routes, 'list', { path: '' })
      expect(reply.status).toBe(200)
      const entries = reply.body.entries as Array<{
        name?: string
        canExtract?: boolean
        hasMarkdown?: boolean
      }>

      const byName = new Map(entries.map(entry => [entry.name, entry]))
      // A document whose sibling is already there: extractable, already extracted.
      expect(byName.get('report.docx')?.canExtract).toBe(true)
      expect(byName.get('report.docx')?.hasMarkdown).toBe(true)
      // A document with no sibling yet: the retry is meaningful.
      expect(byName.get('pending.pdf')?.canExtract).toBe(true)
      expect(byName.get('pending.pdf')?.hasMarkdown).toBe(false)
      // Markdown itself is not something to "extract".
      expect(byName.get('notes.md')?.canExtract).toBe(false)
      expect(byName.get('notes.md')?.hasMarkdown).toBe(false)
      // The sibling appears as its own row too, because it is a real file.
      expect(byName.has('report.docx.md')).toBe(true)
      // A paginator can take the page count from `total` without counting rows.
      expect(reply.body.total).toBe(entries.length)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })
})

describe('a waiting retry runs the document exactly once', () => {
  /**
   * The bug this pins: an earlier `wait:true` ran `extractBeside` inline AND enqueued a
   * second copy so the status surface would look current. One document, two parses --
   * and the route answered from one run while `extract.status` reported the other.
   *
   * The counter is the real MinerU request: every PDF extraction this deployment can do
   * goes through `/v1/file_parse`, so counting those requests counts parses, without
   * mocking the module under test.
   */
  it('sends exactly one parse for one retry, and reports the same outcome the status shows', async () => {
    const { config } = await fixtureRoot()
    let parses = 0
    const countingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: 'u-1', displayName: 'Tester' } }), { status: 200 })
      }
      if (url.includes('/resource-permissions/resolve')) {
        return new Response(JSON.stringify({ canRead: true, canWrite: true }), { status: 200 })
      }
      if (url.includes('/v1/file_parse')) {
        parses += 1
        // A 4.x synchronous result carrying the text inline, so the run succeeds and
        // the sibling is written.
        return new Response(JSON.stringify({
          status: 'completed',
          tier: 'basic',
          files: [{
            name: 'report.pdf',
            status: 'completed',
            content: { markdown: '# 提取出的正文\n\n这一段用于验证只解析了一次。' },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch

    const { ctx, routes, disposers } = fakeHost({ fetchImpl: countingFetch })
    try {
      apply(ctx as never, config as never)
      await writeFile(join(config.actualRoot as string, 'report.pdf'), '%PDF-1.4 fixture')

      const reply = await callRoute(routes, 'extract.retry', { relPath: 'report.pdf', wait: true }, 30_000)

      // One retry, one parse. Two would mean the inline run plus the enqueued copy.
      expect(parses).toBe(1)
      // The route reports the extraction, and the sibling really exists.
      expect(reply.body.outcome).toBe('extracted')
      expect(reply.body.markdown).toBe('report.pdf.md')
      await expect(readFile(join(config.actualRoot as string, 'report.pdf.md'), 'utf8'))
        .resolves.toContain('这一段用于验证只解析了一次')

      // And the status surface agrees with the answer: same path, terminal, succeeded.
      const status = await callRoute(routes, 'extract.status', {})
      const tasks = status.body.tasks as Array<{ relPath?: string; state?: string; markdown?: string }>
      const task = tasks.find(entry => entry.relPath === 'report.pdf')
      expect(task?.state).toBe('succeeded')
      expect(task?.markdown).toBe(reply.body.markdown)
      // Still exactly one parse after reading the status: status is a read, not a run.
      expect(parses).toBe(1)
    } finally {
      for (const dispose of disposers) dispose()
    }
  }, 40_000)

  it('joins an in-flight run instead of starting a second one', async () => {
    // The same protection on the other path: a retry for a document an upload is
    // already extracting must reuse that run, not add a parse.
    const { config } = await fixtureRoot()
    let parses = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slowFetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auth/me')) return new Response(JSON.stringify({ user: { id: 'u-1' } }), { status: 200 })
      if (url.includes('/resource-permissions/resolve')) {
        return new Response(JSON.stringify({ canRead: true, canWrite: true }), { status: 200 })
      }
      if (url.includes('/v1/file_parse')) {
        parses += 1
        await gate
        return new Response(JSON.stringify({
          status: 'completed',
          files: [{ name: 'x.pdf', status: 'completed', content: { markdown: '# 正文内容，足够长以通过检索下限测试。' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch

    const { ctx, routes, disposers } = fakeHost({ fetchImpl: slowFetch })
    try {
      apply(ctx as never, config as never)
      await writeFile(join(config.actualRoot as string, 'x.pdf'), '%PDF-1.4 fixture')
      // First retry queues and blocks on the gate; a second one must join it.
      const first = callRoute(routes, 'extract.retry', { relPath: 'x.pdf', wait: true }, 40_000)
      await eventually(async () => parses === 1)
      const second = callRoute(routes, 'extract.retry', { relPath: 'x.pdf', wait: true }, 40_000)
      await new Promise(resolve => setTimeout(resolve, 50))
      release?.()
      const [firstReply, secondReply] = await Promise.all([first, second])

      expect(parses).toBe(1)
      expect(firstReply.body.outcome).toBe('extracted')
      expect(secondReply.body.outcome).toBe('extracted')
    } finally {
      for (const dispose of disposers) dispose()
    }
  }, 50_000)
})
