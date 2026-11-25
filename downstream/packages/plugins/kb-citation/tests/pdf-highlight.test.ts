// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { chooseTextMatch, findPdfTextMatches, renderBoxHighlights } from '../src/client/pdf-highlight.ts'

function page(number: number, text: string): HTMLElement {
  const element = document.createElement('div')
  element.dataset.pdfPage = String(number)
  for (const [index, part] of text.split('|').entries()) {
    const span = document.createElement('span')
    span.textContent = part
    Object.defineProperty(span, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 40, top: 40 + index * 22, width: 500, height: 20, right: 540, bottom: 60 + index * 22, x: 40, y: 40 + index * 22, toJSON: () => ({}) }),
    })
    element.appendChild(span)
  }
  document.body.appendChild(element)
  return element
}

function addBlueBox(pageElement: HTMLElement, rect = { left: 0, top: 0, right: 600, bottom: 800 }): HTMLElement {
  const box = document.createElement('div')
  box.className = 'kb-citation-box'
  box.dataset.kbCitationBox = 'true'
  Object.defineProperty(box, 'getBoundingClientRect', { value: () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top, x: rect.left, y: rect.top }) })
  pageElement.appendChild(box)
  return box
}

beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn() })

describe('PDF citation highlighting', () => {
  it('paints normalized boxes into an absolutely positioned overlay', () => {
    const element = page(1, 'hello')
    renderBoxHighlights(element, [[0.1, 0.2, 0.5, 0.6]])
    const box = element.querySelector<HTMLElement>('[data-kb-citation-box]')
    expect(box).not.toBeNull()
    expect(box?.style.left).toBe('0px')
    expect(element.style.position).toBe('relative')
  })

  it('finds every text occurrence across pages instead of returning the first', () => {
    page(1, '知识库|总则')
    page(2, '知识库')
    const matches = findPdfTextMatches('知识库')
    expect(matches).toHaveLength(2)
    expect(matches.map(match => match.page)).toEqual([1, 2])
  })

  it('requires an explicit choice when more than one match exists', async () => {
    document.body.innerHTML = ''
    page(1, '知识库')
    page(2, '知识库')
    const matches = findPdfTextMatches('知识库')
    const pending = chooseTextMatch(matches)
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.kb-citation-picker button')]
    expect(buttons).toHaveLength(2)
    buttons[1]?.click()
    await expect(pending).resolves.toMatchObject({ page: 2 })
  })
})

describe('chunk-first PDF groups', () => {
  it('draws all boxes on every page of a multi-page chunk', async () => {
    document.body.innerHTML = ''
    page(1, 'one')
    page(2, 'two')
    const { highlightPdfChunk } = await import('../src/client/pdf-highlight.ts')
    const result = await highlightPdfChunk([
      { page: 1, boxes: [[0.1, 0.1, 0.2, 0.2]] },
      { page: 2, boxes: [[0.3, 0.3, 0.4, 0.4], [0.5, 0.5, 0.6, 0.6]] },
    ])
    expect(result).toMatchObject({ status: 'boxes', page: 1, pageCount: 2, groups: 2 })
    expect(document.querySelectorAll('[data-kb-citation-box]')).toHaveLength(2)
  })
})

describe('chunk-first PDF groups', () => {
  it('paints one union per page even when a legacy payload carries several boxes', async () => {
    document.body.innerHTML = ''
    const pageElement = document.createElement('div')
    pageElement.dataset.pdfPage = '1'
    const canvas = document.createElement('canvas')
    pageElement.appendChild(canvas)
    document.body.appendChild(pageElement)
    Object.defineProperty(pageElement, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 1000, height: 1200, right: 1000, bottom: 1200, x: 0, y: 0, toJSON: () => ({}) }) })
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 1000, height: 1200, right: 1000, bottom: 1200, x: 0, y: 0, toJSON: () => ({}) }) })
    const { highlightPdfChunk } = await import('../src/client/pdf-highlight.ts')
    await highlightPdfChunk([
      { page: 1, boxes: [[0.1, 0.1, 0.2, 0.2], [0.5, 0.5, 0.6, 0.6]] },
      // Duplicate page group from an old token: merged, not painted as a second box.
      { page: 1, boxes: [[0.3, 0.3, 0.4, 0.4]] },
    ])
    const boxes = [...document.querySelectorAll<HTMLElement>('[data-kb-citation-box]')]
    expect(boxes).toHaveLength(1)
    expect(Number.parseFloat(boxes[0]?.style.left ?? '')).toBe(100)
    expect(Number.parseFloat(boxes[0]?.style.top ?? '')).toBe(120)
    expect(Number.parseFloat(boxes[0]?.style.width ?? '')).toBe(500)
    expect(Number.parseFloat(boxes[0]?.style.height ?? '')).toBe(600)
  })
})

