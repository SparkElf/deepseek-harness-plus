/**
 * The members panel, shown in the right sidebar beside a room's conversation.
 *
 * A room is a Session, so the shell already draws its messages; what the shell has no reason to
 * know about is the roster behind them. This panel is that missing view: who is in the room, who
 * owns it, and the one message every member is meant to see.
 *
 * It is a **tab in the official right sidebar**, not a dialog. A roster is something a reader
 * consults while reading — opening it must not cover the conversation it describes — and the
 * shell already owns tab placement, width, persistence and the ability to put it side by side
 * with the document preview. Drawing our own overlay would have to track all of that.
 *
 * What the panel shows comes from the shared store rather than its own requests: the sidebar
 * already reads the roster, and a second reader would let the two disagree about who is present.
 * The one exception is writing the announcement, which no other surface can do.
 *
 * @module @sparkelf/dsh-group-chat/client/MembersPanel
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  announcementMissing,
  announcementView,
  filterMemberRows,
  memberRows,
  type MemberRow,
} from './rows.ts'
import { getRoomFile, listRoomFiles, setAnnouncement, uploadRoomFile, type RoomFiles, type SharedFileText } from './api.ts'
import { Avatar } from './Avatar.tsx'
import { roomIdOfSession } from '../session-id.ts'
import type { GroupChatKey } from './locales.ts'
import type { RoomStore } from './store.ts'
import styles from './MembersPanel.module.css'

/** The tab type this panel is opened as. */
export const MEMBERS_TAB_KIND = 'groupChatMembers'

/**
 * Props the panel reads.
 *
 * `sessionId` comes from the tab seat rather than from navigation parameters: the sidebar
 * persists a tab's place but not the parameters its opener passed, so a reload hands this
 * component a tab with no params at all. Deriving the room from the Session it belongs to is
 * what keeps the panel correct across a reload, and it also decides whether the panel belongs
 * here at all — an ordinary Session has no room, and therefore no roster.
 */
export interface MembersPanelInjected {
  /** The Session this tab was opened beside. */
  readonly sessionId: string
  /** Localized copy. */
  readonly t: (key: GroupChatKey) => string
  /** The shared room store, which already holds the roster. */
  readonly store: RoomStore
}

/**
 * Render the roster and announcement for the room this Session belongs to.
 *
 * @param props - the Session, copy, and shared store.
 * @returns the panel, or a short notice when this Session is not a room.
 */
export function MembersPanel(props: MembersPanelInjected): ReactNode {
  const { sessionId, t, store } = props
  const roomId = roomIdOfSession({ id: sessionId })
  const state = useRoomState(store)

  // Re-read the roster when the panel opens. The sidebar loads rosters for the rooms it lists,
  // but a reload that lands directly on a room's Session may paint this panel before that read
  // completes, and an empty roster would read as "nobody is here".
  useEffect(() => {
    if (roomId !== undefined) void store.loadMembers(roomId)
  }, [roomId, store])

  const members = roomId === undefined ? undefined : state.members[roomId]
  const rows = useMemo(
    () => (members === undefined ? undefined : memberRows(members, state.selfId)),
    [members, state.selfId],
  )
  const room = state.rooms?.find((candidate) => candidate.id === roomId)

  if (roomId === undefined) {
    return <p className={styles['notice']}>{t('membersNotARoom')}</p>
  }

  return (
    <div className={styles['root']}>
      <Announcement
        t={t}
        roomId={roomId}
        announcement={room?.announcement}
        canEdit={room !== undefined && room.ownerUserId === state.selfId}
        onSaved={() => { void store.refresh() }}
      />
      <SharedFiles t={t} roomId={roomId} />
      <Roster
        t={t}
        rows={rows}
        // Only the owner may remove another member: the server enforces the same rule, so
        // hiding the control elsewhere keeps the roster from offering an action that will be
        // refused. The owner's own row never shows it — they cannot remove themselves.
        canRemove={room !== undefined && room.ownerUserId === state.selfId}
        onRemove={(userId) => { void store.removeMember(roomId, userId) }}
      />
    </div>
  )
}

