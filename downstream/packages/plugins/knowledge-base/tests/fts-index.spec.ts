import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  assertIndexOutsideTrees,
  chunkText,
  indexPathFor,
  scopeForPath,
  findChunkForPath,
  readChunkProvenance,
  attachProvenance,
  findChunkId,
  searchIndex,
  syncIndex,
} from '../src/ftsIndex.ts'

const roots: string[] = []
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-fts-'))
  roots.push(root)
  const actual = join(root, 'actual')
  const indexDir = join(root, 'index')
  await mkdir(join(actual, 'global'), { recursive: true })
  await mkdir(join(actual, 'personal/u1'), { recursive: true })
  await mkdir(join(actual, 'personal/u2'), { recursive: true })
  await mkdir(join(actual, 'department/d1'), { recursive: true })
  return { root, actual, indexDir, indexPath: indexPathFor(indexDir) }
}
const canRead = async () => true
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

describe('kb FTS5 index', () => {
  it('indexes and finds Chinese and English text with BM25 snippets', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/制度.md'), '# 差旅制度\n\n出差住宿标准为每晚五百元。\n\n报销需要发票。')
    await writeFile(join(actual, 'global/guide.md'), '# Travel\n\nBook a hotel and keep the receipt for reimbursement.')
    const stats = await syncIndex({ actualRoot: actual, indexPath })
    expect(stats.docs).toBe(2)
    expect(stats.chunks).toBeGreaterThan(0)
    const zh = (await searchIndex({ indexPath, query: '住宿标准', topK: 5, caller: { callerId: 'u1', departmentCodes: [], global: true }, canRead })).hits
    expect(zh[0]).toMatchObject({ path: 'global/制度.md' })
    expect(zh[0]?.snippet).toContain('住宿标准')
    expect(zh[0]?.lineStart).toBe(zh[0]?.line)
    expect(zh[0]?.citation).toMatch(/^kb:\/\/doc\/\d+\/chunk\/[\da-f-]+(?:\?.*)?$/)
    const short = (await searchIndex({ indexPath, query: '差旅', topK: 5, caller: { callerId: 'u1', departmentCodes: [], global: true }, canRead })).hits
    expect(short[0]).toMatchObject({ path: 'global/制度.md' })
    const en = (await searchIndex({ indexPath, query: 'reimbursement', topK: 5, caller: { callerId: 'u1', departmentCodes: [], global: true }, canRead })).hits
    expect(en[0]).toMatchObject({ path: 'global/guide.md' })
    expect(en[0]?.score).toBeGreaterThanOrEqual(0)
  })

  it('relaxes a multi-word phrase to per-token search and dedupes the merge (rag-033)', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/board.md'), '# 董事会议事规则\n\n董事会 表决 通过 需要 三分之二 以上 董事 同意。')
    await writeFile(join(actual, 'global/ops.md'), '# 经营班子会\n\n经营班子会 审议 重大项目，金额 门槛 为 五百万元。')
    await syncIndex({ actualRoot: actual, indexPath })
    const result = await searchIndex({
      indexPath,
      query: '董事会 表决 通过 门槛 经营班子会',
      topK: 10,
      caller: { callerId: 'u1', departmentCodes: [], global: true },
      canRead,
    })
    expect(result.relaxed).toBe(true)
    expect(result.queries).toEqual(['董事会', '表决', '通过', '门槛', '经营班子会'])
    expect(result.hits.length).toBeGreaterThan(0)
    expect(new Set(result.hits.map(hit => hit.path + ':' + String(hit.line))).size).toBe(result.hits.length)
    expect(result.hits.map(hit => hit.path)).toEqual(expect.arrayContaining(['global/board.md', 'global/ops.md']))
  })

  it('ranks a voting-threshold article above a title/preamble chunk on a relaxed query', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(
      join(actual, 'global/preamble.md'),
      '# 董事会议事规则\n\n董事会 董事会 董事会 经营班子会 经营班子会 经营班子会 第一章 总则',
    )
    await writeFile(
      join(actual, 'global/article.md'),
      '# 董事会议事规则\n\n第二十二条 董事会决议分为普通决议和特别决议。董事会通过普通决议，应当经董事会全体成员过半数同意；通过特别决议，应当经董事会全体成员三分之二以上同意。',
    )
    await syncIndex({ actualRoot: actual, indexPath })
    const result = await searchIndex({
      indexPath,
      query: '董事会 经营班子会 表决 通过门槛',
      topK: 10,
      caller: { callerId: 'u1', departmentCodes: [], global: true },
      canRead,
    })
    expect(result.relaxed).toBe(true)
    expect(result.hits[0]?.path).toBe('global/article.md')
  })

  it('returns the original docx/xlsx/pdf path and keeps txt line anchors', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/report.docx'), 'PK binary')
    await writeFile(join(actual, 'global/report.docx.md'), '# 报告\n\n原始文档关键词 预算。')
    await writeFile(join(actual, 'global/table.xlsx'), 'PK binary')
    await writeFile(join(actual, 'global/table.xlsx.md'), '## Sheet: 财务预测\n\n<!-- cell: B2 -->\n原始文档关键词 金额。')
    await writeFile(join(actual, 'global/scan.pdf'), 'PDF binary')
    await writeFile(join(actual, 'global/scan.pdf.md'), '# 扫描件\n\n原始文档关键词 发票。')
    await writeFile(join(actual, 'global/legacy.txt'), '原始文档关键词 旧文本')
    await syncIndex({ actualRoot: actual, indexPath })
    const hits = (await searchIndex({
      indexPath, query: '原始文档关键词', topK: 20,
      caller: { callerId: 'u1', departmentCodes: [], global: true }, canRead,
    })).hits
    const byPath = new Map(hits.map(hit => [hit.path, hit]))
    expect(byPath.get('global/report.docx')).toMatchObject({ markdownPath: 'global/report.docx.md', heading: '# 报告', paragraph: 0 })
    expect(byPath.get('global/table.xlsx')).toMatchObject({ markdownPath: 'global/table.xlsx.md', sheet: '财务预测', cell: 'B2' })
    const docxHit = byPath.get('global/report.docx')
    expect(docxHit?.quote).toContain('原始文档关键词 预算')
    expect(docxHit?.quote).not.toMatch(/^#|\|/u)
    expect(docxHit?.paragraphText).toContain('原始文档关键词')
    expect(byPath.get('global/scan.pdf')).toMatchObject({ markdownPath: 'global/scan.pdf.md' })
    expect(byPath.get('global/legacy.txt')).toMatchObject({ markdownPath: 'global/legacy.txt', lineStart: 1 })
    for (const path of ['global/report.docx', 'global/table.xlsx', 'global/scan.pdf']) {
      expect(byPath.get(path)?.line).toBeUndefined()
      expect(byPath.get(path)?.lineStart).toBeUndefined()
    }
  })

  it('retrieves only the paragraph chunk that contains 合作模式', async () => {
    const { actual, indexPath } = await fixture()
    const paragraphs = Array.from({ length: 24 }, (_, index) => `第${String(index + 1)}段：` + '低空经济产业人才培养与考场服务说明。'.repeat(4))
    paragraphs[14] = '项目合作模式：由甲方提供场地，乙方负责运营，双方按约定比例分成。'
    await writeFile(join(actual, 'global/计划书.md'), '# 商业计划书\n\n' + paragraphs.join('\n\n'))
    await syncIndex({ actualRoot: actual, indexPath })
    const result = await searchIndex({
      indexPath, query: '合作模式', topK: 10,
      caller: { callerId: 'u1', departmentCodes: [], global: true }, canRead,
    })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.quote).toContain('合作模式')
    expect(result.hits[0]?.quote).not.toContain('低空经济产业人才培养与考场服务说明')
  })

  it('uses a query-centered quote instead of the chunk title', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/决议.md'), '# 董事会制度标题\n\n普通决议需要全体董事过半数通过。\n\n特别决议需要三分之二以上通过。')
    await syncIndex({ actualRoot: actual, indexPath })
    const result = await searchIndex({
      indexPath, query: '普通决议', topK: 5,
      caller: { callerId: 'u1', departmentCodes: [], global: true }, canRead,
    })
    const hit = result.hits[0]
    expect(hit?.quote).toContain('普通决议')
    expect(hit?.quote?.startsWith('董事会制度标题')).toBe(false)
    expect(hit?.chunkOrdinal).toBe(0)
    expect(hit?.matchedTerms).toContain('普通决议')
    expect(hit?.highlightText).toContain('普通决议')
    expect(hit?.highlightRanges?.length).toBeGreaterThan(0)
    expect(hit?.citation).toContain('terms=')
    expect(hit?.citation).toContain('highlight=')
  })

  it('omits query highlight fields when the query does not match the chunk', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/无命中.md'), '# 标题\n\n普通决议内容。')
    await syncIndex({ actualRoot: actual, indexPath })
    const result = await searchIndex({
      indexPath, query: '完全不存在的词', topK: 5,
      caller: { callerId: 'u1', departmentCodes: [], global: true }, canRead,
    })
    expect(result.hits[0]?.matchedTerms).toBeUndefined()
    expect(result.hits[0]?.highlightText).toBeUndefined()
  })

  it('localizes displayPath while keeping canonical path for ACL/open', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/制度.md'), '# 制度\n\n检索别名关键词')
    await syncIndex({ actualRoot: actual, indexPath })
    const result = await searchIndex({
      indexPath, query: '检索别名关键词', topK: 5, locale: 'zh',
      caller: { callerId: 'u1', departmentCodes: [], global: true }, canRead,
    })
    expect(result.hits[0]).toMatchObject({ path: 'global/制度.md', displayPath: '全局/制度.md' })
    const english = await searchIndex({
      indexPath, query: '检索别名关键词', topK: 5, locale: 'en',
      caller: { callerId: 'u1', departmentCodes: [], global: true }, canRead,
    })
    expect(english.hits[0]?.displayPath).toBe('Global/制度.md')
  })

  it('filters identity/scope before ranking and never leaks another personal file', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/a.md'), 'shared keyword')
    await writeFile(join(actual, 'personal/u1/a.md'), 'my keyword one')
    await writeFile(join(actual, 'personal/u2/a.md'), 'their keyword two')
    await writeFile(join(actual, 'department/d1/a.md'), 'department keyword three')
    await syncIndex({ actualRoot: actual, indexPath })
    const hits = (await searchIndex({
      indexPath, query: 'keyword', topK: 10,
      caller: { callerId: 'u1', departmentCodes: [], global: false }, canRead,
    })).hits
    expect(hits.map(hit => hit.path).sort()).toEqual(['global/a.md', 'personal/u1/a.md'])
  })

  it('applies topK after the scope filter', async () => {
    const { actual, indexPath } = await fixture()
    await mkdir(join(actual, 'personal/u1'), { recursive: true })
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(actual, `personal/u1/${String(index)}.md`), 'needle own ' + String(index))
      await writeFile(join(actual, `personal/u2/${String(index)}.md`), 'needle other ' + String(index))
    }
    await syncIndex({ actualRoot: actual, indexPath })
    const hits = (await searchIndex({
      indexPath, query: 'needle', topK: 3,
      caller: { callerId: 'u1', departmentCodes: [], global: false }, canRead,
    })).hits
    expect(hits).toHaveLength(3)
    expect(hits.every(hit => hit.path.startsWith('personal/u1/'))).toBe(true)
  })

  it('migrates old rows with null source_path back to the original document', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/legacy.docx'), 'docx')
    await writeFile(join(actual, 'global/legacy.docx.md'), '# 旧索引\n\n迁移关键词')
    await syncIndex({ actualRoot: actual, indexPath })
    const db = new DatabaseSync(indexPath)
    db.prepare('UPDATE kb_docs SET source_path = NULL, markdown_path = NULL').run()
    db.close()
    await syncIndex({ actualRoot: actual, indexPath })
    const db2 = new DatabaseSync(indexPath)
    const row = db2.prepare('SELECT source_path, markdown_path FROM kb_docs WHERE path = ?').get('global/legacy.docx.md') as { source_path: string; markdown_path: string }
    db2.close()
    expect(row).toEqual({ source_path: 'global/legacy.docx', markdown_path: 'global/legacy.docx.md' })
  })

  it('preserves provenance boxes when reindexing for source_path migration', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/scan.pdf'), 'pdf')
    await writeFile(join(actual, 'global/scan.pdf.md'), '# 扫描\n\n住宿标准。')
    await syncIndex({ actualRoot: actual, indexPath })
    const db = new DatabaseSync(indexPath)
    const chunkId = (db.prepare('SELECT id FROM kb_chunks LIMIT 1').get() as { id: number }).id
    db.prepare('INSERT INTO kb_chunk_boxes(chunk_id, page, bbox_json) VALUES (?, 2, ?)').run(chunkId, '[0.1,0.2,0.8,0.3]')
    db.prepare('UPDATE kb_docs SET source_path = NULL, markdown_path = NULL').run()
    db.close()
    await syncIndex({ actualRoot: actual, indexPath })
    const db2 = new DatabaseSync(indexPath)
    const boxes = db2.prepare('SELECT b.page FROM kb_chunks c JOIN kb_chunk_boxes b ON b.chunk_id = c.id').all() as Array<{ page: number }>
    db2.close()
    expect(boxes).toEqual([{ page: 2 }])
  })

  it('keeps source line anchors when the overlap prefix is added', () => {
    const lines = ['# 规则', '']
    for (let index = 1; index <= 30; index += 1) {
      lines.push(`第${index}条 ${'本条内容用于测试分块行号。'.repeat(12)}`, '')
    }
    const text = lines.join('\n')
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(5)
    // The last chunk starts near the end of the document. The old overlap adjustment rewrote
    // every later anchor from the previous chunk's *content* line count, so it landed near the
    // middle instead of the last article.
    expect(chunks.at(-1)!.line).toBeGreaterThan(Math.floor(lines.length * 0.7))
  })

  it('resolves a late markdown line to the article that owns it, not to a neighbour', async () => {
    const { actual, indexPath } = await fixture()
    const lines = ['# 规则', '']
    for (let index = 1; index <= 20; index += 1) {
      lines.push(`第${index}条 ${'本条内容用于测试跨段解析。'.repeat(16)}`, '')
    }
    const text = lines.join('\n')
    await writeFile(join(actual, 'global/report.docx'), 'docx')
    await writeFile(join(actual, 'global/report.docx.md'), text)
    await syncIndex({ actualRoot: actual, indexPath })
    const articleLine = text.split('\n').findIndex(line => line.startsWith('第18条')) + 1
    const found = await findChunkForPath({ indexPath, path: 'global/report.docx.md', line: articleLine })
    expect(found).toBeDefined()
    const provenance = await readChunkProvenance({ indexPath, docId: found!.docId, chunkId: found!.chunkId })
    expect(provenance?.chunkText).toContain('第18条')
  })

  it('uses the requested source line when stored chunk anchors are stale', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/report.docx'), 'docx')
    await writeFile(join(actual, 'global/report.docx.md'), '# 报告\n\n第一段\n\n第二段 关键词\n\n第三段')
    await syncIndex({ actualRoot: actual, indexPath })
    const db = new DatabaseSync(indexPath)
    // Simulate an index built before the overlap-anchor fix: every chunk claims line 1.
    db.prepare('UPDATE kb_chunks SET line = 1').run()
    db.close()
    const found = await findChunkForPath({
      indexPath,
      path: 'global/report.docx.md',
      line: 5,
      lineText: '第二段 关键词',
    })
    expect(found).toBeDefined()
    const provenance = await readChunkProvenance({ indexPath, docId: found!.docId, chunkId: found!.chunkId })
    expect(provenance?.quote).toContain('第二段')
  })

  it('resolves a derived markdown path + line to the original chunk', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/report.docx'), 'docx')
    await writeFile(join(actual, 'global/report.docx.md'), '# 报告\n\n第一段\n\n第二段 关键词\n\n第三段')
    await syncIndex({ actualRoot: actual, indexPath })
    const byDerived = await findChunkForPath({ indexPath, path: 'global/report.docx.md', line: 3 })
    expect(byDerived).toBeDefined()
    const provenance = await readChunkProvenance({ indexPath, docId: byDerived!.docId, chunkId: byDerived!.chunkId })
    expect(provenance).toMatchObject({ path: 'global/report.docx', markdownPath: 'global/report.docx.md' })
    expect(provenance?.quote).toContain('第二段')
    const byOriginal = await findChunkForPath({ indexPath, path: 'global/report.docx', line: 3 })
    expect(byOriginal).toEqual(byDerived)
    const byViewDerived = await findChunkForPath({ indexPath, path: 'global/report.docx.md', line: 3 })
    expect(byViewDerived).toEqual(byDerived)
    await expect(findChunkForPath({ indexPath, path: 'global/missing.docx.md', line: 3 })).resolves.toBeUndefined()
  })

  it('reindexes when the structure-chunker version changes', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/版本.md'), '# 版本\n\n结构分块需要重建。')
    await syncIndex({ actualRoot: actual, indexPath })
    const db = new DatabaseSync(indexPath)
    db.prepare('UPDATE kb_docs SET chunker_version = NULL').run()
    db.close()
    const stats = await syncIndex({ actualRoot: actual, indexPath })
    expect(stats.indexed).toBe(1)
    expect(stats.unchanged).toBe(0)
  })

  it('keeps chunk keys stable and maps old numeric chunk ids after reindex', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/稳定.md'), '# 稳定\n\n第一段内容。\n\n第二段内容。')
    await syncIndex({ actualRoot: actual, indexPath })
    const db = new DatabaseSync(indexPath)
    const before = db.prepare('SELECT id, chunk_key FROM kb_chunks ORDER BY id').all() as Array<{ id: number; chunk_key: string }>
    db.prepare('UPDATE kb_docs SET chunker_version = NULL').run()
    db.close()
    await syncIndex({ actualRoot: actual, indexPath })
    const db2 = new DatabaseSync(indexPath)
    const after = db2.prepare('SELECT id, chunk_key FROM kb_chunks ORDER BY id').all() as Array<{ id: number; chunk_key: string }>
    db2.close()
    expect(after.map(chunk => chunk.chunk_key)).toEqual(before.map(chunk => chunk.chunk_key))
    expect(after[0]?.id).not.toBe(before[0]?.id)
    await expect(findChunkId({ indexPath, docId: 1, chunkId: before[0]!.id })).resolves.toBe(after[0]?.id)
    await expect(findChunkId({ indexPath, docId: 1, chunkId: after[0]!.chunk_key })).resolves.toBe(after[0]?.id)
  })

  it('serializes concurrent search and reindex without database-locked errors', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/并发.md'), '# 并发\n\n并发检索关键词。')
    await syncIndex({ actualRoot: actual, indexPath })
    const searches = Array.from({ length: 6 }, () => searchIndex({
      indexPath, query: '并发检索', topK: 5,
      caller: { callerId: 'u1', departmentCodes: [], global: true }, canRead,
    }))
    await expect(Promise.all([...searches, syncIndex({ actualRoot: actual, indexPath })])).resolves.toBeDefined()
  })

  it('rebuilds incrementally and removes documents whose source disappears', async () => {
    const { actual, indexPath } = await fixture()
    const file = join(actual, 'global/a.md')
    await writeFile(file, 'first body')
    const first = await syncIndex({ actualRoot: actual, indexPath })
    expect(first.indexed).toBe(1)
    const second = await syncIndex({ actualRoot: actual, indexPath })
    expect(second.unchanged).toBe(1)
    expect(second.indexed).toBe(0)
    await writeFile(file, 'second body with changed words')
    const third = await syncIndex({ actualRoot: actual, indexPath })
    expect(third.indexed).toBe(1)
    await rm(file)
    const fourth = await syncIndex({ actualRoot: actual, indexPath })
    expect(fourth.removed).toBe(1)
    expect(fourth.docs).toBe(0)
  })

  it('refuses an index inside the agent-visible tree', () => {
    const { actual } = roots.length > 0 ? { actual: roots[0] + '/actual' } : { actual: '/tmp/x' }
    expect(() => assertIndexOutsideTrees(join(actual, 'index.sqlite'), [actual])).toThrow(/outside/u)
    expect(() => assertIndexOutsideTrees('/tmp/kb-index.sqlite', [actual])).not.toThrow()
  })

  it('chunks by line and recognizes scope helpers', () => {
    const chunks = chunkText('a\n'.repeat(1000), 100)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]?.line).toBe(1)
    expect(scopeForPath('personal/u1/a.md')).toMatchObject({ scope: 'personal', ownerId: 'u1' })
    expect(scopeForPath('department/d1/a.md')).toMatchObject({ scope: 'department', departmentCode: 'd1' })
  })

  it('keeps p95 query latency bounded on a multi-thousand chunk index', async () => {
    const { actual, indexPath } = await fixture()
    for (let doc = 0; doc < 400; doc += 1) {
      const paragraphs = Array.from({ length: 60 }, (_, index) => `第${String(index)}段：知识库检索性能测试，文档 ${String(doc)}，关键词 数据治理。`).join('\n\n')
      await writeFile(join(actual, `global/doc-${String(doc)}.md`), paragraphs)
    }
    const stats = await syncIndex({ actualRoot: actual, indexPath })
    expect(stats.chunks).toBeGreaterThan(1000)
    const started = Date.now()
    const samples: number[] = []
    for (let index = 0; index < 25; index += 1) {
      const queryStarted = Date.now()
      await searchIndex({ indexPath, query: '数据治理', topK: 8, caller: { callerId: 'u', departmentCodes: [], global: true }, canRead })
      samples.push(Date.now() - queryStarted)
    }
    samples.sort((a, b) => a - b)
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0
    // CI machines vary; the shared target is <200ms, and the evidence records the measured value.
    console.log('KB_FTS_BENCH', JSON.stringify({ chunks: stats.chunks, p95Ms: p95, samples }))
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(p95).toBeLessThan(1_000)
  }, 30_000)
})


