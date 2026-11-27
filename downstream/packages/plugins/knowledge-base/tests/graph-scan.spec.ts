import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseGraphFrontMatter,
  parseGraphList,
  readGraphLinks,
  scanKnowledgeGraphs,
  type KnowledgeGraphScopeRoot,
} from '../src/graph.ts'
import {
  emptyKnowledgeGraphTree,
  knowledgeGraphMatches,
  knowledgeGraphsOf,
  type KnowledgeGraphNode,
} from '../src/graphTypes.ts'
import { knowledgeGraphScopeRoots, permissionForKbRoute, type Config } from '../src/index.ts'
import { expectedViewPathFor, syncView, viewPathFor } from '../src/views.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kb-graph-'))
  roots.push(directory)
  return directory
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('the knowledge-graph route is read-only', () => {
  it('maps the graph route to the file-read permission', () => {
    expect(permissionForKbRoute('graph')).toBe('kb:file:read')
  })

  it('leaves the canvas page ungated by a data permission', () => {
    // The page carries no data and makes no request; the graph route above is the
    // one that must be authorized.
    expect(permissionForKbRoute('graph.canvas')).toBeUndefined()
  })
})

describe('the graph scanner', () => {
  it('reads cards, documents and .kg relations without listing .kg as a topic', async () => {
    const actualRoot = await tempRoot()
    const graph = join(actualRoot, 'global', '知识图谱', '平台建设')
    await write(join(graph, '任务总线', 'index.md'), [
      '---',
      'id: task-bus',
      'title: 任务总线',
      'status: active',
      'depth: 4',
      'domain: dsh',
      'tags: [任务, 状态机]',
      '---',
      '',
      '# 任务总线',
      '',
      '任务卡是唯一状态载体。',
      '',
      '## 现在',
      '设计稿完成。',
      '',
    ].join('\n'))
    await write(join(graph, '任务总线', 'state-machine.md'), [
      '# 任务状态机',
      '',
      '主状态与流转。',
      '',
    ].join('\n'))
    await write(join(graph, '群聊', 'index.md'), [
      '---',
      'id: group-chat',
      'title: 群聊',
      '---',
      '# 群聊',
      '',
      '人机协作入口。',
      '',
    ].join('\n'))
    await write(join(graph, '.kg', 'links', 'task-bus--group-chat.md'), [
      '---',
      'a: task-bus',
      'b: group-chat',
      'label: 来源与展示面',
      'updated: 2026-10-28',
      '---',
      '# 任务总线 ↔ 群聊',
      '',
      '群聊是任务的来源与展示面。',
      '',
    ].join('\n'))
    // A relation to a topic that does not exist must not become an invisible edge.
    await write(join(graph, '.kg', 'links', 'task-bus--missing.md'), [
      '---',
      'a: task-bus',
      'b: missing',
      '---',
      'broken',
    ].join('\n'))

    const root: KnowledgeGraphScopeRoot = {
      key: 'global',
      actualPath: 'global/知识图谱',
      viewPath: 'global/知识图谱',
      groupKey: '',
      groupLabel: '',
    }
    const canRead = vi.fn(async () => true)
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: [root],
      caller: { userId: 'u1', label: '测试用户' },
      canRead,
    })

    expect(tree.visible).toBe(1)
    expect(tree.scanned).toBe(1)
    expect(tree.scopes[0]?.groups[0]?.graphs).toHaveLength(1)
    const node = tree.scopes[0]?.groups[0]?.graphs[0]
    expect(node?.id).toBe('global/知识图谱/平台建设')
    expect(node?.counts).toEqual({ topics: 2, links: 1, documents: 1 })
    expect(node?.topics.map(topic => topic.id).sort()).toEqual(['group-chat', 'task-bus'])
    const taskBus = node?.topics.find(topic => topic.id === 'task-bus')
    expect(taskBus?.title).toBe('任务总线')
    expect(taskBus?.depth).toBe(4)
    expect(taskBus?.tags).toEqual(['任务', '状态机'])
    expect(taskBus?.summary).toBe('任务卡是唯一状态载体。')
    expect(taskBus?.body).toContain('## 现在')
    expect(taskBus?.documents).toHaveLength(1)
    expect(taskBus?.documents[0]).toMatchObject({ title: '任务状态机', file: 'state-machine.md' })
    // `index.md` is the card, not a document; `.kg` is never a topic.
    expect(taskBus?.documents.some(document => document.file === 'index.md')).toBe(false)
    expect(node?.topics.some(topic => topic.folder === '.kg')).toBe(false)
    expect(node?.links).toEqual([{
      a: 'task-bus',
      b: 'group-chat',
      label: '来源与展示面',
      updated: '2026-10-28',
      body: '群聊是任务的来源与展示面。',
      file: 'task-bus--group-chat.md',
    }])
    // One permission question per graph, never one per file or per `.kg` entry.
    expect(canRead).toHaveBeenCalledTimes(1)
    expect(canRead).toHaveBeenCalledWith('global/知识图谱/平台建设')
  })

  it('drops a denied graph before returning its name or contents', async () => {
    const actualRoot = await tempRoot()
    await write(join(actualRoot, 'global', '知识图谱', '公开图谱', '主题', 'index.md'), '# 公开\n\n可见。\n')
    await write(join(actualRoot, 'global', '知识图谱', '机密图谱', '秘密', 'index.md'), '# 秘密\n\n不可见。\n')
    const root: KnowledgeGraphScopeRoot = {
      key: 'global',
      actualPath: 'global/知识图谱',
      viewPath: 'global/知识图谱',
      groupKey: '',
      groupLabel: '',
    }
    const canRead = vi.fn(async (path: string) => !path.includes('机密'))
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: [root],
      caller: { userId: 'u1', label: '测试用户' },
      canRead,
    })

    expect(tree.scanned).toBe(2)
    expect(tree.visible).toBe(1)
    expect(tree.denied).toBe(1)
    expect(knowledgeGraphsOf(tree).map(graph => graph.name)).toEqual(['公开图谱'])
    expect(JSON.stringify(tree)).not.toContain('机密')
    expect(JSON.stringify(tree)).not.toContain('秘密')
    expect(canRead).toHaveBeenCalledTimes(2)
  })

  it('scans only the scope roots it is given, so another department never appears', async () => {
    const actualRoot = await tempRoot()
    await write(join(actualRoot, 'department', 'data-platform', '知识图谱', '本部门图谱', '主题', 'index.md'), '# 本部门\n\n。\n')
    await write(join(actualRoot, 'department', 'other', '知识图谱', '外部门图谱', '主题', 'index.md'), '# 外部门\n\n。\n')
    const rootsGiven: KnowledgeGraphScopeRoot[] = [{
      key: 'department',
      actualPath: 'department/data-platform/知识图谱',
      viewPath: 'department/知识图谱',
      groupKey: 'data-platform',
      groupLabel: '数据平台',
    }]
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: rootsGiven,
      caller: { userId: 'u1', label: '测试用户' },
      canRead: async () => true,
    })

    expect(tree.scanned).toBe(1)
    const graphs = knowledgeGraphsOf(tree)
    expect(graphs.map(graph => graph.name)).toEqual(['本部门图谱'])
    expect(JSON.stringify(tree)).not.toContain('外部门')
    expect(graphs[0]?.path).toBe('department/知识图谱/本部门图谱')
    expect(tree.scopes.find(scope => scope.key === 'department')?.groups[0]?.label).toBe('数据平台')
  })

  it('resolves a personal root through the root it was handed, never by composing a uid', async () => {
    const actualRoot = await tempRoot()
    await write(join(actualRoot, 'personal', 'uid-1', '知识图谱', '工作轨迹', '主题', 'index.md'), '# 工作轨迹\n\n。\n')
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: [{
        key: 'personal',
        actualPath: 'personal/uid-1/知识图谱',
        viewPath: 'personal/知识图谱',
        groupKey: '',
        groupLabel: '',
      }],
      caller: { userId: 'uid-1', label: '我' },
      canRead: async () => true,
    })
    const graph = knowledgeGraphsOf(tree)[0]
    expect(graph?.id).toBe('personal/知识图谱/工作轨迹')
    expect(graph?.path).not.toContain('uid-1')
    expect(tree.actualRoot).toBe(actualRoot)
  })

  it('treats a permission call that throws as a denial and keeps scanning', async () => {
    const actualRoot = await tempRoot()
    await write(join(actualRoot, 'global', '知识图谱', '甲', '主题', 'index.md'), '# 甲\n\n。\n')
    await write(join(actualRoot, 'global', '知识图谱', '乙', '主题', 'index.md'), '# 乙\n\n。\n')
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: [{
        key: 'global',
        actualPath: 'global/知识图谱',
        viewPath: 'global/知识图谱',
        groupKey: '',
        groupLabel: '',
      }],
      caller: { userId: 'u1', label: '测试用户' },
      canRead: async (path: string) => {
        if (path.endsWith('甲')) throw new Error('backend down')
        return true
      },
    })
    expect(tree.visible).toBe(1)
    expect(tree.denied).toBe(1)
    expect(knowledgeGraphsOf(tree).map(graph => graph.name)).toEqual(['乙'])
  })

  it('ignores a missing .kg directory and a graph with no topics', async () => {
    const actualRoot = await tempRoot()
    await mkdir(join(actualRoot, 'global', '知识图谱', '空图谱'), { recursive: true })
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: [{
        key: 'global',
        actualPath: 'global/知识图谱',
        viewPath: 'global/知识图谱',
        groupKey: '',
        groupLabel: '',
      }],
      caller: { userId: 'u1', label: '测试用户' },
      canRead: async () => true,
    })
    const graph = knowledgeGraphsOf(tree)[0]
    expect(graph?.topics).toEqual([])
    expect(graph?.links).toEqual([])
    expect(graph?.counts).toEqual({ topics: 0, links: 0, documents: 0 })
  })
})

