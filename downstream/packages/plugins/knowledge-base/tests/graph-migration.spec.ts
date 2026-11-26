// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyMigration,
  migrationReportHasErrors,
  planMigration,
  renderMigrationReport,
  type MigrationReport,
} from '../src/graphMigration.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures/graph-migration', import.meta.url))
const CLI = fileURLToPath(new URL('../scripts/migrate-graphs.mjs', import.meta.url))
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const NOW = '2026-11-12T13:20:00+08:00'

const roots: string[] = []

async function fixtureCopy(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kb-graph-migration-'))
  roots.push(root)
  await cp(join(FIXTURES, name), root, { recursive: true })
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

/** Every file under the fixture, relative path to content, for no-write checks. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), relPath)
        continue
      }
      files[relPath] = await readFile(join(directory, entry.name), 'utf8')
    }
  }
  await walk(root, '')
  return files
}

interface Manifest {
  schemaVersion: number
  id: string
  name: string
  scope: string
  visibility: string
  topics: Array<{ id: string; title: string; description?: string }>
  nodes: Array<{ id: string; path: string }>
  edges: Array<{ id: string; from: string; to: string; type: string; doc?: string }>
}

async function applyFixture(name: string, now = NOW): Promise<{ root: string; report: MigrationReport }> {
  const root = await fixtureCopy(name)
  const plan = await planMigration({ scopeRoot: root, dryRun: true, now })
  const report = await applyMigration({ scopeRoot: root, dryRun: false, now, report: plan })
  return { root, report }
}

function issueCodes(report: MigrationReport): string[] {
  return report.issues.map(entry => entry.code)
}

describe('graph migration planning', () => {
  it('inventories topics/documents/links and writes nothing in a dry run', async () => {
    const root = await fixtureCopy('basic')
    const before = await snapshot(root)
    const report = await planMigration({ scopeRoot: root, dryRun: true, now: NOW })

    expect(report.graphs).toEqual([
      { graphId: '采购图谱', name: '采购图谱', topics: 4, documents: 7, links: 1 },
    ])
    expect(report.matched).toBe(2)
    expect(report.independent).toBe(1)
    expect(report.conflicts).toBe(1)
    expect(report.brokenEdges).toBe(0)
    expect(report.plannedWrites).toEqual([
      '.graphs/采购图谱/graph.json',
      '.graphs/采购图谱/links/topic-policy--topic-flow.md',
    ])
    expect(report.plannedMoves).toHaveLength(5)
    expect(report.plannedMoves).toEqual(expect.arrayContaining([
      {
        from: '知识图谱/采购图谱/模板/独立文档.md',
        to: '图谱文档/采购图谱/模板/独立文档.md',
      },
      {
        from: '知识图谱/采购图谱/制度/index.md',
        to: '图谱文档/采购图谱/制度/index.md',
      },
    ]))
    expect(report.plannedDeletes).toContain('知识图谱/采购图谱/制度/采购制度.md')
    expect(report.plannedDeletes).toContain('知识图谱/采购图谱/.kg/links/topic-policy--topic-flow.md')
    // Topic cards are real bodies: they are moved, never reduced to a description.
    expect(report.plannedDeletes).not.toContain('知识图谱/采购图谱/制度/index.md')
    expect(issueCodes(report)).toContain('title-conflict')
    expect(migrationReportHasErrors(report)).toBe(false)
    expect(await snapshot(root)).toEqual(before)
    expect(await exists(join(root, '.graphs'))).toBe(false)

    const text = renderMigrationReport(report)
    expect(text).toContain('dry-run')
    expect(text).toContain('matched=2 independent=1 conflicts=1 brokenEdges=0')
    expect(text).toContain('title-conflict')
  })

  it('matches an exact-hash copy and keeps exactly one body', async () => {
    const { root, report } = await applyFixture('basic')
    expect(report.applied).toBe(true)

    expect(await exists(join(root, '知识图谱/采购图谱/制度/采购制度.md'))).toBe(false)
    expect(await exists(join(root, '制度/采购制度.md'))).toBe(true)

    const manifest = await readJson<Manifest>(join(root, '.graphs/采购图谱/graph.json'))
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.nodes).toHaveLength(7)
    const policy = manifest.nodes.find(node => node.path === '制度/采购制度.md')
    expect(policy).toBeDefined()
    expect(manifest.nodes.filter(node => node.path.endsWith('采购制度.md'))).toHaveLength(1)
  })

  it('matches a legacy document by frontmatter id even when the files differ', async () => {
    const { root } = await applyFixture('basic')
    const manifest = await readJson<Manifest>(join(root, '.graphs/采购图谱/graph.json'))
    const approval = manifest.nodes.find(node => node.id === 'node-approval')
    expect(approval).toEqual({ id: 'node-approval', path: '流程/审批流程.md' })
    expect(await exists(join(root, '知识图谱/采购图谱/流程/审批流程.md'))).toBe(false)
    expect(await exists(join(root, '流程/审批流程.md'))).toBe(true)
  })

  it('moves an independent document instead of copying it', async () => {
    const { root } = await applyFixture('basic')
    const moved = join(root, '图谱文档/采购图谱/模板/独立文档.md')
    const legacy = join(root, '知识图谱/采购图谱/模板/独立文档.md')
    expect(await exists(legacy)).toBe(false)
    expect(await exists(moved)).toBe(true)
    expect(await readFile(moved, 'utf8')).toContain('只存在于旧图谱')

    const manifest = await readJson<Manifest>(join(root, '.graphs/采购图谱/graph.json'))
    expect(manifest.nodes.map(node => node.path)).toContain('图谱文档/采购图谱/模板/独立文档.md')
  })

  it('materializes a linked topic card as a topic node so the edge survives', async () => {
    const { root, report } = await applyFixture('topic-nodes')
    expect(report.applied).toBe(true)
    expect(report.graphs).toEqual([
      { graphId: '主题图谱', name: '主题图谱', topics: 2, documents: 2, links: 1 },
    ])
    expect(report.brokenEdges).toBe(0)
    expect(report.matched).toBe(0)
    expect(report.independent).toBe(0)
    expect(report.plannedMoves).toEqual(expect.arrayContaining([
      { from: '知识图谱/主题图谱/主题甲/index.md', to: '图谱文档/主题图谱/主题甲/index.md' },
      { from: '知识图谱/主题图谱/主题乙/index.md', to: '图谱文档/主题图谱/主题乙/index.md' },
    ]))

    const manifest = await readJson<Manifest>(join(root, '.graphs/主题图谱/graph.json'))
    expect(manifest.nodes).toEqual(expect.arrayContaining([
      { id: 'topic-a', path: '图谱文档/主题图谱/主题甲/index.md' },
      { id: 'topic-b', path: '图谱文档/主题图谱/主题乙/index.md' },
    ]))
    expect(manifest.edges).toHaveLength(1)
    expect(manifest.edges[0]).toMatchObject({ from: 'topic-a', to: 'topic-b' })
    expect(await exists(join(root, '知识图谱/主题图谱'))).toBe(false)
    expect(await exists(join(root, '.archive/graphs/主题图谱'))).toBe(true)
  })

  it('defaults a generic personal scope root to private visibility', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kb-graph-scope-'))
    roots.push(parent)
    const root = join(parent, 'personal')
    await cp(join(FIXTURES, 'clean'), root, { recursive: true })

    const plan = await planMigration({ scopeRoot: root, dryRun: true, now: NOW })
    const report = await applyMigration({ scopeRoot: root, dryRun: false, now: NOW, report: plan })
    expect(report.applied).toBe(true)

    const manifest = await readJson<Manifest>(join(root, '.graphs/采购图谱/graph.json'))
    expect(manifest.scope).toBe('personal:unknown')
    expect(manifest.visibility).toBe('private')
  })

  it('leaves a same-title different-content document for manual review', async () => {
    const root = await fixtureCopy('basic')
    const plan = await planMigration({ scopeRoot: root, dryRun: true, now: NOW })
    const report = await applyMigration({ scopeRoot: root, dryRun: false, now: NOW, report: plan })

    expect(report.conflicts).toBe(1)
    const conflict = report.issues.find(entry => entry.code === 'title-conflict')
    expect(conflict?.severity).toBe('warning')
    expect(conflict?.path).toBe('知识图谱/采购图谱/供应商/供应商管理.md')

    expect(await exists(join(root, '知识图谱/采购图谱/供应商/供应商管理.md'))).toBe(true)
    expect(await exists(join(root, '采购/供应商管理.md'))).toBe(true)
    // A conflict keeps at least one file in the legacy shell, so it is not archived.
    expect(await exists(join(root, '知识图谱/采购图谱'))).toBe(true)
    expect(await exists(join(root, '.archive/graphs/采购图谱'))).toBe(false)

    const manifest = await readJson<Manifest>(join(root, '.graphs/采购图谱/graph.json'))
    expect(manifest.nodes.map(node => node.path)).not.toContain('知识图谱/采购图谱/供应商/供应商管理.md')
  })
})

describe('graph migration safety', () => {
  it('reports a broken edge and refuses to delete anything', async () => {
    const root = await fixtureCopy('broken')
    const plan = await planMigration({ scopeRoot: root, dryRun: true, now: NOW })
    expect(plan.brokenEdges).toBe(1)
    expect(migrationReportHasErrors(plan)).toBe(true)
    const broken = plan.issues.find(entry => entry.code === 'broken-edge')
    expect(broken?.severity).toBe('error')
    expect(broken?.path).toBe('知识图谱/断链图谱/.kg/links/topic-policy--missing-topic.md')

    const applied = await applyMigration({ scopeRoot: root, dryRun: false, now: NOW, report: plan })
    expect(applied.applied).toBe(false)
    // The exact duplicate and the topic card are still present: the validator
    // error blocked the deletion gate.
    expect(await exists(join(root, '知识图谱/断链图谱/制度/采购制度.md'))).toBe(true)
    expect(await exists(join(root, '知识图谱/断链图谱/制度/index.md'))).toBe(true)
    expect(await exists(join(root, '知识图谱/断链图谱/.kg/links/topic-policy--missing-topic.md'))).toBe(true)
    expect(await exists(join(root, '.graphs/断链图谱/graph.json'))).toBe(false)
  })

  it('is idempotent: a second apply changes no file', async () => {
    const { root, report } = await applyFixture('clean')
    expect(report.applied).toBe(true)
    const manifestPath = join(root, '.graphs/采购图谱/graph.json')
    const manifestBefore = await readFile(manifestPath, 'utf8')
    const before = await snapshot(root)

    const secondPlan = await planMigration({ scopeRoot: root, dryRun: true, now: NOW })
    expect(secondPlan.graphs).toEqual([])
    expect(secondPlan.plannedWrites).toEqual([])
    expect(secondPlan.plannedMoves).toEqual([])
    expect(secondPlan.plannedDeletes).toEqual([])

    const secondApply = await applyMigration({ scopeRoot: root, dryRun: false, now: NOW, report: secondPlan })
    expect(secondApply.applied).toBe(true)
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore)
    expect(await snapshot(root)).toEqual(before)
    expect(await exists(join(root, '.archive/graphs/采购图谱'))).toBe(true)
    expect(await exists(join(root, '知识图谱/采购图谱'))).toBe(false)
  })

  it('generates a manifest whose nodes, edges and link documents all resolve', async () => {
    const { root, report } = await applyFixture('clean')
    const manifest = await readJson<Manifest>(join(root, '.graphs/采购图谱/graph.json'))
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.id).toBe('采购图谱')
    expect(manifest.topics).toHaveLength(3)
    expect(manifest.nodes).toHaveLength(6)
    expect(manifest.edges).toHaveLength(1)
    expect(report.graphs[0]).toEqual({ graphId: '采购图谱', name: '采购图谱', topics: 3, documents: 6, links: 1 })

    for (const node of manifest.nodes) {
      expect(await exists(join(root, node.path)), node.path).toBe(true)
    }
    const nodeIds = new Set(manifest.nodes.map(node => node.id))
    for (const edge of manifest.edges) {
      expect(nodeIds.has(edge.from)).toBe(true)
      expect(nodeIds.has(edge.to)).toBe(true)
      const docPath = edge.doc ?? ''
      expect(docPath.startsWith('.graphs/采购图谱/links/')).toBe(true)
      const linkText = await readFile(join(root, docPath), 'utf8')
      expect(linkText).toContain(`from: ${edge.from}`)
      expect(linkText).toContain(`to: ${edge.to}`)
    }
  })

  it('treats an existing manifest as protected unless --force is set', async () => {
    const { root } = await applyFixture('clean')
    await cp(join(FIXTURES, 'clean/知识图谱'), join(root, '知识图谱'), { recursive: true })

    const withoutForce = await planMigration({ scopeRoot: root, dryRun: true, now: NOW })
    expect(issueCodes(withoutForce)).toContain('manifest-exists')
    expect(withoutForce.plannedWrites).toEqual([])
    expect(withoutForce.plannedMoves).toEqual([])
    expect(withoutForce.plannedDeletes).toEqual([])

    const withForce = await planMigration({ scopeRoot: root, dryRun: true, now: NOW, force: true })
    expect(withForce.plannedWrites).toEqual(['.graphs/采购图谱/graph.json'])
    expect(withForce.issues.some(entry => entry.code === 'manifest-exists')).toBe(false)
  })
})

describe('migrate-graphs CLI', () => {
  it('runs a plain node dry run and reports the inventory', async () => {
    const root = await fixtureCopy('clean')
    const result = spawnSync(process.execPath, [CLI, '--root', root], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('迁移报告（dry-run）')
    expect(result.stdout).toContain('采购图谱: topics=3 documents=6 links=1')
    expect(result.stdout).toContain('matched=2 independent=1 conflicts=0 brokenEdges=0')
    expect(await exists(join(root, '.graphs'))).toBe(false)
  })

  it('exits 1 on an error-level issue', async () => {
    const root = await fixtureCopy('broken')
    const result = spawnSync(process.execPath, [CLI, '--root', root], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[error] broken-edge')
    expect(result.stdout).toContain('brokenEdges=1')
  })
})
