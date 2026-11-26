import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GraphManifest, LoadedGraph, LoadedGraphEdge, LoadedGraphNode } from '../src/graphModel.ts'
import type { GraphViewer } from '../src/graphPolicy.ts'
import type { PersonalBinding } from '../src/memoryBindings.ts'
import {
  SYSTEM_POLICY_MARKER,
  renderMemoryContextMarkdown,
  resolveMemoryContext,
  type MemoryContextResult,
} from '../src/memoryContext.ts'
import { MemoryStore } from '../src/memoryStore.ts'
import { memoryEntryTitle } from '../src/memoryDisplay.ts'

const NOW = '2026-11-12T10:00:00.000Z'

function manifest(overrides: Partial<GraphManifest> = {}): GraphManifest {
  return {
    schemaVersion: 1,
    id: 'g1',
    name: '采购制度图谱',
    scope: 'department:D1',
    version: 3,
    status: 'published',
    createdAt: NOW,
    updatedAt: NOW,
    tags: [],
    visibility: 'department',
    nodes: [],
    edges: [],
    ...overrides,
  }
}

function node(id: string, path: string, overrides: Partial<LoadedGraphNode> = {}): LoadedGraphNode {
  return {
    id,
    path,
    type: 'policy',
    title: id,
    authority: 'advisory',
    internalizable: true,
    origin: 'human',
    reviewStatus: 'approved',
    tags: [],
    sourceRefs: [],
    missing: false,
    ...overrides,
  }
}

function edge(id: string, from: string, to: string, docPath?: string, overrides: Partial<LoadedGraphEdge> = {}): LoadedGraphEdge {
  return {
    id,
    from,
    to,
    type: 'depends_on',
    title: id,
    authority: 'advisory',
    internalizable: true,
    origin: 'human',
    reviewStatus: 'approved',
    tags: [],
    sourceRefs: [],
    missing: false,
    ...(docPath === undefined ? {} : { docPath }),
    ...overrides,
  }
}

function viewer(overrides: Partial<GraphViewer> = {}): GraphViewer {
  return {
    userId: 'u1',
    isAdmin: false,
    isSuperAdmin: false,
    departmentCode: 'D1',
    visibleDepartmentCodes: ['D1'],
    ...overrides,
  }
}

function binding(overrides: Partial<PersonalBinding> = {}): PersonalBinding {
  return {
    userId: 'u1',
    sourceType: 'node',
    sourceId: 'node-a',
    graphId: 'g1',
    mode: 'subscribe',
    sourceVersion: 3,
    sourceCommit: 'commit-3',
    lineage: {},
    status: 'active',
    updatedAt: NOW,
    ...overrides,
  }
}

async function writeDocument(root: string, relPath: string, frontMatter: string, body: string): Promise<void> {
  const target = join(root, relPath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `---\n${frontMatter}\n---\n\n${body}\n`)
}

interface Fixture {
  root: string
  usersRoot: string
  graph: LoadedGraph
  bindings: PersonalBinding[]
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'kb-memory-context-'))
  const usersRoot = join(root, 'users')

  await writeDocument(root, '制度/采购制度.md',
    'id: node-a\ntitle: 采购制度\nauthority: canonical\norigin: human\nreviewStatus: approved',
    '采购正文：差旅标准 500 元。')
  await writeDocument(root, '流程/审批流程.md',
    'id: node-b\ntitle: 审批流程\nauthority: advisory\norigin: ai\nreviewStatus: reviewed',
    '审批正文：三级审批。')
  await writeDocument(root, '策略/安全红线.md',
    'id: node-c\ntitle: 安全红线\nauthority: redline\norigin: human\nreviewStatus: approved',
    '红线正文：禁止外发客户数据。')
  await writeDocument(root, '.graphs/g1/links/edge-1.md',
    'id: edge-1\nfrom: node-a\nto: node-b\ntype: depends_on\nauthority: advisory',
    '关系正文：采购依赖审批。')
  await writeDocument(root, '策略/普通关系.md',
    'id: edge-2\nfrom: node-b\nto: node-c\ntype: depends_on\nauthority: advisory',
    '关系正文：审批触及安全红线。')

  // One internalized branch owned by the user, deliberately divergent from node-b.
  const memoryRoot = join(usersRoot, 'u1', 'memory', 'g1')
  await mkdir(memoryRoot, { recursive: true })
  await writeFile(
    join(memoryRoot, 'node-b.md'),
    '---\nid: node-b\ntitle: 审批流程（个人）\nauthority: advisory\norigin: human\nreviewStatus: reviewed\n---\n\n'
      + '本地内化正文：我自己的审批笔记。\n',
  )

  const graph: LoadedGraph = {
    manifest: manifest(),
    root,
    nodes: [
      node('node-a', '制度/采购制度.md', { type: 'policy', title: '采购制度', authority: 'canonical', origin: 'human' }),
      node('node-b', '流程/审批流程.md', { type: 'procedure', title: '审批流程', authority: 'advisory', origin: 'ai', reviewStatus: 'reviewed' }),
      node('node-c', '策略/安全红线.md', { type: 'policy', title: '安全红线', authority: 'redline' }),
    ],
    edges: [
      edge('edge-1', 'node-a', 'node-b', '.graphs/g1/links/edge-1.md', { title: '采购依赖审批' }),
      edge('edge-2', 'node-b', 'node-c', '策略/普通关系.md', { title: '审批触及安全红线' }),
    ],
    issues: [],
  }

  return {
    root,
    usersRoot,
    graph,
    bindings: [
      binding({ sourceType: 'node', sourceId: 'node-a', mode: 'subscribe' }),
      binding({ sourceType: 'edge', sourceId: 'edge-1', mode: 'subscribe' }),
      binding({ sourceType: 'node', sourceId: 'node-b', mode: 'internalize', localPath: 'memory/g1/node-b.md' }),
    ],
  }
}

