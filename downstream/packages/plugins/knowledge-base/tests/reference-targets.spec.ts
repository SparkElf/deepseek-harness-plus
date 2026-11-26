/**
 * 引用目标与批量菜单的判定逻辑。
 *
 * 这一层只测决策：一次点击该引用几条、批量菜单该覆盖哪些行、数量怎么进文案。
 * 组件接线（弹窗真的弹出、插入真的落到输入框）由 Playwright 在真机上验证，
 * 因为这些行为里没有一条能在无 DOM 的 runner 里被有意义地断言。
 */
import { describe, expect, it } from 'vitest'
import {
  batchLabel,
  batchRowsFor,
  referenceTargetsFor,
  type BatchRow,
} from '../src/client/referenceTargets.ts'

/** One selected row. */
const row = (relPath: string, isDir = false): BatchRow => ({
  relPath,
  name: relPath.split('/').pop() ?? relPath,
  isDir,
})

describe('reference picks the rows the reader can see selected', () => {
  it('references just the clicked row when nothing is selected', () => {
    // The ordinary single-row case, and the one that must not regress when a batch
    // path is added beside it.
    expect(referenceTargetsFor('global/a.md')).toEqual([{ path: 'global/a.md', isDir: false }])
  })

  it('references only the clicked row when the selection is a single row', () => {
    // A one-row selection is not a batch: the menu and the picker both stay single.
    expect(referenceTargetsFor('global/a.md', [row('global/a.md')]))
      .toEqual([{ path: 'global/a.md', isDir: false }])
  })

  it('references every selected row when the click is inside the selection', () => {
    const selection = [row('global/a.md'), row('global/b.md'), row('global/docs', true)]
    expect(referenceTargetsFor('global/b.md', selection)).toEqual([
      { path: 'global/a.md', isDir: false },
      { path: 'global/b.md', isDir: false },
      { path: 'global/docs', isDir: true },
    ])
  })

  it('references only the clicked row when it sits OUTSIDE the selection', () => {
    // Acting on a batch the reader did not point at is a surprise; the click names
    // the row it wants.
    const selection = [row('global/a.md'), row('global/b.md')]
    expect(referenceTargetsFor('global/c.md', selection))
      .toEqual([{ path: 'global/c.md', isDir: false }])
  })

  it('carries each row own isDir, because a mention is spelled differently', () => {
    const selection = [row('global/docs', true), row('global/docs/a.md')]
    const targets = referenceTargetsFor('global/docs', selection)
    expect(targets.map(t => t.isDir)).toEqual([true, false])
  })
})

describe('batch menu covers the same rows the picker would reference', () => {
  it('covers nothing for a single-row click', () => {
    // Empty list = single-row menu. The menu reads this to decide its labels.
    expect(batchRowsFor(row('global/a.md'), undefined)).toEqual([])
    expect(batchRowsFor(row('global/a.md'), [row('global/a.md')])).toEqual([])
  })

  it('covers the whole selection when the click is inside it', () => {
    const selection = [row('global/a.md'), row('global/b.md')]
    expect(batchRowsFor(row('global/a.md'), selection))
      .toEqual([row('global/a.md'), row('global/b.md')])
  })

  it('covers nothing when the click is outside the selection', () => {
    const selection = [row('global/a.md'), row('global/b.md')]
    expect(batchRowsFor(row('global/c.md'), selection)).toEqual([])
  })

  it('agrees with the picker on the same click', () => {
    // The two must not disagree: a menu saying "3 items" that references 2 (or deletes
    // the wrong set) is the exact confusion a shared helper prevents.
    const selection = [row('global/a.md'), row('global/b.md'), row('global/c.md')]
    const menuRows = batchRowsFor(row('global/b.md'), selection)
    const pickerTargets = referenceTargetsFor('global/b.md', selection)
    expect(menuRows.map(r => r.relPath)).toEqual(pickerTargets.map(t => t.path))
  })
})

describe('a batch label always states the number it will act on', () => {
  it('substitutes the count', () => {
    expect(batchLabel('收藏 {n} 项', 3)).toBe('收藏 3 项')
    expect(batchLabel('Delete {n} items', 12)).toBe('Delete 12 items')
  })

  it('leaves a label without a placeholder untouched', () => {
    // A single-row label reaching this path must not be mangled.
    expect(batchLabel('收藏', 3)).toBe('收藏')
  })

  it('replaces only the first placeholder, so a literal brace stays readable', () => {
    expect(batchLabel('{n} of {n}', 2)).toBe('2 of {n}')
  })
})
