export function SegmentedTabs({ items, value, onChange, label, className }: {
  items: readonly { value: any; label: string; id?: string; panelId?: string }[]
  value: any
  onChange: (value: any) => void
  label?: string
  className?: string
}) {
  return <div className={className} role="tablist" aria-label={label}>
    {items.map((item) => <button key={String(item.value)} id={item.id} type="button" role="tab" aria-selected={item.value === value} aria-controls={item.panelId} onClick={() => onChange(item.value)}>{item.label}</button>)}
  </div>
}
