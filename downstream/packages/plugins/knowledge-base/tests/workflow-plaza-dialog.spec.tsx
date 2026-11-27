/**
 * @vitest-environment jsdom
 *
 * The dialog-level contract the reader cares about: choosing a model, then subscribing
 * must open the new Session and close the dialog without waiting for the schedule to be
 * verified. The orchestration unit tests pin the order; this test pins that the view
 * actually wires it: the confirm button calls through, the model reaches the Session,
 * and the modal disappears as soon as the prompt is accepted.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowPlazaCopy, WorkflowPlazaDeps } from '../src/client/workflows/WorkflowPlaza.tsx'
import { WorkflowPlaza } from '../src/client/workflows/WorkflowPlaza.tsx'
import type { WorkflowModelCatalogView } from '../src/client/workflows/modelChoice.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const Button = (props: Record<string, unknown>): React.ReactElement => {
    const { children, variant, size, ...rest } = props as {
      children?: React.ReactNode
      variant?: unknown
      size?: unknown
    }
    return <button type="button" {...rest}>{children}</button>
  }
  const Modal = (props: Record<string, unknown>): React.ReactElement | null => {
    const { children, footer, open } = props as { children?: React.ReactNode; footer?: React.ReactNode; open?: boolean }
    return open === true ? <div data-testid="modal">{children}{footer}</div> : null
  }
  return { Button, Modal }
})

const copy: WorkflowPlazaCopy = {
  title: 'Workflow plaza',
  subscribe: 'Subscribe',
  subscribed: 'Subscribed',
  unsubscribe: 'Unsubscribe',
  frequency: 'Frequency',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  custom: 'Custom',
  cronLabel: 'Cron',
  cronInvalid: 'Invalid cron',
  everyHours: 'Every N hours',
  everyMinutes: 'Every N minutes',
  hoursCount: 'Hours',
  minutesCount: 'Minutes',
  cronReason: () => 'invalid',
  intervalInvalid: (min, max) => `${String(min)}-${String(max)}`,
  subscribing: 'Subscribing…',
  plazaTab: 'Plaza',
  reviewTab: 'Review',
  mineTab: 'My shared', mineEmpty: 'You have not shared a workflow yet.', mineUpdated: 'Updated',
  mineReviewNote: 'Review note', mineResubmit: 'Resubmit', mineUnpublish: 'Unpublish',
  mineDetails: 'View details', mineActionFailed: 'Action failed', mineStatusPending: 'In review',
  mineStatusApproved: 'Shared', mineStatusRejected: 'Rejected', mineStatusUnpublished: 'Unpublished',
  mineScopeGlobal: 'Global', mineScopePrivate: 'Private', mineScopeDepartment: name => `${name} department`,
  reviewEmpty: 'No workflows waiting for review.',
  reviewLoading: 'Loading review queue…',
  reviewFailed: 'Review action failed; try again.',
  reviewAuthor: 'Author',
  reviewCreated: 'Submitted',
  reviewPromptLabel: 'View prompt',
  reviewNotePlaceholder: 'Rejection reason (optional)',
  reviewApprove: 'Approve',
  reviewReject: 'Reject',
  model: 'Model',
  modelLoading: 'Loading models…',
  modelUnavailable: 'Default model (catalog unavailable)',
  modelDefault: 'Workspace default model',
  effort: 'Reasoning effort',
  dialogTitle: 'Subscribe to this workflow',
  dialogConfirm: 'Create task',
  dialogCancel: 'Cancel',
  retry: 'Retry',
  alreadySubscribed: 'Already subscribed',
  failure: reason => `Failed: ${reason}`,
  reason: failure => failure,
  cardTitle: workflow => workflow.id,
  cardDescription: workflow => workflow.id,
}

const catalog: WorkflowModelCatalogView = {
  default: { provider: 'dashscope', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'max' },
  groups: [{
    provider: 'dashscope',
    providerName: 'DashScope',
    models: [{
      key: 'dashscope\u0000deepseek-v4.1-flash-1017',
      provider: 'dashscope',
      providerName: 'DashScope',
      model: 'deepseek-v4.1-flash-1017',
      modelName: 'DeepSeek V4.1 Flash 1017',
      reasoningEfforts: [{ id: 'max', name: 'Max' }],
      defaultEffort: 'max',
    }],
  }],
  failures: [],
}

const makeDeps = () => {
  const calls: string[] = []
  const deps: WorkflowPlazaDeps = {
    listTasks: vi.fn(async () => {
      calls.push('list')
      return []
    }),
    createSession: vi.fn(async () => { calls.push('create'); return 'session-1' }),
    sendPrompt: vi.fn(async (_session: string, text: string) => {
      calls.push('prompt:' + String(text.includes('schedule_create')))
      return true
    }),
    removeTask: vi.fn(async () => true),
    openSession: vi.fn((id: string) => { calls.push('open:' + id) }),
    loadModels: vi.fn(async () => catalog),
    selectModel: vi.fn(async (sessionId: string, selection: { provider: string; model: string; reasoningEffort?: string }) => {
      calls.push('select:' + sessionId + ':' + selection.provider + '/' + selection.model + '/' + String(selection.reasoningEffort))
      return true
    }),
    rememberModel: vi.fn((selection: { provider: string; model: string; reasoningEffort?: string }) => {
      calls.push('remember:' + selection.provider + '/' + selection.model + '/' + String(selection.reasoningEffort))
    }),
    readRememberedModel: vi.fn(() => undefined),
  }
  return { deps, calls }
}

afterEach(() => {
  document.body.innerHTML = ''
})

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

describe('workflow subscribe dialog', () => {
  it('sends the selected model, opens the session and closes immediately', async () => {
    const { deps, calls } = makeDeps()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<WorkflowPlaza copy={copy} deps={deps} />)
    })

    const subscribe = container.querySelector('[data-kb-workflow-subscribe]') as HTMLButtonElement | null
    expect(subscribe).not.toBeNull()
    await act(async () => { subscribe?.click() })

    await waitFor(() => container.querySelector('[data-kb-plaza-model]') !== null)
    const confirm = container.querySelector('[data-kb-plaza-confirm]') as HTMLButtonElement | null
    expect(confirm).not.toBeNull()
    await act(async () => { confirm?.click() })

    await waitFor(() => calls.some(call => call.startsWith('open:')))
    // The dialog is gone before any verification could have run.
    expect(container.querySelector('[data-testid="modal"]')).toBeNull()
    expect(calls).toContain('select:session-1:dashscope/deepseek-v4.1-flash-1017/max')
    expect(calls).toContain('open:session-1')
    expect(calls).toContain('remember:dashscope/deepseek-v4.1-flash-1017/max')
    expect(calls.some(call => call.startsWith('prompt:true'))).toBe(true)
    await act(async () => { root.unmount() })
  })
})
