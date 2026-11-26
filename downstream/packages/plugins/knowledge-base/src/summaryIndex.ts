/**
 * Incremental change detection and summary refresh for the knowledge tree.
 *
 * The design fixes one rule that keeps this module small: the AI never decides
 * what an edit affects. A changed document makes the document and its fixed
 * parent chain dirty; only dirty documents are re-summarised, and directory
 * summaries are folded from the documents summarised in that pass, in stable
 * path order.
 *
 * ```text
 * Git diff / mtime+hash
 *   → ChangeSnapshot
 *   → diffSnapshots
 *   → ChangeSet (changed / added / removed / dirtyDirectories)
 *   → refreshDirtySummaries (only dirty documents reach summarize())
 * ```
 *
 * The module owns no storage. `summarize` and `writeIndex` are injected, so the
 * existing `kb_docs.summary` path (or an INDEX.md writer) remains the one owner
 * of persistence. A removed document is dropped by calling `writeIndex(path,
 * '')`; an empty summary is the "delete this entry" signal.
 *
 * Scope: the snapshot tracks TEXT DOCUMENTS (`.md`, `.markdown`, `.txt`,
 * `.text`). Binary attachments are deliberately outside the summary index; the
 * directory and file names the design reserves for graph/media state
 * (`.graphs`, `.kg`, `.archive`, `_trash`, any other dot directory) are skipped
 * recursively.
 *
 * @module @sparkelf/dsh-knowledge-base/summary-index
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

/** One file's content identity and modification instant. */
export interface ChangeSnapshot { files: Record<string, { mtimeMs: number; sha256: string }> }

/** The difference between two snapshots, plus the directory chain to refresh. */
export interface ChangeSet {
  changed: string[]; added: string[]; removed: string[]
  dirtyDirectories: string[]
}

/** Extensions that are documents for summary purposes. */
const SUMMARY_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text'])

/** Directory names that hold graph state, archive or trash rather than documents. */
const SKIPPED_DIRECTORIES = new Set(['.graphs', '.kg', '.archive', '_trash'])

/** Deterministic string order (code units, locale independent). */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const isErrnoCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null
  && 'code' in error
  && (error as { code?: unknown }).code === code

/**
 * Whether a path is a document the summary index tracks.
 *
 * Exported so the wiring layer can apply the same definition when it maps paths
 * to `kb_docs` rows instead of guessing from a MIME type.
 */
export function isSummaryDocumentPath(relPath: string): boolean {
  return SUMMARY_EXTENSIONS.has(extname(relPath).toLowerCase())
}

/** A directory is skipped when the design reserves it or when it is hidden. */
const isSkippedDirectoryName = (name: string): boolean =>
  name.startsWith('.') || SKIPPED_DIRECTORIES.has(name)

/** A hidden file is tool state (`.DS_Store`, editor swap files), not a document. */
const isHiddenFileName = (name: string): boolean => name.startsWith('.')

const isSafeDocumentPath = (value: string): boolean => {
  if (value === '' || value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/') || /^[A-Za-z]:\//u.test(value)) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

const assertSafeDocumentPaths = (values: string[], field: string): string[] => {
  const unique = [...new Set(values)]
  for (const value of unique) {
    if (!isSafeDocumentPath(value)) {
      throw new Error(`${field} contains an unsafe relative path: ${JSON.stringify(value)}`)
    }
  }
  return unique.sort(compareText)
}

/**
 * Hash every text document under `root` and record its modification instant.
 *
 * Output keys are sorted, so two scans of the same tree produce equal snapshots
 * and callers can compare them without a second ordering pass. A missing root
 * yields an empty snapshot: the plugin may load before a workspace provisions
 * its tree. Symbolic links are not followed, which keeps a link cycle from
 * turning a scan into an infinite walk.
 */
export async function scanKnowledgeTree(root: string): Promise<ChangeSnapshot> {
  const rootAbs = resolve(root)
  const files: ChangeSnapshot['files'] = {}

  const visit = async (directoryAbs: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directoryAbs, { withFileTypes: true })
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) return
      throw error
    }
    entries.sort((left, right) => compareText(left.name, right.name))
    for (const entry of entries) {
      const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (isSkippedDirectoryName(entry.name)) continue
        await visit(join(directoryAbs, entry.name), relPath)
        continue
      }
      if (!entry.isFile()) continue
      if (isHiddenFileName(entry.name) || !isSummaryDocumentPath(relPath)) continue
      const absolute = join(directoryAbs, entry.name)
      try {
        const info = await stat(absolute)
        const bytes = await readFile(absolute)
        files[relPath] = {
          mtimeMs: info.mtimeMs,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }
      } catch (error) {
        // A file removed between readdir and read is simply absent from this
        // snapshot; the previous snapshot will report it as removed.
        if (isErrnoCode(error, 'ENOENT')) continue
        throw error
      }
    }
  }

  await visit(rootAbs, '')

  const sorted: ChangeSnapshot['files'] = {}
  for (const relPath of Object.keys(files).sort(compareText)) sorted[relPath] = files[relPath]
  return { files: sorted }
}

/**
 * Compare two snapshots.
 *
 * Content identity is the sha256, not the mtime: touching a file without
 * changing a byte is not a change and must not spend a summarisation call. The
 * mtime exists so a scanner can skip re-hashing an untouched file; it is kept in
 * the snapshot for that optimisation and for display.
 *
 * `dirtyDirectories` is the deterministic union of the fixed parent chain of
 * every changed, added and removed document, sorted.
 */
