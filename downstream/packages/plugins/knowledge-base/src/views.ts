/**
 * Materialize each user's visible knowledge tree as a hardlink view.
 *
 * A grant in the DataOps database is a statement about what a principal MAY read;
 * it is not a filesystem fact. A workspace process that mounts the shared export
 * sees every file in it, so the grant has to be turned into an actual directory
 * tree before it can mean anything: one directory per user, holding hardlinks to
 * exactly the files that user may read. Nothing crosses into a view whose grant
 * was not resolved by DataOps, so this module never decides who may see what --
 * it only asks, and links what the answer allows.
 *
 * Hardlinks rather than copies: the link shares the inode, so a revoke unlinks
 * the view's entry and the source is untouched, and a re-grant costs one link
 * rather than a copy of the file. That is what makes permission changes
 * incremental, and it is why the NFS export has to be one filesystem (a hardlink
 * cannot span mounts).
 *
 * @module @sparkelf/dsh-knowledge-base/views
 */

import { appendFile, copyFile, link, lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { VIEW_METADATA_FILENAMES } from './viewMetadata.ts'
import { normalizeVectorRetrieval, type VectorRetrievalConfig } from './embeddings.ts'
import { markInternalMutation } from './externalChange.ts'

/** One path a user may read, as DataOps resolved it. */
export interface ResolvedPath {
  /** Path relative to the authoritative root. */
  relPath: string
}

/** Which layout the listing uses for this caller. */
export type ViewMode = 'list' | 'grid' | 'explorer'

/** What one user's view currently holds. */
export interface ViewDelta {
  /** Paths linked into the view during this run. */
  linked: string[]
  /** Paths unlinked from the view during this run. */
  unlinked: string[]
  /** Paths left alone because the view already matched. */
  unchanged: number
  /**
   * View paths that existed only in the view and were imported into the
   * authoritative tree instead of being deleted.
   *
   * A file can land in a view without going through this plugin (a shell `cp`, an
   * editor's save-as). The view is the reader's only writable surface, so treating
   * such a file as an orphan would silently destroy the user's document on the next
   * sync. `adoptOrphan` decides, per path, whether it is imported; these are the
   * paths where that succeeded.
   */
  adopted?: string[]
  /**
   * Directories removed because a revoke emptied them.
   *
   * Kept apart from `unlinked` because a leftover empty directory is not a stale
   * file: it still discloses a folder name the user has lost access to.
   */
  pruned: string[]
  /**
   * Set when the prune pass was deliberately skipped, with the reason.
   *
   * Reported rather than logged so a reader can see it: "the view is not being
   * cleaned because nothing resolved this round" is a fact about the deployment,
   * and the alternative -- silently keeping stale links -- would be indistinguishable
   * from a view that is correct.
   */
  pruneSkipped?: string
}

export interface ViewOptions {
  /** Directory holding the authoritative files. */
  actualRoot: string
  /** Directory holding one view per user. */
  viewRoot: string
  /** Opaque user key; a directory name, so it must not contain a separator. */
  userId: string
  /**
   * Department code used to select the `department/` subtree, when the caller has one.
   *
   * Layout only: it decides which department bucket is linked, never whether a path
   * may be read. Without it the view simply has no department bucket.
   */
  departmentCode?: string
  /**
   * The caller's organization path, root first, as DataOps reported it.
   *
   * This is what turns the department bucket into nested folders: the view mirrors
   * `department/<ancestor>/.../<own>/file` so a reader opening 「部门」 walks their
   * own reporting line instead of one flat pile of every department's documents.
   *
   * Absent from an older backend that reports only `departmentCode`. The view then
   * falls back to the single-level layout, which is exactly what it used to be, so
   * an un-upgraded backend degrades to the old shape rather than to an empty bucket.
   */
  departmentPathCodes?: readonly string[]
  /**
   * Paths this caller has removed from their view, in view coordinates.
   *
   * A filter, not a permission: a hidden path keeps its grant, its inode and every
   * other caller's link. It is checked while building the view because a view is
   * hardlinks into one tree, so "remove" cannot mean "unlink" without also undoing
   * a grant on the next sync.
   */
  hidden?: readonly string[]
}

/** A resolved set linked into a user's view. */
export interface ViewSyncOptions extends ViewOptions {
  /**
   * Whether `resolved` is the complete answer for this caller.
   *
   * True when the caller enumerated the whole tree (the routine and full syncs), and
   * false when it asked about specific paths (a write verifying its own result).
   * Only a full scan may apply the prune-refusal rule below: a targeted sync that
   * resolved nothing knows nothing about the rest of the tree, so it must never prune
   * either -- but it also must not be mistaken for evidence that everything failed.
   */
  fullScan?: boolean
  /**
   * Whether an empty `resolved` may be read as "nothing is readable".
   *
   * Default true: an empty set prunes, which is what a real revoke looks like and what
   * every existing caller means. A caller that enumerated the tree and saw every
   * resolve fail passes false, because an empty answer there is a failure rather than
   * a permission decision, and must not delete the reader's links.
   */
  trustResolvedSet?: boolean
  /**
   * Import one view-only file into the authoritative tree before it is unlinked.
   *
   * Called only for a regular file the resolved set does not name, and only when the
   * prune pass is otherwise about to delete it. Returning true means the file now
   * lives at the authoritative path (and, ideally, that the view entry was relinked
   * to it), so the view keeps it. Returning false falls through to the ordinary
   * unlink, which stays the answer for a file the caller may not write or may not
   * import.
   *
   * The callback owns permission and destination decisions: `syncView` only knows
   * about files and links, not about DataOps grants or bucket layouts.
   */
  adoptOrphan?: (relPath: string, fullPath: string) => Promise<boolean>
}

/**
 * The three top-level buckets every view exposes, in display order.
 *
 * A curated shared store needs one visible answer to "where does this document
 * live" before it can have a delete policy: what everyone may read, what the
 * caller's department may read, and what only the caller may read are three
 * different audiences, and mixing them puts a department document beside a
 * company-wide one with no way to tell them apart.
 */
/**
 * File name of a caller's trash record inside their view directory.
 *
 * Named here rather than imported from `trash.ts` so the view builder does not
 * depend on the trash module: the builder only needs to know not to prune it.
 */
export const TRASH_RECORD_NAME = '.kb-trash.json'

/**
 * Every bookkeeping file this plugin writes into a caller's view directory.
 *
 * The view directory is the directory the reader browses, so a state file left in it
 * is a file the explorer will offer to open, rename or delete. The NAMES live in
 * `viewMetadata.ts` because the client needs them too and cannot import this module
 * (`node:fs/promises` is not available in a browser bundle).
 *
 * The list is cross-checked against the `*PathFor` helpers below at module load: a
 * renamed state file then fails loudly here instead of quietly appearing in every
 * reader's tree, which is how `.kb-favorites.json` reached it once.
 */
export const VIEW_METADATA_NAMES: readonly string[] = VIEW_METADATA_FILENAMES

/** Assert the name list still matches the helpers that produce those paths. */
function assertViewMetadataNames(): void {
  const produced = [
    viewModePathFor,
    settingsPathFor,
    auditLogPathFor,
    treeStatePathFor,
    favoritesPathFor,
    pinsPathFor,
  ].map(pathFor => basename(pathFor(''))).concat(TRASH_RECORD_NAME)
  const producedSet = new Set(produced)
  const declaredSet = new Set(VIEW_METADATA_NAMES)
  const missing = produced.filter(name => !declaredSet.has(name))
  if (missing.length > 0) {
    throw new Error(
      'knowledge-base: state files written into a view but not excluded from the tree: '
      + JSON.stringify(missing) + '. Add them to VIEW_METADATA_FILENAMES.',
    )
  }
  for (const name of declaredSet) {
    if (!producedSet.has(name)) {
      throw new Error(
        'knowledge-base: VIEW_METADATA_FILENAMES names a file nothing writes: '
        + JSON.stringify(name) + '. Remove it, or it hides a reader file with that name.',
      )
    }
  }
}

assertViewMetadataNames()

export const VIEW_BUCKETS = ['global', 'department', 'personal'] as const

/** One bucket a view can hold. */
export type ViewBucket = typeof VIEW_BUCKETS[number]

/** Display name of each bucket, keyed for the client's locale files. */
export const VIEW_BUCKET_LABELS: Readonly<Record<ViewBucket, string>> = {
  global: '全局',
  department: '部门',
  personal: '个人',
}

/**
 * The caller's organization path, cleaned and made safe to use as folder names.
 *
 * Three inputs can produce an empty answer, and all three mean "no hierarchy to
 * render": no path at all (an older backend), an empty path, or a path whose codes
 * are not ordinary path segments. The last one matters because the codes come from
 * another system: a code carrying `/` or `..` would otherwise place a directory
 * outside the view, which is the one thing this module must not allow. Rejecting
 * the whole path rather than the offending segment keeps the layout all-or-nothing,
 * so a caller never sees half a hierarchy that reads as a real one.
 *
 * @param codes - `departmentPathCodes` as DataOps reported it.
 * @returns The usable codes, root first, or an empty array.
 */
export function usableDepartmentPath(codes: readonly string[] | undefined): string[] {
  if (codes === undefined || codes.length === 0) return []
  const cleaned: string[] = []
  for (const code of codes) {
    const trimmed = typeof code === 'string' ? code.trim() : ''
    // A single ordinary segment, which is what {@link isSafeUserId} already defines:
    // it refuses '', '.', '..' and any separator, so reusing it keeps one rule for
    // "may this string be a directory name" instead of a second near-copy.
    if (!isSafeUserId(trimmed)) return []
    cleaned.push(trimmed)
  }
  return cleaned
}

/**
 * The view path a department document lands at, and the source it links to.
 *
 * Two layouts coexist, because a deployment can be mid-upgrade and because documents
 * written before the hierarchy existed are still on the share:
 *
 * - **Nested** (the caller has a usable path): the view mirrors the authoritative
 *   subtree, so `department/<ancestor>/.../<own>/<file>` becomes
 *   `department/<ancestor>/.../<own>/<file>`. Walking 「部门」 then reads the reporting
 *   line, which is the whole point of the change. Every level of the chain is a real
 *   directory in the view, including the caller's own department.
 * - **Flat** (no path at all, or a legacy grant): `department/<file>`, the shape every
 *   earlier version wrote. A backend that reports only `departmentCode` lands here.
 *
 * The compatibility rule is per-path, not per-caller: a grant names a path that exists
 * in the tree TODAY. A nested folder can only be linked from a nested source, so a
 * legacy flat grant (`department/<leaf>/file`) keeps being served flat even after the
 * caller gains an organization path. That is what keeps a document created yesterday
 * readable after the upgrade without a migration pass.
 *
 * @param relPath - authoritative path, already known to start with `department/`.
 * @param codes - the caller's usable organization path, root first.
 * @returns Where to link it inside the bucket, or undefined when the path is not
 * the caller's own department.
 */
function placeDepartmentPath(
  relPath: string,
  codes: readonly string[],
): string | undefined {
  const segments = relPath.split('/').filter(segment => segment !== '')
  if (segments[0] !== 'department') return undefined
  const authority = segments.slice(1)
  if (authority.length < 2) return undefined

  if (codes.length > 0) {
    const own = codes[codes.length - 1]
    // Nested: the authoritative path carries the caller's whole chain. Requiring the
    // FULL chain as an in-order prefix is what keeps a peer department out: a document
    // under `department/<shared-root>/<sibling>/...` fails the comparison and is not
    // linked, even though it shares the root.
    const isOwnSubtree = authority.length > codes.length
      && codes.every((code, index) => authority[index] === code)
    if (isOwnSubtree) {
      // The view mirrors the chain down to and including the caller's own department,
      // so the reader opens 「部门」 and finds their reporting line as folders.
      return authority.join('/')
    }
    // Legacy flat grant for the caller's own department: `department/<own>/<file>`.
    // Served at the bucket root exactly as before, so an older document stays visible
    // instead of needing a migration before it can be read.
    if (authority[0] === own) {
      return authority.slice(1).join('/')
    }
    return undefined
  }

  // Flat layout: no organization path, so the bucket stays one level deep exactly as
  // it was before hierarchy existed.
  return authority.slice(1).join('/')
}

/**
 * Which bucket a resolved path belongs to, and where it lands inside that bucket.
 *
 * The authoritative root carries the same three names as ordinary directories, so
 * ownership is a fact of where the file lives rather than a per-file label that
 * could disagree with it. Legacy flat files (written before the split) answer
 * `global`, which keeps a view populated while a migration is still in progress.
 *
 * `global` owns no second segment, so only its own name is dropped. `department`
 * and `personal` name an OWNER and drop it: a caller opening 「部门」 expects their
 * department's documents inside it, not nested under a second copy of the code.
 *
 * The department bucket's DEPTH depends on the caller, so this function takes the
 * caller's organization path. Everything below the caller's own department keeps
 * its sub-directories, which is what makes the bucket read as a reporting line
 * rather than a flat pile.
 *
 * @param relPath - path relative to the authoritative root.
 * @param departmentPathCodes - the caller's usable organization path, root first.
 *   Absent or empty keeps the legacy single-level department layout.
 * @returns The bucket and the path to link inside it, or undefined when the path
 * cannot be placed safely.
 */
export function bucketOf(
  relPath: string,
  departmentPathCodes?: readonly string[],
): { bucket: ViewBucket; inner: string } | undefined {
  if (!isContainedRelPath(relPath)) return undefined
  const segments = relPath.split('/').filter(segment => segment !== '')
  if (segments.length === 0) return undefined
  const [head] = segments
  if (head === 'global') {
    // `global/<file>` — the bucket name is the whole prefix.
    const inner = segments.slice(1).join('/')
    return inner === '' ? undefined : { bucket: 'global', inner }
  }
  if (head === 'personal') {
    // `personal/<owner>/<file>` — owner is a user id and is not shown.
    const inner = segments.slice(2).join('/')
    return inner === '' ? undefined : { bucket: 'personal', inner }
  }
  if (head === 'department') {
    const inner = placeDepartmentPath(relPath, usableDepartmentPath(departmentPathCodes))
    return inner === undefined ? undefined : { bucket: 'department', inner }
  }
  return { bucket: 'global', inner: relPath }
}

/**
 * Whether a `department/…` path belongs to the caller's own department.
 *
 * The department segment is compared exactly, so `OPS` does not match `OPS2`. A
 * caller with no department matches nothing: their view gets no department bucket
 * rather than every department a stray grant happens to mention.
 *
 * With an organization path there are two shapes a document of the caller's own
 * department can have, and both are accepted because both exist on a live share:
 *
 * - **Nested**, `department/<ancestor>/.../<own>/<something>`: the whole chain must
 *   match in order. Comparing the chain rather than the leaf alone is what keeps a
 *   peer out, since a peer that merely shares the root (`A/B` vs `A/C`) would pass a
 *   leaf-only test.
 * - **Legacy flat**, `department/<own>/<something>`: written before the hierarchy
 *   existed. The caller's own code is at the first position instead of the last, so it
 *   is checked separately; refusing it would make every pre-upgrade document vanish.
 *
 * Both shapes need at least one segment BELOW the department, because the department
 * folder itself is a container, not a document.
 *
 * @param relPath - authoritative path, already known to start with `department/`.
 * @param departmentCode - the caller's department code, when DataOps reported one.
 * @param departmentPathCodes - the caller's organization path, root first, when the
 *   backend reported one. Falls back to {@link departmentCode} when absent.
 * @returns true when the path sits under the caller's own department.
 */
export function departmentPrefixMatches(
  relPath: string,
  departmentCode: string | undefined,
  departmentPathCodes?: readonly string[],
): boolean {
  const segments = relPath.split('/').filter(segment => segment !== '')
  if (segments[0] !== 'department') return false
  const codes = usableDepartmentPath(departmentPathCodes)
  if (codes.length > 0) {
    const own = codes[codes.length - 1]
    // Nested: chain first, so this reads against the same positions the view uses.
    const nestedDepth = codes.length + 1
    if (segments.length > nestedDepth && codes.every((code, index) => segments[index + 1] === code)) {
      return true
    }
    // Legacy flat: the caller's own code sits directly under the bucket.
    if (segments.length > 2 && segments[1] === own) return true
    return false
  }
  // Flat layout: `department/<code>/<something>` — three segments, exactly as before.
  return departmentCode !== undefined && departmentCode !== ''
    && segments.length > 2
    && segments[1] === departmentCode
}

/**
 * Whether a user key is safe to use as one directory name.
 *
 * The key comes from the identity provider rather than from this plugin, so it is
 * validated before it reaches the filesystem: a value carrying a separator or a
 * parent reference would place the view outside the view root, which is the one
 * thing this module must not allow.
 * @param userId - the candidate key.
 * @returns true when it is a single ordinary path segment.
 */export function isSafeUserId(userId: string): boolean {
  return userId !== '' && userId !== '.' && userId !== '..'
    && !userId.includes('/') && !userId.includes('\\') && !userId.includes('\0')
}

/**
 * The directory one user's view lives in.
 * @param options - the roots and the user key.
 * @returns The absolute view directory.
 */
/**
 * Whether a path is a mount point.
 *
 * Read from `/proc/self/mountinfo` rather than inferred from `stat`: comparing a
 * directory's device against its parent's reports a bind mount of the SAME
 * filesystem as "not a mount point", and the whole point of this check is to catch
 * the deployment where the share IS the path being retargeted. The file is the
 * kernel's own list, so a path present in it is mounted by definition.
 *
 * Field 5 of each line is the mount point, escaped (`\040` for a space). A path
 * that is not absolute, or a kernel without the file, answers false: the remaining
 * guards in {@link pointMountAtView} still refuse a non-empty directory, so this
 * check failing open cannot on its own authorize a destructive replace.
 * @param path - absolute path to test.
 * @returns true when the kernel lists it as a mount point.
 */
export async function isMountPoint(path: string): Promise<boolean> {
  let table: string
  try {
    table = await readFile('/proc/self/mountinfo', 'utf8')
  } catch {
    return false
  }
  // A mount point is reported with its trailing separators removed.
  const wanted = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  for (const line of table.split('\n')) {
    if (line === '') continue
    const field = line.split(' ')[4]
    if (field === undefined) continue
    // The kernel escapes space, tab, newline and backslash in this field.
    const decoded = field.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)))
    if (decoded === wanted) return true
  }
  return false
}

