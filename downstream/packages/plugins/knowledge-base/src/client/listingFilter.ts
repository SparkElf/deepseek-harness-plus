/**
 * In-place narrowing of a listing by row name.
 *
 * Kept as a pure function, out of the component, because the component cannot be mounted
 * in a unit test (it pulls the UI primitives and the workspace path helpers) and the rules
 * below are the part that is easy to get wrong: case folding, substring vs prefix, and —
 * most of all — keeping a hit reachable from the root.
 *
 * @module dsh-better-sidebar/client/listing-filter
 */

/**
 * The little a row must expose to be filtered.
 *
 * Only the NAME is required: callers key their rows differently (the explorer by absolute
 * path), so the child lookup is passed in as {@link childrenOf} rather than assumed to be
 * a field name.
 */
export interface FilterableEntry {
  /** Base name, what the reader scans. */
  name: string
  /** Whether the row opens a level. */
  isDir: boolean
}

/** Resolve one directory row's loaded children, if that level has been read. */
export type ChildrenOf<T extends FilterableEntry> = (entry: T) => readonly T[] | undefined

/**
 * Whether a name matches the reader's term.
 *
 * Substring, case-insensitive, on the NAME only: this is the tree's in-place narrowing,
 * and reading file bodies is what the cross-directory search is for.
 * @param name - the row's base name.
 * @param needle - the term, already trimmed and lower-cased by {@link normaliseNeedle}.
 * @returns Whether the row itself matches.
 */
export function nameMatches(name: string, needle: string): boolean {
  if (needle === '') return true
  // Defensive lower-casing: a caller that forgot `normaliseNeedle` would otherwise get a
  // silent "no match" for every uppercase term, which reads as a broken filter rather than
  // as a misuse.
  return name.toLowerCase().includes(needle.toLowerCase())
}

/**
 * Prepare the reader's raw input for matching.
 *
 * Trimmed because a trailing space is invisible and would otherwise make every term match
 * nothing; lower-cased once here rather than once per row.
 * @param raw - what the field holds.
 * @returns The term to compare against.
 */
export function normaliseNeedle(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * Narrow one level, recursively, keeping every hit reachable.
 *
 * A directory is kept when it matches, when anything under it matches, or when an ANCESTOR
 * matched — the last case is what makes typing a folder name show the folder's contents
 * instead of an empty row. A deeply nested hit therefore drags its whole chain with it,
 * which is the only way a file inside a collapsed folder can be seen.
 * @param rows - this level's rows, in display order.
 * @param childrenOf - one directory row's loaded children; `undefined` means "not loaded".
 * @param needle - the term, already normalised.
 * @param withinMatch - whether an ancestor already matched the term.
 * @returns The rows to draw at this level.
 */
export function filterLevel<T extends FilterableEntry>(
  rows: readonly T[],
  childrenOf: ChildrenOf<T>,
  needle: string,
  withinMatch = false,
): T[] {
  if (needle === '') return [...rows]
  const kept: T[] = []
  for (const entry of rows) {
    const selfMatch = nameMatches(entry.name, needle)
    if (entry.isDir) {
      // `undefined` means the level has not been read; it cannot be searched, so the
      // directory is judged on its own name alone (the same answer the walk gives when the
      // reader expands it).
      const kids = childrenOf(entry)
      const kidMatch = kids === undefined ? false : filterLevel(kids, childrenOf, needle, selfMatch).length > 0
      if (selfMatch || kidMatch || withinMatch) kept.push(entry)
      continue
    }
    if (selfMatch || withinMatch) kept.push(entry)
  }
  return kept
}
