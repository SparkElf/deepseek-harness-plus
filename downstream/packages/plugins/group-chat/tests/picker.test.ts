/**
 * The two decisions the pickers and avatars make without a browser.
 *
 * Imported from `rows.ts` rather than from the components: both components pull in the
 * official primitives, whose CSS modules this test runner cannot transform. Keeping the
 * decisions in a plain module is what makes them reachable here at all.
 *
 * @module tests/picker.test
 */

import { describe, expect, it } from 'vitest'
import { filterOptions, initialsOf, type PickerOption } from '../src/client/rows.ts'

const option = (id: string, label: string, secondary?: string): PickerOption =>
  secondary === undefined ? { id, label } : { id, label, secondary }

describe('候选行过滤', () => {
  const rows = [
    option('1', 'DataOps Admin', 'admin'),
    option('2', 'DataOps Operator', 'operator'),
    option('3', 'Font Check', 'fontcheck'),
  ]

  it('按标签的子串过滤，忽略大小写', () => {
    expect(filterOptions(rows, 'admin').map((row) => row.id)).toEqual(['1'])
    expect(filterOptions(rows, 'ADMIN').map((row) => row.id)).toEqual(['1'])
    expect(filterOptions(rows, 'dataops').map((row) => row.id)).toEqual(['1', '2'])
  })

  it('也匹配次行文本，因为操作员往往只知道账号名', () => {
    // The display name is what the row shows, but the handle is what people remember.
    expect(filterOptions(rows, 'fontcheck').map((row) => row.id)).toEqual(['3'])
  })

  it('空查询返回全部，这是对话框刚打开时列表能有内容的唯一原因', () => {
    expect(filterOptions(rows, '')).toHaveLength(3)
    expect(filterOptions(rows, '   ')).toHaveLength(3)
  })

  it('没有匹配时返回空数组而不是回退到全部', () => {
    // Falling back to the full list would make a typo look like a successful search.
    expect(filterOptions(rows, 'zzz')).toEqual([])
  })
})

describe('头像首字母', () => {
  it('中文名取前两个字，因为中文名没有空格可切', () => {
    expect(initialsOf('张三')).toBe('张三')
    expect(initialsOf('数据平台管理员')).toBe('数据')
  })

  it('拉丁名取前两个词的首字母并大写', () => {
    expect(initialsOf('DataOps Admin')).toBe('DA')
    expect(initialsOf('font check')).toBe('FC')
  })

  it('单词名取前两个字符，保证最多两个字形', () => {
    expect(initialsOf('operator')).toBe('OP')
  })

  it('空名字回退到问号，而不是画出空圆', () => {
    expect(initialsOf('')).toBe('?')
    expect(initialsOf('   ')).toBe('?')
  })
})

describe('头像底色', () => {
  it('同一段文字的缩写是稳定的', () => {
    // 头像不再按人变色：DataOps 门户对所有账号都用同一个蓝底白字，工作区复现同一张脸。
    // 所以这里只断言缩写规则本身，不再断言颜色区分度。
    expect(initialsOf('张三')).toBe('张三')
    expect(initialsOf('张三')).toBe(initialsOf('张三'))
  })

  it('缩写对空白与空串都有兜底', () => {
    expect(initialsOf('')).toBe('?')
    expect(initialsOf('   ')).toBe('?')
  })
})
