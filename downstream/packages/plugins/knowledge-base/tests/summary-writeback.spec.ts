import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncIndex } from '../src/ftsIndex.ts'
import {
  applySummaryWriteback,
  summarySnapshotPathFor,
} from '../src/summaryWriteback.ts'

const bases: string[] = []

interface Fixture {
  base: string
  root: string
  indexPath: string
}

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'kb-summary-writeback-'))
  bases.push(base)
  const root = join(base, 'tree')
  const indexPath = join(base, 'index', 'kb.sqlite')
  await mkdir(root, { recursive: true })
  return { base, root, indexPath }
}

async function write(root: string, relPath: string, content: string): Promise<void> {
  const absolute = join(root, relPath)
  await mkdir(join(absolute, '..'), { recursive: true })
  await writeFile(absolute, content, 'utf8')
}

interface DocRow {
  id: number
  path: string
  summary: string | null
  summary_kind: string | null
  summary_version: string | null
}

function rows(indexPath: string): DocRow[] {
  const db = new DatabaseSync(indexPath)
  try {
    return db.prepare('SELECT id, path, summary, summary_kind, summary_version FROM kb_docs ORDER BY path')
      .all() as unknown as DocRow[]
  } finally {
    db.close()
  }
}

function rowFor(indexPath: string, relPath: string): DocRow | undefined {
  return rows(indexPath).find(row => row.path === relPath)
}

function indexFileFor(indexPath: string, docId: number): string {
  return join(dirname(indexPath), 'md', `${String(docId)}.INDEX.md`)
}

const DOC_ONE = '# 采购制度\n\n本制度适用于公司采购活动。采购金额超过三万元的，应当报总经理批准。\n'
const DOC_TWO = '# 报销制度\n\n报销应当提供发票。财务部负责审核报销单据。\n'
const DOC_THREE = '# 合同制度\n\n合同必须经过法务审核。合同金额超过一百万元的，应当报董事会批准。\n'
const DOC_NEW = '# 用印制度\n\n用印必须登记。综合管理部负责保管印章。\n'

async function seed(root: string, indexPath: string, documents: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(documents)) await write(root, relPath, content)
  const stats = await syncIndex({ actualRoot: root, indexPath })
  expect(stats.docs).toBe(Object.keys(documents).length)
}

afterEach(async () => {
  await Promise.all(bases.splice(0).map(base => rm(base, { recursive: true, force: true })))
})

