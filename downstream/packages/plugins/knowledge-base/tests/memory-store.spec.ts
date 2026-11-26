import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MemoryStore,
  MemoryStoreError,
  MEMORY_FACT_FILE,
  MEMORY_FORGET_FILE,
  MEMORY_LOG_DIR,
  MEMORY_PITFALL_FILE,
  MEMORY_PREFERENCE_FILE,
  MEMORY_SOP_DIR,
  type ListedMemoryEntry,
} from '../src/memoryStore.ts'
import {
  MemoryValidationError,
  parseMemoryEntries,
  serializeMemoryEntry,
  type Episodic,
  type Fact,
  type Pitfall,
  type Preference,
  type Sop,
} from '../src/memoryTypes.ts'

const roots: string[] = []
const NOW = new Date('2026-11-12T10:00:00+08:00')

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kb-memory-store-'))
  roots.push(root)
  return root
}

function storeAt(root: string): MemoryStore {
  return new MemoryStore(root, { now: () => NOW })
}

async function readEntries(root: string, relPath: string): Promise<ReturnType<typeof parseMemoryEntries>> {
  return parseMemoryEntries(await readFile(join(root, ...relPath.split('/')), 'utf8'))
}

async function listTemporaryFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(join(directory, entry.name))
      else if (entry.name.includes('.tmp-')) found.push(join(directory, entry.name))
    }
  }
  await visit(root)
  return found
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('daily log', () => {
  it('round-trips all five memory types with unique ids and default private privacy', async () => {
    const root = await tempRoot()
    const store = storeAt(root)
    const shared = {
      sourceTime: '2026-11-12T09:00:00+08:00',
      sourceSession: 'session-1',
      app: 'data-query',
      scenario: '驾驶舱下钻',
    }

    const preference = await store.appendLog({
      ...shared,
      type: 'preference',
      topic: '输出风格',
      value: '先给结论，再给证据',
    })
    const pitfall = await store.appendLog({
      ...shared,
      type: 'pitfall',
      errorSignature: 'ECONNRESET',
      context: '查询大表时连接被重置',
      solution: '降低单次扫描行数并重试',
      appliesTo: ['data-query'],
    })
    const episodic = await store.appendLog({
      ...shared,
      type: 'episodic',
      summary: '用户要求下钻到门店维度',
      request: '按门店拆分销售额',
      outcome: '完成并给出异常门店',
    })
    const fact = await store.appendLog({
      ...shared,
      type: 'fact',
      factKind: 'decision',
      key: '导出格式',
      statement: '默认导出 CSV',
    })
    const sop = await store.appendLog({
      ...shared,
      type: 'sop',
      slug: '指标口径排查',
      title: '指标口径排查',
      trigger: '指标与源表不一致',
      steps: ['查口径文档', '对比源表', '记录差异'],
      tools: ['kb_search(limit=5)'],
      successCriteria: ['找到差异来源'],
    })

    expect(new Set([preference.id, pitfall.id, episodic.id, fact.id, sop.id]).size).toBe(5)
    expect(preference.date).toBe('2026-11-12')
    expect(preference.path).toBe(`${MEMORY_LOG_DIR}/2026-11-12.md`)

    const parsed = await readEntries(root, preference.path)
    expect(parsed.issues).toEqual([])
    expect(parsed.entries.map(entry => entry.type)).toEqual(['preference', 'pitfall', 'episodic', 'fact', 'sop'])
    for (const entry of parsed.entries) {
      expect(entry.privacy).toBe('private')
      expect(entry.sourceSession).toBe('session-1')
      expect(entry.app).toBe('data-query')
      expect(entry.scenario).toBe('驾驶舱下钻')
    }
    expect(parsed.entries[0]).toMatchObject({ topic: '输出风格', value: '先给结论，再给证据' } satisfies Partial<Preference>)
    expect(parsed.entries[1]).toMatchObject({
      errorSignature: 'ECONNRESET',
      solution: '降低单次扫描行数并重试',
      appliesTo: ['data-query'],
    } satisfies Partial<Pitfall>)
    expect(parsed.entries[2]).toMatchObject({
      summary: '用户要求下钻到门店维度',
      request: '按门店拆分销售额',
    } satisfies Partial<Episodic>)
    expect(parsed.entries[3]).toMatchObject({
      factKind: 'decision',
      key: '导出格式',
      statement: '默认导出 CSV',
    } satisfies Partial<Fact>)
    expect(parsed.entries[4]).toMatchObject({
      slug: '指标口径排查',
      status: 'draft',
      version: 1,
      steps: ['查口径文档', '对比源表', '记录差异'],
    } satisfies Partial<Sop>)

    expect(await listTemporaryFiles(root)).toEqual([])
  })

  it('appends multiple entries to one day and splits days by sourceTime', async () => {
    const root = await tempRoot()
    const store = storeAt(root)

    await store.appendLog({ type: 'fact', factKind: 'clarification', key: 'A', statement: '甲', sourceTime: '2026-11-12T08:00:00+08:00' })
    await store.appendLog({ type: 'fact', factKind: 'clarification', key: 'B', statement: '乙', sourceTime: '2026-11-12T18:00:00+08:00' })
    await store.appendLog({ type: 'fact', factKind: 'clarification', key: 'C', statement: '丙', sourceTime: '2026-11-13T09:00:00+08:00' })

    const dayOne = await readEntries(root, `${MEMORY_LOG_DIR}/2026-11-12.md`)
    const dayTwo = await readEntries(root, `${MEMORY_LOG_DIR}/2026-11-13.md`)
    expect(dayOne.entries).toHaveLength(2)
    expect(dayTwo.entries).toHaveLength(1)

    const index = await store.readMemoryIndex()
    expect(index.logs).toEqual([
      { date: '2026-11-12', path: `${MEMORY_LOG_DIR}/2026-11-12.md`, entries: 2 },
      { date: '2026-11-13', path: `${MEMORY_LOG_DIR}/2026-11-13.md`, entries: 1 },
    ])
  })
})

