import { describe, expect, it } from 'vitest'
import { createExtractionQueue, MAX_CONCURRENT_EXTRACTIONS } from '../src/extractionQueue.ts'

/** A runner whose runs are settled by the test, so interleaving is explicit. */
function controlledRunner() {
  const calls: Array<{ relPath: string; mineruBaseUrl: string | undefined; resolve: (state: 'succeeded' | 'failed' | 'unsupported', extra?: Record<string, unknown>) => void }> = []
  const run = (relPath: string, mineruBaseUrl: string | undefined) => new Promise<{
    state: 'succeeded' | 'failed' | 'unsupported'
    markdown?: string
    via?: string
    reason?: string
  }>((resolve) => {
    calls.push({
      relPath,
      mineruBaseUrl,
      resolve: (state, extra) => { resolve({ state, ...(extra ?? {}) }) },
    })
  })
  return { calls, run }
}

/** Let queued microtasks run so the worker can pick up the next item. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('the extraction queue', () => {
  it('runs one extraction at a time', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({
      run: runner.run,
      isExtractable: () => true,
      isAlreadyMarkdown: () => false,
    })

    queue.enqueue('a.docx')
    queue.enqueue('b.docx')
    await settle()

    // Exactly one run is in flight: the second is waiting, not racing it.
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.relPath).toBe('a.docx')
    expect(queue.get('b.docx')?.state).toBe('pending')
    expect(MAX_CONCURRENT_EXTRACTIONS).toBe(1)

    runner.calls[0]!.resolve('succeeded', { markdown: 'a.docx.md', via: 'libreoffice' })
    await settle()

    expect(runner.calls).toHaveLength(2)
    expect(runner.calls[1]!.relPath).toBe('b.docx')
    runner.calls[1]!.resolve('succeeded', { markdown: 'b.docx.md' })
    await queue.drain()
  })

  it('moves a task through pending, running, then succeeded', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({ run: runner.run, isExtractable: () => true,
      isAlreadyMarkdown: () => false })

    const accepted = queue.enqueue('report.pdf')
    // The upload that enqueued it has already answered; this is what it reports.
    expect(accepted.state).toBe('pending')

    await settle()
    expect(queue.get('report.pdf')?.state).toBe('running')

    runner.calls[0]!.resolve('succeeded', { markdown: 'report.pdf.md', via: 'mineru' })
    await queue.drain()

    const done = queue.get('report.pdf')
    expect(done?.state).toBe('succeeded')
    expect(done?.markdown).toBe('report.pdf.md')
    expect(done?.via).toBe('mineru')
    expect(done?.finishedAt).toBeDefined()
  })

  it('records the extractor reason when a run fails', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({ run: runner.run, isExtractable: () => true,
      isAlreadyMarkdown: () => false })

    queue.enqueue('scan.pdf')
    await settle()
    runner.calls[0]!.resolve('failed', { reason: 'no-extractor-succeeded: mineru,python,libreoffice' })
    await queue.drain()

    const task = queue.get('scan.pdf')
    expect(task?.state).toBe('failed')
    expect(task?.reason).toBe('no-extractor-succeeded: mineru,python,libreoffice')
  })

  it('answers an unsupported type immediately instead of spending the worker', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({ run: runner.run, isExtractable: () => false,
      isAlreadyMarkdown: () => false })

    // `.zip` is the shape this branch is about: a format no extractor exists for. It used
    // to be tested with `.md`, which is wrong now that Markdown is recognised as needing no
    // extraction at all -- `.md` has its own successful outcome, not this failure.
    const task = queue.enqueue('archive.zip')
    expect(task.state).toBe('unsupported')
    expect(task.reason).toContain('no extractor')
    await settle()
    // Nothing was scheduled, so the single slot stayed free.
    expect(runner.calls).toHaveLength(0)
  })

  it('joins a duplicate instead of spending two parses on one document', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({ run: runner.run, isExtractable: () => true,
      isAlreadyMarkdown: () => false })

    const first = queue.enqueue('report.pdf')
    const second = queue.enqueue('report.pdf')

    expect(second.queuedAt).toBe(first.queuedAt)
    await settle()
    expect(runner.calls).toHaveLength(1)

    runner.calls[0]!.resolve('succeeded', { markdown: 'report.pdf.md' })
    await queue.drain()
    expect(runner.calls).toHaveLength(1)
    expect(queue.get('report.pdf')?.state).toBe('succeeded')
  })

  it('survives a runner that throws, recording it as a failed extraction', async () => {
    const queue = createExtractionQueue({
      run: async () => { throw new Error('spawn soffice ENOENT') },
      isExtractable: () => true,
      isAlreadyMarkdown: () => false,
    })

    queue.enqueue('legacy.doc')
    await queue.drain()

    const task = queue.get('legacy.doc')
    expect(task?.state).toBe('failed')
    expect(task?.reason).toContain('spawn soffice ENOENT')
  })

  it('reports what is running and what is waiting', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({ run: runner.run, isExtractable: () => true,
      isAlreadyMarkdown: () => false })

    expect(queue.snapshot()).toEqual({ running: undefined, size: 0, tasks: [] })

    queue.enqueue('a.docx')
    queue.enqueue('b.docx')
    await settle()

    const busy = queue.snapshot()
    expect(busy.running).toBe('a.docx')
    // One running plus one waiting. The second has not reached the runner, because
    // this queue serializes: it is `pending`, not `running`.
    expect(busy.size).toBe(2)
    expect(busy.tasks.map(task => task.relPath)).toEqual(['a.docx', 'b.docx'])
    expect(queue.get('b.docx')?.state).toBe('pending')

    runner.calls[0]!.resolve('succeeded', { markdown: 'a.docx.md' })
    await settle()
    runner.calls[1]!.resolve('succeeded', { markdown: 'b.docx.md' })
    await queue.drain()
    expect(queue.snapshot().running).toBeUndefined()
  })

  it('passes the caller address through to the runner', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({ run: runner.run, isExtractable: () => true,
      isAlreadyMarkdown: () => false })

    queue.enqueue('report.pdf', 'http://mineru.internal:8000')
    await settle()

    expect(runner.calls[0]!.mineruBaseUrl).toBe('http://mineru.internal:8000')
    runner.calls[0]!.resolve('succeeded', { markdown: 'report.pdf.md' })
    await queue.drain()
  })

  it('resolves drain immediately on an idle queue', async () => {
    const queue = createExtractionQueue({ run: async () => ({ state: 'succeeded' }), isExtractable: () => true,
      isAlreadyMarkdown: () => false })
    await expect(queue.drain()).resolves.toBeUndefined()
  })
})

describe('the extraction queue tells Markdown apart from an unsupported format', () => {
  /**
   * 用户报的缺陷：`.md` 文件显示「该文件类型无解析器」。`.md` 本身就是 Markdown，
   * 需要的是「无需提取」这个成功结论，而不是「没有解析器」这个失败结论。
   *
   * 直接测队列而不是只测辅助函数：状态是由 `enqueue` 决定的，缺陷也在那一行。
   */
  it('resolves a Markdown document immediately, without occupying the worker', async () => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({
      run: runner.run,
      isExtractable: () => false,
      isAlreadyMarkdown: path => path.endsWith('.md'),
    })

    const task = queue.enqueue('notes.md')
    expect(task.state).toBe('already-markdown')
    // 不是失败：没有原因可报，也没有解析器被请求。
    expect(task.reason).toBeUndefined()
    await settle()
    // 关键：它不占 running 槽位，队列里真正需要解析的任务照常进行。
    expect(runner.calls).toHaveLength(0)
  })

  it('still reports a genuinely unsupported format as unsupported', async () => {
    // 这条防的是"把所有文本类型都当成 Markdown"的过度修正。
    const runner = controlledRunner()
    const queue = createExtractionQueue({
      run: runner.run,
      isExtractable: () => false,
      isAlreadyMarkdown: path => path.endsWith('.md'),
    })

    const task = queue.enqueue('archive.zip')
    expect(task.state).toBe('unsupported')
    expect(task.reason).toContain('no extractor')
  })

  it('does not block a real extraction behind a Markdown one', async () => {
    // 真实队列里两者混排：Markdown 立即终结，pdf 仍然被调度。
    const runner = controlledRunner()
    const queue = createExtractionQueue({
      run: runner.run,
      isExtractable: path => path.endsWith('.pdf'),
      isAlreadyMarkdown: path => path.endsWith('.md'),
    })

    const md = queue.enqueue('a.md')
    const pdf = queue.enqueue('b.pdf')
    expect(md.state).toBe('already-markdown')
    expect(pdf.state).toBe('pending')
    await settle()
    expect(runner.calls.map(call => call.relPath)).toEqual(['b.pdf'])
  })
})

