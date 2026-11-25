// @ts-nocheck
// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { KbSourcesNodeView, kbSourcesDefinition, mergeCitations, sourceFileName, uniqueCitations } from '../src/client/kb-sources.tsx'
import { parseCitationToken, type Citation } from '../src/shared/citation.ts'
import { clearChunkCache } from '../src/client/citation-view.ts'
import { clearLabelCaches } from '../src/client/link-label.ts'

beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn() })
beforeEach(() => {
  clearChunkCache()
  clearLabelCaches()
})

const token = (id: string) => 'kb://doc/d/chunk/' + id + '?path=' + encodeURIComponent('/workspace/kb/a.pdf') + '&page=2'

function citation(id: string, page = 2): Citation {
  return parseCitationToken(token(id) + '&page=' + String(page))!
}

describe('turn source panel', () => {
  it('merges citations and deduplicates repeated sources', () => {
    const text = '见 `' + token('c1') + '` 和 `' + token('c2') + '`，再次 `' + token('c1') + '`。'
    const merged = mergeCitations([], text)
    expect(merged).toHaveLength(2)
    expect(new Set(merged.map(item => item.raw)).size).toBe(2)
  })

  it('keeps first-seen order and drops exact duplicates', () => {
    const first = citation('a')
    const second = citation('b')
    expect(uniqueCitations([first, second, first])).toEqual([first, second])
  })

  it('only starts on the first step and updates on assistant messages', () => {
    expect(kbSourcesDefinition.match({ type: 'step/start', data: { turn: 3, step: 1 } })).toEqual({ id: 'kb-sources:3', role: 'start' })
    expect(kbSourcesDefinition.match({ type: 'step/start', data: { turn: 3, step: 2 } })).toBeNull()
    expect(kbSourcesDefinition.match({ type: 'assistant/message', data: { turn: 3 } })).toEqual({ id: 'kb-sources:3', role: 'update' })
  })

  it('does not materialize a node when the turn has no citation', () => {
    const node = kbSourcesDefinition.buildViewNode({ key: 'k', id: 'kb-sources:1', state: { turn: 1, citations: [] }, start: { seq: 1, location: {} } })
    expect(node).toBeNull()
  })

  it('renders the collapsible source panel above the answer with one row per source', () => {
    const html = renderToStaticMarkup(createElement(KbSourcesNodeView, { node: { data: { turn: 1, citations: [citation('a'), citation('b')] } } }))
    expect(html).toContain('使用了 2 个来源')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('data-kb-sources="1"')
    expect(html).not.toContain('a.pdf')
  })

  it('anchors the panel at turn start, which sorts before the assistant answer', () => {
    const node = kbSourcesDefinition.buildViewNode({
      key: 'k', id: 'kb-sources:1', state: { turn: 1, citations: [citation('x')] }, start: { seq: 10, location: {} },
    })
    expect(node).toMatchObject({ kind: 'kb-sources', target: 'chat', anchorSeq: 10 })
    expect(10).toBeLessThan(11)
  })
})

describe('scanned/text line policy', () => {
  it('only text-like paths consume a line hint', async () => {
    const { isTextPath } = await import('../src/client/citation-view.ts')
    expect(isTextPath('/workspace/kb/a.md')).toBe(true)
    expect(isTextPath('/workspace/kb/a.txt')).toBe(true)
    expect(isTextPath('/workspace/kb/a.pdf')).toBe(false)
    expect(isTextPath('/workspace/kb/a.png')).toBe(false)
  })
})

