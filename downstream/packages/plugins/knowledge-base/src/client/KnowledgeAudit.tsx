/**
 * The audit surface: what is waiting for a decision, and what has already happened.
 *
 * These two belong on one page and were previously two sections of Settings, which
 * was the wrong shelf for either. A review queue is a WORKLIST -- something an
 * operator opens to get through -- and a trail is a RECORD of what the worklist
 * already settled. Setting them under the review switch made the viewer scroll past
 * configuration to find today's arrivals, and put a record of the past next to a
 * control that governs the future.
 *
 * They share a page because they are one loop seen from two ends: a submission
 * entering, and a decision leaving. Deciding in the first tab appends to the second,
 * so keeping both on screen (one click apart) is what makes the loop legible.
 *
 * Both readings are loaded together and the tabs only choose which table is drawn,
 * so the two can never show different answers to "is the queue empty".
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { SegmentedControl } from './ui/SegmentedControl'
import { SegmentedTabs } from './ui/SegmentedTabs'
import { KB_API, kbApiPath } from '../api.ts'
import type {
  KnowledgeAuditEntryView,
  PendingWriteView,
} from './KnowledgeSettings.tsx'
import { sortAuditRows } from './auditPaging.ts'
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  needsPager,
  pageAfterSizeChange,
  paginate,
} from './paging.ts'
import tableStyles from './KnowledgePermissions.module.css'
import styles from './KnowledgeAudit.module.css'
import panelStyles from './KnowledgePanel.module.css'

/** Which half of the loop the tabs are showing. */
type AuditTab = 'review' | 'log'

/** Props for the audit surface. */
export interface KnowledgeAuditProps {
  /** Locale-bound copy resolver for this package's namespace. */
  t: (key: string) => string
}

/** What one read of the two routes produced. */
interface AuditData {
  /** Submissions waiting for a decision. */
  pending: PendingWriteView[]
  /** Whether the caller may decide them, as the Host answers. */
  canDecide: boolean
  /** Recorded changes, newest first as the Host orders them. */
  entries: KnowledgeAuditEntryView[]
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: AuditData }
  | { kind: 'error'; message: string }

/**
 * The rows the ordering hooks read before the first successful load.
 *
 * A module constant rather than an inline `[]`: a fresh array literal on every render
 * would be a new dependency identity, so the `useMemo` below would recompute on every
 * pass while the page is loading or failed.
 */
const EMPTY_ENTRIES: KnowledgeAuditEntryView[] = []

/**
 * Format an audit instant for a table cell.
 *
 * DataOps' own surfaces print `YYYY/MM/DD HH:mm`, and a reader comparing this trail
 * against one of those should see the same date rather than a second dialect.
 * @param value - ISO timestamp.
 * @returns The formatted instant, or a dash when unparseable.
 */
export function formatAuditWhen(value: string): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(time.getFullYear())}/${pad(time.getMonth() + 1)}/${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
}

/**
 * Read both routes once.
 *
 * Deliberately tolerant per route: a queue that cannot be read must not blank the
 * trail, and vice versa. They come from different stores, and a token that reaches
 * one but not the other is a real deployment state this page should still show.
 * @returns The two lists and whether the caller may decide.
 */
async function readAudit(): Promise<AuditData> {
  type Route = Parameters<typeof kbApiPath>[0]
  const post = async (route: Route): Promise<Response> => fetch(kbApiPath(route), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    cache: 'no-store',
  })

  const [pendingResponse, auditResponse] = await Promise.all([
    post(KB_API.pendingList),
    post(KB_API.auditList),
  ])

  let pending: PendingWriteView[] = []
  let canDecide = false
  if (pendingResponse.ok) {
    const body = (await pendingResponse.json()) as { pending?: PendingWriteView[]; canDecide?: boolean }
    pending = body.pending ?? []
    canDecide = body.canDecide === true
  }

  let entries: KnowledgeAuditEntryView[] = []
  if (auditResponse.ok) {
    const body = (await auditResponse.json()) as { entries?: KnowledgeAuditEntryView[] }
    entries = body.entries ?? []
  }

  // Both failed: this is not a partially degraded page, it is an unreadable one, and
  // saying so beats rendering two empty tables that claim nothing is queued.
  if (!pendingResponse.ok && !auditResponse.ok) {
    throw new Error('HTTP ' + String(pendingResponse.status))
  }

  return { pending, canDecide, entries }
}

