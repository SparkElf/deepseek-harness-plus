import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendOverviewGraph,
  appendOverviewGraphs,
  createKnowledgeGraphTools,
  isOverviewGraph,
  OVERVIEW_GRAPH_NAME,
  OVERVIEW_GRAPH_PATH,
  buildOverviewAggregate,
  graphDepartmentCodes,
  graphsForLevel,
  JsonOverviewStore,
  OVERVIEW_STORE_FALLBACK_DIR,
  OverviewStoreManager,
  overviewStoreScope,
  probeOverviewStoreDir,
  type KnowledgeGraphToolHost,
  type OverviewCrossLink,
  type OverviewStore,
  type OverviewStoreScope,
} from '../src/graphTools.ts'
import { loadGraph } from '../src/graphModel.ts'
import { projectGraphJsonScope } from '../src/graphJsonProjection.ts'
import type { KnowledgeAuditEntry } from '../src/views.ts'
import type { KnowledgeGraphNode } from '../src/graphTypes.ts'

const roots: string[] = []
const fakeExec = {} as never

async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kb-graph-overview-'))
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

/** A node document with the documented front-matter shape. */
function nodeDocument(fields: Record<string, string>, body = '正文'): string {
  return ['---', ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), '---', body].join('\n')
}

function manifest(id: string, name: string, nodes: Array<{ id: string; path: string }>, edges: Array<{
  id: string; from: string; to: string; type: string
}>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    name,
    scope: 'personal:u1',
    version: 2,
    status: 'draft',
    owner: 'u1',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    tags: [],
    visibility: 'private',
    nodes,
    edges,
  }
}

interface HostOptions {
  /** View ids (`personal/.graphs/<id>`) the caller may read; undefined means all. */
  readable?: string[]
  canWrite?: (relPath: string) => boolean
  /** The caller's department chain, root first. */
  departmentPathCodes?: string[]
  departmentPathNames?: string[]
}

/**
 * A scanning Host whose listGraphs mirrors the production catalogue: legacy
 * graphs plus every readable `.graphs/<id>/graph.json`, then the synthesized
 * overview. Actual and view paths are kept apart exactly as the real Host does.
 */
function makeHost(root: string, options: HostOptions = {}) {
  const audits: KnowledgeAuditEntry[] = []
  const toActual = (relPath: string): string => {
    const clean = relPath.replace(/^\/+/u, '')
    if (clean === 'personal' || clean.startsWith('personal/')) {
      const rest = clean.slice('personal'.length).replace(/^\//u, '')
      if (rest === 'u1' || rest.startsWith('u1/')) return join(root, clean)
      return join(root, 'personal', 'u1', rest)
    }
    return join(root, clean)
  }
  const host = {
    resolveCaller: async () => ({ userId: 'u1', label: '测试用户' }),
    resolveGraphCaller: async () => ({
      userId: 'u1',
      label: '测试用户',
      ...(options.departmentPathCodes === undefined ? {} : { departmentPathCodes: options.departmentPathCodes }),
      ...(options.departmentPathNames === undefined ? {} : { departmentPathNames: options.departmentPathNames }),
    }),
    canWrite: async (relPath: string) => options.canWrite?.(relPath) ?? true,
    readText: async (viewPath: string) => readFile(toActual(viewPath), 'utf8'),
    readActual: async (relPath: string) => readFile(toActual(relPath), 'utf8'),
    statActual: async (relPath: string) => {
      try {
        const info = await stat(toActual(relPath))
        return info.isDirectory() ? { kind: 'directory' as const } : { kind: 'file' as const, size: info.size }
      } catch {
        return undefined
      }
    },
    statEntry: async (relPath: string) => {
      try {
        const info = await stat(toActual(relPath))
        return info.isDirectory() ? { kind: 'directory' as const } : { kind: 'file' as const, size: info.size }
      } catch {
        return undefined
      }
    },
    createEntry: async (relPath: string, createOptions: { directory?: boolean; content?: string }) => {
      const full = toActual(relPath)
      if (createOptions.directory === true) {
        await mkdir(full, { recursive: true })
        return { relPath, kind: 'directory' as const }
      }
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, createOptions.content ?? '', { encoding: 'utf8', flag: 'wx' })
      return { relPath, kind: 'file' as const }
    },
    overwriteFile: async (relPath: string, content: string) => {
      await writeFile(toActual(relPath), content, 'utf8')
    },
    moveEntry: async (from: string, to: string) => {
      const source = toActual(from)
      const destination = toActual(to)
      if (await exists(destination)) throw new Error('destination already exists: ' + to)
      await mkdir(dirname(destination), { recursive: true })
      await rename(source, destination)
      return { from, to }
    },
    refreshView: async () => ({}),
    viewDir: (userId: string) => join(root, 'state', userId),
    appendAudit: async (_viewDir: string, entry: KnowledgeAuditEntry) => {
      audits.push(entry)
    },
    listGraphs: async (): Promise<KnowledgeGraphNode[]> => {
      const graphs: KnowledgeGraphNode[] = []
      const scope = join(root, 'personal', 'u1')
      const entries = await readdir(join(scope, '.graphs'), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const id = 'personal/.graphs/' + entry.name
        if (options.readable !== undefined && !options.readable.includes(id)) continue
        try {
          const loaded = await loadGraph(scope, entry.name)
          graphs.push(...projectGraphJsonScope({
            key: 'personal',
            viewBase: 'personal',
            actualBase: 'personal/u1',
            graphs: [loaded],
          }))
        } catch {
          // Not a readable graph; the production scanner skips it too.
        }
      }
      return appendOverviewGraph(host as unknown as KnowledgeGraphToolHost, graphs)
    },
  }
  return { host: host as unknown as KnowledgeGraphToolHost, audits, root, toActual }
}

