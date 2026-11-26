import type { ButtonHTMLAttributes, ReactNode } from 'react'

export interface MenuItemButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  onSelect?: () => void
  icon?: ReactNode
  children?: ReactNode
}

export function MenuItemButton({ onSelect, onClick, children, icon, ...props }: MenuItemButtonProps) {
  return <button type="button" {...props} onClick={(event) => { onClick?.(event); if (!event.defaultPrevented) onSelect?.() }}>{icon}{children}</button>
}
