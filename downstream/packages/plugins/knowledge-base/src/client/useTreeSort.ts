/**
 * The knowledge tree's row ordering, remembered per browser.
 *
 * Sorting is a VIEW preference: it decides how one reader scans a list, not what is in the
 * tree. That makes the browser the right place for it -- there is nothing to share with
 * another machine, and a round trip before the list reorders would make a one-click control
 * feel broken. (The list/grid layout, by contrast, lives in the view directory because it
 * was built as a document-level preference; sorting deliberately does not copy that.)
 *
 * The stored key carries the panel id so two different knowledge panels -- or two
 * deployments mounted on one origin -- cannot read each other's choice.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useState } from 'react'

/**
 * The orderings the tree offers.
 *
 * `mtime` first because it is the default: a folder is usually opened to find what was
 * just worked on. `name` is the host's own order, `type` groups by extension, `size`
 * surfaces the large documents.
 */
export type TreeSortKey = 'mtime' | 'name' | 'type' | 'size'

/** Every ordering, in the order the menu lists them. */
export const TREE_SORT_KEYS: readonly TreeSortKey[] = ['mtime', 'name', 'type', 'size']

/** Most recently modified first. */
export const DEFAULT_TREE_SORT: TreeSortKey = 'mtime'

/** What the rail gets back. */
export interface TreeSortStore {
  /** The current ordering. */
  key: TreeSortKey
  /** Choose another ordering; written through to storage. */
  setKey: (key: TreeSortKey) => void
}

/**
 * Whether a value is one of the orderings.
 * @param value - the candidate.
 * @returns Whether it is a known key.
 */
export function isTreeSortKey(value: unknown): value is TreeSortKey {
  return typeof value === 'string' && (TREE_SORT_KEYS as readonly string[]).includes(value)
}

/**
 * Build the storage key for one panel.
 *
 * Exported so the test can assert the shape rather than duplicate the string.
 * @param panelId - the mounting panel's identity, may be empty.
 * @returns The localStorage key.
 */
export function treeSortStorageKey(panelId: string): string {
  return 'dsh-kb-sort:' + (panelId === '' ? 'default' : panelId)
}

/**
 * Read the stored ordering.
 *
 * Any failure -- no storage (a privacy mode, a server render), an unknown value from an
 * older build -- answers the default rather than throwing: a preference that cannot be read
 * must not take the tree down with it.
 * @param panelId - the mounting panel's identity.
 * @returns The stored ordering, or the default.
 */
export function readTreeSort(panelId: string): TreeSortKey {
  try {
    const raw = globalThis.localStorage?.getItem(treeSortStorageKey(panelId))
    return isTreeSortKey(raw) ? raw : DEFAULT_TREE_SORT
  } catch {
    return DEFAULT_TREE_SORT
  }
}

/**
 * Persist the ordering.
 *
 * A write failure is swallowed for the same reason: the reader's click should still take
 * effect for this session even when the browser refuses to remember it.
 * @param panelId - the mounting panel's identity.
 * @param key - the ordering to store.
 */
export function writeTreeSort(panelId: string, key: TreeSortKey): void {
  try {
    globalThis.localStorage?.setItem(treeSortStorageKey(panelId), key)
  } catch {
    // Remembering is a convenience; failing to remember is not an error worth showing.
  }
}

/**
 * Read and write the tree's ordering.
 * @param panelId - the mounting panel's identity, used to scope the stored key.
 * @returns The store.
 */
export function useTreeSort(panelId: string): TreeSortStore {
  // Seeded from storage on the first render so the list never flashes the wrong order.
  const [key, setLocalKey] = useState<TreeSortKey>(() => readTreeSort(panelId))

  // The panel id can arrive after mount (the mount point is read asynchronously), so the
  // stored value is re-read when it changes rather than assuming the first render's id.
  useEffect(() => { setLocalKey(readTreeSort(panelId)) }, [panelId])

  const setKey = useCallback((next: TreeSortKey): void => {
    setLocalKey(next)
    writeTreeSort(panelId, next)
  }, [panelId])

  return { key, setKey }
}
