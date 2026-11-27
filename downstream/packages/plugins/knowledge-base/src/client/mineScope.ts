/**
 * Which documents belong under "Owned by me".
 *
 * Two rules, and the second is the one users asked for explicitly: a document in the
 * caller's own personal folder is theirs, and a document the caller can WRITE is also
 * theirs to manage -- an administrator who maintains `global/` should not have to open
 * the tree to find those files, because the Home tab is where they look first.
 *
 * Write access is not derivable from the tree, so the caller passes in what it knows.
 * The important part is the three-valued answer: "yes", "no" and "not known" are all
 * different, and an unknown permission must not be silently treated as either.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

/** What the caller knows about one path's manageability. */
export type Manageability =
  /** The caller may write or manage it. */
  | 'writable'
  /** The caller may read it but not write it. */
  | 'read-only'
  /** No answer was available: not configured, refused, or not looked up. */
  | 'unknown'

/** What a row's membership answer is. */
export type MineVerdict =
  /** Belongs under "Owned by me". */
  | 'mine'
  /** Does not belong. */
  | 'not-mine'
  /** Cannot be decided; the caller must mark the row rather than drop or claim it. */
  | 'undetermined'

/**
 * The bucket a path sits in, by its first segment.
 * @param relPath - path relative to the knowledge root.
 * @returns The bucket name, or an empty string when the path is empty.
 */
export function bucketOfPath(relPath: string): string {
  const cut = relPath.indexOf('/')
  return cut === -1 ? relPath : relPath.slice(0, cut)
}

/**
 * Whether a path sits inside the caller's own personal folder.
 *
 * `personal/<callerId>/...` and nothing else: a sibling's folder is not the caller's,
 * and the caller's bare `personal/` level is a container rather than their documents.
 * @param relPath - path relative to the knowledge root.
 * @param callerId - the caller's own id, when known.
 * @returns True when the path is under the caller's own folder.
 */
export function isInOwnPersonalFolder(relPath: string, callerId: string | undefined): boolean {
  if (callerId === undefined || callerId === '') return false
  return relPath.startsWith('personal/' + callerId + '/')
}

/**
 * Decide whether one path belongs under "Owned by me".
 *
 * The caller's own personal folder is unconditional: it is theirs by construction, and
 * no permission lookup can make it not theirs. Every other path depends on write access,
 * which is why an unknown answer is NOT treated as permission -- showing a document as
 * "mine" when the caller cannot write it would be a claim the deployment cannot back.
 *
 * An undetermined row is neither dropped nor claimed: the caller renders it with a mark,
 * which is the existing degradation for a permission answer that could not be read.
 * @param relPath - path relative to the knowledge root.
 * @param callerId - the caller's own id, when known.
 * @param manageability - what is known about write access for this path.
 * @returns Whether the row is mine, not mine, or undecidable.
 */
export function mineVerdict(
  relPath: string,
  callerId: string | undefined,
  manageability: Manageability,
): MineVerdict {
  if (isInOwnPersonalFolder(relPath, callerId)) return 'mine'
  if (manageability === 'writable') return 'mine'
  if (manageability === 'read-only') return 'not-mine'
  return 'undetermined'
}

/**
 * The rows under "Owned by me", given what is known about each.
 *
 * Undetermined rows are included and reported separately, because dropping them is the
 * silent-loss failure the user reported: their files existed and simply did not appear.
 * The caller shows them with a mark rather than hiding them.
 * @param rows - every candidate row, in display order.
 * @param callerId - the caller's own id, when known.
 * @param manageabilityOf - per-path write knowledge.
 * @returns The rows to show and the paths whose answer was undetermined.
 */
export function selectOwnedRows<T extends { relPath: string }>(
  rows: readonly T[],
  callerId: string | undefined,
  manageabilityOf: (relPath: string) => Manageability,
): { rows: T[]; undetermined: string[] } {
  const owned: T[] = []
  const undetermined: string[] = []
  for (const row of rows) {
    const verdict = mineVerdict(row.relPath, callerId, manageabilityOf(row.relPath))
    if (verdict === 'mine') owned.push(row)
    else if (verdict === 'undetermined') {
      owned.push(row)
      undetermined.push(row.relPath)
    }
  }
  return { rows: owned, undetermined }
}
