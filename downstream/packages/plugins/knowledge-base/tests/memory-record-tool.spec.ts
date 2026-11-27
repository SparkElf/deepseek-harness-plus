import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryRecordTools, type MemoryRecordToolHost } from '../src/memoryRecordTool.ts'
import { MemoryStore } from '../src/memoryStore.ts'
import { MemoryGraphWriter } from '../src/memoryGraphWriter.ts'

const roots: string[] = []
async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kb-record-tool-'))
  roots.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function hostFor(root: string, guardian = true): MemoryRecordToolHost {
  const scopeRoot = join(root, 'personal', 'u1')
  const store = new MemoryStore(join(scopeRoot, '个人记忆图谱'))
  const writer = new MemoryGraphWriter({ scopeRoot })
  return {
    resolveCaller: async () => ({ userId: 'u1' }),
    isGuardianSession: async sessionId => guardian && sessionId === 'guardian-1',
    storeFor: async () => store,
    graphWriterFor: () => writer,
    skillsRootFor: async () => join(root, 'skills'),
  }
}

function tool(name: string, host: MemoryRecordToolHost) {
  const found = createMemoryRecordTools(host).find(definition => definition.name === name)
  if (found === undefined) throw new Error('missing tool ' + name)
  return found as unknown as { execute(args: Record<string, unknown>, exec: { agent?: { id?: string } }): Promise<Record<string, unknown>> }
}

describe('memory_record tool', () => {
  it('writes a preference and registers the graph node for the guardian session', async () => {
    const root = await tempRoot()
    const host = hostFor(root)
    const result = await tool('memory_record', host).execute({
      type: 'preference', topic: '输出风格', value: '结论先行', app: 'report', privacy: 'private',
    }, { agent: { id: 'guardian-1' } })
    expect(result.ok).toBe(true)
    const text = await readFile(join(root, 'personal', 'u1', '个人记忆图谱', '偏好.md'), 'utf8')
    expect(text).toContain('结论先行')
    const manifest = JSON.parse(await readFile(join(root, 'personal', 'u1', '.graphs', 'personal-memory', 'graph.json'), 'utf8'))
    expect(manifest.nodes.some((node: { path: string }) => node.path === '个人记忆图谱/偏好.md')).toBe(true)
  })

  it('refuses a normal session', async () => {
    const root = await tempRoot()
    await expect(tool('memory_record', hostFor(root)).execute({
      type: 'fact', factKind: 'requirement', key: 'x', statement: 'y',
    }, { agent: { id: 'ordinary' } })).rejects.toThrow(/guardian/i)
  })

  it('rejects a plaintext secret even with a privacy label', async () => {
    const root = await tempRoot()
    await expect(tool('memory_record', hostFor(root)).execute({
      type: 'fact', factKind: 'clarification', key: 'token', statement: 'api_key=sk-1234567890abcdef',
    }, { agent: { id: 'guardian-1' } })).rejects.toThrow()
  })

  it('promotes structured SOP fields even when the SOP has a short body note', async () => {
    const root = await tempRoot()
    const host = hostFor(root)
    await tool('memory_record', host).execute({
      type: 'sop', slug: 'metric-check-body', title: '指标排查', trigger: '指标异常时',
      steps: ['查上游', '查口径'], tools: ['kb_search'], successCriteria: ['找到根因'],
      body: '这是备注，不是正文。', status: 'testing',
    }, { agent: { id: 'guardian-1' } })
    await tool('memory_promote_sop', host).execute({ slug: 'metric-check-body' }, { agent: { id: 'guardian-1' } })
    const skill = await readFile(join(root, 'skills', 'metric-check-body', 'SKILL.md'), 'utf8')
    expect(skill).toContain('触发条件：指标异常时')
    expect(skill).toContain('1. 查上游')
    expect(skill).toContain('kb_search')
    expect(skill).toContain('找到根因')
    expect(skill).toContain('这是备注，不是正文。')
  })

  it('promotes a SOP to a skill and deletes the SOP', async () => {
    const root = await tempRoot()
    const host = hostFor(root)
    await tool('memory_record', host).execute({
      type: 'sop', slug: 'metric-check', title: '指标排查', trigger: '指标异常时',
      steps: ['查上游', '查口径'], status: 'testing',
    }, { agent: { id: 'guardian-1' } })
    const result = await tool('memory_promote_sop', host).execute({ slug: 'metric-check' }, { agent: { id: 'guardian-1' } })
    expect(result.skillPath).toBe(join(root, 'skills', 'metric-check', 'SKILL.md'))
    await expect(readFile(join(root, 'personal', 'u1', '个人记忆图谱', 'SOP', 'metric-check.md'), 'utf8')).rejects.toThrow()
  })
})