describe('the graph card format', () => {
  it('splits simple front matter without needing a YAML dependency', () => {
    const parsed = parseGraphFrontMatter('---\ntitle: 标题\ntags: [a, b]\n---\n# 标题\n\n正文\n')
    expect(parsed.meta.title).toBe('标题')
    expect(parsed.meta.tags).toBe('[a, b]')
    expect(parsed.body).toContain('# 标题')
    expect(parseGraphList(parsed.meta.tags)).toEqual(['a', 'b'])
  })

  it('returns the whole document when there is no front matter', () => {
    expect(parseGraphFrontMatter('# 只有正文\n').meta).toEqual({})
    expect(parseGraphFrontMatter('# 只有正文\n').body).toBe('# 只有正文\n')
  })

  it('drops relations whose endpoints do not both exist', async () => {
    const actualRoot = await tempRoot()
    const graph = join(actualRoot, 'g')
    await write(join(graph, '.kg', 'links', 'a--b.md'), '---\na: a\nb: b\n---\n正文\n')
    await write(join(graph, '.kg', 'links', 'a--c.md'), '---\na: a\nb: c\n---\n正文\n')
    const links = await readGraphLinks(graph, new Set(['a', 'b']))
    expect(links.map(link => link.a + '--' + link.b)).toEqual(['a--b'])
  })
})