describe('preferences', () => {
  it('merges by topic, supersedes a changed value and never duplicates', async () => {
    const root = await tempRoot()
    const store = storeAt(root)

    const first = await store.upsertPreference({ type: 'preference', topic: '输出风格', value: '先给结论' })
    expect(first.created).toBe(true)
    expect(first.path).toBe(MEMORY_PREFERENCE_FILE)

    const idempotent = await store.upsertPreference({ type: 'preference', topic: '输出风格', value: '先给结论' })
    expect(idempotent.created).toBe(false)
    expect(idempotent.id).toBe(first.id)
    expect(idempotent.superseded).toBeUndefined()

    const changed = await store.upsertPreference({ type: 'preference', topic: '输出风格', value: '先给结论，再给证据' })
    expect(changed.created).toBe(false)
    expect(changed.id).not.toBe(first.id)
    expect(changed.superseded).toBe(first.id)

    const parsed = await readEntries(root, MEMORY_PREFERENCE_FILE)
    expect(parsed.issues).toEqual([])
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]).toMatchObject({
      id: changed.id,
      topic: '输出风格',
      value: '先给结论，再给证据',
      supersedes: first.id,
      privacy: 'private',
    } satisfies Partial<Preference>)

    await store.upsertPreference({ type: 'preference', topic: '日期格式', value: 'YYYY-MM-DD' })
    const two = await readEntries(root, MEMORY_PREFERENCE_FILE)
    expect(two.entries.map(entry => (entry as Preference).topic)).toEqual(['日期格式', '输出风格'])
  })

  it('keeps one entry per app+topic pair', async () => {
    const root = await tempRoot()
    const store = storeAt(root)
    await store.upsertPreference({ type: 'preference', app: 'data-query', topic: '结果条数', value: '10' })
    await store.upsertPreference({ type: 'preference', app: 'report', topic: '结果条数', value: '20' })

    const parsed = await readEntries(root, MEMORY_PREFERENCE_FILE)
    expect(parsed.entries).toHaveLength(2)
    expect(parsed.entries.map(entry => `${(entry as Preference).app}:${(entry as Preference).value}`).sort())
      .toEqual(['data-query:10', 'report:20'])
  })
})

