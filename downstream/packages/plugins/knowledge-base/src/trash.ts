/**
 * Tombstones: paths a caller has removed from their view without destroying the file.
 *
 * ## Why a tombstone rather than an unlink
 *
 * A view is hardlinks into one authoritative tree, and several callers' views may
 * hold a link to the same inode. Unlinking the caller's own link would hide the file
 * from them, but it would also make the removal indistinguishable from a revoked
 * grant: the next `syncView` compares grants to links, finds a grant with no link,
 * and puts the link back. Nothing in the filesystem can say "this one was removed on
 * purpose".
 *
 * So removal is recorded rather than performed. A tombstone is a note that says a
 * path is hidden from one caller's view, checked while the view is being built. The
 * file keeps its inode, every other caller keeps their link, and restoring is
 * deleting the note.
 *
 * ### DO NOT "fix" this by moving or deleting the file
 *
 * The obvious-looking change -- make `trash.remove` rename the file into a trash
 * directory, or unlink it -- is WRONG here, and it is the change a future reader is
 * most likely to make. A view entry is a hardlink to the shared authoritative copy:
 * unlinking it removes one link and leaves the data, which looks harmless, but the
 * next `syncView` finds a standing grant with no link and restores it (see above).
 * Moving the file is worse: the authoritative path is the one DataOps grants are
 * written against, so moving it silently invalidates every other caller's grant and
 * makes the document unreachable for everyone, not just the caller who removed it.
 *
 * Removal is a per-caller filter, never a filesystem operation. That is the whole
 * design, and it is why the trash record exists at all.
 *
 * ## What a tombstone is scoped to
 *
 * A tombstone belongs to a CALLER, not to a path: two people sharing a document may
 * disagree about whether it should be in their view. It therefore lives in the
 * caller's own directory and filters only that caller's view.
 *
 * A tombstone is not a permission. It hides what the caller may still be granted;
 * it never grants anything, and a restore cannot resurrect access that DataOps has
 * since withdrawn -- the grant is checked first, and a path whose grant is gone
 * stays gone whatever the tombstone says.
 *
 * @module @sparkelf/dsh-knowledge-base/trash
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** One removed path, as the trash surface lists it. */
export interface Tombstone {
  /** Path relative to the knowledge root, in view coordinates (`<bucket>/<inner>`). */
  relPath: string
  /** Whether the removed entry was a file or a directory. */
  kind: 'file' | 'directory'
  /** Display name of whoever removed it. */
  removedBy: string
  /** ISO-8601 instant of removal. */
  removedAt: string
  /**
   * Where the entry used to sit, when restoring must know more than the path.
   *
   * Equal to {@link relPath} for every current tombstone. It is stored rather than
   * derived because a future version may move a removed document into a holding
   * area, and a record that only knows where the document is not is not enough to
   * put it back.
   */
  originalPath: string
}

/** The on-disk record, versioned so a later shape can be read rather than guessed. */
interface TrashRecord {
  /** Record format version. */
  version: 1
  /** One entry per removed path, newest last. */
  entries: Tombstone[]
}

/** What this module found when it opened a caller's trash file. */
export type TrashRead =
  | { kind: 'absent' }
  | { kind: 'ready'; entries: Tombstone[] }
  /**
   * A file exists but could not be read as a trash record.
   *
   * Reported rather than swallowed: interpreting it as "empty" would resurrect every
   * document the caller had removed, and interpreting it as "everything" would hide
   * their whole tree.
   */
  | { kind: 'unreadable'; reason: string }

/** File name of a caller's trash record, inside that caller's view directory. */
const TRASH_FILE = '.kb-trash.json'

/**
 * Absolute path of one caller's trash record.
 *
 * @param viewDir - the caller's view directory.
 * @returns the path of the record, whether or not it exists.
 */
export function trashPathFor(viewDir: string): string {
  return join(viewDir, TRASH_FILE)
}

/**
 * Read a caller's trash record.
 *
 * @param viewDir - the caller's view directory.
 * @returns what the record holds; `absent` for a caller who never removed anything.
 */