/**
 * Whether a directory exists and holds any entry.
 *
 * A path that does not exist is not non-empty: the create case must pass.
 * @param path - absolute path to read.
 * @returns true when it is a directory with at least one entry.
 */
async function isNonEmptyDirectory(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path)
    return entries.length > 0
  } catch {
    return false
  }
}

/**
 * Point the browsable mount at one user's view.
 *
 * The view is built beside the authoritative tree, but the page browses
 * `mountPoint`. Without this step every user would browse the same directory and a
 * grant would change nothing they can see: the view would be correct and
 * unreachable at the same time.
 *
 * A symlink is the mechanism because the browsable path is a fixed path the caller
 * configured, while the view is per user.
 *
 * This function REPLACES whatever sits at `mountPoint`, so it refuses two shapes
 * outright rather than removing them:
 *
 * - a **mount point**, because removing it would delete the mounted filesystem's
 *   contents on the server. Measured on 2026-10-17: a deployment whose
 *   `mountPoint` was the NFS root had `actual/` and every user's `views/` deleted
 *   by the old unconditional `rm -rf`, and the share root replaced by a symlink.
 * - a **non-empty real directory**, because its contents are someone else's data
 *   and a retarget is not a reason to delete them.
 *
 * What remains is exactly the set of shapes a pointer may legitimately occupy: an
 * absent path (first sync), a symlink (a repeat sync), an empty directory (a
 * leftover), or an already-correct link. A refusal throws rather than returning
 * false, because false means "the view was not ready" while this means "the
 * configuration is wrong" -- two different things for the caller to report.
 * @param options - the roots the paths are resolved against.
 * @param mountPoint - the browsable path to retarget.
 * @returns True when the link now points at the view.
 */
export async function pointMountAtView(
  options: ViewOptions,
  mountPoint: string,
): Promise<boolean> {
  if (!isSafeUserId(options.userId)) {
    throw new Error('unsafe view user id: ' + JSON.stringify(options.userId))
  }
  const target = viewPathFor(options)
  // Verify the view exists before repointing: a link to a missing directory would
  // render as an empty tree, which reads as "you have no files" rather than as a
  // deployment that has not run its first sync.
  try {
    const info = await stat(target)
    if (!info.isDirectory()) return false
  } catch {
    return false
  }
  // Already pointing here: the common case on a repeat sync, and rewriting the link
  // would churn a path a reader may be walking.
  const current = await readlink(mountPoint).catch(() => undefined)
  if (current === target) return true
  if (current === undefined) {
    // Not a symlink, so this is a real entry (or nothing). Both destructive shapes
    // are refused here, before any syscall that could remove something.
    if (await isMountPoint(mountPoint)) {
      throw new Error(
        'refusing to replace ' + JSON.stringify(mountPoint) + ' with a symlink: it is a mount point, '
        + 'and removing it would delete the mounted filesystem\'s contents. Point this plugin\'s '
        + 'mountPoint at a dedicated path for the view pointer instead of at the share root.',
      )
    }
    if (await isNonEmptyDirectory(mountPoint)) {
      throw new Error(
        'refusing to replace ' + JSON.stringify(mountPoint) + ' with a symlink: it is a non-empty '
        + 'directory, and its contents are not this plugin\'s to delete. Point mountPoint at a '
        + 'dedicated path for the view pointer, or empty it first.',
      )
    }
    // Absent, or an empty directory: nothing of value is lost, so a leftover
    // directory is removed to make room for the link. `rm` with `force` answers
    // success for a path that is not there, which is the first-sync case.
    await rm(mountPoint, { recursive: true, force: true })
  } else {
    // `rename` onto a symlink whose target is a directory answers EISDIR, so the
    // old link is removed first. The gap is one syscall wide and only a reader
    // racing a permission change can observe it.
    await unlink(mountPoint)
  }
  // The parent may not exist on a first sync -- the pointer is a nested path such
  // as `<share>/views/current`, and `views/` is created by the view builder only
  // when it has something to link. Without this the very first retarget fails with
  // ENOENT, which reads as a broken deployment rather than as an empty tree.
  await mkdir(dirname(mountPoint), { recursive: true })
  await symlink(target, mountPoint)
  return true
}

