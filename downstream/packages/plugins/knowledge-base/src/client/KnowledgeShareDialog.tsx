/**
 * The Share dialog the knowledge tree's context menu opens.
 *
 * Sharing is a grant, and the grant route already exists: this dialog only chooses
 * WHO receives it. The principal directory behind the picker is the same one the
 * permission table reads, reached through the same `principals` route, so a reader
 * who can grant from either surface picks from one list rather than two that can
 * disagree.
 *
 * The picker is a text field plus a filtered list rather than a `<select>`: a real
 * deployment has hundreds of people, and a closed control makes finding one a
 * scroll. Filtering is local over the directory the Host already returned, so
 * typing costs no round trip and stays responsive while a slow directory is still
 * loading.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Input,
  Modal,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SegmentedControl, type SegmentedControlOption } from './ui/SegmentedControl'
import { KB_API, kbApiPath, readKnowledgeJson } from '../api.ts'
import styles from './KnowledgeShareDialog.module.css'

/** The principal kinds the grant route accepts. */
const SUBJECT_TYPES = ['user', 'role', 'department', 'group'] as const

/** One principal kinds. */
type SubjectType = (typeof SUBJECT_TYPES)[number]

/** One selectable principal, as the Host's directory reports it. */
export interface SharePrincipal {
  /** Stable id the grant names. */
  id: string
  /** What a reader recognises it by: a person's name, a role's title. */
  label: string
  /** Optional second line: department, email, or whatever distinguishes two like-named ids. */
  detail?: string
}

/** The copy this dialog needs, so it renders in the reader's language. */
export interface ShareDialogCopy {
  title: string
  intro: string
  subjectType: string
  search: string
  searchPlaceholder: string
  noMatch: string
  loading: string
  empty: string
  cancel: string
  confirm: string
  working: string
  permission: string
  actionRead: string
  actionWrite: string
  actionManage: string
  chosen: string
  failed: string
  directoryFailed: string
  kind_user: string
  kind_role: string
  kind_department: string
  kind_group: string
}

/** Props for the share dialog. */
export interface KnowledgeShareDialogProps {
  /** The path being shared, relative to the knowledge root, or null when closed. */
  relPath: string | null
  /** Whether that path is a directory; only used to word the intro. */
  isDir: boolean
  /** Locale-bound copy for this dialog. */
  copy: ShareDialogCopy
  /** Close the dialog. */
  onClose: () => void
  /** Called after a grant landed, so the page can refresh its permission view. */
  onShared?: () => void
}

/** One action the grant route accepts, mirroring the permission table's three. */
type GrantAction = 'read' | 'write' | 'manage'

/**
 * The Share dialog.
 * @param props - the target path, the copy, and the callbacks.
 * @returns The modal, or nothing while it is closed.
 */