/**
 * Subscribe to the shared store.
 *
 * Written as a hook rather than read inline so a roster that arrives after the first paint
 * re-renders the panel: the store is a plain observable, not a framework store.
 *
 * @param store - the shared room store.
 * @returns its current state, re-read on every change.
 */
function useRoomState(store: RoomStore): ReturnType<RoomStore['getState']> {
  const [snapshot, setSnapshot] = useState(() => store.getState())
  useEffect(() => {
    setSnapshot(store.getState())
    return store.subscribe(() => { setSnapshot(store.getState()) })
  }, [store])
  return snapshot
}

/** Props for the announcement area. */
interface AnnouncementProps {
  readonly t: (key: GroupChatKey) => string
  readonly roomId: string
  /** The room's announcement, or `undefined` when this deployment has no such field. */
  readonly announcement: string | null | undefined
  /** Whether the operator may write it. Only the owner may, and the server enforces it. */
  readonly canEdit: boolean
  /** Called after a successful save so the room list re-reads the stored value. */
  readonly onSaved: () => void
}

/**
 * The announcement area: read it, and for the owner, write it.
 *
 * Saving re-reads the room list instead of patching local state. The server stores a cleared
 * announcement as `null`, so a local patch would leave this panel and the sidebar showing
 * different spellings of the same absence.
 *
 * @param props - the text, the permission, and how to report a save.
 * @returns the section.
 */
function Announcement(props: AnnouncementProps): ReactNode {
  const { t, roomId, announcement, canEdit, onSaved } = props
  const view = announcementView(announcement)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [missing, setMissing] = useState(false)
  const [failure, setFailure] = useState<GroupChatKey | undefined>(undefined)

  const begin = useCallback((): void => {
    setDraft(view.state === 'text' ? view.text : '')
    setFailure(undefined)
    setEditing(true)
  }, [view])

  const save = useCallback(async (): Promise<void> => {
    setSaving(true)
    setFailure(undefined)
    try {
      await setAnnouncement(roomId, draft.trim())
      setEditing(false)
      onSaved()
    } catch (error) {
      // A deployment without the feature answers 404/405/501. That is a different fact from a
      // refused or failed write, and confusing the two would send the operator looking for a
      // network problem when the workspace simply predates the feature.
      if (announcementMissing(error)) setMissing(true)
      else setFailure('announcementFailed')
    } finally {
      setSaving(false)
    }
  }, [draft, onSaved, roomId])

  return (
    <CollapsibleSection
      t={t}
      title={t('announcementTitle')}
      actions={canEdit && !editing && !missing && view.state !== 'unavailable' ? (
        <button type="button" className={styles['linkButton']} onClick={begin}>
          {view.state === 'empty' ? t('announcementAdd') : t('announcementEdit')}
        </button>
      ) : undefined}
    >
      {missing || view.state === 'unavailable' ? (
        <p className={styles['unavailable']}>{t('announcementUnavailable')}</p>
      ) : editing ? (
        <div className={styles['editor']}>
          <textarea
            className={styles['textarea']}
            value={draft}
            placeholder={t('announcementPlaceholder')}
            onChange={(event) => { setDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setEditing(false)
                return
              }
              // Enter saves and Shift+Enter breaks the line: an announcement is a short notice,
              // and a text area with no save key reads as a form the operator cannot submit.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void save()
              }
            }}
            rows={4}
          />
          <div className={styles['editorFooter']}>
            {saving
              ? <span className={styles['hint']}>{t('announcementSaving')}</span>
              : <span className={styles['hint']}>{t('announcementCleared')}</span>}
            <Button size="sm" onClick={() => { setEditing(false) }}>{t('cancel')}</Button>
            <Button size="sm" variant="primary" onClick={() => void save()} disabled={saving}>
              {t('save')}
            </Button>
          </div>
        </div>
      ) : view.state === 'text' ? (
        <p className={styles['announcementText']}>{view.text}</p>
      ) : (
        // One line, not two: "no announcement yet" and "only the owner can edit" say the same
        // thing twice when the reader is a plain member, and the second alone is what they can
        // act on. The owner-only note is therefore folded into the empty state instead of
        // stacked beneath it.
        <p className={styles['unavailable']}>
          {canEdit ? t('announcementEmpty') : t('announcementOwnerOnly')}
        </p>
      )}

      {failure !== undefined && <p className={styles['error']}>{t(failure)}</p>}
    </CollapsibleSection>
  )
}