describe('the graph tree filter', () => {
  const graph: KnowledgeGraphNode = {
    id: 'global/知识图谱/平台建设',
    name: '平台建设',
    scope: 'global',
    path: 'global/知识图谱/平台建设',
    group: '',
    topics: [{
      id: 'task-bus',
      title: '任务总线',
      status: 'active',
      depth: 4,
      tags: [],
      summary: '',
      body: '',
      folder: '任务总线',
      path: 'global/知识图谱/平台建设/任务总线',
      documents: [],
    }],
    links: [],
    counts: { topics: 1, links: 0, documents: 0 },
  }

  it('matches a graph by its own name or a topic title, not by path', () => {
    expect(knowledgeGraphMatches(graph, '')).toBe(true)
    expect(knowledgeGraphMatches(graph, '平台')).toBe(true)
    expect(knowledgeGraphMatches(graph, '任务')).toBe(true)
    expect(knowledgeGraphMatches(graph, '不存在的')).toBe(false)
  })

  it('starts from an empty tree with the three scopes in display order', () => {
    const tree = emptyKnowledgeGraphTree()
    expect(tree.scopes.map(scope => scope.key)).toEqual(['global', 'department', 'personal'])
    expect(knowledgeGraphsOf(tree)).toEqual([])
  })
})

