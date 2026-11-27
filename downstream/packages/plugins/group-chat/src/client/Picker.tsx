/**
 * A searchable list of choices, for the fields that used to be free text.
 *
 * Three of the room dialogs ask for values the deployment already knows — who can be
 * invited, which preset to run, which directory to work in — and each used to be an empty
 * box that only accepted the answer if it was spelled exactly right. A wrong userId failed
 * only after the invite was submitted, and a wrong directory silently became a room the
 * agent could not work in. This component is the shared answer so all three behave alike
 * rather than each growing its own behaviour.
 *
 * It is deliberately not a `<datalist>`: the options come from an async source, the row
 * needs a picture and a secondary line, and a datalist cannot group or report why it is
 * empty. It is also not built on the official primitives because none of them is a
 * combobox — the package ships Button, Input, Menu and friends, but no searchable select.
 *
 * @module @sparkelf/dsh-group-chat/client/Picker
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { Avatar } from './Avatar.tsx'
import { filterOptions, type PickerOption } from './rows.ts'
import styles from './Picker.module.css'

/**
 * Sentinel id for the "use what I typed" row.
 *
 * A real id cannot collide with it because account ids, preset names and paths are all
 * printable, so a NUL is outside every id space this component is handed.
 */
const TYPED_ROW_ID = '\u0000typed'

export interface PickerProps {
  readonly options: readonly PickerOption[]
  readonly placeholder: string
  /** Shown under the input when the source answered with nothing. */
  readonly emptyHint?: string
  /** Shown instead of the list while the source is in flight. */
  readonly loadingHint?: string
  readonly loading?: boolean
  /** Called on every keystroke; the caller debounces and owns the query. */
  readonly onQueryChange?: (query: string) => void
  /**
   * Lets the field's own text be committed as a value.
   *
   * Two fields this serves — the working directory and the preset — accept any string
   * server-side, so a picker that could only choose from a list would make valid values
   * unreachable. With this set, a non-empty query offers itself as the first row and Enter
   * commits the typed text instead of falling through to the dialog's submit.
   */
  readonly onTypedCommit?: (text: string) => void
  /** Copy for that first row, given the text it would commit. */
  readonly typedCommitLabel?: (text: string) => string
  /** Enter with no highlighted row, and the click on a row, both land here. */
  readonly onPick: (option: PickerOption) => void
  /** Cleared after each pick, so a picker can be used repeatedly without reselecting. */
  readonly value?: string
  readonly autoFocus?: boolean
}

/**
 * A text field with a filtered list beneath it.
 *
 * Keyboard support is the reason this is not a plain list of buttons: ↑/↓ move the highlight
 * without leaving the field, Enter takes the highlighted row, and Escape first closes the
 * list and only then reaches the dialog, so a stray Escape while searching does not discard
 * the whole dialog.
 */
export const Picker = (props: PickerProps): ReactNode => {
  const {
    options, placeholder, emptyHint, loadingHint, loading = false,
    onQueryChange, onTypedCommit, typedCommitLabel, onPick, value, autoFocus = false,
  } = props
  const [query, setQuery] = useState(value ?? '')
  // A picker that opens empty hides the very choices it exists to offer, so an auto-focused
  // field starts expanded: the operator is looking straight at the list they came for.
  const [open, setOpen] = useState(autoFocus)
  const [active, setActive] = useState(0)
  const boxRef = useRef<HTMLDivElement | null>(null)

  // The caller can clear the field (after a pick) without this component losing its own
  // typing state, which is what lets one picker invite several people in a row.
  useEffect(() => { setQuery(value ?? '') }, [value])

  // The typed value is offered as a row of its own, ahead of the filtered ones, so a value
  // the deployment does not list stays reachable by the same Enter key as a listed one.
  const typed: PickerOption[] = onTypedCommit !== undefined && query.trim().length > 0
    ? [{ id: TYPED_ROW_ID, label: typedCommitLabel?.(query.trim()) ?? query.trim() }]
    : []
  const visible = [...typed, ...filterOptions(options, query)]

  // A shrinking list must not keep a highlight that now points past its end.
  useEffect(() => { setActive(0) }, [query])

  const pick = useCallback((option: PickerOption | undefined): void => {
    if (option === undefined) return
    if (option.id === TYPED_ROW_ID) {
      onTypedCommit?.(query.trim())
      return
    }
    onPick(option)
  }, [onPick, onTypedCommit, query])

  // Clicking a row must not blur-close the list before the click lands, so the close is
  // driven by an outside pointerdown rather than by the field's blur.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (boxRef.current !== null && !boxRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [open])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActive((current) => (visible.length === 0 ? 0 : (current + 1) % visible.length))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => (visible.length === 0 ? 0 : (current - 1 + visible.length) % visible.length))
      return
    }
    if (event.key === 'Enter') {
      if (open && visible.length > 0) {
        // Enter belongs to the highlighted row while the list is open; the dialog's own
        // submit only runs when there is nothing to pick.
        event.preventDefault()
        pick(visible[active])
      }
      return
    }
    if (event.key === 'Escape' && open) {
      // Consumed here so Escape closes the list first and the dialog second.
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className={styles['box']} ref={boxRef}>
      <Input
        value={query}
        autoFocus={autoFocus}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onFocus={() => { setOpen(true) }}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
          onQueryChange?.(event.target.value)
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div className={styles['list']} role="listbox">
          {loading && <p className={styles['note']}>{loadingHint ?? ''}</p>}
          {!loading && visible.length === 0 && (
            <p className={styles['note']}>{emptyHint ?? ''}</p>
          )}
          {!loading && visible.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={index === active}
              className={index === active ? styles['rowActive'] : styles['row']}
              onMouseEnter={() => { setActive(index) }}
              onClick={() => { pick(option) }}
            >
              {option.avatarId !== undefined || option.avatarUrl !== undefined
                ? <Avatar name={option.label} src={option.avatarUrl} size="sm" />
                : null}
              <span className={styles['label']}>{option.label}</span>
              {option.secondary !== undefined && option.secondary.length > 0 && (
                <span className={styles['secondary']}>{option.secondary}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
