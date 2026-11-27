/**
 * The progress notification button and its panel.
 *
 * Uploading a document and extracting its text are two waits a reader cannot see
 * otherwise: a dropped file looks like nothing happened until the bytes land, and a
 * scanned PDF looks uploaded while its `.md` sibling is still being produced.
 *
 * This is the notification form of that information: a bell in the panel header whose
 * badge counts the work still in flight, opening a panel that names every task. It
 * replaces an earlier strip pinned to the panel's foot, which was too narrow -- file
 * names were cut to a few characters ("中电信桂【2025】150号…"), which is exactly the
 * detail a reader needs to tell two uploads apart.
 *
 * Only the PRESENTATION lives here. The upload rows come from the panel's own upload
 * code and the extraction rows from `extract.status`; this module reads and retries,
 * it does not own either data path.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, FileTypeIcon, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, type ExtractionStatusView, type ExtractionTaskView } from '../api.ts'
import { canRetryExtraction, classifyExtractionFailure, mergeOptimistic, survivingClientFailures, UPLOAD_EXTRACTION_GRACE_MS } from './progressRules.ts'
import type { FailedExtractionView, OptimisticExtraction } from './progressRules.ts'
import type { UploadTaskView } from './progressRules.ts'
import styles from './KnowledgeProgressPopover.module.css'
import { clearTaskQueue, loadTaskQueue, mergeTaskRecords, saveTaskQueue } from './taskQueueStore.ts'
import type { PersistedTask } from './taskQueueStore.ts'

/** Props for the notification button and panel. */
export interface KnowledgeProgressPopoverProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** The batch currently uploading, oldest first; empty when nothing is in flight. */
  uploads: readonly UploadTaskView[]
  /**
   * Whether to read extraction progress at all.
   *
   * False on a surface that cannot extract (no mount): polling a route whose answer can
   * never be acted on costs a request per reader and buys nothing.
   */
  watchExtraction: boolean
  /** Called after a retry was accepted, so the caller can refresh its own views. */
  onRetried?: (relPath: string) => void
  /**
   * A counter the page bumps when extraction changed outside this panel's own polling.
   *
   * The panel polls only while it already knows about pending work, so an extraction
   * queued from a context menu -- exactly the case where it knows about none -- would
   * never appear. Watching a counter makes that one re-read reachable without adding a
   * second timer.
   */
  refreshSignal?: number
  /**
   * Documents the reader asked to extract that the Host has not reported yet.
   *
   * Drawn as a "queued" row so the click has a visible answer before the round trip
   * finishes. Each entry is replaced by the Host's own task the moment `extract.status`
   * mentions it, and expires on its own when it is never confirmed.
   */
  optimistic?: readonly OptimisticExtraction[]
  /**
   * Requests this page session saw refused before the Host created a task.
   *
   * `extract.retry` answers 404/403 before it enqueues anything, so the Host's snapshot
   * never mentions those failures. Without these rows the panel would show an empty state
   * right after the reader watched an extraction fail -- the exact silence this panel
   * exists to remove. The page owns the store; this component only draws it.
   */
  failures?: readonly FailedExtractionView[]
  /**
   * Keep the persistence/polling work but render no bell or modal.
   *
   * The queue now lives in the Task Center's notifications tab, which reads the same
   * localStorage key; the Knowledge page only needs this component mounted to keep
   * writing observations.
   */
  headless?: boolean
}

/** How often to re-read extraction progress while something is pending. */
const POLL_MS = 1_500

/** Which extraction states are still worth polling for. */
const ACTIVE_STATES = new Set(['pending', 'running'])

/**
 * Render one extraction task's state as a sentence.
 * @param task - the task from the Host.
 * @param t - copy resolver.
 * @returns The sentence and whether a retry would make sense.
 */