export function viewPathFor(options: ViewOptions): string {
  if (!isSafeUserId(options.userId)) {
    throw new Error('unsafe view user id: ' + JSON.stringify(options.userId))
  }
  return join(options.viewRoot, options.userId)
}

/**
 * The view-relative path one authoritative entry is expected to appear at.
 *
 * A write knows the path it just created; this answers "where should the reader see
 * it". Used to VERIFY a refresh rather than trust its status: `syncCallerView` reports
 * success as soon as it has walked the tree, and its per-path permission question
 * fails closed, so a resolve that failed for every path still answers 200 with
 * `resolved: 0`. Comparing the expected view path against the disk is what turns
 * "the sync ran" into "the reader can see it".
 *
 * @param options - the roots and the user key, for the department layout.
 * @param relPath - authoritative path of the entry.
 * @returns The view-relative path, or undefined when the caller's layout excludes it.
 */
export function expectedViewPathFor(
  options: ViewOptions,
  relPath: string,
): string | undefined {
  const placement = bucketOf(relPath, usableDepartmentPath(options.departmentPathCodes))
  if (placement === undefined) return undefined
  if (placement.bucket === 'department'
    && !departmentPrefixMatches(relPath, options.departmentCode, usableDepartmentPath(options.departmentPathCodes))) {
    return undefined
  }
  return placement.bucket + '/' + placement.inner
}

/**
 * Reject a relative path that would escape the root it is joined to.
 *
 * The resolved paths come from the authorization service, but they name files in
 * a shared export. A `..` segment would let a grant for one path reach another, so
 * it is refused here rather than trusted: the service decides visibility, this
 * module decides that a visible path still lands inside the tree.
 * @param relPath - the candidate path.
 * @returns true when the path is relative and stays under its root.
 */
export function isContainedRelPath(relPath: string): boolean {
  if (relPath === '' || relPath.startsWith('/') || relPath.includes('\0')) return false
  if (relPath.includes('\\')) return false
  const segments = relPath.split(sep)
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** One directory entry inside a view, as the walk sees it. */
interface ViewEntry {
  /** Path relative to the view root. */
  relPath: string
  /** Absolute path inside the view. */
  full: string
}

/**
 * Walk one view and report every file it currently links, plus the directories it
 * contains.
 *
 * The directories are reported because an emptied one is exactly what a revoke
 * leaves behind, and a leftover directory still discloses the name of a folder
 * the user no longer has access to.
 * @param viewDir - the user's view directory.
 * @returns The linked files and the directories, relative to the view root.
 */
async function walkView(viewDir: string): Promise<{ files: ViewEntry[]; directories: string[] }> {
  const found: ViewEntry[] = []
  const directories: string[] = []
  // The metadata files live at the view root and are preferences rather than
  // content, so the walk skips them. They have to be skipped here rather than left
  // for the unlink pass: that pass removes every file it walks which the resolved
  // set does not name, so a walked `.pinned.json` would be deleted on every sync
  // and the reader's pins would silently vanish. Skipping these exact paths rather
  // than every dotfile keeps a legitimately granted hidden file -- a `.env` someone
  // was given -- visible to the unlink pass, where a revoke can still remove it.
  //
  // Every preference file this module writes belongs in this set. A new one that is
  // not listed here is silently deleted on the next sync, which reads as a setting
  // that will not stick rather than as a bug in this function.
  const metadataPaths = new Set<string>([
    pinsPathFor(viewDir),
    viewModePathFor(viewDir),
    settingsPathFor(viewDir),
    auditLogPathFor(viewDir),
    treeStatePathFor(viewDir),
    favoritesPathFor(viewDir),
  ])
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // A view that does not exist yet holds nothing; that is the create case.
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Recorded before descending, so a directory that becomes empty is still
        // known to this run and can be pruned in the same pass.
        directories.push(full)
        await walk(full)
        continue
      }
      if (entry.isFile() && !metadataPaths.has(full)) found.push({ relPath: relative(viewDir, full), full })
    }
  }
  await walk(viewDir)
  return { files: found, directories }
}

/**
 * Bring one user's view in line with the paths DataOps resolved for them.
 *
 * Only the difference is touched: a path already linked is left alone, a missing
 * one is linked, and one that is no longer resolved is unlinked. A run over an
 * unchanged grant set therefore performs no filesystem writes at all, which is
 * what makes this safe to repeat after every permission change.
 *
 * A link whose source has gone stale is reported as unlinked rather than failing
 * the run, so one deleted file cannot leave a user's whole view half-applied.
 * @param options - the roots and the user key.
 * @param resolved - the paths DataOps says this user may read.
 * @returns What changed, so a caller can report or log the delta.
 */
export async function syncView(options: ViewSyncOptions, resolved: readonly ResolvedPath[]): Promise<ViewDelta> {
  const viewDir = viewPathFor(options)
  // A view path is `<bucket>/<inner>`, not the authoritative path verbatim: the
  // same file may be readable by a department and by one person, and the bucket is
  // what tells those two audiences apart. `placed` keeps the authoritative path
  // for the source and the view path for the link, because they are no longer equal.
  const hidden = options.hidden === undefined || options.hidden.length === 0
    ? undefined
    : new Set(options.hidden)
  const wanted = new Map<string, string>()
  // The caller's organization path decides how deep the department bucket is. Empty
  // means "no hierarchy": an older backend, or a caller with no department. Either way
  // the bucket keeps the single-level layout it had before, so an un-upgraded backend
  // degrades to the old shape rather than to an empty folder.
  const departmentPathCodes = usableDepartmentPath(options.departmentPathCodes)
  for (const item of resolved) {
    if (!isContainedRelPath(item.relPath)) continue
    const placement = bucketOf(item.relPath, departmentPathCodes)
    if (placement === undefined) continue
    // A department bucket is only linked when it is the CALLER's department. The
    // grant already covers the read, so this is layout: without it a caller whose
    // grants reach two departments would see both under one 「部门」 folder.
    if (placement.bucket === 'department'
      && !departmentPrefixMatches(item.relPath, options.departmentCode, departmentPathCodes)) continue
    // A removed path is not linked even though its grant still stands, so a sync
    // triggered by an unrelated grant change cannot resurrect it.
    if (hidden !== undefined && hidden.has(`${placement.bucket}/${placement.inner}`)) continue
    wanted.set(`${placement.bucket}/${placement.inner}`, join(options.actualRoot, item.relPath))
  }

  // The three buckets exist even when empty. A caller whose grants reach only
  // one of them still sees the same three folders as everyone else, which is what
  // makes the layout a structure rather than an accident of what happens to be
  // shared: an absent 「部门」 would read as "my department has nothing" only if
  // the caller already knew the folder was supposed to be there.
  //
  // The department bucket gets its whole ancestor chain created up front, not just the
  // leaf: a reader opening 「部门」 should find their reporting line even before any
  // document has been placed in it. The chain is created from the caller's path, so
  // it discloses only the departments that path already names.
  const createBuckets: string[] = []
  for (const bucket of VIEW_BUCKETS) {
    // A caller without a department gets no department bucket: an empty folder
    // that can never fill is noise, and the caller has nothing to put in it.
    if (bucket === 'department') {
      const hasDepartment = (options.departmentCode !== undefined && options.departmentCode !== '')
        || departmentPathCodes.length > 0
      if (!hasDepartment) continue
    }
    try {
      await mkdir(join(viewDir, bucket), { recursive: true })
      createBuckets.push(bucket)
    } catch {
      // A bucket that cannot be created is reported by the prune pass below.
    }
  }
  if (departmentPathCodes.length > 0) {
    // `recursive` builds every level in one call and is a no-op for the ones that
    // already exist, which is what keeps this a single syscall per sync rather than one
    // per level. A failure is left to the link pass, which reports the real reason.
    await mkdir(join(viewDir, 'department', ...departmentPathCodes), { recursive: true }).catch(() => undefined)
  }

  const walked = await walkView(viewDir)
  const present = new Map(walked.files.map(entry => [entry.relPath, entry.full]))
  const directories = walked.directories
  const delta: ViewDelta = { linked: [], unlinked: [], unchanged: 0, pruned: [] }
  const adopted: string[] = []

  // Links first: a view is more useful showing too much for one instant than
  // showing nothing, so it is never emptied before it is refilled.
  for (const [relPath, source] of wanted) {
    if (present.has(relPath)) {
      delta.unchanged += 1
      continue
    }
    const target = join(viewDir, relPath)
    try {
      await mkdir(dirname(target), { recursive: true })
      await link(source, target)
      delta.linked.push(relPath)
    } catch {
      // The source may have been removed between the resolve and this link. The
      // path stays out of the view, which is the correct answer for a file that
      // no longer exists; a later run picks it up if it comes back.
    }
  }

  // A full scan that resolved NOTHING is not evidence that everything was revoked.
  //
  // `canReadPath` fails closed, so a backend that is down, a credential that expired,
  // or a resolve that raced a deploy all answer `false` -- and the resolved set then
  // arrives empty with no error anywhere. Pruning on that would delete every link the
  // reader has, which is a visible, unrecoverable-looking loss, while keeping them
  // costs only a stale entry until the next successful sync. So the prune pass is
  // refused in that case and says why.
  //
  // Note on the evidence for this: an empty resolved set was FIRST reproduced with a
  // test stub, not observed in production -- the live deployment answers
  // `considered: 5, resolved: 5`. The rule stays because the failure mode is cheap to
  // guard and expensive to suffer, not because it was seen on the real system. Do not
  // go looking for a "always reproduces" bug behind it.
  // The decision needs information this function does not have.
  //
  // An empty resolved set is ambiguous on its own: it is what a caller sees after
  // every grant was legitimately revoked, and it is also what they see when every
  // resolve FAILED. The filesystem cannot tell those apart -- only the caller knows
  // whether it enumerated the tree successfully or gave up. So prune refusal is opt-in
  // through `trustResolvedSet === false`, set by the one place that can detect a
  // wholesale resolve failure: `syncCallerView`, which knows `considered > 0` while
  // `resolved === 0`.
  //
  // Default true keeps `syncView` a plain "make the view match this set" function, so
  // a deliberate revoke (an empty set that really is empty) still unlinks.
  //
  // A TARGETED sync (`fullScan: false`) prunes nothing for a different reason: it was
  // asked about specific paths, so everything else in the view is unexamined and must
  // not be treated as revoked. It does not report `pruneSkipped`, because an empty
  // answer there means "this one path is not readable", not "the whole scan failed".
  const targeted = options.fullScan === false
  const pruneSkipped = !targeted && options.trustResolvedSet === false && wanted.size === 0 && present.size > 0
    ? 'no-path-resolved'
    : undefined
  const skipPrune = targeted || pruneSkipped !== undefined
  if (pruneSkipped !== undefined) delta.pruneSkipped = pruneSkipped

  for (const [relPath, full] of skipPrune ? [] : present) {
    if (wanted.has(relPath)) continue
    // A view directory holds one bookkeeping file that is not a document: the
    // caller's trash record. Pruning it as an orphan would delete the very record
    // this sync just read, so a removal would apply once and then silently come
    // back on the next sync. It is named rather than pattern-matched: a hidden-dot
    // exception would also spare a user's own `.something` file from a revoke.
    if (relPath === TRASH_RECORD_NAME) continue
    // A file that exists only in the view never went through a knowledge-base write
    // path (a shell `cp` into the mounted view is the common case). Deleting it
    // destroys the reader's document; the callback gets the chance to import it
    // into the authoritative tree instead. A refusal (no write grant, an
    // authoritative name already taken) falls through to the ordinary unlink.
    if (options.adoptOrphan !== undefined) {
      let imported = false
      try {
        imported = await options.adoptOrphan(relPath, full)
      } catch {
        imported = false
      }
      if (imported) {
        adopted.push(relPath)
        continue
      }
    }
    try {
      await rm(full)
      delta.unlinked.push(relPath)
    } catch {
      // A view entry that cannot be removed is left for the next run rather than
      // aborting the rest of the revoke.
    }
  }
  if (adopted.length > 0) delta.adopted = adopted

  // Drop the directories a revoke emptied. Leaving them would still disclose the
  // names of folders the user no longer has access to, and an empty tree reads as a
  // permission that grants nothing rather than as a tree that was never shared.
  // Deepest first, so a directory is reconsidered after its children are gone.
  const pruned: string[] = []
  // Buckets are structure, not a permission artifact: emptying one must not remove
  // it, or the caller's three folders would appear and disappear as grants change.
  // Everything INSIDE a bucket is still pruned normally.
  const bucketRoots = new Set(VIEW_BUCKETS.map(bucket => join(viewDir, bucket)))
  // The caller's own organization chain is structure too. It is created before any
  // document is placed in it, so an empty level must survive the prune pass; otherwise
  // the hierarchy would vanish exactly when a department has no documents yet, which is
  // when the reader most needs to see that the department exists and is simply empty.
  // Only the caller's own chain is spared: a peer department's folder is pruned like
  // any other, so a revoke still hides it.
  const departmentChain = new Set<string>()
  if (departmentPathCodes.length > 0) {
    let cumulative = join(viewDir, 'department')
    departmentChain.add(cumulative)
    for (const code of departmentPathCodes) {
      cumulative = join(cumulative, code)
      departmentChain.add(cumulative)
    }
  }
  for (const dir of skipPrune ? [] : [...directories].sort((a, b) => b.length - a.length)) {
    if (bucketRoots.has(dir)) continue
    if (departmentChain.has(dir)) continue
    const remaining = await readdir(dir).catch(() => ['unreadable'])
    if (remaining.length > 0) continue
    try {
      // `rm` with `recursive: false` answers ERR_FS_EISDIR on a directory, so the
      // removal that actually works here is `rmdir`. The distinction matters because
      // the catch below would have swallowed that error and reported success.
      await rmdir(dir)
      pruned.push(relative(viewDir, dir))
    } catch {
      // Non-empty by the time the removal ran, or gone already: either way the
      // next sync sees the truth.
    }
  }
  delta.pruned = pruned

  return delta
}

