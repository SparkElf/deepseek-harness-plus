import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BindingStore,
  BindingStoreError,
  bindingKey,
  memoryRelativePath,
  parseSimpleYaml,
  serializeBinding,
  type PersonalBinding,
} from '../src/memoryBindings.ts'

const NOW = '2026-11-12T05:20:04.000Z'

function fullBinding(overrides: Partial<PersonalBinding> = {}): PersonalBinding {
  return {
    userId: 'u1',
    sourceType: 'node',
    sourceId: 'node-001',
    graphId: 'procurement',
    mode: 'internalize',
    sourceVersion: 3,
    sourceCommit: 'abc123',
    lineage: {
      subscribedAt: '2026-11-10T01:00:00.000Z',
      forkedFromVersion: 3,
      forkedAt: '2026-11-11T02:00:00.000Z',
      divergence: ['本地补充：税率', 'quote: "x"', '多行 # 不是注释'],
    },
    status: 'active',
    updatedAt: NOW,
    localPath: 'memory/procurement/node-001.md',
    ...overrides,
  }
}

describe('bindingKey / memory paths', () => {
  it('composes <sourceType>-<sourceId> and refuses path escapes', () => {
    expect(bindingKey('node', 'node-001')).toBe('node-node-001')
    expect(bindingKey('edge', '采购-关系')).toBe('edge-采购-关系')
    expect(memoryRelativePath('procurement', 'node-001')).toBe('memory/procurement/node-001.md')

    expect(() => bindingKey('node', '')).toThrow(BindingStoreError)
    expect(() => bindingKey('node', '../escape')).toThrow(BindingStoreError)
    expect(() => bindingKey('node', 'a/b')).toThrow(BindingStoreError)
    expect(() => bindingKey('node', 'a\\b')).toThrow(BindingStoreError)
    expect(() => bindingKey('node', '.hidden')).toThrow(BindingStoreError)
    expect(() => bindingKey('relation' as never, 'x')).toThrow(BindingStoreError)
  })
})

describe('BindingStore YAML roundtrip', () => {
  let root: string
  let store: BindingStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-bindings-'))
    store = new BindingStore(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('round-trips every field, including quoted lineage entries', async () => {
    const binding = fullBinding()
    await store.set(binding)

    expect(await store.get('u1', 'node', 'node-001')).toEqual(binding)
    expect(store.readonlyPath('u1')).toBe(join(root, 'u1', 'bindings'))

    const file = join(store.readonlyPath('u1'), 'node-node-001.yaml')
    const text = await readFile(file, 'utf8')
    expect(text).toContain('userId: u1')
    expect(text).toContain('sourceVersion: 3')
    expect(text).toContain('lineage:')
    expect(text).toContain('divergence: [')
    // Atomic write leaves exactly one binding file, never a temp sibling.
    expect(await readdir(store.readonlyPath('u1'))).toEqual(['node-node-001.yaml'])
  })

  it('rebuilds list() from files and tolerates unknown keys', async () => {
    const directory = store.readonlyPath('u2')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'node-node-9.yaml'),
      [
        'userId: u2',
        'sourceType: node',
        'sourceId: node-9',
        'graphId: g1',
        'mode: pending',
        'sourceVersion: 7',
        'status: active',
        'updatedAt: "2026-11-12T00:00:00.000Z"',
        'requestedMode: subscribe',
        'lineage:',
        '  divergence: [a, "b: c"]',
        'unknownTop: whatever',
        'futureSection:',
        '  nested: 1',
        '',
      ].join('\n'),
    )

    const [binding] = await store.list('u2')
    expect(binding).toBeDefined()
    expect(binding).toMatchObject({
      userId: 'u2',
      sourceType: 'node',
      sourceId: 'node-9',
      graphId: 'g1',
      mode: 'pending',
      sourceVersion: 7,
      status: 'active',
      requestedMode: 'subscribe',
    })
    expect(binding?.lineage.divergence).toEqual(['a', 'b: c'])
    expect((binding as unknown as Record<string, unknown>).unknownTop).toBeUndefined()
    expect((binding as unknown as Record<string, unknown>).futureSection).toBeUndefined()

    // Deleting the file is the whole delete: there is no index to update.
    await rm(join(directory, 'node-node-9.yaml'))
    expect(await store.list('u2')).toEqual([])
  })

  it('returns [] for a user with no bindings directory', async () => {
    expect(await store.list('nobody')).toEqual([])
    expect(await store.get('nobody', 'node', 'missing')).toBeUndefined()
  })

  it('overwrites in place and remove() is idempotent', async () => {
    await store.set(fullBinding())
    await store.set(fullBinding({ mode: 'subscribe', updatedAt: '2026-11-12T06:00:00.000Z' }))

    const binding = await store.get('u1', 'node', 'node-001')
    expect(binding?.mode).toBe('subscribe')
    expect(binding?.updatedAt).toBe('2026-11-12T06:00:00.000Z')
    expect(await readdir(store.readonlyPath('u1'))).toEqual(['node-node-001.yaml'])

    await store.remove('u1', 'node', 'node-001')
    expect(await store.get('u1', 'node', 'node-001')).toBeUndefined()
    await expect(store.remove('u1', 'node', 'node-001')).resolves.toBeUndefined()
  })

  it('rejects invalid bindings before writing anything', async () => {
    await expect(store.set(fullBinding({ sourceVersion: -1 }))).rejects.toThrow(BindingStoreError)
    await expect(store.set(fullBinding({ userId: '../u1' }))).rejects.toThrow(BindingStoreError)
    await expect(store.set(fullBinding({ localPath: '../escape.md' }))).rejects.toThrow(BindingStoreError)
    await expect(store.set(fullBinding({ updatedAt: '' }))).rejects.toThrow(BindingStoreError)
    await expect(stat(join(root, 'u1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a hand-written binding whose identity does not match its file name', async () => {
    const directory = store.readonlyPath('u1')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'node-node-1.yaml'),
      serializeBinding(fullBinding()).replace('sourceId: node-001', 'sourceId: node-002'),
    )

    await expect(store.get('u1', 'node', 'node-1')).rejects.toThrow(BindingStoreError)
  })
})

describe('simple YAML dialect', () => {
  it('writes scalars that would otherwise change type', () => {
    const yaml = serializeBinding(
      fullBinding({
        sourceCommit: '00123',
        lineage: { divergence: ['true', '42', '# not a comment', ''], subscribedAt: NOW },
      }),
    )
    const parsed = parseSimpleYaml(yaml)
    expect(parsed.sourceCommit).toBe('00123')
    const lineage = parsed.lineage as Record<string, unknown>
    expect(lineage.divergence).toEqual(['true', '42', '# not a comment', ''])
    expect(lineage.subscribedAt).toBe(NOW)
  })
})
