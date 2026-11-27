import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ensureDocumentOutline,
  outlineFilePath,
  readDocumentOutline,
  saveDocumentOutline,
  searchIndex,
  syncIndex,
} from '../src/ftsIndex.ts'
import { extractGroundingTokens, planOutlineSave } from '../src/outlineGuard.ts'
import {
  Config,
  KNOWLEDGE_SKILL_NAME,
  MEMORY_SKILL_NAME,
  knowledgeBaseSkillProvider,
} from '../src/index.ts'

const roots: string[] = []
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'kb-summary-'))
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

const prepare = async (options: { auto?: boolean } = {}) => {
  const value = await fixture()
  await writeFile(join(value.actual, 'global/board.md'), BOARD)
  await syncIndex({
    actualRoot: value.actual,
    indexPath: value.indexPath,
    autoGenerateSummaries: options.auto === true,
  })
  const db = new DatabaseSync(value.indexPath)
  const document = db.prepare('SELECT id FROM kb_docs WHERE path = ?').get('global/board.md') as { id: number }
  db.close()
  const outline = await readDocumentOutline({ indexPath: value.indexPath, docId: document.id })
  if (outline === undefined) throw new Error('outline missing')
  const chapter = outline.sections.find(section => section.title === '第二章 表决')
  if (chapter === undefined) throw new Error('chapter missing')
  const article = outline.sections.find(section => section.title === '第五条')
  if (article === undefined) throw new Error('article missing')
  return { ...value, docId: document.id, outline, chapter, article }
}

