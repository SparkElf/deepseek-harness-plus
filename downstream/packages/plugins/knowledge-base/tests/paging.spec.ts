/**
 * The arithmetic behind every table's pager.
 *
 * Paging looks trivial until a list shrinks under the reader, and then it is the
 * difference between "showing rows 41-60 of 45" and an empty table. These pin the
 * clamping, the never-zero page count, and the size-change behaviour.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  needsPager,
  pageAfterSizeChange,
  paginate,
} from '../src/client/paging.ts'

/** A list of numbers 1..n, so a slice is readable in an assertion. */
function rows(n: number): number[] {
  return Array.from({ length: n }, (_, index) => index + 1)
}

describe('slicing a page', () => {
  it('returns the requested slice and the numbers a pager draws', () => {
    const page = paginate(rows(45), 2, 20)
    expect(page.rows).toEqual(rows(45).slice(20, 40))
    expect(page.page).toBe(2)
    expect(page.pageCount).toBe(3)
    expect(page.total).toBe(45)
  })

  it('clamps a page past the end onto the last page', () => {
    // The list shrank from three pages to one under a reader who was on page 3. Obeying
    // the number would render nothing; clamping shows the rows that do exist.
    const page = paginate(rows(5), 3, 20)
    expect(page.page).toBe(1)
    expect(page.pageCount).toBe(1)
    expect(page.rows).toEqual(rows(5))
  })

  it('clamps a page below the start onto page one', () => {
    for (const bad of [0, -1, -999]) {
      const page = paginate(rows(45), bad, 20)
      expect(page.page).toBe(1)
      expect(page.rows).toEqual(rows(45).slice(0, 20))
    }
  })

  it('never reports page zero, even for an empty list', () => {
    // "Page 1 of 0" is the bug this rule exists to prevent. An empty table reports one
    // empty page, and the caller hides the pager.
    const empty = paginate([], 1, 20)
    expect(empty.pageCount).toBe(1)
    expect(empty.page).toBe(1)
    expect(empty.total).toBe(0)
    expect(empty.rows).toEqual([])
    expect(needsPager(empty.total, 20)).toBe(false)
  })

  it('shows a short list on one page', () => {
    const page = paginate(rows(3), 1, 20)
    expect(page.pageCount).toBe(1)
    expect(page.rows).toEqual([1, 2, 3])
    expect(needsPager(3, 20)).toBe(false)
  })

  it('survives a nonsensical page size instead of dividing by zero', () => {
    for (const bad of [0, -20, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const page = paginate(rows(45), 1, bad)
      expect(page.pageCount).toBe(3) // falls back to 20
      expect(page.rows).toHaveLength(20)
    }
  })

  it('treats a fractional or NaN page as page one rather than slicing from a fraction', () => {
    expect(paginate(rows(45), 2.7, 20).page).toBe(2)
    expect(paginate(rows(45), Number.NaN, 20).page).toBe(1)
  })

  it('covers every page exactly once, with no row repeated or dropped', () => {
    // The property that makes paging trustworthy: concatenating the pages reproduces
    // the ordered input.
    const all = rows(45)
    const seen: number[] = []
    for (let page = 1; page <= paginate(all, 1, 20).pageCount; page += 1) {
      seen.push(...paginate(all, page, 20).rows)
    }
    expect(seen).toEqual(all)
  })
})

describe('changing the page size', () => {
  it('keeps the first visible row in view', () => {
    // On page 3 of 20 the reader is looking at row 41. Switching to 100 should land on
    // the page holding row 41, which is page 1; switching to 50 is also page 1.
    expect(pageAfterSizeChange(3, 20, 50)).toBe(1)
    // On page 4 of 20 the first row is 61; at 50 per page that is page 2.
    expect(pageAfterSizeChange(4, 20, 50)).toBe(2)
  })

  it('goes to page one when switching from a large size to a small one', () => {
    // Row 1 is visible on page 1 of any size, so the answer is always 1.
    expect(pageAfterSizeChange(1, 100, 20)).toBe(1)
  })

  it('stays in range after the list shrinks', () => {
    // Page 1 of any size always shows row 1, so a size change from page 1 stays there.
    expect(pageAfterSizeChange(1, 20, 10)).toBe(1)
    // On page 3 of 20 the reader is looking at row 41. At 10 per page row 41 is on
    // page 5, which is where the size change lands -- the first visible row stays put.
    expect(pageAfterSizeChange(3, 20, 10)).toBe(5)
    expect(paginate(rows(45), 5, 10).page).toBe(5)
    // The shrink case is what the clamp is for: the same requested page 5 with only 5
    // rows left must show page 1 rather than an empty page 5.
    expect(paginate(rows(5), 5, 10).page).toBe(1)
  })
})

describe('ordering survives paging', () => {
  it('does not reorder the rows it is given', () => {
    // Sorting is the caller's job and runs before this call. If paging sorted too, a
    // table with no explicit sort would appear to reorder on every page turn.
    const ordered = [9, 7, 5, 3, 1]
    expect(paginate(ordered, 1, 2).rows).toEqual([9, 7])
    expect(paginate(ordered, 2, 2).rows).toEqual([5, 3])
    expect(paginate(ordered, 3, 2).rows).toEqual([1])
  })

  it('slices the filtered list, so the total is the match count', () => {
    // A search box trimming 45 rows to 7 must page 7, not 45: the pager's "of N" is the
    // number the reader can actually reach.
    const filtered = rows(45).filter(n => n % 2 === 0)
    const page = paginate(filtered, 1, 5)
    expect(page.total).toBe(filtered.length)
    expect(page.pageCount).toBe(Math.ceil(filtered.length / 5))
    expect(page.rows).toEqual(filtered.slice(0, 5))
  })
})

describe('the shared page sizes', () => {
  it('offers 20, 50 and 100 with 20 as the default', () => {
    expect(PAGE_SIZES).toEqual([20, 50, 100])
    expect(DEFAULT_PAGE_SIZE).toBe(20)
    expect(PAGE_SIZES).toContain(DEFAULT_PAGE_SIZE)
  })

  it('needs a pager exactly when the table is longer than one page', () => {
    expect(needsPager(20, 20)).toBe(false)
    expect(needsPager(21, 20)).toBe(true)
    expect(needsPager(0, 20)).toBe(false)
  })
})
