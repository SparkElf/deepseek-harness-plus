/**
 * 「归我所有」的归属判定。
 *
 * 用户报的 bug 是：个人目录下有 4 个文件，这个 Tab 却是空的。根因是分支根本没写
 * （落到 `return []`）。这组装的是修好之后的**语义**，特别是三条容易退化的边界：
 * 别人的个人目录不算我的、共享桶要看权限、权限未知时既不丢也不认。
 */
import { describe, expect, it } from 'vitest'
import {
  bucketOfPath,
  isInOwnPersonalFolder,
  mineVerdict,
  selectOwnedRows,
  type Manageability,
} from '../src/client/mineScope.ts'

const ME = 'u-me'

describe('a path is only "mine" inside my own personal folder', () => {
  it('recognises my own folder and its children', () => {
    expect(isInOwnPersonalFolder('personal/u-me/a.md', ME)).toBe(true)
    expect(isInOwnPersonalFolder('personal/u-me/deep/b.md', ME)).toBe(true)
  })

  it('does not claim a colleague folder', () => {
    // The bug this guards: every personal folder looking like the reader's own.
    expect(isInOwnPersonalFolder('personal/u-other/a.md', ME)).toBe(false)
  })

  it('does not claim the personal container itself', () => {
    // `personal/` is the level that holds everyone's folders, not a document of mine.
    expect(isInOwnPersonalFolder('personal', ME)).toBe(false)
    expect(isInOwnPersonalFolder('personal/', ME)).toBe(false)
  })

  it('never matches without a caller id', () => {
    expect(isInOwnPersonalFolder('personal/u-me/a.md', undefined)).toBe(false)
    expect(isInOwnPersonalFolder('personal//a.md', '')).toBe(false)
  })
})

describe('the verdict distinguishes yes, no and not-known', () => {
  it('my own folder is mine regardless of any permission answer', () => {
    // It is mine by construction; no lookup can make it not mine.
    for (const m of ['writable', 'read-only', 'unknown'] as Manageability[]) {
      expect(mineVerdict('personal/u-me/a.md', ME, m)).toBe('mine')
    }
  })

  it('a writable shared path is mine', () => {
    expect(mineVerdict('global/a.md', ME, 'writable')).toBe('mine')
    expect(mineVerdict('department/dev/a.md', ME, 'writable')).toBe('mine')
  })

  it('a read-only shared path is not mine', () => {
    expect(mineVerdict('global/a.md', ME, 'read-only')).toBe('not-mine')
  })

  it('an unknown answer is undetermined, NOT "mine"', () => {
    // The constraint from the Lead: do not silently treat unknown as permitted.
    expect(mineVerdict('global/a.md', ME, 'unknown')).toBe('undetermined')
  })
})

describe('undetermined rows are shown and reported, never silently dropped', () => {
  it('includes them so a file cannot vanish from the tab', () => {
    // The reported bug was exactly this: files existed and simply did not appear.
    const rows = [
      { relPath: 'personal/u-me/a.md' },
      { relPath: 'global/b.md' },
    ]
    const result = selectOwnedRows(rows, ME, () => 'unknown')
    expect(result.rows.map(r => r.relPath)).toEqual(['personal/u-me/a.md', 'global/b.md'])
    // Reported so the caller can mark them rather than pass them off as certain.
    expect(result.undetermined).toEqual(['global/b.md'])
  })

  it('drops read-only rows and keeps writable ones', () => {
    const rows = [
      { relPath: 'global/a.md' },
      { relPath: 'global/b.md' },
      { relPath: 'department/dev/c.md' },
    ]
    const answer: Record<string, Manageability> = {
      'global/a.md': 'writable',
      'global/b.md': 'read-only',
      'department/dev/c.md': 'writable',
    }
    const result = selectOwnedRows(rows, ME, p => answer[p] ?? 'unknown')
    expect(result.rows.map(r => r.relPath)).toEqual(['global/a.md', 'department/dev/c.md'])
    expect(result.undetermined).toEqual([])
  })

  it('keeps the caller personal rows even when everything else is refused', () => {
    const rows = [{ relPath: 'personal/u-me/x.md' }, { relPath: 'global/y.md' }]
    const result = selectOwnedRows(rows, ME, () => 'read-only')
    expect(result.rows.map(r => r.relPath)).toEqual(['personal/u-me/x.md'])
  })
})

describe('bucketOfPath reads only the first segment', () => {
  it('splits on the first slash', () => {
    expect(bucketOfPath('global/a.md')).toBe('global')
    expect(bucketOfPath('department/dev/deep/a.md')).toBe('department')
  })

  it('returns a bare name unchanged', () => {
    expect(bucketOfPath('a.md')).toBe('a.md')
  })
})
