/**
 * The 「工作流广场」 body: built-in workflow templates and their subscribe flow.
 *
 * The plaza is a TEMPLATE SHELF. It renders cards from the static registry and turns a
 * subscription into an ordinary DSH Schedule through the existing agent tool, following
 * the same path the product's own 「新建任务」 button uses (create a Session, ask the model
 * to schedule the work, confirm the task exists). Nothing here schedules anything
 * itself, and nothing here talks to DataOps: a workflow that touches knowledge
 * documents goes through the knowledge API when it runs, where permissions already
 * apply.
 *
 * @module @sparkelf/dsh-knowledge-base/client/workflows/WorkflowPlaza
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  BUILT_IN_WORKFLOWS,
  workflowMarker,
  type WorkflowDefinition,
  type WorkflowIcon,
} from './registry.ts'
import {
  checkCustomCron, frequencyChoices, INTERVAL_SPECS, isIntervalFrequency, intervalCron, resolveCron,
} from './cron.ts'
import { findSubscriptions, subscriptionIndex, type ExistingSubscription, type SubscribedTaskView } from './dedupe.ts'
import {
  createSubscriptionSession,
  unsubscribeWorkflow,
  type SubscribeFailure,
  type SubscribePhase,
} from './subscribe.ts'
import { mergePublishedWorkflows, type PublishedWorkflowView } from './published.ts'
import {
  findModelOption,
  initialModelOption,
  modelKeyOf,
  readRememberedModel,
  rememberModel,
  type WorkflowModelCatalogView,
  type WorkflowModelSelection,
} from './modelChoice.ts'
import styles from './WorkflowPlaza.module.css'

/** Copy the plaza needs, injected so this module owns no dictionary. */
export interface WorkflowPlazaCopy {
  readonly title: string
  readonly subscribe: string
  readonly subscribed: string
  readonly unsubscribe: string
  readonly frequency: string
  readonly daily: string
  readonly weekly: string
  readonly monthly: string
  readonly custom: string
  readonly cronLabel: string
  readonly cronInvalid: string
  /** Labels for the two interval shortcuts. */
  readonly everyHours: string
  readonly everyMinutes: string
  /** Count-field labels, one per interval unit. */
  readonly hoursCount: string
  readonly minutesCount: string
  /** Reasons a cron expression cannot be submitted, by rejection code. */
  readonly cronReason: (reason: string) => string
  /** Range message for an out-of-bounds or non-integer interval count. */
  readonly intervalInvalid: (min: number, max: number) => string
  readonly subscribing: string
  readonly plazaTab: string
  readonly reviewTab: string
  readonly mineTab: string
  readonly mineEmpty: string
  readonly mineUpdated: string
  readonly mineReviewNote: string
  readonly mineResubmit: string
  readonly mineUnpublish: string
  readonly mineDetails: string
  readonly mineActionFailed: string
  readonly mineStatusPending: string
  readonly mineStatusApproved: string
  readonly mineStatusRejected: string
  readonly mineStatusUnpublished: string
  readonly mineScopeGlobal: string
  readonly mineScopePrivate: string
  readonly mineScopeDepartment: (name: string) => string
  readonly reviewEmpty: string
  readonly reviewLoading: string
  readonly reviewFailed: string
  readonly reviewAuthor: string
  readonly reviewCreated: string
  readonly reviewPromptLabel: string
  readonly reviewNotePlaceholder: string
  readonly reviewApprove: string
  readonly reviewReject: string
  readonly model: string
  readonly modelLoading: string
  readonly modelUnavailable: string
  readonly modelDefault: string
  readonly effort: string
  readonly dialogTitle: string
  readonly dialogConfirm: string
  readonly dialogCancel: string
  readonly retry: string
  readonly alreadySubscribed: string
  readonly failure: (reason: string) => string
  readonly reason: (failure: SubscribeFailure) => string
  /** Card title and description, resolved per workflow id by the host. */
  readonly cardTitle: (workflow: WorkflowDefinition) => string
  readonly cardDescription: (workflow: WorkflowDefinition) => string
}