function ids(result: MemoryContextResult): string[] {
  return result.entries.map(entry => entry.sourceId)
}

describe('memory context resolver', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeFixture()
  })

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it('resolves live proxies and internalized branches in deterministic priority order', async () => {
    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: fixture.bindings,
    })

    // canonical proxy (node), canonical relation (edge), then advisory internalized.
    expect(ids(result)).toEqual(['node-a', 'edge-1', 'node-b'])
    expect(result.entries.map(entry => entry.mode)).toEqual(['subscribe', 'subscribe', 'internalize'])

    const subscribed = result.entries[0]!
    expect(subscribed).toMatchObject({
      graphId: 'g1',
      sourceType: 'node',
      sourceId: 'node-a',
      authority: 'canonical',
      status: 'active',
      sourceVersion: 3,
      sourceCommit: 'commit-3',
      path: '制度/采购制度.md',
    })
    expect(subscribed.body).toContain('差旅标准 500 元')
    expect(subscribed.nonOverridable).toBe(false)

    const relation = result.entries[1]!
    expect(relation).toMatchObject({ sourceType: 'edge', from: 'node-a', to: 'node-b', path: '.graphs/g1/links/edge-1.md' })
    expect(relation.body).toContain('采购依赖审批')

    const internalized = result.entries[2]!
    expect(internalized).toMatchObject({
      mode: 'internalize',
      status: 'active',
      path: 'memory/g1/node-b.md',
      authority: 'advisory',
    })
    expect(internalized.body).toContain('本地内化正文')
    expect(internalized.body).not.toContain('三级审批')

    const again = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: fixture.bindings,
    })
    expect(ids(again)).toEqual(ids(result))
  })

  it('reflects a changed source body and frontmatter without re-running the guardian', async () => {
    const first = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: [binding({ sourceType: 'node', sourceId: 'node-a' })],
    })
    expect(first.entries[0]?.body).toContain('500 元')

    await writeDocument(fixture.root, '制度/采购制度.md',
      'id: node-a\ntitle: 采购制度（新版）\nauthority: canonical\norigin: human\nreviewStatus: approved',
      '采购正文：差旅标准 800 元。')

    const second = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: [binding({ sourceType: 'node', sourceId: 'node-a' })],
    })
    expect(second.entries[0]?.body).toContain('800 元')
    expect(second.entries[0]?.body).not.toContain('500 元')
    expect(second.entries[0]?.title).toBe('采购制度（新版）')
    // The binding was not refreshed; the proxy is live regardless.
    expect(second.entries[0]?.sourceVersion).toBe(3)
  })

  it('never follows a source change into an internalized branch', async () => {
    await writeDocument(fixture.root, '流程/审批流程.md',
      'id: node-b\ntitle: 审批流程\nauthority: advisory\norigin: ai\nreviewStatus: reviewed',
      '审批正文：已经改成新流程。')

    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: [binding({ sourceType: 'node', sourceId: 'node-b', mode: 'internalize', localPath: 'memory/g1/node-b.md' })],
    })
    expect(result.entries[0]?.body).toContain('本地内化正文')
    expect(result.entries[0]?.body).not.toContain('已经改成新流程')
    expect(result.entries[0]?.title).toBe('审批流程（个人）')
  })

  it('carries stale and revoked branch status from the binding', async () => {
    const stale = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: [binding({ sourceType: 'node', sourceId: 'node-b', mode: 'internalize', status: 'stale', localPath: 'memory/g1/node-b.md' })],
    })
    expect(stale.entries[0]?.status).toBe('stale')
    expect(stale.entries[0]?.body).toContain('本地内化正文')

    const revoked = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: [binding({ sourceType: 'node', sourceId: 'node-b', mode: 'internalize', status: 'revoked', localPath: 'memory/g1/node-b.md' })],
    })
    expect(revoked.entries[0]?.status).toBe('revoked')
  })

  it('marks redlines nonOverridable and never drops them for the budget', async () => {
    const bindings = [
      binding({ sourceType: 'node', sourceId: 'node-a', mode: 'subscribe' }),
      binding({ sourceType: 'node', sourceId: 'node-b', mode: 'internalize', localPath: 'memory/g1/node-b.md' }),
      binding({ sourceType: 'node', sourceId: 'node-c', mode: 'subscribe' }),
    ]

    const wide = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings,
    })
    const redline = wide.entries.find(entry => entry.sourceId === 'node-c')
    expect(redline).toMatchObject({
      authority: 'redline',
      nonOverridable: true,
      policyNote: SYSTEM_POLICY_MARKER,
    })
    expect(wide.systemPolicy).toBe(SYSTEM_POLICY_MARKER)
    expect(redline?.body).toContain('禁止外发客户数据')

    // Zero budget: only the redline survives.
    const tight = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings,
      maxChars: 0,
    })
    expect(ids(tight)).toEqual(['node-c'])
    expect(tight.entries[0]?.nonOverridable).toBe(true)
    expect(tight.dropped.map(drop => drop.sourceId).sort()).toEqual(['node-a', 'node-b'])
    expect(tight.systemPolicy).toBe(SYSTEM_POLICY_MARKER)
    // Redline may exceed the budget; it is still returned.
    expect(tight.charCount).toBeGreaterThan(0)
  })

  it('drops the advisory internalized branch before the canonical proxy', async () => {
    const bindings = [
      binding({ sourceType: 'node', sourceId: 'node-a', mode: 'subscribe' }),
      binding({ sourceType: 'node', sourceId: 'node-b', mode: 'internalize', localPath: 'memory/g1/node-b.md' }),
      binding({ sourceType: 'node', sourceId: 'node-c', mode: 'subscribe' }),
    ]
    const wide = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings,
    })
    const internalized = wide.entries.find(entry => entry.mode === 'internalize')!
    const budget = wide.charCount - internalized.chars

    const tight = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings,
      maxChars: budget,
    })
    expect(tight.entries.map(entry => entry.sourceId)).toEqual(['node-c', 'node-a'])
    expect(tight.dropped).toEqual([
      expect.objectContaining({ sourceId: 'node-b', mode: 'internalize', reason: 'budget' }),
    ])
  })

  it('omits graphs, and relations with missing endpoints, that the viewer cannot see', async () => {
    const privateGraph: LoadedGraph = {
      manifest: manifest({ id: 'g2', name: '私有图谱', scope: 'personal:someone-else', visibility: 'private', owner: 'someone-else' }),
      root: fixture.root,
      nodes: [node('node-x', '私有/秘密.md')],
      edges: [],
      issues: [],
    }
    const foreignDepartment: LoadedGraph = {
      manifest: manifest({ id: 'g3', name: '别部门图谱', scope: 'department:D2', visibility: 'department' }),
      root: fixture.root,
      nodes: [node('node-y', '别部门/制度.md')],
      edges: [],
      issues: [],
    }

    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph, privateGraph, foreignDepartment],
      bindings: [
        binding({ sourceType: 'node', sourceId: 'node-a' }),
        binding({ graphId: 'g2', sourceType: 'node', sourceId: 'node-x' }),
        binding({ graphId: 'g3', sourceType: 'node', sourceId: 'node-y' }),
      ],
    })
    expect(ids(result)).toEqual(['node-a'])

    // A relation whose endpoint is not in the loaded graph is omitted (fail closed).
    const broken: LoadedGraph = {
      manifest: manifest(),
      root: fixture.root,
      nodes: [node('node-a', '制度/采购制度.md', { authority: 'canonical' })],
      edges: [edge('edge-orphan', 'node-a', 'node-missing', '.graphs/g1/links/edge-1.md')],
      issues: [],
    }
    const orphan = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [broken],
      bindings: [binding({ sourceType: 'edge', sourceId: 'edge-orphan' })],
    })
    expect(orphan.entries).toEqual([])
  })

  it('inherits a redline from either endpoint of a relation', async () => {
    await writeDocument(fixture.root, '流程/审批红线关系.md',
      'id: edge-3\nfrom: node-b\nto: node-c\ntype: depends_on\nauthority: advisory',
      '关系正文：审批记录受红线约束。')

    const graph: LoadedGraph = {
      ...fixture.graph,
      edges: [
        ...fixture.graph.edges,
        edge('edge-3', 'node-b', 'node-c', '流程/审批红线关系.md', { title: '审批红线关系' }),
      ],
    }
    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [graph],
      bindings: [binding({ sourceType: 'edge', sourceId: 'edge-3' })],
    })
    expect(result.entries[0]).toMatchObject({
      sourceType: 'edge',
      authority: 'redline',
      nonOverridable: true,
      policyNote: SYSTEM_POLICY_MARKER,
      from: 'node-b',
      to: 'node-c',
    })
  })
})
describe('personal memory store context', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
    roots.length = 0
  })

  async function personalFixture(): Promise<{
    root: string
    usersRoot: string
    memoryRoot: string
    store: MemoryStore
  }> {
    const root = await mkdtemp(join(tmpdir(), 'kb-memory-personal-'))
    roots.push(root)
    const usersRoot = join(root, 'users')
    const memoryRoot = join(root, 'personal', 'u1', '个人记忆图谱')
    const store = new MemoryStore(memoryRoot, { now: () => new Date(NOW) })
    return { root, usersRoot, memoryRoot, store }
  }

  async function seedFour(store: MemoryStore): Promise<Record<string, string>> {
    const preference = await store.upsertPreference({
      type: 'preference',
      topic: '反诈分析',
      value: '先给结论，再列关键证据',
      displayTitle: '反诈分析先结论后证据',
      privacy: 'normal',
      origin: 'explicit',
      sourceLabel: '会话「反诈分析先结论后证据」中的显式要求',
    })
    const pitfall = await store.upsertPitfall({
      type: 'pitfall',
      errorSignature: '文件写入路径错误',
      context: '写入临时目录失败',
      solution: '先校验目录再写入',
      privacy: 'normal',
      origin: 'auto',
    })
    const fact = await store.upsertFact({
      type: 'fact',
      factKind: 'decision',
      key: '指标口径',
      statement: '先查上游再下结论',
      scope: '指标排查',
      privacy: 'normal',
      origin: 'explicit',
    })
    const sop = await store.writeSop({
      type: 'sop',
      title: '每日检查',
      trigger: '每天一次',
      steps: ['读取会话', '合并候选'],
      privacy: 'normal',
      origin: 'auto',
      status: 'testing',
    })
    const episodic = await store.appendLog({
      type: 'episodic',
      summary: '完成记忆上下文验收',
      privacy: 'normal',
      origin: 'auto',
    })
    return {
      preference: preference.id,
      pitfall: pitfall.id,
      fact: fact.id,
      sop: sop.sop.id,
      episodic: episodic.id,
    }
  }

  it('returns the caller\'s current MemoryStore entries with no binding at all', async () => {
    const fixture = await personalFixture()
    const ids = await seedFour(fixture.store)

    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [],
      personalMemoryRoot: fixture.memoryRoot,
    })

    expect(result.personalCount).toBe(5)
    expect(result.entries.map(entry => entry.type)).toEqual([
      'preference',
      'pitfall',
      'fact',
      'sop',
      'episodic',
    ])
    for (const entry of result.entries) {
      expect(entry).toMatchObject({
        mode: 'personal',
        graphId: 'personal-memory',
        sourceType: 'entry',
        authority: 'advisory',
        status: 'active',
        nonOverridable: false,
      })
      expect(entry.privacy).toBe('normal')
    }

    const preference = result.entries.find(entry => entry.sourceId === ids.preference)!
    expect(preference.title).toBe('反诈分析先结论后证据')
    expect(preference.body).toContain('topic: 反诈分析')
    expect(preference.body).toContain('先给结论，再列关键证据')
    expect(preference.path).toBe('偏好.md')

    const pitfall = result.entries.find(entry => entry.sourceId === ids.pitfall)!
    expect(pitfall.title).toBe('文件写入路径错误')
    expect(pitfall.body).toContain('solution: 先校验目录再写入')

    const sop = result.entries.find(entry => entry.sourceId === ids.sop)!
    expect(sop.sourceVersion).toBe(1)
    expect(sop.body).toContain('status: testing')
    expect(sop.body).toContain('1. 读取会话')
  })

  it('keeps bindings and personal memory together, deduped by id and content', async () => {
    const fixture = await makeFixture()
    roots.push(fixture.root)
    const memoryRoot = join(fixture.root, 'personal', 'u1', '个人记忆图谱')
    const store = new MemoryStore(memoryRoot, { now: () => new Date(NOW) })

    // Same id as the binding source id: the binding wins and the copy is skipped.
    await store.upsertPreference({
      id: 'node-a',
      type: 'preference',
      topic: '采购',
      value: 'binding duplicate',
      privacy: 'normal',
    })
    // Two daily-log entries with identical content: only one is injected.
    await store.appendLog({
      type: 'episodic',
      summary: '重复的情景',
      privacy: 'normal',
      origin: 'auto',
    })
    await store.appendLog({
      type: 'episodic',
      summary: '重复的情景',
      privacy: 'normal',
      origin: 'auto',
    })

    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: [binding({ sourceType: 'node', sourceId: 'node-a', mode: 'subscribe' })],
      personalMemoryRoot: memoryRoot,
    })

    expect(result.entries.map(entry => entry.sourceId)).toEqual(['node-a', expect.any(String)])
    expect(result.entries[0]?.mode).toBe('subscribe')
    expect(result.entries[1]?.mode).toBe('personal')
    expect(result.entries[1]?.body).toContain('重复的情景')
    expect(result.entries.filter(entry => entry.body.includes('binding duplicate'))).toHaveLength(0)
    expect(result.entries.filter(entry => entry.body.includes('重复的情景'))).toHaveLength(1)
  })

  it('skips a superseded value that is still present in the daily log', async () => {
    const fixture = await personalFixture()
    const old = await fixture.store.appendLog({
      id: 'mem-old-preference',
      type: 'preference',
      topic: '汇报',
      value: '先讲过程',
      privacy: 'normal',
    })
    await fixture.store.upsertPreference({
      type: 'preference',
      topic: '汇报',
      value: '先讲结论',
      privacy: 'normal',
      supersedes: old.id,
    })

    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [],
      personalMemoryRoot: fixture.memoryRoot,
    })

    expect(result.entries.some(entry => entry.sourceId === old.id)).toBe(false)
    expect(result.entries.some(entry => entry.body.includes('先讲过程'))).toBe(false)
    expect(result.entries.some(entry => entry.body.includes('先讲结论'))).toBe(true)
  })

  it('honours the character budget and never returns a personal entry as a redline', async () => {
    const fixture = await personalFixture()
    await seedFour(fixture.store)

    const wide = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [],
      personalMemoryRoot: fixture.memoryRoot,
    })
    const preference = wide.entries.find(entry => entry.type === 'preference')!

    const tight = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [],
      personalMemoryRoot: fixture.memoryRoot,
      maxChars: preference.chars,
    })
    expect(tight.entries.map(entry => entry.type)).toEqual(['preference'])
    expect(tight.charCount).toBe(preference.chars)
    expect(tight.dropped.length).toBe(wide.entries.length - 1)
    expect(tight.dropped.every(drop => drop.reason === 'budget')).toBe(true)
    expect(tight.redlineCount).toBe(0)
    expect(tight.systemPolicy).toBe('')

    const zero = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [],
      personalMemoryRoot: fixture.memoryRoot,
      maxChars: 0,
    })
    expect(zero.entries).toEqual([])
    expect(zero.dropped).toHaveLength(wide.entries.length)
  })

  it('keeps a department redline above personal memory and never drops the redline', async () => {
    const fixture = await makeFixture()
    roots.push(fixture.root)
    const memoryRoot = join(fixture.root, 'personal', 'u1', '个人记忆图谱')
    const store = new MemoryStore(memoryRoot, { now: () => new Date(NOW) })
    await seedFour(store)

    const zero = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: [binding({ sourceType: 'node', sourceId: 'node-c', mode: 'subscribe' })],
      personalMemoryRoot: memoryRoot,
      maxChars: 0,
    })
    expect(zero.entries).toHaveLength(1)
    expect(zero.entries[0]).toMatchObject({
      sourceId: 'node-c',
      mode: 'subscribe',
      authority: 'redline',
      nonOverridable: true,
    })
    expect(zero.personalCount).toBe(0)
    expect(zero.systemPolicy).toBe(SYSTEM_POLICY_MARKER)
    expect(zero.dropped.every(drop => drop.mode === 'personal')).toBe(true)
  })

  it('never exposes sensitive or secret entries, or another user\'s tree', async () => {
    const fixture = await personalFixture()
    const sensitive = await fixture.store.upsertPreference({
      type: 'preference',
      topic: '联系方式',
      value: '手机号 13800000000',
      privacy: 'sensitive',
      displayTitle: '联系方式',
    })
    const secret = await fixture.store.upsertFact({
      type: 'fact',
      factKind: 'clarification',
      key: 'API Key',
      statement: '使用凭据管理器里的 key',
      privacy: 'secret',
      credentialRef: 'DASHSCOPE_API_KEY',
      displayTitle: '模型凭据',
    })
    const normal = await fixture.store.upsertPreference({
      type: 'preference',
      topic: '汇报',
      value: '先讲结论',
      privacy: 'normal',
      displayTitle: '汇报先讲结论',
    })

    // A second user's tree exists next to the caller's tree; the resolver must
    // only read the root the Host supplied for the authenticated caller.
    const otherRoot = join(fixture.root, 'personal', 'u2', '个人记忆图谱')
    const other = new MemoryStore(otherRoot, { now: () => new Date(NOW) })
    await other.upsertPreference({
      type: 'preference',
      topic: 'secret-of-u2',
      value: 'OTHER-USER-PRIVATE',
      privacy: 'normal',
      displayTitle: 'OTHER-USER-PRIVATE',
    })

    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [],
      personalMemoryRoot: fixture.memoryRoot,
    })

    expect(result.entries.map(entry => entry.sourceId)).toEqual([normal.id])
    expect(result.entries.some(entry => entry.sourceId === sensitive.id)).toBe(false)
    expect(result.entries.some(entry => entry.sourceId === secret.id)).toBe(false)
    expect(result.entries.some(entry => entry.body.includes('OTHER-USER-PRIVATE'))).toBe(false)
    expect(result.entries.some(entry => entry.body.includes('DASHSCOPE_API_KEY'))).toBe(false)
    expect(result.entries.some(entry => entry.body.includes('13800000000'))).toBe(false)
  })

  it('drops a forgotten entry on the next resolve', async () => {
    const fixture = await personalFixture()
    const ids = await seedFour(fixture.store)

    const before = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [],
      personalMemoryRoot: fixture.memoryRoot,
    })
    expect(before.entries.some(entry => entry.sourceId === ids.preference)).toBe(true)

    await fixture.store.forgetEntry(ids.preference)
    const after = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [],
      personalMemoryRoot: fixture.memoryRoot,
    })
    expect(after.entries.some(entry => entry.sourceId === ids.preference)).toBe(false)
    expect(after.personalCount).toBe(before.personalCount - 1)
  })

  it('stays bindings-only when no personal root is supplied', async () => {
    const fixture = await makeFixture()
    roots.push(fixture.root)
    const memoryRoot = join(fixture.root, 'personal', 'u1', '个人记忆图谱')
    const store = new MemoryStore(memoryRoot, { now: () => new Date(NOW) })
    await store.upsertPreference({
      type: 'preference',
      topic: '汇报',
      value: '先讲结论',
      privacy: 'normal',
    })

    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: [binding({ sourceType: 'node', sourceId: 'node-a', mode: 'subscribe' })],
    })
    expect(result.personalCount).toBe(0)
    expect(result.entries.map(entry => entry.sourceId)).toEqual(['node-a'])
  })
})