describe('chunk endpoint retrieval', () => {
  it('does not call the endpoint when the token already has chunkGroups', async () => {
    const { resolveChunkGroups } = await import('../src/client/citation-view.ts')
    const fetcher = vi.fn()
    const groups = [{ page: 1, boxes: [[0.1, 0.1, 0.2, 0.2]] as const }]
    await expect(resolveChunkGroups({ docId: '7', chunkId: '9' }, { chunkGroups: groups } as never, fetcher as never)).resolves.toEqual(groups)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('fetches by docId/chunkId when groups are absent and returns multi-page groups', async () => {
    const { resolveChunkGroups } = await import('../src/client/citation-view.ts')
    const groups = [{ page: 2, boxes: [[0.1, 0.1, 0.2, 0.2]] as const }, { page: 3, boxes: [[0.3, 0.3, 0.4, 0.4]] as const }]
    const fetcher = vi.fn().mockResolvedValue({ groups })
    await expect(resolveChunkGroups({ docId: '7', chunkId: '9' }, {}, fetcher as never)).resolves.toEqual(groups)
    expect(fetcher).toHaveBeenCalledWith('7', '9')
  })

  it('returns undefined on a failed endpoint so page/boxes/quote can fall back', async () => {
    const { resolveChunkGroups } = await import('../src/client/citation-view.ts')
    const fetcher = vi.fn().mockResolvedValue(undefined)
    await expect(resolveChunkGroups({ docId: '7', chunkId: '9' }, {}, fetcher as never)).resolves.toBeUndefined()
  })
})

describe('fetchChunkGroups', () => {
  it('posts docId/chunkId and groups returned page boxes', async () => {
    const { fetchChunkGroups } = await import('../src/client/citation-view.ts')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: '/workspace/department/scan.pdf', lineStart: 4,
      boxes: [{ page: 1, bbox: '[0.1,0.2,0.3,0.4]' }, { page: 1, bbox: '[0.2,0.3,0.4,0.5]' }, { page: 2, bbox: '0.5,0.6,0.7,0.8' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchChunkGroups('7', '9')
    expect(fetchMock).toHaveBeenCalledWith('/knowledge-base/api/chunk', expect.objectContaining({ method: 'POST', body: JSON.stringify({ docId: 7, chunkId: 9 }) }))
    expect(result?.groups.map(group => group.page)).toEqual([1, 2])
    // Legacy payload: two paragraph boxes on page 1 collapse to one union rectangle.
    expect(result?.groups[0]?.boxes).toEqual([[0.1, 0.2, 0.4, 0.5]])
    expect(result?.groups[1]?.boxes).toEqual([[0.5, 0.6, 0.7, 0.8]])
    expect(result?.path).toBe('/workspace/kb/department/scan.pdf')
    vi.unstubAllGlobals()
  })

  it('prefers the API unionBoxes so every page arrives as one rectangle', async () => {
    const { fetchChunkGroups } = await import('../src/client/citation-view.ts')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: '/workspace/department/scan.pdf',
      unionBoxes: [{ page: 1, bbox: '[0.05,0.1,0.95,0.9]' }, { page: 2, bbox: '[0.1,0.2,0.8,0.7]' }],
      // Raw provenance is still present and must not be painted.
      boxes: [{ page: 1, bbox: '[0.1,0.1,0.2,0.2]' }, { page: 1, bbox: '[0.3,0.3,0.4,0.4]' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchChunkGroups('7', '9')
    expect(result?.groups).toEqual([
      { page: 1, boxes: [[0.05, 0.1, 0.95, 0.9]] },
      { page: 2, boxes: [[0.1, 0.2, 0.8, 0.7]] },
    ])
    vi.unstubAllGlobals()
  })

  it('returns undefined on 404 so the caller can fall back', async () => {
    const { fetchChunkGroups } = await import('../src/client/citation-view.ts')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })))
    await expect(fetchChunkGroups('7', '9')).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })
})

describe('bare chunk token resolution', () => {
  it('keeps a bare chunk target and fetches path plus all page groups before opening', async () => {
    const { parseCitationToken } = await import('../src/shared/citation.ts')
    const { resolveOpenTarget } = await import('../src/client/citation-view.ts')
    const citation = parseCitationToken('kb://doc/37/chunk/89')!
    expect(await citationTargetOfForTest(citation)).toMatchObject({ docId: '37', chunkId: '89' })
    const fetcher = vi.fn().mockResolvedValue({
      path: '/workspace/department/scan.pdf', line: undefined,
      groups: [{ page: 1, boxes: [[0.1, 0.1, 0.2, 0.2]] }, { page: 2, boxes: [[0.3, 0.3, 0.4, 0.4]] }],
    })
    const target = await resolveOpenTarget(citation, fetcher as never)
    expect(target?.path).toBe('/workspace/kb/department/scan.pdf')
    expect(target?.options.chunkGroups).toHaveLength(2)
    expect(fetcher).toHaveBeenCalledWith('37', '89')
  })

  it('does not open when the chunk endpoint has no path', async () => {
    const { parseCitationToken } = await import('../src/shared/citation.ts')
    const { resolveOpenTarget } = await import('../src/client/citation-view.ts')
    const target = await resolveOpenTarget(parseCitationToken('kb://doc/37/chunk/89')!, vi.fn().mockResolvedValue({ groups: [] }) as never)
    expect(target).toBeUndefined()
  })
})

async function citationTargetOfForTest(citation: import('../src/shared/citation.ts').Citation) {
  return (await import('../src/shared/citation.ts')).citationTargetOf(citation)
}

describe('docx citations', () => {
  it('opens the original docx, never the .docx.md extraction sibling', async () => {
    const { originalOfficePath } = await import('../src/shared/citation.ts')
    const { citationTargetOf } = await import('../src/shared/citation.ts')
    expect(originalOfficePath('/workspace/kb/a.docx.md')).toBe('/workspace/kb/a.docx')
    const citation = { raw: 'x', kind: 'kb' as const, docId: '1', chunkId: '2', path: '/workspace/kb/a.docx.md', label: 'a', title: 'a' }
    expect(citationTargetOf(citation)?.path).toBe('/workspace/kb/a.docx')
  })

  it('draws all quote hits in the converted PDF text layer', async () => {
    document.body.innerHTML = ''
    const page = document.createElement('div'); page.dataset.pdfPage = '1'
    const span = document.createElement('span'); span.textContent = '项目背景与整体定位'
    page.appendChild(span); document.body.appendChild(page)
    Object.defineProperty(page, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 600, height: 800 }) })
    Object.defineProperty(span, 'getBoundingClientRect', { value: () => ({ left: 60, top: 80, width: 120, height: 20 }) })
    const { highlightDocxQuote } = await import('../src/client/pdf-highlight.ts')
    const result = await highlightDocxQuote({ quote: '项目背景与整体定位' })
    expect(result).toMatchObject({ status: 'text', page: 1, matches: 1, pageCount: 1 })
    expect(document.querySelectorAll('[data-kb-citation-box]')).toHaveLength(1)
  })

  it('falls back to heading text when the quote is absent', async () => {
    document.body.innerHTML = ''
    const page = document.createElement('div'); page.dataset.pdfPage = '1'
    const span = document.createElement('span'); span.textContent = '第三章 项目定位'
    page.appendChild(span); document.body.appendChild(page)
    Object.defineProperty(page, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 600, height: 800 }) })
    Object.defineProperty(span, 'getBoundingClientRect', { value: () => ({ left: 10, top: 20, width: 80, height: 18 }) })
    const { highlightDocxQuote } = await import('../src/client/pdf-highlight.ts')
    await expect(highlightDocxQuote({ quote: '不存在的段落', heading: '第三章 项目定位' })).resolves.toMatchObject({ status: 'text', matches: 1 })
  }, 15000)
})

describe('chunk docx quote propagation', () => {
  it('carries quote and heading from the chunk API into the resolved citation', async () => {
    const { parseCitationToken } = await import('../src/shared/citation.ts')
    const { resolveOpenTarget } = await import('../src/client/citation-view.ts')
    const fetcher = vi.fn().mockResolvedValue({
      path: '/workspace/department/报告.docx', groups: [],
      quote: '项目背景与整体定位', heading: '第一章 项目背景',
    })
    const target = await resolveOpenTarget(parseCitationToken('kb://doc/37/chunk/89')!, fetcher as never)
    expect(target?.path).toBe('/workspace/kb/department/报告.docx')
    expect(target?.citation.quote).toBe('项目背景与整体定位')
    expect(target?.citation.heading).toBe('第一章 项目背景')
  })
})


describe('source filename and anchor', () => {
  it('shows 文件名:第N块 for a chunk and the real basename without one', () => {
    const citation = { raw: 'x', kind: 'kb' as const, docId: '1', chunkId: '2', path: '/workspace/kb/项目报告.docx', label: 'KB 来源', title: '项目报告' }
    expect(sourceFileName(citation)).toBe('项目报告.docx')
    expect(sourceFileName({ ...citation, chunkOrdinal: 2 })).toBe('项目报告.docx:第3块')
    expect(sourceFileName(citation, '来自 chunk 的真实文件名.docx')).toBe('来自 chunk 的真实文件名.docx')
  })

  it('anchors after thinking and before the finalized answer seq', () => {
    const start = kbSourcesDefinition.start({} as never, { event: { type: 'step/start', data: { turn: 4, step: 1 } } } as never)
    const updated = kbSourcesDefinition.update({ state: start } as never, { event: { type: 'assistant/message', seq: 20, data: { turn: 4, message: { content: [{ type: 'text', text: '`kb://doc/37/chunk/89`' }] } } } } as never)
    const node = kbSourcesDefinition.buildViewNode({ key: 'k', id: 'kb-sources:4', state: updated, start: { seq: 10, location: {} } } as never)
    expect(node?.anchorSeq).toBeCloseTo(19.95)
    expect(node?.anchorSeq).toBeLessThan(20)
  })
})

describe('document-tab opening for docx', () => {
  it('builds a session-scoped dsh-resource address for the original docx', async () => {
    const { sessionFileAddress } = await import('../src/client/resource-address.ts')
    const address = sessionFileAddress('session-123', '/workspace/kb/项目 报告.docx')
    expect(address).toBe('dsh-resource://file/session/session-123//workspace/kb/%E9%A1%B9%E7%9B%AE%20%E6%8A%A5%E5%91%8A.docx')
  })

  it('routes docx to the document-preview tab and PDF/markdown to file tabs', async () => {
    const { usesDocumentTab } = await import('../src/client/kb-sources.tsx')
    expect(usesDocumentTab('/workspace/kb/a.docx')).toBe(true)
    expect(usesDocumentTab('/workspace/kb/a.doc')).toBe(true)
    expect(usesDocumentTab('/workspace/kb/a.pdf')).toBe(false)
    expect(usesDocumentTab('/workspace/kb/a.md')).toBe(false)
  })
})