describe('a failed task always explains itself', () => {
  /**
   * 用户截图上出现过「失败：」——冒号后面什么都没有。那比没有提示更糟：读者既不知道
   * 发生了什么，也不知道该不该重试。任何 `failed` 都必须带非空文本。
   *
   * 三种会走到兜底的输入都被钉住：抛出的 Error、抛出的空 message Error、抛出的非
   * Error 值。最后一种最容易漏（`String(error)` 可能是空串）。
   */
  const failWith = async (thrown: unknown): Promise<string | undefined> => {
    const runner = controlledRunner()
    const queue = createExtractionQueue({
      run: async () => { throw thrown },
      isExtractable: () => true,
      isAlreadyMarkdown: () => false,
    })
    queue.enqueue('x.pdf')
    await queue.drain()
    return queue.get('x.pdf')?.reason
  }

  it('carries the exception message when there is one', async () => {
    const reason = await failWith(new Error('mineru is unreachable'))
    expect(reason).toBe('mineru is unreachable')
  })

  it('never leaves the reason blank for an error with no message', async () => {
    // 这正是截图里那一幕的来源：一个 message 为空的 Error。
    const reason = await failWith(new Error(''))
    expect(reason).toBeDefined()
    expect(reason?.trim()).not.toBe('')
  })

  it('never leaves the reason blank for a thrown non-Error', async () => {
    // `String(undefined)` 是 'undefined'，但 `String('')` 是空串。
    const reason = await failWith('')
    expect(reason).toBeDefined()
    expect(reason?.trim()).not.toBe('')
  })

  it('gives every failure a reason, whatever was thrown', async () => {
    // 一组真实会出现的抛出物，逐个断言非空。
    const thrown = [new Error('boom'), new Error(''), '', undefined, null, 42, { code: 'X' }]
    for (const value of thrown) {
      const reason = await failWith(value)
      expect(reason, 'thrown: ' + String(value)).toBeDefined()
      expect(reason?.trim(), 'thrown: ' + String(value)).not.toBe('')
    }
  })
})

describe('extraction progress steps', () => {
  it('reports parse → chunk → index → done and keeps a failure reason', async () => {
    let reportStep: ((step: 'parse' | 'chunk' | 'index' | 'done') => void) | undefined
    let resolveRun: ((value: { state: 'succeeded'; markdown: string }) => void) | undefined
    const queue = createExtractionQueue({
      run: (_relPath, _url, report) => {
        reportStep = report
        return new Promise(resolve => { resolveRun = resolve })
      },
      isExtractable: () => true,
      isAlreadyMarkdown: () => false,
    })
    queue.enqueue('a.pdf')
    await settle()
    expect(queue.get('a.pdf')).toMatchObject({ state: 'running', step: 'parse' })
    reportStep?.('chunk')
    expect(queue.get('a.pdf')?.step).toBe('chunk')
    reportStep?.('index')
    expect(queue.get('a.pdf')?.step).toBe('index')
    resolveRun?.({ state: 'succeeded', markdown: 'a.pdf.md' })
    await settle()
    expect(queue.get('a.pdf')).toMatchObject({ state: 'succeeded', step: 'done' })
  })
})