/**
 * Remove one user's whole view.
 *
 * Used when a user is removed rather than merely re-scoped: their grants are gone
 * from DataOps, so the view directory has no reason to exist. The authoritative
 * files are untouched, because every entry in the view is a link to them.
 * @param options - the roots and the user key.
 * @returns true when a directory was removed, false when there was none.
 */
export async function dropView(options: ViewOptions): Promise<boolean> {
  const viewDir = viewPathFor(options)
  try {
    await stat(viewDir)
  } catch {
    return false
  }
  await rm(viewDir, { recursive: true, force: true })
  return true
}

/**
 * The dotfile holding one user's list/grid preference.
 *
 * Beside `.pinned.json` and for the same reasons: the view directory is already
 * per-user, already on the share, and the choice should follow the reader rather
 * than the browser profile. Written through {@link writeViewMode} and skipped by
 * the sync walk, which is what keeps a preference from being deleted as if it
 * were a stale grant.
 * @param viewDir - the user's view directory.
 * @returns The absolute path of the view-mode file.
 */
export function viewModePathFor(viewDir: string): string {
  return join(viewDir, '.view-mode.json')
}

/**
 * The dotfile holding this knowledge base's review settings.
 *
 * A third sibling of `.pinned.json` and `.view-mode.json`, for the same reasons: the
 * view directory already exists per user, already lives on the share, and the setting
 * belongs to the knowledge base rather than to one browser profile. It MUST be named in
 * the sync walk's metadata set, or the next sync deletes it as if it were a stale grant.
 * @param viewDir - the user's view directory.
 * @returns The absolute path of the settings file.
 */
export function settingsPathFor(viewDir: string): string {
  return join(viewDir, '.kb-settings.json')
}

/**
 * The append-only audit log.
 *
 * A `.jsonl` file rather than a JSON array: an audit entry is appended with a single
 * `appendFile`, so recording one action never rewrites the history before it. A JSON
 * array would have to be read, extended and rewritten in full, which both costs more and
 * creates a window where a crash truncates the whole trail.
 * @param viewDir - the user's view directory.
 * @returns The absolute path of the audit log.
 */
export function auditLogPathFor(viewDir: string): string {
  return join(viewDir, '.kb-audit.jsonl')
}

/**
 * Where content waits while review is required.
 *
 * Deliberately NOT under a view: the sync walk unlinks every file in a view that the
 * caller's resolved grants do not name, so pending content parked there would be
 * deleted by the next sync, which is the same failure that made writing new documents
 * into a view wrong. It lives in the authoritative root instead, in a directory whose
 * name starts with a dot so the tree listing already hides it.
 * @param actualRoot - the authoritative root.
 * @returns The absolute path of the pending directory.
 */
export function pendingDirFor(actualRoot: string): string {
  return join(actualRoot, '.kb-pending')
}

/**
 * Build the stable filename one pending write is parked under.
 *
 * The caller's id is part of the name so the trail of who submitted what survives even
 * when the same path is submitted twice by different people; the timestamp keeps the
 * two submissions from overwriting each other.
 * @param userId - the submitting caller.
 * @param relPath - the path the caller wanted to write.
 * @param at - when it was submitted.
 * @returns A filename that is safe as one path segment.
 */
export function pendingFileNameFor(userId: string, relPath: string, at: string): string {
  const safeUser = userId.replace(/[^A-Za-z0-9_-]+/gu, '_')
  const safePath = relPath.replace(/[^A-Za-z0-9._-]+/gu, '_')
  const stamp = at.replace(/[^0-9]+/gu, '')
  return safeUser + '__' + stamp + '__' + safePath
}

/**
 * Park one write for review instead of applying it.
 *
 * The payload is a small JSON envelope beside a copy of the bytes, both inside the
 * pending directory. Keeping the content rather than only the intent means an approver
 * can read exactly what was submitted, which is the whole point of reviewing it.
 * @param actualRoot - the authoritative root.
 * @param submission - what was submitted.
 * @returns The directory the submission was parked in.
 */
export async function parkPendingWrite(
  actualRoot: string,
  submission: { userId: string; relPath: string; content: string; at: string },
): Promise<string> {
  const directory = pendingDirFor(actualRoot)
  await mkdir(directory, { recursive: true })
  const name = pendingFileNameFor(submission.userId, submission.relPath, submission.at)
  const envelope = {
    name,
    userId: submission.userId,
    relPath: submission.relPath,
    at: submission.at,
    bytes: Buffer.byteLength(submission.content, 'utf8'),
  }
  await writeFile(join(directory, name + '.json'), JSON.stringify(envelope, null, 2) + '\n', 'utf8')
  await writeFile(join(directory, name + '.content'), submission.content, 'utf8')
  return directory
}

/** One submission waiting for review. */
export interface PendingWrite {
  /** The parking name, which is also the handle a reviewer acts on. */
  name: string
  /** Who submitted it. */
  userId: string
  /** The path it wants to occupy in the authoritative tree. */
  relPath: string
  /** When it was submitted. */
  at: string
  /** Size of the submitted bytes. */
  bytes: number
}

/**
 * Decide whether a value is one parking name and not a path.
 *
 * A reviewer acts on a name that came back from {@link listPendingWrites}, but the
 * request is still browser input. Refusing separators and dot segments here means a
 * crafted name cannot reach outside the pending directory, whatever the caller sends.
 * @param value - the candidate name.
 * @returns Whether it is usable as one path segment.
 */
export function isPendingName(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 512) return false
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) return false
  if (value === '.' || value === '..') return false
  // Dots are allowed WITHIN the name because the parking name carries the original
  // extension (`...__a.md`), and refusing them here made `listPendingWrites` reject every
  // real submission. A name that is only dots is still refused, so no value can be
  // read as a relative segment.
  if (/^\.+$/u.test(value)) return false
  return /^[A-Za-z0-9._-]+$/u.test(value)
}

/**
 * Read every submission waiting for review.
 *
 * The envelope is the source of truth rather than the filename, because the name escapes
 * characters out of `relPath` and that escaping is lossy: a reviewer must see the path
 * the submitter actually asked for. A submission whose envelope cannot be read is
 * skipped rather than aborting the queue.
 * @param actualRoot - the authoritative root.
 * @returns The pending submissions, oldest first.
 */
