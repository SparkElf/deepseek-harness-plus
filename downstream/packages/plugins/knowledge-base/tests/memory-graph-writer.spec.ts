import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadGraph, validateGraph } from '../src/graphModel.ts'
import {
  MemoryGraphWriter,
  MemoryGraphWriterError,
  PERSONAL_MEMORY_GRAPH_ID,
  syncPersonalMemoryGraph,
} from '../src/memoryGraphWriter.ts'
import { MemoryStore } from '../src/memoryStore.ts'

const bases: string[] = []
const NOW = new Date('2026-11-12T10:00:00+08:00')

interface Fixture {
  base: string
  scopeRoot: string
  memoryRoot: string
  store: MemoryStore
  writer: MemoryGraphWriter
}

async function fixture(options: { memoryRoot?: string } = {}): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'kb-memory-graph-'))
  bases.push(base)
  const scopeRoot = join(base, 'personal')
  const memoryRoot = join(scopeRoot, options.memoryRoot ?? '个人记忆图谱')
  const store = new MemoryStore(memoryRoot, { now: () => NOW })
  const writer = new MemoryGraphWriter({ scopeRoot, now: () => NOW, ...(options.memoryRoot === undefined ? {} : { memoryRoot: options.memoryRoot }) })
  return { base, scopeRoot, memoryRoot, store, writer }
}

async function manifestAt(scopeRoot: string): Promise<Record<string, unknown> & {
  version: number
  nodes: Array<{ id: string; path: string }>
  edges: Array<{ id: string; from: string; to: string; type: string }>
}> {
  return JSON.parse(await readFile(join(scopeRoot, '.graphs', PERSONAL_MEMORY_GRAPH_ID, 'graph.json'), 'utf8')) as never
}

async function seedAll(store: MemoryStore): Promise<void> {
  await store.upsertPreference({ type: 'preference', topic: '输出风格', value: '先给结论' })
  await store.upsertPitfall({ type: 'pitfall', errorSignature: 'ECONNRESET', context: 'c', solution: 's' })
  await store.upsertFact({ type: 'fact', factKind: 'decision', key: 'K', statement: 'S' })
  await store.appendLog({
    type: 'episodic',
    summary: '做了一次下钻',
    sourceTime: '2026-11-12T09:00:00+08:00',
  })
  await store.writeSop({ type: 'sop', title: 'SOP A', trigger: 't', steps: ['s'] })
  await store.writeSop({ type: 'sop', title: 'SOP B', trigger: 't', steps: ['s'] })
}

afterEach(async () => {
  await Promise.all(bases.splice(0).map(base => rm(base, { recursive: true, force: true })))
})

describe('ensureGraph', () => {
  it('creates an empty valid personal-memory graph on first access', async () => {
    const { scopeRoot, writer } = await fixture()

    const result = await writer.ensureGraph()

    expect(result.changed).toBe(true)
    expect(result.nodeCount).toBe(0)
    const manifest = await manifestAt(scopeRoot)
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      id: 'personal-memory',
      name: '个人记忆图谱',
      scope: 'personal',
      status: 'draft',
      visibility: 'private',
      nodes: [],
      edges: [],
    })
    expect(manifest.version).toBe(1)

    const loaded = await loadGraph(scopeRoot, PERSONAL_MEMORY_GRAPH_ID)
    expect(validateGraph(loaded)).toEqual([])

    const again = await writer.ensureGraph()
    expect(again).toMatchObject({ changed: false, nodeCount: 0 })
  })
})

describe('registerPath', () => {
  it('adds one scope-relative node and stays idempotent', async () => {
    const { scopeRoot, store, writer } = await fixture()
    await store.upsertPreference({ type: 'preference', topic: '输出风格', value: '先给结论' })

    const first = await writer.registerPath('偏好.md')
    expect(first.changed).toBe(true)
    expect(first.nodeCount).toBe(1)

    const manifest = await manifestAt(scopeRoot)
    expect(manifest.nodes).toEqual([{
      id: 'memory-个人记忆图谱-偏好',
      path: '个人记忆图谱/偏好.md',
    }])
    expect(manifest.version).toBe(2)

    const loaded = await loadGraph(scopeRoot, PERSONAL_MEMORY_GRAPH_ID)
    expect(validateGraph(loaded)).toEqual([])
    expect(loaded.nodes[0]).toMatchObject({ path: '个人记忆图谱/偏好.md', missing: false })

    const again = await writer.registerPath('偏好.md')
    expect(again).toMatchObject({ changed: false, nodeCount: 1 })
    expect((await manifestAt(scopeRoot)).version).toBe(2)
  })

  it('registers daily logs and SOP files as separate nodes', async () => {
    const { scopeRoot, store, writer } = await fixture()
    await store.appendLog({ type: 'episodic', summary: '事件', sourceTime: '2026-11-12T09:00:00+08:00' })
    await store.writeSop({ type: 'sop', title: '指标口径排查', trigger: 't', steps: ['s'] })

    await writer.registerPath('记忆日志/2026-11-12.md')
    const result = await writer.registerPath('SOP/指标口径排查.md')

    expect(result.nodeCount).toBe(2)
    const manifest = await manifestAt(scopeRoot)
    expect(manifest.nodes.map(node => node.path)).toEqual([
      '个人记忆图谱/记忆日志/2026-11-12.md',
      '个人记忆图谱/SOP/指标口径排查.md',
    ].sort())
  })

  it('refuses a missing document and a path outside the memory root', async () => {
    const { writer } = await fixture()

    await expect(writer.registerPath('偏好.md')).rejects.toMatchObject({
      name: 'MemoryGraphWriterError',
      code: 'missing-memory-document',
    } satisfies Partial<MemoryGraphWriterError>)

    await expect(writer.registerPath('../escape.md')).rejects.toMatchObject({ code: 'unsafe-path' })
  })
})

