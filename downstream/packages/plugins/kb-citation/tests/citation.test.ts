import { describe, expect, it, vi } from 'vitest'
import {
  openCitation, openOptionsOf, parseBoxes, parseCitations, parseCitationToken, safeKbPath,
} from '../src/shared/citation.ts'

describe('knowledge-base citation tokens', () => {
  it('parses a canonical kb token with page, boxes, path, quote and heading', () => {
    const token = 'kb://doc/doc-1/chunk/chunk-9?path=' + encodeURIComponent('/workspace/kb/global/a.pdf') + '&page=3&boxes=0.1,0.2,0.5,0.4&heading=' + encodeURIComponent('第三章') + '&quote=' + encodeURIComponent('总则')
    const citation = parseCitationToken(token)
    expect(citation).toMatchObject({
      kind: 'kb', docId: 'doc-1', chunkId: 'chunk-9', path: '/workspace/kb/global/a.pdf',
      page: 3, heading: '第三章', quote: '总则',
      boxes: [[0.1, 0.2, 0.5, 0.4]],
    })
    expect(citation?.title).toContain('第三章')
  })

  it('parses search match terms and highlight ranges from the token', () => {
    const token = 'kb://doc/51/chunk/87d?terms=' + encodeURIComponent('董事会议事规则,通过')
      + '&highlight=' + encodeURIComponent('低空公司董事会议事规则的制定和修改')
      + '&ranges=' + encodeURIComponent('[[4,11],[18,20]]')
    const citation = parseCitationToken(token)
    expect(citation).toMatchObject({
      matchedTerms: ['董事会议事规则', '通过'],
      highlightText: '低空公司董事会议事规则的制定和修改',
      highlightRanges: [{ start: 4, end: 11 }, { start: 18, end: 20 }],
    })
  })

  it('accepts a path:line token under the KB mount', () => {
    expect(parseCitationToken('/workspace/kb/global/a.md:12')).toMatchObject({
      kind: 'path', path: '/workspace/kb/global/a.md', line: 12,
    })
    expect(parseCitationToken('global/a.md:3')).toMatchObject({ path: '/workspace/kb/global/a.md', line: 3 })
  })

  it('rejects traversal, outside paths, URLs and line zero', () => {
    expect(parseCitationToken('/workspace/kb/../etc/passwd:1')).toBeUndefined()
    expect(parseCitationToken('/etc/passwd:1')).toBeUndefined()
    expect(parseCitationToken('https://example.com/a.md:1')).toBeUndefined()
    expect(parseCitationToken('/workspace/kb/a.md:0')).toBeUndefined()
    expect(parseCitationToken('kb://doc/d?path=' + encodeURIComponent('/etc/passwd'))).toBeUndefined()
  })

  it('normalizes MinerU 0..1000 boxes and JSON lists', () => {
    expect(parseBoxes('100,200,500,400')).toEqual([[0.1, 0.2, 0.5, 0.4]])
    expect(parseBoxes('[[0.1,0.2,0.4,0.5],[0.2,0.3,0.6,0.7]]')).toEqual([[0.1, 0.2, 0.4, 0.5], [0.2, 0.3, 0.6, 0.7]])
    expect(parseBoxes('bad')).toBeUndefined()
  })

  it('contains paths through safeKbPath only', () => {
    expect(safeKbPath('global/a.md')).toBe('/workspace/kb/global/a.md')
    expect(safeKbPath('/workspace/kb/global/../a.md')).toBe('/workspace/kb/a.md')
    expect(safeKbPath('../../etc/passwd')).toBeUndefined()
    expect(safeKbPath('/workspace/kb-other/a.md')).toBeUndefined()
    expect(safeKbPath('交投相关资产备份_20261106.zip')).toBeUndefined()
    expect(safeKbPath('docs/a.md')).toBeUndefined()
    expect(safeKbPath('global/a.md')).toBe('/workspace/kb/global/a.md')
    expect(safeKbPath('department/order/a.pdf')).toBe('/workspace/kb/department/order/a.pdf')
    expect(safeKbPath('/workspace/01_低空起降点台账.csv')).toBeUndefined()
    expect(safeKbPath('/workspace/department/order/a.pdf')).toBe('/workspace/kb/department/order/a.pdf')
  })

  it('opens through the injected opener with all viewer options', () => {
    const citation = parseCitationToken('kb://doc/d/chunk/c?path=' + encodeURIComponent('/workspace/kb/a.pdf') + '&page=2&boxes=0.1,0.1,0.2,0.2&sheet=Sheet1&cell=B2')
    const open = vi.fn()
    expect(citation).toBeDefined()
    expect(openCitation(citation!, open)).toBe(true)
    expect(open).toHaveBeenCalledWith('/workspace/kb/a.pdf', expect.objectContaining({
      page: 2, boxes: [[0.1, 0.1, 0.2, 0.2]], sheet: 'Sheet1', cell: 'B2',
    }))
    expect(openOptionsOf(citation!)).toMatchObject({ page: 2, boxes: [[0.1, 0.1, 0.2, 0.2]], sheet: 'Sheet1', cell: 'B2' })
  })

  it('extracts inline-code citations and ignores ordinary code', () => {
    const text = '结论 `kb://doc/d/chunk/c?path=' + encodeURIComponent('/workspace/kb/a.md') + '` 与 `const x = 1`，另见 `/workspace/kb/b.md:8`。'
    expect(parseCitations(text).map(item => item.path)).toEqual(['/workspace/kb/a.md', '/workspace/kb/b.md'])
  })
})

