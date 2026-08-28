/** Machine value of the preset that requires an explicit GUI risk gate. */
export const FULL_ACCESS_PRESET = 'danger-full-access'

/**
 * Convert conventional kebab-case preset names into user-facing title case.
 * @param name - host-supplied preset label or key.
 * @returns the title-cased conventional key, or a non-kebab label unchanged.
 */
export function displayPresetName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/** Locale reader for built-in permission preset names. */
export type PermissionPresetTranslate = (
  key: 'preset.readOnly' | 'preset.workspaceWrite' | 'preset.fullAccess',
) => string

/**
 * Render a permission preset under its localized built-in or host-supplied label.
 * @param value - preset machine value.
 * @param name - host-supplied preset name.
 * @param t - locale reader for built-in product names.
 * @returns the localized built-in label or conventional custom display name.
 */
export function displayPermissionPreset(
  value: string,
  name: string,
  t: PermissionPresetTranslate,
): string {
  if (value === 'read-only') return t('preset.readOnly')
  if (value === 'workspace-write') return t('preset.workspaceWrite')
  if (value === FULL_ACCESS_PRESET) return t('preset.fullAccess')
  return displayPresetName(name)
}
