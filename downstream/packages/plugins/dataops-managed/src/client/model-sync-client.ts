/** Same-origin model-sync calls from the DataOps settings surface. */

/** Route the plugin's Host half serves for model sharing. */
export const MODEL_SYNC_PATH = 'integrations/dataops/model-sync'

/** One model this workspace holds, and whether it is offered to other users. */
export interface ModelSyncModel {
  /** Model id as the settings document stores it. */
  id: string
  /** Whether other users may use it. */
  shared: boolean
}

/** Model sharing as this workspace currently stands. */
export interface ModelSyncStatus {
  /** Whether this workspace follows a publisher. */
  followState: 'following' | 'detached'
  /** Whether an administrator currently shares models. */
  publisherSharing: boolean
  /** How many models this workspace adopts from the publisher. */
  adoptedCount: number
  /** Model ids kept private. */
  privateModelIds: string[]
  /** Publication time, when one is sharing. */
  publishedAt: string | null
  /** Whether the current user may change what this workspace shares. */
  canPublish: boolean
  /** Models this workspace holds. */
  models: ModelSyncModel[]
  /**
   * Settings namespaces this deployment distributes.
   *
   * Present with the models in one response, so the two rows describe the same publication.
   */
  sections: DistributedSection[]
}

/** One settings namespace the deployment distributes. */
export interface DistributedSection {
  /** DSH settings namespace, such as `permission`. */
  ns: string
  /** Whether this workspace still takes the publisher's values for it. */
  followState: 'following' | 'detached'
  /** Whether adoption has applied values for it. */
  applied: boolean
  /** Whether a plugin here owns the namespace, so stopping would affect this workspace. */
  mounted: boolean
}

/** Narrow a response body to the status shape, rejecting anything else. */
function asStatus(value: unknown): ModelSyncStatus | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.followState !== 'following' && record.followState !== 'detached') return null
  return {
    followState: record.followState,
    publisherSharing: record.publisherSharing === true,
    adoptedCount: typeof record.adoptedCount === 'number' ? record.adoptedCount : 0,
    privateModelIds: Array.isArray(record.privateModelIds)
      ? record.privateModelIds.filter((id): id is string => typeof id === 'string')
      : [],
    publishedAt: typeof record.publishedAt === 'string' ? record.publishedAt : null,
    canPublish: record.canPublish === true,
    models: Array.isArray(record.models)
      ? record.models.flatMap((entry) => {
          if (typeof entry !== 'object' || entry === null) return []
          const model = entry as Record<string, unknown>
          return typeof model.id === 'string' ? [{ id: model.id, shared: model.shared === true }] : []
        })
      : [],
    sections: Array.isArray(record.sections)
      ? record.sections.flatMap((entry): DistributedSection[] => {
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
          const section = entry as Record<string, unknown>
          if (typeof section.ns !== 'string' || section.ns === '') return []
          return [{
            ns: section.ns,
            followState: section.followState === 'detached' ? 'detached' : 'following',
            applied: section.applied === true,
            mounted: section.mounted === true,
          }]
        })
      : [],
  }
}

/**
 * Read the current model sharing state.
 * @returns The status, or null when this workspace is not connected to DataOps.
 */
export async function fetchModelSyncStatus(): Promise<ModelSyncStatus | null> {
  const response = await fetch(MODEL_SYNC_PATH, { headers: { accept: 'application/json' } })
  if (response.status === 503) return null
  if (!response.ok) throw new Error('model sync status failed with HTTP ' + String(response.status))
  return asStatus(await response.json())
}

/**
 * Change what this workspace shares.
 * @param body - Action and its parameters.
 * @returns The status after the change, or null when the plugin is not active.
 */
export async function postModelSyncAction(body: Record<string, unknown>): Promise<ModelSyncStatus | null> {
  const response = await fetch(MODEL_SYNC_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.status === 503) return null
  if (!response.ok) throw new Error('model sync action failed with HTTP ' + String(response.status))
  return asStatus(await response.json())
}
