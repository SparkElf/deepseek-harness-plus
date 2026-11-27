// @vitest-environment jsdom
/**
 * The graph canvas runs in its own document and speaks to the panel over
 * `postMessage`. A document card in the topic detail panel is the second way into
 * a file (the Home table is the first), so a click there must produce a
 * `kg:open-document` message with the view-relative path.
 *
 * This is a regression test for a shadowed global: the canvas keeps a tree map in a
 * module-level `parent`, which made every `parent.postMessage(...)` in the same
 * script call `Map.postMessage` and throw inside a `try/catch`. The click looked
 * dead with no error anywhere. Keep the map named `parentOf`; this test executes
 * the real canvas script, not a copy of its wiring.
 */
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { GRAPH_CANVAS_HTML } from '../src/graphCanvas.ts'

const DOCUMENT_PATH = 'personal/知识图谱/工作轨迹/个人知识库/scope.md'

const graphPayload = {
  type: 'kg:set-graphs',
  graphs: [
    {
      id: 'personal/知识图谱/工作轨迹',
      name: '工作轨迹',
      scope: 'personal',
      path: 'personal/知识图谱/工作轨迹',
      group: '',
      topics: [
        {
          id: 'personal-kb',
          title: '个人知识库',
          status: '进行中',
          depth: 3,
          tags: [],
          summary: '只读闭环：tab、图谱树、画布、主题详情。',
          body: '只读闭环：tab、图谱树、画布、主题详情。写操作下一期。',
          folder: '个人知识库',
          path: 'personal/知识图谱/工作轨迹/个人知识库',
          documents: [
            {
              title: '作用域与权限',
              file: 'scope.md',
              path: DOCUMENT_PATH,
              date: '2026-10-31',
            },
          ],
        },
      ],
      links: [],
      counts: { topics: 1, links: 0, documents: 1 },
    },
  ],
  activeGraphId: 'personal/知识图谱/工作轨迹',
  selectedTopicId: null,
}