describe('syncAll', () => {
  it('creates the empty graph when syncAll is the first access', async () => {
    const { scopeRoot, writer } = await fixture()

    const result = await writer.syncAll()

    expect(result).toMatchObject({ changed: true, nodeCount: 0 })
    const loaded = await loadGraph(scopeRoot, PERSONAL_MEMORY_GRAPH_ID)
    expect(loaded.manifest.nodes).toEqual([])
    expect(validateGraph(loaded)).toEqual([])
  })

  it('reconciles every store file into the graph and keeps the manifest valid', async () => {
    const { scopeRoot, store, writer } = await fixture()
    await seedAll(store)

    const result = await writer.syncAll()

    expect(result.nodeCount).toBe(6)
    const manifest = await manifestAt(scopeRoot)
    const paths = manifest.nodes.map(node => node.path)
    expect(paths).toEqual([...paths].sort())
    expect(paths).toEqual([
      '个人记忆图谱/SOP/SOP-A.md',
      '个人记忆图谱/SOP/SOP-B.md',
      '个人记忆图谱/事实.md',
      '个人记忆图谱/偏好.md',
      '个人记忆图谱/记忆日志/2026-11-12.md',
      '个人记忆图谱/踩坑.md',
    ])
    expect(new Set(manifest.nodes.map(node => node.id)).size).toBe(6)
    for (const path of paths) expect(path.startsWith('个人记忆图谱/')).toBe(true)

    const loaded = await loadGraph(scopeRoot, PERSONAL_MEMORY_GRAPH_ID)
    expect(validateGraph(loaded)).toEqual([])
    expect(loaded.nodes.every(node => node.missing === false)).toBe(true)

    const stable = await writer.syncAll()
    expect(stable).toMatchObject({ changed: false, nodeCount: 6 })
    expect((await manifestAt(scopeRoot)).version).toBe(manifest.version)
  })

  it('removes a deleted SOP node and any edge that referenced it', async () => {
    const { scopeRoot, store, writer } = await fixture()
    await seedAll(store)
    await writer.syncAll()

    const manifest = await manifestAt(scopeRoot)
    const logNode = manifest.nodes.find(node => node.path.endsWith('2026-11-12.md'))
    const sopNode = manifest.nodes.find(node => node.path.endsWith('SOP-A.md'))
    expect(logNode).toBeDefined()
    expect(sopNode).toBeDefined()
    manifest.edges.push({
      id: 'edge-log-sop',
      from: logNode!.id,
      to: sopNode!.id,
      type: 'derived_from',
    })
    await writeFile(
      join(scopeRoot, '.graphs', PERSONAL_MEMORY_GRAPH_ID, 'graph.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )
    expect(validateGraph(await loadGraph(scopeRoot, PERSONAL_MEMORY_GRAPH_ID))).toEqual([])

    await store.deleteSop('SOP-A')
    const result = await writer.syncAll()

    expect(result.nodeCount).toBe(5)
    const next = await manifestAt(scopeRoot)
    expect(next.nodes.some(node => node.path.endsWith('SOP-A.md'))).toBe(false)
    expect(next.edges).toEqual([])
    expect(validateGraph(await loadGraph(scopeRoot, PERSONAL_MEMORY_GRAPH_ID))).toEqual([])
  })

  it('keeps existing node ids stable when new files appear', async () => {
    const { scopeRoot, store, writer } = await fixture()
    await store.upsertPreference({ type: 'preference', topic: 'T', value: 'V' })
    await writer.syncAll()
    const before = await manifestAt(scopeRoot)
    const preferenceId = before.nodes[0]?.id

    await store.writeSop({ type: 'sop', title: '新 SOP', trigger: 't', steps: ['s'] })
    await writer.syncAll()
    const after = await manifestAt(scopeRoot)
    expect(after.nodes.find(node => node.path.endsWith('偏好.md'))?.id).toBe(preferenceId)
    expect(after.version).toBe(before.version + 1)
  })
})

describe('removePath and custom layout', () => {
  it('removes one node by memory-relative path', async () => {
    const { scopeRoot, store, writer } = await fixture()
    await store.upsertPreference({ type: 'preference', topic: 'T', value: 'V' })
    await writer.registerPath('偏好.md')

    const result = await writer.removePath('偏好.md')

    expect(result).toMatchObject({ changed: true, nodeCount: 0 })
    expect((await manifestAt(scopeRoot)).nodes).toEqual([])
    expect(validateGraph(await loadGraph(scopeRoot, PERSONAL_MEMORY_GRAPH_ID))).toEqual([])
  })

  it('supports a nested custom memory root and the one-shot helper', async () => {
    const { scopeRoot, store } = await fixture({ memoryRoot: '记忆/个人' })
    await store.upsertPreference({ type: 'preference', topic: 'T', value: 'V' })

    const result = await syncPersonalMemoryGraph({ scopeRoot, memoryRoot: '记忆/个人', now: () => NOW })

    expect(result.nodeCount).toBe(1)
    const manifest = await manifestAt(scopeRoot)
    expect(manifest.nodes[0]?.path).toBe('记忆/个人/偏好.md')
    expect(validateGraph(await loadGraph(scopeRoot, PERSONAL_MEMORY_GRAPH_ID))).toEqual([])
  })
})
