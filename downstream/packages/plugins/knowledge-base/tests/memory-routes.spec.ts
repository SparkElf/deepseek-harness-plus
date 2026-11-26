import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemorySettingsStore } from '../src/memorySettings.ts'
import { MemoryStore } from '../src/memoryStore.ts'
import { handleMemoryRoute, type MemoryRouteResponse } from '../src/memoryRoutes.ts'
import { permissionForKbRoute } from '../src/index.ts'

const roots: string[] = []

interface Fixture {
  base: string
  memoryRoot: string
  usersRoot: string
  store: MemoryStore
  settings: MemorySettingsStore
  graphSync: ReturnType<typeof vi.fn>
  advance: () => void
}

async function fixture(userId = 'u1'): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'kb-memory-routes-'))
  roots.push(base)
  let clock = new Date('2026-11-13T01:00:00.000Z')
  const memoryRoot = join(base, 'personal', userId, '个人记忆图谱')
  const usersRoot = join(base, 'users')
  const store = new MemoryStore(memoryRoot, { now: () => clock })
  const graphSync = vi.fn(async () => ({ graphPath: join(base, 'graph.json'), nodeCount: 0, changed: false }))
  return {
    base,
    memoryRoot,
    usersRoot,
    store,
    settings: new MemorySettingsStore(usersRoot),
    graphSync,
    advance: () => { clock = new Date(clock.getTime() + 60_000) },
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const call = (
  f: Fixture,
  method: string,
  body: Record<string, unknown> = {},
  userId = 'u1',
  options: { defaultEnabled?: boolean } = {},
): Promise<MemoryRouteResponse> => handleMemoryRoute({
  method,
  body,
  caller: { userId, label: userId },
  store: f.store,
  settings: f.settings,
  ...(options.defaultEnabled === undefined ? {} : { defaultEnabled: options.defaultEnabled }),
  graphWriter: { syncAll: f.graphSync as never },
})

interface Seeded {
  preferenceId: string
  pitfallId: string
  factId: string
  episodicId: string
  sopId: string
}

async function seed(f: Fixture): Promise<Seeded> {
  const preference = await f.store.upsertPreference({
    type: 'preference',
    topic: '输出风格',
    value: '先给结论',
    sourceLabel: '驾驶舱下钻',
    scenario: '驾驶舱',
    sourceTime: '2026-11-13T09:00:00+08:00',
    sourceSession: 'session-secret-abc',
    sourceSeqs: [3, 7],
    origin: 'explicit',
  })
  const pitfall = await f.store.upsertPitfall({
    type: 'pitfall',
    errorSignature: '文件写入路径错误',
    context: '个人记忆被写到 global',
    solution: '按调用者解析 personal 作用域',
  })
  const fact = await f.store.upsertFact({
    type: 'fact',
    factKind: 'decision',
    key: '导出格式',
    statement: '默认导出 CSV',
  })
  const episodic = await f.store.appendLog({
    type: 'episodic',
    summary: '排查指标口径',
    sourceLabel: '指标排查',
    sourceTime: '2026-11-13T08:00:00+08:00',
    sourceSession: 'session-log-xyz',
  })
  const sop = await f.store.writeSop({
    type: 'sop',
    title: '指标口径排查',
    trigger: '指标与源表不一致',
    steps: ['查口径文档', '对比源表'],
  })
  return {
    preferenceId: preference.id,
    pitfallId: pitfall.id,
    factId: fact.id,
    episodicId: episodic.id,
    sopId: sop.sop.id,
  }
}

describe('memory.list', () => {
  it('returns the paused default plus table rows with no raw session id', async () => {
    const f = await fixture()
    const ids = await seed(f)

    const result = await call(f, 'memory.list')

    expect(result.status).toBe(200)
    expect(result.body.enabled).toBe(false)
    const entries = result.body.entries as Array<Record<string, unknown>>
    expect(entries).toHaveLength(5)
    for (const row of entries) {
      expect(Object.keys(row).sort()).toEqual([
        'id', 'path', 'privacy', 'sourceLabel', 'sourceTime', 'title', 'type', 'updatedAt',
      ])
    }
    const serialized = JSON.stringify(result.body)
    expect(serialized).not.toContain('session-secret-abc')
    expect(serialized).not.toContain('session-log-xyz')
    expect(serialized).not.toContain('sessionId')
    expect(serialized).not.toContain('sourceSession')

    const preference = entries.find(row => row.id === ids.preferenceId)
    expect(preference).toMatchObject({
      type: 'preference',
      title: '先给结论',
      sourceLabel: '驾驶舱下钻',
      sourceTime: '2026-11-13T09:00:00+08:00',
      privacy: 'private',
      path: '偏好.md',
    })
    expect(entries.find(row => row.id === ids.sopId)).toMatchObject({
      type: 'sop',
      title: '指标口径排查',
      path: 'SOP/指标口径排查.md',
      // No source snapshot was written, so the neutral label is used.
      sourceLabel: '历史会话',
    })
    expect(entries.find(row => row.id === ids.pitfallId)).toMatchObject({
      title: '文件写入路径错误',
      path: '踩坑.md',
    })
  })
})

describe('memory.get', () => {
  it('returns the full entry and normalized source fields', async () => {
    const f = await fixture()
    const ids = await seed(f)

    const result = await call(f, 'memory.get', { id: ids.preferenceId })

    expect(result.status).toBe(200)
    expect(result.body.title).toBe('先给结论')
    expect(result.body.content).toBe('先给结论')
    expect(result.body.source).toEqual({
      label: '驾驶舱下钻',
      at: '2026-11-13T09:00:00+08:00',
      eventSeqs: [3, 7],
      sessionId: 'session-secret-abc',
    })
    expect(result.body.entry).toMatchObject({
      id: ids.preferenceId,
      type: 'preference',
      topic: '输出风格',
      value: '先给结论',
      origin: 'explicit',
      path: '偏好.md',
    })
  })

  it('rejects an unknown id with 404 and an unsafe id with 400', async () => {
    const f = await fixture()
    await expect(call(f, 'memory.get', { id: 'mem-missing' })).resolves.toMatchObject({ status: 404 })
    await expect(call(f, 'memory.get', { id: '../escape' })).resolves.toMatchObject({ status: 400 })
  })
})

describe('memory.update', () => {
  it('corrects the generic content field for each type and preserves identity', async () => {
    const f = await fixture()
    const ids = await seed(f)
    const before = await f.store.getEntry(ids.preferenceId)
    f.advance()

    const preference = await call(f, 'memory.update', { id: ids.preferenceId, content: '先给结论，再给证据' })
    expect(preference.status).toBe(200)
    expect(preference.body.entry).toMatchObject({
      id: ids.preferenceId,
      type: 'preference',
      value: '先给结论，再给证据',
      createdAt: before?.createdAt,
    })
    expect((preference.body.entry as Record<string, unknown>).updatedAt).not.toBe(before?.updatedAt)

    const fact = await call(f, 'memory.update', { id: ids.factId, patch: { content: '默认导出 XLSX' } })
    expect(fact.body.entry).toMatchObject({ statement: '默认导出 XLSX' })

    const pitfall = await call(f, 'memory.update', { id: ids.pitfallId, solution: '按调用者解析 personal 作用域并测试' })
    expect(pitfall.body.entry).toMatchObject({ solution: '按调用者解析 personal 作用域并测试' })

    const episodic = await call(f, 'memory.update', { id: ids.episodicId, content: '排查指标口径并记录结论' })
    expect(episodic.body.entry).toMatchObject({ summary: '排查指标口径并记录结论' })

    const sop = await call(f, 'memory.update', {
      id: ids.sopId,
      title: '指标口径排查（修订）',
      steps: ['查口径文档', '对比源表', '记录差异'],
    })
    expect(sop.body.entry).toMatchObject({
      title: '指标口径排查（修订）',
      steps: ['查口径文档', '对比源表', '记录差异'],
      slug: '指标口径排查',
    })
    expect(f.graphSync).toHaveBeenCalled()
  })

  it('validates privacy, unknown fields and body-supplied identity', async () => {
    const f = await fixture()
    const ids = await seed(f)

    const sensitive = await call(f, 'memory.update', { id: ids.preferenceId, privacy: 'sensitive' })
    expect(sensitive.status).toBe(200)
    expect((sensitive.body.entry as Record<string, unknown>).privacy).toBe('sensitive')

    const secretWithoutRef = await call(f, 'memory.update', { id: ids.preferenceId, privacy: 'secret' })
    expect(secretWithoutRef.status).toBe(400)
    expect(secretWithoutRef.body.code).toBe('invalid-memory')

    await expect(call(f, 'memory.update', { id: ids.preferenceId, bogus: 'x' })).resolves.toMatchObject({ status: 400 })
    await expect(call(f, 'memory.update', { id: ids.preferenceId, userId: 'u2', content: 'x' }))
      .resolves.toMatchObject({ status: 400 })
    await expect(call(f, 'memory.update', {
      id: ids.preferenceId,
      patch: { id: 'mem-other', content: 'x' },
    })).resolves.toMatchObject({ status: 400 })
    await expect(call(f, 'memory.update', { id: ids.sopId, content: 'x' })).resolves.toMatchObject({ status: 400 })
    await expect(call(f, 'memory.update', { id: 'mem-missing', content: 'x' })).resolves.toMatchObject({ status: 404 })
  })
})

describe('memory.forget', () => {
  it('removes the entry, writes a tombstone result and resyncs the graph', async () => {
    const f = await fixture()
    const ids = await seed(f)
    f.graphSync.mockClear()

    const forgotten = await call(f, 'memory.forget', { id: ids.pitfallId })
    expect(forgotten.status).toBe(200)
    expect(forgotten.body).toMatchObject({ id: ids.pitfallId, removed: true, tombstoned: true })
    expect(f.graphSync).toHaveBeenCalledTimes(1)

    const list = await call(f, 'memory.list')
    expect((list.body.entries as Array<Record<string, unknown>>).some(row => row.id === ids.pitfallId)).toBe(false)

    const again = await call(f, 'memory.forget', { id: ids.pitfallId })
    expect(again.body).toMatchObject({ id: ids.pitfallId, removed: false, tombstoned: false })
    expect(f.graphSync).toHaveBeenCalledTimes(1)
  })
})

describe('memory.settings / memory.set-enabled / memory.save-settings', () => {
  const defaults = {
    enabled: false,
    consolidationIntervalMinutes: 60,
    intervalMin: 15,
    intervalMax: 1440,
    intervalDefault: 60,
  }

  it('defaults to paused with a 60-minute interval and persists the per-user switch', async () => {
    const f = await fixture()

    await expect(call(f, 'memory.settings')).resolves.toEqual({ status: 200, body: defaults })

    const enabled = await call(f, 'memory.set-enabled', { enabled: true })
    expect(enabled).toEqual({ status: 200, body: { ...defaults, enabled: true } })
    expect(await f.settings.isEnabled('u1')).toBe(true)
    await expect(call(f, 'memory.list')).resolves.toMatchObject({ body: { enabled: true } })

    const paused = await call(f, 'memory.set-enabled', { enabled: false })
    expect(paused).toEqual({ status: 200, body: { ...defaults, enabled: false } })

    await expect(call(f, 'memory.set-enabled', { enabled: 'yes' })).resolves.toMatchObject({ status: 400 })
  })

  it('saves the interval with the switch in one call and reads it back', async () => {
    const f = await fixture()

    const saved = await call(f, 'memory.save-settings', {
      enabled: true,
      consolidationIntervalMinutes: 30,
    })
    expect(saved).toEqual({
      status: 200,
      body: { ...defaults, enabled: true, consolidationIntervalMinutes: 30 },
    })
    await expect(call(f, 'memory.settings')).resolves.toEqual({
      status: 200,
      body: { ...defaults, enabled: true, consolidationIntervalMinutes: 30 },
    })
    expect(JSON.parse(await readFile(f.settings.filePath('u1'), 'utf8'))).toEqual({
      version: 2,
      memoryEnabled: true,
      consolidationIntervalMinutes: 30,
    })

    // Saving only the interval preserves the switch.
    const intervalOnly = await call(f, 'memory.save-settings', { consolidationIntervalMinutes: 90 })
    expect(intervalOnly).toMatchObject({ body: { enabled: true, consolidationIntervalMinutes: 90 } })
  })

  it('accepts both interval boundaries and rejects out-of-range or non-integer values', async () => {
    const f = await fixture()

    await expect(call(f, 'memory.save-settings', { consolidationIntervalMinutes: 15 })).resolves.toMatchObject({
      status: 200,
      body: { consolidationIntervalMinutes: 15 },
    })
    await expect(call(f, 'memory.save-settings', { consolidationIntervalMinutes: 1440 })).resolves.toMatchObject({
      status: 200,
      body: { consolidationIntervalMinutes: 1440 },
    })
    for (const value of [14, 1441, 30.5, '30', Number.NaN]) {
      const result = await call(f, 'memory.save-settings', { consolidationIntervalMinutes: value })
      expect(result.status).toBe(400)
      expect(result.body).toMatchObject({ code: 'invalid-interval', min: 15, max: 1440 })
    }
    // A rejected write leaves the previous value intact.
    await expect(call(f, 'memory.settings')).resolves.toMatchObject({
      body: { consolidationIntervalMinutes: 1440 },
    })
  })

  it('applies the administrator default on the first read but never over an explicit false', async () => {
    const f = await fixture()

    await expect(call(f, 'memory.settings', {}, 'admin', { defaultEnabled: true })).resolves.toMatchObject({
      status: 200,
      body: { enabled: true },
    })
    // The default read did not create a file.
    await expect(readFile(f.settings.filePath('admin'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const paused = await call(f, 'memory.set-enabled', { enabled: false }, 'admin', { defaultEnabled: true })
    expect(paused).toMatchObject({ status: 200, body: { enabled: false } })

    // Even after a fresh route process would apply the default again, the
    // explicit file wins.
    const fresh = new MemorySettingsStore(f.usersRoot)
    expect(await fresh.isEnabled('admin', { defaultEnabled: true })).toBe(false)
    await expect(call(f, 'memory.settings', {}, 'admin', { defaultEnabled: true })).resolves.toMatchObject({
      body: { enabled: false },
    })
  })

  it('leaves non-administrator first reads paused', async () => {
    const f = await fixture()
    await expect(call(f, 'memory.settings', {}, 'u1', { defaultEnabled: false })).resolves.toMatchObject({
      body: { enabled: false },
    })
  })

  it('rejects unknown fields, a body-supplied userId and empty writes', async () => {
    const f = await fixture()
    await expect(call(f, 'memory.save-settings', { enabled: true, userId: 'other' })).resolves.toMatchObject({
      status: 400,
    })
    await expect(call(f, 'memory.save-settings', { surprise: 1 })).resolves.toMatchObject({
      status: 400,
      body: { code: 'invalid' },
    })
    await expect(call(f, 'memory.save-settings', {})).resolves.toMatchObject({
      status: 400,
      body: { code: 'invalid' },
    })
  })

  it('keeps one user’s switch away from another user’s memory', async () => {
    const one = await fixture('u1')
    const two = await fixture('u2')
    const ids = await seed(one)

    await call(one, 'memory.set-enabled', { enabled: true })

    const listTwo = await call(two, 'memory.list')
    expect(listTwo.body).toMatchObject({ enabled: false, entries: [] })
    await expect(call(two, 'memory.get', { id: ids.preferenceId })).resolves.toMatchObject({ status: 404 })
  })
})

describe('caller safety and route permissions', () => {
  it('rejects an unsafe caller id before any store work', async () => {
    const f = await fixture()
    await expect(call(f, 'memory.list', {}, '../escape')).resolves.toMatchObject({
      status: 403,
      body: { code: 'forbidden' },
    })
  })

  it('maps each method to the memory permission', () => {
    expect(permissionForKbRoute('memory.list')).toBe('kb:file:read')
    expect(permissionForKbRoute('memory.get')).toBe('kb:file:read')
    expect(permissionForKbRoute('memory.settings')).toBe('kb:file:read')
    expect(permissionForKbRoute('memory.update')).toBe('kb:file:write')
    expect(permissionForKbRoute('memory.set-enabled')).toBe('kb:file:write')
    expect(permissionForKbRoute('memory.save-settings')).toBe('kb:file:write')
    expect(permissionForKbRoute('memory.forget')).toBe('kb:file:delete')
    // Promotion is a review action, not a personal-page write. The department
    // administrator's role holds kb:review:decide but not kb:config:manage, so the
    // narrower route gate is the review capability; the handler then checks scope.
    expect(permissionForKbRoute('memory.shared')).toBe('kb:file:read')
    expect(permissionForKbRoute('memory.promote')).toBe('kb:review:decide')
    expect(permissionForKbRoute('memory.promotions')).toBe('kb:review:decide')
    expect(permissionForKbRoute('memory.review-promotion')).toBe('kb:review:decide')
  })
})