describe('pitfalls', () => {
  it('merges by error signature and unions applicability and evidence', async () => {
    const root = await tempRoot()
    const store = storeAt(root)

    const first = await store.upsertPitfall({
      type: 'pitfall',
      errorSignature: 'ECONNRESET',
      context: '大表查询连接被重置',
      solution: '降低单次扫描行数',
      appliesTo: ['data-query'],
      evidence: ['session-1'],
      privacy: 'normal',
    })
    expect(first.created).toBe(true)

    const merged = await store.upsertPitfall({
      type: 'pitfall',
      errorSignature: ' econnreset ',
      context: '大表查询连接被重置（补充）',
      solution: '降低单次扫描行数并重试',
      appliesTo: ['ops-change'],
      evidence: ['session-2'],
      privacy: 'sensitive',
    })

    expect(merged.created).toBe(false)
    expect(merged.merged).toBe(true)
    expect(merged.id).toBe(first.id)

    const parsed = await readEntries(root, MEMORY_PITFALL_FILE)
    expect(parsed.issues).toEqual([])
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]).toMatchObject({
      id: first.id,
      errorSignature: ' econnreset ',
      solution: '降低单次扫描行数并重试',
      appliesTo: ['data-query', 'ops-change'],
      evidence: ['session-1', 'session-2'],
      // The stricter privacy label survives a merge.
      privacy: 'sensitive',
    } satisfies Partial<Pitfall>)
  })
})

describe('facts', () => {
  it('updates an identical statement, flags a conflicting one and keeps one current fact per key', async () => {
    const root = await tempRoot()
    const store = storeAt(root)

    const first = await store.upsertFact({
      type: 'fact',
      factKind: 'decision',
      key: '导出格式',
      statement: '默认导出 CSV',
      app: 'data-query',
      scope: '导出',
    })
    expect(first.created).toBe(true)

    const same = await store.upsertFact({
      type: 'fact',
      factKind: 'decision',
      key: '导出格式',
      statement: '默认导出 CSV',
      app: 'data-query',
      scope: '导出',
      tags: ['export'],
    })
    expect(same.created).toBe(false)
    expect(same.conflict).toBe(false)
    expect(same.id).toBe(first.id)

    const conflicting = await store.upsertFact({
      type: 'fact',
      factKind: 'decision',
      key: '导出格式',
      statement: '默认导出 XLSX',
      app: 'data-query',
      scope: '导出',
    })
    expect(conflicting.conflict).toBe(true)
    expect(conflicting.superseded).toBe(first.id)

    const parsed = await readEntries(root, MEMORY_FACT_FILE)
    expect(parsed.issues).toEqual([])
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]).toMatchObject({
      id: conflicting.id,
      statement: '默认导出 XLSX',
      supersedes: first.id,
    } satisfies Partial<Fact>)
  })

  it('honours an explicit supersede and groups the file by app and scope', async () => {
    const root = await tempRoot()
    const store = storeAt(root)

    const decided = await store.upsertFact({
      type: 'fact',
      factKind: 'requirement',
      key: '保留天数',
      statement: '30 天',
      app: 'data-query',
      scope: '导出',
    })
    const replaced = await store.upsertFact({
      type: 'fact',
      factKind: 'requirement',
      key: '保留天数',
      statement: '90 天',
      app: 'data-query',
      scope: '导出',
      supersedes: decided.id,
    })
    expect(replaced.conflict).toBe(false)
    expect(replaced.superseded).toBe(decided.id)

    await store.upsertFact({
      type: 'fact',
      factKind: 'clarification',
      key: '默认语言',
      statement: '中文',
      app: 'report',
    })

    const text = await readFile(join(root, MEMORY_FACT_FILE), 'utf8')
    expect(text).toContain('## data-query · 导出')
    expect(text).toContain('## report · 全局')

    const parsed = await readEntries(root, MEMORY_FACT_FILE)
    expect(parsed.entries).toHaveLength(2)
    const current = parsed.entries.find(entry => (entry as Fact).key === '保留天数') as Fact
    expect(current.statement).toBe('90 天')
    expect(current.supersedes).toBe(decided.id)
  })
})

