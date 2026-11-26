import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ensureDocumentOutline,
  outlineFilePath,
  readDocumentOutline,
  searchIndex,
  syncIndex,
} from '../src/ftsIndex.ts'

const roots: string[] = []
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-outline-'))
  roots.push(root)
  const actual = join(root, 'actual')
  const indexDir = join(root, 'index')
  await mkdir(join(actual, 'global'), { recursive: true })
  return { root, actual, indexDir, indexPath: join(indexDir, 'kb-index.sqlite') }
}

const caller = { callerId: 'u1', departmentCodes: [] as string[], global: true }
const canRead = async () => true

const BOARD = [
  '# 董事会议事规则',
  '',
  '第一章 总则',
  '',
  '第一条 为规范董事会运作，制定本规则。',
  '',
  '第二条 本规则适用于公司董事会及全体董事。',
  '',
  '第二章 表决',
  '',
  '第三条 董事会决议分为普通决议和特别决议。',
  '',
  '第四条 普通决议应当经全体董事过半数同意。',
  '',
  '第五条 特别决议应当经全体董事三分之二以上同意；关联董事应当回避。',
  '',
  '第六条 本章程未尽事宜，依照法律法规处理。',
  '',
].join('\n')

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

const prepare = async () => {
  const fixtureValue = await fixture()
  await writeFile(join(fixtureValue.actual, 'global/board.md'), BOARD)
  await syncIndex({ actualRoot: fixtureValue.actual, indexPath: fixtureValue.indexPath, autoGenerateSummaries: true })
  const db = new DatabaseSync(fixtureValue.indexPath)
  const doc = db.prepare('SELECT id FROM kb_docs WHERE path = ?').get('global/board.md') as { id: number }
  db.close()
  return { ...fixtureValue, docId: doc.id }
}

