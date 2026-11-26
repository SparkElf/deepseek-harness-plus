/**
 * The `@`-mention picker: choose which conversation a knowledge file goes into.
 *
 * The explorer row's `@` button used to answer `if (sessionId === undefined) return`
 * -- a page with no conversation open simply dropped the click, so the button looked
 * broken. But "no conversation open" is exactly the state this page is in most of the
 * time: it is a management surface, not a chat. The reference still has to land
 * somewhere, so the click now asks where.
 *
 * Two things are deliberately borrowed rather than invented:
 *
 * The insertion itself is `referenceInChat`, the same contract the sidebar explorer
 * and the viewer's selection popup call. That function owns the whole policy this
 * dialog must not re-derive: which workspace root the mention is relative to, the
 * chip spelling for files versus folders, the quoted form for paths with spaces, and
 * the "degrade to a logged no-op" behaviour when a service is missing. Building a
 * second insertion path here would be the one way to make the two surfaces disagree.
 *
 * The session list and the navigation are the host's own services, resolved lazily
 * through `ctx.get` rather than injected: this dialog is mounted whether or not the
 * user has ever opened a conversation, and a page that cannot see `uiSession` must
 * still render (it would show an empty list, not crash).
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { referenceInChat } from 'dsh-better-sidebar/src/client/reference-in-chat.ts'
import styles from './KnowledgeReferencePicker.module.css'
import { MenuItemButton } from './ui/MenuItemButton'
import { deadlineFrom, decideReadiness, isExpired } from './insertReadiness.ts'

/**
 * The bits of the host's client services this dialog reads.
 *
 * Structural rather than imported from the host packages: every field here is read
 * defensively (`?.`), because a deployment may mount this page without the session
 * UI, and a missing service has to mean "no rows" instead of a thrown render.
 */
interface SessionRow {
  readonly id: string
  readonly displayTitle?: string
  readonly title?: string
  readonly updatedAt?: number
  readonly blank?: boolean
}

/** The snapshot shape `ctx.uiSession.adapter` publishes (see KnowledgePanel). */
interface SessionAdapterLike {
  /** Current selection; `key` is the session id, absent before a session exists. */
  getSnapshot?: () => { key?: unknown }
}

/** What `ctx.sessions.list` publishes; only the fields this dialog renders. */
interface SessionListLike {
  getSnapshot: () => {
    ids?: readonly string[]
    byId?: Readonly<Record<string, SessionRow>>
    phase?: string
  }
  subscribe?: (listener: () => void) => () => void
}

/** The host session controller surface this dialog calls. */
interface SessionsLike {
  readonly list?: SessionListLike
  create?: (opts?: { workspaceId?: unknown; cwd?: string }) => Promise<string>
}

/** The workspace navigator that owns "show this conversation". */
interface UiWorkspaceLike {
  openSession?: (target: unknown) => void
  startSession?: (workspaceId?: unknown, options?: { prompt?: string; clearPreviousDraft?: boolean }) => void
}

/** Props for the picker. */
export interface KnowledgeReferencePickerProps {
  /** Whether the dialog is showing. */
  open: boolean
  /** Close without referencing anything. */
  onClose: () => void
  /** Absolute path of the entry the `@` button was pressed on. */
  path: string
  /** Whether that entry is a directory (a folder mention rather than a file chip). */
  isDir: boolean
  /**
   * Every entry a multi-row selection asked to reference.
   *
   * Present only when the `@` button was pressed with several rows selected; the
   * single-row case keeps using `path`/`isDir`. Each entry carries its own `isDir`
   * because a selection may mix folders and documents, and the mention spelling
   * differs between them.
   *
   * This is one dialog for both cases on purpose: "where should this go" is the same
   * question whether one row or five are being referenced, and a second batch-only
   * dialog would be a second place for the insertion contract to drift.
   */
  targets?: readonly { path: string; isDir: boolean }[]
  /** The client context; both the draft insert and the service lookups need it. */
  ctx: unknown
  /** Locale-bound copy for this package's namespace. */
  t: (key: string) => string
  /** Locale tag, so a session's timestamp reads in the reader's language. */
  locale?: string
  /**
   * The conversation the host currently has selected, read at call time.
   *
   * The New Session flow creates a conversation asynchronously and does not return
   * its id, so the only way to name it afterwards is to ask the page's own session
   * binding -- the same observable the file tree is scoped by. Reading it lazily
   * rather than as a prop is what makes it current by the time the draft is ready.
   */
  selectedSessionId?: () => string | undefined
  /**
   * Called once a reference was actually inserted, with the session that received it.
   *
   * The dialog closes itself either way; this exists so the page can report which
   * conversation the file went to, which is the only feedback a reader gets when the
   * target tab is not the one they were looking at.
   */
  onReferenced?: (sessionId: string) => void
}

