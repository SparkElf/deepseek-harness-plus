/** Client read of the portal brand the Host mirrors from DataOps' public settings. */

import {
  normalizeWanxiangBranding,
  type WanxiangBranding,
} from './brand-store.ts'

/** Same-origin route registered by the Host half. */
export const BRANDING_PATH = '/integrations/dataops/branding'

/** The Host answer: the portal's current name and logo, or the plugin's defaults. */
interface BrandingPayload {
  name?: unknown
  logo?: unknown
}

/**
 * Read the current portal brand.
 *
 * A failed read returns null instead of a default so the caller keeps whatever it already
 * shows: at startup that is the hardcoded default, and after a successful read it is the last
 * brand DataOps confirmed.
 * @param options - Origin (tests) and abort signal.
 * @returns The normalized brand, or null when the read failed or answered outside the contract.
 */
export async function fetchWanxiangBranding(
  options: { origin?: string; signal?: AbortSignal } = {},
): Promise<WanxiangBranding | null> {
  try {
    const origin = options.origin ?? window.location.origin
    const response = await fetch(new URL(BRANDING_PATH, origin), {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: options.signal,
    })
    if (!response.ok) return null
    const payload = await response.json() as unknown
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
    const { name, logo } = payload as BrandingPayload
    if (typeof name !== 'string' && typeof logo !== 'string') return null
    return normalizeWanxiangBranding(name, logo)
  } catch {
    // Network failure, abort, or a non-JSON answer: the caller keeps its current brand.
    return null
  }
}