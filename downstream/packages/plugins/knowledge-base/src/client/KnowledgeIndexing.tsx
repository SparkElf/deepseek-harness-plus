/**
 * The indexing surface of the management page.
 *
 * There is no separate index. Retrieval reads the mounted tree directly with grep
 * and read, so a "rebuild" is a recount of what is mounted, and it answers
 * synchronously. Presenting it as a background job would invent a queue the plugin
 * does not have, so this surface says what it is in its own copy instead of
 * implying an index process.
 *
 * The table reports per-directory facts the Host derived from the filesystem:
 * how many files are below each directory, when the newest one changed, and
 * whether the caller can read it. Those are measurements, not estimates, and a
 * directory whose numbers are not known is absent rather than shown as zero.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, type KnowledgeStatusView, readKnowledgeJson } from '../api.ts'
import { DEFAULT_PAGE_SIZE, needsPager, paginate } from './paging.ts'
import styles from './KnowledgePanel.module.css'
import tableStyles from './KnowledgePermissions.module.css'

/** One directory's measured shape, as the Host reports it. */
export interface IndexDirectory {
  /** Path relative to the mount point; empty string means the root itself. */
  relPath: string
  /** Files below this directory, counted recursively. */
  fileCount: number
  /** Newest modification instant in Unix ms, absent when nothing could be read. */
  mtimeMs?: number
  /** Whether this directory's own entries could be listed. */
  readable: boolean
  /**
   * Whether some part of the subtree could not be read, so `fileCount` is a lower
   * bound rather than a total.
   *
   * Absent from an older Host, which is why it is optional here: a missing flag is
   * treated as "not known to be partial" rather than as "complete", so the column
   * never claims more than the Host measured.
   */
  partial?: boolean
}

/** Props for the indexing surface. */
export interface KnowledgeIndexingProps {
  /**
   * Publishes this page's primary control to the panel header.
   *
   * The header is the only band at the top of the page, so a page-level action has
   * to be handed up rather than drawn in a second title row.
   */
  onAction?: (action: ReactNode) => void
  /** Status the page already loaded, used for the first paint. */
  status: KnowledgeStatusView
  /** Called after a rescan, so the page can refresh what it shows. */
  onChanged: () => void
  /** Locale-bound copy for this package's namespace. */
  t: (key: string) => string
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; directories: IndexDirectory[] }
  | { kind: 'error'; message: string }

/**
 * Format a modification instant for a table cell.
 * @param value - Unix ms, or undefined when the stat did not answer.
 * @param c - copy resolver, for the placeholder.
 * @returns The formatted instant, or a dash.
 */
function formatWhen(value: number | undefined, c: (key: string) => string): string {
  if (value === undefined) return c('unknown')
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return c('unknown')
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(time.getFullYear())}/${pad(time.getMonth() + 1)}/${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
}

/**
 * Render the index state as a per-directory table.
 * @param props - the loaded status and a refresh callback.
 * @returns The indexing surface.
 */
export function KnowledgeIndexing(props: KnowledgeIndexingProps) {
  /** Copy resolver, bound from the page so this surface writes no literals. */
  const c = props.t
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(kbApiPath(KB_API.indexDirs), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      const result = await readKnowledgeJson<{ directories?: IndexDirectory[] }>(response)
      setState({ kind: 'ready', directories: result.directories ?? [] })
    } catch (error: unknown) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : c('rescanFailed') })
    }
  }, [c])

  useEffect(() => { void load() }, [load])

  /** Rescan the mount and report the new shape. */
  const rescan = async (): Promise<void> => {
    setBusy(true); setNotice(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.index), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      setNotice(c('rescanDone'))
      // Re-read the table rather than trusting the scan's own summary: the rows
      // are what the reader is looking at, so they are what must agree with disk.
      await load()
      props.onChanged()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : c('rescanFailed'))
    } finally { setBusy(false) }
  }

  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)

  const allDirectories = state.kind === 'ready' ? state.directories : []
  // Client-side slicing, matching the trash table: the route returns every directory at
  // once, so a page switch costs nothing and `total` never disagrees with the rows shown.
  const paged = paginate(allDirectories, page, pageSize)
  const directories = paged.rows

  // Published to the header: the page's own band repeated the surface name the
  // header already shows, so only its explanation and its action remain here.
  const { onAction } = props
  useEffect(() => {
    if (onAction === undefined) return
    onAction(
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => { void rescan() }}
      >
        {busy ? c('rescanning') : c('rescanAll')}
      </Button>,
    )
  }, [onAction, busy, c])
  useEffect(() => () => { onAction?.(undefined) }, [onAction])

  return (
    <div className={`${styles.surface} ${styles.tableSurface}`}>
      {notice !== undefined && <p className={styles.notice}>{notice}</p>}

      <table className={tableStyles.table}>
        <thead>
          <tr>
            <th>{c('colDirectory')}</th>
            <th>{c('colFileCount')}</th>
            <th>{c('colSearchable')}</th>
            <th>{c('colLastChange')}</th>
            <th>{c('actions')}</th>
          </tr>
        </thead>
        <tbody>
          {state.kind === 'loading' && (
            <tr className={tableStyles.emptyRow} role="status">
              <td colSpan={5}>{c('loading')}</td>
            </tr>
          )}
          {state.kind === 'error' && (
            <tr className={tableStyles.emptyRow} role="alert">
              <td colSpan={5}>{state.message}</td>
            </tr>
          )}
          {state.kind === 'ready' && directories.length === 0 && (
            <tr className={tableStyles.emptyRow} role="status">
              <td colSpan={5}>{c('directoriesEmpty')}</td>
            </tr>
          )}
          {directories.map((directory) => (
            <tr key={directory.relPath === '' ? '\u0000root' : directory.relPath}>
              <td className={tableStyles.pathCell}>
                {directory.relPath === '' ? c('rootDirectory') : directory.relPath}
              </td>
              <td className={tableStyles.countCell}>
                {/* A partial count is marked as such rather than shown as a total:
                    a subtree that could not be read makes the number a lower
                    bound, and presenting that as the count would be a claim the
                    filesystem did not support. */}
                {String(directory.fileCount)}
                {directory.partial === true && (
                  <span className={tableStyles.partialMark} title={c('partialCountHint')}>
                    {c('partialCountMark')}
                  </span>
                )}
              </td>
              <td>
                {/* Two states, because the filesystem has two: the caller can read
                    the directory or cannot. There is no queue to be "pending" in. */}
                <Tag tone={directory.readable ? 'success' : 'neutral'}>
                  {directory.readable ? c('searchableYes') : c('searchableNo')}
                </Tag>
              </td>
              <td>{formatWhen(directory.mtimeMs, c)}</td>
              <td className={tableStyles.actionCell}>
                <div className={tableStyles.rowActions}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => { void rescan() }}
                  >
                    {c('rescanRow')}
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {needsPager(allDirectories.length, pageSize) && (
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
    </div>
  )
}