describe('source panel typography', () => {
  it('uses 13px/22px header and 13px rows', () => {
    const citation = { raw: 'x', kind: 'path' as const, path: '/workspace/kb/a.pdf', label: 'a.pdf', title: 'a.pdf' }
    const html = renderToStaticMarkup(createElement(KbSourcesNodeView, { node: { data: { turn: 1, citations: [citation] } } }))
    expect(html).toContain('font-size:13px')
    expect(html).toContain('line-height:22px')
  })
})

describe('inline fileLink label transform', () => {
  it('renders source docx name without .md or :line, keeping title for click routing', async () => {
    const { normalizeFileLinkLabels, sourceLabelForLink } = await import('../src/client/link-label.ts')
    expect(sourceLabelForLink('/workspace/kb/董事会议事规则（试行）.docx.md:193')).toBe('董事会议事规则（试行）.docx')
    expect(sourceLabelForLink('/workspace/kb/财务预测表.xlsx.md')).toBe('财务预测表.xlsx')
    document.body.innerHTML = '<button class="_fileLink_x" title="/workspace/kb/董事会议事规则（试行）.docx.md:193"><svg></svg>董事会议事规则（试行）.docx.md:193</button>'
    normalizeFileLinkLabels(document)
    const button = document.querySelector('button')!
    expect(button.textContent).toBe('董事会议事规则（试行）.docx')
    expect(button.getAttribute('title')).toBe('/workspace/kb/董事会议事规则（试行）.docx')
  })

})

describe('all derived Office/PDF labels', () => {
  it('maps every .md sibling to the source extension and strips line/page suffix', async () => {
    const { sourceLabelForLink } = await import('../src/client/link-label.ts')
    const cases: readonly [string, string][] = [
      ['/workspace/kb/a.docx.md:193', 'a.docx'],
      ['/workspace/kb/a.doc.md', 'a.doc'],
      ['/workspace/kb/a.xlsx.md', 'a.xlsx'],
      ['/workspace/kb/a.xls.md', 'a.xls'],
      ['/workspace/kb/a.pptx.md', 'a.pptx'],
      ['/workspace/kb/a.ppt.md', 'a.ppt'],
      ['/workspace/kb/a.pdf.md:7', 'a.pdf'],
      ['/workspace/kb/a.md:12', 'a.md:第12行'],
    ]
    for (const [value, label] of cases) expect(sourceLabelForLink(value)).toBe(label)
  })
})

describe('inline chunk identity labels', () => {
  it('uses 文件名:第N块 for a chunk and never exposes the raw chunk key', async () => {
    const { sourceLabelForLink } = await import('../src/client/link-label.ts')
    expect(sourceLabelForLink('/workspace/kb/a.docx.md', '335')).toBe('a.docx')
    expect(sourceLabelForLink('/workspace/kb/a.docx.md', '335', undefined, 4)).toBe('a.docx:第5块')
    expect(sourceLabelForLink('/workspace/kb/a.docx.md', undefined, 193)).toBe('a.docx')
    expect(sourceLabelForLink('/workspace/kb/a.docx.md', undefined, undefined, 0)).toBe('a.docx:第1块')
    expect(sourceLabelForLink('/workspace/kb/a.docx.md', undefined, undefined, 4)).toBe('a.docx:第5块')
  })

  it('normalizes two links of the same file to distinct block labels', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { chunkId: number }
      return Promise.resolve(new Response(JSON.stringify({
        path: 'global/a.docx', chunkId: body.chunkId, chunkOrdinal: body.chunkId - 331, boxes: [],
      }), { status: 200 }))
    }))
    document.body.innerHTML = [
      '<button class="_fileLink_x" title="kb://doc/49/chunk/335?path=%2Fworkspace%2Fkb%2Fa.docx.md">a.docx.md</button>',
      '<button class="_fileLink_x" title="kb://doc/49/chunk/336?path=%2Fworkspace%2Fkb%2Fa.docx.md">a.docx.md</button>',
    ].join('')
    normalizeFileLinkLabels(document)
    await new Promise(resolve => setTimeout(resolve, 80))
    const labels = [...document.querySelectorAll('button')].map(button => button.textContent)
    expect(labels).toEqual(['a.docx:第5块', 'a.docx:第6块'])
    vi.unstubAllGlobals()
  })
})

describe('resolve API for inline .docx.md:line', () => {
  it('posts path+line and maps chunkOrdinal/path/quote/boxes', async () => {
    const { fetchResolve, resolveOpenTarget } = await import('../src/client/citation-view.ts')
    const payload = JSON.stringify({
      path: 'global/规则.docx', chunkId: 335, chunkOrdinal: 5, quote: '第二条 经营班子会',
      boxes: [{ page: 1, bbox: '[0.1,0.2,0.3,0.4]' }],
    })
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(payload, { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    const resolved = await fetchResolve('global/规则.docx.md', 73)
    expect(fetchMock).toHaveBeenCalledWith('/knowledge-base/api/resolve', expect.objectContaining({ method: 'POST', body: JSON.stringify({ path: 'global/规则.docx.md', line: 73 }) }))
    expect(resolved?.path).toBe('/workspace/kb/global/规则.docx')
    expect(resolved?.chunkOrdinal).toBe(5)
    expect(resolved?.groups).toEqual([{ page: 1, boxes: [[0.1, 0.2, 0.3, 0.4]] }])
    const citation = (await import('../src/shared/citation.ts')).parseCitationToken('/workspace/kb/global/规则.docx.md:73')!
    const target = await resolveOpenTarget(citation)
    expect(target?.path).toBe('/workspace/kb/global/规则.docx')
    expect(target?.options.chunkOrdinal).toBe(5)
    expect(target?.citation.quote).toBe('第二条 经营班子会')
    vi.unstubAllGlobals()
  })

  it('updates an Office fileLink label to 第N块 from resolve', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ path: 'global/规则.docx', chunkOrdinal: 4, boxes: [] }), { status: 200 })))
    document.body.innerHTML = '<button class="_fileLink_x" title="/workspace/kb/global/规则.docx.md:73">规则.docx.md:73</button>'
    normalizeFileLinkLabels(document)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(document.querySelector('button')?.textContent).toBe('规则.docx:第5块')
    vi.unstubAllGlobals()
  })

  it('keeps text line format as 第73行', async () => {
    const { sourceLabelForLink } = await import('../src/client/link-label.ts')
    expect(sourceLabelForLink('/workspace/kb/说明.txt:73')).toBe('说明.txt:第73行')
  })
})

describe('resolve path spelling', () => {
  it('strips /workspace/kb before calling resolve', async () => {
    const { fetchResolve } = await import('../src/client/citation-view.ts')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ path: 'global/a.docx', chunkOrdinal: 2, boxes: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchResolve('/workspace/kb/global/a.docx.md', 7)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ path: 'global/a.docx.md', line: 7 })
    vi.unstubAllGlobals()
  })
})

