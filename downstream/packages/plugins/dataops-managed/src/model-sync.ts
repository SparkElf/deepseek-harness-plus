/** Adopt, publish, and stop following the model configuration another workspace offers. */

import type { Context } from '@deepseek-ai/cordis'
import { noteAccepted, noteExpired } from './auth-state.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type { PublishedSection } from './settings-sync.ts'
import {
  mergeProviders,
  modelIdsByProvider,
  readModels,
  selectSharedModels,
  writeModels,
} from './model-settings.ts'

/** This plugin's own profile entry id, which owns the sync state. */
export const SYNC_NAMESPACE = 'dataops-managed'

/** Whether this workspace follows the publisher, or keeps what its user wrote. */
export type FollowState = 'following' | 'detached'

/** What this workspace remembers between runs. */
export interface SyncState {
  /** The user here chose their own models, so adoption stops for them. */
  detached: boolean
  /** Model ids adoption last wrote, so a later edit can be told apart from one of them. */
  adoptedModelIds: string[]
  /** Model ids the administrator keeps private; every other model is offered by default. */
  privateModelIds: string[]
}

/** Read and write this workspace's sync state. */
export interface SyncStateStore {
  /** @returns The stored state, or defaults before anything was stored. */
  read(): SyncState
  /** @param next - State to store. */
  write(next: SyncState): Promise<void>
}

/** Configuration the host half receives from the profile. */
export interface SyncConfig {
  /** DataOps browser/API origin reachable from the DSH Host. */
  baseUrl: string
  /** DSH credential reference holding the current DataOps access JWT. */
  credentialRef: string
  /**
   * Collect the settings sections this workspace offers to others.
   *
   * Injected rather than read here because which namespaces travel is a deployment decision:
   * this class carries a publication, and the deployment decides what belongs in one.
   * @returns The sections to publish, in the order they should be applied.
   */
  collectSections?: () => Promise<PublishedSection[]>
}

/** What the settings UI reads to describe the current state. */
export interface SyncStatus {
  /** Whether this workspace currently follows a publisher. */
  followState: FollowState
  /** Whether an administrator currently offers models to this workspace. */
  publisherSharing: boolean
  /** How many models this workspace adopts from the publisher. */
  adoptedCount: number
  /** Model ids the administrator keeps private. */
  privateModelIds: string[]
  /** Publication time reported by the publisher, when one is sharing. */
  publishedAt: string | null
  /** Whether the current user may change what this workspace shares. */
  canPublish: boolean
  /** Models this workspace holds, and whether each is offered to other users. */
  models: { id: string; shared: boolean }[]
}

/** Publication a workspace may adopt, as the DataOps API reports it. */
interface PublishedSnapshot {
  sharingEnabled: boolean
  payload: {
    providers: Record<string, Record<string, unknown>>
    sharedModelIds: string[]
    sections?: PublishedSection[]
  }
  updatedAt: string | null
}

/** Narrow an unknown value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Own the model-sync state one workspace keeps.
 *
 * The state lives in this workspace rather than in DataOps, because whether a user has written
 * their own models is a fact about this workspace. Keeping it here is also what makes the
 * promise hold across restarts: a user who chose their own models is not adopted again.
 */
export class ModelSync {
  constructor(
    private readonly ctx: Context,
    private readonly config: SyncConfig,
    private readonly store: SyncStateStore,
  ) {}