/** What the plaza needs from the Host, all injected so the component stays testable. */
export interface WorkflowPlazaDeps {
  /** Read the authoritative task list. */
  readonly listTasks: () => Promise<readonly SubscribedTaskView[]>
  /** Create a Session and return its id. */
  readonly createSession: () => Promise<string>
  /** Send one prompt into a Session. */
  readonly sendPrompt: (sessionId: string, text: string) => Promise<boolean>
  /** Remove one task. */
  readonly removeTask: (taskId: string, sessionId: string) => Promise<boolean>
  /** The Session's own turn failure, so a failed attempt states the real cause. */
  readonly readSessionFailure?: (sessionId: string) => Promise<string | undefined>
  /** Open a Session, so a failed attempt can be inspected. */
  readonly openSession?: (sessionId: string) => void
  /** Load the Host model catalog; omitted in tests that do not exercise model choice. */
  readonly loadModels?: () => Promise<WorkflowModelCatalogView>
  /** Install the chosen model on a newly created Session. */
  readonly selectModel?: (sessionId: string, selection: WorkflowModelSelection) => Promise<boolean>
  /** Persist the choice for the next dialog open. */
  readonly rememberModel?: (selection: WorkflowModelSelection) => void
  /** Read the previous choice; defaults to localStorage. */
  readonly readRememberedModel?: () => WorkflowModelSelection | undefined
  /** Approved published workflows to append to the built-in shelf. */
  readonly loadPublished?: () => Promise<readonly PublishedWorkflowView[]>
  /** Whether this caller may see the review tab. */
  readonly loadReviewAccess?: () => Promise<boolean>
  /** Pending workflows for the review tab. */
  readonly loadPending?: () => Promise<readonly PublishedWorkflowView[]>
  /** Approve or reject one pending workflow. */
  readonly reviewPublished?: (id: string, decision: 'approve' | 'reject', note?: string) => Promise<boolean>
  /** The caller's own shared workflows (all statuses). */
  readonly loadMine?: () => Promise<readonly PublishedWorkflowView[]>
  /** Unpublish one of the caller's approved workflows. */
  readonly unpublishMine?: (id: string) => Promise<boolean>
  /** Resubmit one rejected/unpublished workflow for review. */
  readonly resubmitMine?: (id: string) => Promise<boolean>
}

/** Props for the plaza body. */
export interface WorkflowPlazaProps {
  readonly copy: WorkflowPlazaCopy
  readonly deps: WorkflowPlazaDeps
  /**
   * Child-slot renderer supplied by the slot system when this component's registration
   * declares `workflow-plaza.actions`. Tests and non-slot uses omit it; the header
   * actions simply do not render.
   */
  readonly renderSlot?: (
    key: 'workflow-plaza.actions',
    owner: Record<string, never>,
  ) => ReactNode
}

/** What the slot's `inject` supplies: the copy and the Host wiring. */
export type WorkflowPlazaInjected = WorkflowPlazaProps

/**
 * Total attempts before the dialog stops offering a retry: the first try plus two.
 *
 * Two retries cover a model that answered nothing once or twice; beyond that the
 * silence repeats, so the reader is told to act instead of burning more turns.
 */
const RETRY_LIMIT = 3

/** Card glyph per workflow icon name. Kept as text so no icon package is required. */
const ICON_GLYPH: Record<WorkflowIcon, string> = {
  organize: '▦',
  index: '☰',
  archive: '⛁',
}