describe('nested topic documents', () => {
  it('lists documents under a personal topic sub-folder and keeps the relative path', async () => {
    const actualRoot = await tempRoot()
    const graph = join(actualRoot, 'personal', 'uid-1', '知识图谱', '工作轨迹')
    await write(join(graph, '主题', 'index.md'), '# 主题\n\n卡片。\n')
    await write(join(graph, '主题', '岗位A', '张三.md'), '# 张三\n\n张三的工作记录。\n')
    await write(join(graph, '主题', '岗位A', '李四.md'), '# 李四\n')
    // A nested index.md belongs to the 岗位 folder, not to the topic card.
    await write(join(graph, '主题', '岗位A', 'index.md'), '# 岗位A\n')
    await write(join(graph, '主题', '岗位B', '子目录', '王五.md'), '# 王五\n')
    await write(join(graph, '主题', '.hidden', 'secret.md'), '# secret\n')

    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: [{
        key: 'personal',
        actualPath: 'personal/uid-1/知识图谱',
        viewPath: 'personal/知识图谱',
        groupKey: '',
        groupLabel: '',
      }],
      caller: { userId: 'uid-1', label: '我' },
      canRead: async () => true,
    })

    const graphNode = knowledgeGraphsOf(tree)[0]
    const topic = graphNode?.topics[0]
    expect(topic?.documents).toHaveLength(4)
    expect(graphNode?.counts.documents).toBe(4)
    const byFile = new Map(topic?.documents.map(document => [document.file, document]))
    expect(byFile.get('岗位A/张三.md')).toMatchObject({
      title: '张三',
      path: 'personal/知识图谱/工作轨迹/主题/岗位A/张三.md',
      summary: '张三的工作记录。',
    })
    // Nested index.md is a document; the topic's own index.md is the card.
    expect(byFile.get('岗位A/index.md')).toMatchObject({ title: '岗位A' })
    expect(byFile.has('index.md')).toBe(false)
    // Hidden folders are skipped at every level, so `.kg`-like roots cannot leak.
    expect(topic?.documents.some(document => document.file.includes('.hidden'))).toBe(false)
  })

  it('lists documents under a department topic sub-folder', async () => {
    const actualRoot = await tempRoot()
    const graph = join(actualRoot, 'department', 'D1', 'D2', '知识图谱', '部门图谱')
    await write(join(graph, '主题', 'index.md'), '# 主题\n')
    await write(join(graph, '主题', '岗位X', '文档.md'), '# 部门文档\n\n正文。\n')

    const viewRoot = await tempRoot()
    const config = {
      baseUrl: 'http://dataops.test', credentialRef: 'c', actualRoot, mountPoint: viewRoot, viewRoot,
    } as unknown as Config
    await mkdir(join(viewRoot, 'u-1', 'department', 'D1', 'D2', '知识图谱'), { recursive: true })
    const roots = await knowledgeGraphScopeRoots({} as never, config, {
      userId: 'u-1', label: '部门用户', roleCodes: [], departmentCode: 'D2',
      departmentPathCodes: ['D1', 'D2'], departmentPathNames: ['一部', '二部'],
    })
    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots,
      caller: { userId: 'u-1', label: '部门用户' },
      canRead: async () => true,
    })

    const graphNode = knowledgeGraphsOf(tree)[0]
    expect(graphNode?.group).toBe('一部 / 二部')
    expect(graphNode?.counts.documents).toBe(1)
    expect(graphNode?.path).toBe('department/D1/D2/知识图谱/部门图谱')
    expect(graphNode?.topics[0]?.documents[0]).toMatchObject({
      title: '部门文档',
      file: '岗位X/文档.md',
      path: 'department/D1/D2/知识图谱/部门图谱/主题/岗位X/文档.md',
    })
  })

  it('keeps the flat global topic document count unchanged', async () => {
    const actualRoot = await tempRoot()
    const graph = join(actualRoot, 'global', '知识图谱', '平台建设')
    await write(join(graph, '任务总线', 'index.md'), '# 任务总线\n')
    await write(join(graph, '任务总线', 'state-machine.md'), '# 任务状态机\n')

    const tree = await scanKnowledgeGraphs({
      actualRoot,
      roots: [{
        key: 'global',
        actualPath: 'global/知识图谱',
        viewPath: 'global/知识图谱',
        groupKey: '',
        groupLabel: '',
      }],
      caller: { userId: 'u1', label: '测试用户' },
      canRead: async () => true,
    })

    expect(knowledgeGraphsOf(tree)[0]?.counts.documents).toBe(1)
  })
})