describe('document outline (INDEX.md + kb_sections)', () => {
  it('generates INDEX.md with a document summary, TOC, chapter summaries and key facts', async () => {
    const { indexPath, indexDir, docId } = await prepare()
    const db = new DatabaseSync(indexPath)
    const doc = db.prepare('SELECT summary, toc_json, summary_version FROM kb_docs WHERE id = ?')
      .get(docId) as { summary: string; toc_json: string; summary_version: string }
    db.close()
    expect(doc.summary).toContain('董事会议事规则')
    expect(doc.summary).toContain('章节包括')
    expect(doc.summary_version).toMatch(/^summary-v2:structure-v3-keyed:/u)
    const toc = JSON.parse(doc.toc_json) as Array<{ title: string; level: number }>
    expect(toc.map(entry => entry.title)).toEqual(expect.arrayContaining(['第一章 总则', '第二章 表决', '第一条', '第五条']))

    const target = outlineFilePath(indexPath, docId)
    expect(target).toBe(join(indexDir, 'md', `${String(docId)}.INDEX.md`))
    const markdown = await readFile(target, 'utf8')
    expect(markdown).toContain('## 文档摘要')
    expect(markdown).toContain('## 目录')
    expect(markdown).toContain('## 章节摘要')
    expect(markdown).toContain('第二章 表决')
    expect(markdown).toContain('三分之二')
    expect(markdown).toContain('**关键事实**')
    expect(markdown).toContain('来源 chunk')
    expect(markdown).toContain(`kb://doc/${String(docId)}/chunk/`)
    // The generated file never lives in the source tree.
    expect(markdown).not.toContain('global/board.md.INDEX.md')
  })

  it('stores a section per heading with an extractive summary and source chunk ids', async () => {
    const { indexPath, docId } = await prepare()
    const outline = await readDocumentOutline({ indexPath, docId })
    expect(outline).toBeDefined()
    expect(outline?.summary).toContain('董事会议事规则')
    expect(outline?.sourceChunkIds.length).toBeGreaterThan(0)
    const chapter = outline?.sections.find(section => section.title === '第二章 表决')
    expect(chapter).toMatchObject({ level: 1 })
    expect(chapter?.summary).toContain('三分之二')
    expect(chapter?.sourceChunkIds.length).toBeGreaterThanOrEqual(4)
    expect(chapter?.keyFacts.some(fact => fact.value.includes('三分之二'))).toBe(true)
    const article = outline?.sections.find(section => section.title === '第五条')
    expect(article).toMatchObject({
      level: 2,
      headingPath: '第二章 表决 > 第五条',
    })
    expect(article?.summary).toContain('关联董事应当回避')
    expect(article?.chunkIds.length).toBe(1)
    expect(article?.sourceChunkIds).toEqual(article?.chunkIds)
    const tocArticle = outline?.toc.find(entry => entry.sectionId === article?.sectionId)
    expect(tocArticle).toMatchObject({ title: '第五条', level: 2, chunkIds: article?.chunkIds })

    // Extraction, not generation: every summary sentence and key fact exists in a source chunk.
    const db = new DatabaseSync(indexPath)
    const contents = (db.prepare('SELECT content FROM kb_chunks WHERE doc_id = ?').all(docId) as Array<{ content: string }>)
      .map(row => row.content).join('\n')
    db.close()
    for (const section of outline?.sections ?? []) {
      for (const fact of section.keyFacts) expect(contents).toContain(fact.value.replace(/…$/u, ''))
    }
    expect(contents).toContain('第五条 特别决议应当经全体董事三分之二以上同意；关联董事应当回避。')
  })

  it('builds a chapter/section/article hierarchy in the TOC', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/hierarchy.md'), [
      '# 分级规则',
      '',
      '第一章 总则',
      '',
      '第一节 决策机构',
      '',
      '第一条 董事会负责本规则的执行。',
      '',
      '第二条 经营班子负责日常经营。',
      '',
    ].join('\n'))
    await syncIndex({ actualRoot: actual, indexPath, autoGenerateSummaries: true })
    const db = new DatabaseSync(indexPath)
    const docId = (db.prepare('SELECT id FROM kb_docs WHERE path = ?').get('global/hierarchy.md') as { id: number }).id
    db.close()
    const outline = await readDocumentOutline({ indexPath, docId })
    const byTitle = new Map(outline?.sections.map(section => [section.title, section]))
    expect(byTitle.get('第一章 总则')?.level).toBe(1)
    expect(byTitle.get('第一节 决策机构')?.level).toBe(2)
    expect(byTitle.get('第一条')?.level).toBe(3)
    expect(byTitle.get('第一条')?.headingPath).toBe('第一章 总则 > 第一节 决策机构 > 第一条')
    expect(byTitle.get('第一章 总则')?.sourceChunkIds.length).toBeGreaterThanOrEqual(2)
    expect(byTitle.get('第一章 总则')?.keyFacts.some(fact => fact.value.includes('董事会负责'))).toBe(true)
  })

  it('scopes summary FTS matches by caller identity', async () => {
    const { actual, indexPath } = await fixture()
    await mkdir(join(actual, 'personal/u2'), { recursive: true })
    await writeFile(join(actual, 'personal/u2/secret.md'), [
      '# 机密规则',
      '',
      '第一章 机密',
      '',
      '第一条 机密门槛为三分之二。',
      '',
    ].join('\n'))
    await syncIndex({ actualRoot: actual, indexPath, autoGenerateSummaries: true })
    const other = await searchIndex({
      indexPath,
      query: '三分之二',
      topK: 5,
      caller: { callerId: 'u1', departmentCodes: [], global: false },
      canRead,
    })
    expect(other.hits).toHaveLength(0)
    expect(other.relatedSections ?? []).toHaveLength(0)
    const owner = await searchIndex({
      indexPath,
      query: '三分之二',
      topK: 5,
      caller: { callerId: 'u2', departmentCodes: [], global: false },
      canRead,
    })
    expect(owner.hits.some(hit => hit.path === 'personal/u2/secret.md')).toBe(true)
    expect(owner.relatedSections?.some(section => section.path === 'personal/u2/secret.md')).toBe(true)
  })

  it('rebuilds the outline when the source hash changes', async () => {
    const { actual, indexPath, docId } = await prepare()
    const first = (await readDocumentOutline({ indexPath, docId }))?.summaryVersion
    await writeFile(join(actual, 'global/board.md'), BOARD.replace('第六条 本章程未尽事宜，依照法律法规处理。', '第六条 附件费用不得超过十万元。'))
    const stats = await syncIndex({ actualRoot: actual, indexPath, autoGenerateSummaries: true })
    expect(stats.indexed).toBe(1)
    const rebuilt = await readDocumentOutline({ indexPath, docId })
    expect(rebuilt?.summaryVersion).not.toBe(first)
    expect(rebuilt?.sections.some(section => section.keyFacts.some(fact => fact.value.includes('十万元')))).toBe(true)
  })

  it('indexes summary chunks in FTS and returns them as navigation-only related sections', async () => {
    const { indexPath } = await prepare()
    // "章节摘要" exists only in the summary index, never in an original chunk.
    const result = await searchIndex({ indexPath, query: '章节摘要', topK: 5, caller, canRead })
    expect(result.hits).toHaveLength(0)
    expect(result.relatedSections?.length).toBeGreaterThan(0)
    expect(result.relatedSections?.some(section => section.sectionPath === '第二章 表决')).toBe(true)
    for (const section of result.relatedSections ?? []) {
      expect(section).not.toHaveProperty('citation')
      expect(section.path).toBe('global/board.md')
      expect(section.sourceChunkIds.length).toBeGreaterThan(0)
      expect(section.summary).not.toBe('')
    }

    // A multi-term comparison question relaxes to per-token summary recall too.
    const comparison = await searchIndex({
      indexPath,
      query: '董事会 表决 三分之二',
      topK: 5,
      caller,
      canRead,
    })
    expect(comparison.relatedSections?.some(section => section.sectionPath === '第二章 表决')).toBe(true)
    expect(comparison.hits.length).toBeGreaterThan(0)
  })

  it('adds sectionId/sectionPath/sectionSummary/docSummary to search hits', async () => {
    const { indexPath } = await prepare()
    const result = await searchIndex({ indexPath, query: '三分之二', topK: 5, caller, canRead })
    const hit = result.hits.find(candidate => candidate.path === 'global/board.md')
    expect(hit).toBeDefined()
    expect(hit?.sectionPath).toBe('第二章 表决 > 第五条')
    expect(hit?.sectionId).toMatch(/^s\d+-\d+$/u)
    expect(hit?.sectionLevel).toBe(2)
    expect(hit?.sectionSummary).toContain('关联董事应当回避')
    expect(hit?.docSummary).toContain('董事会议事规则')
    // The citation token contract is untouched.
    expect(hit?.citation).toMatch(/^kb:\/\/doc\/\d+\/chunk\/[0-9a-f-]+(?:\?.*)?$/u)
  })

  it('rebuilds a legacy outline in place without replacing chunk ids', async () => {
    const { indexPath, docId } = await prepare()
    const db = new DatabaseSync(indexPath)
    const before = db.prepare('SELECT id, chunk_key FROM kb_chunks WHERE doc_id = ? ORDER BY id').all(docId) as Array<{ id: number; chunk_key: string }>
    db.exec('DELETE FROM kb_summary_fts')
    db.prepare('DELETE FROM kb_summary_chunks WHERE doc_id = ?').run(docId)
    db.prepare('DELETE FROM kb_sections WHERE doc_id = ?').run(docId)
    db.prepare('UPDATE kb_docs SET summary = NULL, toc_json = NULL, summary_version = NULL WHERE id = ?').run(docId)
    db.close()

    const legacy = await searchIndex({ indexPath, query: '三分之二', topK: 5, caller, canRead })
    const legacyHit = legacy.hits.find(candidate => candidate.path === 'global/board.md')
    expect(legacyHit).toBeDefined()
    expect(legacyHit).not.toHaveProperty('sectionPath')
    expect(legacyHit).not.toHaveProperty('docSummary')
    expect(legacy.relatedSections).toBeUndefined()

    const rebuilt = await ensureDocumentOutline({ indexPath, docId, autoGenerate: true })
    expect(rebuilt?.summary).toContain('董事会议事规则')
    expect(rebuilt?.sections.length).toBeGreaterThan(0)

    const dbAfter = new DatabaseSync(indexPath)
    const after = dbAfter.prepare('SELECT id, chunk_key FROM kb_chunks WHERE doc_id = ? ORDER BY id').all(docId) as Array<{ id: number; chunk_key: string }>
    dbAfter.close()
    expect(after).toEqual(before)

    const decorated = await searchIndex({ indexPath, query: '三分之二', topK: 5, caller, canRead })
    expect(decorated.hits.find(candidate => candidate.path === 'global/board.md')?.sectionPath).toBe('第二章 表决 > 第五条')
  })

  it('upgrades an old index on the next sync without re-chunking', async () => {
    const { actual, indexPath, docId } = await prepare()
    const db = new DatabaseSync(indexPath)
    const before = db.prepare('SELECT id, chunk_key FROM kb_chunks WHERE doc_id = ? ORDER BY id').all(docId) as Array<{ id: number; chunk_key: string }>
    db.exec('DELETE FROM kb_summary_fts')
    db.prepare('DELETE FROM kb_summary_chunks WHERE doc_id = ?').run(docId)
    db.prepare('DELETE FROM kb_sections WHERE doc_id = ?').run(docId)
    db.prepare('UPDATE kb_docs SET summary = NULL, toc_json = NULL, summary_version = NULL WHERE id = ?').run(docId)
    db.close()

    const stats = await syncIndex({ actualRoot: actual, indexPath, autoGenerateSummaries: true })
    expect(stats.indexed).toBe(0)
    expect(stats.unchanged).toBe(1)
    const dbAfter = new DatabaseSync(indexPath)
    const after = dbAfter.prepare('SELECT id, chunk_key FROM kb_chunks WHERE doc_id = ? ORDER BY id').all(docId) as Array<{ id: number; chunk_key: string }>
    const summaryVersion = (dbAfter.prepare('SELECT summary_version FROM kb_docs WHERE id = ?').get(docId) as { summary_version: string }).summary_version
    dbAfter.close()
    expect(after).toEqual(before)
    expect(summaryVersion).toMatch(/^summary-v2:/u)
    const outline = await readDocumentOutline({ indexPath, docId })
    expect(outline?.sections.length).toBeGreaterThan(0)
  })

  it('leaves an index with no chunks searchable and returns an empty outline', async () => {
    const { actual, indexPath, docId } = await prepare()
    // A document whose derived text is empty still has a row but no chunks.
    await writeFile(join(actual, 'global/empty.md'), '')
    const stats = await syncIndex({ actualRoot: actual, indexPath, autoGenerateSummaries: true })
    expect(stats.docs).toBe(2)
    const db = new DatabaseSync(indexPath)
    const emptyDoc = db.prepare('SELECT id FROM kb_docs WHERE path = ?').get('global/empty.md') as { id: number }
    db.close()
    const empty = await readDocumentOutline({ indexPath, docId: emptyDoc.id })
    expect(empty?.summary).toContain('全文约 0 字')
    expect(empty?.sections).toEqual([])
    const result = await searchIndex({ indexPath, query: '三分之二', topK: 5, caller, canRead })
    expect(result.hits.length).toBeGreaterThan(0)
  })

  it('summarizes doc49 by chapter instead of copying its first article', async () => {
    const fixtureValue = await fixture()
    const source = await readFile(new URL('./fixtures/doc49.md', import.meta.url), 'utf8')
    await mkdir(join(fixtureValue.actual, 'global/rag-eval-fixtures'), { recursive: true })
    await writeFile(join(fixtureValue.actual, 'global/rag-eval-fixtures/doc49.md'), source)
    await syncIndex({
      actualRoot: fixtureValue.actual,
      indexPath: fixtureValue.indexPath,
      autoGenerateSummaries: true,
    })
    const db = new DatabaseSync(fixtureValue.indexPath)
    const docId = (db.prepare('SELECT id FROM kb_docs WHERE path = ?')
      .get('global/rag-eval-fixtures/doc49.md') as { id: number }).id
    db.close()
    const outline = await readDocumentOutline({ indexPath: fixtureValue.indexPath, docId })
    expect(outline).toBeDefined()
    const summary = outline!.summary
    expect(summary).toContain('共 6 章')
    expect(summary).toContain('27 条')
    expect(summary).toContain('关键门槛与流程')
    expect(summary).toContain('二分之一')
    expect(summary).toContain('三分之二')
    expect(summary).toContain('以上含本数')
    expect(summary).not.toContain('主要内容：第一条')
    expect(summary.length).toBeGreaterThanOrEqual(200)
    expect(summary.length).toBeLessThanOrEqual(300)

    const chapter = (prefix: string) => outline!.sections.find(section => section.title.startsWith(prefix))
    const fifth = chapter('第五章')
    expect(fifth).toBeDefined()
    expect(fifth!.summary).toContain('二分之一')
    expect(fifth!.summary).toContain('三分之二')
    expect(fifth!.summary).toContain('回避')
    expect(fifth!.summary.length).toBeGreaterThanOrEqual(80)
    expect(fifth!.summary.length).toBeLessThanOrEqual(200)
    const seventh = chapter('第七章')
    expect(seventh).toBeDefined()
    expect(seventh!.summary).toContain('以上含本数')
    expect(seventh!.summary.length).toBeGreaterThanOrEqual(80)
    expect(seventh!.summary.length).toBeLessThanOrEqual(200)

    for (const chapterSection of outline!.sections.filter(section => section.level === 1 && /^第/u.test(section.title))) {
      expect(chapterSection.summary.length).toBeGreaterThanOrEqual(80)
      expect(chapterSection.summary.length).toBeLessThanOrEqual(200)
      expect(chapterSection.keyFacts.length).toBeLessThanOrEqual(6)
      for (const fact of chapterSection.keyFacts) {
        expect(fact.value.length).toBeLessThanOrEqual(100)
        expect(fact.value).not.toBe(chapterSection.title)
      }
    }
    expect(outline!.sourceChunkIds.length).toBeGreaterThan(0)
  })
})
