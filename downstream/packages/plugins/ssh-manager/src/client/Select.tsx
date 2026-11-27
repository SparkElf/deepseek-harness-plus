import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { VscCheck, VscChevronDown } from 'react-icons/vsc'
import { useT } from './i18n.tsx'
import css from './SshManager.module.css'

function floatingPosition(trigger: HTMLElement): CSSProperties {
  const rect = trigger.getBoundingClientRect()
  const margin = 8
  const width = Math.min(Math.max(170, rect.width), 280, window.innerWidth - margin * 2)
  const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin)
  const below = window.innerHeight - rect.bottom - margin
  const above = rect.top - margin
  return below >= Math.min(160, above)
    ? { left, top: rect.bottom + 4, width, maxHeight: Math.max(96, below) }
    : { left, bottom: window.innerHeight - rect.top + 4, width, maxHeight: Math.max(96, above) }
}

export interface SelectOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

export function nextEnabledOption(options: SelectOption[], current: number, direction: 1 | -1): number {
  if (options.length === 0) return -1
  for (let offset = 1; offset <= options.length; offset++) {
    const index = (current + direction * offset + options.length) % options.length
    if (options[index]?.disabled !== true) return index
  }
  return -1
}

interface SelectProps {
  value: string
  options: SelectOption[]
  onChange(value: string): void
  label: string
  placeholder?: string
  disabled?: boolean
}

export function Select({ value, options, onChange, label, placeholder, disabled = false }: SelectProps) {
  const t = useT()
  const id = useId()
  const root = useRef<HTMLDivElement | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({})
  const selectedIndex = options.findIndex(option => option.value === value)
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const selected = options[selectedIndex]
  const enabled = useMemo(() => options.some(option => option.disabled !== true), [options])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (root.current?.contains(event.target as Node) !== true && menu.current?.contains(event.target as Node) !== true) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => { document.removeEventListener('pointerdown', close) }
  }, [open])

  useEffect(() => {
    if (open) setActiveIndex(selectedIndex >= 0 && options[selectedIndex]?.disabled !== true ? selectedIndex : nextEnabledOption(options, -1, 1))
  }, [open, options, selectedIndex])

  const choose = (index: number): void => {
    const option = options[index]
    if (option === undefined || option.disabled === true) return
    onChange(option.value)
    setOpen(false)
    requestAnimationFrame(() => { button.current?.focus() })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { if (button.current !== null) setPosition(floatingPosition(button.current)); setOpen(true) }
      else setActiveIndex(current => nextEnabledOption(options, current, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Home' && open) { event.preventDefault(); setActiveIndex(nextEnabledOption(options, -1, 1)); return }
    if (event.key === 'End' && open) { event.preventDefault(); setActiveIndex(nextEnabledOption(options, 0, -1)); return }
    if ((event.key === 'Enter' || event.key === ' ') && open) { event.preventDefault(); choose(activeIndex); return }
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false) }
  }

  return <div ref={root} className={css.select} data-open={open}>
    <button
      ref={button}
      type="button"
      className={css.selectTrigger}
      role="combobox"
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={id}
      disabled={disabled || !enabled}
      onClick={() => { setOpen(current => { if (!current && button.current !== null) setPosition(floatingPosition(button.current)); return !current }) }}
      onKeyDown={onKeyDown}
    >
      <span data-placeholder={selected === undefined}>{selected?.label ?? placeholder ?? t('select.placeholder')}</span>
      <VscChevronDown aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menu} id={id} className={css.selectMenu} style={position} role="listbox" aria-label={label} aria-activedescendant={activeIndex >= 0 ? id + '-' + activeIndex.toString() : undefined}>
      {options.map((option, index) => <button
        id={id + '-' + index.toString()}
        type="button"
        role="option"
        aria-selected={option.value === value}
        aria-disabled={option.disabled}
        className={css.selectOption}
        data-active={index === activeIndex}
        disabled={option.disabled}
        key={option.value}
        onPointerMove={() => { if (option.disabled !== true) setActiveIndex(index) }}
        onClick={() => { choose(index) }}
      >
        <span><strong>{option.label}</strong>{option.description !== undefined && <small>{option.description}</small>}</span>
        {option.value === value && <VscCheck aria-hidden="true" />}
      </button>)}
    </div>, document.body)}
  </div>
}