describe('bare kb:// inline label', () => {
  it('resolves kb token to filename:第N块 and never leaves the token visible', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      path: 'global/规则.docx', chunkId: 335, chunkOrdinal: 4, boxes: [],
    }), { status: 200 }))))
    document.body.innerHTML = '<button class="_fileLink_x" title="kb://doc/49/chunk/335">kb://doc/49/chunk/335</button>'
    normalizeFileLinkLabels(document)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(document.querySelector('button')?.textContent).toBe('规则.docx:第5块')
    vi.unstubAllGlobals()
  })
})

describe('chunk API paragraphs', () => {
  it('returns all paragraph texts and chunkOrdinal 0', async () => {
    const { fetchChunkGroups } = await import('../src/client/citation-view.ts')
    const paragraphs = Array.from({ length: 12 }, (_, index) => ({ ordinal: index, text: '段落' + String(index + 1) }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: 'global/规则.docx', chunkId: 335, chunkOrdinal: 0, chunkText: '段落1 段落2', paragraphs, boxes: [],
    }), { status: 200 })))
    const chunk = await fetchChunkGroups('49', '335')
    expect(chunk?.chunkOrdinal).toBe(0)
    expect(chunk?.paragraphs).toHaveLength(12)
    expect(chunk?.chunkText).toContain('段落1')
    vi.unstubAllGlobals()
  })
})

describe('xlsx resolve target', () => {
  it('carries sheet/cell into opener options from resolve', async () => {
    const { parseCitationToken } = await import('../src/shared/citation.ts')
    const { resolveOpenTarget } = await import('../src/client/citation-view.ts')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: 'global/报表.xlsx', chunkOrdinal: 2, sheet: '财务预测', cell: 'F14', boxes: [],
    }), { status: 200 })))
    const target = await resolveOpenTarget(parseCitationToken('/workspace/kb/global/报表.xlsx.md:20')!)
    expect(target?.options).toMatchObject({ sheet: '财务预测', cell: 'F14' })
    expect(target?.path).toBe('/workspace/kb/global/报表.xlsx')
    vi.unstubAllGlobals()
  })
})

describe('kb token carried by link attributes', () => {
  it('normalizes a plain anchor href with no fileLink class', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      path: 'global/附件2.docx', chunkId: 375, chunkOrdinal: 0, boxes: [],
    }), { status: 200 }))))
    document.body.innerHTML = '<a href="kb://doc/55/chunk/375">kb://doc/55/chunk/375</a>'
    normalizeFileLinkLabels(document)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(document.querySelector('a')?.textContent).toBe('附件2.docx:第1块')
    expect(document.querySelector('a')?.textContent).not.toContain('kb://')
    vi.unstubAllGlobals()
  })

  it('normalizes a button title with no fileLink class', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      path: 'global/附件2.docx', chunkId: 375, chunkOrdinal: 0, boxes: [],
    }), { status: 200 }))))
    document.body.innerHTML = '<button title="kb://doc/55/chunk/375">kb://doc/55/chunk/375</button>'
    normalizeFileLinkLabels(document)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(document.querySelector('button')?.textContent).toBe('附件2.docx:第1块')
    vi.unstubAllGlobals()
  })
})

describe('bare prose and inline-code tokens', () => {
  it('renders every bare token as 文件名:第N块 instead of leaving the URL visible', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { chunkId: number }
      return Promise.resolve(new Response(JSON.stringify({
        path: 'global/规则.docx', chunkId: body.chunkId, chunkOrdinal: body.chunkId - 1, boxes: [],
      }), { status: 200 }))
    }))
    const root = document.createElement('div')
    root.innerHTML = '<p>甲 kb://doc/49/chunk/1 乙 <code>kb://doc/49/chunk/2</code></p><a href="kb://doc/49/chunk/3">旧链接</a>'
    document.body.innerHTML = ''; document.body.appendChild(root)
    normalizeFileLinkLabels(root)
    await new Promise(resolve => setTimeout(resolve, 120))
    // Prose and inline code each become one anchor; the existing anchor keeps its place.
    expect(root.querySelectorAll('p a')).toHaveLength(2)
    expect(root.querySelectorAll('code a')).toHaveLength(1)
    const labels = [...root.querySelectorAll('a')].map(anchor => anchor.textContent)
    expect(labels).toEqual(['规则.docx:第1块', '规则.docx:第2块', '规则.docx:第3块'])
    expect(root.textContent).not.toContain('kb://doc/')
    vi.unstubAllGlobals()
  })

  it('does not cut a bare token at its query hints', async () => {
    const { parseCitationToken, parseCitations } = await import('../src/shared/citation.ts')
    const token = 'kb://doc/51/chunk/e63b7f9eda2d86cb?terms=' + encodeURIComponent('董事会,表决')
    expect(parseCitationToken(token)?.chunkId).toBe('e63b7f9eda2d86cb')
    expect(parseCitations('见 ' + token + '。')).toHaveLength(1)
    expect(parseCitationToken('kb://doc/49/chunk/335。')?.chunkId).toBe('335')
  })

  it('never parses a token prefix while the markdown block is still streaming', async () => {
    const { normalizeCitationLinks } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      path: 'global/规则.docx', chunkId: 'ff91bfe0381a4bc0', chunkOrdinal: 7, boxes: [],
    }), { status: 200 }))))
    document.body.innerHTML = [
      '<div data-chat-flow-kind="assistant-step"><div data-streaming="true">',
      '<p>来源 `kb://doc/145/chunk/ff91bfe0381</p>',
      '</div></div>',
    ].join('')
    normalizeCitationLinks(document)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(document.querySelectorAll('a[href*="kb://doc/"]')).toHaveLength(0)
    expect(document.body.textContent).toContain('kb://doc/145/chunk/ff91bfe0381')

    // Once the stream settles the full token is present and may be rewritten.
    document.body.innerHTML = [
      '<div data-chat-flow-kind="assistant-step"><div data-streaming="true">',
      '<p>来源 `<code>kb://doc/145/chunk/ff91bfe0381a4bc0</code>`</p>',
      '</div></div>',
    ].join('')
    normalizeCitationLinks(document)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(document.querySelectorAll('[data-kb-citation-token]')).toHaveLength(0)

    document.querySelector('[data-streaming]')?.removeAttribute('data-streaming')
    normalizeCitationLinks(document)
    await new Promise(resolve => setTimeout(resolve, 80))
    const chip = document.querySelector('[data-kb-citation-token]')
    expect(chip?.textContent).toBe('规则.docx:第8块')
    vi.unstubAllGlobals()
  })
})