describe('explicit model-written summaries', () => {
  it('creates only TOC/section structure on upload by default', async () => {
    const { indexPath, docId } = await prepare()
    const db = new DatabaseSync(indexPath)
    const document = db.prepare('SELECT summary, toc_json, summary_kind, summary_version FROM kb_docs WHERE id = ?')
      .get(docId) as { summary: string | null; toc_json: string; summary_kind: string; summary_version: string }
    const summaryRows = db.prepare('SELECT COUNT(*) AS n FROM kb_summary_chunks WHERE doc_id = ?')
      .get(docId) as { n: number }
    db.close()
    expect(document.summary).toBe('')
    expect(document.summary_kind).toBe('none')
    expect(document.summary_version).toMatch(/^structure-v1:/u)
    expect(summaryRows.n).toBe(0)
    const toc = JSON.parse(document.toc_json) as Array<{ title: string }>
    expect(toc.map(entry => entry.title)).toEqual(expect.arrayContaining(['第一章 总则', '第二章 表决', '第五条']))

    const outline = await readDocumentOutline({ indexPath, docId })
    expect(outline?.summaryStatus).toBe('missing')
    expect(outline?.summaryKind).toBe('none')
    expect(outline?.sections.every(section => section.summary === '')).toBe(true)
    const markdown = await readFile(outlineFilePath(indexPath, docId), 'utf8')
    expect(markdown).toContain('## 目录')
    expect(markdown).toContain('尚未生成摘要')
    expect(markdown).toContain('references/summarize.md')

    const hit = await searchIndex({ indexPath, query: '三分之二', topK: 5, caller, canRead })
    const board = hit.hits.find(candidate => candidate.path === 'global/board.md')
    expect(board).toBeDefined()
    expect(board).not.toHaveProperty('sectionSummary')
    expect(board).not.toHaveProperty('docSummary')
  })

  it('writes doc/section summaries to DB, FTS and INDEX.md', async () => {
    const { indexPath, docId, chapter, article } = await prepare()
    const saved = await saveDocumentOutline({
      indexPath,
      docId,
      summary: '《董事会议事规则》规定普通决议应当经全体董事过半数同意，特别决议应当经全体董事三分之二以上同意。表决机制总览。',
      sections: [
        {
          sectionId: chapter.sectionId,
          headingPath: chapter.headingPath,
          summary: '普通决议应当经全体董事过半数同意；特别决议应当经全体董事三分之二以上同意。',
          keyFacts: [{
            fact: '第四条',
            value: '普通决议应当经全体董事过半数同意。',
            chunkId: article.chunkIds[0]!,
          }],
          sourceChunkIds: chapter.sourceChunkIds,
        },
      ],
    })
    expect(saved?.ok).toBe(true)
    expect(saved?.written.docSummary).toBe(true)
    expect(saved?.written.sectionSummaries).toBe(1)
    expect(saved?.written.keyFacts).toBe(1)
    expect(saved?.written.summaryChunks).toBe(2)
    expect(saved?.rejected).toEqual([])
    expect(saved?.summaryVersion).toMatch(/^llm-v1:/u)

    const db = new DatabaseSync(indexPath)
    const document = db.prepare('SELECT summary, summary_kind, summary_version FROM kb_docs WHERE id = ?')
      .get(docId) as { summary: string; summary_kind: string; summary_version: string }
    const sections = db.prepare('SELECT id, summary FROM kb_sections WHERE doc_id = ?').all(docId) as Array<{ id: string; summary: string }>
    const rows = db.prepare('SELECT kind FROM kb_summary_chunks WHERE doc_id = ? ORDER BY id').all(docId) as Array<{ kind: string }>
    db.close()
    expect(document.summary_kind).toBe('llm')
    expect(document.summary).toContain('表决机制总览')
    expect(document.summary_version).toBe(saved?.summaryVersion)
    expect(sections.find(section => section.id === chapter.sectionId)?.summary).toContain('三分之二')
    expect(rows.map(row => row.kind).sort()).toEqual(['doc_summary', 'section_summary'])

    const outline = await readDocumentOutline({ indexPath, docId })
    expect(outline?.summaryStatus).toBe('ready')
    expect(outline?.summaryKind).toBe('llm')
    const markdown = await readFile(outlineFilePath(indexPath, docId), 'utf8')
    expect(markdown).toContain('表决机制总览')
    expect(markdown).toContain('LLM 阅读原文')

    // A phrase that exists only in the model summary must be reachable through the
    // summary FTS channel, and that channel must stay navigation-only.
    const related = await searchIndex({ indexPath, query: '表决机制总览', topK: 5, caller, canRead })
    expect(related.relatedSections?.some(section => section.summary.includes('表决机制总览'))).toBe(true)
    expect(related.hits).toHaveLength(0)
  })

  it('refuses a number that is absent from the cited chunks and writes nothing', async () => {
    const { indexPath, docId, chapter } = await prepare()
    const before = await readDocumentOutline({ indexPath, docId })
    const saved = await saveDocumentOutline({
      indexPath,
      docId,
      summary: '特别决议应当经全体董事四分之三以上同意。',
      sections: [],
    })
    expect(saved?.ok).toBe(false)
    expect(saved?.rejected.some(field => field.field === 'summary' && field.reason.includes('找不到'))).toBe(true)
    expect(saved?.written.summaryChunks).toBe(0)
    const after = await readDocumentOutline({ indexPath, docId })
    expect(after?.summary).toBe(before?.summary)
    expect(after?.summaryKind).toBe('none')
    expect(after?.sections.every(section => section.summary === '')).toBe(true)
    const db = new DatabaseSync(indexPath)
    const count = db.prepare('SELECT COUNT(*) AS n FROM kb_summary_chunks WHERE doc_id = ?').get(docId) as { n: number }
    db.close()
    expect(count.n).toBe(0)
    expect(chapter.summary).toBe('')
  })

  it('refuses a section or chunk that belongs to another document', async () => {
    const { indexPath, docId } = await prepare()
    const foreignSection = await saveDocumentOutline({
      indexPath,
      docId,
      summary: '本文档说明董事会的表决规则。',
      sections: [{ sectionId: 's999-1', summary: '不存在的章节。' }],
    })
    expect(foreignSection?.ok).toBe(false)
    expect(foreignSection?.rejected[0]).toMatchObject({ field: 'sections[0].sectionId' })

    const foreignChunk = await saveDocumentOutline({
      indexPath,
      docId,
      summary: '本文档说明董事会的表决规则。',
      sections: [{
        sectionId: 's-meaningless',
        sourceChunkIds: [999999],
      }],
    })
    expect(foreignChunk?.ok).toBe(false)
    expect(foreignChunk?.rejected.some(field => field.reason.includes('不属于'))).toBe(true)
  })

  it('keeps a legacy extractive summary until an explicit llm save replaces it', async () => {
    const { indexPath, docId } = await prepare({ auto: true })
    const extractive = await readDocumentOutline({ indexPath, docId })
    expect(extractive?.summaryKind).toBe('extractive')
    expect(extractive?.summaryStatus).toBe('ready')

    await syncIndex({ actualRoot: (await fixtureRoot(indexPath)), indexPath })
    const stillExtractive = await readDocumentOutline({ indexPath, docId })
    expect(stillExtractive?.summaryKind).toBe('extractive')
    expect(stillExtractive?.summary).toBe(extractive?.summary)

    const saved = await saveDocumentOutline({
      indexPath,
      docId,
      summary: '本文档规定董事会的普通决议与特别决议表决门槛。',
      sections: [],
    })
    expect(saved?.ok).toBe(true)
    expect((await readDocumentOutline({ indexPath, docId }))?.summaryKind).toBe('llm')
  })

  it('backfills summary_kind=extractive for a database written before the column existed', async () => {
    const { indexPath } = await fixture()
    await mkdir(join(indexPath, '..'), { recursive: true })
    const legacy = new DatabaseSync(indexPath)
    legacy.exec(`
      CREATE TABLE kb_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        mtime INTEGER NOT NULL,
        hash TEXT NOT NULL,
        title TEXT NOT NULL,
        scope TEXT NOT NULL,
        owner_id TEXT,
        department_code TEXT,
        summary TEXT,
        summary_version TEXT
      );
    `)
    legacy.prepare('INSERT INTO kb_docs(path, mtime, hash, title, scope, summary, summary_version) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('global/board.md', 1, 'abc123', '董事会议事规则', 'global', '旧的抽取式摘要。', 'summary-v1:old')
    legacy.close()
    const migrated = await readDocumentOutline({ indexPath, docId: 1 })
    expect(migrated?.summaryKind).toBe('extractive')
    expect(migrated?.summaryStatus).toBe('ready')
  })

  it('clears an llm summary when the source hash changes', async () => {
    const { indexPath, actual, docId } = await prepare()
    const saved = await saveDocumentOutline({
      indexPath,
      docId,
      summary: '本文档规定董事会的普通决议与特别决议表决门槛。',
      sections: [],
    })
    expect(saved?.ok).toBe(true)
    await writeFile(join(actual, 'global/board.md'), BOARD.replace('第六条 本章程未尽事宜，依照法律法规处理。', '第六条 附件费用不得超过十万元。'))
    await syncIndex({ actualRoot: actual, indexPath })
    const cleared = await readDocumentOutline({ indexPath, docId })
    expect(cleared?.summaryKind).toBe('none')
    expect(cleared?.summaryStatus).toBe('missing')
    expect(cleared?.summary).toBe('')
    expect(cleared?.sections.every(section => section.summary === '')).toBe(true)
  })

  it('exposes the same grounding rule as a pure planner', () => {
    expect(extractGroundingTokens('三分之二以上、5万元、第3条')).toEqual(expect.arrayContaining(['2/3', '50000元', '第3条']))
    const planned = planOutlineSave({
      docId: 1,
      chunks: [{ id: 7, content: '第五条 特别决议应当经全体董事三分之二以上同意。' }],
      storedSections: [{
        sectionId: 's1-1',
        headingPath: '第二章 表决 > 第五条',
        title: '第五条',
        level: 2,
        summary: '',
        keyFacts: [],
        chunkIds: [7],
        sourceChunkIds: [7],
      }],
      submission: {
        docId: 1,
        summary: '特别决议需要三分之二以上同意。',
        sections: [{ sectionId: 's1-1', summary: '特别决议需要三分之二以上同意。' }],
      },
    })
    expect(planned.ok).toBe(true)
    const foreign = planOutlineSave({
      docId: 1,
      chunks: [{ id: 7, content: '第五条 特别决议应当经全体董事三分之二以上同意。' }],
      storedSections: [{
        sectionId: 's1-1',
        headingPath: '第二章 表决 > 第五条',
        title: '第五条',
        level: 2,
        summary: '',
        keyFacts: [],
        chunkIds: [7],
        sourceChunkIds: [7],
      }],
      submission: {
        docId: 1,
        summary: '特别决议需要四分之三以上同意，由财务部审批。',
        sections: [],
      },
    })
    expect(foreign.ok).toBe(false)
    if (!foreign.ok) {
      expect(foreign.rejected.some(item => item.missing?.includes('3/4'))).toBe(true)
      expect(foreign.rejected.some(item => item.missing?.includes('财务部'))).toBe(true)
    }
  })
})

/** The sync helper needs the authoritative root; derive it from the index location. */
async function fixtureRoot(indexPath: string): Promise<string> {
  // `<root>/index/kb-index.sqlite` → `<root>/actual`
  return join(indexPath, '..', '..', 'actual')
}

describe('ensureDocumentOutline summary status', () => {
  it('reports missing instead of fabricating a summary', async () => {
    const { indexPath, docId } = await prepare()
    const ensured = await ensureDocumentOutline({ indexPath, docId })
    expect(ensured?.summaryKind).toBe('none')
    expect(ensured?.summaryStatus).toBe('missing')
    expect(ensured?.summary).toBe('')
  })
})


describe('merged knowledge-base and memory skill registration', () => {
  it('lists one entry per family and routes to explicit reference files', async () => {
    const provider = knowledgeBaseSkillProvider()
    const candidates = await provider.list({})
    expect(candidates.map(candidate => candidate.name).sort()).toEqual([
      KNOWLEDGE_SKILL_NAME, MEMORY_SKILL_NAME,
    ].sort())

    const general = await provider.get(candidates.find(candidate => candidate.name === KNOWLEDGE_SKILL_NAME)!, {})
    expect(general).toMatchObject({ source: 'bundled', provider: 'dsh-knowledge-base' })
    for (const reference of ['references/organize.md', 'references/summarize.md', 'references/vectorize.md', 'references/graph.md']) {
      expect(general?.content).toContain(reference)
      const text = await readFile(new URL(reference, `file://${general!.resourceBase.path}/`), 'utf8')
      expect(text.length).toBeGreaterThan(100)
    }
    const summarize = await readFile(new URL('references/summarize.md', `file://${general!.resourceBase.path}/`), 'utf8')
    expect(summarize).toContain('kb_outline_save')
    expect(summarize).toContain('kb_chunk_get')
    expect(summarize).toContain('引用')
    const vectorize = await readFile(new URL('references/vectorize.md', `file://${general!.resourceBase.path}/`), 'utf8')
    expect(vectorize).toContain('kb_vectorize')
    expect(vectorize).toContain('dryRun')

    const memory = await provider.get(candidates.find(candidate => candidate.name === MEMORY_SKILL_NAME)!, {})
    expect(memory?.name).toBe(MEMORY_SKILL_NAME)
    for (const reference of ['references/guardian.md', 'references/extract.md', 'references/sop-evaluate.md']) {
      expect(memory?.content).toContain(reference)
      const text = await readFile(new URL(reference, `file://${memory!.resourceBase.path}/`), 'utf8')
      expect(text.length).toBeGreaterThan(100)
    }
  })
})


describe('outline.autoGenerate config', () => {
  it('defaults to false and accepts true as the legacy opt-in', () => {
    const resolved = Config({} as never) as unknown as { outline: { autoGenerate: boolean } }
    expect(resolved.outline.autoGenerate).toBe(false)
    const optedIn = Config({ outline: { autoGenerate: true } } as never) as unknown as { outline: { autoGenerate: boolean } }
    expect(optedIn.outline.autoGenerate).toBe(true)
  })
})
