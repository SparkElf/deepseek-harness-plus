// @ts-nocheck
import { useEffect, useRef, useState } from 'react'
import { VscChevronDown, VscDatabase } from 'react-icons/vsc'
import type { ConnectionConfig } from '../types.ts'
import { useT } from './i18n.tsx'
import css from './SqlWorkbench.module.css'

export interface ConnectionPickerProps {
  connections: ConnectionConfig[]
  selectedId: string | null
  onSelect(connectionId: string): void
}

/** 自绘连接选择器，弹层完全使用 DSH token，避免原生 select 的系统主题漂移。 */
export function ConnectionPicker({ connections, selectedId, onSelect }: ConnectionPickerProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selected = connections.find(connection => connection.id === selectedId)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === false) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => { document.removeEventListener('pointerdown', close) }
  }, [open])

  return <div ref={rootRef} className={css.connectionPicker}>
    <button
      className={css.connectionTrigger}
      type="button"
      aria-label={t('connection.label')}
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={() => { setOpen(value => !value) }}
    >
      <VscDatabase size={14} />
      <span>{selected?.name ?? t('connection.none')}</span>
      <VscChevronDown size={14} />
    </button>
    {open && <div className={css.connectionMenu} role="listbox" aria-label={t('connection.label')}>
      {connections.map(connection => <button
        key={connection.id}
        type="button"
        role="option"
        aria-selected={connection.id === selectedId}
        onClick={() => { onSelect(connection.id); setOpen(false) }}
      >
        <VscDatabase size={14} />
        <span>{connection.name}</span>
        <small>{connection.kind}</small>
      </button>)}
    </div>}
  </div>
}