/** The card grid plus the subscribe dialog. */
export function WorkflowPlaza({ copy, deps, renderSlot }: WorkflowPlazaProps): ReactNode {
  const [tasks, setTasks] = useState<readonly SubscribedTaskView[]>([])
  const [publishedViews, setPublishedViews] = useState<readonly PublishedWorkflowView[]>([])
  const [dialogFor, setDialogFor] = useState<WorkflowDefinition | undefined>(undefined)
  const [view, setView] = useState<'plaza' | 'review' | 'mine'>('plaza')
  const [canReview, setCanReview] = useState(false)
  const [mine, setMine] = useState<readonly PublishedWorkflowView[]>([])
  const [mineError, setMineError] = useState<string | undefined>(undefined)
  const [mineBusy, setMineBusy] = useState<string | undefined>(undefined)
  const mounted = useRef(true)

  /** Re-read the authoritative list; card state is never kept only in memory. */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await deps.listTasks()
      if (mounted.current) setTasks(next)
    } catch {
      // A failed read leaves the previous list: the cards keep the last known answer
      // rather than claiming nothing is subscribed.
    }
  }, [deps])

  /** Read approved workflows; failure keeps built-ins only, never breaks the plaza. */
  const refreshPublished = useCallback(async (): Promise<void> => {
    if (deps.loadPublished === undefined) return
    try {
      const next = await deps.loadPublished()
      if (mounted.current) setPublishedViews(next)
    } catch {
      // Keep the last known approved set; the built-ins are still usable.
    }
  }, [deps])

  /** The mine tab is the same list its count is read from; never count separately. */
  const refreshMine = useCallback(async (): Promise<void> => {
    if (deps.loadMine === undefined) return
    try {
      const next = await deps.loadMine()
      if (mounted.current) {
        setMine(next)
        setMineError(undefined)
      }
    } catch {
      if (mounted.current) setMineError(copy.mineActionFailed)
    }
  }, [copy.mineActionFailed, deps])

  useEffect(() => {
    mounted.current = true
    void refresh()
    void refreshPublished()
    void refreshMine()
    return () => { mounted.current = false }
  }, [refresh, refreshPublished, refreshMine])

  useEffect(() => {
    if (deps.loadReviewAccess === undefined) return undefined
    let live = true
    void deps.loadReviewAccess().then((allowed) => {
      if (!live) return
      setCanReview(allowed)
      if (!allowed) setView('plaza')
    }).catch(() => { if (live) setCanReview(false) })
    return () => { live = false }
  }, [deps.loadReviewAccess])

  const cards = useMemo(
    () => mergePublishedWorkflows(BUILT_IN_WORKFLOWS, publishedViews),
    [publishedViews],
  )
  const subscriptions = useMemo(() => subscriptionIndex(findSubscriptions(tasks, cards)), [tasks, cards])

  const onUnsubscribe = useCallback(async (subscription: ExistingSubscription): Promise<void> => {
    await unsubscribeWorkflow(subscription.task.id, subscription.task.sessionId ?? '', { removeTask: deps.removeTask })
    await refresh()
  }, [deps, refresh])

  const onDone = useCallback(async (): Promise<void> => {
    setDialogFor(undefined)
    await Promise.all([refresh(), refreshPublished(), refreshMine()])
  }, [refresh, refreshPublished, refreshMine])

  return (
    <div className={styles.body} data-kb-plaza="body">
      <div className={styles.headerRow} data-kb-plaza-header="">
        {canReview || deps.loadMine !== undefined ? (
          <div className={styles.tabs} role="tablist" data-kb-plaza-tabs="">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'plaza'}
              className={view === 'plaza' ? styles.tabActive : styles.tab}
              data-kb-plaza-tab="plaza"
              onClick={() => { setView('plaza') }}
            >
              {copy.plazaTab}
            </button>
            {deps.loadMine === undefined ? null : (
              <button
                type="button"
                role="tab"
                aria-selected={view === 'mine'}
                className={view === 'mine' ? styles.tabActive : styles.tab}
                data-kb-plaza-tab="mine"
                onClick={() => { setView('mine') }}
              >
                {copy.mineTab}
                <span className={styles.tabCount} data-kb-plaza-mine-count="">{mine.length}</span>
              </button>
            )}
            {canReview ? (
              <button
                type="button"
                role="tab"
                aria-selected={view === 'review'}
                className={view === 'review' ? styles.tabActive : styles.tab}
                data-kb-plaza-tab="review"
                onClick={() => { setView('review') }}
              >
                {copy.reviewTab}
              </button>
            ) : null}
          </div>
        ) : null}
        {renderSlot === undefined ? null : (
          <div className={styles.actions} data-kb-plaza-actions="">
            {renderSlot('workflow-plaza.actions', {})}
          </div>
        )}
      </div>
      {view === 'review' && canReview ? (
        <ReviewPanel copy={copy} deps={deps} onReviewed={onDone} />
      ) : view === 'mine' && deps.loadMine !== undefined ? (
        <MinePanel
          copy={copy}
          items={mine}
          error={mineError}
          busyId={mineBusy}
          onResubmit={async (id) => {
            if (deps.resubmitMine === undefined) return
            setMineBusy(id)
            const ok = await deps.resubmitMine(id)
            setMineBusy(undefined)
            if (!ok) { setMineError(copy.mineActionFailed); return }
            await Promise.all([refreshMine(), refreshPublished()])
          }}
          onUnpublish={async (id) => {
            if (deps.unpublishMine === undefined) return
            setMineBusy(id)
            const ok = await deps.unpublishMine(id)
            setMineBusy(undefined)
            if (!ok) { setMineError(copy.mineActionFailed); return }
            await Promise.all([refreshMine(), refreshPublished()])
          }}
        />
      ) : (
      <ul className={styles.cards} data-kb-plaza="cards">
        {cards.map(workflow => {
          const subscription = subscriptions.get(workflow.id)
          const subscribed = subscription !== undefined
          return (
            <li key={workflow.id} className={styles.card} data-kb-workflow={workflow.id}>
              <div className={styles.cardTop}>
                <span className={styles.cardIcon} aria-hidden="true">{ICON_GLYPH[workflow.icon]}</span>
                <span className={styles.cardTitle}>{copy.cardTitle(workflow)}</span>
                {subscribed ? <span className={styles.mark}>{copy.subscribed}</span> : null}
              </div>
              <div className={styles.cardDesc}>{copy.cardDescription(workflow)}</div>
              <div className={styles.cardFoot}>
                <span className={styles.cardCron}>{workflow.defaultCron}</span>
                {subscribed ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-kb-workflow-unsubscribe={workflow.id}
                    onClick={() => { void onUnsubscribe(subscription) }}
                  >
                    {copy.unsubscribe}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    data-kb-workflow-subscribe={workflow.id}
                    onClick={() => { setDialogFor(workflow) }}
                  >
                    {copy.subscribe}
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      )}
      <SubscribeDialog
        workflow={dialogFor}
        copy={copy}
        deps={deps}
        existing={dialogFor === undefined ? undefined : subscriptions.get(dialogFor.id)}
        onClose={() => { setDialogFor(undefined) }}
        onDone={onDone}
      />
    </div>
  )
}

/**
 * The plaza as a standalone panel page.
 *
 * The automation-task page's `schedule.manager.tabs` seat is contributed at runtime;
 * on a Host that does not declare that child slot the registration is simply inert.
 * This page gives the same body a sidebar-reachable home on every Host, so the feature
 * is never invisible just because the surrounding page is older.
 */
export function WorkflowPlazaPage({ copy, deps, renderSlot }: WorkflowPlazaInjected): ReactNode {
  return (
    <section className={styles.page} data-kb-plaza-page="">
      <h1 className={styles.pageTitle}>{copy.title}</h1>
      <WorkflowPlaza copy={copy} deps={deps} renderSlot={renderSlot} />
    </section>
  )
}

/** Normalized mine status: backend uses reviewStatus, the profile store uses status. */
function mineStatus(item: PublishedWorkflowView): 'pending' | 'approved' | 'rejected' | 'unpublished' {
  if (item.unpublishedAt !== undefined && item.unpublishedAt !== null && item.unpublishedAt !== '') return 'unpublished'
  const value = item.reviewStatus ?? item.status ?? 'pending'
  return value === 'approved' || value === 'rejected' || value === 'unpublished' ? value : 'pending'
}

/** Human scope tag for a mine card. */
function mineScopeLabel(copy: WorkflowPlazaCopy, item: PublishedWorkflowView): string {
  if (item.visibility === 'global') return copy.mineScopeGlobal
  if (item.visibility === 'department') {
    return copy.mineScopeDepartment(item.departmentName ?? item.departmentCode ?? '—')
  }
  return copy.mineScopePrivate
}

/** One workflow's full detail, read in a dialog rather than inline on the card. */
function WorkflowDetailDialog({ item, copy, onClose }: {
  item: PublishedWorkflowView | undefined
  copy: WorkflowPlazaCopy
  onClose: () => void
}): ReactNode {
  return (
    <Modal
      open={item !== undefined}
      onClose={onClose}
      title={item?.title ?? ''}
      closeLabel={copy.dialogCancel}
      footer={<Button variant="outline" onClick={onClose}>{copy.dialogCancel}</Button>}
    >
      {item === undefined ? null : (
        <div className={styles.detailDialogBody} data-kb-plaza-detail-dialog="">
          <p className={styles.detailDescription}>{item.description}</p>
          <pre className={styles.detailInstruction}>{item.instruction}</pre>
          <div className={styles.detailFacts}>
            <span>{copy.mineUpdated}：{item.updatedAt ?? item.reviewedAt ?? item.createdAt ?? '—'}</span>
            {item.cronHint === undefined || item.cronHint === null || item.cronHint === '' ? null : <span>{item.cronHint}</span>}
            {item.category === undefined || item.category === '' ? null : <span>{item.category}</span>}
          </div>
          {item.reviewNote === undefined || item.reviewNote === '' ? null : (
            <p className={styles.failure}>{copy.mineReviewNote}：{item.reviewNote}</p>
          )}
        </div>
      )}
    </Modal>
  )
}

/** Format an API timestamp for a card footer; avoids showing raw ISO text. */
function formatMineTime(value: string | undefined): string {
  if (value === undefined || value === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The caller's own shared workflows, newest update first. */
function MinePanel({ copy, items, error, busyId, onResubmit, onUnpublish }: {
  copy: WorkflowPlazaCopy
  items: readonly PublishedWorkflowView[]
  error?: string
  busyId?: string
  onResubmit: (id: string) => Promise<void>
  onUnpublish: (id: string) => Promise<void>
}): ReactNode {
  const statusLabel = (status: ReturnType<typeof mineStatus>): string => {
    if (status === 'approved') return copy.mineStatusApproved
    if (status === 'rejected') return copy.mineStatusRejected
    if (status === 'unpublished') return copy.mineStatusUnpublished
    return copy.mineStatusPending
  }
  const [detailFor, setDetailFor] = useState<PublishedWorkflowView | undefined>(undefined)
  return (
    <section className={styles.review} data-kb-plaza-mine="">
      {error === undefined ? null : <p className={styles.failure}>{error}</p>}
      {items.length === 0 ? (
        <p className={styles.reviewEmpty} data-kb-plaza-mine-empty="">{copy.mineEmpty}</p>
      ) : (
        <ul className={styles.reviewList}>
          {items.map(item => {
            const status = mineStatus(item)
            return (
              <li key={item.id} className={styles.card} data-kb-plaza-mine-card={item.id}>
                <div className={styles.cardTop}>
                  <span className={styles.cardIcon} aria-hidden="true">{ICON_GLYPH.organize}</span>
                  <span className={styles.cardTitle}>{item.title}</span>
                  <div className={styles.mineTags}>
                    <span className={styles.mineStatus} data-kb-plaza-mine-status={status}>
                      {statusLabel(status)}
                    </span>
                    <span className={styles.mineScope} data-kb-plaza-mine-scope={item.visibility ?? 'private'}>
                      {mineScopeLabel(copy, item)}
                    </span>
                  </div>
                </div>
                <div className={styles.cardDesc}>{item.description}</div>
                {status === 'rejected' && item.reviewNote !== undefined && item.reviewNote !== '' ? (
                  <p className={styles.failure} data-kb-plaza-mine-reason="">{copy.mineReviewNote}：{item.reviewNote}</p>
                ) : null}
                <div className={styles.cardFoot} data-kb-plaza-mine-footer="">
                  <span className={styles.cardCron} title={item.cronHint ?? ''}>{item.cronHint ?? '—'}</span>
                  <span className={styles.mineTime}>{copy.mineUpdated}：{formatMineTime(item.updatedAt ?? item.reviewedAt ?? item.createdAt)}</span>
                  <div className={styles.actions}>
                    {status === 'rejected' || status === 'unpublished' ? (
                      <Button variant="primary" size="sm" disabled={busyId === item.id}
                        data-kb-plaza-mine-resubmit={item.id} onClick={() => { void onResubmit(item.id) }}>
                        {copy.mineResubmit}
                      </Button>
                    ) : null}
                    {status === 'approved' ? (
                      <Button variant="outline" size="sm" disabled={busyId === item.id}
                        data-kb-plaza-mine-unpublish={item.id} onClick={() => { void onUnpublish(item.id) }}>
                        {copy.mineUnpublish}
                      </Button>
                    ) : null}
                    <Button variant="outline" size="sm" data-kb-plaza-mine-detail={item.id}
                      onClick={() => { setDetailFor(item) }}>
                      {copy.mineDetails}
                    </Button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <WorkflowDetailDialog item={detailFor} copy={copy} onClose={() => { setDetailFor(undefined) }} />
    </section>
  )
}

/**
 * The review queue.
 *
 * Only mounted when `loadReviewAccess` says yes; the Host route enforces the same fact,
 * so hiding the tab is representation rather than the authorization decision. A rejection
 * keeps the record in the store but removes it from this queue and never publishes it.
 */
function ReviewPanel({ copy, deps, onReviewed }: {
  copy: WorkflowPlazaCopy
  deps: WorkflowPlazaDeps
  onReviewed: () => Promise<void>
}): ReactNode {
  const [items, setItems] = useState<readonly PublishedWorkflowView[] | undefined>(undefined)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [detailFor, setDetailFor] = useState<PublishedWorkflowView | undefined>(undefined)

  const load = useCallback(async (): Promise<void> => {
    if (deps.loadPending === undefined) {
      setItems([])
      return
    }
    try {
      setItems(await deps.loadPending())
      setError(undefined)
    } catch {
      setError(copy.reviewFailed)
      setItems([])
    }
  }, [deps, copy.reviewFailed])

  useEffect(() => {
    let live = true
    void load().then(() => { if (!live) setItems([]) })
    return () => { live = false }
  }, [load])

  const decide = async (id: string, decision: 'approve' | 'reject'): Promise<void> => {
    if (deps.reviewPublished === undefined || busy !== undefined) return
    setBusy(id)
    setError(undefined)
    try {
      const ok = await deps.reviewPublished(id, decision, notes[id] ?? '')
      if (!ok) {
        setError(copy.reviewFailed)
        return
      }
      await load()
      await onReviewed()
    } finally {
      setBusy(undefined)
    }
  }

  if (items === undefined) return <p className={styles.reviewEmpty}>{copy.reviewLoading}</p>
  return (
    <section className={styles.review} data-kb-plaza-review="">
      {error === undefined ? null : <p className={styles.failure}>{error}</p>}
      {items.length === 0 ? (
        <p className={styles.reviewEmpty} data-kb-plaza-review-empty="">{copy.reviewEmpty}</p>
      ) : (
        <ul className={styles.reviewList}>
          {items.map(item => (
            <li key={item.id} className={styles.reviewCard} data-kb-plaza-pending={item.id}>
              <div className={styles.reviewHead}>
                <strong className={styles.reviewTitle}>{item.title}</strong>
                {item.category === '' ? null : <span className={styles.mark}>{item.category}</span>}
                <span className={styles.mineScope} data-kb-plaza-review-scope={item.visibility ?? 'private'}>
                  {mineScopeLabel(copy, item)}
                </span>
              </div>
              <div className={styles.reviewMeta}>
                {copy.reviewAuthor}：{item.authorName ?? item.authorId ?? '—'} · {copy.reviewCreated}：{item.createdAt ?? '—'}
              </div>
              <p className={styles.reviewDescription}>{item.description}</p>
              <input
                className={styles.reviewNote}
                value={notes[item.id] ?? ''}
                placeholder={copy.reviewNotePlaceholder}
                onChange={event => { setNotes(previous => ({ ...previous, [item.id]: event.target.value })) }}
                disabled={busy === item.id}
                data-kb-plaza-review-note={item.id}
              />
              <div className={styles.reviewActions}>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy === item.id}
                  data-kb-plaza-approve={item.id}
                  onClick={() => { void decide(item.id, 'approve') }}
                >
                  {copy.reviewApprove}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === item.id}
                  data-kb-plaza-review-detail={item.id}
                  onClick={() => { setDetailFor(item) }}
                >
                  {copy.mineDetails}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === item.id}
                  data-kb-plaza-reject={item.id}
                  onClick={() => { void decide(item.id, 'reject') }}
                >
                  {copy.reviewReject}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <WorkflowDetailDialog item={detailFor} copy={copy} onClose={() => { setDetailFor(undefined) }} />
    </section>
  )
}

/** The subscribe dialog: prefilled cron, frequency shortcuts, and the verified result. */
function SubscribeDialog({ workflow, copy, deps, existing, onClose, onDone }: {
  workflow: WorkflowDefinition | undefined
  copy: WorkflowPlazaCopy
  deps: WorkflowPlazaDeps
  existing: ExistingSubscription | undefined
  onClose: () => void
  onDone: () => Promise<void>
}): ReactNode {
  const [frequencyId, setFrequencyId] = useState('weekly')
  const [customCron, setCustomCron] = useState('')
  /**
   * Counts for the two interval shortcuts, keyed by frequency id.
   *
   * Seeded from `INTERVAL_SPECS`, so switching to "every N hours" always shows a usable
   * number instead of an empty box the reader has to fill before anything works.
   */
  const [intervalCounts, setIntervalCounts] = useState<Record<string, string>>({
    everyHours: String(INTERVAL_SPECS.everyHours.defaultCount),
    everyMinutes: String(INTERVAL_SPECS.everyMinutes.defaultCount),
  })
  const [phase, setPhase] = useState<SubscribePhase>('idle')
  const [failure, setFailure] = useState<SubscribeFailure | undefined>(undefined)
  /**
   * Completed attempts. A model that returns nothing once may well succeed on a retry,
   * but a third silent attempt is not worth the round-trip -- after two the dialog
   * stops offering it and asks the reader to act instead.
   */
  const [attempts, setAttempts] = useState(0)
  /**
   * The Host's model catalog, the chosen provider/model key, and the chosen reasoning
   * effort. Undefined catalog means "not loaded yet"; `modelFailed` is the fallback the
   * dialog renders when the catalog cannot be fetched (workspace default only).
   */
  const [modelCatalog, setModelCatalog] = useState<WorkflowModelCatalogView | undefined>(undefined)
  const [modelKey, setModelKey] = useState('')
  const [effort, setEffort] = useState('')
  const [modelFailed, setModelFailed] = useState(false)
  // Synchronous guard: a second click must not reach the orchestration before the first
  // attempt has even awaited. React state alone is too late for a double click.
  const busy = useRef(false)

  // Reset whenever a different workflow opens the dialog, so a previous attempt's
  // failure cannot colour a fresh one. Runs whether or not a workflow is selected, so
  // the hook order never depends on the props (a conditional return above a hook would
  // break React's ordering guarantee the first time the dialog closes).
  useEffect(() => {
    setFrequencyId('weekly')
    setCustomCron(workflow?.defaultCron ?? '')
    setIntervalCounts({
      everyHours: String(INTERVAL_SPECS.everyHours.defaultCount),
      everyMinutes: String(INTERVAL_SPECS.everyMinutes.defaultCount),
    })
    setPhase('idle')
    setFailure(undefined)
    setAttempts(0)
    setModelCatalog(undefined)
    setModelKey('')
    setEffort('')
    setModelFailed(false)
    busy.current = false
  }, [workflow])

  // Load the catalog once per dialog open. Remembered choice wins when it is still
  // served; otherwise the Host default; otherwise the first model. A failed load is a
  // normal fallback (workspace default), not an error the reader must fix.
  useEffect(() => {
    if (workflow === undefined) return undefined
    let live = true
    const load = deps.loadModels
    if (load === undefined) {
      setModelFailed(true)
      return () => { live = false }
    }
    void load().then((catalog) => {
      if (!live) return
      setModelCatalog(catalog)
      const remembered = (deps.readRememberedModel ?? readRememberedModel)()
      const initial = initialModelOption(catalog, remembered)
      if (initial !== undefined) {
        setModelKey(initial.key)
        // The remembered/default selection may have carried an explicit effort; keep it
        // when the option we landed on is that same route.
        const rememberedEffort = remembered !== undefined && modelKeyOf(remembered) === initial.key
          ? remembered.reasoningEffort
          : undefined
        const defaultEffort = catalog.default !== undefined && modelKeyOf(catalog.default) === initial.key
          ? catalog.default.reasoningEffort
          : undefined
        setEffort(rememberedEffort ?? defaultEffort ?? initial.defaultEffort ?? '')
      }
    }).catch(() => {
      if (live) setModelFailed(true)
    })
    return () => { live = false }
  }, [workflow, deps.loadModels, deps.readRememberedModel])

  // Every hook above runs first; only now may the render bail out.
  if (workflow === undefined) return null

  const choices = frequencyChoices(workflow, workflow.defaultCron)
  const intervalRaw = isIntervalFrequency(frequencyId) ? (intervalCounts[frequencyId] ?? '') : ''
  const resolved = resolveCron(frequencyId, workflow, customCron, intervalRaw)
  const intervalSpec = isIntervalFrequency(frequencyId) ? INTERVAL_SPECS[frequencyId] : undefined
  const intervalCheck = intervalSpec === undefined ? undefined : intervalCron(intervalSpec, intervalRaw)
  const customCheck = checkCustomCron(customCron)
  const running = phase === 'creating-session'
    || phase === 'selecting-model'
    || phase === 'prompting'
    || phase === 'verifying'
  const selectedModel = modelCatalog === undefined ? undefined : findModelOption(modelCatalog, modelKey)
  const modelLoading = deps.loadModels !== undefined && modelCatalog === undefined && !modelFailed
  const label = (choiceId: string): string => {
    switch (choiceId) {
      case 'daily': return copy.daily
      case 'weekly': return copy.weekly
      case 'monthly': return copy.monthly
      case 'everyHours': return copy.everyHours
      case 'everyMinutes': return copy.everyMinutes
      default: return copy.custom
    }
  }

  const submit = async (): Promise<void> => {
    if (busy.current || existing !== undefined) return
    if (!resolved.ok) return
    busy.current = true
    setFailure(undefined)
    setPhase('creating-session')
    const model: WorkflowModelSelection | undefined = selectedModel === undefined
      ? undefined
      : {
        provider: selectedModel.provider,
        model: selectedModel.model,
        ...(effort === '' ? {} : { reasoningEffort: effort }),
      }
    try {
      const outcome = await createSubscriptionSession(workflow, resolved.cron, model, {
        listTasks: deps.listTasks,
        createSession: deps.createSession,
        sendPrompt: deps.sendPrompt,
        removeTask: deps.removeTask,
        ...(deps.selectModel === undefined ? {} : { selectModel: deps.selectModel }),
        ...(deps.openSession === undefined ? {} : { openSession: deps.openSession }),
        onChange: state => { setPhase(state.phase) },
      })
      if (outcome.ok) {
        if (model !== undefined) (deps.rememberModel ?? rememberModel)(model)
        // The Session is already opened by createSubscriptionSession; closing the dialog
        // is therefore immediate and the plaza refresh is fire-and-forget.
        await onDone()
        return
      }
      setFailure(outcome.failure)
      setAttempts(count => count + 1)
      setPhase('failed')
      if (outcome.failure === 'not-created' && outcome.sessionId !== undefined) {
        deps.openSession?.(outcome.sessionId)
      }
    } finally {
      busy.current = false
    }
  }

  return (
    <Modal
      open={workflow !== undefined}
      onClose={running ? () => undefined : onClose}
      title={copy.dialogTitle}
      closeLabel={copy.dialogCancel}
      description={copy.cardTitle(workflow)}
      footer={(
        <>
          <Button variant="ghost" disabled={running} onClick={onClose}>{copy.dialogCancel}</Button>
          <Button
            variant="primary"
            disabled={running || resolved.ok === false || existing !== undefined || modelLoading}
            data-kb-plaza-confirm=""
            onClick={() => { void submit() }}
          >
            {running ? copy.subscribing : copy.dialogConfirm}
          </Button>
        </>
      )}
    >
      <div className={styles.dialogBody}>
        {existing === undefined ? null : (
          <p className={styles.failure}>{copy.alreadySubscribed}</p>
        )}
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="kb-plaza-model">{copy.model}</label>
          <select
            id="kb-plaza-model"
            className={styles.cronInput}
            value={modelKey}
            disabled={running || modelLoading}
            data-kb-plaza-model=""
            onChange={event => {
              setModelKey(event.target.value)
              const next = modelCatalog === undefined ? undefined : findModelOption(modelCatalog, event.target.value)
              setEffort(next?.reasoningEffort ?? next?.defaultEffort ?? '')
            }}
          >
            {modelCatalog === undefined ? (
              <option value="">{modelFailed ? copy.modelUnavailable : copy.modelLoading}</option>
            ) : modelCatalog.groups.length === 0 ? (
              <option value="">{copy.modelDefault}</option>
            ) : (
              modelCatalog.groups.map(group => (
                <optgroup key={group.provider} label={group.providerName}>
                  {group.models.map(model => (
                    <option key={model.key} value={model.key}>{model.modelName}</option>
                  ))}
                </optgroup>
              ))
            )}
          </select>
          {selectedModel !== undefined && selectedModel.reasoningEfforts.length > 0 ? (
            <>
              <label className={styles.fieldLabel} htmlFor="kb-plaza-effort">{copy.effort}</label>
              <select
                id="kb-plaza-effort"
                className={styles.cronInput}
                value={effort}
                disabled={running}
                data-kb-plaza-effort=""
                onChange={event => { setEffort(event.target.value) }}
              >
                {selectedModel.reasoningEfforts.map(level => (
                  <option key={level.id} value={level.id}>{level.name}</option>
                ))}
              </select>
            </>
          ) : null}
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{copy.frequency}</span>
          <div className={styles.frequencies} role="group" aria-label={copy.frequency}>
            {choices.map(choice => (
              <button
                key={choice.id}
                type="button"
                className={choice.id === frequencyId ? `${styles.frequency} ${styles.frequencyOn}` : styles.frequency}
                aria-pressed={choice.id === frequencyId}
                data-kb-plaza-frequency={choice.id}
                onClick={() => { setFrequencyId(choice.id) }}
              >
                {label(choice.id)}
              </button>
            ))}
          </div>
        </div>
        {intervalSpec === undefined ? null : (
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="kb-plaza-interval">
              {intervalSpec.unit === 'hours' ? copy.hoursCount : copy.minutesCount}
            </label>
            <input
              id="kb-plaza-interval"
              className={styles.cronInput}
              type="number"
              inputMode="numeric"
              min={intervalSpec.min}
              max={intervalSpec.max}
              step={1}
              value={intervalCounts[frequencyId] ?? ''}
              aria-invalid={intervalCheck !== undefined && !intervalCheck.ok}
              data-kb-plaza-interval=""
              onChange={event => {
                // Switching back to an interval shortcut must not silently overwrite the
                // reader's number, so the count is stored per frequency id rather than
                // in one shared field.
                setIntervalCounts(current => ({ ...current, [frequencyId]: event.target.value }))
              }}
            />
            {intervalCheck !== undefined && !intervalCheck.ok ? (
              <p className={styles.cronInvalid} data-kb-plaza-interval-error={(intervalCheck as { reason?: string }).reason}>
                {copy.intervalInvalid(intervalSpec.min, intervalSpec.max)}
              </p>
            ) : null}
          </div>
        )}
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="kb-plaza-cron">{copy.cronLabel}</label>
          <input
            id="kb-plaza-cron"
            className={styles.cronInput}
            value={frequencyId === 'custom' ? customCron : (resolved.ok ? resolved.cron : '')}
            readOnly={frequencyId !== 'custom'}
            aria-invalid={(frequencyId === 'custom' && !customCheck.ok) || (intervalCheck !== undefined && !intervalCheck.ok)}
            data-kb-plaza-cron=""
            onChange={event => {
              setFrequencyId('custom')
              setCustomCron(event.target.value)
            }}
          />
          {frequencyId === 'custom' && !customCheck.ok ? (
            <p className={styles.cronInvalid}>{copy.cronInvalid}</p>
          ) : null}
        </div>
        {failure === undefined ? null : (
          <div className={styles.failureRow}>
            <p className={styles.failure} data-kb-plaza-failure={failure}>
              {copy.failure(copy.reason(failure))}
            </p>
            {attempts >= RETRY_LIMIT ? null : (
              <Button
                variant="outline"
                size="sm"
                data-kb-plaza-retry=""
                onClick={() => { void submit() }}
              >
                {copy.retry}
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