describe('bbox geometry uses content area, not padded page shell', () => {
  function rect(left: number, top: number, width: number, height: number): DOMRect {
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect
  }

  it('positions a text-match box over the span content rect', async () => {
    document.body.innerHTML = ''
    const page = document.createElement('div'); page.dataset.pdfPage = '1'
    const canvas = document.createElement('canvas'); page.appendChild(canvas); document.body.appendChild(page)
    const span = document.createElement('span'); span.textContent = '第二条 经营班子会'; page.appendChild(span)
    Object.defineProperty(page, 'getBoundingClientRect', { value: () => rect(0, 0, 1000, 1200) })
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => rect(100, 150, 800, 1000) })
    Object.defineProperty(span, 'getBoundingClientRect', { value: () => rect(300, 400, 200, 20) })
    const { renderTextMatchBoxes, rectIntersectionRatio } = await import('../src/client/pdf-highlight.ts')
    expect(renderTextMatchBoxes([{ page: 1, element: span, text: '第二条', context: '', occurrence: 1 }])).toBe(1)
    const box = document.querySelector<HTMLElement>('[data-kb-citation-box]')!
    const left = Number.parseFloat(box.style.left); const top = Number.parseFloat(box.style.top)
    const width = Number.parseFloat(box.style.width); const height = Number.parseFloat(box.style.height)
    expect(rectIntersectionRatio(rect(left, top, width, height), rect(300, 400, 200, 20))).toBeGreaterThan(0.5)
  })

  it('converts normalized boxes against the canvas rect (not page padding)', async () => {
    document.body.innerHTML = ''
    const page = document.createElement('div'); page.dataset.pdfPage = '1'
    const canvas = document.createElement('canvas'); page.appendChild(canvas); document.body.appendChild(page)
    Object.defineProperty(page, 'getBoundingClientRect', { value: () => rect(0, 0, 1000, 1200) })
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => rect(100, 150, 800, 1000) })
    const { renderBoxHighlights } = await import('../src/client/pdf-highlight.ts')
    renderBoxHighlights(page, [[0.1, 0.2, 0.2, 0.3]])
    const box = page.querySelector<HTMLElement>('[data-kb-citation-box]')!
    // content origin (100,150) + 0.1*800 = 180, +0.2*1000 = 350
    expect(Number.parseFloat(box.style.left)).toBe(180)
    expect(Number.parseFloat(box.style.top)).toBe(350)
    expect(Number.parseFloat(box.style.width)).toBe(80)
    expect(Number.parseFloat(box.style.height)).toBeCloseTo(100)
  })
})

describe('lazy Office text and zero-sized canvas fallback', () => {
  it('waits for quote spans that lazy-load after the page mounts', async () => {
    document.body.innerHTML = ''
    const page = document.createElement('div'); page.dataset.pdfPage = '1'; document.body.appendChild(page)
    setTimeout(() => { const span = document.createElement('span'); span.textContent = '第二条 经营班子会'; page.appendChild(span) }, 60)
    const { highlightDocxQuote } = await import('../src/client/pdf-highlight.ts')
    await expect(highlightDocxQuote({ quote: '第二条 经营班子会' })).resolves.toMatchObject({ status: 'text', matches: 1 })
  })

  it('falls back to page content rect when the canvas has zero size', async () => {
    document.body.innerHTML = ''
    const page = document.createElement('div'); page.dataset.pdfPage = '1'; const canvas = document.createElement('canvas'); page.appendChild(canvas); document.body.appendChild(page)
    Object.defineProperty(page, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0 }) })
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 }) })
    const { renderBoxHighlights } = await import('../src/client/pdf-highlight.ts')
    renderBoxHighlights(page, [[0.5, 0.5, 0.75, 0.75]])
    const box = page.querySelector<HTMLElement>('[data-kb-citation-box]')!
    expect(Number.parseFloat(box.style.width)).toBeCloseTo(150)
    expect(Number.parseFloat(box.style.height)).toBeCloseTo(200)
  })
})