describe('SOP lifecycle', () => {
  it('creates draft v1, increments the version on update, and deletes the file', async () => {
    const root = await tempRoot()
    const store = storeAt(root)

    const created = await store.writeSop({
      type: 'sop',
      title: '指标口径排查',
      trigger: '指标与源表不一致',
      steps: ['查口径文档', '对比源表'],
      tools: ['kb_search(limit=5)'],
      successCriteria: ['找到差异来源'],
      evidence: ['session-1'],
    })
    expect(created.path).toBe(`${MEMORY_SOP_DIR}/指标口径排查.md`)
    expect(created.sop).toMatchObject({ slug: '指标口径排查', status: 'draft', version: 1 })
    expect(await readFile(join(root, created.path), 'utf8')).toContain('# 指标口径排查')

    await expect(store.writeSop({
      type: 'sop',
      title: '指标口径排查',
      trigger: '重复',
      steps: ['重复'],
    })).rejects.toMatchObject({ code: 'sop-exists' })

    const testing = await store.updateSop('指标口径排查', {
      status: 'testing',
      steps: ['查口径文档', '对比源表', '记录差异'],
    })
    expect(testing.sop.status).toBe('testing')
    expect(testing.sop.version).toBe(2)
    expect(testing.sop.steps).toHaveLength(3)

    const promoted = await store.updateSop('指标口径排查', { status: 'promoted', promotedTo: ['skill:指标口径排查'] })
    expect(promoted.sop.status).toBe('promoted')
    expect(promoted.sop.version).toBe(3)

    await expect(store.updateSop('指标口径排查', { status: 'testing' })).rejects.toMatchObject({ code: 'sop-terminal' })

    const listed = await store.listSops()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.version).toBe(3)

    expect(await store.deleteSop('指标口径排查')).toBe(true)
    expect(await store.deleteSop('指标口径排查')).toBe(false)
    expect(await store.listSops()).toEqual([])
    await expect(store.updateSop('不存在', { status: 'testing' })).rejects.toMatchObject({ code: 'sop-not-found' })
  })

  it('rejects an illegal status jump', async () => {
    const root = await tempRoot()
    const store = storeAt(root)
    await store.writeSop({ type: 'sop', title: '连续排查', trigger: '异常', steps: ['复现'] })

    await expect(store.updateSop('连续排查', { status: 'promoted' })).rejects.toMatchObject({
      code: 'invalid-status-transition',
    })
  })
})

describe('privacy and secrets', () => {
  it('accepts the four privacy labels and defaults personal memory to private', async () => {
    const root = await tempRoot()
    const store = storeAt(root)

    for (const privacy of ['normal', 'private', 'sensitive'] as const) {
      const written = await store.appendLog({
        type: 'episodic',
        summary: `摘要 ${privacy}`,
        privacy,
        sourceTime: '2026-11-12T09:00:00+08:00',
      })
      expect(written.id).toBeTruthy()
    }
    const parsed = await readEntries(root, `${MEMORY_LOG_DIR}/2026-11-12.md`)
    expect(parsed.entries.map(entry => entry.privacy)).toEqual(['normal', 'private', 'sensitive'])
  })

  it('requires a credentialRef for secret privacy and refuses plaintext secret values', async () => {
    const root = await tempRoot()
    const store = storeAt(root)

    const missingReference = await store.appendLog({
      type: 'fact',
      factKind: 'clarification',
      key: 'API key',
      statement: '查询服务使用专用 API key',
      privacy: 'secret',
    }).catch((error: unknown) => error)
    expect(missingReference).toBeInstanceOf(MemoryValidationError)
    expect((missingReference as MemoryValidationError).issues.some(issue => issue.code === 'secret-requires-credential-ref'))
      .toBe(true)

    const accepted = await store.appendLog({
      type: 'fact',
      factKind: 'clarification',
      key: 'API key',
      statement: '查询服务使用凭据管理器中的 API key',
      privacy: 'secret',
      credentialRef: 'credential:dataops/query-api-key',
    })
    expect(accepted.id).toBeTruthy()

    const plaintext = await store.appendLog({
      type: 'fact',
      factKind: 'clarification',
      key: 'token',
      statement: '直接保存 sk-live-abcdefghijklmnop',
    }).catch((error: unknown) => error)
    expect(plaintext).toBeInstanceOf(MemoryValidationError)
    expect((plaintext as MemoryValidationError).issues.some(issue => issue.code === 'secret-value')).toBe(true)

    const connectionString = await store.appendLog({
      type: 'pitfall',
      errorSignature: 'DB',
      context: '连接串 password=hunter2hunter2 被写进日志',
      solution: '改用凭据引用',
    }).catch((error: unknown) => error)
    expect(connectionString).toBeInstanceOf(MemoryValidationError)
  })
})

