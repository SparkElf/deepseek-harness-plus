/**
 * Cross-module acceptance tests for the memory-graph MVP.
 *
 * Each block exercises a different owner module through its public contract:
 * migration → loader, graph policy, guardian/bindings, and memory policy. The
 * fixtures are written into a tmpdir so the checked-in migration fixtures stay
 * read-only, and every assertion compares actual files on disk rather than a
 * module's own bookkeeping.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyMigration, planMigration, type MigrationReport } from '../src/graphMigration.ts'
import { loadGraph, validateGraph, type LoadedGraph } from '../src/graphModel.ts'
import {
  canManageGraph,
  canViewGraph,
  filterVisibleGraphs,
  type GraphScopeDescriptor,
  type GraphViewer,
} from '../src/graphPolicy.ts'
import { BindingStore, type PersonalBinding } from '../src/memoryBindings.ts'
import { runGuardianPass, type GuardianGraph } from '../src/memoryGuardian.ts'
import { decideMemoryAction, runtimeInjectionTags } from '../src/memoryPolicy.ts'

const roots: string[] = []

async function tempRoot(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  roots.push(directory)
  return directory
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

// ---------------------------------------------------------------------------
// A1-A3: migration dry-run reconciliation
// ---------------------------------------------------------------------------

const POLICY_DOC = [
  '---',
  'title: 采购制度',
  'type: policy',
  'authority: canonical',
  '---',
  '# 采购制度',
  '',
  '采购金额分级审批，十万元以上由分管领导审批。',
  '',
].join('\n')

const APPROVAL_BODY = [
  '---',
  'id: node-approval',
  'title: 审批流程',
  'type: procedure',
  'authority: canonical',
  'reviewStatus: approved',
  '---',
  '# 审批流程',
  '',
  '审批由部门负责人发起，财务复核后归档。',
  '',
].join('\n')

const APPROVAL_LEGACY = [
  '---',
  'id: node-approval',
  'title: 审批流程',
  'type: procedure',
  'sourceRefs: [旧图谱]',
  'authority: canonical',
  '---',
  '# 审批流程',
  '',
  '审批由部门负责人发起，财务复核后归档。',
  '',
].join('\n')

const INDEPENDENT_DOC = [
  '---',
  'title: 独立文档',
  'type: fact',
  'authority: advisory',
  'origin: ai',
  'reviewStatus: draft',
  'generatedBy: model/fixture',
  '---',
  '# 独立文档',
  '',
  '这份文档只存在于旧图谱，需要迁移为独立图谱文档。',
  '',
].join('\n')

/**
 * A small legacy scope with every migration outcome the design names:
 * - `采购制度.md` is byte-identical to its classified copy (hash match);
 * - `审批流程.md` shares a frontmatter id with its classified copy (id match);
 * - `独立文档.md` has no classified copy (independent, moved);
 * - one `.kg` relation resolves both topic endpoints.
 */
async function writeMigrationFixture(root: string): Promise<void> {
  await write(join(root, '制度', '采购制度.md'), POLICY_DOC)
  await write(join(root, '流程', '审批流程.md'), APPROVAL_BODY)
  const graph = join(root, '知识图谱', '采购图谱')
  await write(join(graph, '制度', 'index.md'), '---\nid: topic-policy\ntitle: 制度\n---\n# 制度\n\n制度类文档。\n')
  await write(join(graph, '制度', '采购制度.md'), POLICY_DOC)
  await write(join(graph, '流程', 'index.md'), '---\nid: topic-flow\ntitle: 流程\n---\n# 流程\n\n流程类文档。\n')
  await write(join(graph, '流程', '审批流程.md'), APPROVAL_LEGACY)
  await write(join(graph, '模板', 'index.md'), '---\nid: topic-template\ntitle: 模板\n---\n# 模板\n\n模板类文档。\n')
  await write(join(graph, '模板', '独立文档.md'), INDEPENDENT_DOC)
  await write(
    join(graph, '.kg', 'links', 'topic-policy--topic-flow.md'),
    '---\na: topic-policy\nb: topic-flow\nlabel: 制度依赖流程\n---\n制度执行依赖流程定义。\n',
  )
}

