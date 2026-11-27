/** Live portal branding and the persisted shell preference for the managed DataOps identity. */

/** The name the workspace shows when DataOps has no brand of its own. */
export const DEFAULT_WANXIANG_BRAND_NAME = '万相AI中台'

/** One brand the shell can render. */
export interface WanxiangBranding {
  /** Platform name shared by the wordmark, its accessible name and the browser title. */
  name: string
  /** Inline image data URL or an absolute path; empty draws the inline mark. */
  logo: string
}

/** Hardcoded brand used before the first read and whenever the read fails. */
export const DEFAULT_WANXIANG_BRANDING: WanxiangBranding = {
  name: DEFAULT_WANXIANG_BRAND_NAME,
  logo: '',
}

/** Persisted client preference for the managed DataOps shell identity. */
export interface WanxiangBrandPreference extends WanxiangBranding {
  enabled: boolean
}

/** Stable local preference key shared by Settings and brand-slot registration. */
export const WANXIANG_BRAND_PREFERENCE_KEY = 'dsh.dataops.wanxiangBrand'

/** Same limit the portal applies to its brand name. */
const BRAND_NAME_MAX_LENGTH = 32

/** Inline logo formats the portal's uploader produces, plus SVG for seeded deployments. */
const INLINE_LOGO_PATTERN = /^data:image\/(?:png|jpe?g|webp|svg\+xml);base64,[a-z0-9+/=]+$/iu

/** Portal default marks that the workspace draws itself instead of loading an image. */
const DEFAULT_LOGO_PATHS = new Set([
  '/logo-mark.svg',
  '/logo-text.png',
  '/logo-cube.svg',
  '/logo-cube-mono.svg',
])

/**
 * Normalize a brand name; empty or unusable values keep the workspace default.
 * @param value - Raw value from the host route or a caller.
 * @returns A non-empty display name no longer than the portal's limit.
 */
export function normalizeWanxiangBrandName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_WANXIANG_BRAND_NAME
  const name = value.replace(/\s+/gu, ' ').trim().slice(0, BRAND_NAME_MAX_LENGTH)
  return name === '' ? DEFAULT_WANXIANG_BRAND_NAME : name
}

/**
 * Normalize a brand logo to the two forms the shell renders.
 * @param value - Raw value from the host route or a caller.
 * @returns A data URL, an absolute path, or an empty string for the inline mark.
 */
export function normalizeWanxiangBrandLogo(value: unknown): string {
  if (typeof value !== 'string') return ''
  const logo = value.trim()
  if (logo === '' || DEFAULT_LOGO_PATHS.has(logo)) return ''
  if (INLINE_LOGO_PATTERN.test(logo)) return logo
  if (logo.startsWith('/') && !logo.startsWith('//') && logo.length <= 4096) return logo
  // The Host resolves a portal-relative path against webBaseUrl before answering this route.
  if (/^https?:\/\/[^\s]+$/iu.test(logo) && logo.length <= 4096) return logo
  return ''
}

/**
 * Normalize a pair of raw brand values.
 * @param name - Raw platform name.
 * @param logo - Raw logo value.
 * @returns A brand safe to hand to the shell.
 */
export function normalizeWanxiangBranding(name: unknown, logo: unknown): WanxiangBranding {
  return {
    name: normalizeWanxiangBrandName(name),
    logo: normalizeWanxiangBrandLogo(logo),
  }
}

function initialPreference(): WanxiangBrandPreference {
  const fallback: WanxiangBrandPreference = { enabled: true, ...DEFAULT_WANXIANG_BRANDING }
  if (typeof localStorage === 'undefined') return fallback
  try {
    const value = JSON.parse(localStorage.getItem(WANXIANG_BRAND_PREFERENCE_KEY) ?? 'null') as unknown
    return typeof value === 'object' && value !== null && 'enabled' in value
      && typeof (value as { enabled?: unknown }).enabled === 'boolean'
      ? { ...fallback, enabled: (value as { enabled: boolean }).enabled }
      : fallback
  } catch {
    return fallback
  }
}

let preference = initialPreference()
const listeners = new Set<() => void>()

/** Observable preference compatible with React's useSyncExternalStore. */
export const wanxiangBrandPreference = {
  /** @returns The current enabled flag and branding. */
  getSnapshot: (): WanxiangBrandPreference => preference,
  /**
   * Subscribe to preference or branding changes.
   * @param listener - Called after each committed change.
   * @returns A disposer that removes the listener.
   */
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

/** Replace the live branding; unchanged values do not notify. */
export function setWanxiangBranding(branding: Partial<WanxiangBranding>): void {
  const name = normalizeWanxiangBrandName(branding.name ?? preference.name)
  const logo = normalizeWanxiangBrandLogo(branding.logo ?? preference.logo)
  if (name === preference.name && logo === preference.logo) return
  preference = { ...preference, name, logo }
  for (const listener of listeners) listener()
}

/** Toggle the Wanxiang shell identity from the DataOps Settings section. */
export function setWanxiangBrandEnabled(enabled: boolean): void {
  if (preference.enabled === enabled) return
  preference = { ...preference, enabled }
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(WANXIANG_BRAND_PREFERENCE_KEY, JSON.stringify({ enabled }))
    } catch {
      // Storage failure must not block an in-memory preference change.
    }
  }
  for (const listener of listeners) listener()
}