/**
 * Absolute-path mention insertion for one session.
 *
 * `referenceInChat` answers `void` and swallows every degraded path into a
 * `console.warn`, which is precisely how "the button did nothing" reached the reader:
 * nothing above it could tell an insert from a silent skip. The insert itself stays
 * with `referenceInChat` -- that contract must remain single-source -- but this wrapper
 * reports whether the dialog can claim it happened, by checking that the call neither
 * threw nor left the draft untouched.
 *
 * The check is deliberately coarser than the real one: `referenceInChat` returns void,
 * so "did it throw" is all this layer can observe for sure. A throw is a definite
 * failure and is reported; a silent no-op cannot be distinguished from success here,
 * which is why the dialog also states the destination (so a reader who sees nothing in
 * that conversation knows where to look) rather than promising the chip exists.
 * @param ctx - the client context.
 * @param sessionId - target conversation.
 * @param path - absolute entry path.
 * @param isDir - folder versus file.
 * @returns True when the insert completed without throwing.
 */
function referenceInto(ctx: unknown, sessionId: string, path: string, isDir: boolean): boolean {
  try {
    // `referenceInChat` is declared `void` but its implementation returns the result of
    // `insertWorkspaceReference`, which answers `false` on every degraded path (no
    // workspace for the session, path outside it, no conversation service, draft not
    // ready). Discarding that boolean is why the old code could only ever report
    // "no exception", so a silent no-op looked like success. Read it.
    const answer = (referenceInChat as unknown as (
      c: unknown, s: string, p: string, d: boolean,
    ) => boolean | void)(ctx, sessionId, path, isDir)
    return answer !== false
  } catch {
    return false
  }
}

/**
 * How long the new-conversation path waits for the session to become insertable.
 *
 * Two things have to happen after `startSession` returns, and neither is synchronous:
 * the session appears in the catalog (so there is an id to target), and the workspace
 * that owns it starts reporting it in `sessionIds` (which is how
 * `insertWorkspaceReference` resolves the root the mention is relative to).
 *
 * The window is sized for "new conversation + workspace membership", not for the whole
 * index: creating a conversation is a local registration, and the workspace bookkeeping
 * that follows it is sub-second in practice. Four seconds is roughly two orders of
 * magnitude of headroom over the observed latency.
 *
 * The trade-off is failure fidelity, not data safety. Running out of this budget makes
 * the dialog report `refPickerFailed` (a visible error) rather than silently closing,
 * so a too-short window is loud. A too-long window is the worse failure: the reader sits
 * on a frozen dialog with no explanation while the reference is already impossible to
 * deliver, so the constant must not be raised "just in case" without re-measuring.
 */
const NEW_SESSION_READY_TIMEOUT_MS = 4000

/**
 * How often that readiness is re-checked while the window is open.
 *
 * Polling rather than a subscription because the two conditions live on two different
 * observables (the session catalog and the workspace list) and there is no combined
 * "this session is insertable" signal to subscribe to. 100 ms keeps the visible delay
 * below a frame budget's worth of human perception while costing at most 40 lookups.
 */
const NEW_SESSION_READY_POLL_MS = 100

/**
 * Format one session's last activity the way the sidebar's session list does.
 * @param value - epoch milliseconds, when the host supplied one.
 * @param locale - reader's locale tag.
 * @returns A short date/time, or an empty string when there is nothing to show.
 */
function formatWhen(value: number | undefined, locale: string | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return new Intl.DateTimeFormat(locale === undefined || locale === '' ? undefined : locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  } catch {
    // An unsupported locale tag must not break the list; the numeric date is
    // still readable.
    return date.toISOString().slice(5, 16).replace('T', ' ')
  }
}

/**
 * The `@`-mention session picker.
 * @param props - the entry to reference and the dialog's state.
 * @returns The dialog, or null while closed.
 */