function graphCount(report: MigrationReport): { topics: number; documents: number; links: number } {
  const graph = report.graphs.find(entry => entry.graphId === '采购图谱')
  expect(graph, 'migration report must inventory 采购图谱').toBeDefined()
  return { topics: graph!.topics, documents: graph!.documents, links: graph!.links }
}

describe('migration reconciliation against the new manifest', () => {
  it('plans the same node/edge counts that loadGraph reports after apply', async () => {
    const root = await tempRoot('kb-memory-migration-')
    await writeMigrationFixture(root)

    const plan = await planMigration({ scopeRoot: root, dryRun: true, now: '2026-11-12T13:20:00+08:00' })

    // Dry run is read-only: no manifest and no hidden graph directory yet.
    expect(plan.dryRun).toBe(true)
    expect(await exists(join(root, '.graphs'))).toBe(false)
    // Topic cards are materialized as topic nodes (their bodies are preserved),
    // so the manifest holds 3 documents + 3 topic cards = 6 nodes.
    expect(graphCount(plan)).toEqual({ topics: 3, documents: 6, links: 1 })
    expect(plan.matched).toBe(2)
    expect(plan.independent).toBe(1)
    expect(plan.conflicts).toBe(0)
    expect(plan.brokenEdges).toBe(0)
    expect(plan.issues.filter(entry => entry.severity === 'error')).toEqual([])
    expect(plan.plannedMoves).toEqual([
      { from: '知识图谱/采购图谱/流程/index.md', to: '图谱文档/采购图谱/流程/index.md' },
      { from: '知识图谱/采购图谱/模板/独立文档.md', to: '图谱文档/采购图谱/模板/独立文档.md' },
      { from: '知识图谱/采购图谱/模板/index.md', to: '图谱文档/采购图谱/模板/index.md' },
      { from: '知识图谱/采购图谱/制度/index.md', to: '图谱文档/采购图谱/制度/index.md' },
    ])
    // Both duplicate bodies are slated for deletion; the relation moves to links/.
    expect(plan.plannedDeletes).toContain('知识图谱/采购图谱/制度/采购制度.md')
    expect(plan.plannedDeletes).toContain('知识图谱/采购图谱/流程/审批流程.md')
    expect(plan.plannedDeletes).toContain('知识图谱/采购图谱/.kg/links/topic-policy--topic-flow.md')
    // The dry run wrote nothing at all.
    expect(await exists(join(root, '图谱文档'))).toBe(false)
    expect(await readFile(join(root, '知识图谱/采购图谱/制度/采购制度.md'), 'utf8')).toBe(POLICY_DOC)

    const applied = await applyMigration({
      scopeRoot: root,
      dryRun: false,
      now: '2026-11-12T13:20:00+08:00',
      report: plan,
    })
    expect(applied.applied).toBe(true)

    const loaded = await loadGraph(root, '采购图谱')
    const counts = graphCount(applied)

    // The reconciliation the design asks for: report counts === loaded topology.
    expect(loaded.nodes).toHaveLength(counts.documents)
    expect(loaded.edges).toHaveLength(counts.links)
    expect(loaded.manifest.topics).toHaveLength(counts.topics)
    expect(validateGraph(loaded)).toEqual([])

    // Every referenced body exists and every edge endpoint resolves.
    for (const node of loaded.nodes) {
      expect(await exists(join(root, node.path)), node.path).toBe(true)
    }
    const nodeIds = new Set(loaded.nodes.map(node => node.id))
    for (const edge of loaded.edges) {
      expect(nodeIds.has(edge.from)).toBe(true)
      expect(nodeIds.has(edge.to)).toBe(true)
    }

    // Exactly one body for the hash-matched document; the legacy copy is gone.
    expect(await exists(join(root, '知识图谱/采购图谱/制度/采购制度.md'))).toBe(false)
    expect(await exists(join(root, '制度/采购制度.md'))).toBe(true)
    expect(loaded.nodes.filter(node => node.path.endsWith('采购制度.md'))).toHaveLength(1)
  })

  it('carries the AI origin tag through migration, loading and serialization', async () => {
    const root = await tempRoot('kb-memory-origin-')
    await writeMigrationFixture(root)
    const plan = await planMigration({ scopeRoot: root, dryRun: true, now: '2026-11-12T13:20:00+08:00' })
    await applyMigration({ scopeRoot: root, dryRun: false, now: '2026-11-12T13:20:00+08:00', report: plan })

    const loaded: LoadedGraph = await loadGraph(root, '采购图谱')
    const independent = loaded.nodes.find(node => node.path === '图谱文档/采购图谱/模板/独立文档.md')
    expect(independent).toBeDefined()
    expect(independent?.origin).toBe('ai')
    expect(independent?.reviewStatus).toBe('draft')

    // The provenance is present in the serialized node data, not just a field
    // a UI could reconstruct from somewhere else.
    const serialized = JSON.stringify(loaded.nodes)
    expect(serialized).toContain('"origin":"ai"')

    // `generatedBy` is part of the design's frontmatter (design §7) but not of
    // the loader's GraphNodeAttributes contract (interfaces §1), so it must
    // survive in the migrated body even though the attribute projection drops
    // it. That keeps the provenance recoverable without inventing a field.
    const independentBody = await readFile(join(root, '图谱文档/采购图谱/模板/独立文档.md'), 'utf8')
    expect(independentBody).toContain('generatedBy: model/fixture')
    expect(independentBody).toContain('origin: ai')

    // A human document without an origin field is explicitly defaulted, never
    // left ambiguous.
    const policyNode = loaded.nodes.find(node => node.path === '制度/采购制度.md')
    expect(policyNode?.origin).toBe('human')

    expect(runtimeInjectionTags(independent!).originTag).toBe('AI 生成')
  })
})

