import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GraphManifest, LoadedGraph, LoadedGraphNode } from '../src/graphModel.ts'
import { readSharedMemoryCandidates, sharedMemoryScopeRoots } from '../src/memoryShared.ts'

const NOW = '2026-11-18T10:00:00.000Z'

function manifest(overrides: Partial<GraphManifest> = {}): GraphManifest {
  return {
    schemaVersion: 1,
    id: 'shared-memory',
    name: '部门共享记忆',
    scope: 'department:D1',
    version: 4,
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
    type: 'topic',
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

async function writeDocument(root: string, relPath: string, frontMatter: string, body: string): Promise<void> {
  const target = join(root, relPath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `---\n${frontMatter}\n---\n\n${body}\n`)
}

describe('shared memory scope roots', () => {
  it('always offers global and the caller\'s own department chain', () => {
    expect(sharedMemoryScopeRoots({ departmentPathCodes: ['root', 'dept-a'], departmentCode: 'dept-a' })).toEqual([
      { scope: 'global', relPath: 'global' },
      { scope: 'department', relPath: 'department/root/dept-a', departmentCode: 'dept-a' },
    ])
  })

  it('truncates a malformed department chain instead of escaping the knowledge root', () => {
    expect(sharedMemoryScopeRoots({ departmentPathCodes: ['root', '..', 'dept'], departmentCode: 'dept' })).toEqual([
      { scope: 'global', relPath: 'global' },
      { scope: 'department', relPath: 'department/root', departmentCode: 'root' },
    ])
    expect(sharedMemoryScopeRoots({ departmentPathCodes: ['root/evil'], departmentCode: 'dept' })).toEqual([
      { scope: 'global', relPath: 'global' },
    ])
  })

  it('falls back to the leaf code and never invents a sibling department', () => {
    expect(sharedMemoryScopeRoots({ departmentCode: 'dept-b' })).toEqual([
      { scope: 'global', relPath: 'global' },
      { scope: 'department', relPath: 'department/dept-b', departmentCode: 'dept-b' },
    ])
    expect(sharedMemoryScopeRoots({})).toEqual([{ scope: 'global', relPath: 'global' }])
  })
})

describe('shared memory candidate reading', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
    roots.length = 0
  })

  async function fixture(): Promise<{ root: string; graph: LoadedGraph }> {
    const root = await mkdtemp(join(tmpdir(), 'kb-memory-shared-read-'))
    roots.push(root)
    await writeDocument(root, '记忆共享/mp-normal.md',
      'id: mem-mp-normal\ntitle: 部门周报结论先行\ntype: topic\nauthority: advisory\norigin: human\nreviewStatus: approved',
      '部门周报先写结论，再列数据。')
    await writeDocument(root, '记忆共享/mp-private.md',
      'id: mem-mp-private\ntitle: 部门私有备忘\ntype: fact\nauthority: advisory\nreviewStatus: approved\nprivacy: private',
      '私有正文。')
    await writeDocument(root, '记忆共享/mp-draft.md',
      'id: mem-mp-draft\ntitle: 未发布的部门草稿\ntype: fact\nauthority: advisory',
      '草稿正文：不应进入上下文。')
    await writeDocument(root, '记忆共享/mp-sensitive.md',
      'id: mem-mp-sensitive\ntitle: 敏感记录\ntype: fact\nauthority: advisory\nprivacy: sensitive',
      '敏感正文：13800000000。')
    await writeDocument(root, '记忆共享/mp-secret.md',
      'id: mem-mp-secret\ntitle: 凭据记录\ntype: fact\nauthority: advisory\nprivacy: secret',
      '凭据正文：credentialRef=kb-prod。')
    await writeDocument(root, '记忆共享/mp-redline.md',
      'id: mem-mp-redline\ntitle: 部门安全红线\ntype: policy\nauthority: redline\nreviewStatus: approved',
      '红线正文：禁止外发部门数据。')

    const graph: LoadedGraph = {
      manifest: manifest(),
      root,
      nodes: [
        node('mem-mp-normal', '记忆共享/mp-normal.md', { title: '部门周报结论先行' }),
        node('mem-mp-private', '记忆共享/mp-private.md', { title: '部门私有备忘', type: 'fact' }),
        node('mem-mp-draft', '记忆共享/mp-draft.md', { title: '未发布的部门草稿', type: 'fact', reviewStatus: 'draft' }),
        node('mem-mp-sensitive', '记忆共享/mp-sensitive.md', { title: '敏感记录', type: 'fact' }),
        node('mem-mp-secret', '记忆共享/mp-secret.md', { title: '凭据记录', type: 'fact' }),
        node('mem-mp-redline', '记忆共享/mp-redline.md', { title: '部门安全红线', type: 'policy', authority: 'redline' }),
        node('mem-mp-missing', '记忆共享/mp-missing.md', { title: '缺失文档' }),
      ],
      edges: [],
      issues: [],
    }
    return { root, graph }
  }

  it('returns normal/private documents with live frontmatter and skips sensitive/secret/missing', async () => {
    const { graph } = await fixture()
    const candidates = await readSharedMemoryCandidates(graph)
    expect(candidates.map(candidate => candidate.id)).toEqual([
      'mem-mp-normal',
      'mem-mp-private',
      'mem-mp-redline',
    ])
    expect(candidates[0]).toMatchObject({
      title: '部门周报结论先行',
      authority: 'advisory',
      privacy: 'normal',
      scope: 'department:D1',
      version: 4,
      status: 'active',
    })
    expect(candidates[2]!.authority).toBe('redline')
    expect(candidates.some(candidate => candidate.body.includes('13800000000'))).toBe(false)
    expect(candidates.some(candidate => candidate.body.includes('credentialRef'))).toBe(false)
  })

  it('ignores a graph that is not the shared-memory graph or has no scope', async () => {
    const { graph } = await fixture()
    expect(await readSharedMemoryCandidates({ ...graph, manifest: manifest({ id: 'g1' }) })).toEqual([])
    expect(await readSharedMemoryCandidates({ ...graph, manifest: manifest({ scope: 'personal:u1' }) })).toEqual([])
  })

  it('refuses a document path that escapes the scope root', async () => {
    const { graph } = await fixture()
    graph.nodes.push(node('mem-mp-escape', '../outside.md', { title: '逃逸' }))
    const candidates = await readSharedMemoryCandidates(graph)
    expect(candidates.some(candidate => candidate.id === 'mem-mp-escape')).toBe(false)
  })

  it('strips the promotion audit footer so a re-promotion has identical content', async () => {
    const { root, graph } = await fixture()
    await writeDocument(root, '记忆共享/mp-footer-a.md',
      'id: mem-footer-a\ntitle: 同一条部门结论\ntype: topic\nauthority: advisory\nreviewStatus: approved',
      '同一条部门结论的正文。\n\n---\n\n由部门管理员 A 于 2026-01-01 审核晋升。')
    await writeDocument(root, '记忆共享/mp-footer-b.md',
      'id: mem-footer-b\ntitle: 同一条部门结论\ntype: topic\nauthority: advisory\nreviewStatus: approved',
      '同一条部门结论的正文。\n\n---\n\n由部门管理员 B 于 2026-02-02 审核晋升。')
    graph.nodes.push(
      node('mem-footer-a', '记忆共享/mp-footer-a.md', { title: '同一条部门结论' }),
      node('mem-footer-b', '记忆共享/mp-footer-b.md', { title: '同一条部门结论' }),
    )
    const candidates = await readSharedMemoryCandidates(graph)
    const footers = candidates.filter(candidate => candidate.id.startsWith('mem-footer-'))
    expect(footers.map(candidate => candidate.body)).toEqual([
      '同一条部门结论的正文。',
      '同一条部门结论的正文。',
    ])
  })

  it('prefers the live document title/authority over the manifest projection', async () => {
    const { root, graph } = await fixture()
    await writeDocument(root, '记忆共享/mp-normal.md',
      'id: mem-mp-normal\ntitle: 部门周报（新）\ntype: procedure\nauthority: canonical\nreviewStatus: reviewed',
      '更新后的正文。')
    const [candidate] = await readSharedMemoryCandidates(graph)
    expect(candidate).toMatchObject({
      title: '部门周报（新）',
      type: 'procedure',
      authority: 'canonical',
      reviewStatus: 'reviewed',
    })
  })
})