/**
 * Render the audit page: one tab per end of the review loop.
 * @param props - copy resolver.
 * @returns The audit surface.
 */
export function KnowledgeAudit(props: KnowledgeAuditProps) {
  /** Copy resolver, bound from the page so this surface writes no literals. */
  const c = props.t
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [tab, setTab] = useState<AuditTab>('review')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  /**
   * Which page of the trail is shown, and how big a page is.
   *
   * Local state on purpose: a page position is where this reader is in a list right
   * now, not a document-level preference like the list/grid choice. Persisting it
   * would reopen the page on page 7 of a trail that has since grown.
   *
   * They live here rather than inside `renderTrail` because that function runs on
   * every render and a hook inside it would change the hook count.
   */
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)

  const load = useCallback(async (): Promise<void> => {
    try {
      setState({ kind: 'ready', data: await readAudit() })
    } catch (error: unknown) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /**
   * Approve or reject one submission, then re-read both lists.
   * @param name - the submission to decide.
   * @param decision - which way to decide it.
   */
  const decide = async (name: string, decision: 'approve' | 'reject'): Promise<void> => {
    setBusy(true); setNotice(undefined)
    try {
      const route = decision === 'approve' ? KB_API.pendingApprove : KB_API.pendingReject
      const response = await fetch(kbApiPath(route), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
        cache: 'no-store',
      })
      const body = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(body.error ?? 'HTTP ' + String(response.status))
      setNotice(decision === 'approve' ? c('pendingApproved') : c('pendingRejected'))
      // Re-read rather than splicing locally: the Host is the authority on what is
      // still queued, and the log tab gained an entry that must show.
      await load()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : c('pendingDecideFailed'))
    } finally {
      setBusy(false)
    }
  }

  /**
   * The trail in display order, computed rather than inherited.
   *
   * The Host appends newest-last, and the previous version of this table simply drew
   * the array in the order it received. That is an accident of the writer, not a
   * promise: `sortAuditRows` states the order the reader is being shown and keeps it
   * stable when several rows share an instant.
   *
   * Read from `state` defensively rather than from a destructured `entries`, because
   * these hooks must sit ABOVE the early returns: a hook below them changes the hook
   * count between renders and aborts the subtree.
   */
  const entries = state.kind === 'ready' ? state.data.entries : EMPTY_ENTRIES
  const ordered = useMemo(() => sortAuditRows(entries), [entries])

  /** The visible page of the trail, clamped into range. */
  const trailPage = useMemo(
    () => paginate(ordered, page, pageSize),
    [ordered, page, pageSize],
  )

  if (state.kind === 'loading') {
    return <div className={panelStyles.notice}>{c('settingsLoading')}</div>
  }
  if (state.kind === 'error') {
    return <div className={panelStyles.notice}>{c('settingsLoadFailed')}</div>
  }

  const { pending, canDecide } = state.data

  // A size change keeps the row the reader was looking at in view: switching 20 -> 50
  // while reading row 41 should land on the page that still contains row 41, not on
  // page 1 (which would throw away their position) nor on the old page number (which
  // now points somewhere else). `paginate` clamps the answer if the list is shorter.
  const changePageSize = (next: string): void => {
    const parsed = Number(next)
    const size = PAGE_SIZES.includes(parsed as (typeof PAGE_SIZES)[number]) ? parsed : DEFAULT_PAGE_SIZE
    setPage(pageAfterSizeChange(page, pageSize, size))
    setPageSize(size)
  }

  return (
    <div className={styles.audit}>
      {/* The outcome of the last decision, over both tabs: a decision moves an item
          from one tab to the other, so the confirmation belongs to the page rather
          than to the tab it was made in. */}
      {notice !== undefined && <p className={panelStyles.notice} role="status">{notice}</p>}

      <SegmentedTabs
        items={[
          {
            value: 'review',
            // The count belongs on the tab, not in a heading below it: "is anything
            // waiting for me" is the question this page is opened with, and the tab
            // strip is where that is answered without a click.
            label: c('auditTabReview') + ' (' + String(pending.length) + ')',
            id: 'kb-audit-tab-review',
            panelId: 'kb-audit-panel',
          },
          { value: 'log', label: c('auditTabLog'), id: 'kb-audit-tab-log', panelId: 'kb-audit-panel' },
        ]}
        value={tab}
        onChange={setTab}
        label={c('auditTabsLabel')}
        className={styles.tabs}
      />

      <div id="kb-audit-panel" role="tabpanel" aria-labelledby={'kb-audit-tab-' + tab}>
        {tab === 'review' ? renderQueue() : renderTrail()}
      </div>
    </div>
  )

  /** The worklist: one row per submission, both decisions on the row. */
  function renderQueue() {
    return (
      <>
        {c('settingsPendingHint') === '' ? null : (
          <p className={tableStyles.pageHint}>{c('settingsPendingHint')}</p>
        )}
        <table className={tableStyles.table} data-kb-audit="pending">
          <thead>
            <tr>
              <th>{c('colPendingWhen')}</th>
              <th>{c('colPendingSubmitter')}</th>
              <th>{c('colPendingTarget')}</th>
              <th>{c('colPendingSize')}</th>
              <th>{c('colPendingDecision')}</th>
            </tr>
          </thead>
          <tbody>
            {/* The empty state keeps the header: a table that removes its own
                columns reads as a different page. */}
            {pending.length === 0
              ? (
                <tr className={tableStyles.emptyRow} role="status">
                  <td colSpan={5}>{c('settingsPendingEmpty')}</td>
                </tr>
              )
              : pending.map(entry => (
                <tr key={entry.name} data-kb-pending={entry.name}>
                  <td>{formatAuditWhen(entry.at)}</td>
                  <td>{entry.userId}</td>
                  <td className={styles.pathCell}>{entry.relPath}</td>
                  <td className={tableStyles.countCell}>{String(entry.bytes)} B</td>
                  <td>
                    <span className={tableStyles.actions}>
                      {/* Both decisions stay visible when the caller cannot act, and
                          are disabled rather than hidden: a hidden button would make
                          review look like something this deployment does not have.
                          Only the primary one is primary-coloured -- approving is the
                          action a reviewer is here to take, rejecting the exception. */}
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={!canDecide || busy}
                        onClick={() => { void decide(entry.name, 'approve') }}
                      >
                        {c('pendingApprove')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canDecide || busy}
                        onClick={() => { void decide(entry.name, 'reject') }}
                      >
                        {c('pendingReject')}
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {!canDecide && <p className={tableStyles.pageHint}>{c('pendingReadOnly')}</p>}
      </>
    )
  }

  /** The trail: one row per recorded change, newest first as the Host sends it. */
  function renderTrail() {
    return (
      <>
        {c('settingsAuditHint') === '' ? null : (
          <p className={tableStyles.pageHint}>{c('settingsAuditHint')}</p>
        )}
        <table className={tableStyles.table} data-kb-audit="log">
          <thead>
            <tr>
              <th>{c('colAuditWhen')}</th>
              <th>{c('colAuditActor')}</th>
              <th>{c('colAuditAction')}</th>
              <th>{c('colAuditTarget')}</th>
              <th>{c('colAuditOutcome')}</th>
            </tr>
          </thead>
          <tbody>
            {trailPage.rows.length === 0
              ? (
                <tr className={tableStyles.emptyRow} role="status">
                  <td colSpan={5}>{c('settingsAuditEmpty')}</td>
                </tr>
              )
              : trailPage.rows.map(entry => (
                <tr key={entry.at + entry.action + entry.relPath}>
                  <td>{formatAuditWhen(entry.at)}</td>
                  {/*
                    The display name is what a reader recognises; the id is what the
                    trail is checked against. Showing the name and keeping the id in
                    the tooltip preserves both without widening the column. An entry
                    written before labels were recorded falls back to its id.
                  */}
                  <td title={entry.actor}>{entry.actorLabel ?? actorLabel(entry.actor, c)}</td>
                  {/* The action word comes from the locale table, so a new action the
                      Host adds later shows its raw value instead of a blank cell. */}
                  <td>{actionLabel(entry.action, c)}</td>
                  <td className={styles.pathCell}>
                    {entry.relPath}
                    {entry.toRelPath !== undefined && ' → ' + entry.toRelPath}
                  </td>
                  <td>
                    {/* `rejected` is not a warning about a healthy system -- it is a
                        decision someone made -- so only the parked state gets the
                        attention colour, and a refusal reads as a plain fact. */}
                    <Tag tone={entry.outcome === 'applied' ? 'success' : entry.outcome === 'pending' ? 'warning' : 'neutral'}>
                      {c('auditOutcome' + entry.outcome.charAt(0).toUpperCase() + entry.outcome.slice(1))}
                    </Tag>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {/* The pager is drawn only when there is something to page through. A trail
            that fits on one page has no navigation to offer, and an empty one would
            otherwise have to say "page 1 of 1" about nothing. */}
        {needsPager(trailPage.total, pageSize) && (
          <div className={styles.pager} data-kb-audit-pager>
            <span className={styles.pagerTotal}>
              {c('auditPageTotal').replace('{total}', String(trailPage.total))}
            </span>
            {trailPage.pageCount > 1 && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={trailPage.page <= 1}
                  onClick={() => { setPage(trailPage.page - 1) }}
                  aria-label={c('auditPagePrev')}
                >
                  {c('auditPagePrev')}
                </Button>
                <span className={styles.pagerPosition} data-kb-audit-position>
                  {c('auditPageOf')
                    .replace('{page}', String(trailPage.page))
                    .replace('{pages}', String(trailPage.pageCount))}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={trailPage.page >= trailPage.pageCount}
                  onClick={() => { setPage(trailPage.page + 1) }}
                  aria-label={c('auditPageNext')}
                >
                  {c('auditPageNext')}
                </Button>
              </>
            )}
            {/* The page size is a setting about the table, so it sits at the right
                end of the strip, away from the navigation a reader clicks repeatedly. */}
            <span className={styles.pagerSize}>
              <span className={styles.pagerSizeLabel}>{c('auditPageSize')}</span>
              <SegmentedControl
                id="kb-audit-page-size"
                value={String(pageSize)}
                label={c('auditPageSize')}
                options={PAGE_SIZES.map(size => ({
                  value: String(size),
                  label: c('auditPageSizeOption').replace('{size}', String(size)),
                }))}
                onChange={changePageSize}
              />
            </span>
          </div>
        )}
      </>
    )
  }
}

/**
 * The localized word for one recorded action.
 *
 * Falls back to the raw value: an action a newer Host writes would otherwise render
 * as an empty cell, and a blank is worse than an untranslated word.
 * @param action - the action as the Host records it.
 * @param c - copy resolver.
 * @returns The localized action name.
 */
function actionLabel(action: string, c: (key: string) => string): string {
  // `external-change` and any future `foo_bar` value must resolve to a camel-case key
  // (`auditActionExternalChange`) instead of leaking the raw enum into the table.
  const normalized = action.replace(/[-_]([a-z])/gu, (_match, letter: string) => letter.toUpperCase())
  const key = 'auditAction' + normalized.charAt(0).toUpperCase() + normalized.slice(1)
  const label = c(key)
  // The resolver answers the key itself when it has no entry; showing that would be
  // no more readable than the raw action, so the raw value wins.
  return label === key ? action : label
}

/**
 * The localized name for a recorded actor.
 *
 * `external-change` is the file watcher's actor id; older entries were written before
 * the Host recorded a display label, so the raw id would otherwise reach the table.
 * @param actor - the actor id as the Host records it.
 * @param c - copy resolver.
 * @returns The localized name, or the id when it is not a known actor.
 */
function actorLabel(actor: string, c: (key: string) => string): string {
  if (actor === 'external-change' || actor === 'externalChange') return c('auditActorExternalChange')
  if (actor === 'system') return c('auditActorSystem')
  return actor
}
