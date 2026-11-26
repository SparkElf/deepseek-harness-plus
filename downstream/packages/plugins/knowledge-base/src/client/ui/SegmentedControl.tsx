export interface SegmentedOption<T> { value: T; label: string }
export type SegmentedControlOption<T> = SegmentedOption<T>

export function SegmentedControl<T>({ id, label, value, options, onChange }: {
  id?: string
  label?: string
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
}) {
  return <div id={id} role="radiogroup" aria-label={label}>
    {options.map((option) => <button key={String(option.value)} type="button" role="radio" aria-checked={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>
}
