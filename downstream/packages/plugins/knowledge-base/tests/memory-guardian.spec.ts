import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BindingStore, type PersonalBinding } from '../src/memoryBindings.ts'
import {
  markUpstreamUpdates,
  runGuardianPass,
  type GuardianGraph,
  type GuardianSourceEdge,
  type GuardianSourceNode,
} from '../src/memoryGuardian.ts'

const NOW = '2026-11-12T05:20:04.000Z'
const LATER = '2026-11-12T07:00:00.000Z'

const ZERO_RESULT = {
  createdPending: 0,
  subscribed: 0,
  internalized: 0,
  rejectedRedline: 0,
  upstreamUpdates: 0,
  revoked: 0,
}

function defaultNodes(): GuardianSourceNode[] {
  return [
    {
      id: 'node-a',
      path: '制度/采购制度.md',
      type: 'policy',
      title: '采购制度',
      authority: 'canonical',
      internalizable: true,
      origin: 'human',
      reviewStatus: 'approved',
      tags: ['采购'],
      sourceRefs: [],
    },
    {
      id: 'node-b',
      path: '流程/审批流程.md',
      type: 'procedure',
      title: '审批流程',
      authority: 'advisory',
      internalizable: true,
      origin: 'ai',
      reviewStatus: 'reviewed',
      tags: ['流程'],
      sourceRefs: [],
    },
  ]
}

function defaultEdges(): GuardianSourceEdge[] {
  return [
    {
      id: 'edge-1',
      from: 'node-a',
      to: 'node-b',
      docPath: '.graphs/g1/links/edge-1.md',
      type: 'depends_on',
      title: '采购依赖审批',
      authority: 'advisory',
      internalizable: true,
      origin: 'human',
      reviewStatus: 'approved',
      tags: [],
      sourceRefs: [],
    },
  ]
}

interface Fixture {
  root: string
  usersRoot: string
  store: BindingStore
  graph: (options?: GraphOptions) => GuardianGraph
}

interface GraphOptions {
  nodes?: GuardianSourceNode[]
  edges?: GuardianSourceEdge[]
  version?: number
  commit?: string
  status?: string
  scope?: string
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'kb-guardian-'))
  const usersRoot = join(root, 'users')
  await mkdir(usersRoot, { recursive: true })

  await mkdir(join(root, '制度'), { recursive: true })
  await writeFile(
    join(root, '制度', '采购制度.md'),
    '---\nid: node-a\ntype: policy\ntitle: 采购制度\n---\n\n采购正文 A 版本 3\n',
  )
  await mkdir(join(root, '流程'), { recursive: true })
  await writeFile(
    join(root, '流程', '审批流程.md'),
    '---\nid: node-b\ntype: procedure\ntitle: 审批流程\n---\n\n审批正文 B\n',
  )
  await mkdir(join(root, '.graphs', 'g1', 'links'), { recursive: true })
  await writeFile(
    join(root, '.graphs', 'g1', 'links', 'edge-1.md'),
    '---\nid: edge-1\nfrom: node-a\nto: node-b\n---\n\n关系正文\n',
  )

  const graph: Fixture['graph'] = (options = {}) => ({
    manifest: {
      schemaVersion: 1,
      id: 'g1',
      name: '采购制度图谱',
      scope: options.scope ?? 'department:OPS',
      version: options.version ?? 3,
      status: options.status ?? 'published',
      tags: [],
      visibility: 'department',
    },
    root,
    commit: options.commit ?? 'commit-3',
    nodes: options.nodes ?? defaultNodes(),
    edges: options.edges ?? defaultEdges(),
  })

  return { root, usersRoot, store: new BindingStore(usersRoot), graph }
}