describe('token priority over legacy paths', () => {
  it('reads data-kb-citation-token before a legacy title and resolves the chunk', async () => {
    const { fileLinkValue, citationFromClickTarget } = await import('../src/client/link-label.ts')
    const token = 'kb://doc/49/chunk/e63b7f9eda2d86cb'
    document.body.innerHTML = '<button class="o3BgMG_fileLink" data-kb-citation-token="' + token + '" title="/workspace/kb/global/规则.docx.md:193">旧标签</button>'
    const button = document.querySelector('button')!
    expect(fileLinkValue(button)).toBe(token)
    expect(citationFromClickTarget(button)).toMatchObject({ kind: 'kb', docId: '49', chunkId: 'e63b7f9eda2d86cb' })
  })

  it('renders one chunk as the same 文件名:第N块 in answer and GenUI', async () => {
    const { normalizeCitationLinks } = await import('../src/client/link-label.ts')
    const { sourceFileName } = await import('../src/client/kb-sources.tsx')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      path: 'global/规则.docx', chunkId: '335', chunkOrdinal: 4, boxes: [],
    }), { status: 200 }))))
    document.body.innerHTML = [
      '<div data-chat-flow-kind="assistant-step">',
      '<p>正文 kb://doc/49/chunk/335</p>',
      '<div data-genui-artifact="true"><div>依据 <button class="V1MMBW_inlineFileLink" title="&lt;/workspace/kb/规则.docx&gt;">打开原文</button> · kb://doc/49/chunk/335</div></div>',
      '</div>',
    ].join('')
    normalizeCitationLinks(document)
    await new Promise(resolve => setTimeout(resolve, 120))
    const labels = [...document.querySelectorAll('[data-kb-citation-token]')].map(element => element.textContent)
    expect(labels).toEqual(['规则.docx:第5块', '规则.docx:第5块'])
    expect(sourceFileName({
      raw: 'kb://doc/49/chunk/335', kind: 'kb', docId: '49', chunkId: '335', chunkOrdinal: 4,
      path: '/workspace/kb/global/规则.docx', label: 'KB 来源', title: '规则',
    })).toBe('规则.docx:第5块')
    vi.unstubAllGlobals()
  })
})

describe('stale chunk reference', () => {
  it('shows 引用已失效 instead of raw kb token when resolve returns 404', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })))
    document.body.innerHTML = '<a href="kb://doc/99/chunk/999">旧引用</a>'
    normalizeFileLinkLabels(document)
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(document.querySelector('a')?.textContent).toBe('引用已失效')
    expect(document.querySelector('a')?.textContent).not.toContain('kb://')
    vi.unstubAllGlobals()
  })
})

describe('angle-wrapped targets and GenUI tokens', () => {
  it('strips < > from kb token and path before resolving', async () => {
    const { parseCitationToken } = await import('../src/shared/citation.ts')
    const { resolveOpenTarget } = await import('../src/client/citation-view.ts')
    const token = parseCitationToken('<kb://doc/51/chunk/99>')!
    expect(token.chunkId).toBe('99')
    const path = parseCitationToken('</workspace/kb/global/a.docx>')!
    expect(path.path).toBe('/workspace/kb/global/a.docx')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ path: 'global/a.docx', chunkOrdinal: 1, boxes: [] }), { status: 200 })))
    await expect(resolveOpenTarget(path)).resolves.toMatchObject({ path: '/workspace/kb/global/a.docx' })
    vi.unstubAllGlobals()
  })

  it('turns a GenUI 打开原文 · kb:// button into a fileLink chip', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      path: 'global/规则.docx', chunkId: 51, chunkOrdinal: 1, boxes: [],
    }), { status: 200 }))))
    const root = document.createElement('div')
    root.innerHTML = '<button>打开原文 · kb://doc/51/chunk/99</button>'
    document.body.innerHTML = ''; document.body.appendChild(root)
    normalizeFileLinkLabels(root)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(root.querySelector('button')?.textContent).toBe('规则.docx:第2块')
    expect(root.querySelector('button')?.getAttribute('title')).toBe('kb://doc/51/chunk/99')
    vi.unstubAllGlobals()
  })
})

describe('GenUI 打开原文 plain text', () => {
  it('turns only 打开原文 · kb:// into an anchor and labels it', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      path: 'global/规则.docx', chunkId: 51, chunkOrdinal: 1, boxes: [],
    }), { status: 200 }))))
    const root = document.createElement('div')
    root.innerHTML = '<p>条款说明 打开原文 · kb://doc/51/chunk/99 结尾</p>'
    document.body.innerHTML = ''; document.body.appendChild(root)
    normalizeFileLinkLabels(root)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(root.querySelector('a')?.textContent).toBe('规则.docx:第2块')
    expect(root.querySelector('p')?.textContent).toContain('规则.docx:第2块')
    vi.unstubAllGlobals()
  })
})

describe('GenUI inlineFileLink with sibling token', () => {
  it('takes token from sibling, strips title angles, updates button and removes raw token', async () => {
    const { normalizeFileLinkLabels, fileLinkValue } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      path: 'global/0911规则.docx', chunkId: 99, chunkOrdinal: 1, boxes: [],
    }), { status: 200 }))))
    const root = document.createElement('div')
    root.innerHTML = '<div data-genui-artifact="true"><div class="V1MMBW_liDesc">说明 <button class="V1MMBW_inlineFileLink" title="&lt;/workspace/kb/global/0911规则.docx&gt;">打开原文</button> · kb://doc/52/chunk/100</div></div>'
    document.body.innerHTML = ''; document.body.appendChild(root)
    const card = root.querySelector('[data-genui-artifact="true"]')!
    normalizeFileLinkLabels(card)
    await new Promise(resolve => setTimeout(resolve, 120))
    const button = card.querySelector('button')!
    expect(button.textContent).toBe('0911规则.docx:第2块')
    expect(button.querySelector('.kb-citation-fileicon')).toBeNull()
    expect(button.querySelector('.kb-citation-suffix')?.textContent).toBe(':第2块')
    expect(button.getAttribute('title')).toBe('/workspace/kb/global/0911规则.docx')
    expect(card.textContent).not.toContain('kb://doc/')
    expect(fileLinkValue(button)).toBe('kb://doc/52/chunk/100')
    vi.unstubAllGlobals()
  })
})

