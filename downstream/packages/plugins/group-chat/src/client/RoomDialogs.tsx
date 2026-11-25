/**
 * The three per-room dialogs: invite, members, and settings.
 *
 * They share one module because they are one interaction family — each is opened from a
 * room row's context menu, each operates on exactly one room, and each writes through the
 * same store. Splitting them would triple the plumbing without separating anything.
 *
 * The settings dialog carries the required notice: its three switches change where a room
 * appears, not who may reach it. The server enforces permissions; these are preferences.
 *
 * @module @sparkelf/dsh-group-chat/client/RoomDialogs
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  Button,
  IconCheckOutlineRegular,
  IconLoadingOutlineRegular,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  inviteMembers,
  listMembers,
  searchInviteCandidates,
  updateRoom,
  type InviteCandidate,
  type RoomMember,
} from './api.ts'
import { Avatar } from './Avatar.tsx'
import { filterCandidates, isChosen, toggleChosen } from './rows.ts'
import { failureOf, type RoomStore } from './store.ts'
import type { GroupChatKey } from './locales.ts'
import styles from './CreateRoomDialog.module.css'
import invite from './InviteDialog.module.css'

export interface RoomDialogsProps {
  readonly t: (key: GroupChatKey) => string
  readonly store: RoomStore
}

/**
 * Render whichever room dialog is open.
 * @param props - the copy resolver and the store holding the open dialog.
 * @returns the dialog, or null when none is open.
 */
export function RoomDialogs(props: RoomDialogsProps) {
  const { t, store } = props
  const dialog = store.getState().dialog
  if (dialog === undefined) return null
  const close = (): void => store.setDialog(undefined)
  if (dialog.kind === 'invite') {
    return <InviteDialog t={t} store={store} roomId={dialog.roomId} onClose={close} />
  }
  if (dialog.kind === 'settings') {
    return <SettingsDialog t={t} store={store} roomId={dialog.roomId} onClose={close} />
  }
  if (dialog.kind === 'transfer') {
    return <TransferDialog t={t} store={store} roomId={dialog.roomId} onClose={close} />
  }
  return <MembersDialog t={t} roomId={dialog.roomId} onClose={close} />
}

/**
 * Add existing DataOps accounts to a room.
 *
 * The list is multi-select rather than one-pick-at-a-time: a room is usually started with
 * several colleagues, and a dialog that closed after each person made that a repeated
 * errand. Rows are native buttons with `aria-pressed`, so Tab, Enter and Space all work and
 * a screen reader hears the selected state; ↑/↓ move between rows without leaving the list.
 *
 * What is selected lives in `chosen` and not in the search result rows. A query can hide an
 * already-picked person — the server search returns only what matches — and keeping the two
 * separate is what stops the selection from silently emptying as the operator narrows the
 * list.
 */