describe('graph canvas document cards', () => {
  it('posts kg:open-document with the view-relative path when a card is clicked', async () => {
    const dom = new JSDOM(GRAPH_CANVAS_HTML, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'http://localhost/knowledge-base/api/graph.canvas',
    })
    const { window } = dom
    const messages: Array<{ type?: string; path?: string }> = []
    window.addEventListener('message', (event) => {
      const data = event.data as { type?: string; path?: string } | null
      if (data !== null && typeof data === 'object') messages.push(data)
    })

    // The script posts `kg:ready` from its own load handler; wait for the document
    // to finish, then hand it the same payload the host sends.
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    window.postMessage(graphPayload, '*')
    await new Promise((resolve) => window.setTimeout(resolve, 50))

    const view = (window as unknown as { __KG_VIEW__?: { selectTopic: (id: string) => void } }).__KG_VIEW__
    expect(view).toBeTruthy()
    view?.selectTopic('personal-kb')

    const card = window.document.querySelector('.p-doc-item') as HTMLElement | null
    expect(card).not.toBeNull()
    expect(card?.getAttribute('data-doc-path')).toBe(DOCUMENT_PATH)
    card?.click()

    await new Promise((resolve) => window.setTimeout(resolve, 50))
    const opened = messages.find((message) => message.type === 'kg:open-document')
    expect(opened?.path).toBe(DOCUMENT_PATH)
    dom.window.close()
  })
})
describe('graph canvas overview', () => {
  it('draws the cross-graph edge dashed and navigates to the source graph on click', async () => {
    const overviewPayload = {
      type: 'kg:set-graphs',
      graphs: [
        {
          id: 'personal/.graphs/__overview__',
          name: '总图',
          scope: 'personal',
          path: 'personal/.graphs/__overview__',
          group: '',
          format: 'overview',
          computed: true,
          readOnly: true,
          topics: [
            {
              id: 'personal/.graphs/a:n1',
              title: '采购制度',
              status: 'approved',
              depth: 1,
              domain: 'policy',
              tags: ['采购制度图谱'],
              summary: '',
              body: '',
              folder: '采购制度图谱',
              path: 'personal/制度/采购制度.md',
              documents: [],
              sourceGraphId: 'personal/.graphs/a',
              sourceNodeId: 'n1',
              scope: 'personal',
              contributed: true,
              readOnly: true,
            },
            {
              id: 'personal/.graphs/a:n2',
              title: '审批流程',
              status: 'draft',
              depth: 1,
              domain: 'procedure',
              tags: ['采购制度图谱'],
              summary: '',
              body: '',
              folder: '采购制度图谱',
              path: 'personal/流程/审批流程.md',
              documents: [],
              sourceGraphId: 'personal/.graphs/a',
              sourceNodeId: 'n2',
              scope: 'personal',
            },
            {
              id: 'personal/.graphs/b:n3',
              title: '岗位',
              status: 'draft',
              depth: 1,
              domain: 'fact',
              tags: ['人力资源图谱'],
              summary: '',
              body: '',
              folder: '人力资源图谱',
              path: 'personal/人力/岗位.md',
              documents: [],
              sourceGraphId: 'personal/.graphs/b',
              sourceNodeId: 'n3',
              scope: 'personal',
            },
          ],
          links: [
            { a: 'personal/.graphs/a:n1', b: 'personal/.graphs/a:n2', label: 'depends_on', body: '' },
            { a: 'personal/.graphs/a:n2', b: 'personal/.graphs/b:n3', label: 'governs', body: '', crossGraph: true },
          ],
          counts: { topics: 3, links: 2, documents: 0 },
        },
      ],
      activeGraphId: 'personal/.graphs/__overview__',
      selectedTopicId: null,
    }
    const dom = new JSDOM(GRAPH_CANVAS_HTML, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'http://localhost/knowledge-base/api/graph.canvas',
    })
    const { window } = dom
    const messages: Array<{ type?: string; graphId?: string; topicId?: string }> = []
    window.addEventListener('message', (event) => {
      const data = event.data as { type?: string; graphId?: string; topicId?: string } | null
      if (data !== null && typeof data === 'object') messages.push(data)
    })
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    window.postMessage(overviewPayload, '*')
    await new Promise((resolve) => window.setTimeout(resolve, 80))

    // The cross-graph edge is dashed even though the ordinary cross toggle is off.
    expect(window.document.querySelectorAll('path.edge.cross').length).toBeGreaterThan(0)
    expect(window.document.getElementById('cross')?.classList.contains('on')).toBe(true)
    expect(window.document.querySelectorAll('.p-badge.contributed').length).toBeGreaterThan(0)

    // Clicking an aggregated card hands the source graph/node back to the host.
    const view = (window as unknown as { __KG_VIEW__?: { selectTopic: (id: string) => void } }).__KG_VIEW__
    view?.selectTopic('personal/.graphs/b:n3')
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    const opened = messages.find((message) => message.type === 'kg:open-source')
    expect(opened?.graphId).toBe('personal/.graphs/b')
    expect(opened?.topicId).toBe('n3')
    // The overview must not open a detail panel for the computed copy.
    expect(window.document.getElementById('panel')?.classList.contains('open')).toBe(false)
    dom.window.close()
  })
})

describe('graph canvas empty overview', () => {
  it('shows the empty state instead of dereferencing an absent first topic', async () => {
    const dom = new JSDOM(GRAPH_CANVAS_HTML, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'http://localhost/knowledge-base/api/graph.canvas',
    })
    const { window } = dom
    const errors: string[] = []
    window.addEventListener('error', (event) => { errors.push(String(event.message)) })
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    window.postMessage({
      type: 'kg:set-graphs',
      graphs: [{
        id: 'global/.graphs/__overview__',
        name: '总图',
        scope: 'global',
        path: 'global/.graphs/__overview__',
        group: '',
        format: 'overview',
        computed: true,
        readOnly: true,
        topics: [],
        links: [],
        counts: { topics: 0, links: 0, documents: 0 },
      }],
      activeGraphId: 'global/.graphs/__overview__',
      selectedTopicId: null,
    }, '*')
    await new Promise((resolve) => window.setTimeout(resolve, 80))
    expect(errors).toEqual([])
    expect(window.document.getElementById('kg-empty')?.hidden).toBe(false)
    dom.window.close()
  })
})