describe('KB path canonicalization (task-94)', () => {
  it('folds backend-relative and NAS view paths into /workspace/kb', () => {
    expect(parseCitationToken('department/order/a.pdf:12')?.path).toBe('/workspace/kb/department/order/a.pdf')
    expect(parseCitationToken('/workspace/department/order/a.pdf:12')?.path).toBe('/workspace/kb/department/order/a.pdf')
    expect(parseCitationToken('/nas/kb/views/260afb31/department/order/a.pdf:12')?.path).toBe('/workspace/kb/department/order/a.pdf')
    expect(parseCitationToken('/workspace/kb/department/a.pdf:12')?.path).toBe('/workspace/kb/department/a.pdf')
  })

  it('keeps every viewer hint on one shared target', () => {
    const citation = parseCitationToken('/workspace/department/a.pdf:9?x=1')
    expect(citation).toBeUndefined()
    const shared = parseCitationToken('kb://doc/d/chunk/c?path=' + encodeURIComponent('/workspace/department/a.pdf') + '&line=9&page=2&boxes=0.1,0.1,0.2,0.2&sheet=S1&cell=B2')
    expect(shared?.path).toBe('/workspace/kb/department/a.pdf')
    expect(openOptionsOf(shared!)).toMatchObject({ line: 9, page: 2, boxes: [[0.1, 0.1, 0.2, 0.2]], sheet: 'S1', cell: 'B2' })
  })
})

describe('chunk-first citations (task-94 follow-up)', () => {
  it('keeps chunkId and every page group in the shared target options', () => {
    const groups = [
      { page: 2, boxes: [[0.1, 0.2, 0.4, 0.5]] },
      { page: 3, boxes: [[0.2, 0.3, 0.6, 0.7], [0.1, 0.1, 0.9, 0.2]] },
    ]
    const citation = parseCitationToken('kb://doc/d/chunk/chunk-7?path=' + encodeURIComponent('/workspace/department/scan.pdf') + '&groups=' + encodeURIComponent(JSON.stringify(groups)))
    expect(citation?.chunkId).toBe('chunk-7')
    expect(citation?.path).toBe('/workspace/kb/department/scan.pdf')
    expect(citation?.chunkGroups).toEqual(groups)
    expect(citation?.page).toBe(2)
    expect(openOptionsOf(citation!)).toMatchObject({ chunkId: 'chunk-7', chunkGroups: groups, page: 2 })
  })

  it('parses multi-page groups in compact page:boxes form and sorts pages', () => {
    const citation = parseCitationToken('kb://doc/d/chunk/c?path=' + encodeURIComponent('/workspace/kb/a.pdf') + '&groups=' + encodeURIComponent('3:0.2,0.2,0.4,0.4;1:0.1,0.1,0.2,0.2'))
    expect(citation?.chunkGroups?.map(group => group.page)).toEqual([1, 3])
  })
})

