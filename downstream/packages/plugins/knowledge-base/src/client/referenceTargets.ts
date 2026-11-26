/**
 * Pure helpers for the reference picker and the batch menu.
 *
 * Kept out of the components because the parts worth testing are the decisions, not the
 * rendering: how a selection becomes a target list, what the batch label says, and which
 * entries a paste loop should attempt. The components are wired to these, so a change in
 * behaviour here is what the tests below pin down; the real DOM interaction is covered by
 * the browser walkthrough instead.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

/** One entry a reference will be inserted for, in absolute path form. */
export interface ReferenceTarget {
  /** Absolute path as the tree and the routes speak it. */
  path: string
  /** True for a directory (folder mention) rather than a document (file chip). */
  isDir: boolean
}

/** One row a batch action covers. */
export interface BatchRow {
  /** Path relative to the knowledge root. */
  relPath: string
  /** Display name, for menu copy. */
  name: string
  /** Whether the row is a directory. */
  isDir: boolean
}

/**
 * The entries a picker opened on `relPath` should insert.
 *
 * A multi-row selection wins when it contains the clicked row, because that is the set
 * the reader could see highlighted. Otherwise the click is a single-row action on the row
 * under the pointer -- which is also what happens when the clicked row sits outside the
 * selection, since acting on a batch the reader did not point at would be a surprise.
 * @param relPath - the row the `@` button was pressed on.
 * @param selection - the rows the explorer reports as selected, if any.
 * @returns One target, or every selected row when the click was inside the selection.
 */
export function referenceTargetsFor(relPath: string, selection?: readonly BatchRow[]): ReferenceTarget[] {
  const inside = selection !== undefined
    && selection.length > 1
    && selection.some(row => row.relPath === relPath)
  if (!inside) return [{ path: relPath, isDir: false }]
  return selection.map(row => ({ path: row.relPath, isDir: row.isDir }))
}

/**
 * The rows a menu opened on one row should act on.
 *
 * Mirrors {@link referenceTargetsFor}: a right-click inside a multi-selection acts on the
 * whole selection, and anywhere else acts on the one row. The menu and the picker must
 * agree, or a "delete 3 items" dialog would reference four.
 * @param target - the row under the pointer.
 * @param selection - the rows marked selected, if any.
 * @returns The rows the batch entries cover, or an empty list for a single-row menu.
 */
export function batchRowsFor(target: BatchRow, selection?: readonly BatchRow[]): BatchRow[] {
  if (selection === undefined || selection.length < 2) return []
  return selection.some(row => row.relPath === target.relPath) ? [...selection] : []
}

/**
 * Fill a batch label's `{n}` placeholder.
 *
 * A separate function so the count is formatted in one place: a label that prints the
 * rows it will touch must never print a different number from the rows it does touch.
 * @param template - the locale string, containing `{n}`.
 * @param count - how many rows.
 * @returns The label with the count substituted.
 */
export function batchLabel(template: string, count: number): string {
  return template.replace('{n}', String(count))
}
