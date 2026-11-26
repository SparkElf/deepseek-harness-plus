/**
 * Page slicing for every table in the knowledge surface.
 *
 * A pure module rather than a hook: the rule worth testing is arithmetic, and a hook
 * would need a renderer to exercise. The component owns the page and size as state;
 * this answers what that state should display.
 *
 * The one rule that matters is the clamp. A reader can be on page 7 of a table when a
 * filter, a search word or a re-read shrinks it to two pages, and obeying "page 7"
 * literally renders an empty table with a pager that still says there is data. So the
 * requested page is clamped into range and the clamped value is returned, which is what
 * the owner writes back into its own state.
 *
 * @module @sparkelf/dsh-knowledge-base/client/paging
 */

/** Page sizes every table offers, in the order the control shows them. */
export const PAGE_SIZES = [20, 50, 100] as const

/** The page size a fresh table starts on. */
export const DEFAULT_PAGE_SIZE = 20

/** One page of rows plus the numbers a pager draws. */
export interface Page<T> {
  /** The rows on this page, in order. */
  rows: T[]
  /** 1-based page actually shown, clamped into range. */
  page: number
  /** Total number of pages; never zero, so no pager can say "page 1 of 0". */
  pageCount: number
  /** Total row count across all pages. */
  total: number
}

/**
 * Whether a table of this size needs a pager at all.
 *
 * A single page has nothing to page through, so the control row is not drawn: an
 * always-visible pager on a three-row table is furniture that implies the reader is
 * missing something. Empty is the same answer for the same reason.
 * @param total - row count before slicing.
 * @param pageSize - rows per page.
 * @returns true when there is more than one page.
 */
export function needsPager(total: number, pageSize: number): boolean {
  const size = normalisePageSize(pageSize)
  return total > size
}

/**
 * Coerce a page size to something usable.
 *
 * A zero or negative size would divide by zero; a fraction or NaN would produce a
 * non-integer page count. Falling back to the default keeps the pager drawable rather
 * than letting a bad value blank the table.
 * @param pageSize - the candidate size.
 * @returns A positive safe integer.
 */
function normalisePageSize(pageSize: number): number {
  return Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE
}

/**
 * Slice one page out of a list that is already in display order.
 *
 * Ordering is the caller's job and happens BEFORE this call: pagination must never
 * reorder, or turning a page would appear to sort the table differently. The same
 * applies to filtering -- a filtered list is what gets paged, so the count in the pager
 * is the count of matches rather than of the whole table.
 *
 * @param rows - rows already filtered and ordered.
 * @param page - 1-based page requested; clamped into range.
 * @param pageSize - rows per page; a non-positive or non-integer value falls back.
 * @returns The page and the numbers to draw.
 */
export function paginate<T>(rows: readonly T[], page: number, pageSize: number): Page<T> {
  const total = rows.length
  const size = normalisePageSize(pageSize)
  const pageCount = Math.max(1, Math.ceil(total / size))
  // Guard NaN, zero, negatives and fractions before clamping. `Math.floor` first so a
  // fractional page cannot slice from a non-integer offset.
  const wanted = Number.isFinite(page) ? Math.floor(page) : 1
  const clamped = Math.min(Math.max(wanted, 1), pageCount)
  const start = (clamped - 1) * size
  return { rows: rows.slice(start, start + size), page: clamped, pageCount, total }
}

/**
 * The 1-based page a size change should land on.
 *
 * Keeping the first visible row in view is the point: a reader who switches from 20 to
 * 100 rows is looking at row 41, so the page they want is the one containing it, not
 * page 1 and not page 3 of the old numbering. Clamping in {@link paginate} then keeps
 * that answer in range if the list is shorter than expected.
 *
 * @param currentPage - page shown before the change.
 * @param previousSize - size in force before the change.
 * @param nextSize - size being chosen.
 * @returns The 1-based page to request.
 */
export function pageAfterSizeChange(currentPage: number, previousSize: number, nextSize: number): number {
  const before = normalisePageSize(previousSize)
  const after = normalisePageSize(nextSize)
  const page = Number.isFinite(currentPage) ? Math.max(1, Math.floor(currentPage)) : 1
  // The index of the first row currently visible, expressed in the new page grid.
  const firstVisibleRow = (page - 1) * before
  return Math.floor(firstVisibleRow / after) + 1
}