describe('validation and read index', () => {
  it('rejects missing required fields and unsafe paths before writing anything', async () => {
    const root = await tempRoot()
    const store = storeAt(root)

    const missing = await store.appendLog({
      type: 'fact',
      factKind: 'decision',
      key: '',
      statement: '没有 key',
    }).catch((error: unknown) => error)
    expect(missing).toBeInstanceOf(MemoryValidationError)

    const badSlug = await store.writeSop({
      type: 'sop',
      slug: '../escape',
      title: '逃逸',
      trigger: 'x',
      steps: ['y'],
    }).catch((error: unknown) => error)
    expect(badSlug).toBeInstanceOf(MemoryValidationError)

    await expect(store.appendLog({
      type: 'episodic',
      summary: '日期非法',
    }, { date: '2026-13-40' })).rejects.toMatchObject({ code: 'invalid-log-date' })

    await expect(store.updateSop('../escape', { status: 'testing' })).rejects.toMatchObject({ code: 'unsafe-path' })
    expect(await listTemporaryFiles(root)).toEqual([])
  })

  it('reads the current index without duplicating entries', async () => {
    const root = await tempRoot()
    const store = storeAt(root)

    await store.upsertPreference({ type: 'preference', topic: '输出风格', value: '先给结论' })
    await store.upsertPitfall({ type: 'pitfall', errorSignature: 'E1', context: 'c', solution: 's' })
    await store.upsertFact({ type: 'fact', factKind: 'decision', key: 'K', statement: 'S' })
    await store.appendLog({ type: 'episodic', summary: '今天做了什么', sourceTime: '2026-11-12T09:00:00+08:00' })
    await store.writeSop({ type: 'sop', title: 'SOP A', trigger: 't', steps: ['s'] })
    await store.writeSop({ type: 'sop', title: 'SOP B', trigger: 't', steps: ['s'] })

    const index = await store.readMemoryIndex()
    expect(index.root).toBe(root)
    expect(index.preferences).toHaveLength(1)
    expect(index.pitfalls).toHaveLength(1)
    expect(index.facts).toHaveLength(1)
    expect(index.sops.map(sop => sop.slug)).toEqual(['SOP-A', 'SOP-B'])
    expect(index.logs).toHaveLength(1)
    expect(index.issues).toEqual([])
  })

  it('is idempotent for repeated identical preference writes', async () => {
    const root = await tempRoot()
    const store = storeAt(root)
    const first = await store.upsertPreference({ type: 'preference', topic: 'T', value: 'V' })
    const before = await readFile(join(root, MEMORY_PREFERENCE_FILE), 'utf8')
    const second = await store.upsertPreference({ type: 'preference', topic: 'T', value: 'V' })
    expect(second.id).toBe(first.id)
    expect(await readFile(join(root, MEMORY_PREFERENCE_FILE), 'utf8')).toBe(before)
  })
})