describe('MinerU bbox object parsing', () => {
  it('reads nested bbox objects returned by /knowledge-base/api/chunk', () => {
    const citation = parseCitationToken('kb://doc/37/chunk/89')
    expect(citation?.chunkGroups).toBeUndefined()
    expect(parseBoxes(JSON.stringify({ bbox: [0.122, 0.163, 0.803, 0.201], coord_space: 'normalized' }))).toEqual([[0.122, 0.163, 0.803, 0.201]])
    expect(parseBoxes(JSON.stringify([{ bbox: [0.1, 0.2, 0.3, 0.4] }, { bbox: [0.2, 0.3, 0.4, 0.5] }]))).toEqual([[0.1, 0.2, 0.3, 0.4], [0.2, 0.3, 0.4, 0.5]])
  })
})

describe('markdown link citations', () => {
  it('extracts .docx.md/.xlsx.md/.pdf.md links as source files without fake line numbers', () => {
    const text = [
      '见 [规则](/workspace/kb/董事会议事规则（试行）.docx.md:193)。',
      '表 [预测表](global/rag-eval-fixtures/财务预测表.xlsx.md)。',
      'PDF [报告](/workspace/kb/a.pdf.md:7)。',
      '文本 [说明](global/a.md:12)。',
    ].join('\n')
    const citations = parseCitations(text)
    expect(citations.map(citation => citation.path)).toEqual([
      '/workspace/kb/董事会议事规则（试行）.docx',
      '/workspace/kb/global/rag-eval-fixtures/财务预测表.xlsx',
      '/workspace/kb/a.pdf',
      '/workspace/kb/global/a.md',
    ])
    expect(citations[0]?.line).toBeUndefined()
    expect(citations[1]?.line).toBeUndefined()
    expect(citations[2]?.line).toBeUndefined()
    expect(citations[3]?.line).toBe(12)
  })

  it('dedupes a markdown-link source and its inline-code twin', () => {
    const citations = parseCitations('[规则](/workspace/kb/a.docx.md) 与 `/workspace/kb/a.docx`')
    expect(citations).toHaveLength(1)
    expect(citations[0]?.path).toBe('/workspace/kb/a.docx')
  })
})

describe('query term extraction', () => {
  it('drops the message timestamp so page/article numbers are not treated as terms', async () => {
    const { queryTermsFromPrompt } = await import('../src/client/citation-view.ts')
    const terms = queryTermsFromPrompt('董事会和经营班子会的表决通过门槛有什么不同？ 请使用知识库工具检索后回答。\n10:18')
    // ICU versions disagree on whether 董事会 is one word or 董事 + 会; assert the stable terms.
    expect(terms).toEqual(expect.arrayContaining(['表决', '通过', '门槛']))
    expect(terms).not.toContain('10')
    expect(terms).not.toContain('18')
    expect(terms.some(term => /^\d+$/.test(term))).toBe(false)
  })

  it('returns no terms for a prompt that has nothing to match', async () => {
    const { queryTermsFromPrompt } = await import('../src/client/citation-view.ts')
    expect(queryTermsFromPrompt('？。！，、')).toEqual([])
    // Length-1 fragments and symbol-only runs are not searchable terms either.
    expect(queryTermsFromPrompt('？ a 。')).toEqual([])
  })

  it('filters generic question words but keeps real phrases', async () => {
    const { specificQueryTerms } = await import('../src/client/citation-view.ts')
    expect(specificQueryTerms(['董事', '董事会', '经营班子会', '通过', '表决', '门槛', '董事会议事规则']))
      .toEqual(['表决', '门槛', '董事会议事规则'])
    // A question made only of generic words has no business painting amber.
    expect(specificQueryTerms(['董事会', '经营班子会', '通过', '经营', '班子'])).toEqual([])
    expect(specificQueryTerms(['门槛'])).toEqual(['门槛'])
  })
})
