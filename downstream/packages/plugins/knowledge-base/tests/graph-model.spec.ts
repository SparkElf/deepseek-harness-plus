import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GraphLoadError,
  listGraphs,
  loadGraph,
  parseNodeFrontMatter,
  validateGraph,
  type GraphManifest,
} from '../src/graphModel.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kb-graph-model-'))
  roots.push(directory)
  return directory
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

/** Build a node document with the documented front matter shape. */
function nodeDocument(fields: Record<string, string>, body = '正文'): string {
  return ['---', ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), '---', body].join('\n')
}

function graphManifest(overrides: Partial<GraphManifest> = {}): GraphManifest {
  return {
    schemaVersion: 1,
    id: 'procurement',
    name: '采购制度图谱',
    scope: 'department:data-platform',
    version: 3,
    status: 'published',
    createdAt: '2026-11-01T10:00:00+08:00',
    updatedAt: '2026-11-12T11:00:00+08:00',
    tags: ['采购', '制度'],
    visibility: 'department',
    nodes: [],
    edges: [],
    ...overrides,
  }
}

interface GraphFixture {
  nodes?: Record<string, string>
  links?: Record<string, string>
}

async function writeGraph(root: string, manifest: GraphManifest, fixture: GraphFixture = {}): Promise<void> {
  await write(join(root, '.graphs', manifest.id, 'graph.json'), JSON.stringify(manifest, null, 2))
  for (const [relPath, content] of Object.entries(fixture.nodes ?? {})) {
    await write(join(root, relPath), content)
  }
  for (const [name, content] of Object.entries(fixture.links ?? {})) {
    await write(join(root, '.graphs', manifest.id, 'links', name), content)
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('parseNodeFrontMatter', () => {
  it('reads every documented field and separates the body', () => {
    const source = nodeDocument({
      id: 'node-procurement',
      type: 'policy',
      title: '采购制度',
      authority: 'canonical',
      internalizable: 'true',
      origin: 'mixed',
      reviewStatus: 'approved',
      tags: '[采购, 制度]',
      sourceRefs: '["https://example.com/spec a", 规范]',
    }, '正文\n第二行')

    const parsed = parseNodeFrontMatter(source)

    expect(parsed.issues).toEqual([])
    expect(parsed.attributes).toEqual({
      id: 'node-procurement',
      type: 'policy',
      title: '采购制度',
      authority: 'canonical',
      internalizable: true,
      origin: 'mixed',
      reviewStatus: 'approved',
      tags: ['采购', '制度'],
      sourceRefs: ['https://example.com/spec a', '规范'],
    })
    expect(parsed.body).toBe('正文\n第二行')
  })

  it('applies the documented defaults for absent optional fields', () => {
    const parsed = parseNodeFrontMatter(nodeDocument({ id: 'n1', title: '标题' }))

    expect(parsed.issues).toEqual([])
    expect(parsed.attributes).toEqual({
      id: 'n1',
      type: 'fact',
      title: '标题',
      authority: 'advisory',
      internalizable: true,
      origin: 'human',
      reviewStatus: 'draft',
      tags: [],
      sourceRefs: [],
    })
  })

  it('handles quoted strings, inline comments and quoted array items', () => {
    const source = [
      '---',
      'id: "node-1"',
      "title: '采购: 制度 #1'",
      'tags: ["a, b", 采购] # 这是注释',
      '---',
      'body',
    ].join('\n')

    const parsed = parseNodeFrontMatter(source)

    expect(parsed.issues).toEqual([])
    expect(parsed.attributes?.title).toBe('采购: 制度 #1')
    expect(parsed.attributes?.tags).toEqual(['a, b', '采购'])
    expect(parsed.body).toBe('body')
  })

  it('returns null and an issue when required identity fields are missing', () => {
    const missingId = parseNodeFrontMatter(nodeDocument({ title: '标题' }))
    const missingTitle = parseNodeFrontMatter(nodeDocument({ id: 'n1' }))

    expect(missingId.attributes).toBeNull()
    expect(missingId.issues).toMatchObject([{ severity: 'error', code: 'invalid-frontmatter' }])
    expect(missingId.issues[0]?.message).toContain('"id"')
    expect(missingTitle.attributes).toBeNull()
    expect(missingTitle.issues[0]?.message).toContain('"title"')
  })

  it('rejects unknown enums and quoted booleans instead of downgrading them', () => {
    const badAuthority = parseNodeFrontMatter(nodeDocument({ id: 'n1', title: '标题', authority: 'super' }))
    const quotedBoolean = parseNodeFrontMatter(nodeDocument({ id: 'n1', title: '标题', internalizable: '"false"' }))

    expect(badAuthority.attributes).toBeNull()
    expect(badAuthority.issues.some(issue => issue.message.includes('authority'))).toBe(true)
    expect(quotedBoolean.attributes).toBeNull()
    expect(quotedBoolean.issues.some(issue => issue.message.includes('internalizable'))).toBe(true)
  })

  it('returns the source as body when there is no front matter block', () => {
    const parsed = parseNodeFrontMatter('# 只有正文\n')

    expect(parsed.attributes).toBeNull()
    expect(parsed.body).toBe('# 只有正文\n')
    expect(parsed.issues).toMatchObject([{ severity: 'error', code: 'invalid-frontmatter' }])
  })

  it('returns an empty body when the front matter block closes the document', () => {
    const parsed = parseNodeFrontMatter(nodeDocument({ id: 'n1', title: '标题' }, ''))

    expect(parsed.attributes).not.toBeNull()
    expect(parsed.body).toBe('')
  })
})

describe('loadGraph', () => {
  it('loads manifest, node bodies and relation documents without issues', async () => {
    const root = await tempRoot()
    const manifest = graphManifest({
      nodes: [
        { id: 'node-procurement', path: '制度/采购制度.md' },
        { id: 'node-approval', path: '流程/审批流程.md' },
      ],
      edges: [
        {
          id: 'edge-001',
          from: 'node-procurement',
          to: 'node-approval',
          type: 'depends_on',
          doc: '.graphs/procurement/links/edge-001.md',
        },
      ],
    })
    await writeGraph(root, manifest, {
      nodes: {
        '制度/采购制度.md': nodeDocument({
          id: 'node-procurement',
          type: 'policy',
          title: '采购制度',
          authority: 'canonical',
          reviewStatus: 'approved',
          tags: '[采购]',
        }),
        '流程/审批流程.md': nodeDocument({
          id: 'node-approval',
          type: 'procedure',
          title: '审批流程',
        }),
      },
      links: {
        'edge-001.md': nodeDocument({
          id: 'edge-001',
          from: 'node-procurement',
          to: 'node-approval',
          type: 'depends_on',
          authority: 'canonical',
          origin: 'ai',
          reviewStatus: 'reviewed',
        }),
      },
    })

    const graph = await loadGraph(root, 'procurement')

    expect(graph.root).toBe(resolve(root))
    expect(graph.manifest).toEqual(manifest)
    expect(graph.issues).toEqual([])
    expect(graph.nodes.map(node => node.id)).toEqual(['node-procurement', 'node-approval'])
    expect(graph.nodes[0]).toMatchObject({
      id: 'node-procurement',
      path: '制度/采购制度.md',
      type: 'policy',
      title: '采购制度',
      authority: 'canonical',
      reviewStatus: 'approved',
      tags: ['采购'],
      missing: false,
    })
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toMatchObject({
      id: 'edge-001',
      from: 'node-procurement',
      to: 'node-approval',
      type: 'depends_on',
      docPath: '.graphs/procurement/links/edge-001.md',
      authority: 'canonical',
      origin: 'ai',
      reviewStatus: 'reviewed',
      title: 'edge-001',
      missing: false,
    })
    expect(validateGraph(graph)).toEqual([])
  })

  it('reports a missing node body as an error instead of throwing', async () => {
    const root = await tempRoot()
    await writeGraph(root, graphManifest({
      nodes: [{ id: 'node-missing', path: '制度/不存在.md' }],
    }))

    const graph = await loadGraph(root, 'procurement')

    expect(graph.issues).toMatchObject([{
      severity: 'error',
      code: 'missing-node',
      ref: '制度/不存在.md',
    }])
    expect(graph.nodes[0]).toMatchObject({
      id: 'node-missing',
      path: '制度/不存在.md',
      missing: true,
      type: 'fact',
      title: '不存在',
    })
    expect(validateGraph(graph).map(issue => issue.code)).toEqual(['missing-node'])
  })

  it('reports duplicate node and edge ids and keeps the first declaration', async () => {
    const root = await tempRoot()
    await writeGraph(root, graphManifest({
      nodes: [
        { id: 'node-1', path: 'a.md' },
        { id: 'node-1', path: 'b.md' },
      ],
      edges: [
        { id: 'edge-1', from: 'node-1', to: 'node-1', type: 'relates_to' },
        { id: 'edge-1', from: 'node-1', to: 'node-1', type: 'relates_to' },
      ],
    }), {
      nodes: {
        'a.md': nodeDocument({ id: 'node-1', title: 'A' }),
        'b.md': nodeDocument({ id: 'node-1', title: 'B' }),
      },
    })

    const graph = await loadGraph(root, 'procurement')

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]?.path).toBe('a.md')
    expect(graph.edges).toHaveLength(1)
    expect(graph.issues.filter(issue => issue.code === 'duplicate-id')).toHaveLength(2)
    expect(new Set(validateGraph(graph).map(issue => issue.code))).toEqual(new Set(['duplicate-id']))
  })

  it('reports an edge endpoint that the manifest never declared', async () => {
    const root = await tempRoot()
    await writeGraph(root, graphManifest({
      nodes: [{ id: 'node-1', path: 'a.md' }],
      edges: [
        { id: 'edge-1', from: 'node-1', to: 'node-ghost', type: 'depends_on' },
      ],
    }), {
      nodes: { 'a.md': nodeDocument({ id: 'node-1', title: 'A' }) },
    })

    const graph = await loadGraph(root, 'procurement')

    expect(graph.issues).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'unknown-endpoint',
      ref: 'edge-1',
    }))
    expect(graph.issues.some(issue => issue.message.includes('node-ghost'))).toBe(true)
    expect(validateGraph(graph).some(issue => issue.code === 'unknown-endpoint')).toBe(true)
  })

  it('rejects node and edge document paths that escape the scope root', async () => {
    const root = await tempRoot()
    await write(join(root, '..', 'kb-outside-node.md'), nodeDocument({ id: 'outside', title: 'Outside' }))
    await writeGraph(root, graphManifest({
      nodes: [{ id: 'node-escape', path: '../kb-outside-node.md' }],
      edges: [
        { id: 'edge-escape', from: 'node-escape', to: 'node-escape', type: 'relates_to', doc: '../kb-outside-link.md' },
      ],
    }))

    const graph = await loadGraph(root, 'procurement')

    const escapeIssues = graph.issues.filter(issue => issue.code === 'path-escape')
    expect(escapeIssues).toHaveLength(2)
    expect(escapeIssues.every(issue => issue.severity === 'error')).toBe(true)
    expect(graph.nodes[0]?.missing).toBe(true)
    expect(graph.edges[0]?.missing).toBe(true)
    expect(validateGraph(graph).filter(issue => issue.code === 'path-escape')).toHaveLength(2)
  })

  it('reports a declared but absent relation document as a warning', async () => {
    const root = await tempRoot()
    await writeGraph(root, graphManifest({
      nodes: [{ id: 'node-1', path: 'a.md' }],
      edges: [
        { id: 'edge-1', from: 'node-1', to: 'node-1', type: 'relates_to', doc: '.graphs/procurement/links/edge-1.md' },
      ],
    }), {
      nodes: { 'a.md': nodeDocument({ id: 'node-1', title: 'A' }) },
    })

    const graph = await loadGraph(root, 'procurement')

    expect(graph.issues).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'missing-edge-doc',
      ref: '.graphs/procurement/links/edge-1.md',
    }))
    expect(graph.edges[0]).toMatchObject({ missing: true, docPath: '.graphs/procurement/links/edge-1.md' })
    // A missing optional relation body must not make the graph unpublishable.
    expect(validateGraph(graph)).toEqual([])
  })

  it('attaches a relation document at its default links/<edgeId>.md location', async () => {
    const root = await tempRoot()
    await writeGraph(root, graphManifest({
      nodes: [{ id: 'node-1', path: 'a.md' }],
      edges: [{ id: 'edge-1', from: 'node-1', to: 'node-1', type: 'relates_to' }],
    }), {
      nodes: { 'a.md': nodeDocument({ id: 'node-1', title: 'A' }) },
      links: { 'edge-1.md': nodeDocument({ id: 'edge-1', type: 'relates_to', authority: 'redline' }) },
    })

    const graph = await loadGraph(root, 'procurement')

    expect(graph.issues).toEqual([])
    expect(graph.edges[0]).toMatchObject({
      docPath: '.graphs/procurement/links/edge-1.md',
      authority: 'redline',
      missing: false,
    })
  })

  it('warns about a relation document that no edge references', async () => {
    const root = await tempRoot()
    await writeGraph(root, graphManifest({
      nodes: [{ id: 'node-1', path: 'a.md' }],
      edges: [{ id: 'edge-1', from: 'node-1', to: 'node-1', type: 'relates_to' }],
    }), {
      nodes: { 'a.md': nodeDocument({ id: 'node-1', title: 'A' }) },
      links: {
        'edge-1.md': nodeDocument({ id: 'edge-1', type: 'relates_to' }),
        'edge-orphan.md': nodeDocument({ id: 'edge-orphan', type: 'relates_to' }),
      },
    })

    const graph = await loadGraph(root, 'procurement')

    const orphans = graph.issues.filter(issue => issue.code === 'orphan-edge')
    expect(orphans).toHaveLength(1)
    expect(orphans[0]?.severity).toBe('warning')
    expect(orphans[0]?.ref).toBe('.graphs/procurement/links/edge-orphan.md')
  })

  it('keeps the manifest id and warns when a node document disagrees', async () => {
    const root = await tempRoot()
    await writeGraph(root, graphManifest({
      nodes: [{ id: 'node-manifest', path: 'a.md' }],
    }), {
      nodes: { 'a.md': nodeDocument({ id: 'node-frontmatter', title: 'A' }) },
    })

    const graph = await loadGraph(root, 'procurement')

    expect(graph.nodes[0]?.id).toBe('node-manifest')
    expect(graph.issues).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'invalid-frontmatter',
      ref: 'a.md',
    }))
  })

  it('keeps attributes when only the title is omitted from a node document', async () => {
    const root = await tempRoot()
    await writeGraph(root, graphManifest({
      nodes: [{ id: 'node-1', path: '制度/采购制度.md' }],
    }), {
      nodes: {
        '制度/采购制度.md': nodeDocument({ id: 'node-1', authority: 'redline', internalizable: 'false' }),
      },
    })

    const graph = await loadGraph(root, 'procurement')

    expect(graph.issues).toEqual([])
    expect(graph.nodes[0]).toMatchObject({
      title: '采购制度',
      authority: 'redline',
      internalizable: false,
    })
  })

  it('loads an unannotated legacy document with default attributes and a warning', async () => {
    const root = await tempRoot()
    await writeGraph(root, graphManifest({
      nodes: [{ id: 'node-legacy', path: '制度/旧制度.md' }],
    }), {
      nodes: { '制度/旧制度.md': '# 旧制度\n\n没有 front matter。\n' },
    })

    const graph = await loadGraph(root, 'procurement')

    expect(graph.issues).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'invalid-frontmatter',
      ref: '制度/旧制度.md',
    }))
    expect(graph.nodes[0]).toMatchObject({
      id: 'node-legacy',
      title: '旧制度',
      type: 'fact',
      authority: 'advisory',
      origin: 'human',
      reviewStatus: 'draft',
      missing: false,
    })
    // Migrated legacy documents may not be annotated yet; that must not make the
    // graph unpublishable, so validation ignores the warning.
    expect(validateGraph(graph)).toEqual([])
  })

  it('turns a structurally invalid manifest into issues instead of an exception', async () => {
    const root = await tempRoot()
    await write(join(root, '.graphs', 'procurement', 'graph.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'procurement',
      name: 'Broken',
      scope: 'department:data-platform',
      version: 'three',
      status: 'unknown',
      createdAt: '2026-11-01',
      updatedAt: '2026-11-12',
      tags: 'not-an-array',
      visibility: 'everyone',
      nodes: 'not-an-array',
      edges: [{ id: 'edge-1' }],
    }))

    const graph = await loadGraph(root, 'procurement')

    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
    expect(graph.manifest.id).toBe('procurement')
    const messages = graph.issues.filter(issue => issue.code === 'invalid-manifest').map(issue => issue.message)
    expect(messages.some(message => message.includes('schemaVersion'))).toBe(true)
    expect(messages.some(message => message.includes('nodes'))).toBe(true)
    expect(messages.some(message => message.includes('edges[0]'))).toBe(true)
    expect(messages.some(message => message.includes('visibility'))).toBe(true)
  })

  it('throws GraphLoadError only for a missing or non-JSON manifest', async () => {
    const root = await tempRoot()

    const missing = await loadGraph(root, 'procurement').catch((error: unknown) => error)
    expect(missing).toBeInstanceOf(GraphLoadError)
    expect(missing).toMatchObject({ name: 'GraphLoadError', code: 'manifest-missing' })

    await write(join(root, '.graphs', 'procurement', 'graph.json'), '{ not json')
    const invalidJson = await loadGraph(root, 'procurement').catch((error: unknown) => error)
    expect(invalidJson).toBeInstanceOf(GraphLoadError)
    expect(invalidJson).toMatchObject({ name: 'GraphLoadError', code: 'manifest-invalid-json' })
  })

  it('refuses a graph id that could walk out of .graphs/', async () => {
    const root = await tempRoot()
    await expect(loadGraph(root, '../elsewhere')).rejects.toMatchObject({
      code: 'invalid-graph-id',
    })
  })
})

describe('listGraphs', () => {
  it('lists readable graphs sorted by directory id and counts their issues', async () => {
    const root = await tempRoot()
    await writeGraph(root, graphManifest({ id: 'zeta', nodes: [{ id: 'n1', path: 'a.md' }] }), {
      nodes: { 'a.md': nodeDocument({ id: 'n1', title: 'A' }) },
    })
    await writeGraph(root, graphManifest({ id: 'alpha', nodes: [{ id: 'n1', path: 'missing.md' }] }))
    await mkdir(join(root, '.graphs', 'no-manifest'), { recursive: true })
    await write(join(root, '.graphs', 'broken', 'graph.json'), '{ nope')

    const graphs = await listGraphs(root)

    expect(graphs.map(graph => graph.id)).toEqual(['alpha', 'zeta'])
    expect(graphs[0]?.issueCount).toBe(1)
    expect(graphs[0]?.manifest.name).toBe('采购制度图谱')
    expect(graphs[1]?.issueCount).toBe(0)
  })

  it('returns an empty list when the scope has no .graphs directory', async () => {
    const root = await tempRoot()
    await expect(listGraphs(root)).resolves.toEqual([])
  })
})
