/**
 * Promotion contract: who may promote, who may approve, what gets written and
 * what a shared list may reveal.
 *
 * These tests drive the real route handler with a real `MemoryStore` and a real
 * promotion queue on disk, so the audit trail and the shared graph assertions are
 * about bytes, not mocks. DataOps is replaced by the injected `canWrite` /
 * `canRead` seams, which is exactly the boundary the host owns.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/memoryStore.ts'
import {
  canReviewPromotion,
  decidePromotionScope,
  isPromotionVisibleTo,
  listPromotionRecords,
  promotionContentOf,
  promotionStorePath,
  type PromotionReviewer,
} from '../src/memoryPromotion.ts'
import {
  handleMemoryPromotionRoute,
  type MemoryPromotionMethod,
} from '../src/memoryPromotionRoutes.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface Fixture {
  base: string
  actualRoot: string
  queuePath: string
  store: MemoryStore
  preferenceId: string
  sopId: string
  clock: { now: Date }
}

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'kb-memory-promotion-'))
  roots.push(base)
  const actualRoot = join(base, 'actual')
  const personalRoot = join(actualRoot, 'personal', 'u1', '个人记忆图谱')
  const clock = { now: new Date('2026-11-18T02:00:00.000Z') }
  const store = new MemoryStore(personalRoot, { now: () => clock.now })
  const preference = await store.upsertPreference({
    type: 'preference',
    topic: '输出风格',
    value: '先给结论',
    privacy: 'normal',
    sourceLabel: '驾驶舱下钻',
  })
  const sop = await store.writeSop({
    type: 'sop',
    title: '指标口径排查',
    trigger: '指标与源表不一致',
    steps: ['查口径文档', '对比源表'],
    successCriteria: ['差异有书面结论'],
    privacy: 'normal',
  })
  return {
    base,
    actualRoot,
    queuePath: promotionStorePath(join(actualRoot, '.memory', 'users')),
    store,
    preferenceId: preference.id,
    sopId: sop.sop.id,
    clock,
  }
}

const ordinary = (overrides: Partial<PromotionReviewer> = {}): PromotionReviewer => ({
  userId: 'u-member',
  name: '普通成员',
  isGlobalAdmin: false,
  canManageConfig: false,
  departmentCode: 'dept-a',
  departmentPathCodes: ['dept-a'],
  reviewDepartments: [],
  visibleDepartmentCodes: ['dept-a'],
  ...overrides,
})

const deptAdmin = (overrides: Partial<PromotionReviewer> = {}): PromotionReviewer => ordinary({
  userId: 'u-dept-admin',
  name: '部门管理员',
  reviewDepartments: ['dept-a'],
  ...overrides,
})

const globalAdmin = (overrides: Partial<PromotionReviewer> = {}): PromotionReviewer => ordinary({
  userId: 'u-admin',
  name: '管理员',
  isGlobalAdmin: true,
  canManageConfig: true,
  departmentCode: undefined,
  departmentPathCodes: undefined,
  reviewDepartments: ['dept-a'],
  ...overrides,
})

const call = (
  f: Fixture,
  method: MemoryPromotionMethod,
  body: Record<string, unknown>,
  actor: { id: string; name: string },
  reviewer: PromotionReviewer,
  seams: { canWrite?: (relPath: string) => Promise<boolean>; canRead?: (relPath: string) => Promise<boolean> } = {},
) => handleMemoryPromotionRoute({
  method,
  body,
  actor,
  reviewer,
  store: f.store,
  queuePath: f.queuePath,
  actualRoot: f.actualRoot,
  now: () => f.clock.now,
  ...seams,
})

describe('promotion scope decisions', () => {
  it('reserves global promotion for a configuration administrator', () => {
    expect(decidePromotionScope(deptAdmin(), 'global').ok).toBe(false)
    expect(decidePromotionScope(globalAdmin(), 'global').ok).toBe(true)
  })

  it('scopes a department promotion to the caller’s own reviewable department', () => {
    expect(decidePromotionScope(deptAdmin(), 'department', 'dept-a')).toMatchObject({
      ok: true,
      departmentCode: 'dept-a',
      departmentPath: ['dept-a'],
    })
    expect(decidePromotionScope(deptAdmin(), 'department', 'dept-b').ok).toBe(false)
    expect(decidePromotionScope(ordinary(), 'department', 'dept-a').ok).toBe(false)
  })
})

describe('memory.promote', () => {
  it('refuses an ordinary member outright', async () => {
    const f = await fixture()
    const result = await call(
      f,
      'memory.promote',
      { id: f.preferenceId, targetScope: 'department', departmentCode: 'dept-a' },
      { id: 'u-member', name: '普通成员' },
      ordinary(),
    )
    expect(result.status).toBe(403)
    expect(result.body).toMatchObject({ code: 'PROMOTION_FORBIDDEN' })
    expect(await listPromotionRecords(f.queuePath)).toHaveLength(0)
  })

  it('refuses every non-normal privacy rather than downgrading it', async () => {
    const f = await fixture()
    const privateEntry = await f.store.upsertPreference({
      type: 'preference',
      topic: '个人习惯',
      value: '不要在回答里提我的名字',
      privacy: 'private',
    })
    const result = await call(
      f,
      'memory.promote',
      { id: privateEntry.id, targetScope: 'department', departmentCode: 'dept-a' },
      { id: 'u-dept-admin', name: '部门管理员' },
      deptAdmin(),
    )
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ code: 'PRIVACY_NOT_PROMOTABLE' })
  })

  it('creates a pending request with the actor, scope and target graph in its audit', async () => {
    const f = await fixture()
    const result = await call(
      f,
      'memory.promote',
      { id: f.sopId, targetScope: 'department', departmentCode: 'dept-a' },
      { id: 'u-dept-admin', name: '部门管理员' },
      deptAdmin(),
    )
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ pending: true, applied: false })
    const records = await listPromotionRecords(f.queuePath)
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record).toMatchObject({
      status: 'pending',
      requestedBy: { id: 'u-dept-admin', name: '部门管理员' },
      source: { userId: 'u-dept-admin', memoryId: f.sopId, memoryType: 'sop' },
      target: {
        scope: 'department',
        departmentCode: 'dept-a',
        graphId: 'shared-memory',
        docPath: `记忆共享/${record.id}.md`,
      },
    })
    expect(record.audit[0]).toMatchObject({
      actorId: 'u-dept-admin',
      action: 'requested',
      detail: { scope: 'department', departmentCode: 'dept-a', targetGraph: 'shared-memory', memoryId: f.sopId },
    })
    // Nothing is written to the department tree until someone approves it.
    await expect(stat(join(f.actualRoot, 'department', 'dept-a'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deduplicates an identical pending request', async () => {
    const f = await fixture()
    const push = () => call(
      f,
      'memory.promote',
      { id: f.preferenceId, targetScope: 'department', departmentCode: 'dept-a' },
      { id: 'u-dept-admin', name: '部门管理员' },
      deptAdmin(),
    )
    const first = await push()
    const second = await push()
    expect(first.body.promotion).toMatchObject({ id: (second.body.promotion as { id: string }).id })
    expect(second.body.duplicate).toBe(true)
    expect(await listPromotionRecords(f.queuePath)).toHaveLength(1)
  })

  it('applies immediately only on an explicit administrator confirmation', async () => {
    const f = await fixture()
    const result = await call(
      f,
      'memory.promote',
      { id: f.sopId, targetScope: 'global', confirm: true },
      { id: 'u-admin', name: '管理员' },
      globalAdmin(),
    )
    expect(result.status).toBe(200)
    expect(result.body.applied).toBe(true)
    const records = await listPromotionRecords(f.queuePath)
    expect(records[0]).toMatchObject({ status: 'approved', confirmed: true })
    expect(records[0]!.audit.at(-1)).toMatchObject({
      actorId: 'u-admin',
      action: 'confirmed',
      detail: { scope: 'global', appliedPath: `global/记忆共享/${records[0]!.id}.md` },
    })

    const doc = await readFile(join(f.actualRoot, 'global', '记忆共享', `${records[0]!.id}.md`), 'utf8')
    expect(doc).toContain('title: "指标口径排查"')
    expect(doc).toContain('type: procedure')
    expect(doc).toContain('reviewStatus: approved')
    expect(doc).toContain('触发条件：指标与源表不一致')

    const graph = JSON.parse(await readFile(
      join(f.actualRoot, 'global', '.graphs', 'shared-memory', 'graph.json'),
      'utf8',
    )) as { scope: string; visibility: string; nodes: Array<{ id: string; path: string }> }
    expect(graph).toMatchObject({ scope: 'global', visibility: 'global' })
    expect(graph.nodes).toContainEqual({ id: `mem-${records[0]!.id}`, path: `记忆共享/${records[0]!.id}.md` })
  })

  it('keeps the request pending when DataOps denies the target write', async () => {
    const f = await fixture()
    const asked: string[] = []
    const result = await call(
      f,
      'memory.promote',
      { id: f.sopId, targetScope: 'global', confirm: true },
      { id: 'u-admin', name: '管理员' },
      globalAdmin(),
      { canWrite: async (relPath) => { asked.push(relPath); return false } },
    )
    expect(result.status).toBe(403)
    expect((await listPromotionRecords(f.queuePath))[0]!.status).toBe('pending')
    // DataOps grants are keyed by the exact resource id: the folder without a
    // trailing slash is the id a folder grant is stored under.
    expect(asked).toEqual(['global'])
  })
})

describe('memory.review-promotion', () => {
  async function pending(f: Fixture, reviewer = deptAdmin()): Promise<string> {
    const created = await call(
      f,
      'memory.promote',
      { id: f.preferenceId, targetScope: 'department', departmentCode: 'dept-a' },
      { id: 'u-dept-admin', name: '部门管理员' },
      reviewer,
    )
    return (created.body.promotion as { id: string }).id
  }

  it('refuses self-approval even for the submitting department administrator', async () => {
    const f = await fixture()
    const id = await pending(f)
    const result = await call(
      f,
      'memory.review-promotion',
      { id, decision: 'approve' },
      { id: 'u-dept-admin', name: '部门管理员' },
      deptAdmin(),
    )
    expect(result.status).toBe(403)
    expect(result.body).toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' })
    expect((await listPromotionRecords(f.queuePath))[0]!.status).toBe('pending')
  })

  it('lets a different administrator in the same department approve and audit it', async () => {
    const f = await fixture()
    const id = await pending(f)
    const result = await call(
      f,
      'memory.review-promotion',
      { id, decision: 'approve', note: '可复用' },
      { id: 'u-admin', name: '管理员' },
      globalAdmin({ reviewDepartments: ['dept-a'] }),
    )
    expect(result.status).toBe(200)
    expect(result.body.applied).toBe(true)
    const record = (await listPromotionRecords(f.queuePath))[0]!
    expect(record).toMatchObject({
      status: 'approved',
      reviewedBy: { id: 'u-admin', name: '管理员' },
      reviewNote: '可复用',
      confirmed: false,
    })
    expect(record.audit.at(-1)).toMatchObject({
      actorId: 'u-admin',
      action: 'approved',
      detail: { appliedPath: `department/dept-a/记忆共享/${id}.md` },
    })
    const doc = await readFile(join(f.actualRoot, 'department', 'dept-a', '记忆共享', `${id}.md`), 'utf8')
    expect(doc).toContain('先给结论')
  })

  it('keeps both nodes when two approvals land at the same time', async () => {
    const f = await fixture()
    const created = await Promise.all([
      call(
        f,
        'memory.promote',
        { id: f.preferenceId, targetScope: 'department', departmentCode: 'dept-a' },
        { id: 'u-dept-admin', name: '部门管理员' },
        deptAdmin(),
      ),
      call(
        f,
        'memory.promote',
        { id: f.sopId, targetScope: 'department', departmentCode: 'dept-a' },
        { id: 'u-dept-admin', name: '部门管理员' },
        deptAdmin(),
      ),
    ])
    const ids = created.map(item => (item.body.promotion as { id: string }).id)
    const approved = await Promise.all(ids.map(id => call(
      f,
      'memory.review-promotion',
      { id, decision: 'approve' },
      { id: 'u-admin', name: '管理员' },
      globalAdmin(),
    )))
    expect(approved.map(item => item.status)).toEqual([200, 200])
    const graph = JSON.parse(await readFile(
      join(f.actualRoot, 'department', 'dept-a', '.graphs', 'shared-memory', 'graph.json'),
      'utf8',
    )) as { nodes: Array<{ id: string; path: string }> }
    expect(graph.nodes).toHaveLength(2)
    expect(graph.nodes.map(node => node.path).sort()).toEqual(
      ids.map(id => `记忆共享/${id}.md`).sort(),
    )
  })

  it('refuses a reviewer outside the target department', async () => {
    const f = await fixture()
    const id = await pending(f)
    const result = await call(
      f,
      'memory.review-promotion',
      { id, decision: 'approve' },
      { id: 'u-dept-b-admin', name: 'B 部门管理员' },
      deptAdmin({ userId: 'u-dept-b-admin', departmentCode: 'dept-b', reviewDepartments: ['dept-b'] }),
    )
    expect(result.status).toBe(403)
    expect(result.body).toMatchObject({ code: 'PROMOTION_FORBIDDEN' })
  })

  it('records a rejection with its reviewer and note', async () => {
    const f = await fixture()
    const id = await pending(f)
    const result = await call(
      f,
      'memory.review-promotion',
      { id, decision: 'reject', note: '只适用于个人场景' },
      { id: 'u-admin', name: '管理员' },
      globalAdmin(),
    )
    expect(result.status).toBe(200)
    const record = (await listPromotionRecords(f.queuePath))[0]!
    expect(record).toMatchObject({ status: 'rejected', reviewNote: '只适用于个人场景' })
    expect(record.audit.at(-1)).toMatchObject({ action: 'rejected' })
  })
})

describe('memory.shared', () => {
  async function approvedGlobal(f: Fixture): Promise<void> {
    await call(
      f,
      'memory.promote',
      { id: f.sopId, targetScope: 'global', confirm: true },
      { id: 'u-admin', name: '管理员' },
      globalAdmin(),
    )
  }

  async function approvedDept(f: Fixture, dept: string, reviewer = deptAdmin()): Promise<void> {
    const created = await call(
      f,
      'memory.promote',
      { id: f.preferenceId, targetScope: 'department', departmentCode: dept },
      { id: reviewer.userId, name: reviewer.name },
      reviewer,
    )
    const id = (created.body.promotion as { id: string }).id
    const approved = await call(
      f,
      'memory.review-promotion',
      { id, decision: 'approve' },
      { id: 'u-admin', name: '管理员' },
      globalAdmin(),
    )
    expect(approved.status).toBe(200)
  }

  it('shows approved global memory to every reader and hides pending or rejected ones', async () => {
    const f = await fixture()
    await approvedGlobal(f)
    // A pending second request must not appear.
    await call(
      f,
      'memory.promote',
      { id: f.preferenceId, targetScope: 'global' },
      { id: 'u-admin', name: '管理员' },
      globalAdmin(),
    )
    const result = await call(f, 'memory.shared', {}, { id: 'u-member', name: '普通成员' }, ordinary())
    expect(result.status).toBe(200)
    const entries = result.body.entries as Array<Record<string, unknown>>
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ title: '指标口径排查', scope: 'global', type: 'sop' })
    // No personal identifier or source session is exposed.
    expect(JSON.stringify(result.body)).not.toContain('u1')
  })

  it('shows a department promotion only to that department', async () => {
    const f = await fixture()
    await approvedDept(f, 'dept-a')
    const inside = await call(f, 'memory.shared', {}, { id: 'u-a', name: 'A 成员' }, ordinary())
    const outside = await call(
      f,
      'memory.shared',
      {},
      { id: 'u-b', name: 'B 成员' },
      ordinary({ userId: 'u-b', departmentCode: 'dept-b', departmentPathCodes: ['dept-b'], visibleDepartmentCodes: ['dept-b'] }),
    )
    expect((inside.body.entries as unknown[])).toHaveLength(1)
    expect((outside.body.entries as unknown[])).toHaveLength(0)
  })

  it('hides a scope when DataOps refuses the read and asks about the exact folder id', async () => {
    const f = await fixture()
    await approvedGlobal(f)
    const asked: string[] = []
    const result = await call(
      f,
      'memory.shared',
      {},
      { id: 'u-member', name: '普通成员' },
      ordinary(),
      { canRead: async (relPath) => { asked.push(relPath); return false } },
    )
    expect(result.body.entries).toEqual([])
    expect(asked).toEqual(['global'])
  })
})

describe('promotion visibility and content helpers', () => {
  it('exposes the folder only through the scope prefix', () => {
    expect(promotionStorePath('/nas/kb/actual/.memory/users')).toBe('/nas/kb/actual/.memory/promotions.json')
  })

  it('renders SOP steps and success criteria into the shared body', () => {
    const text = promotionContentOf({
      id: 'x',
      type: 'sop',
      privacy: 'normal',
      createdAt: '2026-01-01T00:00:00Z',
      slug: 's',
      title: 't',
      status: 'testing',
      version: 1,
      trigger: '触发',
      steps: ['一', '二'],
      successCriteria: ['标准'],
    })
    expect(text).toContain('触发条件：触发')
    expect(text).toContain('1. 一')
    expect(text).toContain('- 标准')
  })

  it('never treats an unreviewed record as reviewable by a non-admin', () => {
    const target = {
      scope: 'department' as const,
      departmentCode: 'dept-a',
      graphId: 'shared-memory' as const,
      graphName: '部门共享记忆',
      docPath: '记忆共享/x.md',
    }
    expect(canReviewPromotion(deptAdmin(), target)).toBe(true)
    expect(canReviewPromotion(ordinary(), target)).toBe(false)
    expect(isPromotionVisibleTo({
      id: 'x',
      status: 'approved',
      source: { userId: 'u1', memoryId: 'm', memoryType: 'fact', title: 't', content: 'c', privacy: 'normal' },
      target,
      requestedBy: { id: 'u-dept-admin', name: '部门管理员' },
      requestedAt: '2026-01-01T00:00:00Z',
      confirmed: false,
      audit: [],
    }, ordinary())).toBe(true)
  })
})