describe('whole-chunk docx boxes', () => {
  it('draws title and every body paragraph across pages, not just the first hit', async () => {
    document.body.innerHTML = ''
    const first = page(1, '规则标题|第一条 为完善公司经营管理，保障经营班子依法合规行使职权。')
    const second = page(2, '第二条 经营班子会由总经理召集和主持。')
    Object.defineProperty(first, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0 }) })
    Object.defineProperty(second, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0 }) })
    const { highlightDocxChunk } = await import('../src/client/pdf-highlight.ts')
    const result = await highlightDocxChunk({ paragraphs: [
      { text: '规则标题', ordinal: 1 },
      { text: '第一条 为完善公司经营管理，保障经营班子依法合规行使职权。', ordinal: 2 },
      { text: '第二条 经营班子会由总经理召集和主持。', ordinal: 3 },
    ] })
    expect(result).toMatchObject({ status: 'text', matches: 3, groups: 2, pageCount: 2 })
    expect(document.querySelectorAll('[data-kb-citation-box]')).toHaveLength(2)
  })
})

describe('12-paragraph chunk', () => {
  it('draws every paragraph across pages without per-paragraph waits', async () => {
    document.body.innerHTML = ''
    const p1 = page(1, Array.from({ length: 6 }, (_, i) => '第一页段落' + String(i + 1) + '正文内容').join('|'))
    const p2 = page(2, Array.from({ length: 6 }, (_, i) => '第二页段落' + String(i + 1) + '正文内容').join('|'))
    for (const el of [p1, p2]) Object.defineProperty(el, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0 }) })
    const paragraphs = [...Array.from({ length: 12 }, (_, i) => ({ text: (i < 6 ? '第一页' : '第二页') + '段落' + String((i % 6) + 1) + '正文内容' }))]
    const { highlightDocxChunk } = await import('../src/client/pdf-highlight.ts')
    const result = await highlightDocxChunk({ paragraphs })
    expect(result).toMatchObject({ status: 'text', matches: 12, groups: 2, pageCount: 2 })
    expect(document.querySelectorAll('[data-kb-citation-box]')).toHaveLength(2)
  })
})

describe('scroll target after chunk painting', () => {
  it('sets the PDF container scrollTop so the first bbox centers in the viewport', async () => {
    document.body.innerHTML = ''
    const container = document.createElement('div')
    container.style.overflowY = 'auto'
    document.body.appendChild(container)
    Object.defineProperty(container, 'clientHeight', { value: 400 })
    Object.defineProperty(container, 'scrollHeight', { value: 2000 })
    Object.defineProperty(container, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400, x: 0, y: 0 }) })
    const pdfPage = document.createElement('div'); pdfPage.dataset.pdfPage = '1'; container.appendChild(pdfPage)
    const box = document.createElement('div'); box.className = 'kb-citation-box'; box.dataset.kbCitationBox = 'true'; pdfPage.appendChild(box)
    Object.defineProperty(box, 'getBoundingClientRect', { value: () => ({ left: 0, top: 1000, width: 200, height: 20, right: 200, bottom: 1020, x: 0, y: 1000 }) })
    const { scrollToFirstBox } = await import('../src/client/pdf-highlight.ts')
    expect(scrollToFirstBox(pdfPage)).toBe(true)
    expect(container.scrollTop).toBeCloseTo(810)
  })
})

describe('chunk union content validation', () => {
  it('passes when the union box covers the chunk text and fails on unrelated text', async () => {
    document.body.innerHTML = ''
    const page = document.createElement('div'); page.dataset.pdfPage = '1'
    const span = document.createElement('span'); span.textContent = '第二条 经营班子会由总经理召集和主持'
    page.appendChild(span); document.body.appendChild(page)
    Object.defineProperty(span, 'getBoundingClientRect', { value: () => ({ left: 10, top: 40, width: 300, height: 20, right: 310, bottom: 60, x: 10, y: 40 }) })
    const { verifyChunkBoxContent } = await import('../src/client/pdf-highlight.ts')
    const good = verifyChunkBoxContent(page, { left: 0, top: 20, right: 400, bottom: 80 }, ['第二条 经营班子会由总经理召集和主持'])
    expect(good.ok).toBe(true)
    expect(good.score).toBeGreaterThan(0.5)
    const bad = verifyChunkBoxContent(page, { left: 0, top: 20, right: 400, bottom: 80 }, ['完全无关的财务数据'])
    expect(bad.ok).toBe(false)
  })
})