describe('AI provenance gates publishing', () => {
  const admin: GraphViewer = {
    userId: 'admin-1',
    isAdmin: true,
    isSuperAdmin: false,
    departmentCode: 'D0',
    visibleDepartmentCodes: ['D0'],
  }

  it('allows publishing AI content only when the origin tag is present', () => {
    const aiNode = {
      id: 'node-ai',
      authority: 'advisory' as const,
      internalizable: true,
      origin: 'ai' as const,
      reviewStatus: 'draft' as const,
    }
    expect(decideMemoryAction({ action: 'publish', node: aiNode, viewer: admin })).toEqual({ allowed: true })

    const unstamped = { id: 'node-ai', authority: 'advisory' as const, internalizable: true }
    const denied = decideMemoryAction({ action: 'publish', node: unstamped, viewer: admin })
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe('missing-origin')
  })
})

// ---------------------------------------------------------------------------
// A4: permission boundary matrix
// ---------------------------------------------------------------------------

describe('graph permission boundary matrix', () => {
  const member: GraphViewer = {
    userId: 'member-1',
    isAdmin: false,
    isSuperAdmin: false,
    departmentCode: 'D1',
    visibleDepartmentCodes: ['D1'],
  }
  const departmentAdmin: GraphViewer = {
    userId: 'dept-admin-1',
    isAdmin: false,
    isSuperAdmin: false,
    departmentCode: 'D1',
    visibleDepartmentCodes: ['D1', 'D1.1'],
    manageableDepartmentCodes: ['D1', 'D1.1'],
  }
  const admin: GraphViewer = {
    userId: 'admin-1',
    isAdmin: true,
    isSuperAdmin: false,
    departmentCode: 'D0',
    visibleDepartmentCodes: ['D0', 'D1', 'D1.1', 'D2'],
    manageableDepartmentCodes: ['D1', 'D1.1', 'D2'],
  }
  const superAdmin: GraphViewer = {
    userId: 'super-1',
    isAdmin: true,
    isSuperAdmin: true,
    departmentCode: 'D0',
    visibleDepartmentCodes: ['D0'],
  }

  const globalGraph: GraphScopeDescriptor = { visibility: 'global' }
  const departmentD1: GraphScopeDescriptor = { visibility: 'department', departmentCode: 'D1' }
  const departmentD11: GraphScopeDescriptor = { visibility: 'department', departmentCode: 'D1.1' }
  const departmentD2: GraphScopeDescriptor = { visibility: 'department', departmentCode: 'D2' }
  const memberPrivate: GraphScopeDescriptor = { visibility: 'private', ownerId: 'member-1' }
  const someoneElsePrivate: GraphScopeDescriptor = { visibility: 'private', ownerId: 'member-2' }

  const cases: Array<{
    name: string
    viewer: GraphViewer
    scope: GraphScopeDescriptor
    view: boolean
    manage: boolean
  }> = [
    { name: 'member sees global', viewer: member, scope: globalGraph, view: true, manage: false },
    { name: 'member sees own department', viewer: member, scope: departmentD1, view: true, manage: false },
    { name: 'member cannot see a sub-department', viewer: member, scope: departmentD11, view: false, manage: false },
    { name: 'member cannot see another department', viewer: member, scope: departmentD2, view: false, manage: false },
    { name: 'member sees own private graph', viewer: member, scope: memberPrivate, view: true, manage: true },
    { name: 'member cannot see another private graph', viewer: member, scope: someoneElsePrivate, view: false, manage: false },

    { name: 'department admin sees own department', viewer: departmentAdmin, scope: departmentD1, view: true, manage: true },
    { name: 'department admin sees and manages the subtree', viewer: departmentAdmin, scope: departmentD11, view: true, manage: true },
    { name: 'department admin cannot manage global', viewer: departmentAdmin, scope: globalGraph, view: true, manage: false },
    { name: 'department admin cannot see another department', viewer: departmentAdmin, scope: departmentD2, view: false, manage: false },
    { name: 'department admin does not see private graphs', viewer: departmentAdmin, scope: memberPrivate, view: false, manage: false },

    { name: 'admin sees managed departments', viewer: admin, scope: departmentD2, view: true, manage: true },
    { name: 'admin manages global graphs', viewer: admin, scope: globalGraph, view: true, manage: true },
    { name: 'admin does not see private graphs', viewer: admin, scope: someoneElsePrivate, view: false, manage: false },

    { name: 'super admin sees every department', viewer: superAdmin, scope: departmentD2, view: true, manage: true },
    { name: 'super admin does not see private graphs by default', viewer: superAdmin, scope: memberPrivate, view: false, manage: false },
    { name: 'super admin owns their own private graph', viewer: superAdmin, scope: { visibility: 'private', ownerId: 'super-1' }, view: true, manage: true },
  ]

  it.each(cases)('$name', ({ viewer, scope, view, manage }) => {
    expect(canViewGraph(viewer, scope)).toBe(view)
    expect(canManageGraph(viewer, scope)).toBe(manage)
  })

  it('filters a mixed list without leaking a private or out-of-scope name', () => {
    const graphs = [
      { name: '全局', scope: globalGraph },
      { name: '本部门', scope: departmentD1 },
      { name: '外部门', scope: departmentD2 },
      { name: '我的私有', scope: memberPrivate },
      { name: '他人私有', scope: someoneElsePrivate },
    ]
    expect(filterVisibleGraphs(member, graphs).map(graph => graph.name)).toEqual(['全局', '本部门', '我的私有'])
    expect(filterVisibleGraphs(superAdmin, graphs).map(graph => graph.name)).toEqual(['全局', '本部门', '外部门'])
  })
})