function describeExtraction(
  task: ExtractionTaskView,
  t: (key: string) => string,
): { text: string; canRetry: boolean } {
  if (task.state === 'pending') return { text: t('progressPending'), canRetry: canRetryExtraction(task.state) }
  if (task.state === 'running') {
    if (task.step === 'chunk') return { text: t('progressStepChunk'), canRetry: true }
    if (task.step === 'index') return { text: t('progressStepIndex'), canRetry: true }
    if (task.step === 'done') return { text: t('progressStepDone'), canRetry: false }
    return {
      text: task.via === undefined ? t('progressStepParse') : t('progressExtractingVia').replace('{via}', task.via),
      canRetry: canRetryExtraction(task.state),
    }
  }
  if (task.state === 'succeeded') return { text: t('progressSucceeded'), canRetry: canRetryExtraction(task.state) }
  // Already Markdown: the reader asked for an extraction and there is nothing to do. A
  // success, not a failure -- reporting it as "no extractor" told them their own Markdown
  // file was unreadable.
  if (task.state === 'already-markdown') return { text: t('progressAlreadyMarkdown'), canRetry: false }
  if (task.state === 'unsupported') return { text: t('progressUnsupported'), canRetry: canRetryExtraction(task.state) }
  // The badge states the outcome; the reason belongs on its own line under the name,
  // where the reader can read it instead of hunting for a cut-off badge.
  return { text: t('progressFailedTitle'), canRetry: canRetryExtraction(task.state) }
}

/**
 * Render one failed task's reason the way a reader can act on it.
 *
 * The Host speaks in errno terms (`no such file`); the one case worth translating is a
 * vanished source, because the action differs (look for the file) from every other
 * failure. The raw string stays visible as secondary text so an operator keeps the
 * detail even when the friendly sentence is on top.
 * @param reason - the raw reason.
 * @param t - copy resolver.
 * @returns The readable sentence and the raw reason when it differs.
 */
function readFailureReason(
  reason: string | undefined,
  t: (key: string) => string,
): { text: string; raw?: string } {
  const raw = reason === undefined || reason === '' ? undefined : reason
  if (raw === undefined) return { text: t('progressFailedTitle') }
  if (classifyExtractionFailure(raw) === 'missing-file') {
    return { text: t('extractReasonMissingFile'), raw }
  }
  return { text: raw }
}

/**
 * The notification button and its progress panel.
 * @param props - the upload batch, whether to watch extraction, and the copy resolver.
 * @returns The button, plus the panel while it is open.
 */