export async function listPendingWrites(actualRoot: string): Promise<PendingWrite[]> {
  const directory = pendingDirFor(actualRoot)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const pending: PendingWrite[] = []
  for (const entry of names) {
    if (!entry.endsWith('.json')) continue
    try {
      const raw = await readFile(join(directory, entry), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown> | null
      if (parsed === null || typeof parsed !== 'object') continue
      const name = typeof parsed.name === 'string' ? parsed.name : entry.slice(0, -'.json'.length)
      if (!isPendingName(name)) continue
      if (typeof parsed.userId !== 'string' || typeof parsed.relPath !== 'string') continue
      pending.push({
        name,
        userId: parsed.userId,
        relPath: parsed.relPath,
        at: typeof parsed.at === 'string' ? parsed.at : '',
        bytes: typeof parsed.bytes === 'number' ? parsed.bytes : 0,
      })
    } catch {
      // A half-written envelope is data from an interrupted submit, not a reason to
      // hide the rest of the queue.
    }
  }
  // Oldest first, so a reviewer works the queue in the order it arrived.
  pending.sort((left, right) => left.at.localeCompare(right.at))
  return pending
}

/**
 * Read one submission's bytes.
 *
 * The name is checked again rather than trusted: this is the function that returns
 * content to be written into the shared tree, so it is the last place a traversal could
 * turn into a write outside the pending directory.
 * @param actualRoot - the authoritative root.
 * @param name - the parking name.
 * @returns The submitted content, or null when it is not there.
 */
export async function readPendingContent(actualRoot: string, name: string): Promise<string | null> {
  if (!isPendingName(name)) return null
  try {
    return await readFile(join(pendingDirFor(actualRoot), name + '.content'), 'utf8')
  } catch {
    return null
  }
}

/**
 * Forget one submission.
 *
 * Used by both the approve and the reject path: approving means the bytes now live in the
 * authoritative tree, and rejecting means nobody wants them. Either way the parked copy
 * must not linger, or the queue would re-offer a decision already made.
 * @param actualRoot - the authoritative root.
 * @param name - the parking name.
 * @returns Whether anything was removed.
 */
export async function discardPendingWrite(actualRoot: string, name: string): Promise<boolean> {
  if (!isPendingName(name)) return false
  const directory = pendingDirFor(actualRoot)
  let removed = false
  for (const suffix of ['.json', '.content']) {
    try {
      await unlink(join(directory, name + suffix))
      removed = true
    } catch {
      // Already gone is the same outcome as removing it.
    }
  }
  return removed
}

/**
 * Storage choices the operator may change from the panel.
 *
 * A strict subset of the plugin's configuration, and every field here is one the panel
 * can meaningfully write: which shape to run, which transport a remote deployment uses,
 * and where that transport reaches. Everything omitted -- `mountPoint`, `actualRoot`,
 * `viewRoot`, `permitted` -- is left to the deployment because those paths are bound into
 * the container when it is created, so writing them here would only point the plugin at
 * paths nothing serves.
 *
 * There is deliberately no private-key field. `sshKeyRef` names a credential; the secret
 * lives in the credential store, which is the only place a key may live.
 */
export interface KnowledgeStorageSettings {
  /** Which storage shape to run, when the operator has chosen one. */
  storageMode?: 'local' | 'remote'
  /** Transport a remote deployment reaches its share by. */
  storageProtocol?: 'nfs' | 'sshfs'
  /** NFS export host. */
  nfsServer?: string
  /** SSHFS: remote host. */
  sshHost?: string
  /** SSHFS: login user. */
  sshUser?: string
  /** SSHFS: SSH daemon port. */
  sshPort?: number
  /** SSHFS: absolute path of the shared directory on the remote host. */
  sshRemotePath?: string
  /** SSHFS: extra `-o` options. */
  sshMountOptions?: string
  /** SSHFS: credential reference holding the private key -- a name, never the key. */
  sshKeyRef?: string
  /** Optional vector retrieval settings, stored deployment-wide. */
  retrieval?: { vector: VectorRetrievalConfig }
}

/** Whether a write must be reviewed before it counts as published. */
export interface KnowledgeSettings extends KnowledgeStorageSettings {
  /**
   * When true, content a caller adds is recorded as pending instead of taking effect.
   *
   * Defaults to false: the product ships with review OFF and an audit trail only, which
   * is the behaviour the operator asked for. Turning it on is a deliberate act.
   */
  reviewRequired: boolean
  /**
   * MinerU's full base address, or `''` to derive it from the port.
   *
   * The port alone cannot express anything but this machine: a service reached through
   * a tunnel, a gateway or another host has no port to put here. An empty value means
   * "derive it", which keeps every existing deployment working without a migration.
   */
  mineruBaseUrl: string
}

/** The settings a caller who has never opened the page gets. */
export const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeSettings = { reviewRequired: false, mineruBaseUrl: '' }

/**
 * Normalise a MinerU base address.
 *
 * Only an absolute http(s) address is storable. A bare host, a `file:` URL or a typo
 * would be handed to a parser that can only fail on it, and the failure would surface
 * as "extraction broke" rather than "this setting is wrong", so the value is checked
 * where it is written instead.
 * @param raw - the candidate value.
 * @returns The trimmed address without a trailing slash, or `''`.
 */
export function normalizeMineruBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  // A trailing slash is the same endpoint as without it, and keeping it would make two
  // identical settings compare unequal. The path is preserved: MinerU may sit behind a
  // prefix.
  return trimmed.replace(/\/+$/u, '')
}

/**
 * Copy the storage fields out of a parsed settings object.
 *
 * Values are validated here rather than at the render site so a hand-edited or foreign file
 * cannot put an unknown mode into the effective configuration: an unrecognized value is
 * dropped and the deployment default stands.
 * @param raw - the parsed settings object.
 * @returns The recognized storage fields, omitting anything invalid.
 */
export function storageSettingsOf(raw: Record<string, unknown>): KnowledgeStorageSettings {
  const out: KnowledgeStorageSettings = {}
  if (raw.storageMode === 'local' || raw.storageMode === 'remote') out.storageMode = raw.storageMode
  if (raw.storageProtocol === 'nfs' || raw.storageProtocol === 'sshfs') out.storageProtocol = raw.storageProtocol
  if (typeof raw.nfsServer === 'string') out.nfsServer = raw.nfsServer
  if (typeof raw.sshHost === 'string') out.sshHost = raw.sshHost
  if (typeof raw.sshUser === 'string') out.sshUser = raw.sshUser
  if (typeof raw.sshPort === 'number' && Number.isInteger(raw.sshPort) && raw.sshPort > 0 && raw.sshPort <= 65_535) out.sshPort = raw.sshPort
  if (typeof raw.sshRemotePath === 'string') out.sshRemotePath = raw.sshRemotePath
  if (typeof raw.sshMountOptions === 'string') out.sshMountOptions = raw.sshMountOptions
  if (typeof raw.sshKeyRef === 'string') out.sshKeyRef = raw.sshKeyRef
  if (raw.retrieval !== undefined && raw.retrieval !== null && typeof raw.retrieval === 'object') {
    const vector = (raw.retrieval as Record<string, unknown>).vector
    if (vector !== undefined) out.retrieval = { vector: normalizeVectorRetrieval(vector) }
  }
  return out
}

/**
 * Read this knowledge base's settings.
 *
 * Anything unrecognized answers the defaults rather than an error: a corrupt settings
 * file should cost the reader their preferences, not the page. `reviewRequired` is
 * coerced to a real boolean so a hand-edited `"false"` string cannot switch review on.
 * @param viewDir - the user's view directory.
 * @returns The stored settings, or the defaults.
 */
export async function readSettings(viewDir: string): Promise<KnowledgeSettings> {
  let raw: string
  try {
    raw = await readFile(settingsPathFor(viewDir), 'utf8')
  } catch {
    return { ...DEFAULT_KNOWLEDGE_SETTINGS }
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_KNOWLEDGE_SETTINGS }
    // The storage fields travel with the review toggle: the panel writes both through this
    // one file, so a read that returned only the toggle would silently drop them.
    return {
      reviewRequired: parsed.reviewRequired === true,
      // A value the writer would refuse reads as "not configured" rather than as an
      // error: a hand-edited or older file must cost the reader their preference, not
      // the page, and "derive from the port" is always a working answer.
      mineruBaseUrl: normalizeMineruBaseUrl(parsed.mineruBaseUrl),
      ...storageSettingsOf(parsed),
    }
  } catch {
    return { ...DEFAULT_KNOWLEDGE_SETTINGS }
  }
}

/**
 * Whether this caller's settings file holds a MinerU address that was refused as invalid.
 *
 * {@link readSettings} normalises a hand-edited or foreign value down to `''`, which makes
 * "never configured" and "configured with something unusable" indistinguishable. The
 * settings page has to tell them apart: the second case must not leave the reader thinking
 * their own address is in use when it was dropped and a fallback answered instead.
 *
 * Read separately rather than threaded through {@link readSettings} because only the page
 * needs it -- the extractor either has a usable address or it does not, and the reason it
 * does not is a message for a human.
 *
 * @param viewDir - the user's view directory.
 * @returns true when the file holds a non-empty value that the normaliser rejected.
 */
export async function storedMineruInvalid(viewDir: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(settingsPathFor(viewDir), 'utf8')
  } catch {
    return false
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (parsed === null || typeof parsed !== 'object') return false
    const value = parsed.mineruBaseUrl
    if (typeof value !== 'string') return false
    return value.trim() !== '' && normalizeMineruBaseUrl(value) === ''
  } catch {
    return false
  }
}

/**
 * Replace this knowledge base's settings.
 *
 * Atomic by rename for the same reason the pins and the view mode are: a reader must
 * never observe a half-written settings file. The view directory is created because a
 * setting can be recorded before the first sync has built one.
 * @param viewDir - the user's view directory, created if absent.
 * @param settings - the settings to store.
 * @returns The settings actually written.
 */
export async function writeSettings(
  viewDir: string,
  settings: KnowledgeSettings,
): Promise<KnowledgeSettings> {
  const normalized: KnowledgeSettings = {
    reviewRequired: settings.reviewRequired === true,
    mineruBaseUrl: normalizeMineruBaseUrl(settings.mineruBaseUrl),
    // Round-tripped through the validator so a caller cannot store a value the reader
    // would reject, and omitted fields stay omitted rather than becoming `undefined` keys.
    ...storageSettingsOf({ ...settings } as unknown as Record<string, unknown>),
    ...(settings.retrieval === undefined ? {} : { retrieval: settings.retrieval }),
  }
  await mkdir(viewDir, { recursive: true })
  const target = settingsPathFor(viewDir)
  const temporary = target + '.tmp'
  await writeFile(temporary, JSON.stringify(normalized), 'utf8')
  await rename(temporary, target)
  return normalized
}

/**
 * The deployment-level settings file, addressed from the mounted knowledge tree.
 *
 * A separate accessor from {@link settingsPathFor} because the two files answer different
 * questions and are read at different moments. The per-user file is only reachable once a
 * caller is known, while this one must be readable on the very first `config` call -- before
 * any identity has been resolved -- because the storage shape is what tells the page whether
 * a caller is needed at all. `mountPoint` is the one path the panel knows without asking
 * anyone, so the file hangs off it.
 *
 * Named `.kb-settings.json` so it lands in the same metadata set the sync walk already
 * skips; a sync that deleted it would silently revert the operator's choice.
 * @param mountPoint - the mounted knowledge tree.
 * @returns The absolute path of the settings file.
 */
export function storageSettingsPathFor(mountPoint: string): string {
  return join(mountPoint, '.kb-settings.json')
}

/**
 * Read the stored storage settings, tolerating every ordinary absence.
 *
 * A missing mount point, a missing file, and a file written by an older build are all the
 * same answer here: nothing has been chosen yet, so the deployment defaults stand. Only a
 * value that IS present and unrecognized is dropped, and it is dropped on its own rather
 * than invalidating its neighbours.
 * @param mountPoint - the mounted knowledge tree.
 * @returns The stored storage fields, empty when nothing usable is on disk.
 */
