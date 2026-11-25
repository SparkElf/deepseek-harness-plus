/**
 * Settings the workspace takes as defaults from an administrator's publication.
 *
 * The model sync owns the models. This module owns every other namespace the deployment chooses
 * to distribute, and it follows the same contract: a workspace takes the published values once,
 * and from the first value its user writes it keeps its own and is never overwritten again.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'

/** One settings namespace offered by a publication. */
export interface PublishedSection {
  /** DSH settings namespace, such as `permission`. */
  ns: string
  /** The section's values at publication time. */
  value: Record<string, unknown>
}

/** One entry the settings service reports. */
interface SettingsEntry {
  /** Profile entry id the entry belongs to. */
  ns: string
  /** Config values the entry currently resolves to. */
  value: unknown
  /** Revision a write must present back. */
  revision: number
}

/** Whether this workspace still follows the publisher for one namespace. */
export type SectionFollowState = 'following' | 'detached'

/** One distributed namespace as the settings UI reads it. */
export interface DistributedSectionStatus {
  /** DSH settings namespace. */
  ns: string
  /** Whether this workspace still takes the publisher's values for it. */
  followState: SectionFollowState
  /** Whether adoption has applied values for it. */
  applied: boolean
  /** Whether a plugin in this workspace owns the namespace, so applying it would do something. */
  mounted: boolean
}

/** Per-namespace bookkeeping this workspace keeps. */
export interface SectionSyncRecord {
  /** Whether the user here wrote this namespace, so adoption stops for it. */
  detached: boolean
  /** A fingerprint of what adoption last wrote, so a later edit can be told apart from it. */
  adoptedFingerprint: string | null
}

/** What this workspace remembers about distributed settings. */
export interface SectionSyncState {
  /** Bookkeeping keyed by settings namespace. */
  sections: Record<string, SectionSyncRecord>
}

/** Default state before this workspace stored anything. */
export const SECTION_SYNC_DEFAULT: SectionSyncState = { sections: {} }

/** Read and write this workspace's section-sync state. */
export interface SectionSyncStore {
  /** @returns The stored state, or defaults before anything was stored. */
  read(): SectionSyncState
  /** @param next - State to store. */
  write(next: SectionSyncState): Promise<void>
}

/** Narrow an unknown value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * A stable rendering of one section's values.
 *
 * Key order is normalized so two reads of the same values match, and a publication that only
 * reordered its keys does not read as a change the user made.
 * @param value - Section values.
 * @returns A fingerprint comparable across reads.
 */
export function fingerprintSection(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort()
  const normalized: Record<string, unknown> = {}
  for (const key of keys) normalized[key] = value[key]
  return JSON.stringify(normalized)
}

/**
 * Own the distributed settings one workspace keeps.
 *
 * The state lives in this workspace rather than in DataOps because whether a user has written
 * their own values is a fact about this workspace, and keeping it here is what makes the promise
 * hold across restarts: a user who chose their own settings is not adopted again.
 */
export class SettingsSync {
  constructor(
    private readonly ctx: Context,
    private readonly store: SectionSyncStore,
  ) {}

  /**
   * Read one namespace as this workspace currently holds it.
   * @param ns - Settings namespace to read.
   * @returns The values and revision, or undefined when no plugin owns that namespace.
   */
  private readSection(ns: string): { value: Record<string, unknown>; revision: number } | undefined {
    const descriptor = this.ctx.settings.describe().find((entry: SettingsEntry) => entry.ns === ns)
    if (descriptor === undefined) return undefined
    const value = asRecord(descriptor.value)
    if (value === null) return undefined
    return { value, revision: descriptor.revision }
  }

  /** Read this workspace's per-namespace bookkeeping. */
  private recordOf(state: SectionSyncState, ns: string): SectionSyncRecord {
    return state.sections[ns] ?? { detached: false, adoptedFingerprint: null }
  }

  /**
   * Take the published values for every namespace this workspace has not already diverged from.
   *
   * A namespace the user has written is skipped and marked detached, so a local edit is never
   * replaced. A namespace whose current values match what adoption last wrote is still following,
   * so the publisher's newer values replace them. Everything else is a default a user may change.
   * @param sections - Sections the publisher offers.
   * @returns Namespaces that were written, for logging.
   */
  async adopt(sections: readonly PublishedSection[]): Promise<string[]> {
    const state = this.store.read()
    const next: SectionSyncState = { sections: { ...state.sections } }
    const written: string[] = []
    let stateChanged = false

    for (const section of sections) {
      const record = this.recordOf(state, section.ns)
      if (record.detached) continue
      const current = this.readSection(section.ns)
      // A namespace no mounted plugin owns cannot be written; skipping it keeps a publication
      // for a plugin this deployment does not run from failing the whole adoption.
      if (current === undefined) continue
      const currentFingerprint = fingerprintSection(current.value)
      const publishedFingerprint = fingerprintSection(section.value)
      if (record.adoptedFingerprint !== null && currentFingerprint !== record.adoptedFingerprint) {
        // The workspace moved away from what adoption wrote, so this user has their own values.
        next.sections[section.ns] = { detached: true, adoptedFingerprint: record.adoptedFingerprint }
        stateChanged = true
        continue
      }
      if (currentFingerprint === publishedFingerprint) {
        if (record.adoptedFingerprint !== publishedFingerprint) {
          next.sections[section.ns] = { detached: false, adoptedFingerprint: publishedFingerprint }
          stateChanged = true
        }
        continue
      }
      await this.ctx.settings.update(section.ns, section.value)
      next.sections[section.ns] = { detached: false, adoptedFingerprint: publishedFingerprint }
      stateChanged = true
      written.push(section.ns)
    }

    if (stateChanged) await this.store.write(next)
    return written
  }

  /**
   * Describe the distributed settings for the settings UI.
   *
   * Reports every namespace the deployment offers, whether this workspace still follows the
   * publisher for it, and whether a plugin here owns it. A namespace no plugin owns cannot be
   * applied, so a panel marks that row rather than offering a control that would do nothing.
   * @param namespaces - Namespaces the deployment distributes.
   * @returns One entry per namespace, in the order given.
   */
  status(namespaces: readonly string[]): DistributedSectionStatus[] {
    const state = this.store.read()
    return namespaces.map((ns) => {
      const record = this.recordOf(state, ns)
      return {
        ns,
        followState: record.detached ? 'detached' as const : 'following' as const,
        applied: record.adoptedFingerprint !== null,
        mounted: this.readSection(ns) !== undefined,
      }
    })
  }

  /**
   * Stop following the publisher for one namespace and keep what this workspace holds now.
   * @param ns - Settings namespace to detach.
   */
  async detach(ns: string): Promise<void> {
    const state = this.store.read()
    const record = this.recordOf(state, ns)
    await this.store.write({
      sections: { ...state.sections, [ns]: { ...record, detached: true } },
    })
  }
}