describe('target-page-only rendering', () => {
  it('does not scroll a non-target page and ends on the union box', async () => {
    document.body.innerHTML = ''
    const p1 = page(1, '第一段正文内容')
    const p2 = page(2, '第二段正文内容')
    const p3 = page(3, '非目标页内容')
    for (const el of [p1, p2, p3]) Object.defineProperty(el, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0 }) })
    const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView)
    scroll.mockClear()
    const { highlightDocxChunk } = await import('../src/client/pdf-highlight.ts')
    await highlightDocxChunk({ paragraphs: [{ text: '第一段正文内容' }, { text: '第二段正文内容' }], pages: [1, 2] })
    const scrolledPages = scroll.mock.instances.filter(instance => (instance as HTMLElement).dataset.pdfPage !== undefined).map(instance => (instance as HTMLElement).dataset.pdfPage)
    expect(scrolledPages).not.toContain('3')
    const last = scroll.mock.instances.at(-1) as HTMLElement | undefined
    expect(last?.dataset.kbCitationBox).toBe('true')
  })
})

describe('query hit highlight and legend', () => {
  it('draws amber hit boxes and a legend without stealing the viewport from the union box', async () => {
    document.body.innerHTML = ''
    const pageEl = page(1, '项目合作模式正文|项目背景')
    Object.defineProperty(pageEl, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0 }) })
    const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView)
    scroll.mockClear()
    const { highlightDocxChunk } = await import('../src/client/pdf-highlight.ts')
    const result = await highlightDocxChunk({ paragraphs: [{ text: '项目合作模式正文' }], query: '项目合作模式', pages: [1] })
    expect(result.status).toBe('text')
    expect(document.querySelectorAll('.kb-citation-hit').length).toBeGreaterThan(0)
    expect(document.querySelector('.kb-citation-legend')).toBeNull()
    const last = scroll.mock.instances.at(-1) as HTMLElement | undefined
    expect(last?.dataset.kbCitationBox).toBe('true')
  })
})

describe('docx chunk on a late page', () => {
  it('searches every page when the chunk carries no page hint and reveals the first box', async () => {
    document.body.innerHTML = ''
    const container = document.createElement('div')
    container.style.overflowY = 'auto'
    document.body.appendChild(container)
    Object.defineProperty(container, 'clientHeight', { value: 400 })
    Object.defineProperty(container, 'scrollHeight', { value: 12000 })
    Object.defineProperty(container, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 600, height: 400, right: 600, bottom: 400, x: 0, y: 0 }) })
    container.scrollTop = 120
    const boxes: HTMLElement[] = []
    for (let number = 1; number <= 16; number += 1) {
      const el = document.createElement('div')
      el.dataset.pdfPage = String(number)
      const span = document.createElement('span')
      span.textContent = number === 14
        ? '表示同意、反对、弃权。表示反对、弃权的，必须说明具体理由并记载于会议记录。'
        : number === 15
          ? '第二十四条 董事会审议时，应当重点研判决策事项的合法合规性。'
          : '第' + String(number) + '页正文'
      el.appendChild(span)
      container.appendChild(el)
      Object.defineProperty(el, 'getBoundingClientRect', { value: () => ({ left: 0, top: number * 700, width: 600, height: 700, right: 600, bottom: number * 700 + 700, x: 0, y: number * 700 }) })
      Object.defineProperty(span, 'getBoundingClientRect', { value: () => ({ left: 40, top: number * 700 + 80, width: 500, height: 20, right: 540, bottom: number * 700 + 100, x: 40, y: number * 700 + 80 }) })
      boxes.push(el)
    }
    const { highlightDocxChunk } = await import('../src/client/pdf-highlight.ts')
    const result = await highlightDocxChunk({
      paragraphs: [{ text: '表示同意、反对、弃权。表示反对、弃权的，必须说明具体理由并记载于会议记录。' }],
      quote: '第二十四条 董事会审议时，应当重点研判决策事项的合法合规性。',
    })
    const painted = [...document.querySelectorAll<HTMLElement>('.kb-citation-box')]
    expect(result.status).toBe('text')
    expect(painted.length).toBeGreaterThanOrEqual(1)
    expect(painted[0]?.closest<HTMLElement>('[data-pdf-page]')?.dataset.pdfPage).toBe('14')
    expect(result.page).toBe(14)
  })
})

