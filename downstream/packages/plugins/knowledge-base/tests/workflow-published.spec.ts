import { describe, expect, it } from 'vitest'
import { BUILT_IN_WORKFLOWS, findWorkflow } from '../src/client/workflows/registry.ts'
import { mergePublishedWorkflows, publishedDefinition } from '../src/client/workflows/published.ts'

const record = {
  id: 'wf-1',
  title: '客户回访整理',
  description: '每周整理回访记录',
  instruction: '读取本周回访记录，生成跟进建议。',
  cronHint: '0 9 * * 1',
  category: '客户成功',
  authorName: '张三',
  createdAt: '2026-10-23T01:00:00.000Z',
  status: 'approved' as const,
}

describe('approved workflow cards', () => {
  it('turns an approved record into a plaza definition with its own copy', () => {
    const workflow = publishedDefinition(record)
    expect(workflow).toMatchObject({
      id: 'wf-1',
      title: '客户回访整理',
      description: '每周整理回访记录',
      instruction: '读取本周回访记录，生成跟进建议。',
      defaultCron: '0 9 * * 1',
      category: '客户成功',
      authorName: '张三',
    })
    expect(workflow.frequencies.length).toBeGreaterThan(0)
  })

  it('falls back to a usable cron when the author supplied prose', () => {
    const workflow = publishedDefinition({ ...record, cronHint: '每周一早上' })
    expect(workflow.defaultCron).toBe('0 9 * * 1')
  })

  it('merges built-ins first and keeps ids unique', () => {
    const merged = mergePublishedWorkflows(BUILT_IN_WORKFLOWS, [
      record,
      { ...record, id: 'wf-2', title: '第二个' },
      { ...record, id: 'wf-1', title: '重复 id' },
    ])
    expect(merged.map(workflow => workflow.id)).toEqual([
      ...BUILT_IN_WORKFLOWS.map(workflow => workflow.id),
      'wf-1',
      'wf-2',
    ])
    expect(findWorkflow('wf-1')).toBeUndefined() // built-in lookup is not the merge
    expect(merged.at(-1)?.title).toBe('第二个')
  })
})