describe('real GenUI card with a hex chunk key', () => {
  it('rewrites the button, removes the sibling token, strips title angles, and routes the click by token', async () => {
    const { normalizeCitationLinks, citationFromClickTarget, fileLinkValue } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: 'global/0911规则.docx', chunkId: 'e63b7f9eda2d86cb', chunkOrdinal: 6, boxes: [],
    }), { status: 200 })))
    const root = document.createElement('div')
    root.innerHTML = '<div data-genui-artifact="true"><div data-genui="true"><div class="V1MMBW_liDesc">依据 <button class="V1MMBW_inlineFileLink" title="&lt;/workspace/kb/global/0911规则.docx&gt;">打开原文</button> · kb://doc/51/chunk/e63b7f9eda2d86cb</div></div></div>'
    document.body.innerHTML = ''
    document.body.appendChild(root)
    normalizeCitationLinks(document)
    const button = root.querySelector('button')!
    // The click target is pinned synchronously; the visible label upgrades after the chunk fetch.
    expect(button.dataset.kbCitationToken).toBe('kb://doc/51/chunk/e63b7f9eda2d86cb')
    expect(root.textContent).not.toContain('kb://doc/')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(button.textContent).toBe('0911规则.docx:第7块')
    expect(button.getAttribute('title')).toBe('/workspace/kb/global/0911规则.docx')
    expect(root.textContent).not.toContain('kb://doc/')
    expect(fileLinkValue(button)).toBe('kb://doc/51/chunk/e63b7f9eda2d86cb')
    expect(citationFromClickTarget(button)).toMatchObject({
      kind: 'kb', docId: '51', chunkId: 'e63b7f9eda2d86cb',
    })
    vi.unstubAllGlobals()
  })

  it('normalizes a GenUI card mounted after install, with no source panel present', async () => {
    const { installCitationLinkNormalizer } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: 'global/0911规则.docx', chunkOrdinal: 6, boxes: [],
    }), { status: 200 })))
    document.body.innerHTML = ''
    const dispose = installCitationLinkNormalizer(document)
    const card = document.createElement('div')
    card.innerHTML = '<div data-genui-artifact="true"><div data-genui="true"><div class="V1MMBW_liDesc">依据 <button class="V1MMBW_inlineFileLink" title="&lt;/workspace/kb/global/0911规则.docx&gt;">打开原文</button> · kb://doc/51/chunk/e63b7f9eda2d86cb</div></div></div>'
    document.body.appendChild(card)
    await new Promise(resolve => setTimeout(resolve, 240))
    expect(card.querySelector('button')?.textContent).toBe('0911规则.docx:第7块')
    expect(card.textContent).not.toContain('kb://doc/')
    dispose()
    vi.unstubAllGlobals()
  })

  it('never rewrites a token quoted in a user prompt', async () => {
    const { normalizeCitationLinks } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: 'global/0911规则.docx', chunkOrdinal: 0, boxes: [],
    }), { status: 200 })))
    document.body.innerHTML = [
      '<div data-chat-flow-kind="user-step"><p>请解释 打开原文 · kb://doc/51/chunk/e63b7f9eda2d86cb</p></div>',
      '<div data-chat-flow-kind="assistant-step"><div data-genui-artifact="true"><div data-genui="true"><div class="V1MMBW_liDesc">依据 <button class="V1MMBW_inlineFileLink" title="&lt;/workspace/kb/global/0911规则.docx&gt;">打开原文</button> · kb://doc/51/chunk/e63b7f9eda2d86cb</div></div></div></div>',
    ].join('')
    normalizeCitationLinks(document)
    const prompt = document.querySelector('[data-chat-flow-kind="user-step"]')!
    expect(prompt.textContent).toBe('请解释 打开原文 · kb://doc/51/chunk/e63b7f9eda2d86cb')
    expect(prompt.querySelector('a')).toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('hex chunk key transport', () => {
  it('posts a chunk_key as a string so the endpoint can look it up', async () => {
    const { fetchChunkGroups } = await import('../src/client/citation-view.ts')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: '/workspace/kb/global/0911规则.docx', chunkId: 'e63b7f9eda2d86cb', chunkOrdinal: 6, boxes: [],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchChunkGroups('51', 'e63b7f9eda2d86cb')).resolves.toMatchObject({ path: '/workspace/kb/global/0911规则.docx' })
    expect(fetchMock).toHaveBeenCalledWith('/knowledge-base/api/chunk', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ docId: 51, chunkId: 'e63b7f9eda2d86cb' }),
    }))
    vi.unstubAllGlobals()
  })
})


describe('native fileLink styling', () => {
  it('renders the official paper glyph and muted :第13块 suffix for an xlsx inlineFileLink', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: 'global/财务预测表.xlsx', chunkOrdinal: 12, boxes: [],
    }), { status: 200 })))
    const root = document.createElement('div')
    root.innerHTML = '<div data-genui-artifact="true"><div>说明 <button class="V1MMBW_inlineFileLink" title="&lt;/workspace/kb/global/财务预测表.xlsx&gt;">打开原文</button> · kb://doc/53/chunk/101</div></div>'
    document.body.innerHTML = ''; document.body.appendChild(root)
    normalizeFileLinkLabels(root.querySelector('[data-genui-artifact="true"]')!)
    await new Promise(resolve => setTimeout(resolve, 120))
    const button = root.querySelector('button')!
    expect(button.textContent).toBe('财务预测表.xlsx:第13块')
    expect(button.classList.contains('kb-citation-file-link')).toBe(true)
    expect(button.querySelector('.kb-citation-fileicon')).toBeNull()
    expect(button.querySelector('svg.kb-citation-file-link-icon')?.getAttribute('data-kb-file-kind')).toBe('document')
    expect(button.querySelector('.kb-citation-filename')?.textContent).toBe('财务预测表.xlsx')
    expect(button.querySelector('.kb-citation-suffix')?.textContent).toBe(':第13块')
    expect(button.getAttribute('style')).toBeNull()
    vi.unstubAllGlobals()
  })

  it('copies the official MarkdownFileLink class list when the card already has one', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: 'global/0911规则.docx', chunkOrdinal: 12, boxes: [],
    }), { status: 200 })))
    const root = document.createElement('div')
    root.innerHTML = [
      '<div data-genui-artifact="true">',
      '<button class="o3BgMG_fileMention o3BgMG_fileLink">官方附件</button>',
      '<div class="V1MMBW_liDesc">依据 <button class="V1MMBW_inlineFileLink" title="&lt;/workspace/kb/global/0911规则.docx&gt;">打开原文</button> · kb://doc/51/chunk/e63b7f9eda2d86cb</div>',
      '</div>',
    ].join('')
    document.body.innerHTML = ''; document.body.appendChild(root)
    normalizeFileLinkLabels(root.querySelector('[data-genui-artifact="true"]')!)
    await new Promise(resolve => setTimeout(resolve, 120))
    const button = root.querySelector<HTMLElement>('button[data-kb-citation-token]')!
    expect(button.classList.contains('o3BgMG_fileMention')).toBe(true)
    expect(button.classList.contains('o3BgMG_fileLink')).toBe(true)
    expect(button.classList.contains('kb-citation-file-link')).toBe(true)
    expect(button.querySelector('svg.kb-citation-file-link-icon')).not.toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('office path + chunkId provenance', () => {
  it('carries chunkText/paragraphs/chunkOrdinal into the citation branch', async () => {
    const { resolveOpenTarget } = await import('../src/client/citation-view.ts')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: 'global/rule.docx', chunkOrdinal: 6, chunkText: '完整块文本',
      paragraphs: [{ ordinal: 0, text: '第一段' }], boxes: [],
    }), { status: 200 })))
    const target = await resolveOpenTarget({
      raw: 'kb://doc/51/chunk/e63b7f9eda2d86cb', kind: 'kb', docId: '51', chunkId: 'e63b7f9eda2d86cb',
      path: '/workspace/kb/global/rule.docx',
    })
    expect(target?.citation).toMatchObject({ chunkText: '完整块文本', chunkOrdinal: 6 })
    expect(target?.citation.paragraphs).toHaveLength(1)
    expect(target?.options.chunkOrdinal).toBe(6)
    vi.unstubAllGlobals()
  })
})

