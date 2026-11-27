/**
 * Where a dropped file actually lands.
 *
 * The tree shows a reader a `personal` folder, but the authoritative tree stores every
 * caller's documents under their own id (`personal/<owner>/<file>`) -- the owner segment
 * is hidden from the view on purpose, because it is an implementation detail a reader
 * never typed. The consequence is that a tree row labelled 「个人」 carries the path
 * `personal`, and writing straight to it puts the file in `personal/` beside the owner
 * directories, where no view will ever show it: the reader uploads, the progress row says
 * "done", and the file is invisible.
 *
 * This module owns that translation so every drop entry point (the borrowed explorer, the
 * plugin's own listing, the Home table) answers the same question the same way.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

/** The bucket whose second segment is the caller's own id, hidden from the view. */
const PERSONAL = 'personal'

/**
 * Resolve a view-relative directory into the authoritative path a write must use.
 *
 * A `personal` path gains the caller's id as its second segment, at whatever depth the
 * drop names: the bucket row (`personal`), a folder inside it (`personal/specs`), or one
 * nested deeper all resolve to the caller's own subtree. Everything else (`global`,
 * `department/...`, `''` for the mount root) is already authoritative and passes through.
 *
 * A `personal` path with no caller id is REFUSED rather than passed through. Writing to
 * `personal` without an owner is exactly the defect this function exists to prevent, so
 * the refusal is explicit: `undefined` means "no safe destination", and the caller reports
 * it instead of writing somewhere the reader cannot see.
 * @param viewRelDir - the directory as the VIEW names it (what a tree row carries).
 * @param callerId - the id the Host reports for the caller, when it is known.
 * @returns The authoritative relative directory, or undefined when it cannot be resolved.
 */
export function resolveUploadDir(viewRelDir: string, callerId: string | undefined): string | undefined {
  // The view and the authoritative tree share one separator; normalising here keeps a
  // caller that joined with a trailing slash from producing `personal//`.
  // Padding is trimmed, not just trimmed around separators: a caller that names the
  // mount root as a blank string means the root, not a directory called ' '.
  const normalized = viewRelDir.trim().replace(/\\/gu, '/').replace(/^\/+/u, '').replace(/\/+$/u, '')
  if (normalized === '') return ''
  if (normalized === PERSONAL) {
    return callerId === undefined || callerId === '' ? undefined : PERSONAL + '/' + callerId
  }
  if (normalized.startsWith(PERSONAL + '/')) {
    if (callerId === undefined || callerId === '') return undefined
    // The id goes immediately after the bucket, so a nested drop lands in the caller's
    // own subtree rather than at `personal/specs` (another owner's namespace or a stray
    // directory beside the owners).
    return PERSONAL + '/' + callerId + '/' + normalized.slice(PERSONAL.length + 1)
  }
  return normalized
}
