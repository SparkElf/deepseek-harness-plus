// @ts-nocheck
/**
 * @vitest-environment jsdom
 *
 * The review tab is a permission-shaped surface: it must not exist for a non-reviewer,
 * and an approval must go through the Host call rather than mutate the queue locally.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowPlazaCopy, WorkflowPlazaDeps } from '../src/client/workflows/WorkflowPlaza.tsx'
import { WorkflowPlaza } from '../src/client/workflows/WorkflowPlaza.tsx'
import type { PublishedWorkflowView } from '../src/client/workflows/published.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Button = (props: Record<string, unknown>): React.ReactElement => {
    const { children, variant, size, ...rest } = props as { children?: React.ReactNode }
    return <button type="button" {...rest}>{children}</button>
  }
  const Modal = (props: Record<string, unknown>): React.ReactElement | null => {
    const { children, footer, open } = props as { children?: React.ReactNode; footer?: React.ReactNode; open?: boolean }
    return open === true ? <div data-testid="modal">{children}{footer}</div> : null
  }
  return { Button, Modal }
})

const copy: WorkflowPlazaCopy = {
  title: 'Workflow plaza', subscribe: 'Subscribe', subscribed: 'Subscribed', unsubscribe: 'Unsubscribe',
  frequency: 'Frequency', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', custom: 'Custom',
  cronLabel: 'Cron', cronInvalid: 'Invalid', everyHours: 'Every N hours', everyMinutes: 'Every N minutes',
  hoursCount: 'Hours', minutesCount: 'Minutes', cronReason: () => 'invalid',
  intervalInvalid: (min, max) => `${String(min)}-${String(max)}`,
  subscribing: 'Subscribing…', plazaTab: 'Plaza', reviewTab: 'Review',
  mineTab: 'My shared', mineEmpty: 'You have not shared a workflow yet.', mineUpdated: 'Updated',
  mineReviewNote: 'Review note', mineResubmit: 'Resubmit', mineUnpublish: 'Unpublish',
  mineDetails: 'View details', mineActionFailed: 'Action failed', mineStatusPending: 'In review',
  mineStatusApproved: 'Shared', mineStatusRejected: 'Rejected', mineStatusUnpublished: 'Unpublished',
  mineScopeGlobal: 'Global', mineScopePrivate: 'Private', mineScopeDepartment: name => `${name} department`,
  reviewEmpty: 'No workflows waiting for review.', reviewLoading: 'Loading review queue…',
  reviewFailed: 'Review action failed; try again.', reviewAuthor: 'Author', reviewCreated: 'Submitted',
  reviewPromptLabel: 'View prompt', reviewNotePlaceholder: 'Rejection reason (optional)',
  reviewApprove: 'Approve', reviewReject: 'Reject',
  model: 'Model', modelLoading: 'Loading models…', modelUnavailable: 'Default model', modelDefault: 'Workspace default', effort: 'Reasoning effort',
  dialogTitle: 'Subscribe', dialogConfirm: 'Create task', dialogCancel: 'Cancel', retry: 'Retry',
  alreadySubscribed: 'Already subscribed', failure: reason => reason, reason: failure => failure,
  cardTitle: workflow => workflow.title ?? workflow.id,
  cardDescription: workflow => workflow.description ?? workflow.id,
}

const pending: PublishedWorkflowView = {
  id: 'wf-1', title: '客户回访整理', description: '每周整理回访记录',
  instruction: '读取本周回访记录，生成跟进建议。', cronHint: '0 9 * * 1', category: '客户成功',
  authorName: '张三', createdAt: '2026-10-23T01:00:00.000Z', status: 'pending',
}

const deps = (overrides: Partial<WorkflowPlazaDeps>): WorkflowPlazaDeps => ({
  listTasks: async () => [],
  createSession: async () => 'session-1',
  sendPrompt: async () => true,
  removeTask: async () => true,
  ...overrides,
})

afterEach(() => { document.body.innerHTML = '' })

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 2000) throw new Error('timed out')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

describe('workflow plaza header actions', () => {
  it('renders the declared actions seat without owning the contributor', async () => {
    const renderSlot = vi.fn(() => null)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<WorkflowPlaza copy={copy} deps={deps({})} renderSlot={renderSlot} />)
    })
    expect(renderSlot).toHaveBeenCalledWith('workflow-plaza.actions', {})
    expect(container.querySelector('[data-kb-plaza-header]')).not.toBeNull()
    expect(container.querySelector('[data-kb-plaza-header] > [data-kb-plaza-actions]')).not.toBeNull()
    await act(async () => { root.unmount() })
  })
})

describe('workflow review tab', () => {
  it('is absent for a caller without review access', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<WorkflowPlaza copy={copy} deps={deps({ loadReviewAccess: async () => false })} />) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
    expect(container.querySelector('[data-kb-plaza-tab="review"]')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('lists a pending workflow and sends approve with the reason field', async () => {
    const reviewPublished = vi.fn(async () => true)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<WorkflowPlaza copy={copy} deps={deps({
        loadReviewAccess: async () => true,
        loadPending: async () => [pending],
        reviewPublished,
      })} />)
    })
    await waitFor(() => container.querySelector('[data-kb-plaza-tab="review"]') !== null)
    await act(async () => {
      (container.querySelector('[data-kb-plaza-tab="review"]') as HTMLButtonElement).click()
    })
    await waitFor(() => container.querySelector('[data-kb-plaza-pending="wf-1"]') !== null)
    const note = container.querySelector('[data-kb-plaza-review-note="wf-1"]') as HTMLInputElement
    await act(async () => {
      // React's controlled-input value tracker ignores a plain assignment.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(note, '内容合格')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      (container.querySelector('[data-kb-plaza-approve="wf-1"]') as HTMLButtonElement).click()
    })
    await waitFor(() => reviewPublished.mock.calls.length === 1)
    expect(reviewPublished).toHaveBeenCalledWith('wf-1', 'approve', '内容合格')
    await act(async () => { root.unmount() })
  })
})
describe('workflow plaza header row', () => {
  it('keeps tabs and the actions seat in one header row', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const renderSlot = vi.fn(() => null)
    await act(async () => {
      root.render(<WorkflowPlaza copy={copy} deps={deps({
        loadReviewAccess: async () => true,
        loadMine: async () => [],
      })} renderSlot={renderSlot} />)
    })
    await waitFor(() => container.querySelector('[data-kb-plaza-tab="mine"]') !== null)
    const header = container.querySelector('[data-kb-plaza-header]')
    expect(header?.querySelector('[data-kb-plaza-tabs]')).not.toBeNull()
    expect(header?.querySelector('[data-kb-plaza-actions]')).not.toBeNull()
    await act(async () => { root.unmount() })
  })
})

describe('workflow mine tab', () => {
  const rejected: PublishedWorkflowView = {
    id: 'wf-rejected', title: '周报汇总', description: '汇总周报',
    instruction: '读取周报并汇总。', cronHint: '0 9 * * 1', category: '运营',
    reviewStatus: 'rejected', reviewNote: '提示词需要更具体', visibility: 'department',
    departmentName: '数据平台', updatedAt: '2026-10-23T02:00:00.000Z',
  }
  const pendingMine: PublishedWorkflowView = {
    id: 'wf-pending', title: '审核中的工作流', description: '等待审核',
    instruction: '整理。', reviewStatus: 'pending', visibility: 'private',
    updatedAt: '2026-10-23T01:30:00.000Z',
  }
  const approved: PublishedWorkflowView = {
    id: 'wf-approved', title: '客户回访', description: '回访整理',
    instruction: '整理回访。', reviewStatus: 'approved', visibility: 'global',
    updatedAt: '2026-10-23T03:00:00.000Z',
  }

  it('shows the same count as the mine list, status, scope and rejection reason', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<WorkflowPlaza copy={copy} deps={deps({ loadMine: async () => [pendingMine, rejected, approved] })} />)
    })
    await waitFor(() => container.querySelector('[data-kb-plaza-tab="mine"]') !== null)
    expect(container.querySelector('[data-kb-plaza-mine-count]')?.textContent).toBe('3')
    await act(async () => {
      (container.querySelector('[data-kb-plaza-tab="mine"]') as HTMLButtonElement).click()
    })
    await waitFor(() => container.querySelector('[data-kb-plaza-mine-card="wf-rejected"]') !== null)
    expect(container.querySelector('[data-kb-plaza-mine-status="rejected"]')?.textContent).toBe('Rejected')
    expect(container.querySelector('[data-kb-plaza-mine-scope="department"]')?.textContent).toContain('数据平台')
    expect(container.querySelector('[data-kb-plaza-mine-reason]')?.textContent).toContain('提示词需要更具体')
    const pendingCard = container.querySelector('[data-kb-plaza-mine-card="wf-pending"]')
    expect(pendingCard?.querySelector('[data-kb-plaza-mine-footer]')).not.toBeNull()
    expect(pendingCard?.querySelector('[data-kb-plaza-mine-resubmit]')).toBeNull()
    expect(pendingCard?.querySelector('[data-kb-plaza-mine-unpublish]')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('resubmits a rejected workflow and unpublishes an approved one', async () => {
    const resubmitMine = vi.fn(async () => true)
    const unpublishMine = vi.fn(async () => true)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<WorkflowPlaza copy={copy} deps={deps({
        loadMine: async () => [rejected, approved],
        resubmitMine,
        unpublishMine,
      })} />)
    })
    await waitFor(() => container.querySelector('[data-kb-plaza-tab="mine"]') !== null)
    await act(async () => {
      (container.querySelector('[data-kb-plaza-tab="mine"]') as HTMLButtonElement).click()
    })
    await waitFor(() => container.querySelector('[data-kb-plaza-mine-resubmit="wf-rejected"]') !== null)
    await act(async () => {
      (container.querySelector('[data-kb-plaza-mine-resubmit="wf-rejected"]') as HTMLButtonElement).click()
    })
    await waitFor(() => resubmitMine.mock.calls.length === 1)
    await act(async () => {
      (container.querySelector('[data-kb-plaza-mine-unpublish="wf-approved"]') as HTMLButtonElement).click()
    })
    await waitFor(() => unpublishMine.mock.calls.length === 1)
    await act(async () => { root.unmount() })
  })
})