  /**
   * Read the DataOps JWT this workspace is currently authorized with.
   * @returns The token, or undefined when the workspace has no session yet.
   */
  private async token(): Promise<string | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.credentialRef))
    return resolved?.value
  }

  /** The DataOps API origin this workspace reports to. */
  private apiBase(): string {
    return new URL(this.config.baseUrl).origin
  }

  /**
   * Fetch the publication this workspace may adopt.
   * @returns The published snapshot, or undefined when the workspace is not authorized.
   */
  private async fetchPublished(): Promise<PublishedSnapshot | undefined> {
    const token = await this.token()
    if (token === undefined) return undefined
    const response = await fetch(new URL('/api/ai/shared-models/published', this.apiBase()), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    if (response.status === 401) {
      noteExpired()
      return undefined
    }
    noteAccepted()
    if (!response.ok) throw new Error(`Shared model read failed with HTTP ${String(response.status)}`)
    const body = asRecord(await response.json())
    if (body === null) return undefined
    const payload = asRecord(body.payload)
    const providers = payload === null ? null : asRecord(payload.providers)
    return {
      sharingEnabled: body.sharingEnabled === true,
      payload: {
        providers: providers === null ? {} : providers as Record<string, Record<string, unknown>>,
        sharedModelIds: Array.isArray(payload?.sharedModelIds)
          ? payload.sharedModelIds.filter((id): id is string => typeof id === 'string')
          : [],
      },
      updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : null,
    }
  }

  /**
   * The models this workspace offers to others.
   *
   * Every model is offered unless the administrator marked it private, which is what makes a
   * newly added model shared without an extra step.
   * @param providers - Providers this workspace holds.
   * @param privateModelIds - Model ids kept private.
   * @returns Model ids to offer.
   */
  private offeredModelIds(
    providers: Record<string, Record<string, unknown>>,
    privateModelIds: readonly string[],
  ): string[] {
    const held = Object.values(modelIdsByProvider(providers)).flat()
    const privateIds = new Set(privateModelIds)
    return held.filter((id) => !privateIds.has(id))
  }

  /**
   * Report this workspace's models to DataOps as a publication.
   *
   * Called when an administrator turns sharing on, or edits their models while it is on. The
   * workspace stays the owner of the configuration; DataOps stores only this copy.
   * @param sharingEnabled - Whether sharing is on.
   */
  async publish(sharingEnabled: boolean): Promise<void> {
    const token = await this.token()
    if (token === undefined) throw new Error('This workspace has no DataOps session to publish with')
    const state = this.store.read()
    const current = readModels(this.ctx)
    const response = await fetch(new URL('/api/ai/shared-models/publication', this.apiBase()), {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        sharingEnabled,
        providers: current.providers,
        sharedModelIds: this.offeredModelIds(current.providers, state.privateModelIds),
        sections: await this.config.collectSections?.() ?? [],
      }),
    })
    if (!response.ok) throw new Error(`Shared model publish failed with HTTP ${String(response.status)}`)
  }

  /**
   * Read the current user's own publication state and whether they may change it.
   *
   * The permission rule lives in DataOps; the browser only displays what this reports, so
   * nothing in the page decides who is an administrator.
   * @returns The state, or null when the workspace is not authorized.
   */
  async readOwnState(): Promise<{ sharingEnabled: boolean; canPublish: boolean } | null> {
    const token = await this.token()
    if (token === undefined) return null
    const response = await fetch(new URL('/api/ai/shared-models/publication', this.apiBase()), {
      headers: { authorization: `Bearer ${token}` },
    })
    if (response.status === 401) {
      noteExpired()
      return null
    }
    noteAccepted()
    if (!response.ok) throw new Error(`Shared model status read failed with HTTP ${String(response.status)}`)
    const body = asRecord(await response.json())
    return {
      sharingEnabled: body?.sharingEnabled === true,
      canPublish: body?.canPublish === true,
    }
  }

  /**
   * Record which models the administrator keeps private.
   * @param privateModelIds - Model ids not offered to other users.
   * @param sharingEnabled - Whether sharing is on, so the change reaches readers now.
   */
  async setPrivateModels(privateModelIds: readonly string[], sharingEnabled: boolean): Promise<void> {
    const state = this.store.read()
    await this.store.write({ ...state, privateModelIds: [...new Set(privateModelIds)] })
    if (sharingEnabled) await this.publish(true)
  }

  /**
   * Adopt the published models into this workspace.
   *
   * Does nothing when the user here writes their own models, which is what keeps a local edit
   * from being replaced by the publisher's version. Otherwise it merges: models the workspace
   * lacks are added, and a model it already holds is left exactly as it is.
   * @returns Adopted provider profiles, or null when nothing was adopted.
   */
  async adopt(): Promise<Record<string, Record<string, unknown>> | null> {
    const state = this.store.read()
    if (state.detached) return null
    const published = await this.fetchPublished()
    if (published === undefined || !published.sharingEnabled) return null
    const offered = selectSharedModels(published.payload.providers, published.payload.sharedModelIds)
    if (Object.keys(offered).length === 0) return null
    const offeredIds = [...new Set(Object.values(modelIdsByProvider(offered)).flat())]
    const current = readModels(this.ctx)
    if (this.editedSinceAdoption(current.providers, state.adoptedModelIds)) {
      await this.store.write({ ...state, detached: true })
      return null
    }
    const merged = mergeProviders(current.providers, offered)
    if (merged.changed) await writeModels(this.ctx, merged.providers, current.revision)
    await this.store.write({ ...state, adoptedModelIds: offeredIds })
    return offered
  }

  /**
   * Whether this workspace holds models adoption did not put there.
   *
   * A model the workspace has now and adoption did not write is the user's own, so adopting
   * again would discard their work. An empty record means adoption never ran here, and the
   * first pass must not read the workspace's existing models as an edit.
   * @param current - Providers the workspace holds now.
   * @param adoptedModelIds - Model ids adoption last wrote.
   * @returns True when the workspace holds something adoption did not write.
   */
  private editedSinceAdoption(
    current: Record<string, Record<string, unknown>>,
    adoptedModelIds: readonly string[],
  ): boolean {
    if (adoptedModelIds.length === 0) return false
    const adopted = new Set(adoptedModelIds)
    const currentIds = Object.values(modelIdsByProvider(current)).flat()
    return currentIds.some((id) => !adopted.has(id))
  }

  /**
   * Stop following the publisher and keep what this workspace holds now.
   *
   * A user who chose their own models must not be pulled back, so this choice is stored and
   * survives the next start.
   */
  async detach(): Promise<void> {
    await this.store.write({ ...this.store.read(), detached: true })
  }

  /**
   * Read the settings sections the current publication offers.
   *
   * Separate from `adopt`, which owns the models: a workspace adopts models and settings from one
   * publication but keeps separate bookkeeping for each, because a user who changed the permission
   * default has not thereby chosen their own models.
   * @returns The offered sections, or an empty list when nobody publishes or none are offered.
   */
  async readPublishedSections(): Promise<PublishedSection[]> {
    try {
      const published = await this.fetchPublished()
      if (published === undefined || !published.sharingEnabled) return []
      return published.payload.sections ?? []
    } catch (error) {
      // A publication that cannot be read must not stop the models from being adopted, which is
      // what the caller does next; it retries on the following start.
      void error
      return []
    }
  }

  /**
   * Follow the publisher again, adopting its models on the next pass.
   */
  async resumeFollowing(): Promise<void> {
    await this.store.write({ ...this.store.read(), detached: false })
  }

  /**
   * Describe the current state for the settings UI.
   * @returns The sync state, whether the viewer may publish, and their own models.
   */
  async status(): Promise<SyncStatus> {
    const state = this.store.read()
    const own = await this.readOwnState()
    const published = await this.fetchPublished()
    const offered = published === undefined || !published.sharingEnabled
      ? {}
      : selectSharedModels(published.payload.providers, published.payload.sharedModelIds)
    const held = [...new Set(Object.values(modelIdsByProvider(readModels(this.ctx).providers)).flat())]
    const privateIds = new Set(state.privateModelIds)
    return {
      followState: state.detached ? 'detached' : 'following',
      publisherSharing: published?.sharingEnabled === true,
      adoptedCount: Object.values(modelIdsByProvider(offered)).flat().length,
      privateModelIds: state.privateModelIds,
      publishedAt: published?.updatedAt ?? null,
      canPublish: own?.canPublish === true,
      models: held.map((id) => ({ id, shared: !privateIds.has(id) })),
    }
  }
}