function InviteDialog(props: {
  t: (key: GroupChatKey) => string
  store: RoomStore
  roomId: string
  onClose: () => void
}) {
  const { t, store, roomId, onClose } = props
  const [candidates, setCandidates] = useState<readonly InviteCandidate[]>([])
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<readonly InviteCandidate[]>([])
  const [searching, setSearching] = useState(true)
  const [busy, setBusy] = useState(false)
  const [searchError, setSearchError] = useState<GroupChatKey | undefined>(undefined)
  const [submitError, setSubmitError] = useState<GroupChatKey | undefined>(undefined)
  const [done, setDone] = useState(false)
  // Bumped by Retry. The query itself may not change, so the effect needs a dependency that
  // still re-runs the same read.
  const [attempt, setAttempt] = useState(0)
  const listRef = useRef<HTMLUListElement | null>(null)

  // Typing re-runs the search on a pause, so a name typed at speed is one request rather
  // than one per letter. An empty query is a real query — it is what fills the list before
  // anything has been typed.
  useEffect(() => {
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const next = await searchInviteCandidates(roomId, query)
          if (!cancelled) {
            setCandidates(next)
            setSearchError(undefined)
          }
        } catch (cause) {
          if (!cancelled) setSearchError(failureOf(cause))
        } finally {
          if (!cancelled) setSearching(false)
        }
      })()
    }, 220)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [roomId, query, attempt])

  const toggle = (candidate: InviteCandidate): void => {
    setDone(false)
    setSubmitError(undefined)
    setChosen((current) => toggleChosen(current, candidate))
  }

  const submit = async (): Promise<void> => {
    if (chosen.length === 0 || busy) return
    setBusy(true)
    setSubmitError(undefined)
    try {
      await inviteMembers(roomId, chosen.map((member) => member.userId))
      await store.refresh()
      setChosen([])
      setDone(true)
      // The people just invited are members now and must drop out of the candidates. Clearing
      // the query re-runs the read; when it was already empty, the attempt counter does.
      if (query.length === 0) setAttempt((current) => current + 1)
      else setQuery('')
    } catch (cause) {
      setSubmitError(failureOf(cause))
    } finally {
      setBusy(false)
    }
  }

  // Arrow keys walk the rows the way a listbox does; without this, reaching the tenth
  // candidate means ten Tabs. Enter and Space already toggle, because each row is a button.
  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-candidate]') ?? [])]
    if (rows.length === 0) return
    event.preventDefault()
    const index = rows.indexOf(document.activeElement as HTMLButtonElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next = index < 0 ? 0 : (index + step + rows.length) % rows.length
    rows[next]?.focus()
  }

  const moveToList = (): void => {
    listRef.current?.querySelector<HTMLButtonElement>('button[data-candidate]')?.focus()
  }

  // The narrowing is applied here as well as at the server, so the list answers a keystroke
  // on the same frame rather than one debounce later. The server's answer replaces these
  // rows when it arrives.
  const visible = filterCandidates(candidates, query)

  return (
    <Modal
      open
      onClose={onClose}
      title={t('inviteTitle')}
      closeLabel={t('cancel')}
      className={invite.dialog}
      contentClassName={invite.content}
      footer={(
        <div className={styles.footer}>
          <Button variant="ghost" size="md" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" size="md" disabled={busy || chosen.length === 0}
                  onClick={() => void submit()}>
            {chosen.length === 0
              ? t('inviteSubmit')
              : t('inviteSubmitCount').replace('{count}', String(chosen.length))}
          </Button>
        </div>
      )}
    >
      <div className={styles.body}>
        {/* Search and its helper text are one field, the same grouping the create dialog
            uses for the fields it shares this stylesheet with. */}
        <div className={invite.field}>
          <div className={invite.searchRow}>
            <Input
              className={invite.search}
              value={query}
              data-modal-autofocus
              placeholder={t('invitePlaceholder')}
              aria-label={t('inviteSearchLabel')}
              onChange={(event) => { setQuery(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown') return
                event.preventDefault()
                moveToList()
              }}
            />
            {searching && <IconLoadingOutlineRegular className={invite.spinner} size={14} />}
          </div>
          <span className={styles.hint}>{t('inviteHint')}</span>
        </div>

        {/* A live region mounted from the first render: a status element that appears
            together with its text is not reliably announced, and the count changing is
            exactly what a screen-reader user needs to hear after each toggle. */}
        <span className={invite.visuallyHidden} role="status">
          {chosen.length === 0
            ? ''
            : t('inviteSelectedCount').replace('{count}', String(chosen.length))}
        </span>

        {/* The chips are the durable answer to "who am I about to invite": they survive a
            narrowed list and name everyone, rather than leaving that to a count alone. */}
        {chosen.length > 0 && (
          <div className={styles.field}>
            <span className={styles.label}>
              {t('inviteSelectedCount').replace('{count}', String(chosen.length))}
            </span>
            <ul className={invite.chips}>
              {chosen.map((member) => (
                <li key={member.userId} className={invite.chip}>
                  {/* The chip already says the name, so the picture's own label would
                      repeat it in the row's accessible name. */}
                  <span aria-hidden="true">
                    <Avatar name={member.displayName || member.username}
                            src={member.avatarUrl} size="sm" />
                  </span>
                  <span className={invite.chipName}>{member.displayName || member.username}</span>
                  <button
                    type="button"
                    className={invite.chipRemove}
                    aria-label={`${t('inviteRemove')} ${member.displayName || member.username}`}
                    onClick={() => {
                      setChosen((current) => current.filter((row) => row.userId !== member.userId))
                    }}
                  >×</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* One region, four states: a failed read with its retry, a read in flight, an answer
            with rows, and an answer with none. The panel keeps its place across all four so
            the dialog does not change height as the operator types. */}
        {searchError !== undefined && !searching ? (
          <div className={invite.errorRow}>
            <span className={invite.error}>{t(searchError)}</span>
            <Button size="sm" variant="ghost" onClick={() => { setAttempt((current) => current + 1) }}>
              {t('retry')}
            </Button>
          </div>
        ) : searching && visible.length === 0 ? (
          <p className={invite.note}>{t('inviteSearching')}</p>
        ) : visible.length === 0 ? (
          <p className={invite.note}>{t('inviteEmpty')}</p>
        ) : (
          <ul ref={listRef} className={invite.list} onKeyDown={onListKeyDown}>
            {visible.map((candidate) => {
              const selected = isChosen(chosen, candidate.userId)
              const name = candidate.displayName.length > 0 ? candidate.displayName : candidate.username
              return (
                <li key={candidate.userId}>
                  <button
                    type="button"
                    data-candidate
                    className={selected ? invite.rowSelected : invite.row}
                    aria-pressed={selected}
                    onClick={() => { toggle(candidate) }}
                  >
                    {/* The row's name is already its text; hiding the picture's label
                        keeps the button's accessible name from saying it twice. */}
                    <span aria-hidden="true">
                      <Avatar name={name} src={candidate.avatarUrl} size="sm" />
                    </span>
                    <span className={invite.rowName}>{name}</span>
                    <span className={invite.rowHandle}>{candidate.username}</span>
                    {/* Held in the layout even when unselected, so a pick does not shift
                        the name towards the handle. */}
                    <span className={selected ? invite.check : invite.checkHidden} aria-hidden="true">
                      <IconCheckOutlineRegular size={14} />
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {done && <p className={styles.hint}>{t('saved')}</p>}
        {submitError !== undefined && <p className={invite.error}>{t(submitError)}</p>}
      </div>
    </Modal>
  )
}

/** List a room's members. */
function MembersDialog(props: {
  t: (key: GroupChatKey) => string
  roomId: string
  onClose: () => void
}) {
  const { t, roomId, onClose } = props
  const [members, setMembers] = useState<readonly RoomMember[] | undefined>(undefined)
  const [error, setError] = useState<GroupChatKey | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const next = await listMembers(roomId)
        if (!cancelled) setMembers(next)
      } catch (cause) {
        if (!cancelled) setError(failureOf(cause))
      }
    })()
    return () => { cancelled = true }
  }, [roomId])

  return (
    <Modal open onClose={onClose} title={t('membersTitle')} closeLabel={t('cancel')}
           footer={<div className={styles.footer}><Button variant="ghost" size="md" onClick={onClose}>{t('cancel')}</Button></div>}>
      <div className={styles.body}>
        {error !== undefined && <p className={styles.error}>{t(error)}</p>}
        {error === undefined && members === undefined && <p className={styles.hint}>{t('loading')}</p>}
        {members !== undefined && (
          <ul className={styles.memberList}>
            {members.map((member) => (
              <li key={member.userId} className={styles.memberRow}>
                <Avatar name={member.displayName} src={member.avatarUrl} />
                <span className={styles.memberName}>{member.displayName}</span>
                {member.owner && <span className={styles.memberBadge}>{t('ownerBadge')}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}

/** The room's three policy dimensions. */
/**
 * Hand ownership of this room to another member.
 *
 * Exists because an owner cannot leave: a room without an owner has nobody who may change its
 * settings, so the server refuses the leave. Transferring is that way out, and this dialog is
 * where the owner names the successor.
 *
 * Only current members are offered, and the owner is excluded — the server rejects both a
 * non-member and a self-transfer, so listing them would only invite a refusal.
 */
function TransferDialog(props: {
  t: (key: GroupChatKey) => string
  store: RoomStore
  roomId: string
  onClose: () => void
}) {
  const { t, store, roomId, onClose } = props
  const room = store.getState().rooms?.find((candidate) => candidate.id === roomId)
  const [members, setMembers] = useState<readonly RoomMember[] | undefined>(undefined)
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<GroupChatKey | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void listMembers(roomId)
      .then((rows) => { if (!cancelled) setMembers(rows) })
      .catch(() => { if (!cancelled) setMembers([]) })
    return () => { cancelled = true }
  }, [roomId])

  const candidates = (members ?? []).filter((member) => member.userId !== store.selfId())

  const submit = async (): Promise<void> => {
    if (busy || chosen === undefined) return
    setBusy(true)
    setFailure(undefined)
    try {
      await store.transfer(roomId, chosen)
      onClose()
    } catch (cause) {
      setFailure(failureOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t('menuTransferTitle')}
      closeLabel={t('cancel')}
      footer={(
        <div className={styles.footer}>
          <Button variant="ghost" size="md" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" size="md" disabled={busy || chosen === undefined}
                  onClick={() => void submit()}>
            {t('menuTransferConfirm')}
          </Button>
        </div>
      )}
    >
      <div className={invite.content}>
        <p className={invite.note}>{t('menuTransferHint')}</p>
        {room !== undefined && <p className={invite.note}>{room.name}</p>}
        {members === undefined && <p className={invite.note}>…</p>}
        {members !== undefined && candidates.length === 0 && (
          <p className={invite.note}>{t('menuTransferEmpty')}</p>
        )}
        {candidates.length > 0 && (
          <ul className={invite.list} role="listbox" aria-label={t('menuTransferTitle')}>
            {candidates.map((member) => (
              <li key={member.userId}>
                <button type="button" role="option"
                        aria-selected={chosen === member.userId}
                        className={chosen === member.userId ? invite.rowSelected : invite.row}
                        onClick={() => setChosen(member.userId)}>
                  <Avatar size="sm" name={member.displayName} src={member.avatarUrl ?? undefined} />
                  <span className={invite.rowName}>{member.displayName}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {failure !== undefined && <p className={invite.error} role="alert">{t(failure)}</p>}
      </div>
    </Modal>
  )
}

function SettingsDialog(props: {
  t: (key: GroupChatKey) => string
  store: RoomStore
  roomId: string
  onClose: () => void
}) {
  const { t, store, roomId, onClose } = props
  const room = store.getState().rooms?.find((candidate) => candidate.id === roomId)
  const [invitePolicy, setInvitePolicy] = useState(room?.invitePolicy ?? 'anyone')
  const [discoverability, setDiscoverability] = useState(room?.discoverability ?? 'discoverable')
  const [agentTrigger, setAgentTrigger] = useState(room?.agentTrigger ?? 'mention')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<GroupChatKey | undefined>(undefined)

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await updateRoom(roomId, { invitePolicy, discoverability, agentTrigger })
      await store.refresh()
      onClose()
    } catch (cause) {
      setError(failureOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('settingsTitle')}
      closeLabel={t('cancel')}
      footer={(
        <div className={styles.footer}>
          <Button variant="ghost" size="md" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" size="md" disabled={busy} onClick={() => void save()}>
            {t('save')}
          </Button>
        </div>
      )}
    >
      <div className={styles.body}>
        {/* Three switches, each a distinct control point: who may invite, who can find the
            room, and whether the agent answers. */}
        <div className={styles.switches}>
          <PolicyRow t={t} label={t('createPolicy')}
                     value={invitePolicy === 'anyone'} onChange={(next) => setInvitePolicy(next ? 'anyone' : 'admin')}
                     onLabel={t('policyAnyone')} offLabel={t('policyAdmin')} />
          <PolicyRow t={t} label={t('createVisibility')}
                     value={discoverability === 'discoverable'} onChange={(next) => setDiscoverability(next ? 'discoverable' : 'invite_only')}
                     onLabel={t('discoverable')} offLabel={t('inviteOnly')} />
        </div>
        <div className={styles.switches} style={{ borderTop: 'none', paddingTop: 0 }}>
          <span className={styles.label}>{t('createTrigger')}</span>
          <div className={styles.triggerExtra}>
            {(['mention', 'always', 'never'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={agentTrigger === mode ? styles.pillActive : styles.pill}
                onClick={() => setAgentTrigger(mode)}
              >
                {mode === 'mention' ? t('triggerMention') : mode === 'always' ? t('triggerAlways') : t('triggerNever')}
              </button>
            ))}
          </div>
        </div>
        <p className={styles.notice}>{t('createNotice')}</p>
        {error !== undefined && <p className={styles.error}>{t(error)}</p>}
      </div>
    </Modal>
  )
}

/** One two-state policy row, labelled with what each side means. */
function PolicyRow(props: {
  t: (key: GroupChatKey) => string
  label: string
  value: boolean
  onChange: (next: boolean) => void
  onLabel: string
  offLabel: string
}) {
  const { label, value, onChange, onLabel, offLabel } = props
  return (
    <div className={styles.policyRow}>
      <span className={styles.label}>{label}</span>
      <div className={styles.triggerExtra}>
        <button type="button" className={value ? styles.pillActive : styles.pill}
                onClick={() => onChange(true)}>{onLabel}</button>
        <button type="button" className={!value ? styles.pillActive : styles.pill}
                onClick={() => onChange(false)}>{offLabel}</button>
      </div>
    </div>
  )
}