// ---------------------------------------------------------------------------
// A5-A8: subscribe vs internalize, redline
// ---------------------------------------------------------------------------

const NODE_A_PATH = '制度/采购制度.md'
const NODE_B_PATH = '流程/审批流程.md'

interface GuardianFixture {
  root: string
  usersRoot: string
  store: BindingStore
}

/**
 * Write a loadable `.graphs/g1` graph plus its node bodies, so the guardian is
 * fed a real `LoadedGraph` rather than a hand-built structural stub.
 */
async function writeGuardianFixture(
  root: string,
  options: {
    version?: number
    nodeA?: { authority?: string; internalizable?: boolean; body?: string }
    extraNodes?: Array<{ id: string; path: string; authority?: string }>
    extraEdges?: Array<{ id: string; from: string; to: string; authority?: string }>
  } = {},
): Promise<void> {
  const version = options.version ?? 1
  const nodeABody = options.nodeA?.body ?? '采购正文 第一版'
  await write(join(root, NODE_A_PATH), [
    '---',
    'id: node-a',
    'type: policy',
    'title: 采购制度',
    `authority: ${options.nodeA?.authority ?? 'canonical'}`,
    `internalizable: ${options.nodeA?.internalizable ?? true}`,
    'origin: human',
    'reviewStatus: approved',
    '---',
    '# 采购制度',
    '',
    nodeABody,
    '',
  ].join('\n'))
  await write(join(root, NODE_B_PATH), [
    '---',
    'id: node-b',
    'type: procedure',
    'title: 审批流程',
    'authority: advisory',
    'internalizable: true',
    'origin: ai',
    'reviewStatus: reviewed',
    '---',
    '# 审批流程',
    '',
    '审批正文 B',
    '',
  ].join('\n'))
  await write(join(root, '.graphs', 'g1', 'links', 'edge-1.md'), [
    '---',
    'id: edge-1',
    'from: node-a',
    'to: node-b',
    'authority: advisory',
    'internalizable: true',
    'origin: human',
    'reviewStatus: approved',
    '---',
    '# 采购依赖审批',
    '',
    '关系正文：采购制度依赖审批流程。',
    '',
  ].join('\n'))

  const nodes: Array<{ id: string; path: string }> = [
    { id: 'node-a', path: NODE_A_PATH },
    { id: 'node-b', path: NODE_B_PATH },
  ]
  const edges: Array<{ id: string; from: string; to: string; type: string; doc?: string }> = [
    { id: 'edge-1', from: 'node-a', to: 'node-b', type: 'depends_on', doc: '.graphs/g1/links/edge-1.md' },
  ]

  for (const extra of options.extraNodes ?? []) {
    await write(join(root, extra.path), [
      '---',
      `id: ${extra.id}`,
      'type: fact',
      `title: ${extra.id}`,
      `authority: ${extra.authority ?? 'advisory'}`,
      'internalizable: true',
      'origin: human',
      '---',
      `# ${extra.id}`,
      '',
      `${extra.id} 正文`,
      '',
    ].join('\n'))
    nodes.push({ id: extra.id, path: extra.path })
  }
  for (const extra of options.extraEdges ?? []) {
    await write(join(root, '.graphs', 'g1', 'links', `${extra.id}.md`), [
      '---',
      `id: ${extra.id}`,
      `from: ${extra.from}`,
      `to: ${extra.to}`,
      'type: relates_to',
      `authority: ${extra.authority ?? 'advisory'}`,
      'internalizable: true',
      'origin: human',
      '---',
      `${extra.id} 关系正文`,
      '',
    ].join('\n'))
    edges.push({
      id: extra.id,
      from: extra.from,
      to: extra.to,
      type: 'relates_to',
      doc: `.graphs/g1/links/${extra.id}.md`,
    })
  }

  const manifest = {
    schemaVersion: 1,
    id: 'g1',
    name: '采购制度图谱',
    description: 'fixture',
    scope: 'department:OPS',
    version,
    status: 'published',
    createdAt: '2026-11-12T05:00:00.000Z',
    updatedAt: '2026-11-12T05:00:00.000Z',
    tags: [],
    visibility: 'department',
    topics: [],
    nodes,
    edges,
  }
  await write(join(root, '.graphs', 'g1', 'graph.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function makeGuardianFixture(
  options?: Parameters<typeof writeGuardianFixture>[1],
): Promise<GuardianFixture> {
  const root = await tempRoot('kb-memory-guardian-')
  const usersRoot = join(root, 'users')
  await mkdir(usersRoot, { recursive: true })
  await writeGuardianFixture(root, options)
  return { root, usersRoot, store: new BindingStore(usersRoot) }
}

async function asGuardianGraph(root: string): Promise<GuardianGraph> {
  const loaded = await loadGraph(root, 'g1')
  return {
    manifest: loaded.manifest,
    root: loaded.root,
    nodes: loaded.nodes,
    edges: loaded.edges,
  }
}

async function requestInternalize(
  store: BindingStore,
  userId: string,
  sourceType: 'node' | 'edge',
  sourceId: string,
): Promise<PersonalBinding> {
  const binding = await store.get(userId, sourceType, sourceId)
  expect(binding, `${sourceType} ${sourceId} must exist before internalizing`).toBeDefined()
  const pending: PersonalBinding = { ...binding!, mode: 'pending', requestedMode: 'internalize' }
  await store.set(pending)
  return pending
}

describe('subscribe is a live proxy, internalize is an independent branch', () => {
  it('resolves a new node to a source-relative proxy and copies no body', async () => {
    const fixture = await makeGuardianFixture()
    const graph = await asGuardianGraph(fixture.root)

    const result = await runGuardianPass({
      graph,
      usersRoot: fixture.usersRoot,
      userIds: ['u1'],
      now: '2026-11-12T05:20:04.000Z',
    })
    expect(result).toMatchObject({ createdPending: 3, subscribed: 3, internalized: 0 })

    const binding = await fixture.store.get('u1', 'node', 'node-a')
    expect(binding).toMatchObject({
      mode: 'subscribe',
      status: 'active',
      sourceVersion: 1,
      localPath: NODE_A_PATH,
    })
    // No personal body exists; the proxy points at the department document.
    expect(await exists(join(fixture.usersRoot, 'u1', 'memory'))).toBe(false)
    const bindingFile = await readFile(join(fixture.usersRoot, 'u1', 'bindings', 'node-node-a.yaml'), 'utf8')
    expect(bindingFile).not.toContain('采购正文 第一版')

    // "Live" means a source edit is visible through the proxy path immediately.
    await write(join(fixture.root, NODE_A_PATH), POLICY_DOC.replace('采购金额分级审批', '采购金额分级审批（第二版）'))
    const viaProxy = await readFile(join(fixture.root, binding!.localPath!), 'utf8')
    expect(viaProxy).toContain('第二版')
  })

  it('keeps an internalized body independent and marks it stale on a source update', async () => {
    const fixture = await makeGuardianFixture()
    const v1 = await asGuardianGraph(fixture.root)
    await runGuardianPass({ graph: v1, usersRoot: fixture.usersRoot, userIds: ['u1'], now: '2026-11-12T05:20:04.000Z' })
    await requestInternalize(fixture.store, 'u1', 'node', 'node-a')
    const internalized = await runGuardianPass({
      graph: v1,
      usersRoot: fixture.usersRoot,
      userIds: ['u1'],
      now: '2026-11-12T07:00:00.000Z',
    })
    expect(internalized).toMatchObject({ internalized: 1, subscribed: 0, rejectedRedline: 0 })

    const localPath = join(fixture.usersRoot, 'u1', 'memory', 'g1', 'node-a.md')
    const forked = await readFile(localPath, 'utf8')
    expect(forked).toContain('采购正文 第一版')
    const active = await fixture.store.get('u1', 'node', 'node-a')
    expect(active).toMatchObject({ mode: 'internalize', status: 'active', sourceVersion: 1 })
    expect(active?.lineage.forkedFromVersion).toBe(1)
    expect(active?.lineage.forkedAt).toBe('2026-11-12T07:00:00.000Z')

    // The department publishes version 2 with a different body.
    await writeGuardianFixture(fixture.root, { version: 2, nodeA: { body: '采购正文 第二版（部门已更新）' } })
    const v2 = await asGuardianGraph(fixture.root)
    const updated = await runGuardianPass({
      graph: v2,
      usersRoot: fixture.usersRoot,
      userIds: ['u1'],
      now: '2026-11-13T07:00:00.000Z',
    })
    expect(updated.upstreamUpdates).toBeGreaterThanOrEqual(1)

    const stale = await fixture.store.get('u1', 'node', 'node-a')
    expect(stale).toMatchObject({ mode: 'internalize', status: 'stale', sourceVersion: 2 })
    expect(stale?.lineage.forkedFromVersion).toBe(1)
    // The local branch keeps the forked body: no automatic overwrite.
    expect(await readFile(localPath, 'utf8')).toBe(forked)
    expect(await readFile(localPath, 'utf8')).not.toContain('部门已更新')
    // The source itself did change, so the test cannot pass by accident.
    expect(await readFile(join(fixture.root, NODE_A_PATH), 'utf8')).toContain('部门已更新')
  })

  it('refuses a redline node and never writes a personal body', async () => {
    const fixture = await makeGuardianFixture({
      nodeA: { authority: 'redline', internalizable: false },
    })
    const graph = await asGuardianGraph(fixture.root)
    await runGuardianPass({ graph, usersRoot: fixture.usersRoot, userIds: ['u1'], now: '2026-11-12T05:20:04.000Z' })
    await requestInternalize(fixture.store, 'u1', 'node', 'node-a')

    const result = await runGuardianPass({
      graph,
      usersRoot: fixture.usersRoot,
      userIds: ['u1'],
      now: '2026-11-12T07:00:00.000Z',
    })
    expect(result.rejectedRedline).toBe(1)
    expect(result.internalized).toBe(0)
    expect(await fixture.store.get('u1', 'node', 'node-a')).toMatchObject({ mode: 'subscribe', status: 'active' })
    expect(await exists(join(fixture.usersRoot, 'u1', 'memory', 'g1', 'node-a.md'))).toBe(false)

    const loaded = await loadGraph(fixture.root, 'g1')
    const redlineNode = loaded.nodes.find(node => node.id === 'node-a')!
    const decision = decideMemoryAction({ action: 'internalize', node: redlineNode })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('redline')
    expect(decision.nonOverridable).toBe(true)
  })

  it('refuses a redline edge, whether inherited from an endpoint or set on the relation', async () => {
    const fixture = await makeGuardianFixture({
      nodeA: { authority: 'redline', internalizable: false },
      extraNodes: [{ id: 'node-c', path: '模板/独立文档.md' }],
      extraEdges: [{ id: 'edge-2', from: 'node-b', to: 'node-c', authority: 'redline' }],
    })
    const graph = await asGuardianGraph(fixture.root)
    await runGuardianPass({ graph, usersRoot: fixture.usersRoot, userIds: ['u1'], now: '2026-11-12T05:20:04.000Z' })
    await requestInternalize(fixture.store, 'u1', 'edge', 'edge-1')
    await requestInternalize(fixture.store, 'u1', 'edge', 'edge-2')

    const result = await runGuardianPass({
      graph,
      usersRoot: fixture.usersRoot,
      userIds: ['u1'],
      now: '2026-11-12T07:00:00.000Z',
    })
    expect(result.rejectedRedline).toBe(2)
    expect(result.internalized).toBe(0)
    expect(await fixture.store.get('u1', 'edge', 'edge-1')).toMatchObject({ mode: 'subscribe' })
    expect(await fixture.store.get('u1', 'edge', 'edge-2')).toMatchObject({ mode: 'subscribe' })
    expect(await exists(join(fixture.usersRoot, 'u1', 'memory', 'g1', 'edge-1.md'))).toBe(false)
    expect(await exists(join(fixture.usersRoot, 'u1', 'memory', 'g1', 'edge-2.md'))).toBe(false)

    // The policy layer agrees: an edge inherits a redline endpoint.
    const loaded = await loadGraph(fixture.root, 'g1')
    const edge = loaded.edges.find(entry => entry.id === 'edge-1')!
    const endpoints = loaded.nodes.filter(node => node.id === edge.from || node.id === edge.to)
    expect(decideMemoryAction({ action: 'internalize', edge, edgeEndpoints: endpoints }).allowed).toBe(false)
  })
})
