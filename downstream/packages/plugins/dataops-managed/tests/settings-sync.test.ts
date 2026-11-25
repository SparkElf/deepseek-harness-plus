/** Behavior the settings distribution promises: take once, then never overwrite a user's edit. */

import { describe, expect, it } from 'vitest'
import { SettingsSync, fingerprintSection } from '../src/settings-sync.ts'
import type { PublishedSection, SectionSyncState, SectionSyncStore } from '../src/settings-sync.ts'

/** One namespace as the settings service reports it, keyed by name. */
type SectionValues = Record<string, Record<string, unknown>>

/**
 * Build a context whose settings service serves the given namespaces.
 *
 * Only the two calls this class makes are implemented: `describe` for the namespaces it can
 * write, and `update` for the write itself, which records into the map so a later read sees it.
 */
const contextFor = (values: SectionValues) => {
  const revision = { current: 1 }
  return {
    settings: {
      describe: () => Object.entries(values).map(([ns, value]) => ({
        ns,
        value,
        revision: revision.current,
      })),
      update: async (ns: string, patch: Record<string, unknown>) => {
        values[ns] = { ...(values[ns] ?? {}), ...patch }
        revision.current += 1
      },
    },
  }
}

/** In-memory store standing in for the workspace's settings document. */
const storeFor = (initial: SectionSyncState = { sections: {} }): SectionSyncStore => {
  let state = initial
  return {
    read: () => state,
    write: async (next) => { state = next },
  }
}

/** One offered namespace. */
const section = (ns: string, value: Record<string, unknown>): PublishedSection => ({ ns, value })

describe('fingerprintSection', () => {
  it('ignores key order so a reordered publication is not read as an edit', () => {
    expect(fingerprintSection({ a: 1, b: 2 })).toBe(fingerprintSection({ b: 2, a: 1 }))
  })

  it('separates sections whose values differ', () => {
    expect(fingerprintSection({ a: 1 })).not.toBe(fingerprintSection({ a: 2 }))
  })
})

describe('SettingsSync.adopt', () => {
  it('writes a namespace the workspace has not diverged from', async () => {
    const values: SectionValues = { permission: { defaultPreset: 'workspace-write' } }
    const sync = new SettingsSync(contextFor(values) as never, storeFor())

    const written = await sync.adopt([section('permission', { defaultPreset: 'danger-full-access' })])

    expect(written).toEqual(['permission'])
    expect(values.permission).toEqual({ defaultPreset: 'danger-full-access' })
  })

  it('skips a namespace no mounted plugin owns', async () => {
    const values: SectionValues = {}
    const sync = new SettingsSync(contextFor(values) as never, storeFor())

    const written = await sync.adopt([section('absent', { a: 1 })])

    expect(written).toEqual([])
    expect(values).toEqual({})
  })

  it('leaves a namespace alone once the user has written it', async () => {
    const values: SectionValues = { permission: { defaultPreset: 'read-only' } }
    const store = storeFor()
    const sync = new SettingsSync(contextFor(values) as never, store)

    // First pass adopts, so the plugin knows what it wrote.
    await sync.adopt([section('permission', { defaultPreset: 'danger-full-access' })])
    expect(values.permission).toEqual({ defaultPreset: 'danger-full-access' })

    // The user then chooses their own value.
    values.permission = { defaultPreset: 'workspace-write' }

    // A later publication must not replace it.
    const written = await sync.adopt([section('permission', { defaultPreset: 'read-only' })])

    expect(written).toEqual([])
    expect(values.permission).toEqual({ defaultPreset: 'workspace-write' })
    expect(store.read().sections.permission?.detached).toBe(true)
  })

  it('replaces what adoption wrote when the publisher offers newer values', async () => {
    const values: SectionValues = { permission: { defaultPreset: 'danger-full-access' } }
    const store = storeFor()
    const sync = new SettingsSync(contextFor(values) as never, store)

    await sync.adopt([section('permission', { defaultPreset: 'danger-full-access' })])
    const written = await sync.adopt([section('permission', { defaultPreset: 'workspace-write' })])

    expect(written).toEqual(['permission'])
    expect(values.permission).toEqual({ defaultPreset: 'workspace-write' })
    expect(store.read().sections.permission?.detached).toBe(false)
  })

  it('tracks each namespace separately', async () => {
    const values: SectionValues = { permission: { a: 1 }, general: { b: 1 } }
    const store = storeFor()
    const sync = new SettingsSync(contextFor(values) as never, store)

    await sync.adopt([section('permission', { a: 1 }), section('general', { b: 1 })])
    // The user changes only the permission default.
    values.permission = { a: 2 }

    const written = await sync.adopt([section('permission', { a: 1 }), section('general', { b: 2 })])

    // The namespace the user touched stays theirs; the untouched one still follows.
    expect(written).toEqual(['general'])
    expect(values.permission).toEqual({ a: 2 })
    expect(values.general).toEqual({ b: 2 })
  })

  it('does not rewrite a namespace whose values already match', async () => {
    const values: SectionValues = { permission: { defaultPreset: 'danger-full-access' } }
    const sync = new SettingsSync(contextFor(values) as never, storeFor())

    const written = await sync.adopt([section('permission', { defaultPreset: 'danger-full-access' })])

    expect(written).toEqual([])
  })
})

describe('SettingsSync.status', () => {
  it('reports a mounted namespace the workspace still follows', async () => {
    const values: SectionValues = { permission: { a: 1 } }
    const sync = new SettingsSync(contextFor(values) as never, storeFor())

    expect(sync.status(['permission'])).toEqual([
      { ns: 'permission', followState: 'following', applied: false, mounted: true },
    ])
  })

  it('marks a namespace no plugin owns, so a row for it is not offered as applicable', () => {
    const sync = new SettingsSync(contextFor({}) as never, storeFor())

    expect(sync.status(['absent'])).toEqual([
      { ns: 'absent', followState: 'following', applied: false, mounted: false },
    ])
  })

  it('reports applied and detached after adoption and a detach', async () => {
    const values: SectionValues = { permission: { a: 1 } }
    const sync = new SettingsSync(contextFor(values) as never, storeFor())

    await sync.adopt([section('permission', { a: 2 })])
    expect(sync.status(['permission'])).toEqual([
      { ns: 'permission', followState: 'following', applied: true, mounted: true },
    ])

    await sync.detach('permission')
    expect(sync.status(['permission'])).toEqual([
      { ns: 'permission', followState: 'detached', applied: true, mounted: true },
    ])
  })
})

describe('SettingsSync.detach', () => {
  it('stops a later publication from replacing what the workspace holds', async () => {
    const values: SectionValues = { permission: { defaultPreset: 'workspace-write' } }
    const store = storeFor()
    const sync = new SettingsSync(contextFor(values) as never, store)

    await sync.detach('permission')
    const written = await sync.adopt([section('permission', { defaultPreset: 'read-only' })])

    expect(written).toEqual([])
    expect(values.permission).toEqual({ defaultPreset: 'workspace-write' })
  })
})
