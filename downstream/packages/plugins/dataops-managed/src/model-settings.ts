/** Model configuration one workspace publishes and another adopts. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'

/** One entry the settings service reports. */
interface SettingsEntry {
  /** Profile entry id the entry belongs to. */
  ns: string
  /** Config values the entry currently resolves to. */
  value: unknown
  /** Revision a write must present back. */
  revision: number
}

/** Profile entry id whose Config holds the model providers. */
export const MODEL_SETTINGS_NAMESPACE = 'llm-pi-ai'

/** Field within that entry's Config holding provider profiles keyed by provider id. */
const PROVIDERS_FIELD = 'providers'

/** Model ids inside a provider profile, as the plugin stores them. */
const MODELS_FIELD = 'models'

/** One provider profile as the settings document holds it. */
type ProviderProfile = Record<string, unknown>

/** One model entry inside a provider profile. */
type ModelEntry = Record<string, unknown>

/** Model configuration read from, or written to, the local settings document. */
export interface ModelSettingsSnapshot {
  /** Providers keyed by provider id. */
  providers: Record<string, ProviderProfile>
  /** Revision the read observed; a write must present it back. */
  revision: number | undefined
}

/** Read a model's stable identity inside a provider profile. */
function modelIdOf(entry: ModelEntry): string | null {
  const id = entry.id
  return typeof id === 'string' && id.trim() !== '' ? id : null
}

/** Narrow an unknown value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Read provider profiles out of a settings value. */
function providersOf(value: unknown): Record<string, ProviderProfile> {
  const root = asRecord(value)
  const providers = root === null ? null : asRecord(root[PROVIDERS_FIELD])
  if (providers === null) return {}
  const result: Record<string, ProviderProfile> = {}
  for (const [providerId, profile] of Object.entries(providers)) {
    const narrowed = asRecord(profile)
    if (narrowed !== null) result[providerId] = narrowed
  }
  return result
}

/**
 * Read the models this workspace currently holds.
 *
 * A missing section is an empty result rather than an error: a fresh workspace has never
 * opened the models page, and that is the normal state for the first user to arrive.
 * @param ctx - DSH Host context carrying the settings service.
 * @returns Provider profiles and the revision the read observed.
 */
export function readModels(ctx: Context): ModelSettingsSnapshot {
  const descriptor = ctx.settings.describe().find((entry: SettingsEntry) => entry.ns === MODEL_SETTINGS_NAMESPACE)
  if (descriptor === undefined) return { providers: {}, revision: undefined }
  return { providers: providersOf(descriptor.value), revision: descriptor.revision }
}

/**
 * Collect every model id a workspace holds, grouped by provider.
 * @param providers - Provider profiles to walk.
 * @returns Model ids offered by each provider.
 */
export function modelIdsByProvider(providers: Record<string, ProviderProfile>): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [providerId, profile] of Object.entries(providers)) {
    const models = profile[MODELS_FIELD]
    if (!Array.isArray(models)) continue
    result[providerId] = models
      .map((entry) => asRecord(entry))
      .filter((entry): entry is ModelEntry => entry !== null)
      .map((entry) => modelIdOf(entry))
      .filter((id): id is string => id !== null)
  }
  return result
}

/**
 * Narrow published providers to the models their publisher offers.
 *
 * The publisher decides which of its models other users may use; a model it kept private is
 * dropped here, so it is never written into a reader's settings at all.
 * @param providers - Published provider profiles.
 * @param sharedModelIds - Model ids the publisher offers.
 * @returns Providers holding only the offered models.
 */
export function selectSharedModels(
  providers: Record<string, ProviderProfile>,
  sharedModelIds: readonly string[],
): Record<string, ProviderProfile> {
  const offered = new Set(sharedModelIds)
  if (offered.size === 0) return {}
  const result: Record<string, ProviderProfile> = {}
  for (const [providerId, profile] of Object.entries(providers)) {
    const models = profile[MODELS_FIELD]
    if (!Array.isArray(models)) continue
    const kept = models.filter((entry) => {
      const narrowed = asRecord(entry)
      const id = narrowed === null ? null : modelIdOf(narrowed)
      return id !== null && offered.has(id)
    })
    if (kept.length === 0) continue
    result[providerId] = { ...profile, [MODELS_FIELD]: kept }
  }
  return result
}

/**
 * Merge adopted provider profiles into the ones a workspace already holds.
 *
 * A provider the user already has keeps its own models and gains the adopted ones that are
 * missing, so adopting never removes a model the user configured. The user's own entry for a
 * model wins on conflict: that is what keeps a local edit from being overwritten.
 * @param local - Providers the workspace holds now.
 * @param adopted - Providers the publisher offers.
 * @returns Providers to write, and whether anything changed.
 */
export function mergeProviders(
  local: Record<string, ProviderProfile>,
  adopted: Record<string, ProviderProfile>,
): { providers: Record<string, ProviderProfile>; changed: boolean } {
  const result: Record<string, ProviderProfile> = { ...local }
  let changed = false
  for (const [providerId, adoptedProfile] of Object.entries(adopted)) {
    const adoptedModels = Array.isArray(adoptedProfile[MODELS_FIELD])
      ? adoptedProfile[MODELS_FIELD] as unknown[]
      : []
    const localProfile = result[providerId]
    if (localProfile === undefined) {
      result[providerId] = adoptedProfile
      changed = changed || adoptedModels.length > 0
      continue
    }
    const localModels = Array.isArray(localProfile[MODELS_FIELD])
      ? localProfile[MODELS_FIELD] as unknown[]
      : []
    const localIds = new Set(
      localModels
        .map((entry) => asRecord(entry))
        .filter((entry): entry is ModelEntry => entry !== null)
        .map((entry) => modelIdOf(entry))
        .filter((id): id is string => id !== null),
    )
    const missing = adoptedModels.filter((entry) => {
      const narrowed = asRecord(entry)
      const id = narrowed === null ? null : modelIdOf(narrowed)
      return id !== null && !localIds.has(id)
    })
    if (missing.length === 0) continue
    result[providerId] = { ...localProfile, [MODELS_FIELD]: [...localModels, ...missing] }
    changed = true
  }
  return { providers: result, changed }
}

/**
 * Write provider profiles into this workspace's settings.
 *
 * The write presents the revision the read observed. A settings service that has moved on
 * refuses it with its own conflict error, which the caller surfaces rather than retrying:
 * silently overwriting a concurrent edit is exactly what this feature must not do.
 * @param ctx - DSH Host context carrying the settings service.
 * @param providers - Providers to store.
 * @param revision - Revision from the read this write is based on.
 */
export async function writeModels(
  ctx: Context,
  providers: Record<string, ProviderProfile>,
  revision: number | undefined,
): Promise<void> {
  await ctx.settings.update(MODEL_SETTINGS_NAMESPACE, { [PROVIDERS_FIELD]: providers }, revision)
}
