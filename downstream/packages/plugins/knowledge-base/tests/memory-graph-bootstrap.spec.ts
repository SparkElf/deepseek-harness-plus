import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensurePersonalMemoryGraph,
  PERSONAL_MEMORY_GRAPH_ID,
  readPersonalMemoryGraph,
} from '../src/memoryGraphBootstrap.ts'
import { loadGraph, validateGraph } from '../src/graphModel.ts'

const roots: string[] = []
async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kb-memory-graph-'))
  roots.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('personal memory graph bootstrap', () => {
  it('creates an empty, private, published manifest', async () => {
    const root = await tempRoot()
    const result = await ensurePersonalMemoryGraph({ scopeRoot: root, userId: 'u1', now: '2026-11-12T18:00:00+08:00' })
    expect(result.created).toBe(true)
    expect(result.path).toBe(join(root, '.graphs', PERSONAL_MEMORY_GRAPH_ID, 'graph.json'))
    const manifest = await readPersonalMemoryGraph(root)
    expect(manifest).toMatchObject({
      id: PERSONAL_MEMORY_GRAPH_ID,
      name: '个人记忆图谱',
      scope: 'personal:u1',
      owner: 'u1',
      visibility: 'private',
      status: 'published',
      nodes: [],
      edges: [],
    })
    const loaded = await loadGraph(root, PERSONAL_MEMORY_GRAPH_ID)
    expect(loaded.nodes).toEqual([])
    expect(loaded.edges).toEqual([])
    expect(validateGraph(loaded)).toEqual([])
  })

  it('is idempotent and never overwrites an existing graph', async () => {
    const root = await tempRoot()
    const first = await ensurePersonalMemoryGraph({ scopeRoot: root, userId: 'u1', now: '2026-11-12T18:00:00+08:00' })
    const second = await ensurePersonalMemoryGraph({ scopeRoot: root, userId: 'u1', now: '2026-11-12T19:00:00+08:00' })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect((await readPersonalMemoryGraph(root))?.createdAt).toBe('2026-11-12T18:00:00+08:00')
  })

  it('refuses an unsafe user id instead of escaping the scope', async () => {
    const root = await tempRoot()
    await expect(ensurePersonalMemoryGraph({ scopeRoot: root, userId: '../x' })).rejects.toThrow(/unsafe userId/)
  })
})
