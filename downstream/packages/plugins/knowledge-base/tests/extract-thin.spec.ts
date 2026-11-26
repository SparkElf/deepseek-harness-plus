import { describe, expect, it } from 'vitest'
import { looksTooThinToSearch } from '../src/extract.ts'

describe('spotting an extraction too thin to search', () => {
  it('calls a page of real prose searchable', () => {
    const prose = '# 运维手册\n\n'
      + '本手册说明值班流程、故障上报路径与交接要求。值班人员应当在交接前完成巡检，'
      + '并在交接记录中写明未完成事项。发生一级故障时，先上报再处置，不得先处置后上报。'
    expect(looksTooThinToSearch(prose)).toBe(false)
  })

  it('treats a bare title and page number as too thin', () => {
    // This is the shape a mis-classified scan comes back as: the classifier read the
    // header and stopped, so the page's body is absent entirely.
    expect(looksTooThinToSearch('# 合同\n\n- 1 -')).toBe(true)
    expect(looksTooThinToSearch('')).toBe(true)
  })

  it('is not fooled by markup that renders without carrying words', () => {
    // A scanned page often produces image placeholders, empty tables and rules. All
    // of that is structure; none of it can be searched for a sentence.
    const structural = [
      '# 标题',
      '',
      '![](images/0001.jpg)',
      '',
      '| | |',
      '|---|---|',
      '| | |',
      '',
      '---',
      '',
      '<!-- page 1 -->',
    ].join('\n')
    expect(looksTooThinToSearch(structural)).toBe(true)
  })

  it('counts the words that survive next to the markup', () => {
    // The test targets a page that produced nothing, not a page that is merely
    // short: real prose beside a placeholder must clear the floor.
    const mixed = '# 通知\n\n![](a.png)\n\n各部门于本周五前提交名单，逾期不再受理。\n'
      + '提交地址为综合楼三层办公室，联系电话见附表。'
    expect(looksTooThinToSearch(mixed)).toBe(false)
  })

  it('does not force OCR over a genuinely short notice', () => {
    // A two-clause notice is a real document. Retrying it would cost a parse for
    // nothing, so the floor stays below an ordinary short paragraph.
    const short = '# 提醒\n\n本周五下午三点召开例会，请准时参加。'
    expect(looksTooThinToSearch(short)).toBe(false)
  })
})