async function requestInternalize(
  store: BindingStore,
  userId: string,
  sourceType: 'node' | 'edge',
  sourceId: string,
  now = LATER,
): Promise<PersonalBinding> {
  const binding = await store.get(userId, sourceType, sourceId)
  expect(binding).toBeDefined()
  const pending: PersonalBinding = { ...binding!, mode: 'pending', requestedMode: 'internalize', updatedAt: now }
  await store.set(pending)
  return pending
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('guardian pass: discovery and proxies', () => {
  let fixture: Fixture

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it('resolves new nodes and edges to live proxies without copying any body', async () => {
    fixture = await makeFixture()

    const result = await runGuardianPass({
      graph: fixture.graph(),
      usersRoot: fixture.usersRoot,
      userIds: ['u1'],
      now: NOW,
    })

    expect(result).toEqual({ ...ZERO_RESULT, createdPending: 3, subscribed: 3 })

    const node = await fixture.store.get('u1', 'node', 'node-a')
    expect(node).toMatchObject({
      mode: 'subscribe',
      status: 'active',
      sourceVersion: 3,
      sourceCommit: 'commit-3',
      localPath: '制度/采购制度.md',
    })
    expect(node?.lineage.subscribedAt).toBe(NOW)

    const edge = await fixture.store.get('u1', 'edge', 'edge-1')
    expect(edge).toMatchObject({ mode: 'subscribe', localPath: '.graphs/g1/links/edge-1.md' })

    expect(await pathExists(join(fixture.usersRoot, 'u1', 'memory'))).toBe(false)
    expect((await readdir(join(fixture.usersRoot, 'u1', 'bindings'))).sort()).toEqual([
      'edge-edge-1.yaml',
      'node-node-a.yaml',
      'node-node-b.yaml',
    ])

    // No version change, no pending work: a second pass writes nothing.
    const again = await runGuardianPass({
      graph: fixture.graph(),
      usersRoot: fixture.usersRoot,
      userIds: ['u1'],
      now: '2026-11-12T06:00:00.000Z',
    })
    expect(again).toEqual(ZERO_RESULT)
    expect((await fixture.store.get('u1', 'node', 'node-a'))?.updatedAt).toBe(NOW)
  })

  it('skips draft graphs and department-scoped graphs for another department', async () => {
    fixture = await makeFixture()

    const draft = await runGuardianPass({
      graph: fixture.graph({ status: 'draft' }),
      usersRoot: fixture.usersRoot,
      userIds: ['u1'],
      now: NOW,
    })
    expect(draft).toEqual(ZERO_RESULT)

    const otherDepartment = await runGuardianPass({
      graph: fixture.graph({ scope: 'department:OPS' }),
      usersRoot: fixture.usersRoot,
      userIds: ['u1'],
      departmentCode: 'DATA',
      now: NOW,
    })
    expect(otherDepartment).toEqual(ZERO_RESULT)
    expect(await fixture.store.list('u1')).toEqual([])

    const sameDepartment = await runGuardianPass({
      graph: fixture.graph({ scope: 'department:OPS' }),
      usersRoot: fixture.usersRoot,
      userIds: ['u1'],
      departmentCode: 'OPS',
      now: NOW,
    })
    expect(sameDepartment.createdPending).toBe(3)
  })
})

describe('guardian pass: internalize', () => {
  let fixture: Fixture

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it('copies the body into the personal memory tree with frontmatter and lineage', async () => {
    fixture = await makeFixture()
    await runGuardianPass({ graph: fixture.graph(), usersRoot: fixture.usersRoot, userIds: ['u1'], now: NOW })
    await requestInternalize(fixture.store, 'u1', 'node', 'node-a')

    const result = await runGuardianPass({
      graph: fixture.graph(),
      usersRoot: fixture.usersRoot,
      userIds: ['u1'],
      now: LATER,
    })

    expect(result.internalized).toBe(1)
    expect(result.subscribed).toBe(0)

    const binding = await fixture.store.get('u1', 'node', 'node-a')
    expect(binding).toMatchObject({
      mode: 'internalize',
      status: 'active',
      localPath: 'memory/g1/node-a.md',
      sourceVersion: 3,
      sourceCommit: 'commit-3',
    })
    expect(binding?.lineage).toMatchObject({ forkedFromVersion: 3, forkedAt: LATER, divergence: [] })

    const text = await readFile(join(fixture.usersRoot, 'u1', 'memory', 'g1', 'node-a.md'), 'utf8')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('id: node-a')
    expect(text).toContain('type: policy')
    expect(text).toContain('title: 采购制度')
    expect(text).toContain('authority: canonical')
    expect(text).toContain('origin: human')
    expect(text).toContain('reviewStatus: approved')
    expect(text).toContain('sourceGraph: g1')
    expect(text).toContain('sourceVersion: 3')
    expect(text).toContain('sourceCommit: commit-3')
    expect(text.split('\n---\n').slice(1).join('\n---\n').trim()).toBe('采购正文 A 版本 3')

    // The subscribed sibling is a proxy: no personal copy.
    expect(await pathExists(join(fixture.usersRoot, 'u1', 'memory', 'g1', 'node-b.md'))).toBe(false)
  })

  it('rejects redline and non-internalizable nodes and falls back to a proxy', async () => {
    fixture = await makeFixture()
    const nodes = defaultNodes()
    nodes[0] = { ...nodes[0], authority: 'redline', internalizable: false }
    nodes[1] = { ...nodes[1], internalizable: false }
    const graph = fixture.graph({ nodes })

    await runGuardianPass({ graph, usersRoot: fixture.usersRoot, userIds: ['u1'], now: NOW })
    await requestInternalize(fixture.store, 'u1', 'node', 'node-a')
    await requestInternalize(fixture.store, 'u1', 'node', 'node-b')

    const result = await runGuardianPass({ graph, usersRoot: fixture.usersRoot, userIds: ['u1'], now: LATER })
    expect(result.rejectedRedline).toBe(2)
    expect(result.subscribed).toBe(2)
    expect(result.internalized).toBe(0)

    expect(await fixture.store.get('u1', 'node', 'node-a')).toMatchObject({ mode: 'subscribe', status: 'active' })
    expect(await fixture.store.get('u1', 'node', 'node-b')).toMatchObject({ mode: 'subscribe', status: 'active' })
    expect(await pathExists(join(fixture.usersRoot, 'u1', 'memory'))).toBe(false)
  })

  it('rejects redline edges and inherits redline from either endpoint', async () => {
    fixture = await makeFixture()
    const nodes = defaultNodes()
    nodes[0] = { ...nodes[0], authority: 'redline', internalizable: false }
    const edges: GuardianSourceEdge[] = [
      // Advisory relation, but its `from` endpoint is redline: inherited.
      { ...defaultEdges()[0], id: 'edge-1' },
      // Explicitly redline relation between two non-redline endpoints.
      { ...defaultEdges()[0], id: 'edge-2', from: 'node-b', to: 'node-a', authority: 'redline', docPath: undefined },
    ]
    const graph = fixture.graph({ nodes, edges })

    await runGuardianPass({ graph, usersRoot: fixture.usersRoot, userIds: ['u1'], now: NOW })
    await requestInternalize(fixture.store, 'u1', 'edge', 'edge-1')
    await requestInternalize(fixture.store, 'u1', 'edge', 'edge-2')

    const result = await runGuardianPass({ graph, usersRoot: fixture.usersRoot, userIds: ['u1'], now: LATER })
    expect(result.rejectedRedline).toBe(2)
    expect(result.internalized).toBe(0)
    expect(await fixture.store.get('u1', 'edge', 'edge-1')).toMatchObject({ mode: 'subscribe' })
    expect(await fixture.store.get('u1', 'edge', 'edge-2')).toMatchObject({ mode: 'subscribe' })
    expect(await pathExists(join(fixture.usersRoot, 'u1', 'memory', 'g1', 'edge-1.md'))).toBe(false)
    expect(await pathExists(join(fixture.usersRoot, 'u1', 'memory', 'g1', 'edge-2.md'))).toBe(false)
  })

  it('internalizes an edge only after both endpoints are internalized', async () => {
    fixture = await makeFixture()
    await runGuardianPass({ graph: fixture.graph(), usersRoot: fixture.usersRoot, userIds: ['u1'], now: NOW })

    await requestInternalize(fixture.store, 'u1', 'node', 'node-a')
    await requestInternalize(fixture.store, 'u1', 'edge', 'edge-1')

    const partial = await runGuardianPass({
      graph: fixture.graph(),
      usersRoot: fixture.usersRoot,
      userIds: ['u1'],
      now: LATER,
    })
    expect(partial.internalized).toBe(1)
    expect(await fixture.store.get('u1', 'edge', 'edge-1')).toMatchObject({ mode: 'pending' })
    expect(await pathExists(join(fixture.usersRoot, 'u1', 'memory', 'g1', 'edge-1.md'))).toBe(false)

    await requestInternalize(fixture.store, 'u1', 'node', 'node-b')
    const complete = await runGuardianPass({
      graph: fixture.graph(),
      usersRoot: fixture.usersRoot,
      userIds: ['u1'],
      now: '2026-11-12T08:00:00.000Z',
    })
    // node-b and edge-1 in the same pass: nodes are resolved before edges.
    expect(complete.internalized).toBe(2)
    expect(await fixture.store.get('u1', 'edge', 'edge-1')).toMatchObject({
      mode: 'internalize',
      localPath: 'memory/g1/edge-1.md',
    })

    const text = await readFile(join(fixture.usersRoot, 'u1', 'memory', 'g1', 'edge-1.md'), 'utf8')
    expect(text).toContain('from: node-a')
    expect(text).toContain('to: node-b')
    expect(text).toContain('sourceType: edge')
    expect(text).toContain('关系正文')
  })
})

describe('guardian pass: upstream versions and redline upgrades', () => {
  let fixture: Fixture

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it('refreshes subscribe proxies and marks internalize stale without overwriting the local body', async () => {
    fixture = await makeFixture()
    await runGuardianPass({ graph: fixture.graph(), usersRoot: fixture.usersRoot, userIds: ['u1'], now: NOW })
    await requestInternalize(fixture.store, 'u1', 'node', 'node-a')
    await runGuardianPass({ graph: fixture.graph(), usersRoot: fixture.usersRoot, userIds: ['u1'], now: LATER })

    const localPath = join(fixture.usersRoot, 'u1', 'memory', 'g1', 'node-a.md')
    const before = await readFile(localPath, 'utf8')

    // The department publishes version 4 with a changed body.
    await writeFile(
      join(fixture.root, '制度', '采购制度.md'),
      '---\nid: node-a\ntype: policy\ntitle: 采购制度\n---\n\n采购正文 A 版本 4\n',
    )
    const v4 = fixture.graph({ version: 4, commit: 'commit-4' })

    const updated = await markUpstreamUpdates({ graph: v4, usersRoot: fixture.usersRoot, userIds: ['u1'], now: LATER })
    expect(updated).toBe(3) // node-a, node-b and edge-1 were all at version 3

    expect(await fixture.store.get('u1', 'node', 'node-a')).toMatchObject({
      mode: 'internalize',
      status: 'stale',
      sourceVersion: 4,
      sourceCommit: 'commit-4',
    })
    expect(await fixture.store.get('u1', 'node', 'node-b')).toMatchObject({
      mode: 'subscribe',
      status: 'active',
      sourceVersion: 4,
    })
    expect(await readFile(localPath, 'utf8')).toBe(before)
    expect(await readFile(localPath, 'utf8')).not.toContain('版本 4')

    // Idempotent: the same version does not flag again.
    expect(await markUpstreamUpdates({ graph: v4, usersRoot: fixture.usersRoot, userIds: ['u1'], now: LATER })).toBe(0)

    const pass = await runGuardianPass({ graph: v4, usersRoot: fixture.usersRoot, userIds: ['u1'], now: LATER })
    expect(pass).toEqual(ZERO_RESULT)
    expect((await fixture.store.get('u1', 'node', 'node-a'))?.status).toBe('stale')
    expect(await readFile(localPath, 'utf8')).toBe(before)
  })

  it('revokes an internalized branch when the source is upgraded to redline', async () => {
    fixture = await makeFixture()
    await runGuardianPass({ graph: fixture.graph(), usersRoot: fixture.usersRoot, userIds: ['u1'], now: NOW })
    await requestInternalize(fixture.store, 'u1', 'node', 'node-a')
    await runGuardianPass({ graph: fixture.graph(), usersRoot: fixture.usersRoot, userIds: ['u1'], now: LATER })

    const localPath = join(fixture.usersRoot, 'u1', 'memory', 'g1', 'node-a.md')
    const before = await readFile(localPath, 'utf8')

    const nodes = defaultNodes()
    nodes[0] = { ...nodes[0], authority: 'redline', internalizable: false }
    const v4 = fixture.graph({ version: 4, commit: 'commit-4', nodes })

    const result = await runGuardianPass({ graph: v4, usersRoot: fixture.usersRoot, userIds: ['u1'], now: LATER })
    expect(result.revoked).toBe(1)
    expect(result.upstreamUpdates).toBe(3)

    const binding = await fixture.store.get('u1', 'node', 'node-a')
    expect(binding).toMatchObject({
      mode: 'subscribe',
      status: 'revoked',
      sourceVersion: 4,
      localPath: '制度/采购制度.md',
    })
    // The local body is retained for audit; it is simply no longer the branch.
    expect(await readFile(localPath, 'utf8')).toBe(before)

    const again = await runGuardianPass({ graph: v4, usersRoot: fixture.usersRoot, userIds: ['u1'], now: LATER })
    expect(again.revoked).toBe(0)
    expect(again).toEqual(ZERO_RESULT)
  })
})
