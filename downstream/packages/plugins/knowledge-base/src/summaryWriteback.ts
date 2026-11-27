// @ts-nocheck
/**
 * Persist incremental summary refreshes into the existing knowledge index.
 *
 * `summaryIndex.ts` decides WHICH documents changed. This module is the write
 * half: it reads the changed/added documents, rebuilds a deterministic extractive
 * summary from the already-indexed chunks, updates the existing `kb_docs` row
 * (`summary`, `summary_kind='extractive'`, `summary_version`), and refreshes the
 * generated `index/md/<docId>.INDEX.md` when that file already exists. Removed
 * documents have their summary cleared. The scan snapshot is written last and
 * atomically, so a failed run is simply retried from the previous baseline.
 *
 * ## Why the index must be current
 *
 * The summary is built from the chunks SQLite already holds, with the exact
 * `chunkText` + `buildDocumentOutline` functions the indexer uses, so the text
 * matches what `kb_search` can cite. Before using a document this module verifies
 * that the stored chunks are byte-identical to a fresh chunking of the source. A
 * changed document whose row/chunks are stale (or missing entirely) is reported as
 * `pending` and left OUT of the snapshot, so the next run retries it after
 * `syncIndex` catches up. Nothing is guessed from a stale index.
 *
 * The expected call order in the plugin is:
 *
 * ```ts
 * await syncIndex({ actualRoot, indexPath })
 * await applySummaryWriteback({ root: actualRoot, indexPath })
 * ```
 *
 * ## Boundaries
 *
 * - It does not create the SQLite schema. `kb_docs`/`kb_chunks` and `kb_index_meta`
 *   are owned by `ftsIndex.ts`; a missing `kb_docs` table is a wiring error.
 * - It writes only the three summary columns. Section rows, TOC and the summary
 *   FTS table stay owned by `ftsIndex`/`kb_outline_save`, so a model-authored
 *   outline is never half-replaced by an extractive one.
 * - An existing `summary_kind='llm'` summary is preserved, matching the indexer's
 *   own rule; extractive output never downgrades model-authored text.
 *
 * @module @sparkelf/dsh-knowledge-base/summary-writeback
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  CHUNKER_VERSION,
  chunkText,
  outlineFilePath,
  writeOutlineFile,
} from './ftsIndex.ts'
import {
  SUMMARY_VERSION,
  buildDocumentOutline,
  renderOutlineMarkdown,
  type BuiltOutline,
  type OutlineChunk,
} from './outlineText.ts'
import { diffSnapshots, scanKnowledgeTree, type ChangeSnapshot } from './summaryIndex.ts'

/** Inputs for one incremental summary write-back pass. */
export interface SummaryWritebackOptions {
  /** Authoritative knowledge-tree root; the same `actualRoot` given to `syncIndex`. */
  root: string
  /** SQLite index file created/owned by `ftsIndex` (`kb.sqlite`). */
  indexPath: string
  /** Where the scan baseline lives; defaults to `<index dir>/summary-snapshot.json`. */
  snapshotPath?: string
  /**
   * Optional replacement summarizer for the changed/added documents. When omitted,
   * the deterministic extractive summary from the indexed chunks is used. The
   * source text is the current file content, so a caller may plug in a model here.
   */
  summarize?: (relPath: string, source: string) => Promise<string>
}

/** What one write-back pass did; all path arrays are sorted. */
export interface SummaryWritebackResult {
  /** Documents whose `kb_docs.summary` was rewritten. */
  updated: string[]
  /** Documents that disappeared from the tree; their summary was cleared. */
  removed: string[]
  /** Changed/added documents the index has not caught up with; retried next run. */
  pending: string[]
  /** Documents left untouched because a model-authored (`llm`) summary owns them. */
  preserved: string[]
  /** Absolute `INDEX.md` paths regenerated (only files that already existed). */
  indexFiles: string[]
  /** Absolute snapshot path used for this pass. */
  snapshotPath: string
  /** False when the baseline was already current and nothing was written. */
  snapshotWritten: boolean
}

/** Default baseline file name, beside the SQLite index and never inside the tree. */
const DEFAULT_SNAPSHOT_FILE = 'summary-snapshot.json'