export function KnowledgeProgressPopover(props: KnowledgeProgressPopoverProps) {
  const t = props.t
  /** Tasks observed by the Host before this page session belong to history, not the live queue. */
  const sessionStart = useRef(Date.now())
  const [extractions, setExtractions] = useState<ExtractionTaskView[]>([])
  const [open, setOpen] = useState(false)
  /** The task being retried, so only its own row shows the pending state. */
  const [retrying, setRetrying] = useState<string | undefined>(undefined)
  const [retryError, setRetryError] = useState<{ relPath: string; reason: string } | undefined>(undefined)

  const readExtractions = useCallback(async (): Promise<ExtractionTaskView[]> => {
    const response = await fetch(kbApiPath(KB_API.extractStatus), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error('HTTP ' + String(response.status))
    const body = (await response.json()) as ExtractionStatusView
    return body.tasks ?? []
  }, [])

  /**
   * The Host's tasks plus the rows only this panel knows about yet.
   *
   * `Date.now()` is read on render rather than held in state on purpose: an entry's
   * remaining lifetime only matters when something re-renders, and the poll re-renders
   * while work is pending.
   */
  const merged = useMemo(
    () => mergeOptimistic(extractions, props.optimistic ?? [], Date.now()),
    [extractions, props.optimistic],
  )

  // Poll only while something is pending: an idle reader must not cost a request every
  // second and a half forever. The panel being open does not change the rule -- the
  // closed state has to stay current too, because the badge has to be right before the
  // reader clicks it.
  useEffect(() => {
    if (!props.watchExtraction) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async (): Promise<void> => {
      try {
        const tasks = await readExtractions()
        if (!live) return
        setExtractions(tasks)
        // Keep polling while a task is queued or running, and also while the reader has
        // the panel open (they are watching it, so a stale list is worse than a request).
        if (tasks.some(task => ACTIVE_STATES.has(task.state)) || pendingRef.current > 0) {
          timer = setTimeout(() => { void tick() }, POLL_MS)
        }
      } catch {
        // A failed read leaves the last known state on screen; the badge is not the place
        // to shout about a transient Host hiccup.
        if (live) timer = setTimeout(() => { void tick() }, POLL_MS)
      }
    }
    void tick()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [props.watchExtraction, readExtractions, props.refreshSignal, props.uploads])

  // The poll loop reads the current pending count through a ref: putting it in the effect
  // dependencies would restart the timer on every task change and starve the interval.
  const pendingRef = useRef(0)

  /** Ask the Host to run this extraction again. */
  const retry = useCallback(async (relPath: string): Promise<void> => {
    setRetrying(relPath)
    setRetryError(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.extractRetry), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath }),
        cache: 'no-store',
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        setRetryError({ relPath, reason: body.error ?? 'HTTP ' + String(response.status) })
        return
      }
      setExtractions(await readExtractions())
      props.onRetried?.(relPath)
    } catch (error: unknown) {
      setRetryError({ relPath, reason: error instanceof Error ? error.message : 'retry failed' })
    } finally {
      setRetrying(undefined)
    }
  }, [props, readExtractions])

  // Failures the Host has no task for still belong in the summary, so they are folded in
  // as synthetic failed rows before counting. A summary that skipped them would show
  // "0 failed" above a list holding the failure the reader just saw.
  const clientFailures = useMemo(
    () => survivingClientFailures(merged.rows, props.failures ?? [], merged.queued),
    [merged.rows, merged.queued, props.failures],
  )
  /**
   * One unified queue: each file is one row whose badge advances through
   * uploading → uploaded → extracting → done (or failed). Uploads and the extraction
   * tasks they trigger are merged by tree-relative path, so a reader never has to
   * reconcile two groups that describe the same file.
   */
  interface QueueRow {
    key: string
    name: string
    path: string
    stage: 'uploading' | 'uploaded' | 'extracting' | 'done' | 'failed'
    kind: 'upload' | 'extract'
    percent?: number
    reason?: string
    rawReason?: string
    markdown?: string
    at?: string
    retryPath?: string
    retryable?: boolean
    /** Restored from localStorage rather than observed this session. */
    historical?: boolean
  }
  const basename = (value: string): string => value.slice(value.lastIndexOf('/') + 1)
  const dirname = (value: string): string => value.slice(0, value.lastIndexOf('/'))
  const queueRows = useMemo<QueueRow[]>(() => {
    const rows = new Map<string, QueueRow>()
    const extractionByPath = new Map(merged.rows.map(task => [task.relPath, task]))
    const extractionByName = new Map(merged.rows.map(task => [basename(task.relPath), task]))
    const used = new Set<string>()
    /** Overall progress: upload 0-25, upload done 25, extraction 25-75, done 100. */
    const progressForExtraction = (task: ExtractionTaskView): number => {
      if (task.state === 'succeeded' || task.state === 'already-markdown') return 100
      if (task.state === 'failed' || task.state === 'unsupported') return 50
      if (task.state === 'pending') return 30
      if (task.step === 'chunk') return 60
      if (task.step === 'index') return 70
      if (task.step === 'done') return 75
      return 45
    }
    const applyExtraction = (row: QueueRow, task: ExtractionTaskView): void => {
      used.add(task.relPath)
      row.percent = progressForExtraction(task)
      if (task.state === 'succeeded' || task.state === 'already-markdown') {
        row.stage = 'done'
        row.markdown = task.markdown
        return
      }
      if (task.state === 'failed' || task.state === 'unsupported') {
        row.stage = 'failed'
        const failure = readFailureReason(task.reason, t)
        row.reason = failure.text
        if (failure.raw !== undefined) row.rawReason = failure.raw
        if (classifyExtractionFailure(task.reason ?? '') !== 'missing-file') {
          row.retryPath = task.relPath
          row.retryable = true
        }
        return
      }
      row.stage = 'extracting'
    }
    const rank: Record<QueueRow['stage'], number> = { uploading: 0, uploaded: 1, extracting: 2, done: 3, failed: 4 }
    const upsert = (row: QueueRow): void => {
      const existing = rows.get(row.key)
      if (existing === undefined) { rows.set(row.key, row); return }
      if (rank[row.stage] >= rank[existing.stage]) rows.set(row.key, { ...existing, ...row })
    }
    for (const task of props.uploads) {
      const relPath = task.dir === '' ? task.name : task.dir + '/' + task.name
      const name = basename(task.name)
      const row: QueueRow = {
        key: 'file:' + name,
        name,
        path: '',
        kind: 'upload',
        stage: 'uploading',
        percent: task.percent === undefined ? 0 : Math.round(task.percent * 0.25),
        at: task.at,
      }
      if (task.state === 'failed') {
        row.stage = 'failed'
        row.percent = 0
        row.reason = task.reason
      } else if (task.state === 'done') {
        const extraction = extractionByPath.get(relPath) ?? extractionByName.get(name)
        if (extraction !== undefined) applyExtraction(row, extraction)
        else { row.stage = 'uploaded'; row.percent = 25 }
      }
      upsert(row)
    }
    // Completed tasks the Host still remembers from an earlier page session are history:
    // the persisted record (if any) renders them. Active tasks and this session's own
    // requests stay live.
    const recentCutoff = Date.now() - 10 * 60_000
    const sourceNames = new Set(props.uploads.map(task => basename(task.name)))
    for (const task of merged.rows) {
      if (used.has(task.relPath)) continue
      const name = basename(task.relPath)
      if (rows.has('file:' + name)) continue
      // `.md` 是派生产物：源文件已经在队列里时不再单独显示一行。
      if (name.endsWith('.md') && sourceNames.has(name.slice(0, -3))) continue
      const at = Date.parse(task.queuedAt ?? task.startedAt ?? task.finishedAt ?? '')
      if (!Number.isFinite(at) || at < recentCutoff) continue
      const active = task.state === 'pending' || task.state === 'running'
      if (!active && at < sessionStart.current) continue
      const row: QueueRow = {
        key: 'file:' + name,
        name,
        path: '',
        kind: 'extract',
        stage: 'extracting',
        percent: 25,
        at: task.queuedAt ?? task.startedAt,
      }
      applyExtraction(row, task)
      upsert(row)
    }
    for (const entry of merged.queued) {
      const name = basename(entry.relPath)
      const existing = rows.get('file:' + name)
      if (existing !== undefined) {
        if (existing.stage === 'uploaded') { existing.stage = 'extracting'; existing.percent = 25 }
        continue
      }
      rows.set('file:' + name, {
        key: 'file:' + name,
        name,
        path: '',
        kind: 'extract',
        stage: 'extracting',
        percent: 25,
        at: new Date(entry.requestedAt).toISOString(),
      })
    }
    for (const failure of clientFailures) {
      const name = basename(failure.relPath)
      const readable = readFailureReason(failure.reason, t)
      const missingFile = classifyExtractionFailure(failure.reason) === 'missing-file'
      const existing = rows.get('file:' + name)
      if (existing !== undefined) {
        existing.stage = 'failed'
        existing.percent = existing.percent ?? 50
        existing.reason = readable.text
        if (readable.raw !== undefined) existing.rawReason = readable.raw
        if (!missingFile) { existing.retryPath = failure.relPath; existing.retryable = true }
        continue
      }
      rows.set('file:' + name, {
        key: 'file:' + name,
        name,
        path: '',
        kind: 'extract',
        stage: 'failed',
        percent: 50,
        reason: readable.text,
        ...(readable.raw === undefined ? {} : { rawReason: readable.raw }),
        ...(missingFile ? {} : { retryPath: failure.relPath, retryable: true }),
        at: new Date(failure.at).toISOString(),
      })
    }
    return [...rows.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
  }, [props.uploads, merged, clientFailures, t])

  const queueDone = queueRows.filter(row => row.stage === 'done' || row.stage === 'uploaded').length
  const queueFailed = queueRows.filter(row => row.stage === 'failed').length
  const [history, setHistory] = useState<PersistedTask[]>(() => loadTaskQueue())
  /**
   * Persist every observation. Metadata only: the task's name, stage, progress and
   * timestamps, never the document bytes.
   */
  useEffect(() => {
    if (queueRows.length === 0) return
    setHistory(current => {
      const now = Date.now()
      const incoming: PersistedTask[] = queueRows.map(row => {
        const started = row.at === undefined ? NaN : Date.parse(row.at)
        return {
          id: row.key,
          fileName: row.name,
          kind: row.kind,
          stage: row.stage,
          ...(row.percent === undefined ? {} : { progress: row.percent }),
          startedAt: Number.isFinite(started) ? started : now,
          ...(row.stage === 'done' || row.stage === 'failed' ? { finishedAt: now } : {}),
          ...(row.reason === undefined ? {} : { error: row.reason }),
        }
      })
      const next = mergeTaskRecords(current, incoming, now)
      saveTaskQueue(next)
      return next
    })
  }, [queueRows])
  const historyRows = useMemo<QueueRow[]>(() => {
    const live = new Set(queueRows.map(row => row.key))
    // 一份文件只画一张历史卡：upload 与 extract 是同一件事的两个阶段，按文件名折叠，
    // 阶段取更靠后的那一条（extract 优先），避免刷新后出现「已上传 + 已提取」两行。
    const stageRank: Record<QueueRow['stage'], number> = { uploading: 0, uploaded: 1, extracting: 2, done: 3, failed: 4 }
    const byFile = new Map<string, PersistedTask>()
    for (const record of history) {
      if (live.has(record.id)) continue
      const existing = byFile.get(record.fileName)
      if (existing === undefined || stageRank[record.stage] >= stageRank[existing.stage]) byFile.set(record.fileName, record)
    }
    return [...byFile.values()].map(record => ({
      key: 'history:' + record.id,
      name: record.fileName,
      path: '',
      kind: record.kind,
      stage: record.stage,
      ...(record.progress === undefined ? {} : { percent: record.progress }),
      at: new Date(record.startedAt).toISOString(),
      ...(record.error === undefined ? {} : { reason: record.error }),
      historical: true,
    }))
  }, [history, queueRows])
  const displayRows = useMemo(
    () => [...queueRows, ...historyRows].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
    [queueRows, historyRows],
  )

  /**
   * Badge = tasks not finished yet (uploading or extracting). Uploaded-only rows are settled:
   * the file is in place, so they must not keep the badge lit.
   */
  const pending = queueRows.filter(row => row.stage === 'uploading' || row.stage === 'extracting').length
  /**
   * Poll window: after an upload settles, keep polling briefly so the extraction task the
   * Host creates afterwards is noticed; the badge itself does not count that window.
   */
  const pollPending = queueRows.filter(row => {
    if (row.stage === 'uploading' || row.stage === 'extracting') return true
    if (row.stage !== 'uploaded' || row.at === undefined) return false
    const at = Date.parse(row.at)
    return Number.isFinite(at) && Date.now() - at < UPLOAD_EXTRACTION_GRACE_MS
  }).length
  pendingRef.current = pollPending


  // A queued guess is work in flight, so the panel and its badge have to count it.
  const queuedCount = merged.queued.length
  const hasWork = displayRows.length > 0

  // The badge is the only always-visible part. It states a count and nothing else: a
  // number that is zero is not information, so the badge is absent rather than "0".
  const badge = pending === 0 ? undefined : pending > 99 ? t('progressBadgeMore') : String(pending)

  if (props.headless === true) return null

  return (
    <>
      <button
        type="button"
        className={styles.bell}
        aria-label={t('progressOpen')}
        title={t('progressOpen')}
        aria-expanded={open}
        onClick={() => { setOpen(current => !current) }}
      >
        {/* A bell drawn as text-free SVG: the icon set is the product's, but the glyph is
            this plugin's business, and one inline path avoids a new dependency for a
            single control. */}
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path
            d="M8 2.2a3.6 3.6 0 0 0-3.6 3.6v2.4L3.2 10.6a.5.5 0 0 0 .45.75h8.7a.5.5 0 0 0 .45-.75L11.6 8.2V5.8A3.6 3.6 0 0 0 8 2.2Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path d="M6.4 12.4a1.7 1.7 0 0 0 3.2 0" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        {badge !== undefined && (
          <span className={styles.badge} aria-label={t('progressBadge').replace('{n}', String(pending))}>{badge}</span>
        )}
      </button>

      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={t('progressTitle')}
        className={styles.dialog}
        headless
      >
        <div className={styles.dialogShell}>
          <div className={styles.dialogHead}>
            <div className={styles.dialogTitleRow}>
              <h2 className={styles.dialogTitle}>{t('progressTitle')}</h2>
              {displayRows.length > 0 && (
                <span className={styles.titleRatio}>{queueDone}/{displayRows.length}</span>
              )}
            </div>
            <button type="button" className={styles.dialogClose} aria-label={t('progressClose')} onClick={() => { setOpen(false) }}>
              ×
            </button>
          </div>
          <div className={styles.dialogContent}>
        {!hasWork && <p className={styles.empty}>{t('progressIdle')}</p>}

        {displayRows.length > 0 && (
          <section className={styles.group}>
            <ul className={styles.list}>
              {displayRows.map(row => {
                const stageLabel = row.stage === 'uploading' ? t('dropUploading')
                  : row.stage === 'uploaded' ? t('progressUploadDone')
                    : row.stage === 'extracting' ? t('progressExtracting')
                      : row.stage === 'done' ? t('progressExtractDone')
                        : t('progressFailedTitle')
                const tone = row.stage === 'failed' ? styles.badgeFailed
                  : row.stage === 'done' || row.stage === 'uploaded' ? styles.badgeDone
                    : styles.badgeBusy
                const time = row.at === undefined
                  ? ''
                  : (() => { try { return new Date(row.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) } catch { return '' } })()
                return (
                  <li key={row.key} className={styles.card}>
                    <span className={styles.cardRow}>
                      <FileTypeIcon path={row.name} size={16} />
                      <Tooltip label={row.name} side="top">
                        <span className={styles.cardName}>{row.name}</span>
                      </Tooltip>
                      {time !== '' && <span className={styles.cardTime}>{time}</span>}
                      <span className={tone}>{stageLabel}</span>
                    </span>
                    <span className={styles.progressRow} data-stage={row.stage}>
                      <span
                        className={styles.progressTrack}
                        role="progressbar"
                        aria-label={row.name}
                        aria-valuenow={row.percent ?? 0}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <span
                          className={row.stage === 'failed' ? styles.progressFill + ' ' + styles.progressFillFailed : styles.progressFill}
                          style={{ width: String(row.percent ?? 0) + '%' }}
                        />
                      </span>
                      {row.percent !== undefined && (
                        <span className={styles.progressPercent}>{String(Math.round(row.percent)) + '%'}</span>
                      )}
                    </span>
                    {row.reason !== undefined && <span className={styles.cardReason}>{row.reason}</span>}
                    {row.rawReason !== undefined && row.rawReason !== row.reason && (
                      <span className={styles.cardRawReason}>{t('progressRawReason').replace('{reason}', row.rawReason)}</span>
                    )}
                    {row.retryable === true && row.retryPath !== undefined && (
                      <span className={styles.cardActions}>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={retrying !== undefined}
                          onClick={() => { void retry(row.retryPath as string) }}
                        >
                          {retrying === row.retryPath ? t('progressRetrying') : t('progressRetry')}
                        </Button>
                      </span>
                    )}
                    {retryError !== undefined && retryError.relPath === row.retryPath && (
                      <span className={styles.cardReason}>{t('progressRetryFailed').replace('{reason}', retryError.reason)}</span>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}
          </div>
          <div className={styles.footer}>
            <Button
              variant="ghost"
              size="md"
              disabled={history.length === 0}
              onClick={() => { clearTaskQueue(); setHistory([]) }}
            >
              {t('progressClear')}
            </Button>
            <Button variant="ghost" size="md" onClick={() => { setOpen(false) }}>
              {t('progressClose')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
