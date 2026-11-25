import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { VscCheck, VscChevronDown, VscKebabVertical, VscSearch } from 'react-icons/vsc'
import { useT } from './i18n.tsx'
import css from './Dropdown.module.css'

function floatingPosition(trigger: HTMLElement, minWidth: number, maxWidth: number): CSSProperties {
  const rect = trigger.getBoundingClientRect()
  const margin = 8
  const width = Math.min(maxWidth, Math.max(minWidth, rect.width), window.innerWidth - margin * 2)
  const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin)
  const below = window.innerHeight - rect.bottom - margin
  const above = rect.top - margin
  return below >= Math.min(180, above)
    ? { left, top: rect.bottom + 4, width, maxHeight: Math.max(96, below) }
    : { left, bottom: window.innerHeight - rect.top + 4, width, maxHeight: Math.max(96, above) }
}

export interface SelectOption<T extends string = string> {
  value: T
  label: string
  description?: string
  disabled?: boolean
}

export function filterSelectOptions<T extends string>(options: SelectOption<T>[], query: string): SelectOption<T>[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return options
  return options.filter(option => (option.label + ' ' + (option.description ?? '')).toLocaleLowerCase().includes(needle))
}

interface SelectProps<T extends string> {
  value: T
  options: SelectOption<T>[]
  onChange(value: T): void
  label: string
  className?: string
  disabled?: boolean
  searchable?: boolean
  placeholder?: string
  renderValue?: (option: SelectOption<T> | undefined) => ReactNode
}

export function Select<T extends string>({ value, options, onChange, label, className, disabled, searchable, placeholder, renderValue }: SelectProps<T>) {
  const t = useT()
  const id = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState<CSSProperties>({})
  const selected = options.find(option => option.value === value)
  const canSearch = searchable ?? options.length > 8
  const filtered = useMemo(() => filterSelectOptions(options, query), [options, query])

  const show = (): void => {
    if (disabled) return
    const selectedIndex = options.findIndex(option => option.value === value)
    setQuery('')
    setActive(Math.max(0, selectedIndex))
    if (triggerRef.current !== null) setPosition(floatingPosition(triggerRef.current, 180, 320))
    setOpen(true)
  }
  const hide = (restoreFocus = false): void => {
    setOpen(false)
    setQuery('')
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const choose = (option: SelectOption<T>): void => {
    if (option.disabled) return
    onChange(option.value)
    hide(true)
  }
  const move = (direction: 1 | -1): void => {
    if (filtered.length === 0) return
    let next = active
    for (let index = 0; index < filtered.length; index++) {
      next = (next + direction + filtered.length) % filtered.length
      if (!filtered[next]?.disabled) break
    }
    setActive(next)
  }
  const onMenuKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0) }
    else if (event.key === 'End') { event.preventDefault(); setActive(Math.max(0, filtered.length - 1)) }
    else if (event.key === 'Enter') { event.preventDefault(); const option = filtered[active]; if (option !== undefined) choose(option) }
    else if (event.key === 'Escape' || event.key === 'Tab') hide(event.key === 'Escape')
  }

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => { if (!rootRef.current?.contains(event.target as Node) && !popoverRef.current?.contains(event.target as Node)) hide() }
    document.addEventListener('mousedown', close)
    return () => { document.removeEventListener('mousedown', close) }
  }, [open])
  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => { (canSearch ? searchRef.current : listRef.current)?.focus() })
  }, [canSearch, open])
  useEffect(() => { setActive(0) }, [query])

  return <div ref={rootRef} className={[css.root, className].filter(Boolean).join(' ')}>
    <button
      ref={triggerRef}
      type="button"
      className={css.trigger}
      role="combobox"
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={id}
      disabled={disabled}
      onClick={() => { open ? hide() : show() }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          show()
        }
      }}
    >
      <span>{renderValue ? renderValue(selected) : selected?.label ?? placeholder ?? t('select.default')}</span><VscChevronDown aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={popoverRef} className={css.popover} style={position}>
      {canSearch && <label className={css.search}><VscSearch aria-hidden="true" /><input ref={searchRef} value={query} onChange={event => { setQuery(event.target.value) }} onKeyDown={onMenuKeyDown} placeholder={t('select.search')} aria-label={t('select.searchLabel', { label })} /></label>}
      <div ref={listRef} id={id} className={css.listbox} role="listbox" tabIndex={canSearch ? -1 : 0} aria-label={label} aria-activedescendant={filtered[active] === undefined ? undefined : id + '-' + active} onKeyDown={onMenuKeyDown}>
        {filtered.length === 0 && <div className={css.noResults}>{t('select.noResults')}</div>}
        {filtered.map((option, index) => <div
          id={id + '-' + index}
          key={option.value}
          className={css.option}
          role="option"
          aria-selected={option.value === value}
          aria-disabled={option.disabled}
          data-active={index === active}
          onMouseEnter={() => { setActive(index) }}
          onMouseDown={event => { event.preventDefault() }}
          onClick={() => { choose(option) }}
        >
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          {option.value === value && <VscCheck aria-hidden="true" />}
        </div>)}
      </div>
    </div>, document.body)}
  </div>
}

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onSelect(): void
}

export function ActionMenu({ label, items, icon = <VscKebabVertical /> }: { label: string; items: MenuItem[]; icon?: ReactNode }) {
  const id = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState<CSSProperties>({})
  const enabled = items.map((item, index) => item.disabled ? -1 : index).filter(index => index >= 0)
  const focusIndex = (index: number): void => { setActive(index); requestAnimationFrame(() => itemRefs.current[index]?.focus()) }
  const show = (): void => { if (triggerRef.current !== null) setPosition(floatingPosition(triggerRef.current, 160, 240)); setOpen(true); focusIndex(enabled[0] ?? 0) }
  const hide = (restoreFocus = false): void => { setOpen(false); if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus()) }

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => { if (!rootRef.current?.contains(event.target as Node) && !popoverRef.current?.contains(event.target as Node)) hide() }
    document.addEventListener('mousedown', close)
    return () => { document.removeEventListener('mousedown', close) }
  }, [open])

  return <div className={css.menuRoot} ref={rootRef}>
    <button ref={triggerRef} type="button" className={css.iconTrigger} title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => { open ? hide() : show() }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); show() } }}>{icon}</button>
    {open && createPortal(<div ref={popoverRef} id={id} className={[css.popover, css.menu].join(' ')} style={position} role="menu" aria-label={label} onKeyDown={event => {
      const position = enabled.indexOf(active)
      if (event.key === 'ArrowDown') { event.preventDefault(); focusIndex(enabled[(position + 1) % enabled.length] ?? 0) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); focusIndex(enabled[(position - 1 + enabled.length) % enabled.length] ?? 0) }
      else if (event.key === 'Escape' || event.key === 'Tab') hide(event.key === 'Escape')
    }}>
      {items.map((item, index) => <button
        ref={element => { itemRefs.current[index] = element }}
        key={item.id}
        type="button"
        role="menuitem"
        className={css.menuItem}
        data-danger={item.danger}
        data-separator={item.separator}
        disabled={item.disabled}
        tabIndex={index === active ? 0 : -1}
        onClick={() => { item.onSelect(); hide(true) }}
      >{item.icon}<span>{item.label}</span></button>)}
    </div>, document.body)}
  </div>
}
