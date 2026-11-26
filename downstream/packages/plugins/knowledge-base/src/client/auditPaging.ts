/**
 * Ordering for the audit trail.
 *
 * Only the ordering lives here. Paging is the shared `paging.ts` utility that the other
 * tables in this package use, adopted rather than duplicated: two implementations of
 * "slice a page and clamp it" drift, and the one that is not used by the table next door
 * is the one that gets the fix.
 *
 * The order is a correctness rule, not a presentation detail. The Host happens to append
 * newest-last to its log, so a table that drew the array as received would look right
 * until the writer changed. The reader's question is "what happened most recently", and
 * that answer is computed here from the timestamps.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

/** The fields the ordering rule needs. */
export interface AuditRow {
  /** ISO-8601 instant the row records. */
  at: string
  /** Path the action concerned, used as the tie-breaker. */
  relPath: string
  /** What was done, used as the second tie-breaker. */
  action: string
  /** Destination for a move, used as the last tie-breaker. */
  toRelPath?: string
}

/**
 * Compare two instants, newest first.
 *
 * `Date.parse` rather than string comparison: the Host writes ISO-8601, which sorts
 * lexically only while every stamp shares one timezone form. Parsing costs nothing here
 * and keeps the order correct if a stamp ever arrives with an offset.
 * @param left - first timestamp.
 * @param right - second timestamp.
 * @returns negative when `left` is newer.
 */
function compareInstants(left: string, right: string): number {
  const a = Date.parse(left)
  const b = Date.parse(right)
  // An unparseable stamp sinks to the bottom instead of landing at the top, where it
  // would look like the most recent thing that ever happened.
  if (Number.isNaN(a) && Number.isNaN(b)) return 0
  if (Number.isNaN(a)) return 1
  if (Number.isNaN(b)) return -1
  return b - a
}

/**
 * Order rows newest first, with a stable tie-break.
 *
 * The secondary keys are what stop rows from swapping places between renders when several
 * share an instant -- the normal case for a batch, where one action writes several rows
 * with the same `at`. Without them the platform sort could order equal keys either way,
 * and a reader paging forward would see a row twice or not at all.
 *
 * Ordering is total: `relPath`, then `action`, then `toRelPath` are all compared, and two
 * rows equal in every one of those are indistinguishable to this table anyway.
 * @param rows - the rows as received.
 * @returns A new array; the input is not mutated.
 */
export function sortAuditRows<T extends AuditRow>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => {
    const byInstant = compareInstants(left.at, right.at)
    if (byInstant !== 0) return byInstant
    if (left.relPath !== right.relPath) return left.relPath < right.relPath ? -1 : 1
    if (left.action !== right.action) return left.action < right.action ? -1 : 1
    const leftTo = left.toRelPath ?? ''
    const rightTo = right.toRelPath ?? ''
    if (leftTo !== rightTo) return leftTo < rightTo ? -1 : 1
    return 0
  })
}