describe('memory CRUD and forget', () => {
  let root: string
  let store: MemoryStore
  let clock: Date

  async function seed(): Promise<{
    preference: string
    pitfall: string
    fact: string
    episodic: string
    sop: string
  }> {
    const preference = await store.upsertPreference({
      type: 'preference',
      topic: '输出风格',
      value: '先给结论，再给证据',
      sourceLabel: '驾驶舱下钻',
      sourceSeqs: [12, 18],
      origin: 'explicit',
      sourceSession: 'session-1',
      sourceTime: '2026-11-12T09:00:00+08:00',
    })
    const pitfall = await store.upsertPitfall({
      type: 'pitfall',
      errorSignature: 'ECONNRESET',
      context: '大表查询中断',
      solution: '降低扫描行数并重试',
    })
    const fact = await store.upsertFact({
      type: 'fact',
      factKind: 'decision',
      key: '指标口径',
      statement: '先查上游再下结论',
    })
    const episodic = await store.appendLog({
      type: 'episodic',
      summary: '今天完成了驾驶舱下钻',
      sourceTime: '2026-11-12T10:00:00+08:00',
    })
    const sop = await store.writeSop({
      type: 'sop',
      slug: 'sop-crud',
      title: 'SOP CRUD',
      trigger: '需要验证 CRUD 时',
      steps: ['第一步'],
    })
    return {
      preference: preference.id,
      pitfall: pitfall.id,
      fact: fact.id,
      episodic: episodic.id,
      sop: sop.sop.id,
    }
  }

  beforeEach(async () => {
    root = await tempRoot()
    clock = new Date('2026-11-12T10:00:00+08:00')
    store = new MemoryStore(root, { now: () => clock })
  })

  it('lists and gets all five types with stable paths, including source snapshots', async () => {
    const ids = await seed()
    const entries = await store.listEntries()
    expect(entries).toHaveLength(5)
    expect(new Set(entries.map(entry => entry.type))).toEqual(
      new Set(['preference', 'pitfall', 'fact', 'episodic', 'sop']),
    )

    const preference = entries.find(entry => entry.type === 'preference') as ListedMemoryEntry
    expect(preference).toMatchObject({
      id: ids.preference,
      path: MEMORY_PREFERENCE_FILE,
      sourceLabel: '驾驶舱下钻',
      sourceSeqs: [12, 18],
      origin: 'explicit',
      sourceSession: 'session-1',
    })
    expect(entries.find(entry => entry.type === 'pitfall')?.path).toBe(MEMORY_PITFALL_FILE)
    expect(entries.find(entry => entry.type === 'fact')?.path).toBe(MEMORY_FACT_FILE)
    expect(entries.find(entry => entry.type === 'episodic')?.path).toBe(`${MEMORY_LOG_DIR}/2026-11-12.md`)
    expect(entries.find(entry => entry.type === 'sop')?.path).toBe(`${MEMORY_SOP_DIR}/sop-crud.md`)

    expect(await store.getEntry(ids.fact)).toMatchObject({ id: ids.fact, type: 'fact' })
    expect(await store.getEntry('mem-missing')).toBeUndefined()
    expect(await store.getEntry('')).toBeUndefined()
  })

  it('updates every type in place, preserving id/type/createdAt and source fields', async () => {
    const ids = await seed()
    const before = await store.getEntry(ids.preference)

    clock = new Date('2026-11-12T11:00:00+08:00')
    const preference = await store.updateEntry(ids.preference, {
      value: '先结论，后证据，最后给行动项',
      privacy: 'normal',
      sourceLabel: '驾驶舱下钻（第二版）',
      sourceSeqs: [12, 18, 24],
    })
    expect(preference).toMatchObject({
      id: ids.preference,
      type: 'preference',
      createdAt: before?.createdAt,
      value: '先结论，后证据，最后给行动项',
      privacy: 'normal',
      sourceLabel: '驾驶舱下钻（第二版）',
      sourceSeqs: [12, 18, 24],
      path: MEMORY_PREFERENCE_FILE,
    })
    expect(preference.updatedAt).toBe('2026-11-12T03:00:00.000Z')
    expect((await store.getEntry(ids.preference))?.updatedAt).toBe('2026-11-12T03:00:00.000Z')

    const pitfall = await store.updateEntry(ids.pitfall, { solution: '分页重试', appliesTo: ['大表'] })
    expect(pitfall).toMatchObject({ id: ids.pitfall, solution: '分页重试', appliesTo: ['大表'], path: MEMORY_PITFALL_FILE })

    const fact = await store.updateEntry(ids.fact, { statement: '先查上游，再核对口径' })
    expect(fact).toMatchObject({ id: ids.fact, statement: '先查上游，再核对口径', path: MEMORY_FACT_FILE })

    const episodic = await store.updateEntry(ids.episodic, { summary: '驾驶舱下钻完成并复核' })
    expect(episodic).toMatchObject({ id: ids.episodic, summary: '驾驶舱下钻完成并复核', path: `${MEMORY_LOG_DIR}/2026-11-12.md` })

    const sop = await store.updateEntry(ids.sop, { title: 'SOP CRUD v2', steps: ['第一步', '第二步'] })
    expect(sop).toMatchObject({ id: ids.sop, title: 'SOP CRUD v2', steps: ['第一步', '第二步'], path: `${MEMORY_SOP_DIR}/sop-crud.md` })
    expect((sop as { version?: number }).version).toBe(1)
    expect(await readFile(join(root, MEMORY_SOP_DIR, 'sop-crud.md'), 'utf8')).toContain('# SOP CRUD v2')
  })

  it('refuses unknown patch fields, duplicate merge keys and secret without a credentialRef', async () => {
    const ids = await seed()
    await expect(store.updateEntry(ids.preference, { status: 'promoted' } as never)).rejects.toMatchObject({ code: 'invalid-patch' })
    await expect(store.updateEntry(ids.preference, { privacy: 'secret' })).rejects.toThrow(MemoryValidationError)
    await expect(store.updateEntry(ids.preference, { value: 'sk-aaaaaaaaaaaaaaaa' })).rejects.toThrow(MemoryValidationError)

    const secret = await store.updateEntry(ids.preference, {
      privacy: 'secret',
      credentialRef: 'vault://memory/preference-token',
    })
    expect(secret).toMatchObject({ privacy: 'secret', credentialRef: 'vault://memory/preference-token' })

    await store.upsertPreference({ type: 'preference', topic: '另一个主题', value: 'v' })
    await expect(store.updateEntry(ids.preference, { topic: '另一个主题' })).rejects.toMatchObject({ code: 'duplicate-key' })
  })

  it('forgets entries with a tombstone and keeps the rest of each document intact', async () => {
    const ids = await seed()
    const secondEpisodic = await store.appendLog({
      type: 'episodic',
      summary: '第二条日志',
      sourceTime: '2026-11-12T11:00:00+08:00',
    })

    expect(await store.forgetEntry(ids.preference)).toEqual({
      id: ids.preference,
      removed: true,
      tombstoned: true,
    })
    const preferenceDoc = await readEntries(root, MEMORY_PREFERENCE_FILE)
    expect(preferenceDoc.entries.find(entry => entry.id === ids.preference)).toBeUndefined()

    const tombstone = await readFile(join(root, ...MEMORY_FORGET_FILE.split('/')), 'utf8')
    expect(tombstone).toContain(ids.preference)
    expect(tombstone).toContain('type: preference')
    expect(tombstone).toContain('先给结论，再给证据')
    expect(tombstone).toContain('forgottenAt:')

    expect(await store.forgetEntry(ids.sop)).toMatchObject({ removed: true, tombstoned: true })
    await expect(readFile(join(root, MEMORY_SOP_DIR, 'sop-crud.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    expect(await store.forgetEntry(ids.episodic)).toMatchObject({ removed: true, tombstoned: true })
    const log = await readEntries(root, `${MEMORY_LOG_DIR}/2026-11-12.md`)
    expect(log.entries.map(entry => entry.id)).toEqual([secondEpisodic.id])

    expect(await store.forgetEntry('mem-missing')).toEqual({
      id: 'mem-missing',
      removed: false,
      tombstoned: false,
    })
  })

  it('refuses to edit a document that already has parse issues', async () => {
    const valid = serializeMemoryEntry({
      id: 'mem-valid',
      type: 'preference',
      privacy: 'private',
      createdAt: '2026-11-12T10:00:00+08:00',
      topic: 'T',
      value: 'V',
    })
    await writeFile(
      join(root, MEMORY_PREFERENCE_FILE),
      `# 偏好\n\n${valid}\n<!-- memory:entry -->\n---\nnot: [closed\n`,
      'utf8',
    )
    await expect(store.updateEntry('mem-valid', { value: 'V2' })).rejects.toMatchObject({ code: 'invalid-memory-file' })
    await expect(store.forgetEntry('mem-valid')).rejects.toMatchObject({ code: 'invalid-memory-file' })
  })
})

describe('error surface', () => {
  it('exposes stable error codes', async () => {
    const root = await tempRoot()
    expect(() => new MemoryStore('')).toThrowError(MemoryStoreError)
    const store = storeAt(root)
    await expect(store.updateSop('missing', {})).rejects.toMatchObject({ code: 'sop-not-found' })
  })
})