describe('citation click latency', () => {
  it('lands a lazy target page in under three seconds without scrolling the document', async () => {
    document.body.innerHTML = ''
    const container = document.createElement('div')
    container.style.overflowY = 'auto'
    document.body.appendChild(container)
    Object.defineProperty(container, 'clientHeight', { value: 1024 })
    Object.defineProperty(container, 'scrollHeight', { value: 19000 })
    Object.defineProperty(container, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 760, height: 1024, right: 760, bottom: 1024, x: 0, y: 0 }) })
    const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView)
    scroll.mockClear()
    for (let number = 1; number <= 19; number += 1) {
      const page = document.createElement('div')
      page.dataset.pdfPage = String(number)
      Object.defineProperty(page, 'getBoundingClientRect', { value: () => ({ left: 0, top: number * 1000, width: 740, height: 990, right: 740, bottom: number * 1000 + 990, x: 0, y: number * 1000 }) })
      const addSpan = (text: string): void => {
        const span = document.createElement('span')
        span.textContent = text
        Object.defineProperty(span, 'getBoundingClientRect', { value: () => ({ left: 40, top: number * 1000 + 80, width: 660, height: 620, right: 700, bottom: number * 1000 + 700, x: 40, y: number * 1000 + 80 }) })
        page.appendChild(span)
      }
      if (number === 14) {
        // Simulate the host's lazy text layer: the page shell exists, spans arrive later.
        setTimeout(() => { addSpan('表示同意、反对、弃权。表示反对、弃权的，必须说明具体理由并记载于会议记录。') }, 120)
      } else {
        addSpan('第' + String(number) + '页正文')
      }
      container.appendChild(page)
    }
    const { highlightDocxChunk } = await import('../src/client/pdf-highlight.ts')
    const started = performance.now()
    const result = await highlightDocxChunk({
      paragraphs: [{ text: '表示同意、反对、弃权。表示反对、弃权的，必须说明具体理由并记载于会议记录。' }],
      chunkOrdinal: 12,
      docKey: 'doc:latency',
      chunkKey: 'chunk:latency',
    })
    const elapsed = performance.now() - started
    expect(result).toMatchObject({ status: 'text', page: 14 })
    expect(elapsed).toBeLessThan(3000)
    const scrolledPages = scroll.mock.instances
      .filter(instance => (instance as HTMLElement).dataset.pdfPage !== undefined)
      .map(instance => (instance as HTMLElement).dataset.pdfPage)
    expect(scrolledPages).not.toContain('1')
    expect(scrolledPages.every(page => page === '14')).toBe(true)
  })
})

describe('cross-span docx quote', () => {
  it('finds a quote split across several text-layer spans and draws one union box', async () => {
    document.body.innerHTML = ''
    const pageEl = page(1, '第二十四条 董事会审议时|，应当重点研判|决策事项的合法合规性。')
    Object.defineProperty(pageEl, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0 }) })
    for (const span of [...pageEl.querySelectorAll('span')]) {
      Object.defineProperty(span, 'getBoundingClientRect', { value: () => ({ left: 20, top: 40, width: 560, height: 20, right: 580, bottom: 60, x: 20, y: 40 }) })
    }
    const { highlightDocxQuote } = await import('../src/client/pdf-highlight.ts')
    const result = await highlightDocxQuote({ quote: '第二十四条 董事会审议时，应当重点研判决策事项的合法合规性。' })
    expect(result).toMatchObject({ status: 'text', page: 1, matches: 1, pageCount: 1 })
    expect(document.querySelectorAll('.kb-citation-box')).toHaveLength(1)
  })
})

describe('truncated query terms', () => {
  it('draws amber hits for terms split from a truncated quote', async () => {
    document.body.innerHTML = ''
    const pageEl = page(1, '项目合作模式：我公司负责项目筹办')
    addBlueBox(pageEl)
    const { renderQueryHits } = await import('../src/client/pdf-highlight.ts')
    const drawn = renderQueryHits('项目合作模式：我公司负责项…', pageEl)
    expect(drawn).toBeGreaterThan(0)
    expect(pageEl.querySelectorAll('.kb-citation-hit').length).toBeGreaterThan(0)
    expect(document.querySelector('.kb-citation-legend')).toBeNull()
  })
})

