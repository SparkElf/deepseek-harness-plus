// @vitest-environment jsdom
/**
 * Document-level provenance has two halves that must agree: the legacy scanner
 * copies `origin` / `reviewStatus` / `authority` from real front matter into the
 * graph payload, and the embedded canvas paints the same three chips in the topic
 * card header and the document list.
 *
 * The scanner half runs against a temp legacy graph (no `.graphs/` manifest), so
 * it proves the additive fields did not turn into a new-format-only feature. The
 * canvas half executes the real embedded script, not a copy of the renderer: a
 * string test alone would pass even if `badgesHtml` were never called from the two
 * row builders.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { scanKnowledgeGraphs, type KnowledgeGraphScopeRoot } from '../src/graph.ts'
import { GRAPH_CANVAS_HTML } from '../src/graphCanvas.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kb-doc-badges-'))
  roots.push(directory)
  return directory
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const scopeRoot: KnowledgeGraphScopeRoot = {
  key: 'global',
  actualPath: 'global/知识图谱',
  viewPath: 'global/知识图谱',
  groupKey: '',
  groupLabel: '',
}

/** Write one legacy graph with provenance-bearing and provenance-less files. */
async function legacyGraph(): Promise<string> {
  const actualRoot = await tempRoot()
  const graph = join(actualRoot, 'global', '知识图谱', '平台建设')
  await write(join(graph, '平台红线', 'index.md'), [
    '---',
    'id: platform-redline',
    'title: 平台红线',
    'origin: "mixed"',
    'reviewStatus: reviewed',
    'authority: advisory',
    '---',
    '',
    '# 平台红线',
    '',
    '部门与全局都必须遵守的制度。',
    '',
  ].join('\n'))
  await write(join(graph, '平台红线', '制度.md'), [
    '---',
    'origin: ai',
    'reviewStatus: approved',
    'authority: redline',
    '---',
    '',
    '# 发布红线',
    '',
    'AI 起草、管理员确认。',
    '',
  ].join('\n'))
  await write(join(graph, '平台红线', '未知值.md'), [
    '---',
    'origin: robot',
    'reviewStatus: approved',
    '---',
    '',
    '# 未知来源',
    '',
    '未知 origin 必须被忽略而不是让扫描失败。',
    '',
  ].join('\n'))
  // Unterminated front matter: the scanner's simple parser must treat the whole
  // file as a body and still list the document.
  await write(join(graph, '平台红线', '坏格式.md'), [
    '---',
    'origin: ai',
    'reviewStatus: approved',
    '',
    '# 坏格式',
    '',
  ].join('\n'))
  return actualRoot
}

describe('legacy scanner document provenance', () => {
  it('copies origin/reviewStatus/authority from topic and document front matter', async () => {
    const actualRoot = await legacyGraph()
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: [scopeRoot],
      caller: { userId: 'u1', label: '测试用户' },
      canRead: async () => true,
    })

    const graph = tree.scopes[0]?.groups[0]?.graphs[0]
    expect(graph?.name).toBe('平台建设')
    const topic = graph?.topics[0]
    expect(topic).toMatchObject({
      id: 'platform-redline',
      title: '平台红线',
      origin: 'mixed',
      reviewStatus: 'reviewed',
      authority: 'advisory',
    })

    const regulated = topic?.documents.find(document => document.file === '制度.md')
    expect(regulated).toMatchObject({
      title: '发布红线',
      origin: 'ai',
      reviewStatus: 'approved',
      authority: 'redline',
    })
    // Existing fields keep their values and meaning.
    expect(regulated?.summary).toBe('AI 起草、管理员确认。')

    const unknown = topic?.documents.find(document => document.file === '未知值.md')
    expect(unknown?.origin).toBeUndefined()
    expect(unknown?.reviewStatus).toBe('approved')

    const malformed = topic?.documents.find(document => document.file === '坏格式.md')
    expect(malformed).toBeDefined()
    expect(malformed?.origin).toBeUndefined()
    expect(topic?.documents).toHaveLength(3)
  })

  it('leaves provenance absent when the front matter has none, so legacy cards are unchanged', async () => {
    const actualRoot = await tempRoot()
    await write(join(actualRoot, 'global', '知识图谱', '旧图谱', '旧主题', 'index.md'), [
      '# 旧主题',
      '',
      '旧卡片没有标签。',
      '',
    ].join('\n'))
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: [scopeRoot],
      caller: { userId: 'u1', label: '测试用户' },
      canRead: async () => true,
    })
    const topic = tree.scopes[0]?.groups[0]?.graphs[0]?.topics[0]
    expect(topic).toBeDefined()
    expect(topic?.origin).toBeUndefined()
    expect(topic?.reviewStatus).toBeUndefined()
    expect(topic?.authority).toBeUndefined()
  })
})

