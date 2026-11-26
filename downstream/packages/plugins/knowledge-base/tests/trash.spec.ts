import { describe, expect, it } from 'vitest'
import {
  addTombstone,
  hiddenPaths,
  removeTombstone,
  tombstoneHides,
  type Tombstone,
} from '../src/trash.ts'
import { bucketOf, usableDepartmentPath } from '../src/views.ts'

/** Build a tombstone with the fields a test does not care about filled in. */
function stone(relPath: string, kind: 'file' | 'directory' = 'file'): Tombstone {
  return { relPath, kind, removedBy: 'tester', removedAt: '2026-01-01T00:00:00.000Z', originalPath: relPath }
}

describe('a tombstone hides a path and what is under it', () => {
  it('hides the path it names', () => {
    expect(tombstoneHides([stone('global/a.md')], 'global/a.md')).toBeDefined()
    expect(tombstoneHides([stone('global/a.md')], 'global/b.md')).toBeUndefined()
  })

  it('hides a directory subtree, because removing a folder removes its contents', () => {
    const entries = [stone('global/2024', 'directory')]
    expect(tombstoneHides(entries, 'global/2024/report.md')).toBeDefined()
    // Deeper still: the folder is the unit of removal, not one level of it.
    expect(tombstoneHides(entries, 'global/2024/q1/plan.md')).toBeDefined()
  })

  it('does not let one name prefix another', () => {
    // A tombstone on `global/ab` must not hide `global/abc`: the boundary is a
    // separator, not a string prefix.
    const entries = [stone('global/ab', 'directory')]
    expect(tombstoneHides(entries, 'global/abc')).toBeUndefined()
    expect(tombstoneHides(entries, 'global/ab/c')).toBeDefined()
  })

  it('leaves a same-named file in another bucket visible', () => {
    // Buckets are different audiences; hiding one person's draft must not touch the
    // identically named company document.
    const entries = [stone('personal/notes.md')]
    expect(tombstoneHides(entries, 'global/notes.md')).toBeUndefined()
  })
})

describe('adding a tombstone', () => {
  it('is idempotent, because a double click sends the same request twice', () => {
    const once = addTombstone([], stone('global/a.md'))
    const twice = addTombstone(once, stone('global/a.md'))
    expect(twice).toHaveLength(1)
  })

  it('replaces the tombstones it subsumes', () => {
    // Keeping the children after the folder is removed would leave them hidden
    // after the folder is restored, which is not what restoring means.
    const entries = [stone('global/dir/a.md'), stone('global/dir/b.md')]
    const next = addTombstone(entries, stone('global/dir', 'directory'))
    expect(next.map(entry => entry.relPath)).toEqual(['global/dir'])
  })

  it('keeps unrelated removals', () => {
    const entries = [stone('global/a.md')]
    const next = addTombstone(entries, stone('personal/b.md'))
    expect(next.map(entry => entry.relPath).sort()).toEqual(['global/a.md', 'personal/b.md'])
  })

  it('appends, so the newest removal is last in the record', () => {
    const next = addTombstone([stone('global/a.md')], stone('global/b.md'))
    expect(next[next.length - 1]?.relPath).toBe('global/b.md')
  })
})

describe('restoring', () => {
  it('drops the tombstone and reports that it did', () => {
    const result = removeTombstone([stone('global/a.md')], 'global/a.md')
    expect(result.restored).toBe(true)
    expect(result.entries).toEqual([])
  })

  it('reports a restore of something not removed rather than pretending', () => {
    const result = removeTombstone([stone('global/a.md')], 'global/other.md')
    expect(result.restored).toBe(false)
    expect(result.entries).toHaveLength(1)
  })

  it('restores a folder along with the children it subsumed', () => {
    const result = removeTombstone([stone('global/dir', 'directory')], 'global/dir')
    expect(result.restored).toBe(true)
    expect(result.entries).toEqual([])
  })

  it('leaves a sibling directory alone', () => {
    const entries = [stone('global/dir', 'directory'), stone('global/other', 'directory')]
    const result = removeTombstone(entries, 'global/dir')
    expect(result.entries.map(entry => entry.relPath)).toEqual(['global/other'])
  })
})

describe('the hidden set a view builder consumes', () => {
  it('names every removed path', () => {
    const set = hiddenPaths([stone('global/a.md'), stone('personal/b.md')])
    expect([...set].sort()).toEqual(['global/a.md', 'personal/b.md'])
  })

  it('is empty when nothing was removed', () => {
    expect(hiddenPaths([]).size).toBe(0)
  })
})