export async function readStorageSettings(mountPoint: string): Promise<KnowledgeStorageSettings> {
  let raw: string
  try {
    raw = await readFile(storageSettingsPathFor(mountPoint), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (parsed === null || typeof parsed !== 'object') return {}
    return storageSettingsOf(parsed)
  } catch {
    return {}
  }
}

/**
 * Merge a patch into the stored storage settings and write the file atomically.
 *
 * A merge rather than a replace: the panel sends only the fields the operator touched, and a
 * save that blanked the others would make editing one field erase the rest. Written by
 * `rename` so a reader never sees a half-written file, for the same reason the per-user
 * settings are.
 * @param mountPoint - the mounted knowledge tree, created if absent.
 * @param patch - the fields to change.
 * @returns The settings now on disk.
 */
export async function writeStorageSettings(
  mountPoint: string,
  patch: KnowledgeStorageSettings,
): Promise<KnowledgeStorageSettings> {
  const merged = { ...(await readStorageSettings(mountPoint)), ...storageSettingsOf(patch as Record<string, unknown>) }
  await mkdir(mountPoint, { recursive: true })
  const target = storageSettingsPathFor(mountPoint)
  const temporary = target + '.tmp'
  // `reviewRequired` is preserved when the file already had it: this accessor owns only the
  // storage half, and rewriting the file must not drop the half it does not read.
  let existing: Record<string, unknown> = {}
  try {
    const raw = await readFile(target, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (parsed !== null && typeof parsed === 'object') existing = parsed
  } catch {
    existing = {}
  }
  const next = { ...existing, ...merged }
  await writeFile(temporary, JSON.stringify(next), 'utf8')
  await rename(temporary, target)
  return storageSettingsOf(next)
}

/**
 * Read one user's list/grid preference.
 *
 * Anything unrecognized answers `list`, which is the shape the page was built
 * around: a corrupt or hand-edited preference should cost the reader a layout
 * choice, not the page. A missing file is that same ordinary first read.
 * @param viewDir - the user's view directory.
 * @returns The stored mode.
 */
export async function readViewMode(viewDir: string): Promise<ViewMode> {
  let raw: string
  try {
    raw = await readFile(viewModePathFor(viewDir), 'utf8')
  } catch {
    return 'list'
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    return parsed !== null && typeof parsed === 'object' && (parsed.mode === 'grid' || parsed.mode === 'explorer') ? parsed.mode : 'list'
  } catch {
    return 'list'
  }
}

/**
 * Replace one user's list/grid preference.
 *
 * Atomic by rename for the same reason the pins are: a reader must never observe
 * a half-written file. The view directory is created because the preference can
 * be recorded before the first sync has built one.
 * @param viewDir - the user's view directory, created if absent.
 * @param mode - the mode to store.
 * @returns The mode actually written.
 */
export async function writeViewMode(viewDir: string, mode: ViewMode): Promise<ViewMode> {
  await mkdir(viewDir, { recursive: true })
  const target = viewModePathFor(viewDir)
  const temporary = target + '.tmp'
  await writeFile(temporary, JSON.stringify({ mode }), 'utf8')
  await rename(temporary, target)
  return mode
}

/**
 * The dotfile holding one user's expanded folders in the explorer.
 *
 * A sibling of `.pinned.json` and `.view-mode.json`, for the same reasons: the view
 * directory is already per-user and already on the share, so "the same person sees
 * the same tree" needs no new storage of its own. It MUST be named in the sync
 * walk's metadata set, or the next sync deletes it as if it were a stale grant --
 * which reads as a preference that will not stick rather than as a bug in that walk.
 * @param viewDir - the user's view directory.
 * @returns The absolute path of the tree-state file.
 */
export function treeStatePathFor(viewDir: string): string {
  return join(viewDir, '.kb-tree-state.json')
}

/**
 * One absolute path this file will store.
 *
 * Absolute by design (see {@link TreeStateView}), but absolute is not by itself
 * enough: this is a JSON file a user can hand-edit and a browser can post to, so a
 * value only survives if it is a non-empty string with no control characters. The
 * tree ignores an entry it cannot match, but storing junk forever would let the
 * file grow without bound across a broken client's retries.
 * @param value - one candidate entry.
 * @returns Whether it is worth storing.
 */
function isStorableExpandedPath(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('/')
    && value.length > 1
    && value.length <= 4096
    // Control characters have no place in a path and are how a hand-edited file
    // most often stops being a path at all.
    && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Read one user's expanded folders.
 *
 * Every failure answers an empty list, which is also the correct default: the tree
 * starts fully collapsed, so a missing file, an unreadable file, a truncated file,
 * and a file holding something other than an array all resolve to the state a
 * first visit has. Never throws -- the tree must render even when this file is
 * missing or corrupt, and a preference is never worth failing a page for.
 * @param viewDir - the user's view directory.
 * @returns The stored expanded paths, deduplicated, junk entries dropped.
 */
export async function readTreeState(viewDir: string): Promise<string[]> {
  let raw: string
  try {
    raw = await readFile(treeStatePathFor(viewDir), 'utf8')
  } catch {
    // Missing is the ordinary state of a reader who has never opened a folder.
    return []
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const expanded = parsed.expanded
    if (!Array.isArray(expanded)) return []
    // Deduplicate while preserving order: the explorer tolerates repeats, but a
    // repeated path would make every future save re-send the duplicate.
    const seen = new Set<string>()
    const kept: string[] = []
    for (const entry of expanded) {
      if (!isStorableExpandedPath(entry) || seen.has(entry)) continue
      seen.add(entry)
      kept.push(entry)
    }
    return kept
  } catch {
    // A corrupt file is replaced on the first save rather than reported: it holds
    // a list of directory names, and the collapsed tree is a fine answer.
    return []
  }
}

/**
 * Replace one user's expanded folders.
 *
 * Atomic by rename for the same reason the pins and the view mode are: a reader
 * must never observe a half-written file, and the file lives on a share where a
 * crash mid-write would otherwise leave a truncated document that reads as "all
 * collapsed". The view directory is created because the preference can be
 * recorded before the first sync has built one.
 *
 * Junk is dropped rather than refused: unlike a pin, which names a document the
 * reader explicitly asked to keep, this is a volume knob whose worst failure mode
 * is a folder that comes back closed. Answering 400 here would make a broken
 * client's save look like a page error for no reader-visible gain.
 * @param viewDir - the user's view directory, created if absent.
 * @param expanded - the absolute paths to store.
 * @returns The paths actually written.
 */
export async function writeTreeState(viewDir: string, expanded: readonly string[]): Promise<string[]> {
  const seen = new Set<string>()
  const normalised: string[] = []
  for (const entry of expanded) {
    if (!isStorableExpandedPath(entry) || seen.has(entry)) continue
    seen.add(entry)
    normalised.push(entry)
  }
  await mkdir(viewDir, { recursive: true })
  const target = treeStatePathFor(viewDir)
  const temporary = target + '.tmp'
  await writeFile(temporary, JSON.stringify({ expanded: normalised }), 'utf8')
  await rename(temporary, target)
  return normalised
}

/**
 * The dotfile holding one user's favourite paths.
 *
 * A fourth sibling of `.pinned.json`, `.view-mode.json` and `.kb-tree-state.json`,
 * and for the same reason: a favourite is a view preference about the reader, not a
 * property of the document, so the caller's own view directory is already the right
 * owner and no backend table is involved. It MUST stay listed in the sync walk's
 * metadata set or the next sync unlinks it, which shows up as a star that will not
 * stick rather than as a bug in that walk.
 *
 * Kept separate from `pins` on purpose. A pin promotes a path into the rail's band
 * and is addressed by the reader looking for a shortcut; a favourite only marks the
 * row where it already sits, and the two are expected to differ -- pinning a folder
 * you work in every day while still starring the report you are drafting.
 * @param viewDir - the user's view directory.
 * @returns The absolute path of the favourites file.
 */
export function favoritesPathFor(viewDir: string): string {
  return join(viewDir, '.kb-favorites.json')
}

/**
 * Read one user's favourites.
 *
 * A missing or unparsable file is the empty list, exactly as {@link readPins}
 * reports it: no favourites is the ordinary first state, and a corrupt preference
 * should cost the reader their stars rather than the page.
 * @param viewDir - the user's view directory.
 * @returns The favourited paths, in the order they were written.
 */
export async function readFavorites(viewDir: string): Promise<string[]> {
  let raw: string
  try {
    raw = await readFile(favoritesPathFor(viewDir), 'utf8')
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    // A bare array: the file has one field, and a wrapper would add a shape to
    // validate for no gain.
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && isContainedRelPath(item))
  } catch {
    return []
  }
}

/**
 * Replace one user's favourites.
 *
 * Normalised and written by atomic rename, like every other preference file here:
 * a reader must never observe a half-written list, and the temporary is a sibling
 * because a rename cannot cross a filesystem.
 * @param viewDir - the user's view directory, created if absent.
 * @param relPaths - the paths to store.
 * @returns The paths actually written, after normalisation.
 */
export async function writeFavorites(viewDir: string, relPaths: readonly string[]): Promise<string[]> {
  const seen = new Set<string>()
  const normalised: string[] = []
  for (const relPath of relPaths) {
    if (!isContainedRelPath(relPath)) continue
    if (seen.has(relPath)) continue
    seen.add(relPath)
    normalised.push(relPath)
  }
  await mkdir(viewDir, { recursive: true })
  const target = favoritesPathFor(viewDir)
  const temporary = target + '.tmp'
  await writeFile(temporary, JSON.stringify(normalised), 'utf8')
  await rename(temporary, target)
  return normalised
}

/**
 * Move or rename one entry inside the authoritative tree.
 *
 * `rename(2)` rather than a copy followed by an unlink, and that choice is the
 * whole point of this function: the authoritative tree is an NFS export, so a
 * copy-and-delete would read and rewrite the entire file across the network for
 * what the kernel can do as a single atomic directory operation. It also keeps
 * the inode, which matters because every user's view holds HARDLINKS to these
 * files: a copy would give the moved file a new inode and leave every hardlink in
 * every view pointing at the old one. Callers must resynchronize the affected
 * views afterwards ({@link syncView} relinks the new path and drops the old), and
 * that is not optional -- without it the reader sees a dead entry.
 *
 * Both paths are required to be contained relative paths; the caller is
 * responsible for having asked the authority whether the caller may write them.
 * The destination's parent is created when it does not exist, and a destination
 * that already holds an entry is refused rather than overwritten, because a move
 * that silently replaces a document is data loss and no prompt can undo it.
 * @param options - the roots; only `actualRoot` is used.
 * @param fromRelPath - the entry's current path, relative to the root.
 * @param toRelPath - the entry's new path, relative to the root.
 * @returns The moved entry's new relative path.
 */
export async function moveEntry(
  options: ViewOptions,
  fromRelPath: string,
  toRelPath: string,
): Promise<{ from: string; to: string }> {
  if (!isContainedRelPath(fromRelPath) || !isContainedRelPath(toRelPath)) {
    throw new Error('refusing to move a path that is not contained: ' + JSON.stringify({ fromRelPath, toRelPath }))
  }
  const source = join(options.actualRoot, fromRelPath)
  const destination = join(options.actualRoot, toRelPath)
  // A no-op rename would answer success and report a move that changed nothing.
  if (source === destination) throw new Error('source and destination are the same path')
  // Refuse a destination that already exists BEFORE the rename, so the error names
  // the conflict instead of arriving as a bare EEXIST/ENOTEMPTY from the kernel.
  // Only "not there" (ENOENT) may continue; any other stat failure is reported as
  // itself rather than mistaken for an available destination.
  let destinationTaken = true
  try {
    await stat(destination)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') destinationTaken = false
    else throw error
  }
  if (destinationTaken) throw new Error('destination already exists: ' + JSON.stringify(toRelPath))
  await mkdir(dirname(destination), { recursive: true })
  await rename(source, destination)
  // Both paths changed outside the watcher's notion of "external": this process is
  // about to write its own audit entry for the move.
  markInternalMutation(fromRelPath)
  markInternalMutation(toRelPath)
  return { from: fromRelPath, to: toRelPath }
}

/** One entry the copy route would create, resolved before anything is written. */
interface CopyPlanEntry {
  /** Path relative to the authoritative root. */
  relPath: string
  /** True for a directory, false for a file or a symlink. */
  directory: boolean
  /** True when the source is a symlink; the link itself is copied, never its target. */
  symlink: boolean
  /** Bytes for a regular file, so the size cap is enforced before writing. */
  bytes: number
}

/** Hard limits on one copy, so a mistaken paste cannot fill the export. */
const COPY_MAX_ENTRIES = 200
const COPY_MAX_BYTES = 50 * 1024 * 1024

/**
 * Walk one source and describe everything a copy of it would create.
 *
 * Resolved completely before the first byte is written. That ordering is the whole
 * point: a directory copy that fails halfway leaves a partial subtree the reader has to
 * find and delete by hand, and no error message makes that acceptable. Passing this
 * phase is what lets the write phase treat failure as "unexpected" rather than "the
 * reader's fault".
 *
 * Symlinks are recorded but never descended into. Following one would copy whatever it
 * points at -- which may be outside the export entirely, or a link back to an ancestor
 * that would recurse forever. Copying the link itself preserves the reader's structure
 * and keeps the operation bounded by what is actually inside the source.
 * @param actualRoot - the authoritative root the paths are relative to.
 * @param relPath - the source, relative to that root.
 * @returns The entries in walk order, parents before children.
 */
async function planCopy(actualRoot: string, relPath: string): Promise<CopyPlanEntry[]> {
  const planned: CopyPlanEntry[] = []
  let bytes = 0

  const walk = async (currentRel: string): Promise<void> => {
    if (planned.length >= COPY_MAX_ENTRIES) {
      throw new Error('copy would create more than ' + String(COPY_MAX_ENTRIES) + ' entries')
    }
    const info = await lstat(join(actualRoot, currentRel))
    if (info.isSymbolicLink()) {
      // The link is copied as a link; `readlink` runs in the write phase.
      planned.push({ relPath: currentRel, directory: false, symlink: true, bytes: 0 })
      return
    }
    if (info.isDirectory()) {
      planned.push({ relPath: currentRel, directory: true, symlink: false, bytes: 0 })
      const children = await readdir(join(actualRoot, currentRel), { withFileTypes: true })
      for (const child of children) await walk(currentRel + '/' + child.name)
      return
    }
    if (!info.isFile()) throw new Error('cannot copy a special file: ' + JSON.stringify(currentRel))
    bytes += info.size
    if (bytes > COPY_MAX_BYTES) {
      throw new Error('copy would exceed ' + String(COPY_MAX_BYTES) + ' bytes')
    }
    planned.push({ relPath: currentRel, directory: false, symlink: false, bytes: info.size })
  }

  await walk(relPath)
  return planned
}

/**
 * Copy one entry, with its subtree, to a new path inside the authoritative tree.
 *
 * Three rules that the caller cannot waive:
 *
 * - **No overwrite.** An existing destination is refused by name rather than replaced
 *   or auto-renamed: a silent overwrite destroys something the reader did not name, and
 *   an auto-rename produces a file under a name they never typed while the surface says
 *   the copy succeeded.
 * - **Symlinks are copied, not followed.** See {@link planCopy}.
 * - **All-or-nothing.** Everything is resolved and size-checked first; if the write
 *   phase still fails, the paths written so far are removed, so the tree never keeps a
 *   half-copied directory.
 *
 * `copyFile` + `mkdir` rather than a recursive helper: the plan already knows every
 * path, and doing them one at a time is what makes rollback a list of paths to unlink
 * instead of a second tree walk over an unknown half-written state.
 * @param options - the caller's view options (only `actualRoot` is used).
 * @param fromRelPath - the source, relative to the authoritative root.
 * @param toRelPath - the destination, relative to the authoritative root.
 * @returns The source and destination paths, on success.
 */
export async function copyEntry(
  options: ViewOptions,
  fromRelPath: string,
  toRelPath: string,
): Promise<{ from: string; to: string; entries: number; bytes: number }> {
  if (!isContainedRelPath(fromRelPath) || !isContainedRelPath(toRelPath)) {
    throw new Error('refusing to copy a path that is not contained: ' + JSON.stringify({ fromRelPath, toRelPath }))
  }
  if (fromRelPath === toRelPath) throw new Error('source and destination are the same path')
  // A copy into its own subtree would require an infinite tree; the check is on the
  // resolved destination's prefix, not on string equality of the two paths.
  if (toRelPath.startsWith(fromRelPath + '/')) {
    throw new Error('cannot copy a directory into itself: ' + JSON.stringify(toRelPath))
  }
  const source = join(options.actualRoot, fromRelPath)
  const destination = join(options.actualRoot, toRelPath)

  // Refuse an occupied destination before the walk, so the common mistake costs
  // nothing and the message names the conflict rather than an EEXIST from the kernel.
  let destinationTaken = true
  try {
    await stat(destination)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') destinationTaken = false
    else throw error
  }
  if (destinationTaken) throw new Error('destination already exists: ' + JSON.stringify(toRelPath))

  const planned = await planCopy(options.actualRoot, fromRelPath)
  const written: string[] = []
  const totalBytes = planned.reduce((sum, entry) => sum + entry.bytes, 0)

  try {
    for (const entry of planned) {
      const targetRel = toRelPath + entry.relPath.slice(fromRelPath.length)
      const targetPath = join(options.actualRoot, targetRel)
      if (entry.directory) {
        await mkdir(targetPath, { recursive: true })
      } else if (entry.symlink) {
        const linkTarget = await readlink(join(options.actualRoot, entry.relPath))
        await symlink(linkTarget, targetPath)
      } else {
        await mkdir(dirname(targetPath), { recursive: true })
        await copyFile(join(options.actualRoot, entry.relPath), targetPath)
      }
      written.push(targetPath)
      markInternalMutation(targetRel)
    }
  } catch (error) {
    // Undo in reverse order so a directory is empty before it is removed. Best effort:
    // the original failure is what the caller needs to hear, not a cleanup complaint.
    for (const writtenPath of written.reverse()) {
      await rm(writtenPath, { recursive: true, force: true }).catch(() => undefined)
    }
    throw error
  }

  return { from: fromRelPath, to: toRelPath, entries: planned.length, bytes: totalBytes }
}

/**
 * The dotfile holding one user's pins.
 *
 * A dotfile inside the caller's own view directory, rather than a backend table:
 * the view directory is already per-user, already on the shared export, and
 * already rebuilt in place by {@link syncView}. Pins are therefore durable across
 * a restart and need no new authority to store. The name is dotted to keep it out
 * of the way of a reader scanning the tree, and the walk skips this exact path so
 * a sync cannot delete it.
 * @param viewDir - the user's view directory.
 * @returns The absolute path of the pin file.
 */
export function pinsPathFor(viewDir: string): string {
  return join(viewDir, '.pinned.json')
}

/**
 * Read one user's pins.
 *
 * A missing file is the empty list rather than an error: every user has no pins
 * until they make one, so that is the ordinary first read. A file that exists but
 * cannot be parsed is also reported empty, because a corrupt preference should
 * cost the reader their pins rather than the whole page.
 * @param viewDir - the user's view directory.
 * @returns The pinned paths, in the order they were written.
 */
export async function readPins(viewDir: string): Promise<string[]> {
  let raw: string
  try {
    raw = await readFile(pinsPathFor(viewDir), 'utf8')
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    // The file is a bare array rather than an object with a key: it has exactly one
    // field, and a wrapper would only add a shape to validate.
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

/**
 * Replace one user's pins.
 *
 * The list is normalized before it is written: every entry must be a contained
 * relative path, duplicates collapse, and the order is the caller's. Writing is
 * atomic by rename, so a reader never observes a half-written file, and the
 * temporary name is a sibling because a rename cannot cross a filesystem.
 * @param viewDir - the user's view directory, created if absent.
 * @param relPaths - the paths to store, already filtered for readability.
 * @returns The paths actually written, after normalization.
 */
export async function writePins(viewDir: string, relPaths: readonly string[]): Promise<string[]> {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const relPath of relPaths) {
    if (!isContainedRelPath(relPath)) continue
    if (seen.has(relPath)) continue
    seen.add(relPath)
    normalized.push(relPath)
  }
  await mkdir(viewDir, { recursive: true })
  const target = pinsPathFor(viewDir)
  const temporary = target + '.tmp'
  await writeFile(temporary, JSON.stringify(normalized), 'utf8')
  await rename(temporary, target)
  return normalized
}

/** One recorded change to the knowledge base. */
export interface KnowledgeAuditEntry {
  /** ISO timestamp of the action. */
  at: string
  /** Who performed it: the DataOps user id the Host resolved. */
  actor: string
  /**
   * That user's display name at the time of the action, when the Host resolved one.
   *
   * Kept beside the id rather than replacing it: the id is the identity an audit is
   * checked against, while this is only what the trail is read as. Optional because
   * logs written before it existed carry no label, and a reader must show such an
   * entry by its id rather than drop it.
   */
  actorLabel?: string
  /** What they did. */
  /**
   * What they did.
   *
   * `edit` is a save of an existing document's bytes, kept distinct from `create`
   * because the two answer different questions in a review: "who first put this
   * here" and "who changed it last". A save through the host's own file editor
   * reports here through a side channel (see the `audit.appended` route), which is
   * what keeps the host's write path untouched.
   *
   * `delete` is a caller-scoped tombstone (the bytes stay on disk); `external-change`
   * is written by the filesystem watcher when a process outside these tools (usually
   * a shell command) modifies the authoritative tree.
   */
  action: 'create' | 'upload' | 'move' | 'approve' | 'reject' | 'edit' | 'delete' | 'external-change'
  /** The path the action concerned, relative to the knowledge root. */
  relPath: string
  /** For a move, the destination path. */
  toRelPath?: string
  /** Model-facing tool that performed the action, when one did. */
  tool?: string
  /** Graph the action belongs to, when the action is a graph operation. */
  graphId?: string
  /** Topic id inside the graph, when the action names one. */
  topicId?: string
  /** Short human intent (`new topic`, `move-to-trash`, ...). */
  intent?: string
  /** One-line description of what changed, for review. */
  diffSummary?: string
  /**
   * Extra detail for actions that have more than one flavour.
   *
   * Only `external-change` currently uses it (`updated` / `renamed` / `deleted`).
   * Optional so older lines remain readable.
   */
  detail?: 'updated' | 'renamed' | 'deleted'
  /**
   * What became of it.
   *
   * `pending` means it was parked for review, `applied` means it took effect,
   * `rejected` means a reviewer refused it. The three are kept distinct because
   * "nothing happened yet" and "somebody said no" are different facts, and an audit
   * trail that collapsed them would misreport why a document is missing.
   */
  outcome: 'applied' | 'pending' | 'rejected'
}

/**
 * Append one audit entry.
 *
 * Deliberately append-only: no update and no delete path exists in this module, because
 * an audit trail a caller can rewrite is not an audit trail. The file is opened with
 * `'a'`, so the write is a single append at the end and can never overwrite an earlier
 * entry, even with two writers racing.
 *
 * Failure to record is NOT allowed to fail the action that was recorded. The caller has
 * already made its change, so throwing here would report a failure that did not happen;
 * the caller is expected to treat this as best-effort and the reason is logged by the
 * host. That trade is deliberate: an audit gap is bad, but a reported-but-not-applied
 * write is worse.
 * @param viewDir - the user's view directory, created if absent.
 * @param entry - the entry to record.
 */
export async function appendAuditEntry(viewDir: string, entry: KnowledgeAuditEntry): Promise<void> {
  await mkdir(viewDir, { recursive: true })
  await appendFile(auditLogPathFor(viewDir), JSON.stringify(entry) + '\n', 'utf8')
}

/**
 * Read the newest audit entries, newest first.
 *
 * The whole file is read because it is a per-user, append-only log that grows by one
 * short line per write; there is no rotation yet and pretending otherwise would add a
 * seek that the format does not support. Unparseable lines are skipped rather than
 * thrown: a half-written last line from a crash must not make the whole trail unreadable.
 * @param viewDir - the user's view directory.
 * @param limit - maximum entries to return, newest first.
 * @returns The entries, newest first.
 */
export async function readAuditEntries(viewDir: string, limit = 200): Promise<KnowledgeAuditEntry[]> {
  let raw: string
  try {
    raw = await readFile(auditLogPathFor(viewDir), 'utf8')
  } catch {
    return []
  }
  const entries: KnowledgeAuditEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as KnowledgeAuditEntry
      if (parsed && typeof parsed.at === 'string' && typeof parsed.actor === 'string') {
        // Older lines predate `actorLabel`; a non-string value is treated as absent.
        // Neither case is an error: the id alone still identifies the actor.
        if (typeof parsed.actorLabel !== 'string') delete parsed.actorLabel
        entries.push(parsed)
      }
    } catch {
      // A torn line is data from an interrupted write, not a reason to hide the rest.
    }
  }
  return entries.slice(-Math.max(1, limit)).reverse()
}

/**
 * The directory inside the authoritative tree that holds the template library.
 *
 * Under `actualRoot` rather than the caller's view, because a template is shared
 * content: a view is a mirror the next sync rewrites, so a template stored there
 * would vanish on the next permission change. A dot-prefixed name keeps it out of the
 * three reader-facing buckets, and the tree's `exclude` list keeps it out of listings.
 */
const TEMPLATE_DIR = '.kb-templates'

/** The metadata record's file name, inside the template directory. */
const TEMPLATE_INDEX = '.kb-templates.json'

/** One stored template, as the index records it. */
export interface TemplateRecord {
  /** Derived from the stored document's name. */
  id: string
  title: string
  description: string
  category: string
  tags: string[]
  /** The document's stored file name, including its extension. */
  fileName: string
  /** Last-modified instant, ISO-8601. */
  updatedAt: string
}

/** The on-disk index. Open by design: a newer build may add fields. */
interface TemplateIndex {
  version: 1
  templates: TemplateRecord[]
}

/**
 * The template directory's absolute path.
 * @param actualRoot - the authoritative tree's root.
 * @returns The absolute directory.
 */
export function templateDirFor(actualRoot: string): string {
  return join(actualRoot, TEMPLATE_DIR)
}

/**
 * Derive a template id from its stored file name.
 *
 * The file name is the identity because it is also what the reader sees and what the
 * download writes: keeping a separate opaque id would let the two drift, and a
 * template whose record points at a file that moved is a broken card.
 * @param fileName - the document's stored file name.
 * @returns A stable id.
 */
function templateIdOf(fileName: string): string {
  return fileName.replace(/\.[^.]+$/u, '')
}

/**
 * Whether a name is a plain file name this store can hold.
 *
 * A template's document sits directly in the template directory, so a name carrying a
 * separator would place it somewhere else, and one starting with a dot would collide
 * with the index.
 * @param fileName - the candidate name, extension included.
 * @returns Whether it is storage-safe.
 */
function isStorableTemplateFileName(fileName: string): boolean {
  if (fileName === '' || fileName.startsWith('.')) return false
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0')) return false
  return fileName !== '.' && fileName !== '..'
}

/**
 * Read the template index.
 *
 * Every failure answers an empty library, which is also the correct first-run state:
 * a missing directory, a truncated index, and an index holding the wrong shape all
 * resolve to "no templates yet". Never throws -- the library must render.
 * @param actualRoot - the authoritative tree's root.
 * @returns The template records, newest first.
 */
export async function readTemplates(actualRoot: string): Promise<TemplateRecord[]> {
  let raw: string
  try {
    raw = await readFile(join(templateDirFor(actualRoot), TEMPLATE_INDEX), 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TemplateIndex> | null
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.templates)) return []
    const kept: TemplateRecord[] = []
    for (const entry of parsed.templates) {
      if (entry === null || typeof entry !== 'object') continue
      const record = entry as Partial<TemplateRecord>
      if (typeof record.fileName !== 'string' || !isStorableTemplateFileName(record.fileName)) continue
      kept.push({
        id: templateIdOf(record.fileName),
        title: typeof record.title === 'string' && record.title.trim() !== '' ? record.title.trim() : templateIdOf(record.fileName),
        description: typeof record.description === 'string' ? record.description : '',
        category: typeof record.category === 'string' ? record.category : '',
        tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        fileName: record.fileName,
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
      })
    }
    return kept.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  } catch {
    return []
  }
}

