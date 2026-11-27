/**
 * Drag-and-drop upload: the part that can be decided without a browser.
 *
 * A drop needs three things settled before anything is uploaded: which directory the
 * pointer is over, whether that directory may receive a drop, and the list of files
 * (with their paths inside a dropped folder) that the drop carried. All three are
 * answers about *data*, not about React state, so they live here and are tested
 * directly instead of through a rendered tree.
 *
 * The module deliberately does not touch `DataTransfer`, `FileList` or `document`.
 * The test runner has no DOM (measured: `DataTransfer`, `FileList` and `document` are
 * all undefined, only `File` exists), and a module that reached for them could only be
 * tested by faking the entire browser. It describes the two shapes it needs instead,
 * and the component adapts a real event to them at the boundary. That is also what
 * keeps the traversal order and the collision rules honest: they are pure functions of
 * their inputs, so a test can assert them without a browser.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

/** A file plus the path it should occupy under the drop target. */
export interface DroppedFile {
  /** The browser's `File`, or anything carrying a name and a byte source. */
  file: unknown
  /**
   * Path relative to the directory the reader dropped onto.
   *
   * A single dropped file carries only its name. A file from a dropped folder carries
   * the folder's segments too (`specs/2026/api.md`), which is what preserves the shape
   * the reader saw in the file manager instead of flattening it.
   */
  relativePath: string
}

/**
 * What a directory row knows about itself, as far as a drop is concerned.
 *
 * The two flags are separate on purpose. `isDirectory` says what the row IS; `drops`
 * says whether this surface accepts drops AT ALL right now (an upload already running,
 * or a read-only caller). A file row is a directory the drop must ignore, while a
 * disabled directory row is one that must also ignore it -- the reason differs but the
 * answer does not, so `acceptsDrop()` is the single place that combines them.
 */
export interface DropTargetLike {
  /** The directory an accepted drop uploads into, relative to the knowledge root. */
  relativePath: string
  /** Whether the row names a folder rather than a document. */
  isDirectory: boolean
  /** Whether this surface accepts drops at the moment (false while busy/read-only). */
  drops: boolean
}

/** The minimum a drop event must expose for this module to read it. */
export interface DropEventLike {
  /** Whether the event carries file payload; a text drag must not upload anything. */
  hasFiles: boolean
  /** The pending file list, or undefined when the browser exposes none. */
  files: readonly DroppedFile[] | undefined
}

/** Why a drop produced no upload. Each case is a different thing to tell the reader. */
export type DropRefusal =
  /** The pointer was over a document, or outside any drop target. */
  | 'not-a-directory'
  /** A drop target was hit but it is not accepting drops right now. */
  | 'disabled'
  /** The target accepted, but the drop carried no files (a text or link drag). */
  | 'no-files'

/** The verdict for one drop. */
export type DropPlan =
  | { kind: 'upload'; directory: string; files: DroppedFile[] }
  | { kind: 'refuse'; reason: DropRefusal }

/**
 * Whether this row may receive the drop that is being dragged over it.
 *
 * Used by `dragover` to decide `preventDefault` (which is what makes the browser show
 * "copy" and allows the drop) and whether to paint the highlight. It answers `false`
 * for a document row so a file dragged onto a file is refused rather than silently
 * doing nothing, and `false` while the surface is busy so a second drop cannot start
 * a competing upload.
 * @param target - the row under the pointer, or undefined outside any row.
 * @returns Whether the row would accept a drop.
 */
export function acceptsDrop(target: DropTargetLike | undefined): boolean {
  if (target === undefined) return false
  return target.isDirectory && target.drops
}

/**
 * Decide what one drop should do.
 *
 * Kept separate from the event so the refusal cases stay distinguishable: "you dropped
 * it on a document" and "you dragged text, not files" need different sentences, and a
 * single `undefined` return would force the caller to guess which happened.
 * @param target - the row under the pointer, or undefined outside any row.
 * @param event - the drop's payload.
 * @returns The upload to perform, or why it was refused.
 */
export function planDrop(target: DropTargetLike | undefined, event: DropEventLike): DropPlan {
  if (target === undefined || !target.isDirectory) return { kind: 'refuse', reason: 'not-a-directory' }
  if (!target.drops) return { kind: 'refuse', reason: 'disabled' }
  if (!event.hasFiles || event.files === undefined || event.files.length === 0) {
    return { kind: 'refuse', reason: 'no-files' }
  }
  return { kind: 'upload', directory: target.relativePath, files: [...event.files] }
}

/**
 * Normalise a path relative to the drop target.
 *
 * Browsers report a dropped folder's contents with either separator (the `File` API on
 * Windows reports `\`, `webkitRelativePath` uses `/`), and a leading separator would
 * make the joined path absolute and fail the server's containment check. Both are
 * collapsed here so the server sees one form.
 * @param raw - the path as the browser reported it.
 * @returns The path with forward slashes and no leading separator.
 */
export function normalizeDropPath(raw: string): string {
  return raw.replace(/\\/gu, '/').replace(/^\/+/u, '')
}

/**
 * Join a drop target with one file's own path.
 * @param directory - the target directory relative to the knowledge root, `''` for the root.
 * @param relativePath - the file's path inside the drop, already normalised or not.
 * @returns The target path relative to the knowledge root.
 */
export function dropTargetPath(directory: string, relativePath: string): string {
  const file = normalizeDropPath(relativePath)
  const base = directory.replace(/\/+$/u, '')
  return base === '' ? file : base + '/' + file
}