/** The default snapshot path for one index; exported for callers that inspect it. */
export function summarySnapshotPathFor(indexPath: string): string {
  return join(dirname(resolve(indexPath)), DEFAULT_SNAPSHOT_FILE)
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const isErrnoCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null
  && 'code' in error
  && (error as { code?: unknown }).code === code

/** The summary version the indexer would compute for these source bytes. */
const summaryVersionFor = (source: string): string =>
  `${SUMMARY_VERSION}:${CHUNKER_VERSION}:${createHash('sha256').update(source).digest('hex').slice(0, 12)}`

const firstLineOf = (content: string): string | undefined =>
  content.split('\n').find(line => line.trim() !== '')?.slice(0, 200)

const isSafeRelativePath = (value: string): boolean => {
  if (value === '' || value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/') || /^[A-Za-z]:\//u.test(value)) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) return false
    throw error
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Read the previous baseline; a corrupt file is an error rather than a full re-summary. */
const readSnapshot = async (snapshotPath: string): Promise<ChangeSnapshot> => {
  let raw: string
  try {
    raw = await readFile(snapshotPath, 'utf8')
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return { files: {} }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`summary snapshot ${snapshotPath} is not valid JSON; delete it to rebuild the baseline`)
  }
  if (!isRecord(parsed) || !isRecord(parsed.files)) {
    throw new Error(`summary snapshot ${snapshotPath} is not a ChangeSnapshot; delete it to rebuild the baseline`)
  }
  const files: ChangeSnapshot['files'] = {}
  for (const [relPath, entry] of Object.entries(parsed.files)) {
    if (!isRecord(entry) || typeof entry.mtimeMs !== 'number' || typeof entry.sha256 !== 'string') {
      throw new Error(`summary snapshot ${snapshotPath} has an invalid entry for ${relPath}`)
    }
    files[relPath] = { mtimeMs: entry.mtimeMs, sha256: entry.sha256 }
  }
  return { files }
}

/** Stable JSON so "did the baseline actually change" cannot depend on key order. */
const canonicalSnapshotJson = (snapshot: ChangeSnapshot): string => {
  const keys = Object.keys(snapshot.files).sort(compareText)
  return JSON.stringify({ files: Object.fromEntries(keys.map(key => [key, snapshot.files[key]])) })
}

/** Remove pending paths so a later pass sees them again as added and retries. */
const withoutPaths = (snapshot: ChangeSnapshot, excluded: ReadonlySet<string>): ChangeSnapshot => {
  const files: ChangeSnapshot['files'] = {}
  for (const relPath of Object.keys(snapshot.files).sort(compareText)) {
    if (excluded.has(relPath)) continue
    files[relPath] = snapshot.files[relPath]
  }
  return { files }
}

/** Write the baseline atomically (same-directory tmp file + rename). */
const writeSnapshotAtomically = async (snapshotPath: string, snapshot: ChangeSnapshot): Promise<void> => {
  await mkdir(dirname(snapshotPath), { recursive: true })
  const temporary = `${snapshotPath}.${String(process.pid)}.tmp`
  try {
    await writeFile(temporary, `${canonicalSnapshotJson(snapshot)}\n`, 'utf8')
    await rename(temporary, snapshotPath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

interface DocumentRow {
  id: number
  path: string
  title: string
  source_path: string | null
  markdown_path: string | null
  summary: string | null
  summary_kind: string | null
}

interface IndexedChunk {
  id: number
  content: string
}

interface PreparedUpdate {
  relPath: string
  docId: number
  summary: string
  version: string
  indexMarkdown?: string
}

const hasKbDocsTable = (db: DatabaseSync): boolean =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kb_docs'").get() !== undefined

/** Chunks in the exact order the indexer inserted them (line, ordinal, id). */
const chunksForDocument = (db: DatabaseSync, docId: number): IndexedChunk[] =>
  db.prepare('SELECT id, content FROM kb_chunks WHERE doc_id = ? ORDER BY line, COALESCE(ord, 0), id')
    .all(docId) as unknown as IndexedChunk[]

/**
 * Rebuild the outline for one document from its indexed chunks.
 *
 * The caller has already verified the chunks match a fresh `chunkText(source)`, so
 * the chunk ids are exactly the citable ids `kb_search` returns and an `INDEX.md`
 * regenerated from this outline stays navigable.
 */
const outlineForDocument = (row: DocumentRow, chunks: readonly IndexedChunk[]): BuiltOutline => {
  const outlineChunks: OutlineChunk[] = chunks.map((chunk, index) => {
    const heading = firstLineOf(chunk.content)
    return {
      id: chunk.id,
      ordinal: index,
      content: chunk.content,
      ...(heading === undefined ? {} : { heading }),
    }
  })
  return buildDocumentOutline({
    docId: row.id,
    docTitle: row.title,
    sourcePath: row.source_path ?? row.path,
    chunks: outlineChunks,
  })
}

/**
 * Run one incremental summary write-back pass.
 *
 * Only changed/added documents are read; only removed documents are cleared.
 * Unchanged documents cost one hash in `scanKnowledgeTree` and nothing else. A
 * second pass with an unchanged tree performs no database writes and no summary
 * generation, and leaves the snapshot alone.
 *
 * @throws when the index file/table is missing, the source cannot be read, or a
 *         database/INDEX write fails. In every failure case the snapshot is NOT
 *         advanced, so the same changes are retried on the next pass.
 */
export async function applySummaryWriteback(options: SummaryWritebackOptions): Promise<SummaryWritebackResult> {
  const root = resolve(options.root)
  const indexPath = resolve(options.indexPath)
  const snapshotPath = options.snapshotPath === undefined
    ? summarySnapshotPathFor(indexPath)
    : resolve(options.snapshotPath)

  if (!(await pathExists(indexPath))) {
    throw new Error(`knowledge index ${indexPath} does not exist; run syncIndex before summary write-back`)
  }

  const previous = await readSnapshot(snapshotPath)
  const next = await scanKnowledgeTree(root)
  const changeSet = diffSnapshots(previous, next)
  const dirtyDocuments = [...new Set([...changeSet.changed, ...changeSet.added])].sort(compareText)
  const removalSet = new Set(changeSet.removed)

  const updated: string[] = []
  const pending: string[] = []
  const preserved: string[] = []
  const prepared: PreparedUpdate[] = []

  const db = new DatabaseSync(indexPath)
  try {
    db.exec('PRAGMA busy_timeout = 8000')
    if (!hasKbDocsTable(db)) {
      throw new Error(`knowledge index ${indexPath} has no kb_docs table; run syncIndex before summary write-back`)
    }
    const readDocument = db.prepare('SELECT id, path, title, source_path, markdown_path, summary, summary_kind FROM kb_docs WHERE path = ?')

    for (const relPath of dirtyDocuments) {
      if (!isSafeRelativePath(relPath)) {
        throw new Error(`changed document has an unsafe relative path: ${JSON.stringify(relPath)}`)
      }
      const row = readDocument.get(relPath) as DocumentRow | undefined
      if (row === undefined) {
        // Not indexed yet: a later syncIndex run inserts the row and the next pass
        // revisits the document because it stays out of the snapshot.
        pending.push(relPath)
        continue
      }

      let source: string
      try {
        source = await readFile(join(root, relPath), 'utf8')
      } catch (error) {
        if (isErrnoCode(error, 'ENOENT')) {
          // The file vanished between the scan and this read: treat it as removed.
          removalSet.add(relPath)
          continue
        }
        throw error
      }

      const chunks = chunksForDocument(db, row.id)
      const fresh = chunkText(source)
      const chunksCurrent = chunks.length === fresh.length
        && chunks.every((chunk, index) => chunk.content === fresh[index]?.content)
      if (!chunksCurrent) {
        // The index still describes older bytes; summarizing now would attach a
        // fresh version to stale text. Retry after syncIndex.
        pending.push(relPath)
        continue
      }
      if (row.summary_kind === 'llm') {
        // Never downgrade a model-authored summary; the indexer preserves it too.
        preserved.push(relPath)
        continue
      }

      const outline = outlineForDocument(row, chunks)
      const summary = options.summarize === undefined
        ? outline.summary
        : await options.summarize(relPath, source)
      const version = summaryVersionFor(source)
      const indexTarget = outlineFilePath(indexPath, row.id)
      const indexMarkdown = (await pathExists(indexTarget))
        ? renderOutlineMarkdown({
          docId: row.id,
          docTitle: row.title,
          sourcePath: row.source_path ?? row.path,
          summaryVersion: version,
          summaryKind: 'extractive',
          summary,
          summarySourceChunkIds: outline.sourceChunkIds,
          toc: outline.toc,
          sections: outline.sections,
        })
        : undefined

      prepared.push({
        relPath,
        docId: row.id,
        summary,
        version,
        ...(indexMarkdown === undefined ? {} : { indexMarkdown }),
      })
      updated.push(relPath)
    }

    const removed = [...removalSet].sort(compareText)
    if (prepared.length > 0 || removed.length > 0) {
      const updateDocument = db.prepare("UPDATE kb_docs SET summary = ?, summary_kind = 'extractive', summary_version = ? WHERE id = ?")
      const clearDocument = db.prepare("UPDATE kb_docs SET summary = NULL, summary_kind = 'none', summary_version = NULL WHERE path = ?")
      db.exec('BEGIN')
      try {
        for (const item of prepared) updateDocument.run(item.summary, item.version, item.docId)
        for (const relPath of removed) clearDocument.run(relPath)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }

    const indexFiles: string[] = []
    for (const item of prepared) {
      if (item.indexMarkdown === undefined) continue
      indexFiles.push(await writeOutlineFile(indexPath, item.docId, item.indexMarkdown))
    }

    const pendingSet = new Set(pending)
    const baseline = withoutPaths(next, pendingSet)
    const snapshotWritten = canonicalSnapshotJson(previous) !== canonicalSnapshotJson(baseline)
    if (snapshotWritten) await writeSnapshotAtomically(snapshotPath, baseline)

    return {
      updated,
      removed: [...removalSet].sort(compareText),
      pending,
      preserved,
      indexFiles,
      snapshotPath,
      snapshotWritten,
    }
  } finally {
    db.close()
  }
}