export function diffSnapshots(previous: ChangeSnapshot, next: ChangeSnapshot): ChangeSet {
  const changed: string[] = []
  const added: string[] = []
  const removed: string[] = []

  const nextPaths = Object.keys(next.files).sort(compareText)
  for (const relPath of nextPaths) {
    const before = previous.files[relPath]
    if (before === undefined) {
      added.push(relPath)
      continue
    }
    if (before.sha256 !== next.files[relPath].sha256) changed.push(relPath)
  }

  const previousPaths = Object.keys(previous.files).sort(compareText)
  for (const relPath of previousPaths) {
    if (!Object.prototype.hasOwnProperty.call(next.files, relPath)) removed.push(relPath)
  }

  const dirtyDirectories = new Set<string>()
  for (const relPath of [...changed, ...added, ...removed]) {
    for (const directory of parentChain(relPath)) dirtyDirectories.add(directory)
  }

  return {
    changed,
    added,
    removed,
    dirtyDirectories: [...dirtyDirectories].sort(compareText),
  }
}

/**
 * The fixed ancestor chain of a document, root-first.
 *
 * `a/b/c.md` answers `['a', 'a/b']`; a document at the root answers `[]`. The
 * chain never includes the document itself and never depends on what currently
 * exists on disk, which is what makes "which directories are dirty" a pure
 * function of the changed path.
 *
 * Invalid input (absolute path, `..`, NUL) answers `[]` instead of throwing:
 * there is no ancestor chain to refresh outside the root.
 */
export function parentChain(relPath: string): string[] {
  const normalized = relPath.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.includes('\0')) return []
  const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length <= 1) return []
  if (segments.some(segment => segment === '..')) return []
  const chain: string[] = []
  for (let index = 1; index < segments.length; index += 1) chain.push(segments.slice(0, index).join('/'))
  return chain
}

/** One line per child so a directory aggregate has a stable shape. */
const aggregateLine = (relPath: string, summary: string): string =>
  `- ${relPath}: ${summary.replace(/\s+/gu, ' ').trim()}`

/**
 * Re-summarise the changed/added documents, drop removed ones and rebuild the
 * dirty directory aggregates.
 *
 * Only `changeSet.changed` and `changeSet.added` documents reach `summarize()`,
 * each exactly once, in sorted path order. Removed documents are not
 * summarised; they are dropped by calling `writeIndex(path, '')`.
 *
 * Directory aggregates are folded from the summaries produced in THIS pass,
 * using the deterministic child order (`- <relPath>: <summary>`). That is the
 * only summary source the injected API exposes; a directory with no freshly
 * summarised child is not rewritten, so a deletion alone cannot blank an
 * aggregate that still describes unchanged siblings. A caller that stores full
 * child summaries should merge them at the sink.
 *
 * @returns `updated` - document paths summarised and written, sorted.
 *          `directories` - directory paths whose aggregate was written, sorted.
 */
export async function refreshDirtySummaries(input: {
  root: string; changeSet: ChangeSet
  summarize: (relPath: string, source: string) => Promise<string>
  writeIndex: (relPath: string, summary: string) => Promise<void>
}): Promise<{ updated: string[]; directories: string[] }> {
  const rootAbs = resolve(input.root)
  const changed = assertSafeDocumentPaths(input.changeSet.changed, 'changeSet.changed')
  const added = assertSafeDocumentPaths(input.changeSet.added, 'changeSet.added')
  const removed = new Set(assertSafeDocumentPaths(input.changeSet.removed, 'changeSet.removed'))
  const dirtyDocuments = [...new Set([...changed, ...added])].sort(compareText)

  const summaries = new Map<string, string>()
  const updated: string[] = []

  for (const relPath of dirtyDocuments) {
    let source: string
    try {
      source = await readFile(join(rootAbs, relPath), 'utf8')
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
        // The file vanished between diff and refresh; treat it as removed.
        removed.add(relPath)
        continue
      }
      throw error
    }
    const summary = await input.summarize(relPath, source)
    await input.writeIndex(relPath, summary)
    summaries.set(relPath, summary)
    updated.push(relPath)
  }

  const removedDocuments = [...removed].sort(compareText)
  for (const relPath of removedDocuments) await input.writeIndex(relPath, '')

  const dirtyDirectories = new Set<string>()
  for (const relPath of [...dirtyDocuments, ...removedDocuments]) {
    for (const directory of parentChain(relPath)) dirtyDirectories.add(directory)
  }
  for (const directory of input.changeSet.dirtyDirectories ?? []) {
    const normalized = directory.replaceAll('\\', '/').replace(/\/+$/u, '')
    if (normalized === '') continue
    if (!isSafeDocumentPath(normalized)) {
      throw new Error(`changeSet.dirtyDirectories contains an unsafe relative path: ${JSON.stringify(directory)}`)
    }
    dirtyDirectories.add(normalized)
  }

  const directories: string[] = []
  for (const directory of [...dirtyDirectories].sort(compareText)) {
    const children = [...summaries.entries()]
      .filter(([relPath]) => relPath.startsWith(`${directory}/`))
      .sort(([left], [right]) => compareText(left, right))
    if (children.length === 0) continue
    await input.writeIndex(directory, children.map(([relPath, summary]) => aggregateLine(relPath, summary)).join('\n'))
    directories.push(directory)
  }

  return { updated, directories }
}