const DOCUMENT_PATH = 'global/知识图谱/平台建设/平台红线/制度.md'

const canvasPayload = {
  type: 'kg:set-graphs',
  graphs: [
    {
      id: 'global/知识图谱/平台建设',
      name: '平台建设',
      scope: 'global',
      path: 'global/知识图谱/平台建设',
      group: '',
      topics: [
        {
          id: 'platform-redline',
          title: '平台红线',
          status: 'active',
          depth: 2,
          tags: [],
          summary: '部门与全局都必须遵守的制度。',
          body: '',
          folder: '平台红线',
          path: 'global/知识图谱/平台建设/平台红线',
          origin: 'mixed',
          reviewStatus: 'reviewed',
          authority: 'redline',
          documents: [
            {
              title: '发布红线',
              file: '制度.md',
              path: DOCUMENT_PATH,
              date: '2026-11-01',
              origin: 'ai',
              reviewStatus: 'approved',
              authority: 'redline',
            },
            {
              title: '普通说明',
              file: '说明.md',
              path: 'global/知识图谱/平台建设/平台红线/说明.md',
              date: '2026-11-02',
            },
          ],
        },
      ],
      links: [],
      counts: { topics: 1, links: 0, documents: 2 },
    },
  ],
  activeGraphId: 'global/知识图谱/平台建设',
  selectedTopicId: null,
}

describe('graph canvas provenance badges', () => {
  it('ships the badge renderer and calls it from the topic header and document rows', () => {
    expect(GRAPH_CANVAS_HTML).toContain('function badgesHtml')
    expect(GRAPH_CANVAS_HTML).toContain('badgesHtml(t)')
    expect(GRAPH_CANVAS_HTML).toContain('badgesHtml(d)')
    expect(GRAPH_CANVAS_HTML).toContain('.p-badge.ai')
    expect(GRAPH_CANVAS_HTML).toContain('.p-badge.reviewed')
    expect(GRAPH_CANVAS_HTML).toContain('.p-badge.redline')
    expect(GRAPH_CANVAS_HTML).toContain('aria-label="内容标签"')
  })

  it('renders [AI 生成] [已审核] [红线] in the topic card and document list', async () => {
    const dom = new JSDOM(GRAPH_CANVAS_HTML, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'http://localhost/knowledge-base/api/graph.canvas',
    })
    const { window } = dom
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    window.postMessage(canvasPayload, '*')
    await new Promise((resolve) => window.setTimeout(resolve, 50))

    const view = (window as unknown as { __KG_VIEW__?: { selectTopic: (id: string) => void } }).__KG_VIEW__
    expect(view).toBeTruthy()
    view?.selectTopic('platform-redline')

    const cardBadges = [...window.document.querySelectorAll('.card h3 .p-badge')]
    expect(cardBadges.map(badge => badge.textContent)).toEqual(['[AI 生成]', '[已审核]', '[红线]'])
    expect(cardBadges.map(badge => badge.getAttribute('aria-label'))).toEqual(['AI 生成', '已审核', '红线'])

    const docRows = [...window.document.querySelectorAll('.p-doc-item')]
    const regulated = docRows.find(row => row.getAttribute('data-doc-path') === DOCUMENT_PATH)
    expect(regulated).toBeDefined()
    const documentedBadges = [...(regulated?.querySelectorAll('.p-doc-item .p-badge') ?? [])]
    expect(documentedBadges.map(badge => badge.textContent)).toEqual(['[AI 生成]', '[已审核]', '[红线]'])
    expect(documentedBadges[2]?.getAttribute('title')).toBe('红线：只能订阅，不可内化或覆盖')

    const plain = docRows.find(row => row.getAttribute('data-doc-path')?.endsWith('/说明.md') === true)
    expect(plain?.querySelectorAll('.p-badge')).toHaveLength(0)

    dom.window.close()
  })
})