describe('host fileLink without title/href', () => {
  it('uses path-shaped text as target and strips .docx.md to .docx', async () => {
    const { normalizeFileLinkLabels, fileLinkValue } = await import('../src/client/link-label.ts')
    document.body.innerHTML = '<button class="o3BgMG_fileLink">kb/global/rag-eval-fixtures/制度.docx.md</button>'
    const button = document.querySelector('button')!
    expect(fileLinkValue(button)).toBe('/workspace/kb/global/rag-eval-fixtures/制度.docx.md')
    normalizeFileLinkLabels(document)
    expect(button.textContent).toBe('制度.docx')
  })

  it('strips a .docx.md title from _fileMention and keeps no fake block number', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    document.body.innerHTML = '<button class="_fileMention_1ypvv_85 _fileLink_1ypvv_59" title="global/制度.docx.md">制度.docx.md</button>'
    const button = document.querySelector('button')!
    normalizeFileLinkLabels(document)
    expect(button.textContent).toBe('制度.docx')
  })

  it('resolves a path text with :line to the owning chunk block suffix', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ chunkOrdinal: 4, boxes: [] }), { status: 200 })))
    document.body.innerHTML = '<button class="o3BgMG_fileLink">kb/global/制度.docx.md:166</button>'
    normalizeFileLinkLabels(document)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(document.querySelector('button')?.textContent).toBe('制度.docx:第5块')
    vi.unstubAllGlobals()
  })
})

describe('host fileLink click target', () => {
  it('maps path-only .docx.md button to the original docx on click', async () => {
    const { citationFromClickTarget } = await import('../src/client/link-label.ts')
    const { resolveOpenTarget } = await import('../src/client/citation-view.ts')
    document.body.innerHTML = '<button class="o3BgMG_fileLink">kb/global/制度.docx.md</button>'
    const citation = citationFromClickTarget(document.querySelector('button'))!
    expect(citation?.path).toBe('/workspace/kb/global/制度.docx.md')
    const target = await resolveOpenTarget(citation!)
    expect(target?.path).toBe('/workspace/kb/global/制度.docx')
  })
})

describe('tool-call result fileLink', () => {
  it('normalizes a .docx.md button inside data-slot tool.call.toolview', async () => {
    const { normalizeCitationLinks, citationFromClickTarget } = await import('../src/client/link-label.ts')
    document.body.innerHTML = '<div data-slot="tool.call.toolview" data-tool="read" data-variant="read" data-state="ok"><div data-disclosure-row><span class="_root_1rdzk_1"><span class="_content_1rdzk_11"><button class="o3BgMG_fileLink">kb/global/rag-eval-fixtures/制度.docx.md</button></span></span></div></div>'
    const button = document.querySelector('button')!
    normalizeCitationLinks(document)
    expect(button.textContent).toBe('制度.docx')
    expect(citationFromClickTarget(button)?.path).toBe('/workspace/kb/global/rag-eval-fixtures/制度.docx.md')
  })
})

/**
 * A cited physical line lands on an unrelated chunk unless two things hold:
 * the resolved chunk text contains that line, and the label/click carry the same chunkId.
 *
 * Regression shape: 经营班子会议事规则.docx.md:137 (第十五条) resolved to chunk ordinal 8
 * (第二十一条/第二十二条) because the index stores paragraph ordinals in `kb_chunks.line`.
 */
describe('citation line verification and chunk identity', () => {
  const LINE = '第十五条 会议审议事项，以赞成人数超过应出席人数的二分之一方可通过。'
  const WRONG = '第二十二条 经营班子会议决定的事项，应由分管领导按照分工和职责组织实施。'

  /** Source text whose line 137 is LINE; lines 1..136 hold 68 non-empty paragraphs. */
  function sourceAt137(): string {
    const lines: string[] = []
    for (let index = 1; index < 137; index += 1) lines.push(index % 2 === 1 ? '填充段落' + String(index) : '')
    lines.push(LINE)
    return lines.join('\n')
  }

  function provenance(ordinal: number, key: string, chunkText: string): string {
    return JSON.stringify({
      docId: 49, chunkId: 25863 + ordinal, chunkKey: key, chunkOrdinal: ordinal,
      path: 'global/规则.docx', chunkText, quote: chunkText.slice(0, 40), boxes: [],
    })
  }

  function mockResolve(options: { retryText?: string; retryOrdinal?: number; retryKey?: string } = {}): ReturnType<typeof vi.fn> {
    const source = sourceAt137()
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const href = String(url)
      if (href.endsWith('/knowledge-base/api/resolve')) {
        const body = JSON.parse(String(init?.body)) as { line?: number }
        if (body.line === 69) {
          return Promise.resolve(new Response(provenance(options.retryOrdinal ?? 6, options.retryKey ?? '1fe09e0dbfb4184d', options.retryText ?? LINE), { status: 200 }))
        }
        return Promise.resolve(new Response(provenance(8, 'wrongchunk', WRONG), { status: 200 }))
      }
      if (href.endsWith('/knowledge-base/api/read')) {
        return Promise.resolve(new Response(JSON.stringify({ kind: 'text', content: source }), { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  beforeEach(async () => {
    const { clearLabelCaches } = await import('../src/client/link-label.ts')
    clearLabelCaches()
  })

  it('retries in the paragraph-ordinal space and returns the chunk that owns the line', async () => {
    const fetchMock = mockResolve()
    const { fetchResolve } = await import('../src/client/citation-view.ts')
    const resolved = await fetchResolve('/workspace/kb/global/规则.docx.md', 137)
    expect(resolved?.chunkOrdinal).toBe(6)
    expect(resolved?.chunkKey).toBe('1fe09e0dbfb4184d')
    const lines = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/resolve'))
      .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { line: number }).line)
    expect(lines).toEqual([137, 69])
  })

  it('rejects both lookups when neither chunk contains the cited line', async () => {
    mockResolve({ retryText: WRONG, retryOrdinal: 8, retryKey: 'wrongchunk' })
    const { fetchResolve } = await import('../src/client/citation-view.ts')
    await expect(fetchResolve('/workspace/kb/global/规则.docx.md', 137)).resolves.toBeUndefined()
  })

  it('stamps the label and click with the same verified chunk token', async () => {
    mockResolve()
    const { normalizeFileLinkLabels, citationFromClickTarget } = await import('../src/client/link-label.ts')
    document.body.innerHTML = '<button class="_fileLink_x" title="/workspace/kb/global/规则.docx.md:137">规则.docx.md:137</button>'
    normalizeFileLinkLabels(document)
    await new Promise(resolve => setTimeout(resolve, 120))
    const button = document.querySelector('button')!
    expect(button.textContent).toBe('规则.docx:第7块')
    expect(button.dataset.kbCitationToken).toBe('kb://doc/49/chunk/1fe09e0dbfb4184d')
    expect(citationFromClickTarget(button)?.chunkId).toBe('1fe09e0dbfb4184d')
  })

  it('shows 引用已失效 and blocks the click when no chunk proves the line', async () => {
    mockResolve({ retryText: WRONG, retryOrdinal: 8, retryKey: 'wrongchunk' })
    const { normalizeFileLinkLabels, citationFromClickTarget } = await import('../src/client/link-label.ts')
    document.body.innerHTML = '<button class="_fileLink_x" title="/workspace/kb/global/规则.docx.md:137">规则.docx.md:137</button>'
    normalizeFileLinkLabels(document)
    await new Promise(resolve => setTimeout(resolve, 120))
    const button = document.querySelector('button')!
    expect(button.textContent).toBe('引用已失效')
    expect(button.dataset.kbCitationInvalid).toBe('true')
    expect(citationFromClickTarget(button)).toBeUndefined()
  })
})

describe('line fragment citations', () => {
  it('parses #L73/#L73-L80 and :193 into path+line', async () => {
    const { parseCitationToken } = await import('../src/shared/citation.ts')
    expect(parseCitationToken('global/a.docx.md#L73')).toMatchObject({ path: '/workspace/kb/global/a.docx.md', line: 73 })
    expect(parseCitationToken('global/a.docx.md#L73-L80')).toMatchObject({ line: 73 })
    expect(parseCitationToken('global/a.docx.md:193')).toMatchObject({ line: 193 })
    expect(parseCitationToken('kb://doc/49/chunk/1fe0')).toMatchObject({ docId: '49', chunkId: '1fe0' })
  })

  it('maps #L73, #L257, :193 and token to original docx', async () => {
    const { parseCitationToken } = await import('../src/shared/citation.ts')
    const { resolveOpenTarget } = await import('../src/client/citation-view.ts')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ path: 'global/a.docx', chunkOrdinal: 2, boxes: [] }), { status: 200 }))))
    for (const raw of ['global/a.docx.md#L73', 'global/a.docx.md#L257', 'global/a.docx.md:193', 'kb://doc/49/chunk/1fe0']) {
      const target = await resolveOpenTarget(parseCitationToken(raw)!)
      expect(target?.path).toBe('/workspace/kb/global/a.docx')
    }
    vi.unstubAllGlobals()
  })

  it('labels #L73 as source filename:第5块 after resolve', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ chunkOrdinal: 4, boxes: [] }), { status: 200 })))
    document.body.innerHTML = '<button class="_fileLink_x" title="global/a.docx.md#L73">a.docx.md#L73</button>'
    normalizeFileLinkLabels(document)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(document.querySelector('button')?.textContent).toBe('a.docx:第5块')
    vi.unstubAllGlobals()
  })
})