describe('applySummaryWriteback', () => {
  it('backfills extractive summaries, regenerates existing INDEX.md files and writes the snapshot', async () => {
    const { root, indexPath } = await fixture()
    await seed(root, indexPath, {
      'docs/one.md': DOC_ONE,
      'docs/two.md': DOC_TWO,
      'docs/three.md': DOC_THREE,
    })

    const result = await applySummaryWriteback({ root, indexPath })

    expect(result.updated).toEqual(['docs/one.md', 'docs/three.md', 'docs/two.md'])
    expect(result.removed).toEqual([])
    expect(result.pending).toEqual([])
    expect(result.preserved).toEqual([])
    expect(result.snapshotPath).toBe(summarySnapshotPathFor(indexPath))
    expect(result.snapshotWritten).toBe(true)

    const all = rows(indexPath)
    for (const row of all) {
      expect(row.summary).toContain('文档主题')
      expect(row.summary_kind).toBe('extractive')
      expect(row.summary_version).toMatch(/^summary-v2:structure-v3-keyed:[0-9a-f]{12}$/u)
    }

    // The pre-existing INDEX.md is rewritten with the new summary and the extractive wording.
    expect(result.indexFiles).toHaveLength(3)
    const one = all.find(row => row.path === 'docs/one.md')
    expect(one).toBeDefined()
    const indexMarkdown = await readFile(indexFileFor(indexPath, one!.id), 'utf8')
    expect(indexMarkdown).toContain('摘要从原文结构抽取')
    expect(indexMarkdown).toContain(one!.summary as string)

    const snapshot = JSON.parse(await readFile(result.snapshotPath, 'utf8')) as { files: Record<string, unknown> }
    expect(Object.keys(snapshot.files)).toEqual(['docs/one.md', 'docs/three.md', 'docs/two.md'])
    const indexEntries = await readdir(join(dirname(indexPath), 'md'))
    expect(indexEntries.some(entry => entry.endsWith('.tmp'))).toBe(false)
  })

  it('is idempotent: a second pass with an unchanged tree does no work', async () => {
    const { root, indexPath } = await fixture()
    await seed(root, indexPath, { 'docs/one.md': DOC_ONE, 'docs/two.md': DOC_TWO })

    await applySummaryWriteback({ root, indexPath })
    const summarize = vi.fn(async () => 'not used')
    const second = await applySummaryWriteback({ root, indexPath, summarize })

    expect(summarize).not.toHaveBeenCalled()
    expect(second).toMatchObject({
      updated: [],
      removed: [],
      pending: [],
      preserved: [],
      indexFiles: [],
      snapshotWritten: false,
    })
  })

  it('summarises only the changed and added documents', async () => {
    const { root, indexPath } = await fixture()
    await seed(root, indexPath, {
      'docs/one.md': DOC_ONE,
      'docs/two.md': DOC_TWO,
      'docs/three.md': DOC_THREE,
    })
    await applySummaryWriteback({ root, indexPath })
    const before = new Map(rows(indexPath).map(row => [row.path, row.summary]))

    await write(root, 'docs/one.md', '# 采购制度（修订）\n\n本制度适用于全部采购活动。采购金额超过五万元的，应当报总经理批准。\n')
    await write(root, 'docs/four.md', DOC_NEW)
    // The normal wiring order: index first, then summaries.
    await syncIndex({ actualRoot: root, indexPath })

    const summarize = vi.fn(async (relPath: string, source: string) => `模型摘要：${relPath}（${String(source.length)} 字）`)
    const result = await applySummaryWriteback({ root, indexPath, summarize })

    expect(summarize.mock.calls.map(([relPath]) => relPath)).toEqual(['docs/four.md', 'docs/one.md'])
    expect(result.updated).toEqual(['docs/four.md', 'docs/one.md'])
    expect(rowFor(indexPath, 'docs/one.md')?.summary).toMatch(/^模型摘要：docs\/one\.md/u)
    expect(rowFor(indexPath, 'docs/four.md')?.summary).toMatch(/^模型摘要：docs\/four\.md/u)
    // Untouched documents kept their previous summary.
    expect(rowFor(indexPath, 'docs/two.md')?.summary).toBe(before.get('docs/two.md'))
    expect(rowFor(indexPath, 'docs/three.md')?.summary).toBe(before.get('docs/three.md'))

    const one = rowFor(indexPath, 'docs/one.md')!
    expect(await readFile(indexFileFor(indexPath, one.id), 'utf8')).toContain('模型摘要：docs/one.md')
  })

  it('clears the summary of a removed document', async () => {
    const { root, indexPath } = await fixture()
    await seed(root, indexPath, { 'docs/one.md': DOC_ONE, 'docs/two.md': DOC_TWO })
    await applySummaryWriteback({ root, indexPath })
    const oneBefore = rowFor(indexPath, 'docs/one.md')
    expect(rowFor(indexPath, 'docs/two.md')?.summary).toContain('文档主题')

    await unlink(join(root, 'docs/two.md'))
    const summarize = vi.fn(async () => 'not used')
    const result = await applySummaryWriteback({ root, indexPath, summarize })

    expect(summarize).not.toHaveBeenCalled()
    expect(result.updated).toEqual([])
    expect(result.removed).toEqual(['docs/two.md'])
    // This pass runs without syncIndex, so the row still exists — and is cleared.
    const twoAfter = rowFor(indexPath, 'docs/two.md')
    expect(twoAfter).toBeDefined()
    expect(twoAfter?.summary).toBeNull()
    expect(twoAfter?.summary_kind).toBe('none')
    expect(twoAfter?.summary_version).toBeNull()
    // The surviving document is untouched.
    expect(rowFor(indexPath, 'docs/one.md')?.summary).toBe(oneBefore?.summary)
  })

  it('leaves unindexed changes pending and out of the snapshot until syncIndex catches up', async () => {
    const { root, indexPath } = await fixture()
    await seed(root, indexPath, { 'docs/one.md': DOC_ONE })
    await applySummaryWriteback({ root, indexPath })

    await write(root, 'docs/new.md', DOC_NEW)
    const pendingResult = await applySummaryWriteback({ root, indexPath })
    expect(pendingResult.pending).toEqual(['docs/new.md'])
    expect(pendingResult.updated).toEqual([])
    expect(rowFor(indexPath, 'docs/new.md')).toBeUndefined()
    const pendingSnapshot = JSON.parse(await readFile(pendingResult.snapshotPath, 'utf8')) as { files: Record<string, unknown> }
    expect(Object.keys(pendingSnapshot.files)).toEqual(['docs/one.md'])

    await syncIndex({ actualRoot: root, indexPath })
    const caughtUp = await applySummaryWriteback({ root, indexPath })
    expect(caughtUp.updated).toEqual(['docs/new.md'])
    expect(caughtUp.pending).toEqual([])
    expect(rowFor(indexPath, 'docs/new.md')?.summary_kind).toBe('extractive')
    const caughtUpSnapshot = JSON.parse(await readFile(caughtUp.snapshotPath, 'utf8')) as { files: Record<string, unknown> }
    expect(Object.keys(caughtUpSnapshot.files)).toEqual(['docs/new.md', 'docs/one.md'])
  })

  it('does not advance the snapshot when a write fails', async () => {
    const { root, indexPath } = await fixture()
    await seed(root, indexPath, { 'docs/one.md': DOC_ONE })
    const baseline = await applySummaryWriteback({ root, indexPath })
    const snapshotBefore = await readFile(baseline.snapshotPath, 'utf8')

    await write(root, 'docs/one.md', '# 采购制度（修订）\n\n本制度适用于全部采购活动。采购金额超过五万元的，应当报总经理批准。\n')
    await syncIndex({ actualRoot: root, indexPath })

    const failing = vi.fn(async () => {
      throw new Error('summarizer exploded')
    })
    await expect(applySummaryWriteback({ root, indexPath, summarize: failing })).rejects.toThrow('summarizer exploded')

    expect(await readFile(baseline.snapshotPath, 'utf8')).toBe(snapshotBefore)
    const afterFailure = rowFor(indexPath, 'docs/one.md')
    expect(afterFailure?.summary_kind).toBe('none')
    expect(afterFailure?.summary).toBe('')

    const retried = await applySummaryWriteback({ root, indexPath })
    expect(retried.updated).toEqual(['docs/one.md'])
    expect(retried.snapshotWritten).toBe(true)
    expect(rowFor(indexPath, 'docs/one.md')?.summary_kind).toBe('extractive')
  })

  it('never downgrades a model-authored summary', async () => {
    const { root, indexPath } = await fixture()
    await seed(root, indexPath, { 'docs/one.md': DOC_ONE, 'docs/two.md': DOC_TWO })

    const db = new DatabaseSync(indexPath)
    try {
      db.prepare("UPDATE kb_docs SET summary = 'LLM 摘要', summary_kind = 'llm', summary_version = 'llm-v1' WHERE path = 'docs/one.md'").run()
    } finally {
      db.close()
    }

    const result = await applySummaryWriteback({ root, indexPath })

    expect(result.preserved).toEqual(['docs/one.md'])
    expect(result.updated).toEqual(['docs/two.md'])
    expect(rowFor(indexPath, 'docs/one.md')).toMatchObject({
      summary: 'LLM 摘要',
      summary_kind: 'llm',
      summary_version: 'llm-v1',
    })
  })
})