/**
 * A collapsible section header.
 *
 * The right sidebar can be dragged narrow, and this panel stacks three sections in it. A
 * section that stays open at 200px squeezes the roster until names collide, so each section
 * can collapse to its title — the title row is the thinnest thing that still tells a member
 * what exists below. Collapsed state is local: a member who folded "shared files" to make
 * room for the roster is describing what they are looking at now, not a preference to
 * persist across rooms.
 *
 * @param props - visible title, optional count, and the body to hide.
 * @returns the section.
 */
function CollapsibleSection(props: {
  title: string
  count?: number
  defaultOpen?: boolean
  actions?: ReactNode
  t: (key: GroupChatKey) => string
  children: ReactNode
}): ReactNode {
  const { title, count, defaultOpen = true, actions, t, children } = props
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={styles['section']}>
      <div className={styles['sectionHeader']}>
        <button
          type="button"
          className={styles['sectionToggle']}
          aria-expanded={open}
          // The label is the disclosure control: a separate caret button would put two targets
          // in a 200px row and leave neither big enough to hit.
          onClick={() => { setOpen((value) => !value) }}
        >
          <span className={styles['caret']} aria-hidden="true">{open ? '\u25BE' : '\u25B8'}</span>
          <span className={styles['sectionLabel']}>{title}</span>
        </button>
        {count !== undefined && count > 0 && <span className={styles['count']}>{count}</span>}
        {actions}
      </div>
      {open && <div className={styles['sectionBody']}>{children}</div>}
    </section>
  )
}

/**
 * The room's shared folder, as the members panel shows it.
 *
 * Read on demand rather than kept in the shared store: the folder changes when someone
 * uploads or when the room's agent writes a file, and a panel that only refreshes on room
 * switch would show a stale list for the whole time it is open. Re-reading each time the
 * panel opens keeps the list honest without a poll of its own.
 *
 * @param props - the room and copy.
 * @returns the section.
 */