describe('hover title source path', () => {
  it('removes .docx.md and #L from title while click still uses the cached target', async () => {
    const { normalizeFileLinkLabels, fileLinkValue } = await import('../src/client/link-label.ts')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ chunkOrdinal: 4, boxes: [] }), { status: 200 })))
    document.body.innerHTML = '<button class="_fileLink_x" title="/workspace/kb/a.docx.md#L73">a.docx.md#L73</button>'
    const button = document.querySelector('button')!
    normalizeFileLinkLabels(document)
    expect(button.getAttribute('title')).toBe('/workspace/kb/a.docx')
    expect(button.getAttribute('aria-label')).not.toContain('.md')
    expect(fileLinkValue(button)).toBe('/workspace/kb/a.docx.md#L73')
    vi.unstubAllGlobals()
  })
})

describe('same-document resolve batching', () => {
  const SOURCE = '第一条\n第二条\n第三条'
  const CHUNK = {
    path: 'global/制度.docx', chunkId: 335, chunkKey: 'chunk-335', chunkOrdinal: 4,
    lineStart: 1, lineEnd: 3, chunkText: SOURCE, boxes: [],
  }

  /**
   * A fetch double that answers `/read` and `/resolve` with separate Response objects.
   *
   * `mockResolvedValue(new Response(...))` cannot be reused across two requests: the second
   * `json()` throws "Body is unusable", which looks like a resolve failure in the caller.
   */
  function citationFetch() {
    const calls: string[] = []
    const mock = vi.fn(async (url: string) => {
      calls.push(url)
      const body = url === '/knowledge-base/api/read'
        ? { kind: 'text', content: SOURCE }
        : CHUNK
      return new Response(JSON.stringify(body), { status: 200 })
    })
    return { mock, calls }
  }

  it('answers a second cited line from the resolved chunk without another resolve', async () => {
    const { fetchResolve } = await import('../src/client/citation-view.ts')
    const { mock, calls } = citationFetch()
    vi.stubGlobal('fetch', mock)

    const first = await fetchResolve('global/制度.docx.md', 1)
    const second = await fetchResolve('global/制度.docx.md', 2)

    expect(first?.chunkOrdinal).toBe(4)
    expect(second?.chunkOrdinal).toBe(4)
    expect(calls.filter(url => url === '/knowledge-base/api/resolve')).toHaveLength(1)
    expect(calls.filter(url => url === '/knowledge-base/api/read')).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('labels three citations of one chunk with one resolve and one read', async () => {
    const { normalizeFileLinkLabels } = await import('../src/client/link-label.ts')
    const { mock, calls } = citationFetch()
    vi.stubGlobal('fetch', mock)
    document.body.innerHTML = [
      '<button class="_fileLink_x" title="global/制度.docx.md:1">制度.docx.md:1</button>',
      '<button class="_fileLink_x" title="global/制度.docx.md:2">制度.docx.md:2</button>',
      '<button class="_fileLink_x" title="global/制度.docx.md:3">制度.docx.md:3</button>',
    ].join('')

    normalizeFileLinkLabels(document)
    await new Promise(resolve => setTimeout(resolve, 150))

    expect([...document.querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['制度.docx:第5块', '制度.docx:第5块', '制度.docx:第5块'])
    expect(calls.filter(url => url === '/knowledge-base/api/resolve')).toHaveLength(1)
    expect(calls.filter(url => url === '/knowledge-base/api/read')).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('records a citation-resolve mark on the opt-in timeline', async () => {
    const { fetchResolve } = await import('../src/client/citation-view.ts')
    const { citationTimingEvents, resetCitationTiming } = await import('../src/client/timing.ts')
    const { mock } = citationFetch()
    vi.stubGlobal('fetch', mock)
    vi.stubGlobal('__KB_CITATION_TIMING__', true)
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    resetCitationTiming()

    await fetchResolve('global/制度.docx.md', 1)

    const marks = citationTimingEvents().filter(event => event.name === 'citation-resolve')
    expect(marks).toHaveLength(1)
    expect(marks[0]?.detail).toContain('global/制度.docx.md:1')
    debug.mockRestore()
    vi.unstubAllGlobals()
    resetCitationTiming()
  })

  it('still resolves every line when the citations fall in different chunks', async () => {
    const { fetchResolve } = await import('../src/client/citation-view.ts')
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      if (url === '/knowledge-base/api/read') return new Response(JSON.stringify({ kind: 'text', content: SOURCE }), { status: 200 })
      return new Response(JSON.stringify({ ...CHUNK, lineStart: 1, lineEnd: 1, chunkOrdinal: 1 }), { status: 200 })
    }))

    await fetchResolve('global/制度.docx.md', 1)
    await fetchResolve('global/制度.docx.md', 2)

    expect(calls.filter(url => url === '/knowledge-base/api/resolve')).toHaveLength(2)
    vi.unstubAllGlobals()
  })
})