export async function readTrash(viewDir: string): Promise<TrashRead> {
  let raw: string
  try {
    raw = await readFile(trashPathFor(viewDir), 'utf8')
  } catch (error) {
    if (isMissing(error)) return { kind: 'absent' }
    return { kind: 'unreadable', reason: describeError(error) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { kind: 'unreadable', reason: 'not JSON: ' + describeError(error) }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'unreadable', reason: 'not an object' }
  }
  const entries = (parsed as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return { kind: 'unreadable', reason: 'no entries array' }
  const valid: Tombstone[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.relPath !== 'string' || record.relPath === '') continue
    valid.push({
      relPath: record.relPath,
      kind: record.kind === 'directory' ? 'directory' : 'file',
      removedBy: typeof record.removedBy === 'string' ? record.removedBy : '',
      removedAt: typeof record.removedAt === 'string' ? record.removedAt : '',
      originalPath: typeof record.originalPath === 'string' && record.originalPath !== ''
        ? record.originalPath
        : record.relPath,
    })
  }
  return { kind: 'ready', entries: valid }
}

/**
 * Write a caller's trash record atomically.
 *
 * Written to a sibling and renamed into place, because a half-written record would
 * read as `unreadable` on the next load and hide a caller's whole tree. An empty
 * entry list removes the file instead of storing `{ entries: [] }`: absence is the
 * state a caller who removed nothing is already in.
 *
 * @param viewDir - the caller's view directory.
 * @param entries - the complete set of tombstones to keep.
 */
export async function writeTrash(viewDir: string, entries: readonly Tombstone[]): Promise<void> {
  const target = trashPathFor(viewDir)
  if (entries.length === 0) {
    await rm(target, { force: true })
    return
  }
  const record: TrashRecord = { version: 1, entries: [...entries] }
  await mkdir(dirname(target), { recursive: true })
  const staging = target + '.tmp-' + String(process.pid)
  await writeFile(staging, JSON.stringify(record, null, 2) + '\n', 'utf8')
  await rename(staging, target)
}

/**
 * The set of tombstones that hide a path, including those on an ancestor.
 *
 * Removing a folder removes what is inside it. Storing a tombstone per descendant
 * would mean walking the tree on every removal and would leave a document uploaded
 * into a removed folder afterwards visible in the trash's place; matching ancestors
 * at read time makes the folder the unit of removal, which is what a caller means
 * by removing it.
 *
 * @param entries - the caller's tombstones.
 * @param relPath - the path being tested, in view coordinates.
 * @returns the matching tombstone (itself or an ancestor), or undefined.
 */
export function tombstoneHides(
  entries: readonly Tombstone[],
  relPath: string,
): Tombstone | undefined {
  for (const entry of entries) {
    if (entry.relPath === relPath) return entry
    // A directory tombstone covers its subtree. The trailing slash is what makes
    // this a segment match: `a/b` must not be hidden by a tombstone on `a/bc`.
    if (entry.kind === 'directory' && relPath.startsWith(entry.relPath + '/')) return entry
  }
  return undefined
}

/**
 * Add a tombstone, replacing any it subsumes.
 *
 * Removing an already-removed path is not an error -- a double click, or a page that
 * reloaded mid-request, both produce it -- and the resulting record is the same as
 * if it had happened once.
 *
 * A tombstone on a folder replaces tombstones on its descendants: keeping both would
 * leave the children hidden after the folder is restored, which is not what restoring
 * the folder means.
 *
 * @param entries - the existing tombstones.
 * @param added - the tombstone to add.
 * @returns the new complete list, newest last.
 */
export function addTombstone(entries: readonly Tombstone[], added: Tombstone): Tombstone[] {
  const prefix = added.relPath + '/'
  const kept = entries.filter(entry =>
    entry.relPath !== added.relPath && !entry.relPath.startsWith(prefix))
  kept.push(added)
  return kept
}

/**
 * Remove a tombstone, and the ones it subsumed, so the path becomes visible again.
 *
 * @param entries - the existing tombstones.
 * @param relPath - the path being restored.
 * @returns the remaining tombstones, and whether anything was removed.
 */
export function removeTombstone(
  entries: readonly Tombstone[],
  relPath: string,
): { entries: Tombstone[]; restored: boolean } {
  const prefix = relPath + '/'
  const kept = entries.filter(entry =>
    entry.relPath !== relPath && !entry.relPath.startsWith(prefix))
  return { entries: kept, restored: kept.length !== entries.length }
}

/**
 * Build the foreign keys a tombstone should never share.
 *
 * @param entries - the caller's tombstones.
 * @returns every hidden path, for a caller that needs a set rather than a predicate.
 */
export function hiddenPaths(entries: readonly Tombstone[]): Set<string> {
  return new Set(entries.map(entry => entry.relPath))
}

/**
 * Whether an error means "the file is not there".
 *
 * @param error - whatever the fs call threw.
 * @returns true for ENOENT.
 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * Render an error as one line a person can read.
 *
 * @param error - whatever was thrown.
 * @returns the message, or the value's own text for a non-error.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