const toolFor = (host: KnowledgeGraphToolHost, name: string) => {
  const definition = createKnowledgeGraphTools(host).find(tool => tool.name === name)
  if (definition === undefined) throw new Error(`missing tool ${name}`)
  return definition
}

const execute = async (host: KnowledgeGraphToolHost, name: string, args: Record<string, unknown>) => (
  toolFor(host, name).execute(args, fakeExec) as Promise<Record<string, any>>
)

function crossLink(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'x-policy-skill',
    fromGraph: 'personal/.graphs/proc',
    from: 'node-policy',
    toGraph: 'personal/.graphs/hr',
    to: 'node-skill',
    type: 'governs',
    authority: 'advisory',
    internalizable: true,
    origin: 'human',
    reviewStatus: 'draft',
    tags: ['跨图'],
    sourceRefs: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Two readable graphs, one unreadable graph, and a cross-link store. */
async function fixture(options: HostOptions = {}): Promise<{
  root: string
  host: KnowledgeGraphToolHost
  audits: KnowledgeAuditEntry[]
}> {
  const root = await tempRoot()
  const scope = join(root, 'personal', 'u1')
  await write(join(scope, '.graphs', 'proc', 'graph.json'), JSON.stringify(manifest('proc', '采购制度图谱', [
    { id: 'node-policy', path: '制度/采购制度.md' },
    { id: 'node-flow', path: '流程/审批流程.md' },
  ], [{ id: 'edge-1', from: 'node-policy', to: 'node-flow', type: 'depends_on' }]), null, 2))
  await write(join(scope, '制度', '采购制度.md'), nodeDocument({
    id: 'node-policy', type: 'policy', title: '采购制度', authority: 'canonical',
    internalizable: 'true', origin: 'human', reviewStatus: 'approved', tags: '[采购]', sourceRefs: '[]',
  }))
  await write(join(scope, '流程', '审批流程.md'), nodeDocument({
    id: 'node-flow', type: 'procedure', title: '审批流程', authority: 'advisory',
    internalizable: 'true', origin: 'human', reviewStatus: 'draft', tags: '[]', sourceRefs: '[]',
  }))

  await write(join(scope, '.graphs', 'hr', 'graph.json'), JSON.stringify(manifest('hr', '人力资源图谱', [
    { id: 'node-role', path: '人力/岗位.md' },
    { id: 'node-skill', path: '人力/技能.md' },
  ], [{ id: 'edge-2', from: 'node-role', to: 'node-skill', type: 'requires' }]), null, 2))
  await write(join(scope, '人力', '岗位.md'), nodeDocument({
    id: 'node-role', type: 'fact', title: '岗位', authority: 'advisory',
    internalizable: 'true', origin: 'human', reviewStatus: 'draft', tags: '[]', sourceRefs: '[]',
  }))
  await write(join(scope, '人力', '技能.md'), nodeDocument({
    id: 'node-skill', type: 'skill', title: '技能', authority: 'advisory',
    internalizable: 'true', origin: 'human', reviewStatus: 'draft', tags: '[]', sourceRefs: '[]',
  }))

  // A graph the caller may not read. Its node is the hidden side of one link.
  await write(join(scope, '.graphs', 'secret', 'graph.json'), JSON.stringify(manifest('secret', '机密图谱', [
    { id: 'secret-node', path: '机密/秘密.md' },
  ], []), null, 2))
  await write(join(scope, '机密', '秘密.md'), nodeDocument({
    id: 'secret-node', type: 'fact', title: '机密节点', authority: 'canonical',
    internalizable: 'false', origin: 'human', reviewStatus: 'approved', tags: '[]', sourceRefs: '[]',
  }))

  await write(join(scope, '.graphs', '__overview__', 'links.json'), JSON.stringify({
    schemaVersion: 1,
    links: [
      crossLink(),
      crossLink({ id: 'x-secret', toGraph: 'personal/.graphs/secret', to: 'secret-node' }),
      crossLink({ id: 'x-dangling', to: 'no-such-node' }),
    ],
  }, null, 2))

  return makeHost(root, {
    readable: ['personal/.graphs/proc', 'personal/.graphs/hr'],
    ...options,
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('overview graph catalogue', () => {
  it('adds the computed 总图 and never aggregates itself', async () => {
    const { host, root } = await fixture()
    const graphs = await host.listGraphs()
    const overview = graphs.find(isOverviewGraph)
    expect(overview).toBeDefined()
    expect(overview?.name).toBe(OVERVIEW_GRAPH_NAME)
    expect(overview?.id).toBe(OVERVIEW_GRAPH_PATH)
    expect(overview?.computed).toBe(true)
    expect(overview?.readOnly).toBe(true)
    expect(overview?.topics).toHaveLength(4)
    expect(overview?.topics.some(topic => String(topic.id).includes('__overview__'))).toBe(false)
    expect(graphs.filter(graph => graph.name === OVERVIEW_GRAPH_NAME)).toHaveLength(1)
    expect(await exists(join(root, 'personal', 'u1', '.graphs', '__overview__', 'graph.json'))).toBe(false)
  })

  it('excludes unreadable graphs from the catalogue and the aggregate', async () => {
    const { host } = await fixture({ readable: ['personal/.graphs/proc', 'personal/.graphs/hr'] })
    const graphs = await host.listGraphs()
    expect(graphs.some(graph => graph.name === '机密图谱')).toBe(false)
    const result = await execute(host, 'kg_get', { graph: OVERVIEW_GRAPH_NAME })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('机密')
    expect(serialized).not.toContain('secret-node')
    expect(result.graphs).toHaveLength(2)
    expect(result.totals).toEqual({ graphs: 2, nodes: 4, edges: 3, crossEdges: 1 })
  })
})

describe('kg_get 总图', () => {
  it('returns graph summaries, namespaced nodes and remapped edges', async () => {
    const { host } = await fixture()
    const result = await execute(host, 'kg_get', { graph: OVERVIEW_GRAPH_NAME })
    expect(result.ok).toBe(true)
    expect(result.overview).toBe(true)
    expect(result.computed).toBe(true)
    expect(result.readOnly).toBe(true)
    expect(result.graph.id).toBe(OVERVIEW_GRAPH_PATH)
    expect(result.graphs).toHaveLength(2)
    expect(result.graphs.map((graph: { id: string }) => graph.id).sort()).toEqual([
      'personal/.graphs/hr',
      'personal/.graphs/proc',
    ])
    const policy = result.nodes.find((node: { id: string }) => node.id === 'personal/.graphs/proc:node-policy')
    expect(policy).toMatchObject({
      graphId: 'personal/.graphs/proc',
      nodeId: 'node-policy',
      type: 'policy',
      title: '采购制度',
      authority: 'canonical',
      reviewStatus: 'approved',
      docPath: 'personal/制度/采购制度.md',
    })
    expect(result.nodes).toHaveLength(4)
    const internal = result.edges.find((edge: { from: string; to: string }) => (
      edge.from === 'personal/.graphs/proc:node-policy' && edge.to === 'personal/.graphs/proc:node-flow'
    ))
    expect(internal).toMatchObject({
      graphId: 'personal/.graphs/proc',
      crossGraph: false,
      type: 'depends_on',
    })
    const cross = result.edges.find((edge: { id: string }) => edge.id === 'x-policy-skill')
    expect(cross).toMatchObject({
      from: 'personal/.graphs/proc:node-policy',
      to: 'personal/.graphs/hr:node-skill',
      crossGraph: true,
      type: 'governs',
      authority: 'advisory',
    })
    // The unreadable target and the dangling node are silently dropped.
    expect(result.edges.some((edge: { id: string }) => edge.id === 'x-secret')).toBe(false)
    expect(result.edges.some((edge: { id: string }) => edge.id === 'x-dangling')).toBe(false)
    expect(result.totals).toEqual({ graphs: 2, nodes: 4, edges: 3, crossEdges: 1 })
  })

  it('resolves the overview by reserved id, short path and display name', async () => {
    const { host } = await fixture()
    for (const graph of ['总图', '__overview__', 'personal/__overview__', OVERVIEW_GRAPH_PATH]) {
      const result = await execute(host, 'kg_get', { graph })
      expect(result.graph.id, graph).toBe(OVERVIEW_GRAPH_PATH)
    }
  })

  it('does not double-count the overview in the no-argument overview', async () => {
    const { host } = await fixture()
    const result = await execute(host, 'kg_get', {})
    expect(result.totals.graphs).toBe(2)
    expect(result.graphs).toHaveLength(2)
    expect(result.overviewGraph.name).toBe(OVERVIEW_GRAPH_NAME)
    expect(result.overviewGraph.computed).toBe(true)
  })
})

describe('kg_add cross-graph edge', () => {
  it('returns a draft, then writes links.json with an audit record', async () => {
    const { host, root, audits } = await fixture()
    const linksPath = join(root, 'personal', 'u1', '.graphs', '__overview__', 'links.json')
    const draft = await execute(host, 'kg_add', {
      graph: OVERVIEW_GRAPH_NAME,
      kind: 'edge',
      id: 'x-flow-role',
      fromGraph: 'personal/.graphs/proc',
      toGraph: 'personal/.graphs/hr',
      from: 'node-flow',
      to: 'node-role',
      type: 'handoff',
      title: '流程交接岗位',
      authority: 'canonical',
      origin: 'ai',
      reviewStatus: 'reviewed',
      tags: ['交接'],
      sourceRefs: ['doc-1'],
    })
    expect(draft.draft).toBe(true)
    expect(draft.format).toBe('overview')
    expect(draft.path).toBe(OVERVIEW_GRAPH_PATH + '/links.json')
    expect(String(draft.content)).toContain('x-flow-role')
    expect(await readFile(linksPath, 'utf8')).not.toContain('x-flow-role')

    const written = await execute(host, 'kg_add', {
      graph: '__overview__',
      kind: 'edge',
      id: 'x-flow-role',
      fromGraph: 'personal/.graphs/proc',
      toGraph: 'personal/.graphs/hr',
      from: 'node-flow',
      to: 'node-role',
      type: 'handoff',
      title: '流程交接岗位',
      authority: 'canonical',
      origin: 'ai',
      reviewStatus: 'reviewed',
      tags: ['交接'],
      sourceRefs: ['doc-1'],
      confirm: true,
    })
    expect(written.ok).toBe(true)
    expect(written.audit.written).toBe(true)
    const stored = JSON.parse(await readFile(linksPath, 'utf8')) as { links: Array<Record<string, unknown>> }
    const record = stored.links.find(link => link.id === 'x-flow-role')
    expect(record).toMatchObject({
      fromGraph: 'personal/.graphs/proc',
      from: 'node-flow',
      toGraph: 'personal/.graphs/hr',
      to: 'node-role',
      type: 'handoff',
      authority: 'canonical',
      origin: 'ai',
      reviewStatus: 'reviewed',
    })
    expect(audits.at(-1)).toMatchObject({
      action: 'create',
      tool: 'kg_add',
      graphId: OVERVIEW_GRAPH_PATH,
      topicId: 'x-flow-role',
      intent: 'new cross-graph edge',
      outcome: 'applied',
    })

    const after = await execute(host, 'kg_get', { graph: '总图' })
    const edge = after.edges.find((item: { id: string }) => item.id === 'x-flow-role')
    expect(edge.from).toBe('personal/.graphs/proc:node-flow')
    expect(edge.to).toBe('personal/.graphs/hr:node-role')
  })

  it('rejects a duplicate edge id', async () => {
    const { host } = await fixture()
    await expect(execute(host, 'kg_add', {
      graph: '总图', kind: 'edge', id: 'x-policy-skill',
      fromGraph: 'personal/.graphs/proc', toGraph: 'personal/.graphs/hr',
      from: 'node-flow', to: 'node-role', type: 'handoff', confirm: true,
    })).rejects.toMatchObject({ code: 'exists' })
  })

  it('rejects a dangling endpoint node', async () => {
    const { host } = await fixture()
    await expect(execute(host, 'kg_add', {
      graph: '总图', kind: 'edge', id: 'x-bad',
      fromGraph: 'personal/.graphs/proc', toGraph: 'personal/.graphs/hr',
      from: 'missing-node', to: 'node-role', type: 'handoff',
    })).rejects.toMatchObject({ code: 'not-found' })
  })

  it('rejects an unreadable endpoint graph', async () => {
    const { host } = await fixture({ readable: ['personal/.graphs/proc', 'personal/.graphs/hr'] })
    await expect(execute(host, 'kg_add', {
      graph: '总图', kind: 'edge', id: 'x-hidden',
      fromGraph: 'personal/.graphs/proc', toGraph: 'personal/.graphs/secret',
      from: 'node-policy', to: 'secret-node', type: 'handoff',
    })).rejects.toMatchObject({ code: 'not-found' })
  })

  it('requires write permission on the overview store', async () => {
    const { host } = await fixture({ canWrite: path => !path.includes('__overview__') })
    await expect(execute(host, 'kg_add', {
      graph: '总图', kind: 'edge', id: 'x-denied',
      fromGraph: 'personal/.graphs/proc', toGraph: 'personal/.graphs/hr',
      from: 'node-policy', to: 'node-role', type: 'handoff', confirm: true,
    })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('refuses to overwrite a corrupt links.json', async () => {
    const { host, root } = await fixture()
    const linksPath = join(root, 'personal', 'u1', '.graphs', '__overview__', 'links.json')
    await writeFile(linksPath, '{ not json', 'utf8')
    await expect(execute(host, 'kg_add', {
      graph: '总图', kind: 'edge', id: 'x-new',
      fromGraph: 'personal/.graphs/proc', toGraph: 'personal/.graphs/hr',
      from: 'node-policy', to: 'node-role', type: 'handoff', confirm: true,
    })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('unreadable') })
    expect(await readFile(linksPath, 'utf8')).toBe('{ not json')
  })

  it('refuses kind=node on the overview with an actionable error', async () => {
    const { host } = await fixture()
    await expect(execute(host, 'kg_add', {
      graph: '总图', kind: 'node', id: 'new-node', path: '制度/新制度.md', title: '新制度',
    })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('source graph') })
  })
})

describe('overview read-only surface', () => {
  it('refuses kg_set on the overview', async () => {
    const { host } = await fixture()
    await expect(execute(host, 'kg_set', {
      graph: '总图', id: 'x-policy-skill', authority: 'canonical',
    })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('read-only') })
  })

  it('moves a cross-graph link to _trash on kg_del', async () => {
    const { host, root, audits } = await fixture()
    const draft = await execute(host, 'kg_del', { graph: '总图', id: 'x-policy-skill' })
    expect(draft.draft).toBe(true)
    expect(draft.kind).toBe('edge')
    const confirmed = await execute(host, 'kg_del', { graph: '总图', id: 'x-policy-skill', confirm: true })
    expect(confirmed.movedToTrash).toBe(true)
    const linksPath = join(root, 'personal', 'u1', '.graphs', '__overview__', 'links.json')
    const stored = JSON.parse(await readFile(linksPath, 'utf8')) as { links: Array<{ id: string }> }
    expect(stored.links.some(link => link.id === 'x-policy-skill')).toBe(false)
    const trashDir = join(root, 'personal', 'u1', '.graphs', '__overview__', '_trash', 'links')
    const trash = await readdir(trashDir)
    expect(trash.some(name => name.endsWith('x-policy-skill.json'))).toBe(true)
    expect(audits.at(-1)).toMatchObject({
      action: 'delete', tool: 'kg_del', graphId: OVERVIEW_GRAPH_PATH, topicId: 'x-policy-skill',
    })
  })
})
// ---------------------------------------------------------------------------
// Three scope-level overviews
// ---------------------------------------------------------------------------

interface ScopeSpec {
  level: 'global' | 'department' | 'personal'
  viewBase: string
  actualBase: string
  groupLabel?: string
}

/**
 * A Host that scans `.graphs` under all three scope bases, the way the real
 * `knowledgeGraphScopeRoots` resolves one root per scope for a caller.
 */
function makeScopedHost(
  root: string,
  catalogueSpecs: ScopeSpec[],
  options: HostOptions = {},
  overviewSpecs: ScopeSpec[] = catalogueSpecs,
) {
  const made = makeHost(root, options)
  made.host.listGraphs = async () => {
    const graphs: KnowledgeGraphNode[] = []
    for (const spec of catalogueSpecs) {
      const directory = join(root, spec.actualBase, '.graphs')
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const id = spec.viewBase + '/.graphs/' + entry.name
        if (options.readable !== undefined && !options.readable.includes(id)) continue
        try {
          const loaded = await loadGraph(join(root, spec.actualBase), entry.name)
          graphs.push(...projectGraphJsonScope({
            key: spec.level,
            viewBase: spec.viewBase,
            actualBase: spec.actualBase,
            groupLabel: spec.groupLabel ?? '',
            graphs: [loaded],
          }))
        } catch {
          // Not a readable graph.
        }
      }
    }
    return appendOverviewGraphs(made.host, graphs, overviewSpecs)
  }
  return made
}

async function threeLevelFixture(options: HostOptions = {}) {
  const root = await tempRoot()
  // Global graph.
  await write(join(root, 'global', '.graphs', 'shared', 'graph.json'), JSON.stringify(manifest('shared', '全局制度图谱', [
    { id: 'g-policy', path: '制度/全局制度.md' },
  ], []), null, 2))
  await write(join(root, 'global', '制度', '全局制度.md'), nodeDocument({
    id: 'g-policy', type: 'policy', title: '全局制度', authority: 'canonical',
    internalizable: 'true', origin: 'human', reviewStatus: 'approved', tags: '[]', sourceRefs: '[]',
  }))
  // Department graph.
  await write(join(root, 'department', 'D1', '.graphs', 'dept', 'graph.json'), JSON.stringify(manifest('dept', '部门流程图谱', [
    { id: 'd-flow', path: '流程/部门流程.md' },
    { id: 'd-role', path: '流程/部门岗位.md' },
  ], [{ id: 'd-edge', from: 'd-flow', to: 'd-role', type: 'requires' }]), null, 2))
  await write(join(root, 'department', 'D1', '流程', '部门流程.md'), nodeDocument({
    id: 'd-flow', type: 'procedure', title: '部门流程', authority: 'advisory',
    internalizable: 'true', origin: 'human', reviewStatus: 'draft', tags: '[]', sourceRefs: '[]',
  }))
  await write(join(root, 'department', 'D1', '流程', '部门岗位.md'), nodeDocument({
    id: 'd-role', type: 'fact', title: '部门岗位', authority: 'advisory',
    internalizable: 'true', origin: 'human', reviewStatus: 'draft', tags: '[]', sourceRefs: '[]',
  }))
  // Subdepartment graph: a D1 caller must see it in the department/personal totals.
  await write(join(root, 'department', 'D1', 'D2', '.graphs', 'sub', 'graph.json'), JSON.stringify(manifest('sub', '子部门制度图谱', [
    { id: 's-rule', path: '制度/子部门规则.md' },
  ], []), null, 2))
  await write(join(root, 'department', 'D1', 'D2', '制度', '子部门规则.md'), nodeDocument({
    id: 's-rule', type: 'policy', title: '子部门规则', authority: 'canonical',
    internalizable: 'true', origin: 'human', reviewStatus: 'approved', tags: '[]', sourceRefs: '[]',
  }))
  // Personal graph.
  await write(join(root, 'personal', 'u1', '.graphs', 'proc', 'graph.json'), JSON.stringify(manifest('proc', '采购制度图谱', [
    { id: 'node-policy', path: '制度/采购制度.md' },
  ], []), null, 2))
  await write(join(root, 'personal', 'u1', '制度', '采购制度.md'), nodeDocument({
    id: 'node-policy', type: 'policy', title: '采购制度', authority: 'canonical',
    internalizable: 'true', origin: 'human', reviewStatus: 'approved', tags: '[]', sourceRefs: '[]',
  }))
  const specs: ScopeSpec[] = [
    { level: 'global', viewBase: 'global', actualBase: 'global' },
    { level: 'department', viewBase: 'department/D1', actualBase: 'department/D1', groupLabel: '数据部' },
    { level: 'personal', viewBase: 'personal', actualBase: 'personal/u1' },
  ]
  const catalogueSpecs: ScopeSpec[] = [
    ...specs,
    { level: 'department', viewBase: 'department/D1/D2', actualBase: 'department/D1/D2', groupLabel: '子部门' },
  ]
  return {
    ...makeScopedHost(root, catalogueSpecs, { departmentPathCodes: ['D1'], departmentPathNames: ['数据部'], ...options }, specs),
    specs,
  }
}

describe('three scope-level overviews', () => {
  it('publishes one 总图 per scope and aggregates only that scope', async () => {
    const { host } = await threeLevelFixture()
    const graphs = await host.listGraphs()
    const overviews = graphs.filter(graph => graph.computed === true)
    expect(overviews.map(graph => graph.id).sort()).toEqual([
      'department/D1/.graphs/__overview__',
      'global/.graphs/__overview__',
      'personal/.graphs/__overview__',
    ])
    expect(overviews.every(graph => graph.name === '总图')).toBe(true)
    expect(overviews.every(graph => graph.readOnly === true)).toBe(true)

    const global = await execute(host, 'kg_get', { graph: 'global/__overview__' })
    expect(global.graph.scope).toBe('global')
    expect(global.graphs.map((graph: { name: string }) => graph.name)).toEqual(['全局制度图谱'])
    expect(global.nodes[0].id).toBe('global/.graphs/shared:g-policy')

    const department = await execute(host, 'kg_get', { graph: 'department/__overview__' })
    expect(department.graph.scope).toBe('department')
    expect(department.graphs).toHaveLength(3)
    expect(department.graphs.map((graph: { name: string }) => graph.name)).toEqual(expect.arrayContaining([
      '全局制度图谱',
      '部门流程图谱',
      '子部门制度图谱',
    ]))

    // The shared display name defaults to the caller's personal overview, which
    // also inherits the department subtree and the global scope.
    const personal = await execute(host, 'kg_get', { graph: '总图' })
    expect(personal.graph.scope).toBe('personal')
    expect(personal.graphs).toHaveLength(4)
    expect(personal.graphs.map((graph: { name: string }) => graph.name)).toEqual(expect.arrayContaining([
      '全局制度图谱',
      '部门流程图谱',
      '子部门制度图谱',
      '采购制度图谱',
    ]))
  })

  it('marks inherited graphs/nodes as contributed and read-only', async () => {
    const { host } = await threeLevelFixture()
    const personal = await execute(host, 'kg_get', { graph: '总图' })
    const globalSummary = personal.graphs.find((graph: { name: string }) => graph.name === '全局制度图谱')
    const departmentSummary = personal.graphs.find((graph: { name: string }) => graph.name === '部门流程图谱')
    const subSummary = personal.graphs.find((graph: { name: string }) => graph.name === '子部门制度图谱')
    const ownSummary = personal.graphs.find((graph: { name: string }) => graph.name === '采购制度图谱')
    expect(globalSummary).toMatchObject({ contributed: true, readOnly: true })
    expect(departmentSummary).toMatchObject({ contributed: true, readOnly: true })
    expect(subSummary).toMatchObject({ contributed: true, readOnly: true })
    expect(ownSummary?.contributed).toBeUndefined()

    const globalNode = personal.nodes.find((node: { id: string }) => node.id === 'global/.graphs/shared:g-policy')
    const departmentNode = personal.nodes.find((node: { id: string }) => node.id === 'department/D1/.graphs/dept:d-flow')
    const ownNode = personal.nodes.find((node: { id: string }) => node.id === 'personal/.graphs/proc:node-policy')
    expect(globalNode).toMatchObject({ contributed: true, readOnly: true })
    expect(departmentNode).toMatchObject({ contributed: true, readOnly: true })
    expect(ownNode?.contributed).toBeUndefined()

    // Global 总图 must not pull in a department graph.
    const global = await execute(host, 'kg_get', { graph: 'global/__overview__' })
    expect(global.graphs.map((graph: { name: string }) => graph.name)).toEqual(['全局制度图谱'])
    expect(global.nodes.some((node: { id: string }) => node.id.includes('department/'))).toBe(false)
  })

  it('allows a personal cross-graph edge to a contributed global node', async () => {
    const { host } = await threeLevelFixture()
    const written = await execute(host, 'kg_add', {
      graph: '总图', kind: 'edge', id: 'personal-to-global',
      fromGraph: 'personal/.graphs/proc', from: 'node-policy',
      toGraph: 'global/.graphs/shared', to: 'g-policy', type: 'follows',
      confirm: true,
    })
    expect(written.ok).toBe(true)
    const personal = await execute(host, 'kg_get', { graph: '总图' })
    const edge = personal.edges.find((item: { id: string }) => item.id === 'personal-to-global')
    expect(edge).toMatchObject({
      from: 'personal/.graphs/proc:node-policy',
      to: 'global/.graphs/shared:g-policy',
      crossGraph: true,
      contributed: true,
      readOnly: true,
    })
  })

  it('refuses a cross-graph edge whose endpoint is outside the overview scope', async () => {
    const { host } = await threeLevelFixture()
    await expect(execute(host, 'kg_add', {
      graph: 'global/__overview__', kind: 'edge', id: 'cross-scope',
      fromGraph: 'global/.graphs/shared', from: 'g-policy',
      toGraph: 'personal/.graphs/proc', to: 'node-policy', type: 'governs',
    })).rejects.toMatchObject({ code: 'not-found' })
  })

  it('writes each scope cross-link to its own links.json', async () => {
    const { host, root } = await threeLevelFixture()
    const written = await execute(host, 'kg_add', {
      graph: 'department/__overview__', kind: 'edge', id: 'dept-link',
      fromGraph: 'department/D1/.graphs/dept', from: 'd-flow',
      toGraph: 'department/D1/.graphs/dept', to: 'd-role', type: 'handoff',
      confirm: true,
    })
    expect(written.ok).toBe(true)
    expect(written.scope).toBe('department')
    const storePath = join(root, 'department', 'D1', '.graphs', '__overview__', 'links.json')
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as { links: Array<{ id: string }> }
    expect(stored.links.map(link => link.id)).toEqual(['dept-link'])
    // The personal store is untouched.
    expect(await exists(join(root, 'personal', 'u1', '.graphs', '__overview__', 'links.json'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// OverviewStore lifecycle
// ---------------------------------------------------------------------------

class FakeStore implements OverviewStore {
  readonly scope: OverviewStoreScope
  closed = false
  private used: number
  private rev = 0
  private bytes: number

  constructor(scope: OverviewStoreScope, bytes = 100, now: () => number = Date.now) {
    this.scope = scope
    this.bytes = bytes
    this.used = now()
  }

  async open(): Promise<void> { this.rev += 1 }
  async query(): Promise<OverviewCrossLink[]> { return [] }
  async replace(): Promise<void> { this.rev += 1 }
  close(): void { this.closed = true }
  lastUsed(): number { return this.used }
  revision(): string { return String(this.rev) }
  estimatedBytes(): number { return this.bytes }
  issues(): readonly string[] { return [] }
}

function storeScope(level: 'global' | 'department' | 'personal', actualBase: string): OverviewStoreScope {
  return overviewStoreScope({ level, viewBase: actualBase, actualBase })
}

describe('OverviewStoreManager lifecycle', () => {
  it('opens on demand, reuses a shared store and closes personal stores per user', async () => {
    let clock = 1_000
    const opened: FakeStore[] = []
    const provider = {
      open: async (scope: OverviewStoreScope) => {
        const store = new FakeStore(scope, 100, () => clock)
        opened.push(store)
        await store.open()
        return store
      },
    }
    const manager = new OverviewStoreManager(provider, { now: () => clock })
    const globalA = await manager.acquire(storeScope('global', 'global')) as FakeStore
    const globalB = await manager.acquire(storeScope('global', 'global')) as FakeStore
    expect(globalA).toBe(globalB)
    expect(opened).toHaveLength(1)
    manager.release(globalA)
    manager.release(globalB)

    const personal = await manager.acquire(storeScope('personal', 'personal/u1')) as FakeStore
    manager.release(personal)
    expect(manager.size()).toBe(2)
    manager.closePersonal('u1')
    expect(manager.size()).toBe(1)
    expect(personal.closed).toBe(true)
    manager.closeAll()
    expect(globalA.closed).toBe(true)
    expect(manager.size()).toBe(0)
  })

  it('evicts idle stores by TTL, LRU limit and memory budget', async () => {
    let clock = 0
    const provider = {
      open: async (scope: OverviewStoreScope) => {
        const store = new FakeStore(scope, 100, () => clock)
        await store.open()
        return store
      },
    }
    // TTL: personal default is 10 min (inside the approved 5–10 min range).
    const ttlManager = new OverviewStoreManager(provider, { now: () => clock, maxStores: 10 })
    const personal = await ttlManager.acquire(storeScope('personal', 'personal/u1')) as FakeStore
    ttlManager.release(personal)
    ttlManager.sweep(clock + 9 * 60_000)
    expect(ttlManager.size()).toBe(1)
    ttlManager.sweep(clock + 11 * 60_000)
    expect(ttlManager.size()).toBe(0)
    expect(personal.closed).toBe(true)

    // LRU count.
    clock = 0
    const lruManager = new OverviewStoreManager(provider, { now: () => clock, maxStores: 2, memoryBudgetBytes: 10_000 })
    for (const level of ['global', 'department', 'personal'] as const) {
      clock += 1
      const store = await lruManager.acquire(storeScope(level, level === 'personal' ? 'personal/u1' : level))
      lruManager.release(store)
    }
    lruManager.sweep(clock)
    expect(lruManager.size()).toBe(2)

    // Memory budget: 2 × 100 bytes > 150, so the idle LRU entry is evicted.
    clock = 0
    const memoryManager = new OverviewStoreManager(provider, {
      now: () => clock,
      maxStores: 10,
      memoryBudgetBytes: 150,
    })
    for (const level of ['global', 'department'] as const) {
      clock += 1
      const store = await memoryManager.acquire(storeScope(level, level))
      memoryManager.release(store)
    }
    memoryManager.sweep(clock)
    expect(memoryManager.size()).toBe(1)
    expect(memoryManager.cachedBytes()).toBeLessThanOrEqual(150)
  })

  it('rebuilds atomically by opening the replacement before closing the old store', async () => {
    let clock = 1
    const stores: FakeStore[] = []
    const provider = {
      open: async (scope: OverviewStoreScope) => {
        const store = new FakeStore(scope, 100, () => clock)
        stores.push(store)
        await store.open()
        return store
      },
    }
    const manager = new OverviewStoreManager(provider, { now: () => clock })
    const scope = storeScope('global', 'global')
    const first = await manager.acquire(scope) as FakeStore
    manager.release(first)
    const replacement = await manager.rebuild(scope) as FakeStore
    expect(stores).toHaveLength(2)
    expect(first.closed).toBe(true)
    expect(replacement.closed).toBe(false)
    const reused = await manager.acquire(scope) as FakeStore
    expect(reused).toBe(replacement)
    manager.closeAll()
  })
})

describe('overview store directory probe', () => {
  it('passes every capability check on a writable directory', async () => {
    const root = await tempRoot()
    const target = join(root, '.overview')
    const result = await probeOverviewStoreDir(target)
    expect(result.ok).toBe(true)
    expect(result.fallback).toBe(false)
    expect(result.dir).toBe(target)
    expect(result.checks).toEqual({ open: true, write: true, fsync: true, read: true, lock: true })
  })

  it('falls back to the local directory when the requested root is unusable', async () => {
    const root = await tempRoot()
    const notADirectory = join(root, 'plain-file')
    await write(notADirectory, 'x')
    const result = await probeOverviewStoreDir(join(notADirectory, '.overview'))
    expect(result.fallback).toBe(true)
    expect(result.dir).toBe(OVERVIEW_STORE_FALLBACK_DIR)
    expect(result.requested).toBe(join(notADirectory, '.overview'))
  })

  it('materializes a read-model snapshot under the probed store root', async () => {
    const { host } = await fixture()
    const root = await tempRoot()
    const storeDir = join(root, '.overview')
    const scope = overviewStoreScope({ level: 'personal', viewBase: 'personal', actualBase: 'personal/u1' })
    const store = new JsonOverviewStore(host, scope, Date.now, storeDir)
    await store.open()
    const aggregate = buildOverviewAggregate(scope, [])
    await store.materialize(aggregate)
    const name = scope.actualPath.replace(/[^A-Za-z0-9._-]+/gu, '_') + '.json'
    const snapshot = JSON.parse(await readFile(join(storeDir, 'personal', name), 'utf8')) as {
      schemaVersion: number
      scope: { level: string }
      aggregate: { graph: { name: string } }
    }
    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.scope.level).toBe('personal')
    expect(snapshot.aggregate.graph.name).toBe('总图')
  })
})

describe('graphsForLevel inheritance', () => {
  function node(scope: 'global' | 'department' | 'personal', id: string, actualPath: string): KnowledgeGraphNode {
    return {
      id,
      name: id,
      scope,
      path: id,
      group: '',
      topics: [],
      links: [],
      counts: { topics: 0, links: 0, documents: 0 },
      actualPath,
    }
  }

  it('selects global / department-subtree / personal contributions and excludes self', () => {
    const global = node('global', 'global/.graphs/g', 'global/.graphs/g')
    const dept = node('department', 'department/D1/.graphs/d', 'department/D1/.graphs/d')
    const sub = node('department', 'department/D1/D2/.graphs/s', 'department/D1/D2/.graphs/s')
    const other = node('department', 'department/D9/.graphs/x', 'department/D9/.graphs/x')
    const mine = node('personal', 'personal/.graphs/p', 'personal/u1/.graphs/p')
    const otherUser = node('personal', 'personal/.graphs/q', 'personal/u2/.graphs/q')
    const overview = { ...node('personal', 'personal/.graphs/__overview__', 'personal/u1/.graphs/__overview__'), computed: true }
    const catalogue = [global, dept, sub, other, mine, otherUser, overview]
    const caller = { userId: 'u1', departmentPathCodes: ['D1'] }

    expect(graphsForLevel(caller, 'global', catalogue)).toEqual([global])
    expect(graphsForLevel(caller, 'department', catalogue)).toEqual([global, dept, sub])
    expect(graphsForLevel(caller, 'personal', catalogue)).toEqual([global, dept, sub, mine])
    expect(graphDepartmentCodes(dept)).toEqual(['D1'])
    expect(graphDepartmentCodes(sub)).toEqual(['D1', 'D2'])
    expect(graphDepartmentCodes(other)).toEqual(['D9'])
  })
})
