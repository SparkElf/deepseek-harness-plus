import { describe, expect, it } from 'vitest'
import type { LoadedGraph, LoadedGraphEdge, LoadedGraphNode } from '../src/graphModel.ts'
import {
  graphScopeBase,
  graphStorePath,
  mergeProjectedGraphs,
  projectGraphJsonScope,
} from '../src/graphJsonProjection.ts'
import { emptyKnowledgeGraphTree } from '../src/graphTypes.ts'

function node(overrides: Partial<LoadedGraphNode> & Pick<LoadedGraphNode, 'id' | 'path'>): LoadedGraphNode {
  return {
    id: overrides.id,
    path: overrides.path,
    type: overrides.type ?? 'policy',
    title: overrides.title ?? '',
    authority: overrides.authority ?? 'advisory',
    internalizable: overrides.internalizable ?? true,
    origin: overrides.origin ?? 'human',
    reviewStatus: overrides.reviewStatus ?? 'approved',
    tags: overrides.tags ?? [],
    sourceRefs: overrides.sourceRefs ?? [],
    missing: overrides.missing ?? false,
  }
}

function edge(overrides: Partial<LoadedGraphEdge> & Pick<LoadedGraphEdge, 'id' | 'from' | 'to'>): LoadedGraphEdge {
  return {
    id: overrides.id,
    from: overrides.from,
    to: overrides.to,
    type: overrides.type ?? 'depends_on',
    authority: overrides.authority ?? 'advisory',
    internalizable: overrides.internalizable ?? true,
    origin: overrides.origin ?? 'human',
    reviewStatus: overrides.reviewStatus ?? 'approved',
    tags: overrides.tags ?? [],
    sourceRefs: overrides.sourceRefs ?? [],
    missing: overrides.missing ?? false,
  }
}

function loaded(overrides: Partial<LoadedGraph> = {}): LoadedGraph {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'procurement',
      name: '采购制度图谱',
      scope: 'department:data-platform',
      version: 3,
      status: 'published',
      createdAt: '2026-11-01T10:00:00+08:00',
      updatedAt: '2026-11-12T11:00:00+08:00',
      tags: ['采购'],
      visibility: 'department',
      nodes: [
        { id: 'node-procurement', path: '制度/采购制度.md' },
        { id: 'node-approval', path: '流程/审批流程.md' },
      ],
      edges: [{ id: 'edge-001', from: 'node-procurement', to: 'node-approval', type: 'depends_on' }],
    },
    root: '/kb/department/D1',
    nodes: [
      node({ id: 'node-procurement', path: '制度/采购制度.md', title: '采购制度', type: 'policy' }),
      node({ id: 'node-approval', path: '流程/审批流程.md', title: '审批流程', type: 'procedure' }),
    ],
    edges: [edge({ id: 'edge-001', from: 'node-procurement', to: 'node-approval' })],
    issues: [],
    ...overrides,
  }
}

describe('graph scope base', () => {
  it('strips the legacy graph folder from an authoritative root', () => {
    expect(graphScopeBase('department/D1/知识图谱')).toBe('department/D1')
    expect(graphScopeBase('global/知识图谱')).toBe('global')
    expect(graphScopeBase('personal/u1/知识图谱')).toBe('personal/u1')
  })

  it('leaves a root that is already a scope base alone', () => {
    expect(graphScopeBase('department/D1')).toBe('department/D1')
  })

  it('builds the hidden store path inside the scope base', () => {
    expect(graphStorePath('department/D1', 'procurement')).toBe('department/D1/.graphs/procurement')
    expect(graphStorePath('', 'procurement')).toBe('.graphs/procurement')
  })
})