describe('shared memory context', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
    roots.length = 0
  })

  interface SharedFixture {
    root: string
    usersRoot: string
    scopeRoot: string
    graph: LoadedGraph
  }

  async function sharedFixture(scope = 'department:D1'): Promise<SharedFixture> {
    const root = await mkdtemp(join(tmpdir(), 'kb-memory-shared-'))
    roots.push(root)
    const usersRoot = join(root, 'users')
    const scopeRoot = join(root, ...scope.replace(':', '/').split('/'))
    await writeDocument(scopeRoot, '记忆共享/mp-1.md',
      'id: mem-mp-1\ntitle: 部门周报结论先行\ntype: topic\nauthority: advisory\norigin: human\nreviewStatus: approved\nscope: ' + scope,
      '部门周报先写结论，再列数据。')
    const graph: LoadedGraph = {
      manifest: manifest({
        id: 'shared-memory',
        name: '部门共享记忆',
        scope,
        version: 7,
        visibility: scope === 'global' ? 'global' : 'department',
      }),
      root: scopeRoot,
      nodes: [node('mem-mp-1', '记忆共享/mp-1.md', {
        title: '部门周报结论先行',
        type: 'topic',
        authority: 'advisory',
      })],
      edges: [],
      issues: [],
    }
    return { root, usersRoot, scopeRoot, graph }
  }

  it('injects approved shared memory as an advisory [SHARED] entry with its scope', async () => {
    const fixture = await sharedFixture()
    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
    })

    expect(result.sharedCount).toBe(1)
    const entry = result.entries[0]!
    expect(entry.mode).toBe('shared')
    expect(entry.sourceId).toBe('mem-mp-1')
    expect(entry.authority).toBe('advisory')
    expect(entry.nonOverridable).toBe(false)
    expect(entry.scope).toBe('department:D1')
    expect(entry.privacy).toBe('normal')
    expect(entry.sourceVersion).toBe(7)

    const rendered = renderMemoryContextMarkdown(result)
    expect(rendered).toContain('## [SHARED] 部门周报结论先行')
    expect(rendered).toContain('scope: department:D1')
    expect(rendered).toContain('shared: 1')
    expect(rendered).not.toContain(SYSTEM_POLICY_MARKER)
  })

  it('dedupes a shared node against a subscription by id and another shared document by content', async () => {
    const fixture = await sharedFixture()
    // The same node also has a legacy subscription binding: the live proxy wins.
    await writeDocument(fixture.scopeRoot, '记忆共享/mp-2.md',
      'id: mem-mp-2\ntitle: 部门周报结论先行\ntype: topic\nauthority: advisory\norigin: human\nreviewStatus: approved',
      '部门周报先写结论，再列数据。')
    fixture.graph.nodes.push(node('mem-mp-2', '记忆共享/mp-2.md', { title: '部门周报结论先行', type: 'topic' }))

    const subscribed = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      bindings: [binding({ sourceType: 'node', sourceId: 'mem-mp-1', graphId: 'shared-memory', mode: 'subscribe' })],
    })
    expect(subscribed.entries.map(entry => entry.mode)).toEqual(['subscribe'])

    const duplicate = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
    })
    expect(duplicate.sharedCount).toBe(1)
  })

  it('never injects sensitive or secret shared documents', async () => {
    const fixture = await sharedFixture()
    await writeDocument(fixture.scopeRoot, '记忆共享/mp-sensitive.md',
      'id: mem-mp-sensitive\ntitle: 敏感部门记录\nauthority: advisory\nprivacy: sensitive',
      '敏感正文：手机号 13800000000。')
    await writeDocument(fixture.scopeRoot, '记忆共享/mp-secret.md',
      'id: mem-mp-secret\ntitle: 凭据部门记录\nauthority: advisory\nprivacy: secret',
      '凭据正文：credentialRef=kb-prod。')
    fixture.graph.nodes.push(
      node('mem-mp-sensitive', '记忆共享/mp-sensitive.md', { title: '敏感部门记录', type: 'topic' }),
      node('mem-mp-secret', '记忆共享/mp-secret.md', { title: '凭据部门记录', type: 'topic' }),
    )

    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
    })
    expect(result.entries.map(entry => entry.sourceId)).toEqual(['mem-mp-1'])
    const rendered = renderMemoryContextMarkdown(result)
    expect(rendered).not.toContain('13800000000')
    expect(rendered).not.toContain('credentialRef')
  })

  it('omits a department shared graph the viewer cannot see', async () => {
    const fixture = await sharedFixture('department:D2')
    const result = await resolveMemoryContext({
      viewer: viewer({ departmentCode: 'D1', visibleDepartmentCodes: ['D1'] }),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
    })
    expect(result.sharedCount).toBe(0)
    expect(renderMemoryContextMarkdown(result)).not.toContain('部门周报先写结论')
  })

  it('keeps department/global policy and shared memory while personal memory is paused', async () => {
    const fixture = await makeFixture()
    const shared = await sharedFixture()
    roots.push(fixture.root)
    const memoryRoot = join(fixture.root, 'personal', 'u1', '个人记忆图谱')
    const store = new MemoryStore(memoryRoot, { now: () => new Date(NOW) })
    await store.upsertPreference({
      type: 'preference',
      topic: '汇报',
      value: '先讲结论',
      privacy: 'normal',
    })

    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph, shared.graph],
      // A redline subscription and a personal internalized copy of a department node.
      bindings: [
        binding({ sourceType: 'node', sourceId: 'node-c', mode: 'subscribe' }),
        binding({ sourceType: 'node', sourceId: 'node-b', mode: 'internalize', localPath: 'memory/g1/node-b.md' }),
      ],
      personalMemoryRoot: memoryRoot,
      paused: true,
    })

    const entryIds = result.entries.map(entry => entry.sourceId)
    expect(entryIds).toContain('node-c')
    expect(entryIds).not.toContain('node-b')
    expect(result.personalCount).toBe(0)
    expect(result.sharedCount).toBe(1)
    const redline = result.entries.find(entry => entry.sourceId === 'node-c')!
    expect(redline.nonOverridable).toBe(true)
    expect(result.systemPolicy).toBe(SYSTEM_POLICY_MARKER)
    const rendered = renderMemoryContextMarkdown(result)
    expect(rendered).toContain('[REDLINE] 安全红线')
    expect(rendered).toContain('[SHARED] 部门周报结论先行')
    expect(rendered).not.toContain('本地内化正文')
    expect(rendered).not.toContain('[PERSONAL]')
  })

  it('drops shared advisory memory before a canonical proxy or a redline', async () => {
    const fixture = await makeFixture()
    const shared = await sharedFixture()
    roots.push(fixture.root)
    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph, shared.graph],
      bindings: [
        binding({ sourceType: 'node', sourceId: 'node-a', mode: 'subscribe' }),
        binding({ sourceType: 'node', sourceId: 'node-c', mode: 'subscribe' }),
      ],
      maxChars: 0,
    })

    expect(result.entries.map(entry => entry.sourceId)).toEqual(['node-c'])
    expect(result.redlineCount).toBe(1)
    expect(result.sharedCount).toBe(0)
    expect(result.dropped.map(drop => drop.sourceId)).toContain('mem-mp-1')
    expect(result.dropped.map(drop => drop.sourceId)).toContain('node-a')
  })

  it('marks a shared redline nonOverridable and never drops it for the budget', async () => {
    const fixture = await sharedFixture()
    await writeDocument(fixture.scopeRoot, '记忆共享/mp-redline.md',
      'id: mem-mp-redline\ntitle: 部门安全红线\nauthority: redline\norigin: human\nreviewStatus: approved',
      '红线正文：禁止外发部门数据。')
    fixture.graph.nodes.push(
      node('mem-mp-redline', '记忆共享/mp-redline.md', { title: '部门安全红线', type: 'policy', authority: 'redline' }),
    )

    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph],
      maxChars: 0,
    })
    expect(result.entries.map(entry => entry.sourceId)).toEqual(['mem-mp-redline'])
    expect(result.entries[0]!.nonOverridable).toBe(true)
    expect(result.systemPolicy).toBe(SYSTEM_POLICY_MARKER)
  })

  it('orders redline, canonical, personal current memory, then shared advisory', async () => {
    const fixture = await makeFixture()
    const shared = await sharedFixture()
    roots.push(fixture.root)
    const memoryRoot = join(fixture.root, 'personal', 'u1', '个人记忆图谱')
    const store = new MemoryStore(memoryRoot, { now: () => new Date(NOW) })
    const preference = await store.upsertPreference({
      type: 'preference',
      topic: '汇报',
      value: '先讲结论',
      displayTitle: '汇报先讲结论',
      privacy: 'normal',
    })

    const result = await resolveMemoryContext({
      viewer: viewer(),
      usersRoot: fixture.usersRoot,
      userId: 'u1',
      graphs: [fixture.graph, shared.graph],
      bindings: [
        binding({ sourceType: 'node', sourceId: 'node-a', mode: 'subscribe' }),
        binding({ sourceType: 'node', sourceId: 'node-c', mode: 'subscribe' }),
      ],
      personalMemoryRoot: memoryRoot,
    })
    expect(result.entries.map(entry => entry.sourceId)).toEqual([
      'node-c',
      'node-a',
      preference.id,
      'mem-mp-1',
    ])
  })
})
