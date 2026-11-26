import { describe, expect, it } from 'vitest'
import { chunkText } from '../src/ftsIndex.ts'

describe('structure-aware chunking', () => {
  it('keeps headings/paragraphs and targets 350–500 chars with overlap', () => {
    const paragraphs = Array.from({ length: 24 }, (_, index) => `第${String(index + 1)}段：` + '低空经济产业人才培养与考场服务说明。'.repeat(4)).join('\n\n')
    const text = '# 项目方案\n\n一、总体说明\n\n' + paragraphs
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every(chunk => chunk.content.length <= 860)).toBe(true)
    expect(chunks.every(chunk => chunk.content.length >= 120)).toBe(true)
    // Adjacent chunks share a bounded tail, so a phrase at a boundary stays retrievable.
    expect(chunks[1]?.content).toContain(chunks[0]?.content.slice(-50) ?? '')
  })

  it('keeps a table row and a legal clause atomic', () => {
    const row = '| A1 项目 | B1 金额 | C1 备注 |'
    const clause = '第十二条 本合同项下的全部条款均须经董事会审议通过后方可生效。'
    const chunks = chunkText('# 制度\n\n' + clause + '\n\n' + row + '\n\n' + '普通说明。'.repeat(80))
    expect(chunks.some(chunk => chunk.content.includes(clause))).toBe(true)
    expect(chunks.some(chunk => chunk.content.includes(row))).toBe(true)
    expect(chunks.some(chunk => chunk.content.includes('| A1 项目 | B1'))).toBe(true)
  })

  it('keeps a query phrase in its own paragraph-sized chunk', () => {
    const paragraphs = Array.from({ length: 20 }, (_, index) => `第${String(index + 1)}段：` + '项目运营说明。'.repeat(10))
    paragraphs[12] = '项目合作模式：由甲方提供场地，乙方负责运营。'
    const chunks = chunkText('# 商业计划书\n\n' + paragraphs.join('\n\n'))
    const containing = chunks.filter(chunk => chunk.content.includes('项目合作模式'))
    expect(containing).toHaveLength(1)
    expect(containing[0]?.content.length).toBeLessThanOrEqual(860)
  })
})

describe('structural boundaries outrank the character target', () => {
  const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七']
  const list = numerals.map((numeral, index) => `（${numeral}）第${String(index + 1)}项：` + '经营班子会审议事项的具体说明。'.repeat(6)).join('\n')
  const text = [
    '第一章 总则',
    '第一条 为规范经营班子会议事程序，制定本规则。',
    '第六条 经营班子会审议后提请董事会决策的事项：',
    list,
    '第三章 经营班子会议的召集及通知',
    '第七条 经营班子会召开会议的次数应当满足经营发展需要。' + '会议出席人数应当达到应出席人数的二分之一以上。'.repeat(12),
    '第八条 经营班子会召开前两个工作日通知全体成员。',
  ].join('\n')

  it('splits list items 15-17 from 第三章 and 第七条 instead of merging all three', () => {
    const chunks = chunkText(text)
    const chapter = chunks.find(chunk => chunk.content.includes('第三章'))
    expect(chapter).toBeDefined()
    // The chapter heading starts its own chunk and owns the following article.
    expect(chapter!.content.startsWith('第三章')).toBe(true)
    expect(chapter!.content).toContain('第七条')
    // The preceding chunk may end at （十七）, but it must not carry the chapter heading.
    const listTail = chunks.find(chunk => chunk.content.includes('（十七）'))
    expect(listTail).toBeDefined()
    expect(listTail!.content).not.toContain('第三章')
    expect(listTail!.content).not.toContain('第七条')
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('never appends an article heading to the previous body', () => {
    const chunks = chunkText(text)
    const chunkWith = (marker: string): string => chunks.find(chunk => chunk.content.includes(marker))?.content ?? ''
    // 第七条 is the first article of 第三章, so it shares that chapter's opening chunk.
    expect(chunkWith('第七条').startsWith('第三章')).toBe(true)
    // 第八条 is a later article: it opens its own chunk instead of trailing 第七条's body.
    expect(chunkWith('第八条').startsWith('第八条')).toBe(true)
    expect(chunkWith('第六条')).not.toContain('第七条')
    expect(chunkWith('第六条')).not.toContain('第八条')
  })
})