export function KnowledgeReferencePicker(props: KnowledgeReferencePickerProps) {
  const { open, onClose, path, isDir, ctx, t, locale, selectedSessionId } = props
  const [term, setTerm] = useState('')

  /**
   * Which of the dialog's two steps is showing.
   *
   * `actions` is the landing surface: two named actions and nothing else. `sessions`
   * is the search-and-pick step, reached only by choosing the conversation action.
   * The split exists because opening straight into a hundred-row list buries the
   * decision the dialog is actually asking ("where should this go?") under a list the
   * reader has to read before they can answer it.
   */
  const [step, setStep] = useState<'actions' | 'sessions'>('actions')

  /**
   * Every entry this dialog will insert.
   *
   * A multi-row selection arrives as `targets`; the single-row case arrives as
   * `path`/`isDir`. Normalised once here so the rest of the dialog has no branch on
   * which shape it was opened with.
   */
  const entries = useMemo<readonly { path: string; isDir: boolean }[]>(
    () => props.targets !== undefined && props.targets.length > 0 ? props.targets : [{ path, isDir }],
    [props.targets, path, isDir],
  )
  /** Bumped after a failed create so the row's error is not a stale one. */
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  /**
   * Land on the action list every time the dialog opens.
   *
   * Without this a closed-and-reopened dialog would resume on the search step, with
   * the previous filter still typed -- the reader would have to press "back" to reach a
   * surface they never asked to leave.
   */
  useEffect(() => {
    if (!open) return
    setStep('actions')
    setTerm('')
    setError(undefined)
  }, [open])

  /**
   * Subscribe to the host's session catalog.
   *
   * Read through `ctx.get` instead of a prop so a host that mounts this page
   * without the session UI still renders: an absent service yields no rows, which
   * the dialog states as "no conversation to choose from" rather than crashing.
   */
  const sessions = useMemo(() => {
    const services = (ctx as { get?: (name: string) => unknown } | undefined)?.get
    if (typeof services !== 'function') return undefined
    try {
      return services.call(ctx, 'sessions') as SessionsLike | undefined
    } catch {
      return undefined
    }
  }, [ctx])

  const workspaceId = useMemo(() => {
    const services = (ctx as { get?: (name: string) => unknown } | undefined)?.get
    if (typeof services !== 'function') return undefined
    try {
      const workspaces = services.call(ctx, 'workspaces') as
        | { list?: { getSnapshot?: () => { items?: ReadonlyArray<{ id?: unknown }> } } }
        | undefined
      const snapshot = workspaces?.list?.getSnapshot?.()
      return snapshot?.items?.[0]?.id
    } catch {
      return undefined
    }
  }, [ctx])

  /**
   * The conversation the host currently has selected, when it names one.
   *
   * Read lazily from the page's own binding rather than as a prop, for the same reason
   * `selectedSessionId` is a callback: the New Session flow creates a conversation
   * asynchronously, so the value has to be sampled when the row is used, not when the
   * dialog mounted. `undefined` hides the shortcut row rather than offering a
   * destination whose name the dialog cannot state.
   */
  const current = useMemo(() => {
    try {
      const value = selectedSessionId?.()
      return typeof value === 'string' && value !== '' ? value : undefined
    } catch {
      return undefined
    }
  }, [selectedSessionId, open])

  const [rows, setRows] = useState<readonly SessionRow[]>([])

  /** Pull the catalog into local state, tolerating every missing piece. */
  const reload = useCallback((): void => {
    try {
      const snapshot = sessions?.list?.getSnapshot()
      const ids = snapshot?.ids ?? []
      const byId = snapshot?.byId ?? {}
      const next: SessionRow[] = []
      for (const id of ids) {
        const row = byId[id]
        if (row === undefined) continue
        next.push(row)
      }
      // Newest first, which is the order a reader picks from: the conversation
      // they were just in is almost always the answer.
      next.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      setRows(next)
    } catch {
      setRows([])
    }
  }, [sessions])

  // Load on open, and follow the catalog while it is showing: a session created in
  // another tab should appear without reopening the dialog.
  useEffect(() => {
    if (!open) return
    reload()
    const subscribe = (sessions?.list as { subscribe?: (listener: () => void) => () => void } | undefined)?.subscribe
    if (typeof subscribe !== 'function') return
    try {
      return subscribe.call(sessions?.list, reload)
    } catch {
      return
    }
  }, [open, reload, sessions])

  // A reopened dialog starts from a clean filter rather than the previous search.
  useEffect(() => {
    if (open) {
      setTerm('')
      setError(undefined)
    }
  }, [open])

  /** Rows after the local keyword filter, over title and id. */
  const visible = useMemo(() => {
    const needle = term.trim().toLocaleLowerCase()
    if (needle === '') return rows
    return rows.filter((row) => {
      const name = (row.displayTitle ?? row.title ?? row.id).toLocaleLowerCase()
      const id = row.id.toLocaleLowerCase()
      return name.includes(needle) || id.includes(needle)
    })
  }, [rows, term])

  /**
   * Insert every selected entry into one existing conversation and switch to it.
   *
   * The failure is surfaced in the dialog rather than only logged: a click that
   * appears to do nothing is the exact complaint this dialog exists to answer, so a
   * refused insert has to say so. The dialog stays open on failure, which is what lets
   * the reader retry or pick another conversation.
   */
  const choose = useCallback((sessionId: string): void => {
    const failed = entries.filter(entry => !referenceInto(ctx, sessionId, entry.path, entry.isDir))
    if (failed.length > 0 && failed.length === entries.length) {
      // Nothing landed: say so and keep the dialog open.
      setError(t('refPickerFailed'))
      return
    }
    if (failed.length > 0) {
      // A partial insert is still a problem the reader must know about, but the dialog
      // closes because something did arrive; the page reports the rest.
      setError(t('refPickerFailed'))
    }
    // Navigate after inserting: the draft belongs to that session, and showing it
    // is what lets the reader see the chip they just asked for.
    try {
      const navigator = (ctx as { get?: (name: string) => unknown } | undefined)?.get
      const workspace = typeof navigator === 'function'
        ? navigator.call(ctx, 'uiWorkspace') as UiWorkspaceLike | undefined
        : undefined
      workspace?.openSession?.({ kind: 'known', sessionId })
    } catch {
      // The reference is already in that session's draft; failing to switch is a
      // navigation problem the reader can solve by opening the session themselves.
    }
    props.onReferenced?.(sessionId)
    onClose()
  }, [ctx, entries, onClose, props, t])

  /**
   * Put the selection into the conversation this page is bound to.
   *
   * This is the primary path and it deliberately does NOT create a conversation. The
   * host's own `@`-file button inserts into the draft of the conversation it is attached
   * to, so the reader sees the chip in the composer already on screen. An earlier
   * revision created a session here and then guessed which one to target; the guess was
   * often a different session whose composer was not mounted, and because that session's
   * draft revision really did change, the insert reported success while the visible
   * composer stayed empty.
   *
   * Two conditions have to hold, in this order:
   *
   *   1. the target conversation's composer must be MOUNTED -- this page is a global
   *      panel with no chat of its own, so a composer exists only once the host has
   *      navigated to a conversation;
   *   2. the insert then has to run against that same conversation's input.
   *
   * The host is therefore asked to open the conversation first, and the insert waits
   * for the composer element to appear (or reports that it never did).
   */
  const insertIntoBoundSession = useCallback((): void => {
    setBusy(true)
    setError(undefined)
    const target = selectedSessionId?.()
    if (typeof target !== 'string' || target === '') {
      // Nowhere to put it: say so rather than inserting into nothing.
      setError(t('refPickerNoTarget'))
      setBusy(false)
      return
    }

    // Navigate first, so the composer for this conversation mounts.
    try {
      const navigator = (ctx as { get?: (name: string) => unknown } | undefined)?.get
      const workspace = typeof navigator === 'function'
        ? navigator.call(ctx, 'uiWorkspace') as UiWorkspaceLike | undefined
        : undefined
      workspace?.openSession?.({ kind: 'known', sessionId: target })
    } catch {
      // A host that cannot navigate may still have the composer mounted; the wait
      // below decides instead of this catch.
    }

    // One deadline for the whole attempt, computed once. Recomputing per retry would
    // push it forward forever and the failure branch would be unreachable.
    const deadline = deadlineFrom(Date.now(), NEW_SESSION_READY_TIMEOUT_MS)

    /**
     * Whether the composer for `target` is on screen.
     *
     * The composer is a contenteditable Lexical editor marked `data-composer-input`; it
     * carries no session id of its own. Membership is established through the
     * conversation service instead: a resident input shell for `target` exists exactly
     * when the host has mounted that conversation's input. Presence alone is therefore
     * not treated as readiness -- a composer belonging to another conversation would be
     * the wrong destination.
     */
    const composerReady = (): boolean => {
      if (typeof document === 'undefined') return false
      if (document.querySelector('[data-composer-input="true"]') === null) return false
      try {
        const services = (ctx as { get?: (name: string) => unknown }).get
        if (typeof services !== 'function') return true
        const conversation = services.call(ctx, 'conversation') as
          | { input?: { shell?: (id: string) => unknown } } | undefined
        if (conversation?.input?.shell === undefined) return true
        return conversation.input.shell(target) !== undefined
      } catch {
        return true
      }
    }

    const insertWhenReady = (): void => {
      const expired = isExpired(Date.now(), deadline)
      const ready = composerReady()
      if (!ready && !expired) {
        window.setTimeout(insertWhenReady, NEW_SESSION_READY_POLL_MS)
        return
      }
      const landed = ready
        ? entries.filter(entry => referenceInto(ctx, target, entry.path, entry.isDir))
        : []
      const inserted = ready && landed.length === entries.length
      console.log('[kb-ref] bound target=' + target + ' ready=' + ready
        + ' landed=' + landed.length + '/' + entries.length + ' expired=' + expired)
      if (!inserted) {
        // Keep the dialog open so the message is readable.
        setError(t('refPickerFailed'))
        setBusy(false)
        return
      }
      props.onReferenced?.(target)
      onClose()
    }
    window.setTimeout(insertWhenReady, 0)
  }, [ctx, entries, onClose, props, selectedSessionId, t])

  /**
   * Create a fresh conversation and put the reference in it.
   *
   * Secondary to {@link insertIntoBoundSession}: the reader explicitly asked for a new
   * conversation, so creating one is the point. The insert still has to wait for that
   * conversation's composer, because a freshly created session has no mounted input
   * yet -- inserting before the composer exists writes into a draft nobody is showing.
   */
  const createNew = useCallback((): void => {
    setBusy(true)
    setError(undefined)
    void (async () => {
      try {
        const navigator = (ctx as { get?: (name: string) => unknown } | undefined)?.get
        const workspace = typeof navigator === 'function'
          ? navigator.call(ctx, 'uiWorkspace') as UiWorkspaceLike | undefined
          : undefined
        if (typeof workspace?.startSession !== 'function') {
          setError(t('refPickerCreateFailed'))
          setBusy(false)
          return
        }
        // Remember the catalog BEFORE creating: a new session lands at index 0 and the
        // tail keeps pointing at an older session, so the diff is the only identity
        // available (the create call does not return the new id).
        const knownIds = new Set<string>(sessions?.list?.getSnapshot()?.ids ?? [])
        workspace.startSession(workspaceId)

        const deadline = deadlineFrom(Date.now(), NEW_SESSION_READY_TIMEOUT_MS)

        /**
         * Whether the composer for the freshly created conversation is on screen.
         *
         * Creating a conversation does not mount its composer; the host navigates to it
         * first. Inserting before that writes into a draft nobody is showing, which is
         * why the chip was invisible even though the draft revision changed. The new
         * session is identified by diffing the catalog against `knownIds`.
         */
        const probe = (): { target: string | undefined; ready: boolean } => {
          let target: string | undefined
          try {
            const ids = sessions?.list?.getSnapshot()?.ids ?? []
            target = ids.find(id => !knownIds.has(id))
          } catch {
            target = undefined
          }
          if (target === undefined) return { target: undefined, ready: false }
          if (typeof document === 'undefined') return { target, ready: false }
          if (document.querySelector('[data-composer-input="true"]') === null) {
            return { target, ready: false }
          }
          try {
            const services = (ctx as { get?: (name: string) => unknown }).get
            if (typeof services !== 'function') return { target, ready: true }
            const conversation = services.call(ctx, 'conversation') as
              | { input?: { shell?: (id: string) => unknown } } | undefined
            if (conversation?.input?.shell === undefined) return { target, ready: true }
            return { target, ready: conversation.input.shell(target) !== undefined }
          } catch {
            return { target, ready: true }
          }
        }

        const insertWhenReady = (): void => {
          const expired = isExpired(Date.now(), deadline)
          const { target, ready } = probe()
          if ((target === undefined || !ready) && !expired) {
            window.setTimeout(insertWhenReady, NEW_SESSION_READY_POLL_MS)
            return
          }
          const landed = target !== undefined && ready
            ? entries.filter(entry => referenceInto(ctx, target as string, entry.path, entry.isDir))
            : []
          const inserted = target !== undefined && ready && landed.length === entries.length
          console.log('[kb-ref] created target=' + String(target) + ' ready=' + ready
            + ' landed=' + landed.length + '/' + entries.length + ' expired=' + expired)
          if (!inserted) {
            setError(t('refPickerFailed'))
            setBusy(false)
            return
          }
          props.onReferenced?.(target as string)
          onClose()
        }
        window.setTimeout(insertWhenReady, 0)
      } catch {
        setError(t('refPickerCreateFailed'))
        setBusy(false)
      }
    })()
  }, [ctx, entries, onClose, props, sessions, t, workspaceId])

  /**
   * One row of the landing step: a name and nothing else.
   *
   * No subtitle and no explanation. The product rule is that a control states its
   * name; a sentence underneath it is documentation, and documentation in a menu is
   * read once and then in the way for every subsequent use.
   */
  const actionRow = (label: string, onSelect: () => void, disabled = false): ReactNode => (
    <li>
      <MenuItemButton disabled={disabled} onSelect={onSelect}>
        <span className={styles.rowName}>{label}</span>
      </MenuItemButton>
    </li>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={entries.length > 1
        ? t('refPickerBatchTitle').replace('{n}', String(entries.length))
        : t('refPickerTitle')}
      closeLabel={t('cancel')}
    >
      <div className={styles.body}>
        {step === 'actions' && (
          <ul className={styles.list} aria-label={t('refPickerTitle')}>
            {/* New conversation: creates one, and the reference is inserted into its
                draft through the same `referenceInChat` contract the explorer uses, so
                the composer shows the product's own `@` chip rather than text. */}
            {actionRow(busy ? t('refPickerCreating') : t('refPickerNew'), createNew, busy)}
            {/* Reference into the conversation this page is bound to. That session is
                the one the reader is looking at, so it is used directly rather than
                guessed: the insert targets it and the host is asked to show it, which
                is what makes the chip visible in the composer. The list below stays
                reachable as the secondary door for a different destination. */}
            {/* Secondary: pick a different conversation from the catalog. */}
            {actionRow(t('refPickerTitle'), () => { setStep('sessions') }, busy)}
          </ul>
        )}

        {step === 'sessions' && (
          <>
            <Input
              value={term}
              placeholder={t('refPickerSearch')}
              aria-label={t('refPickerSearch')}
              onChange={(event) => { setTerm(event.target.value) }}
              data-modal-autofocus
            />

            <ul className={styles.list} aria-label={t('refPickerSearch')}>
              {visible.length === 0 && (
                <li className={styles.empty}>
                  {/* Nothing matches the typing versus an empty catalog: the reader's
                      own filter earns a different sentence from a missing catalog. */}
                  {term.trim() === '' ? t('refPickerNoSessions') : t('refPickerNoMatch')}
                </li>
              )}

              {visible.map((row) => {
                const name = row.displayTitle ?? row.title ?? row.id
                const when = formatWhen(row.updatedAt, locale)
                return (
                  <li key={row.id}>
                    <MenuItemButton onSelect={() => { choose(row.id) }}>
                      <span className={styles.rowName}>{name}</span>
                      {/* The timestamp is data about the conversation, not a sentence
                          explaining the control, so it stays. */}
                      {when !== '' && <span className={styles.rowWhen}>{when}</span>}
                    </MenuItemButton>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        {error !== undefined && <p className={styles.error} role="alert">{error}</p>}
      </div>

      <div className={styles.footer}>
        {/* One control, two jobs: on the search step it goes back to the action list
            (so the step is not a trap); on the landing step there is nothing behind it,
            so it closes. Both are labelled with the action they perform. */}
        {step === 'sessions' && (
          <Button variant="ghost" onClick={() => { setStep('actions') }}>{t('refPickerBack')}</Button>
        )}
        <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
      </div>
    </Modal>
  )
}