describe('graph.json projection', () => {
  it('projects every node into a topic card and every resolvable edge into a link', () => {
    const [graph] = projectGraphJsonScope({
      key: 'department',
      viewBase: 'department/D1',
      actualBase: 'department/D1',
      groupKey: 'D1',
      groupLabel: '数据平台部',
      graphs: [loaded()],
    })
    expect(graph).toBeDefined()
    expect(graph?.format).toBe('graph-json')
    expect(graph?.readOnly).toBe(false)
    expect(graph?.name).toBe('采购制度图谱')
    expect(graph?.scope).toBe('department')
    expect(graph?.group).toBe('数据平台部')
    expect(graph?.id).toBe('department/D1/.graphs/procurement')
    expect(graph?.actualPath).toBe('department/D1/.graphs/procurement')
    expect(graph?.counts).toEqual({ topics: 2, links: 1, documents: 2 })
    expect(graph?.topics.map(topic => topic.id)).toEqual(['node-procurement', 'node-approval'])
    expect(graph?.topics[0]?.path).toBe('department/D1/制度/采购制度.md')
    expect(graph?.topics[0]?.status).toBe('approved')
    expect(graph?.topics[0]?.domain).toBe('policy')
    expect(graph?.links[0]).toMatchObject({ a: 'node-procurement', b: 'node-approval', label: 'depends_on' })
  })

  it('drops an edge whose endpoint is absent instead of drawing a broken arrow', () => {
    const graph = loaded({
      edges: [
        edge({ id: 'edge-001', from: 'node-procurement', to: 'node-approval' }),
        edge({ id: 'edge-002', from: 'node-procurement', to: 'node-missing' }),
      ],
    })
    const [projected] = projectGraphJsonScope({
      key: 'global',
      viewBase: 'global',
      actualBase: 'global',
      graphs: [graph],
    })
    expect(projected?.counts.links).toBe(1)
    expect(projected?.links.map(link => link.a + '->' + link.b)).toEqual(['node-procurement->node-approval'])
  })

  it('syncs counts with what it actually projected', () => {
    const graph = loaded({
      nodes: [node({ id: 'only', path: 'a/only.md' })],
      edges: [],
    })
    const [projected] = projectGraphJsonScope({
      key: 'personal',
      viewBase: 'personal/u1',
      actualBase: 'personal/u1',
      graphs: [graph],
    })
    expect(projected?.counts).toEqual({ topics: 1, links: 0, documents: 1 })
  })
})

describe('merging projected graphs into the scanned tree', () => {
  it('appends into the matching scope without disturbing legacy graphs', () => {
    const tree = emptyKnowledgeGraphTree()
    const legacy = {
      id: 'global/知识图谱/old',
      name: '旧图谱',
      scope: 'global' as const,
      path: 'global/知识图谱/old',
      group: '',
      topics: [],
      links: [],
      counts: { topics: 0, links: 0, documents: 0 },
    }
    const globalScope = tree.scopes.find(scope => scope.key === 'global')
    globalScope?.groups.push({ key: '', label: '', graphs: [legacy] })
    const [projected] = projectGraphJsonScope({
      key: 'global',
      viewBase: 'global',
      actualBase: 'global',
      graphs: [loaded()],
    })
    mergeProjectedGraphs(tree, { global: projected === undefined ? [] : [projected] })
    const graphs = tree.scopes.find(scope => scope.key === 'global')?.groups[0]?.graphs ?? []
    expect(graphs.map(graph => graph.name)).toEqual(['旧图谱', '采购制度图谱'])
  })

  it('creates a flat group when the scanner returned none', () => {
    const tree = emptyKnowledgeGraphTree()
    const [projected] = projectGraphJsonScope({
      key: 'personal',
      viewBase: 'personal/u1',
      actualBase: 'personal/u1',
      graphs: [loaded()],
    })
    mergeProjectedGraphs(tree, { personal: projected === undefined ? [] : [projected] })
    const scope = tree.scopes.find(entry => entry.key === 'personal')
    expect(scope?.groups).toHaveLength(1)
    expect(scope?.groups[0]?.graphs[0]?.name).toBe('采购制度图谱')
  })
})
