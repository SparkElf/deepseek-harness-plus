import { describe, expect, it, vi } from 'vitest'
import {
  mergeProviders,
  modelIdsByProvider,
  selectSharedModels,
} from '../src/model-settings.ts'
import { ModelSync } from '../src/model-sync.ts'
import type { SyncState } from '../src/model-sync.ts'

/** Build a provider profile holding the named models. */
const provider = (...ids: string[]) => ({
  displayName: 'Provider',
  apiKeyEnv: 'OPENAI_API_KEY',
  models: ids.map((id) => ({ id, name: id })),
})

/** Collect the model ids a provider record holds. */
const idsOf = (providers: Record<string, Record<string, unknown>>) =>
  Object.values(modelIdsByProvider(providers)).flat().sort()

describe('selectSharedModels', () => {
  it('keeps only the models the publisher offers', () => {
    const offered = selectSharedModels({ p: provider('a', 'b', 'c') }, ['a', 'c'])
    expect(idsOf(offered)).toEqual(['a', 'c'])
  })

  it('returns nothing when the publisher offers nothing', () => {
    expect(selectSharedModels({ p: provider('a') }, [])).toEqual({})
  })

  it('drops a provider whose models are all private', () => {
    expect(selectSharedModels({ p: provider('a'), q: provider('b') }, ['b'])).toEqual({
      q: provider('b'),
    })
  })
})

describe('mergeProviders', () => {
  it('adds an adopted provider the workspace does not have', () => {
    const merged = mergeProviders({}, { p: provider('a') })
    expect(merged.changed).toBe(true)
    expect(idsOf(merged.providers)).toEqual(['a'])
  })

  it('keeps the model the user already configured and adds the missing one', () => {
    const merged = mergeProviders(
      { p: provider('a') },
      { p: provider('a', 'b') },
    )
    expect(idsOf(merged.providers)).toEqual(['a', 'b'])
    expect(merged.changed).toBe(true)
  })

  it('leaves the user version of a model untouched', () => {
    const local = { p: { models: [{ id: 'a', name: 'My name', contextWindow: 4096 }] } }
    const adopted = { p: { models: [{ id: 'a', name: 'Admin name', contextWindow: 1000000 }] } }
    const merged = mergeProviders(local, adopted)
    expect(merged.changed).toBe(false)
    expect((merged.providers.p.models as { name: string }[])[0].name).toBe('My name')
  })

  it('never removes a model the user added', () => {
    const merged = mergeProviders({ p: provider('mine') }, { p: provider('theirs') })
    expect(idsOf(merged.providers)).toEqual(['mine', 'theirs'])
  })

  it('reports no change when everything is already present', () => {
    const merged = mergeProviders({ p: provider('a', 'b') }, { p: provider('a', 'b') })
    expect(merged.changed).toBe(false)
  })
})

describe('ModelSync adoption', () => {
  /** A sync instance whose DataOps calls are stubbed, with the state it reports. */
  const makeSync = (options: {
    published?: { sharingEnabled: boolean; payload: { providers: Record<string, Record<string, unknown>>; sharedModelIds: string[] }; updatedAt: string | null }
    local?: Record<string, Record<string, unknown>>
    state?: Partial<SyncState>
  }) => {
    const local = { providers: options.local ?? {}, revision: 3 }
    const stored: SyncState = {
      detached: false,
      adoptedModelIds: [],
      privateModelIds: [],
      ...options.state,
    }
    const writes: Record<string, Record<string, unknown>>[] = []
    const ctx = {
      credentials: { resolve: async () => ({ value: 'token', source: 'test' }) },
      settings: {
        describe: () => [{ ns: 'llm-pi-ai', value: local, revision: 3 }],
        update: vi.fn(async (_ns: string, patch: { providers?: Record<string, Record<string, unknown>> }) => {
          if (patch.providers !== undefined) writes.push(patch.providers)
        }),
      },
      logger: { warn: vi.fn(), info: vi.fn() },
    } as never
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(
      options.published ?? { sharingEnabled: false, payload: { providers: {}, sharedModelIds: [] }, updatedAt: null },
    ), { status: 200, headers: { 'content-type': 'application/json' } })))
    const sync = new ModelSync(ctx, { baseUrl: 'http://dataops.test', credentialRef: 'DATAOPS' }, {
      read: () => stored,
      write: async (next) => { Object.assign(stored, next) },
    })
    return { sync, stored, writes }
  }

  it('adopts the publisher models into an empty workspace', async () => {
    const { sync, writes, stored } = makeSync({
      published: {
        sharingEnabled: true,
        payload: { providers: { p: provider('shared') }, sharedModelIds: ['shared'] },
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    await sync.adopt()
    expect(writes).toHaveLength(1)
    expect(idsOf(writes[0])).toEqual(['shared'])
    expect(stored.adoptedModelIds).toEqual(['shared'])
  })

  it('does not adopt once the user wrote their own models', async () => {
    const { sync, writes } = makeSync({
      local: { p: provider('inline') },
      state: { detached: true },
      published: {
        sharingEnabled: true,
        payload: { providers: { p: provider('shared') }, sharedModelIds: ['shared'] },
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    await sync.adopt()
    expect(writes).toHaveLength(0)
  })

  it('stops following when the workspace holds a model adoption did not write', async () => {
    const { sync, writes, stored } = makeSync({
      local: { p: provider('shared', 'mine') },
      state: { adoptedModelIds: ['shared'] },
      published: {
        sharingEnabled: true,
        payload: { providers: { p: provider('shared', 'second') }, sharedModelIds: ['shared', 'second'] },
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    await sync.adopt()
    expect(writes).toHaveLength(0)
    expect(stored.detached).toBe(true)
  })

  it('adopts a newly shared model while the workspace is unchanged', async () => {
    const { sync, writes } = makeSync({
      local: { p: provider('shared') },
      state: { adoptedModelIds: ['shared'] },
      published: {
        sharingEnabled: true,
        payload: { providers: { p: provider('shared', 'second') }, sharedModelIds: ['shared', 'second'] },
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    await sync.adopt()
    expect(writes).toHaveLength(1)
    expect(idsOf(writes[0])).toEqual(['second', 'shared'])
  })

  it('does nothing while no administrator is sharing', async () => {
    const { sync, writes } = makeSync({ published: { sharingEnabled: false, payload: { providers: {}, sharedModelIds: [] }, updatedAt: null } })
    await sync.adopt()
    expect(writes).toHaveLength(0)
  })
})