describe('user query terms', () => {
  it('draws amber for 表决/通过/门槛 from search terms', async () => {
    document.body.innerHTML = ''
    const pageEl = page(1, '第十五条 经营班子会表决 一般事项须经应出席人数过半数通过 门槛')
    addBlueBox(pageEl)
    const { renderQueryHits } = await import('../src/client/pdf-highlight.ts')
    const drawn = renderQueryHits('', pageEl, ['表决', '通过', '门槛'])
    expect(drawn).toBeGreaterThan(0)
    expect(pageEl.querySelectorAll('.kb-citation-hit').length).toBeGreaterThan(0)
  })

  it('extracts keywords from the latest user prompt', async () => {
    document.body.innerHTML = '<div data-chat-flow-kind="user">董事会和经营班子会的表决通过门槛有什么不同？</div>'
    const { userQueryTerms } = await import('../src/client/citation-view.ts')
    const terms = userQueryTerms()
    expect(terms).toEqual(expect.arrayContaining(['表决', '通过', '门槛']))
  })
})

describe('amber across split text spans', () => {
  it('matches a term whose characters live in different spans', async () => {
    document.body.innerHTML = ''
    // PDF.js splits Chinese runs at line wraps and sometimes per character; neither span
    // contains 表决 on its own.
    const pageEl = page(1, '第十四条 以举手方式进|行表|决，表示同意')
    addBlueBox(pageEl)
    const { renderQueryHits } = await import('../src/client/pdf-highlight.ts')
    const drawn = renderQueryHits('', pageEl, ['表决'])
    expect(drawn).toBe(2)
    expect(pageEl.querySelectorAll('.kb-citation-hit')).toHaveLength(2)
  })

  it('tolerates whitespace inserted inside the rendered term', async () => {
    document.body.innerHTML = ''
    const pageEl = page(1, '重要法律事 务的内容，应当提供法律审核意见')
    addBlueBox(pageEl)
    const { renderQueryHits } = await import('../src/client/pdf-highlight.ts')
    expect(renderQueryHits('', pageEl, ['重要法律事务'])).toBe(1)
  })

  it('draws nothing when no term occurs, instead of faking a hit from the quote', async () => {
    document.body.innerHTML = ''
    const pageEl = page(1, '第十五条 会议表决与通过门槛')
    addBlueBox(pageEl)
    const { renderQueryHits } = await import('../src/client/pdf-highlight.ts')
    expect(renderQueryHits('', pageEl, ['人事任免'])).toBe(0)
    expect(pageEl.querySelectorAll('.kb-citation-hit')).toHaveLength(0)
  })

  it('does not paint a 0.5px box for a span whose text layer is not laid out yet', async () => {
    document.body.innerHTML = ''
    const pageEl = page(1, '第十五条 会议表决与通过门槛')
    const span = pageEl.querySelector('span')!
    // A text layer that has text before PDF.js typesets it reports an all-zero rect.
    Object.defineProperty(span, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }),
    })
    const { renderQueryHits } = await import('../src/client/pdf-highlight.ts')
    expect(renderQueryHits('', pageEl, ['表决'])).toBe(0)
    expect(pageEl.querySelectorAll('.kb-citation-hit')).toHaveLength(0)
  })

  it('keeps an earlier good paint when the refreshed text layer reports zero rects', async () => {
    document.body.innerHTML = ''
    const pageEl = page(1, '第十五条 会议表决与通过门槛')
    addBlueBox(pageEl)
    const { renderQueryHits } = await import('../src/client/pdf-highlight.ts')
    expect(renderQueryHits('', pageEl, ['表决'])).toBe(1)
    const span = pageEl.querySelector('span')!
    Object.defineProperty(span, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }),
    })
    expect(renderQueryHits('', pageEl, ['表决'])).toBe(0)
    expect(pageEl.querySelectorAll('.kb-citation-hit')).toHaveLength(1)
  })
})