describe('PDF provenance join', () => {
  it('returns page and bbox from kb_chunk_boxes without putting bbox in the markdown text', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/scan.pdf.md'), '# OCR text\n\n住宿标准五百元。')
    await syncIndex({ actualRoot: actual, indexPath })
    const db = new DatabaseSync(indexPath)
    const chunkId = (db.prepare('SELECT id FROM kb_chunks LIMIT 1').get() as { id: number }).id
    db.prepare('INSERT INTO kb_chunk_boxes(chunk_id, page, bbox_json, block_index, occurrence, confidence) VALUES (?, 2, ?, 4, 1, 0.93)').run(chunkId, '[0.1,0.2,0.8,0.3]')
    db.prepare('INSERT INTO kb_chunk_boxes(chunk_id, page, bbox_json, block_index, occurrence, confidence) VALUES (?, 3, ?, 5, 1, 0.51)').run(chunkId, '[0.2,0.3,0.7,0.4]')
    db.close()
    const hits = (await searchIndex({ indexPath, query: '住宿标准', topK: 5, caller: { callerId: 'u', departmentCodes: [], global: true }, canRead })).hits
    expect(hits[0]).toMatchObject({
      path: 'global/scan.pdf',
      markdownPath: 'global/scan.pdf.md',
      page: 2,
      bbox: '[0.1,0.2,0.8,0.3]',
      approximate: true,
      docId: 1,
      chunkId,
      citation: expect.stringMatching(/^kb:\/\/doc\/1\/chunk\/[\da-f-]+(?:\?.*)?$/),
    })
    expect(hits[0]?.line).toBeUndefined()
    expect(hits[0]?.lineStart).toBeUndefined()
    // One union per page, even though provenance stored one block row per page.
    expect(hits[0]?.boxes).toHaveLength(2)
    expect(hits[0]?.boxes?.map(box => box.page)).toEqual([2, 3])
    expect(hits[0]?.boxes?.[0]).toMatchObject({ bbox: '[0.1,0.2,0.8,0.3]' })
    expect(hits[0]?.boxes?.[1]).toMatchObject({ bbox: '[0.2,0.3,0.7,0.4]', approximate: true })
    expect(hits[0]?.snippet).toContain('住宿标准')
    const chunk = await readChunkProvenance({ indexPath, docId: 1, chunkId })
    expect(chunk).toMatchObject({ docId: 1, chunkId, path: 'global/scan.pdf', markdownPath: 'global/scan.pdf.md' })
    expect(chunk?.line).toBeUndefined()
    expect(chunk?.boxes.map(box => box.page)).toEqual([2, 3])
    expect(chunk?.chunkText).toContain('住宿标准')
    expect(chunk?.paragraphs.length).toBeGreaterThan(0)
    expect(chunk?.paragraphs[0]).toMatchObject({ ordinal: 0 })
    expect(chunk?.paragraphs.map(paragraph => paragraph.ordinal)).toEqual(chunk?.paragraphs.map((_, index) => index))
  })
})


