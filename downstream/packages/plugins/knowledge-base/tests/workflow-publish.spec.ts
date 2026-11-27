import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WorkflowPublishError,
  listApprovedWorkflows,
  listPendingWorkflows,
  listWorkflowsForAuthor,
  normalizePublishInput,
  publishStorePath,
  publishWorkflow,
  readWorkflowStore,
  resubmitPublishedWorkflow,
  reviewWorkflow,
  unpublishPublishedWorkflow,
} from '../src/workflowPublish.ts'

const actor = { id: 'u-1', name: '张三' }
const reviewer = { id: 'admin-1', name: '超级管理员' }
const input = {
  title: '每周客户回访',
  description: '每周整理客户回访记录并生成摘要',
  instruction: '读取本周客户回访记录，按客户归并，输出三条跟进建议。',
  cronHint: '0 9 * * 1',
  category: '客户成功',
}

const tempStore = async (): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'kb-workflow-publish-'))
  return { dir, path: publishStorePath(dir) }
}

describe('workflow publish store', () => {
  it('publishes as pending with author, session and audit', async () => {
    const { dir, path } = await tempStore()
    try {
      const result = await publishWorkflow(path, input, actor, 'session-1', () => new Date('2026-10-23T01:00:00Z'))
      expect(result.duplicate).toBe(false)
      expect(result.record).toMatchObject({
        title: input.title,
        status: 'pending',
        authorId: 'u-1',
        authorName: '张三',
        sourceSessionId: 'session-1',
        createdAt: '2026-10-23T01:00:00.000Z',
        cronHint: '0 9 * * 1',
        category: '客户成功',
      })
      expect(result.record.id).toMatch(/^wf-/u)
      expect(result.record.audit).toEqual([{
        at: '2026-10-23T01:00:00.000Z',
        actorId: 'u-1',
        actorName: '张三',
        action: 'published',
      }])
      expect(await listPendingWorkflows(path)).toHaveLength(1)
      expect(await listApprovedWorkflows(path)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates the same normalized title + author while pending', async () => {
    const { dir, path } = await tempStore()
    try {
      const first = await publishWorkflow(path, input, actor)
      const second = await publishWorkflow(path, { ...input, title: '  每周客户回访  ' }, actor)
      expect(second.duplicate).toBe(true)
      expect(second.record.id).toBe(first.record.id)
      expect((await readWorkflowStore(path)).workflows).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('allows the same title from a different author', async () => {
    const { dir, path } = await tempStore()
    try {
      const first = await publishWorkflow(path, input, actor)
      const second = await publishWorkflow(path, input, { id: 'u-2', name: '李四' })
      expect(second.record.id).not.toBe(first.record.id)
      expect((await listPendingWorkflows(path))).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('approves into the public list and records the reviewer', async () => {
    const { dir, path } = await tempStore()
    try {
      const { record } = await publishWorkflow(path, input, actor)
      const approved = await reviewWorkflow(path, record.id, 'approve', reviewer, '内容合格', () => new Date('2026-10-23T02:00:00Z'))
      expect(approved.status).toBe('approved')
      expect(approved.reviewedByName).toBe('超级管理员')
      expect(approved.reviewNote).toBe('内容合格')
      expect(approved.audit.at(-1)).toMatchObject({
        action: 'approved',
        actorId: 'admin-1',
        note: '内容合格',
      })
      expect(await listPendingWorkflows(path)).toEqual([])
      expect((await listApprovedWorkflows(path)).map(item => item.id)).toEqual([record.id])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects but retains the record, hidden from the public list', async () => {
    const { dir, path } = await tempStore()
    try {
      const { record } = await publishWorkflow(path, input, actor)
      const rejected = await reviewWorkflow(path, record.id, 'reject', reviewer, '提示词范围过宽')
      expect(rejected.status).toBe('rejected')
      expect(rejected.reviewNote).toBe('提示词范围过宽')
      expect(await listApprovedWorkflows(path)).toEqual([])
      expect(await listPendingWorkflows(path)).toEqual([])
      expect((await readWorkflowStore(path)).workflows).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses to review the same record twice', async () => {
    const { dir, path } = await tempStore()
    try {
      const { record } = await publishWorkflow(path, input, actor)
      await reviewWorkflow(path, record.id, 'approve', reviewer)
      await expect(reviewWorkflow(path, record.id, 'reject', reviewer))
        .rejects.toMatchObject({ code: 'already-reviewed' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists across a fresh read (restart simulation)', async () => {
    const { dir, path } = await tempStore()
    try {
      const { record } = await publishWorkflow(path, input, actor)
      await reviewWorkflow(path, record.id, 'approve', reviewer)
      const raw = JSON.parse(await readFile(path, 'utf8')) as { workflows: Array<{ status: string }> }
      expect(raw.workflows[0]?.status).toBe('approved')
      expect((await listApprovedWorkflows(path))[0]?.id).toBe(record.id)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stores visibility and department scope; defaults to private', async () => {
    const { dir, path } = await tempStore()
    try {
      const defaults = await publishWorkflow(path, input, actor)
      expect(defaults.record).toMatchObject({ visibility: 'private', departmentCode: '' })
      const dept = await publishWorkflow(path, {
        ...input,
        title: '部门工作流',
        visibility: 'department',
        departmentCode: 'data-platform',
      }, actor)
      expect(dept.record).toMatchObject({ visibility: 'department', departmentCode: 'data-platform' })
      await expect(publishWorkflow(path, {
        ...input,
        title: '缺部门',
        visibility: 'department',
      }, actor)).rejects.toMatchObject({ code: 'invalid' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lists own workflows and resubmits a rejected one', async () => {
    const { dir, path } = await tempStore()
    try {
      const published = await publishWorkflow(path, input, actor)
      await reviewWorkflow(path, published.record.id, 'reject', reviewer, '提示词不够具体')
      const mine = await listWorkflowsForAuthor(path, actor.id)
      expect(mine).toHaveLength(1)
      expect(mine[0]).toMatchObject({ status: 'rejected', reviewNote: '提示词不够具体' })
      const resubmitted = await resubmitPublishedWorkflow(path, published.record.id, actor)
      expect(resubmitted).toMatchObject({ status: 'pending' })
      expect(resubmitted.reviewNote).toBeUndefined()
      await expect(resubmitPublishedWorkflow(path, published.record.id, actor))
        .rejects.toMatchObject({ code: 'invalid' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('unpublishes an approved workflow and hides it from the public list', async () => {
    const { dir, path } = await tempStore()
    try {
      const published = await publishWorkflow(path, input, actor)
      await reviewWorkflow(path, published.record.id, 'approve', reviewer)
      expect(await listApprovedWorkflows(path)).toHaveLength(1)
      const unpublished = await unpublishPublishedWorkflow(path, published.record.id, actor)
      expect(unpublished).toMatchObject({ status: 'unpublished' })
      expect(await listApprovedWorkflows(path)).toEqual([])
      expect((await listWorkflowsForAuthor(path, actor.id))[0]?.status).toBe('unpublished')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects incomplete or overlong input before writing', async () => {
    const { dir, path } = await tempStore()
    try {
      await expect(publishWorkflow(path, { ...input, title: '   ' }, actor))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(publishWorkflow(path, { ...input, instruction: 'x'.repeat(8_001) }, actor))
        .rejects.toMatchObject({ code: 'invalid' })
      expect((await readWorkflowStore(path)).workflows).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('quarantines a corrupt store instead of crashing the plaza', async () => {
    const { dir, path } = await tempStore()
    try {
      await writeFile(path, '{not json')
      expect(await readWorkflowStore(path)).toEqual({ version: 1, workflows: [] })
      const files = await readdir(dir)
      expect(files.some(name => name.includes('.corrupt-'))).toBe(true)
      expect(await readFile(join(dir, files.find(name => name.includes('.corrupt-'))!), 'utf8'))
        .toBe('{not json')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('serializes concurrent publishes instead of losing one', async () => {
    const { dir, path } = await tempStore()
    try {
      await Promise.all([
        publishWorkflow(path, { ...input, title: '并发 A' }, actor),
        publishWorkflow(path, { ...input, title: '并发 B' }, actor),
        publishWorkflow(path, { ...input, title: '并发 C' }, actor),
      ])
      expect((await listPendingWorkflows(path))).toHaveLength(3)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes optional fields and rejects a non-string type', () => {
    expect(normalizePublishInput({ ...input, cronHint: undefined, category: undefined }))
      .toMatchObject({ cronHint: '', category: '' })
    expect(() => normalizePublishInput({ ...input, title: 3 as never }))
      .toThrow(WorkflowPublishError)
  })
})