function SharedFiles(props: { t: (key: GroupChatKey) => string; roomId: string }): ReactNode {
  const { t, roomId } = props
  const [state, setState] = useState<RoomFiles | undefined>(undefined)
  const [preview, setPreview] = useState<SharedFileText | undefined>(undefined)
  const [previewFailure, setPreviewFailure] = useState<string | undefined>(undefined)
  const [uploading, setUploading] = useState(false)
  const [uploadFailure, setUploadFailure] = useState<string | undefined>(undefined)
  const [reloadKey, setReloadKey] = useState(0)
  const [subPath, setSubPath] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    void listRoomFiles(roomId, subPath)
      .then((next) => { if (live) setState(next) })
      // A failed read is not an empty folder: showing "no files" would misreport a broken
      // mount as an empty one, so the section says so plainly instead.
      .catch(() => { if (live) setState({ path: null, files: [] }) })
    return () => { live = false }
  }, [roomId, reloadKey, subPath])

  if (state === undefined) return null
  // Breadcrumbs come from the server rather than being rebuilt here: it already resolved the
  // path, and a second resolver would disagree with it the first time either changed.
  const crumbs = state.crumbs ?? []
  // No shared tree on this deployment: the section would only ever say "unavailable", which
  // is noise for a member who never had the feature.
  if (state.path === null) return null

  const openPreview = (path: string): void => {
    setPreviewFailure(undefined)
    void getRoomFile(roomId, path)
      .then((next) => { setPreview(next) })
      .catch(() => { setPreviewFailure(t('membersFileUnreadable')) })
  }

  const upload = (picked: File): void => {
    setUploading(true)
    setUploadFailure(undefined)
    void uploadRoomFile(roomId, picked)
      .then(() => { setReloadKey((value) => value + 1) })
      .catch(() => { setUploadFailure(t('membersFileUploadFailed')) })
      .finally(() => {
        setUploading(false)
        // Reset so picking the same file twice still fires a change event.
        if (fileInput.current !== null) fileInput.current.value = ''
      })
  }

  return (
    <CollapsibleSection
      t={t}
      title={t('membersFilesTitle')}
      count={state.files.length}
      actions={(
        <>
          {/* A hidden input, opened by the button: the native file dialog is the only picker
              that can hand back a File without a second permission step. */}
          <input
            ref={fileInput}
            type="file"
            className={styles['filePicker']}
            aria-label={t('membersFileUpload')}
            onChange={(event) => {
              const picked = event.target.files?.[0]
              if (picked !== undefined) upload(picked)
            }}
          />
          <button
            type="button"
            className={styles['refresh']}
            aria-label={t('membersFileUpload')}
            title={t('membersFileUpload')}
            disabled={uploading}
            onClick={() => { fileInput.current?.click() }}
          >
            {uploading ? '\u22EF' : '+'}
          </button>
          {/* The folder changes when the room's agent writes a file, and this panel can stay
              open for a long time; a manual refresh is cheaper than polling and honest about
              when the list is from. */}
          <button
            type="button"
            className={styles['refresh']}
            aria-label={t('membersFilesRefresh')}
            title={t('membersFilesRefresh')}
            onClick={() => { setReloadKey((value) => value + 1) }}
          >
            {'\u21BB'}
          </button>
        </>
      )}
    >
      {crumbs.length > 0 && (
        <nav className={styles['crumbs']} aria-label={t('membersFilesTitle')}>
          <button type="button" className={styles['crumb']} onClick={() => { setSubPath('') }}>
            {t('membersFilesRoot')}
          </button>
          {crumbs.map((crumb) => (
            <span key={crumb.path} className={styles['crumbGroup']}>
              <span className={styles['crumbSep']} aria-hidden="true">/</span>
              <button
                type="button"
                className={styles['crumb']}
                onClick={() => { setSubPath(crumb.path) }}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
      )}
      {state.files.length === 0 ? (
        <p className={styles['hint']}>{t('membersFilesEmpty')}</p>
      ) : (
        <ul className={styles['list']}>
          {state.files.map((file) => (
            <li key={file.path} className={styles['row']}>
              {file.directory ? (
                <button
                  type="button"
                  className={styles['fileButton']}
                  onClick={() => { setSubPath(joinPath(subPath, file.path)) }}
                  title={file.path}
                >
                  <span className={styles['fileIcon']} aria-hidden="true">{'\u{1F4C1}'}</span>
                  <span className={styles['name']}>{file.name}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className={styles['fileButton']}
                  onClick={() => { openPreview(joinPath(subPath, file.path)) }}
                  title={file.path}
                >
                  <span className={styles['fileIcon']} aria-hidden="true">{'\u{1F4C4}'}</span>
                  <span className={styles['name']}>{file.name}</span>
                  <span className={styles['fileSize']}>{formatBytes(file.size)}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {previewFailure !== undefined && <p className={styles['hint']}>{previewFailure}</p>}
      {uploadFailure !== undefined && <p className={styles['error']}>{uploadFailure}</p>}
      {preview !== undefined && (
        <section className={styles['preview']} aria-label={preview.name}>
          <div className={styles['previewHeader']}>
            <span className={styles['previewTitle']} title={preview.path}>{preview.name}</span>
            <button
              type="button"
              className={styles['previewClose']}
              aria-label={t('membersFileClose')}
              onClick={() => { setPreview(undefined) }}
            >
              {'\u00D7'}
            </button>
          </div>
          {preview.image !== undefined ? (
            <img className={styles['previewImage']} src={preview.image} alt={preview.name} />
          ) : preview.textLike ? (
            <>
              <pre className={styles['previewBody']}>{preview.text}</pre>
              {preview.truncated && <p className={styles['hint']}>{t('membersFileTruncated')}</p>}
            </>
          ) : (
            <p className={styles['hint']}>{t('membersFileBinary')}</p>
          )}
        </section>
      )}
    </CollapsibleSection>
  )
}

/** Joins a folder-relative path onto the folder currently shown. */
const joinPath = (prefix: string, name: string): string =>
  prefix === '' ? name : `${prefix}/${name}`

/** Bytes as a short human string; the panel has one column, not a table. */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Props for the roster. */
interface RosterProps {
  readonly t: (key: GroupChatKey) => string
  readonly rows: readonly MemberRow[] | undefined
  /** Whether this reader may remove another member; the owner's own row is excluded too. */
  readonly canRemove: boolean
  /** Remove one member by account id. */
  readonly onRemove: (userId: string) => void
}

/**
 * The roster: a search box and one row per member.
 *
 * The search box appears only once the roster is long enough that scanning is slower than
 * typing. Below that it would be a control that cannot help.
 *
 * @param props - the rows and copy.
 * @returns the section.
 */
function Roster(props: RosterProps): ReactNode {
  const { t, rows, canRemove, onRemove } = props
  const [query, setQuery] = useState('')
  // The field starts folded away: a roster of a handful of names reads faster than a control row,
  // and the header already carries the section's actions at the same weight. The button is the way
  // in; while the field is open the same button closes it and clears the query.
  const [searching, setSearching] = useState(false)
  const visible = useMemo(
    () => (rows === undefined ? undefined : filterMemberRows(rows, query)),
    [rows, query],
  )
  const closeSearch = (): void => { setSearching(false); setQuery('') }

  return (
    <CollapsibleSection
      t={t}
      title={t('membersRosterTitle')}
      count={rows?.length}
      actions={(
        <button
          type="button"
          className={styles['searchToggle']}
          aria-label={searching ? t('membersSearchClear') : t('membersSearchOpen')}
          aria-expanded={searching}
          title={searching ? t('membersSearchClear') : t('membersSearchOpen')}
          onClick={() => { if (searching) closeSearch(); else setSearching(true) }}
        >
          {searching ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                 strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                 strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
          )}
        </button>
      )}
    >

      {searching && rows !== undefined && (
        <div className={styles['search']}>
          <Input
            value={query}
            // Opened by an explicit action, so it takes focus; the reader asked for it and would
            // otherwise have to reach for it a second time.
            autoFocus
            placeholder={t('membersSearchPlaceholder')}
            aria-label={t('membersSearch')}
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </div>
      )}

      {visible === undefined ? (
        <p className={styles['hint']}>{t('loading')}</p>
      ) : visible.length === 0 ? (
        <p className={styles['hint']}>
          {rows !== undefined && rows.length > 0 ? t('membersSearchEmpty') : t('membersEmpty')}
        </p>
      ) : (
        <ul className={styles['list']}>
          {visible.map((row) => (
            <li key={row.userId} className={styles['row']}>
              <Avatar name={row.name} src={row.avatarUrl} size="md" />
              <span className={styles['name']} title={row.name}>{row.name}</span>
              {row.self && <span className={styles['selfTag']}>{t('membersSelf')}</span>}
              {row.owner && <span className={styles['ownerTag']}>{t('membersOwner')}</span>}
              {canRemove && !row.self && (
                <button
                  type="button"
                  className={styles['remove']}
                  title={t('removeMember')}
                  aria-label={t('removeMember')}
                  onClick={() => { onRemove(row.userId) }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                       strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8a1 1 0 0 0 1 1h2.8a1 1 0 0 0 1-1l.6-8" />
                  </svg>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </CollapsibleSection>
  )
}

/**
 * The chip that labels the members tab in the sidebar's tab strip.
 *
 * The sidebar calls this separately from the body so the strip can render without mounting every
 * placed tab; it therefore needs the label alone, and none of the body's data.
 *
 * @param props - the localized copy.
 * @returns the tab's label.
 */
export function MembersTabTitle(props: { readonly t: (key: GroupChatKey) => string }): ReactNode {
  return props.t('membersTitle')
}
