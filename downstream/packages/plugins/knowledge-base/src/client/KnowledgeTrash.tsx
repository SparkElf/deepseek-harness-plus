/**
 * The Trash surface: what this caller removed, and the way back.
 *
 * ## What a removal is here
 *
 * Removing a document does not delete it. A view is hardlinks into one shared tree,
 * so unlinking the caller's own link would be indistinguishable from a revoked grant
 * and the next sync would put the link back. The removal is therefore recorded as a
 * tombstone that filters this caller's view, and restoring deletes the note. See
 * `src/trash.ts` for the full reasoning.
 *
 * ## Why restore can bring back nothing
 *
 * A grant can be withdrawn while a document sits in the trash. Restoring it then
 * rebuilds the view without that document, which is the correct outcome and one the
 * page has to say out loud -- a Restore button that appears to do nothing reads as a
 * broken page.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_PAGE_SIZE, needsPager, paginate } from './paging.ts'
import { KB_API } from '../api.ts'
import styles from './KnowledgePanel.module.css'
import tableStyles from './KnowledgePermissions.module.css'

/** Props for the Trash surface. */
export interface KnowledgeTrashProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
}

/** One removed path, as the route reports it. */
interface TrashEntry {
  /** Path relative to the knowledge root, in view coordinates. */
  relPath: string
  /** Whether the removed entry was a file or a directory. */
  kind: 'file' | 'directory'
  /** Display name of whoever removed it. */
  removedBy: string
  /** ISO-8601 instant of removal. */
  removedAt: string
  /** Where it used to sit. */
  originalPath: string
}

/** What the surface is doing right now. */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; entries: TrashEntry[]; error?: string }
  | { kind: 'error'; message: string }

/**
 * Call one knowledge route and decode its JSON answer.
 *
 * @param route - route name from {@link KB_API}.
 * @param body - request body, sent as JSON when present.
 * @returns the decoded answer.
 * @throws when the route refuses or answers with something that is not JSON.
 */
async function callRoute<T>(route: string, body?: unknown): Promise<T> {
  // Resolve against the document base so a deployment under a path prefix
  // (the serves the DSH at /dsh/) keeps the plugin's Host routes.
  const response = await fetch(new URL(`knowledge-base/api/${route}`, document.baseURI), {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new Error(`知识库接口返回了非 JSON 内容 (${response.status})`)
  }
  if (!response.ok) {
    const message = typeof parsed === 'object' && parsed !== null
      ? (parsed as { error?: unknown }).error
      : undefined
    throw new Error(typeof message === 'string' ? message : `请求失败 (${response.status})`)
  }
  return parsed as T
}

/**
 * Format one removal instant for a row.
 *
 * @param value - ISO-8601 instant from the route.
 * @param locale - BCP-47 tag the browser should format in.
 * @returns the local date and time, or the raw value when it cannot be read.
 */
export function formatRemovedAt(value: string, locale?: string): string {
  if (value === '') return ''
  const when = new Date(value)
  if (Number.isNaN(when.getTime())) return value
  try {
    return when.toLocaleString(locale, {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return when.toISOString()
  }
}

/**
 * The last segment of a view path, which is the name a reader recognises.
 *
 * @param relPath - path in view coordinates.
 * @returns that segment, or the whole path when it holds no separator.
 */
export function entryNameOf(relPath: string): string {
  const segments = relPath.split('/')
  return segments[segments.length - 1] ?? relPath
}

/**
 * Render the Trash surface.
 *
 * @param props - copy resolver.
 * @returns The trash table, its empty state, and a restore action per row.
 */
export function KnowledgeTrash(props: KnowledgeTrashProps) {
  const c = props.t
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      const result = await callRoute<{ entries: TrashEntry[]; error?: string }>(KB_API.trash)
      setState({
        kind: 'ready',
        entries: result.entries,
        ...(result.error === undefined ? {} : { error: result.error }),
      })
    } catch (error: unknown) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : c('trashReadFailed') })
    }
  }, [c])

  useEffect(() => {
    void load()
  }, [load])

  async function restore(entry: TrashEntry): Promise<void> {
    setBusy(entry.relPath)
    setNotice(undefined)
    try {
      await callRoute(KB_API.trashRestore, { relPath: entry.relPath })
      await load()
      // A restore rebuilds the view, and a grant withdrawn while the document was
      // hidden means the view comes back without it. Saying so is the difference
      // between "restored" and "the button did nothing".
      setNotice(c('trashRestored'))
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : c('trashWriteFailed'))
    } finally {
      setBusy(undefined)
    }
  }

  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)

  const allRows = state.kind === 'ready' ? state.entries : []
  // Paging lives here rather than in the route: the trash list is small and fully loaded,
  // so slicing on the client keeps a page switch instant and keeps `total` honest.
  const paged = paginate(allRows, page, pageSize)
  const rows = paged.rows

  return (
    <div className={`${styles.surface} ${styles.tableSurface}`}>
      {notice !== undefined && <p className={styles.notice}>{notice}</p>}
      {state.kind === 'error' && <p className={styles.notice}>{state.message}</p>}
      {state.kind === 'ready' && state.error !== undefined && (
        <p className={styles.notice}>{state.error}</p>
      )}

      <table className={tableStyles.table}>
        <thead>
          <tr>
            <th>{c('colTrashName')}</th>
            <th>{c('colTrashOrigin')}</th>
            <th>{c('colTrashDeletedAt')}</th>
            <th>{c('colTrashRetention')}</th>
            <th>{c('actions')}</th>
          </tr>
        </thead>
        <tbody>
          {/* The empty state KEEPS the header above it: a table that removes its
              own columns reads as a different page, and the columns are the part
              of this surface that is already decided. */}
          {rows.length === 0 && (
            <tr className={tableStyles.emptyRow} role="status">
              <td colSpan={5}>
                <div>{c('trashEmptyRow')}</div>
              </td>
            </tr>
          )}
          {rows.map(entry => (
            <tr key={entry.relPath} data-kb-trash-row={entry.relPath}>
              <td>{entryNameOf(entry.relPath)}</td>
              <td className={styles.muted}>{entry.originalPath}</td>
              <td>{formatRemovedAt(entry.removedAt)}</td>
              <td className={styles.muted}>{c('trashNoExpiry')}</td>
              <td>
                <button
                  type="button"
                  className={tableStyles.linkButton}
                  disabled={busy === entry.relPath}
                  onClick={() => void restore(entry)}
                >
                  {c('trashRestore')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {needsPager(allRows.length, pageSize) && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', padding: '8px 0' }}>
          <button type="button" disabled={paged.page <= 1} onClick={() => setPage(paged.page - 2)}>
            {c('auditPagePrev')}
          </button>
          <span>
            {c('auditPageOf').replace('{page}', String(paged.page)).replace('{pages}', String(paged.pageCount))}
          </span>
          <button type="button" disabled={paged.page >= paged.pageCount} onClick={() => setPage(paged.page)}>
            {c('auditPageNext')}
          </button>
        </div>
      )}

      {state.kind === 'loading' && <p className={styles.muted}>{c('loading')}</p>}
    </div>
  )
}

/** One removed path, re-exported for callers that build their own table. */
export type { TrashEntry }