/**
 * Write the template index atomically.
 * @param actualRoot - the authoritative tree's root.
 * @param templates - the records to store.
 */
async function writeTemplates(actualRoot: string, templates: readonly TemplateRecord[]): Promise<void> {
  const directory = templateDirFor(actualRoot)
  await mkdir(directory, { recursive: true })
  const target = join(directory, TEMPLATE_INDEX)
  const temporary = target + '.tmp'
  const index: TemplateIndex = { version: 1, templates: [...templates] }
  await writeFile(temporary, JSON.stringify(index, null, 2), 'utf8')
  await rename(temporary, target)
}

/**
 * Store one template: its document and its metadata.
 *
 * Replacing is keyed on the FILE NAME, not on a separate id, because the file name is
 * the identity. A save that changes the name therefore writes a new document and
 * removes the old one, which is what "rename this template" means; a save that keeps
 * the name overwrites in place.
 * @param actualRoot - the authoritative tree's root.
 * @param input - the document text and metadata.
 * @returns The stored record.
 */
export async function saveTemplate(
  actualRoot: string,
  input: {
    title: string
    description: string
    category: string
    tags: readonly string[]
    fileName: string
    content?: string
    /** The template being edited, so its previous document is removed on a rename. */
    id?: string
  },
): Promise<TemplateRecord> {
  if (!isStorableTemplateFileName(input.fileName)) {
    throw new Error('a template file name must be a plain name with an extension')
  }
  const directory = templateDirFor(actualRoot)
  await mkdir(directory, { recursive: true })
  const previous = await readTemplates(actualRoot)
  const editing = input.id === undefined ? undefined : previous.find(record => record.id === input.id)
  // A metadata-only edit keeps the stored document; a create (or a rename) needs one.
  if (input.content === undefined && editing === undefined) {
    throw new Error('a new template needs its document content')
  }
  if (input.content !== undefined) {
    await writeFile(join(directory, input.fileName), input.content, 'utf8')
  }
  // Renaming is a move of the record; the old document is removed only after the new
  // one is on disk, so a failed write cannot leave the library pointing at nothing.
  if (editing !== undefined && editing.fileName !== input.fileName) {
    await rm(join(directory, editing.fileName), { force: true })
  }
  const record: TemplateRecord = {
    id: templateIdOf(input.fileName),
    title: input.title.trim() === '' ? templateIdOf(input.fileName) : input.title.trim(),
    description: input.description.trim(),
    category: input.category.trim(),
    tags: [...new Set(input.tags.map(tag => tag.trim()).filter(tag => tag !== ''))],
    fileName: input.fileName,
    updatedAt: new Date().toISOString(),
  }
  const next = editing === undefined
    ? [...previous.filter(item => item.fileName !== record.fileName), record]
    : [...previous.filter(item => item.fileName !== editing.fileName && item.fileName !== record.fileName), record]
  await writeTemplates(actualRoot, next)
  return record
}

/**
 * Remove one template: its document and its record.
 *
 * Both halves go together, because a record without a document is a card that cannot
 * be used and a document without a record is an invisible file. A missing document is
 * not an error -- the record is what says the template exists, and removing it is the
 * operation asked for.
 * @param actualRoot - the authoritative tree's root.
 * @param id - the template to remove.
 * @returns Whether a template was removed.
 */
export async function removeTemplate(actualRoot: string, id: string): Promise<boolean> {
  const previous = await readTemplates(actualRoot)
  const found = previous.find(record => record.id === id)
  if (found === undefined) return false
  await rm(join(templateDirFor(actualRoot), found.fileName), { force: true })
  await writeTemplates(actualRoot, previous.filter(record => record.id !== id))
  return true
}

/**
 * Stat one stored template's document, so the card can report its real size.
 * @param actualRoot - the authoritative tree's root.
 * @param fileName - the record's stored name.
 * @returns Byte size, or 0 when the document is gone.
 */
export async function templateBytes(actualRoot: string, fileName: string): Promise<number> {
  try {
    return (await stat(join(templateDirFor(actualRoot), fileName))).size
  } catch {
    return 0
  }
}