export function KnowledgeShareDialog(props: KnowledgeShareDialogProps) {
  const { relPath, isDir, copy, onClose } = props

  const [subjectType, setSubjectType] = useState<SubjectType>('user')
  const [action, setAction] = useState<GrantAction>('read')
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<readonly SharePrincipal[]>([])
  const [chosen, setChosen] = useState<SharePrincipal | null>(null)
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  /** Highlighted row in the filtered list, so Enter has a target. */
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement | null>(null)

  const open = relPath !== null

  /**
   * Read one principal kind's directory.
   *
   * Re-run whenever the kind changes, because the ids live in different spaces: a
   * value chosen as a user is meaningless as a role. A failure is reported rather
   * than shown as an empty directory, which would read as "nobody exists".
   */
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setNotice(undefined)
    setOptions([])
    setChosen(null)
    setActive(0)
    void (async () => {
      try {
        const response = await fetch(kbApiPath(KB_API.principals), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ principalType: subjectType }),
          cache: 'no-store',
        })
        const body = await readKnowledgeJson<{ options?: SharePrincipal[]; error?: string }>(response)
        if (!alive) return
        if (body.error !== undefined) {
          setNotice(copy.directoryFailed + ' ' + body.error)
          setOptions([])
          return
        }
        setOptions(Array.isArray(body.options) ? body.options : [])
      } catch (failure: unknown) {
        if (!alive) return
        setNotice(copy.directoryFailed + ' ' + (failure instanceof Error ? failure.message : ''))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [open, subjectType, copy.directoryFailed])

  /**
   * The directory narrowed by what has been typed.
   *
   * Matching covers the detail line as well as the label, because an operator
   * looking for a colleague often knows the department but not the exact spelling
   * of the name. The comparison is case-insensitive and trimmed so a trailing space
   * does not empty the list.
   */
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return options
    return options.filter(option =>
      option.label.toLowerCase().includes(needle)
      || (option.detail ?? '').toLowerCase().includes(needle)
      || option.id.toLowerCase().includes(needle))
  }, [options, query])

  /**
   * Keep the highlight inside the filtered list.
   *
   * Typing narrows the list under a highlight that was set against the wider one,
   * so without this the highlight can point past the end and Enter would pick
   * nothing (or the wrong row once the list grows again).
   */
  useEffect(() => {
    if (filtered.length === 0) { setActive(0); return }
    if (active > filtered.length - 1) setActive(0)
  }, [filtered, active])

  /** Scroll the highlighted row into view when the keyboard moves it. */
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    if (list === null) return
    const row = list.querySelector<HTMLElement>('[data-active="true"]')
    row?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  /** Send the grant, then close. */
  const share = useCallback(async (): Promise<void> => {
    if (relPath === null || chosen === null) return
    setWorking(true)
    setNotice(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.grant), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          relPath,
          principalType: subjectType,
          principalId: chosen.id,
          action,
        }),
        cache: 'no-store',
      })
      const body = await readKnowledgeJson<{ error?: string }>(response)
      if (!response.ok || body.error !== undefined) {
        throw new Error(body.error ?? 'HTTP ' + String(response.status))
      }
      props.onShared?.()
      onClose()
    } catch (failure: unknown) {
      setNotice(copy.failed + ' ' + (failure instanceof Error ? failure.message : ''))
    } finally {
      setWorking(false)
    }
  }, [relPath, chosen, subjectType, action, copy.failed, props, onClose])

  /** Move the highlight, wrapping at both ends. */
  const move = useCallback((delta: number): void => {
    if (filtered.length === 0) return
    setActive(current => (current + delta + filtered.length) % filtered.length)
  }, [filtered.length])

  /**
   * Handle a key inside the picker.
   *
   * The dialog is a normal form, so Enter must confirm rather than insert a newline
   * into the search field, and the arrows must walk the list rather than the
   * caret. Escape is left to the primitive, which already closes the modal.
   */
  const onSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); return }
    if (event.key === 'Enter') {
      event.preventDefault()
      const target = filtered[active]
      if (target !== undefined && chosen === null) setChosen(target)
      else if (chosen !== null) { void share() }
    }
  }, [move, filtered, active, chosen, share])

  if (!open) return null

  /**
   * The kind segments' labels.
   *
   * An explicit map rather than a computed `copy['kind_' + kind]`: a template-built
   * key is not one of `ShareDialogCopy`'s properties, so TypeScript cannot see that
   * every kind has copy and a missing translation would compile.
   */
  const kindLabels: Record<SubjectType, string> = {
    user: copy.kind_user,
    role: copy.kind_role,
    department: copy.kind_department,
    group: copy.kind_group,
  }
  const kindOptions: readonly SegmentedControlOption<SubjectType>[] = SUBJECT_TYPES.map((kind) => ({
    value: kind,
    label: kindLabels[kind],
  }))

  return (
    <Modal
      open
      title={copy.title}
      className={styles.dialog}
      contentClassName={styles.content}
      // The file name sits under the title in the dialog's own supporting line: a reader
      // who opened Share from a row needs to see WHICH document they are about to share,
      // and the generic phrasing alone does not say. It also occupies the place the
      // removed explanatory paragraph used to, so the dialog still has one line of context.
      description={relPath === null ? undefined : relPath.slice(relPath.lastIndexOf('/') + 1)}
      closeLabel={copy.cancel}
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" disabled={working} onClick={onClose}>{copy.cancel}</Button>
          <Button variant="primary" disabled={working || chosen === null} onClick={() => { void share() }}>
            {working ? copy.working : copy.confirm}
          </Button>
        </>
      )}
    >
      <div className={styles.body} data-testid="share-body">
        {/* No introductory paragraph here. It explained how permissions are recorded,
            which the reader asked us to remove: the dialog opens directly on the choice
            it exists to make. `intro` is still used for the directory hint below, where
            it says what the dialog is actually about. */}

        <div className={styles.field}>
          <span className={styles.fieldLabel}>{copy.subjectType}</span>
          <SegmentedControl
            id="kb-share-subject-type"
            label={copy.subjectType}
            value={subjectType}
            options={kindOptions}
            onChange={(next) => { setSubjectType(next as SubjectType) }}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>{copy.permission}</span>
          <SegmentedControl
            id="kb-share-action"
            label={copy.permission}
            value={action}
            options={[
              { value: 'read', label: copy.actionRead },
              { value: 'write', label: copy.actionWrite },
              { value: 'manage', label: copy.actionManage },
            ]}
            onChange={(next) => { setAction(next as GrantAction) }}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>{copy.search}</span>
          <Input
            value={query}
            placeholder={copy.searchPlaceholder}
            aria-label={copy.search}
            autoFocus
            onChange={(event) => { setQuery(event.target.value); setActive(0) }}
            onKeyDown={onSearchKeyDown}
          />
        </div>

        {chosen !== null && (
          <div className={styles.chosen}>
            <span className={styles.chosenLabel}>{copy.chosen}</span>
            <Pill>{chosen.detail === undefined ? chosen.label : chosen.label + ' · ' + chosen.detail}</Pill>
            <Button variant="ghost" onClick={() => { setChosen(null) }}>{copy.cancel}</Button>
          </div>
        )}

        <ul className={styles.list} ref={listRef} role="listbox" aria-label={copy.search} data-testid="share-list">
          {loading && <li className={styles.state}>{copy.loading}</li>}
          {!loading && filtered.length === 0 && (
            <li className={styles.state}>{options.length === 0 ? copy.empty : copy.noMatch}</li>
          )}
          {!loading && filtered.map((option, index) => (
            <li key={option.id}>
              <button
                type="button"
                role="option"
                aria-selected={chosen?.id === option.id}
                data-active={index === active ? 'true' : 'false'}
                className={styles.option}
                onMouseEnter={() => { setActive(index) }}
                onClick={() => { setChosen(option) }}
              >
                <span className={styles.optionLabel}>{option.label}</span>
                {option.detail !== undefined && <span className={styles.optionDetail}>{option.detail}</span>}
              </button>
            </li>
          ))}
        </ul>

        {notice !== undefined && <p className={styles.notice} role="alert">{notice}</p>}
        {isDir && <p className={styles.hint}>{copy.intro}</p>}
      </div>
    </Modal>
  )
}