describe('persisted union boxes', () => {
  it('stores one union rectangle per page from block provenance', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/union.pdf'), 'pdf')
    await writeFile(join(actual, 'global/union.pdf.md'), '# 扫描\n\n住宿标准五百元。')
    await syncIndex({ actualRoot: actual, indexPath })
    const db = new DatabaseSync(indexPath)
    const chunkId = (db.prepare('SELECT id FROM kb_chunks LIMIT 1').get() as { id: number }).id
    db.close()
    await attachProvenance({
      indexPath,
      markdownPath: 'global/union.pdf.md',
      blocks: [
        { page: 2, bbox: [0.1, 0.2, 0.4, 0.3], text: '住宿标准五百元' },
        { page: 3, bbox: [0.2, 0.3, 0.6, 0.4], text: '住宿标准五百元' },
      ],
    })
    const chunk = await readChunkProvenance({ indexPath, docId: 1, chunkId })
    expect(chunk?.unionBoxes.map(union => union.page)).toEqual([2, 3])
    expect(chunk?.unionBoxes[0]?.bbox).toBe('[0.1,0.2,0.4,0.3]')
  })
})

describe('citation box contract', () => {
  it('keeps per-block provenance in storage but serves one union per page', async () => {
    const { actual, indexPath } = await fixture()
    await writeFile(join(actual, 'global/scan.pdf'), 'pdf')
    await writeFile(join(actual, 'global/scan.pdf.md'), '# 扫描\n\n住宿标准五百元。')
    await syncIndex({ actualRoot: actual, indexPath })
    const db = new DatabaseSync(indexPath)
    const chunkId = (db.prepare('SELECT id FROM kb_chunks LIMIT 1').get() as { id: number }).id
    // Three blocks on two pages: two paragraphs on page 2, one on page 3.
    db.prepare('INSERT INTO kb_chunk_boxes(chunk_id, page, bbox_json, block_index) VALUES (?, 2, ?, 1)').run(chunkId, '[0.1,0.2,0.4,0.3]')
    db.prepare('INSERT INTO kb_chunk_boxes(chunk_id, page, bbox_json, block_index) VALUES (?, 2, ?, 2)').run(chunkId, '[0.2,0.1,0.6,0.5]')
    db.prepare('INSERT INTO kb_chunk_boxes(chunk_id, page, bbox_json, block_index) VALUES (?, 3, ?, 3)').run(chunkId, '[0.3,0.4,0.5,0.6]')
    expect((db.prepare('SELECT COUNT(*) AS n FROM kb_chunk_boxes').get() as { n: number }).n).toBe(3)
    db.close()

    const chunk = await readChunkProvenance({ indexPath, docId: 1, chunkId })
    expect(chunk?.boxes.map(box => box.page)).toEqual([2, 3])
    expect(chunk?.boxes[0]?.bbox).toBe('[0.1,0.1,0.6,0.5]')
    expect(chunk?.boxes[1]?.bbox).toBe('[0.3,0.4,0.5,0.6]')
    expect(chunk?.unionBoxes).toEqual([
      { page: 2, bbox: '[0.1,0.1,0.6,0.5]' },
      { page: 3, bbox: '[0.3,0.4,0.5,0.6]' },
    ])

    const hits = (await searchIndex({
      indexPath, query: '住宿标准', topK: 5,
      caller: { callerId: 'u', departmentCodes: [], global: true }, canRead,
    })).hits
    expect(hits[0]?.boxes?.map(box => box.page)).toEqual([2, 3])
    expect(hits[0]?.boxes).toHaveLength(2)
  })

  it('remaps an old content-keyed citation after re-chunking and expires deleted text', async () => {
    const { actual, indexPath } = await fixture()
    const sentence = '经营班子会审议事项应当形成会议纪要并归档保存。'
    const lines = Array.from({ length: 24 }, () => sentence)
    const file = join(actual, 'global/规则.md')
    await writeFile(file, '# 规则\n\n' + lines.join(''))
    await syncIndex({ actualRoot: actual, indexPath })
    const db = new DatabaseSync(indexPath)
    const before = db.prepare('SELECT chunk_key FROM kb_chunks ORDER BY id').all() as Array<{ chunk_key: string }>
    db.close()
    expect(before).toHaveLength(1)
    const oldKey = before[0]!.chunk_key

    // Re-chunk: a new article heading in the middle splits the old chunk into two.
    const split = lines.slice(0, 18).join('') + '\n第七条 ' + lines.slice(18).join('')
    await writeFile(file, '# 规则\n\n' + split)
    await syncIndex({ actualRoot: actual, indexPath })
    const remapped = await findChunkId({ indexPath, docId: 1, chunkId: oldKey })
    expect(remapped).toBeDefined()
    const chunk = await readChunkProvenance({ indexPath, docId: 1, chunkId: remapped! })
    expect(chunk?.chunkText).toContain(sentence)

    // Replace the whole document: the old token must expire rather than open a wrong chunk.
    await writeFile(file, '# 规则\n\n' + '完全无关的新制度条款说明。'.repeat(80))
    await syncIndex({ actualRoot: actual, indexPath })
    await expect(findChunkId({ indexPath, docId: 1, chunkId: oldKey })).resolves.toBeUndefined()
  })

  it('remaps a v2 chunk that spans several v3 chunks from its own start', async () => {
    const { actual, indexPath } = await fixture()
    const file = join(actual, 'global/分段规则.md')
    await writeFile(file, [
      '# 分段规则',
      '第一章 总则',
      '第一条 经营班子会审议年度经营计划。',
      '第二条 经营班子会审议年度投资计划。',
      '第二章 议事',
      '第三条 经营班子会审议重大采购事项。',
      '第四条 经营班子会审议重大融资事项。',
      '第五条 经营班子会审议重大担保事项。',
    ].join('\n\n'))
    await syncIndex({ actualRoot: actual, indexPath })
    const db = new DatabaseSync(indexPath)
    const chunks = db.prepare('SELECT id, ord, chunk_key, content FROM kb_chunks WHERE doc_id = 1 ORDER BY ord').all() as Array<{
      id: number; ord: number; chunk_key: string; content: string
    }>
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    const start = 2
    const startKey = chunks[start]!.chunk_key
    // A v2 chunk starts inside a v3 chunk and continues through the next two. No single new
    // chunk holds half of it, so a single-best matcher either drops the citation or opens a
    // later neighbour.
    const oldContent = [
      chunks[start]!.content.split('\n').slice(1).join('\n'),
      chunks[start + 1]!.content,
      chunks[start + 2]!.content,
    ].join('\n')
    const oldKey = '0123456789abcdef'
    db.prepare('DELETE FROM kb_chunks WHERE doc_id = 1').run()
    const inserted = db.prepare(
      'INSERT INTO kb_chunks(doc_id, path, line, ord, chunk_key, heading, content) VALUES (1, ?, 1, ?, ?, ?, ?)',
    ).run('global/分段规则.md', start, oldKey, '旧块', oldContent)
    const oldNumericId = Number(inserted.lastInsertRowid)
    db.prepare("UPDATE kb_docs SET chunker_version = 'structure-v2-keyed' WHERE id = 1").run()
    db.close()

    await syncIndex({ actualRoot: actual, indexPath })
    const resolved = await findChunkId({ indexPath, docId: 1, chunkId: oldKey })
    expect(resolved).toBeDefined()
    await expect(findChunkId({ indexPath, docId: 1, chunkId: oldNumericId })).resolves.toBe(resolved)
    const db2 = new DatabaseSync(indexPath)
    const row = db2.prepare('SELECT chunk_key, ord, content FROM kb_chunks WHERE id = ?').get(resolved!) as {
      chunk_key: string; ord: number; content: string
    }
    db2.close()
    // The citation opens the chunk that contains its start, not the later block that shares
    // more text with the whole old chunk.
    expect(row.chunk_key).toBe(startKey)
    expect(row.ord).toBe(start)
    expect(row.content).toContain('第三条 经营班子会审议重大采购事项')
  })
})