/**
 * Collapse a dropped list to one entry per destination.
 *
 * Dropping the same folder twice, or a folder plus one of its files, would otherwise
 * send two writes to the same path: the first succeeds and the second is refused as
 * "already exists", so the reader would be shown a failure for a file that is actually
 * there. The FIRST occurrence wins because that is the one the browser enumerated
 * first, and its bytes are the ones the reader saw at the top of the drag.
 * @param files - the dropped files.
 * @returns One entry per distinct destination path, in first-seen order.
 */
export function dedupeDropped(files: readonly DroppedFile[]): DroppedFile[] {
  const seen = new Set<string>()
  const out: DroppedFile[] = []
  for (const entry of files) {
    const key = normalizeDropPath(entry.relativePath)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push({ file: entry.file, relativePath: key })
  }
  return out
}

/**
 * One line describing the outcome of a whole drop, or undefined when there is nothing
 * worth saying (all files landed).
 *
 * The reader dropped N files and gets one message: naming each failure is unreadable,
 * while "some failed" without a count is not actionable. Partial success therefore
 * states both numbers and names the first few failures, because the next step (retry
 * that one, rename it, ask for access) depends on WHICH file was refused.
 * @param results - one outcome per attempted file, in order.
 * @param maxNames - how many failing names to spell out before summarising the rest.
 * @returns The sentence to show, or undefined when every file landed.
 */
export function summarizeDrop(
  results: readonly { relativePath: string; ok: boolean }[],
  maxNames = 3,
): { ok: number; failed: string[] } | undefined {
  const failed = results.filter(result => !result.ok).map(result => result.relativePath)
  if (failed.length === 0) return undefined
  const named = failed.length <= maxNames ? failed : [...failed.slice(0, maxNames), '…']
  return { ok: results.length - failed.length, failed: named }
}

/**
 * Whether a drag event carries files this surface could upload.
 *
 * `types` is the only part of a `DataTransfer` readable during `dragover`: the payload
 * itself is protected until the drop, so this is what `dragover` must ask to decide
 * whether to `preventDefault`. An internal row drag sets `text/plain` and the knowledge
 * base's own MIME type but NOT `Files`, which is how an in-page move stays a move.
 * @param types - `event.dataTransfer.types`.
 * @returns Whether the drag is an external file payload.
 */
export function isFileDrag(types: readonly string[] | undefined): boolean {
  if (types === undefined) return false
  return types.includes('Files')
}

/**
 * Read the files of a drop as the shape {@link planDrop} takes.
 *
 * `webkitGetAsEntry` is preferred because it is the only way a DROPPED FOLDER arrives:
 * folders never appear in `dataTransfer.files`, so a plain file list silently drops them
 * and the reader sees "nothing happened". The entry API must be read synchronously from
 * the drop handler (the payload enters protected mode once the event dispatch ends), so
 * entries are captured here first and traversed afterwards.
 *
 * Falls back to the flat file list when the entry API is missing or yields nothing
 * usable, which is also the correct behaviour for a browser that only reports files.
 * @param transfer - the drop's `dataTransfer`.
 * @returns One entry per file, with paths relative to the drop target.
 */
export async function readDroppedFiles(transfer: DataTransfer | undefined | null): Promise<DroppedFile[]> {
  if (transfer === undefined || transfer === null) return []

  // Captured synchronously, traversed after: the handles stay readable, the payload
  // does not.
  const entries: FileSystemEntry[] = []
  if (typeof transfer.items !== 'undefined' && transfer.items !== null) {
    for (const item of Array.from(transfer.items)) {
      if (item.kind !== 'file') continue
      const entry = item.webkitGetAsEntry?.()
      if (entry !== undefined && entry !== null) entries.push(entry)
    }
  }

  const flat = (): DroppedFile[] => Array.from(transfer.files ?? []).map(file => ({
    file,
    // `||`, not `??`: `webkitRelativePath` is the EMPTY STRING for a plain file, not
    // undefined, so nullish coalescing keeps '' and the file name is lost. The path then
    // ends in a bare separator and the server refuses it as escaping the root -- which is
    // exactly the "I dragged a file in and nothing happened" report.
    relativePath: normalizeDropPath((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name),
  }))

  if (entries.length === 0) return flat()

  const collected: DroppedFile[] = []
  for (const entry of entries) {
    // A dropped folder has no `File` of its own; only its children do. A top-level
    // file is collected directly.
    await walkEntry(entry, '', collected)
  }
  // A folder that read as empty (or an entry API that gave nothing usable) still has
  // the flat list to fall back on; that is how a plain file drop keeps working.
  return collected.length === 0 ? flat() : collected
}

/**
 * Walk one dropped entry, collecting its files with paths relative to the target.
 * @param entry - the entry to walk.
 * @param prefix - the accumulated folder path.
 * @param out - where to append.
 */
async function walkEntry(entry: FileSystemEntry, prefix: string, out: DroppedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | undefined>((resolve) => {
      (entry as FileSystemFileEntry).file(resolve, () => { resolve(undefined) })
    })
    if (file !== undefined) out.push({ file, relativePath: normalizeDropPath(prefix + file.name) })
    return
  }
  if (!entry.isDirectory) return
  const directory = entry as FileSystemDirectoryEntry
  const reader = directory.createReader()
  // `readEntries` answers at most 100 entries per call and signals "done" with an empty
  // batch, so it must be drained in a loop. This is the trap that drops a large folder's
  // tail silently.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => { resolve([]) })
    })
    if (batch.length === 0) break
    for (const child of batch) {
      await walkEntry(child, prefix + entry.name + '/', out)
    }
  }
}