describe('no fake amber without a user question', () => {
  it('paints only the blue union when the transcript has no user term', async () => {
    document.body.innerHTML = ''
    page(1, '第十五条 会议审议事项以赞成人数超过应出席人数的二分之一方可通过')
    const { applyCitationView } = await import('../src/client/citation-view.ts')
    await applyCitationView({
      raw: 'kb://doc/49/chunk/1fe09e0dbfb4184d', kind: 'kb', docId: '49', chunkId: '1fe09e0dbfb4184d',
      path: '/workspace/kb/a.docx', chunkOrdinal: 0, label: 'a.docx', title: 'a.docx',
      paragraphs: [{ text: '第十五条 会议审议事项以赞成人数超过应出席人数的二分之一方可通过' }],
    }, { chunkId: '1fe09e0dbfb4184d' })
    expect(document.querySelectorAll('.kb-citation-box').length).toBe(1)
    expect(document.querySelectorAll('.kb-citation-hit').length).toBe(0)
    expect(document.querySelector('.kb-citation-legend')).toBeNull()
  })

  it('paints amber from the KB matched term, not from generic question words', async () => {
    document.body.innerHTML = '<div data-chat-flow-kind="user">董事会和经营班子会的表决通过门槛有什么不同？</div>'
    page(1, '第十五条 会议审议事项以赞成人数超过应出席人数的二分之一方可通过')
    const { applyCitationView } = await import('../src/client/citation-view.ts')
    await applyCitationView({
      raw: 'kb://doc/49/chunk/1fe09e0dbfb4184d', kind: 'kb', docId: '49', chunkId: '1fe09e0dbfb4184d',
      path: '/workspace/kb/a.docx', chunkOrdinal: 0, label: 'a.docx', title: 'a.docx',
      matchedTerms: ['应出席人数'],
      paragraphs: [{ text: '第十五条 会议审议事项以赞成人数超过应出席人数的二分之一方可通过' }],
    }, { chunkId: '1fe09e0dbfb4184d' })
    expect(document.querySelectorAll('.kb-citation-box').length).toBe(1)
    expect(document.querySelectorAll('.kb-citation-hit').length).toBeGreaterThan(0)
  })

  it('does not paint generic question words when the token has no matched term', async () => {
    document.body.innerHTML = '<div data-chat-flow-kind="user">董事会和经营班子会的表决通过门槛有什么不同？</div>'
    page(1, '第十五条 会议审议事项以赞成人数超过应出席人数的二分之一方可通过')
    const { applyCitationView } = await import('../src/client/citation-view.ts')
    await applyCitationView({
      raw: 'kb://doc/49/chunk/1fe09e0dbfb4184d', kind: 'kb', docId: '49', chunkId: '1fe09e0dbfb4184d',
      path: '/workspace/kb/a.docx', chunkOrdinal: 0, label: 'a.docx', title: 'a.docx',
      paragraphs: [{ text: '第十五条 会议审议事项以赞成人数超过应出席人数的二分之一方可通过' }],
    }, { chunkId: '1fe09e0dbfb4184d' })
    expect(document.querySelectorAll('.kb-citation-box').length).toBe(1)
    expect(document.querySelectorAll('.kb-citation-hit').length).toBe(0)
  })
})

describe('amber clipped to chunk union', () => {
  it('keeps in-union occurrence and drops the same term outside the blue box', async () => {
    document.body.innerHTML = ''
    const pageEl = document.createElement('div'); pageEl.dataset.pdfPage = '1'
    Object.defineProperty(pageEl, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0 }) })
    const inside = document.createElement('span'); inside.textContent = '表决通过'
    Object.defineProperty(inside, 'getBoundingClientRect', { value: () => ({ left: 20, top: 20, width: 120, height: 18, right: 140, bottom: 38, x: 20, y: 20 }) })
    const outside = document.createElement('span'); outside.textContent = '经营班子会记录'
    Object.defineProperty(outside, 'getBoundingClientRect', { value: () => ({ left: 20, top: 200, width: 200, height: 18, right: 220, bottom: 218, x: 20, y: 200 }) })
    pageEl.append(inside, outside); document.body.appendChild(pageEl)
    addBlueBox(pageEl, { left: 0, top: 0, right: 300, bottom: 60 })
    const { renderQueryHits } = await import('../src/client/pdf-highlight.ts')
    expect(renderQueryHits('', pageEl, ['通过'])).toBe(1)
    const hit = pageEl.querySelector<HTMLElement>('.kb-citation-hit')!
    expect(Number.parseFloat(hit.style.top)).toBeLessThan(60)
    expect(pageEl.querySelectorAll('.kb-citation-hit')).toHaveLength(1)
  })
})
