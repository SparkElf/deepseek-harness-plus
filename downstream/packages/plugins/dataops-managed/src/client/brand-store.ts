/** Persisted client preference for the managed DataOps shell identity. */
export interface WanxiangBrandPreference {
  enabled: boolean
}

/** Stable local preference key shared by Settings and brand-slot registration. */
export const WANXIANG_BRAND_PREFERENCE_KEY = 'dsh.dataops.wanxiangBrand'

function initialPreference(): WanxiangBrandPreference {
  if (typeof localStorage === 'undefined') return { enabled: true }
  try {
    const value = JSON.parse(localStorage.getItem(WANXIANG_BRAND_PREFERENCE_KEY) ?? 'null') as unknown
    return typeof value === 'object' && value !== null && 'enabled' in value
      && typeof (value as { enabled?: unknown }).enabled === 'boolean'
      ? { enabled: (value as { enabled: boolean }).enabled }
      : { enabled: true }
  } catch {
    return { enabled: true }
  }
}

let preference = initialPreference()
const listeners = new Set<() => void>()

/** Observable preference compatible with React's useSyncExternalStore. */
export const wanxiangBrandPreference = {
  getSnapshot: (): WanxiangBrandPreference => preference,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}

/** Toggle the Wanxiang shell identity from the DataOps Settings section. */
export function setWanxiangBrandEnabled(enabled: boolean): void {
  if (preference.enabled === enabled) return
  preference = { enabled }
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(WANXIANG_BRAND_PREFERENCE_KEY, JSON.stringify(preference))
    } catch {
      // Storage failure must not block an in-memory preference change.
    }
  }
  for (const listener of listeners) listener()
}