describe('graph scope roots', () => {
  it('composes nested department and personal roots from the caller, not a directory inode', async () => {
    const root = await tempRoot()
    const actualRoot = join(root, 'actual')
    const viewRoot = join(root, 'views')
    await mkdir(join(actualRoot, 'department/D1/D2/知识图谱'), { recursive: true })
    await mkdir(join(actualRoot, 'personal/u-1/知识图谱'), { recursive: true })
    await mkdir(join(viewRoot, 'u-1/department/知识图谱'), { recursive: true })
    await mkdir(join(viewRoot, 'u-1/personal/知识图谱'), { recursive: true })
    const config = {
      baseUrl: 'http://dataops.test', credentialRef: 'c', actualRoot, viewRoot, mountPoint: viewRoot,
    } as unknown as Config

    const roots = await knowledgeGraphScopeRoots({} as never, config, {
      userId: 'u-1',
      label: 'u',
      roleCodes: [],
      departmentCode: 'D2',
      departmentPathCodes: ['D1', 'D2'],
      departmentPathNames: ['一部', '二部'],
    })

    expect(roots.find(root => root.key === 'department')).toMatchObject({
      actualPath: 'department/D1/D2/知识图谱',
      viewPath: 'department/D1/D2/知识图谱',
      groupKey: 'D1/D2',
      groupLabel: '一部 / 二部',
    })
    expect(roots.find(root => root.key === 'personal')).toMatchObject({
      actualPath: 'personal/u-1/知识图谱',
      viewPath: 'personal/知识图谱',
    })
    expect(roots.find(root => root.key === 'global')?.actualPath).toBe('global/知识图谱')
  })

  it('falls back to the legacy flat department root when the backend reports only a code', async () => {
    const root = await tempRoot()
    const actualRoot = join(root, 'actual')
    const viewRoot = join(root, 'views')
    await mkdir(join(actualRoot, 'department/OPS/知识图谱'), { recursive: true })
    await mkdir(join(viewRoot, 'u-1/department/知识图谱'), { recursive: true })
    const config = {
      baseUrl: 'http://dataops.test', credentialRef: 'c', actualRoot, viewRoot, mountPoint: viewRoot,
    } as unknown as Config

    const roots = await knowledgeGraphScopeRoots({} as never, config, {
      userId: 'u-1', label: 'u', roleCodes: [], departmentCode: 'OPS',
    })

    expect(roots.find(root => root.key === 'department')).toMatchObject({
      actualPath: 'department/OPS/知识图谱',
      groupKey: 'OPS',
    })
  })
})

describe('nested documents in the view', () => {
  it('links a nested department document into the chain-mirrored view path', async () => {
    const root = await tempRoot()
    const actualRoot = join(root, 'actual')
    const viewRoot = join(root, 'views')
    const options = {
      actualRoot, viewRoot, userId: 'u-1', departmentCode: 'D2', departmentPathCodes: ['D1', 'D2'],
    }
    const relPath = 'department/D1/D2/知识图谱/部门图谱/主题/岗位X/文档.md'
    await write(join(actualRoot, relPath), '# 部门文档\n')

    await syncView(options, [{ relPath }])

    expect(expectedViewPathFor(options, relPath)).toBe(relPath)
    await expect(readFile(join(viewPathFor(options), relPath), 'utf8')).resolves.toBe('# 部门文档\n')
  })

  it('links a personal topic sub-folder document into the same nested view path', async () => {
    const root = await tempRoot()
    const actualRoot = join(root, 'actual')
    const viewRoot = join(root, 'views')
    const options = { actualRoot, viewRoot, userId: 'u-1' }
    const relPath = 'personal/u-1/知识图谱/工作轨迹/主题/岗位A/张三.md'
    await write(join(actualRoot, relPath), '# 张三\n')

    await syncView(options, [{ relPath }])

    expect(expectedViewPathFor(options, relPath)).toBe('personal/知识图谱/工作轨迹/主题/岗位A/张三.md')
    await expect(readFile(join(viewPathFor(options), 'personal/知识图谱/工作轨迹/主题/岗位A/张三.md'), 'utf8'))
      .resolves.toBe('# 张三\n')
  })
})