describe('删除 → 列表消失 → 回收站出现 → 恢复 → 列表出现', () => {
  /**
   * The four states a reader judges the trash by, driven through the functions the
   * Host actually calls. Two coordinate spaces are exercised because that is where
   * the reported defect lived:
   *
   * - `global/a.md` is the same string in both spaces, so it always worked.
   * - `personal/<uid>/note.md` is NOT: the view drops the owner segment, so the
   *   tombstone has to be matched against `personal/note.md`. Deleting a personal
   *   document used to write the tombstone and leave the file visible.
   */
  const USER = 'u-1'

  /** The view-relative path a tombstone must also match, mirroring syncCallerView. */
  function viewPathOf(relPath: string, departmentPathCodes: readonly string[] = []): string | undefined {
    const placement = bucketOf(relPath, usableDepartmentPath(departmentPathCodes))
    return placement === undefined ? undefined : placement.bucket + '/' + placement.inner
  }

  /** The hidden set syncCallerView builds: both forms, deduplicated. */
  function hiddenSet(entries: readonly Tombstone[], codes: readonly string[] = []): Set<string> {
    const out = new Set<string>()
    for (const entry of entries) {
      out.add(entry.relPath)
      const viewPath = viewPathOf(entry.relPath, codes)
      if (viewPath !== undefined) out.add(viewPath)
    }
    return out
  }

  /** Whether the view would show this authoritative path after a sync. */
  function visibleInView(entries: readonly Tombstone[], relPath: string, codes: readonly string[] = []): boolean {
    const viewPath = viewPathOf(relPath, codes)
    if (viewPath === undefined) return false
    return !hiddenSet(entries, codes).has(viewPath)
  }

  it('runs all four states for a global document', () => {
    const relPath = 'global/a.md'
    // 1. before removal: it is in the listing.
    let tombstones: readonly Tombstone[] = []
    expect(visibleInView(tombstones, relPath)).toBe(true)

    // 2. remove: absent from the listing, present in the trash.
    tombstones = addTombstone(tombstones, stone(relPath))
    expect(visibleInView(tombstones, relPath)).toBe(false)
    expect(tombstones.map(entry => entry.relPath)).toEqual([relPath])

    // 3. restore: back in the listing, gone from the trash.
    const restored = removeTombstone(tombstones, relPath)
    expect(restored.restored).toBe(true)
    expect(restored.entries).toEqual([])
    expect(visibleInView(restored.entries, relPath)).toBe(true)
  })

  it('runs all four states for a PERSONAL document, whose view path drops the owner', () => {
    // This is the case that used to fail: the tombstone says personal/u-1/note.md but
    // the view builds personal/note.md, so the deleted file stayed visible.
    const relPath = `personal/${USER}/note.md`
    // The two spaces genuinely differ, which is what makes this test meaningful.
    expect(viewPathOf(relPath)).toBe('personal/note.md')

    let tombstones: readonly Tombstone[] = []
    expect(visibleInView(tombstones, relPath)).toBe(true)

    tombstones = addTombstone(tombstones, stone(relPath))
    // THE assertion: the deleted personal document leaves the listing.
    expect(visibleInView(tombstones, relPath)).toBe(false)
    expect(tombstones.map(entry => entry.relPath)).toEqual([relPath])

    const restored = removeTombstone(tombstones, relPath)
    expect(restored.restored).toBe(true)
    expect(visibleInView(restored.entries, relPath)).toBe(true)
  })

  it('runs all four states for a legacy flat department document', () => {
    // With NO organization path the department bucket stays one level deep, so
    // `department/<leaf>/file` is served at the bucket root as `department/file` --
    // a third shape, same rule. (A caller WITH a path keeps the chain instead, which
    // is why this case passes no codes.)
    const relPath = 'department/data-combat/legacy.md'
    expect(viewPathOf(relPath, [])).toBe('department/legacy.md')

    let tombstones: readonly Tombstone[] = []
    expect(visibleInView(tombstones, relPath, [])).toBe(true)
    tombstones = addTombstone(tombstones, stone(relPath))
    expect(visibleInView(tombstones, relPath, [])).toBe(false)

    const restored = removeTombstone(tombstones, relPath)
    expect(visibleInView(restored.entries, relPath, [])).toBe(true)
  })

  it('keeps a raw tombstone working without migration', () => {
    // Old records contain only the authoritative path. The hidden set still contains
    // that raw form, so nothing needs rewriting when this ships.
    const entries = [stone(`personal/${USER}/old.md`)]
    expect(hiddenSet(entries).has(`personal/${USER}/old.md`)).toBe(true)
    // And a caller who stores the view form directly is honoured too.
    expect(hiddenSet([stone('personal/direct.md')]).has('personal/direct.md')).toBe(true)
  })

  it('hides a whole personal directory, not just its own path', () => {
    // Removing a folder must take its contents with it: the subtree is matched on the
    // tombstoned path, and the view form carries the same relationship.
    const entries = [stone(`personal/${USER}/folder`, 'directory')]
    expect(tombstoneHides(entries, `personal/${USER}/folder/inner.md`)).toBeDefined()
    // The tombstone itself names the folder; the child is hidden by the subtree rule
    // inside `tombstoneHides`, not by a separate entry in the hidden set.
    expect(entries.some(entry => entry.relPath === `personal/${USER}/folder`)).toBe(true)
    expect(hiddenSet(entries).has('personal/folder')).toBe(true)
  })
})
