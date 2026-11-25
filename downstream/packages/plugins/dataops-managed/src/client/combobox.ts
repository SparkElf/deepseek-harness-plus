/** Pure helpers shared by the permission-centre combobox and resource details. */

/** One selectable option. */
export interface ComboboxOption {
  readonly value: string
  readonly label: string
  readonly hint?: string
}

/**
 * Filter options by display label or code hint, case-insensitively.
 * @param options - all options.
 * @param query - typed search text.
 */
export function filterComboboxOptions(options: readonly ComboboxOption[], query: string): ComboboxOption[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...options]
  return options.filter(option => option.label.toLowerCase().includes(needle)
    || (option.hint ?? '').toLowerCase().includes(needle))
}

/** Keep an active index inside a possibly empty result list. */
export function clampActiveIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, index))
}

/** Owner cell face: a real display name, or a dash; never the raw id. */
export function ownerDisplay(ownerName: string | undefined | null): string {
  const name = ownerName?.trim()
  return name === undefined || name === '' ? '—' : name
}
