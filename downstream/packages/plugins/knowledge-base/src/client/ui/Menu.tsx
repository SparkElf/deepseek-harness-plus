import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function Menu({ open, anchor, onClose, children }: {
  open: boolean
  anchor: ReactNode
  onClose: () => void
  align?: string
  children: ReactNode
}) {
  return <>{anchor}{open ? createPortal(<div role="menu" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>{children}</div>, document.body) : null}</>
}
