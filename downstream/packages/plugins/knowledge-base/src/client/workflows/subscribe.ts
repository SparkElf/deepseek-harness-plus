/**
 * Turning one plaza card into a real DSH Schedule.
 *
 * ## Why this goes through a Session
 *
 * DSH exposes Schedules to the browser as list-and-delete only; creating one is an
 * agent tool (`schedule_create`). That is deliberate -- the task manager page says so
 * in its own type docs ("Start a new Session, where a reminder is created by asking
 * the model to schedule it. The page deliberately has no creation form of its own.")
 * -- so subscribing follows exactly the path the product already uses for its own
 * 「新建任务」 button: create a Session, ask the model to schedule the work, then confirm
 * it actually happened.
 *
 * ## Why the result is verified instead of assumed
 *
 * The model is a participant, not a function call. It can misread the request, ask a
 * clarifying question, or reply with prose and call nothing. Reporting "subscribed" on
 * the back of a successful `prompt` would be reporting that a message was delivered,
 * not that a task exists. So the last step re-reads the authoritative task list and
 * only then reports success; anything else is a failure with a reason the reader can
 * act on.
 *
 * Every dependency is injected, because the interesting part is the decision sequence
 * and a test should be able to drive it without a browser, a model, or a clock.
 *
 * @module @sparkelf/dsh-knowledge-base/client/workflows/subscribe
 */

import { findSubscription, type SubscribedTaskView } from './dedupe.ts'
import type { WorkflowModelSelection } from './modelChoice.ts'
import { workflowMarker, type WorkflowDefinition } from './registry.ts'

/** Where a subscription attempt currently is. */
export type SubscribePhase =
  | 'idle'
  | 'creating-session'
  | 'selecting-model'
  | 'prompting'
  | 'verifying'
  | 'opened'
  | 'subscribed'
  | 'cancelling'
  | 'cancelled'
  | 'failed'

/** Why an attempt failed, in terms the dialog can explain. */
export type SubscribeFailure =
  /** The workflow already has a task; nothing was created. */
  | 'already-subscribed'
  /** The Host refused to create a Session. */
  | 'session-failed'
  /** The new Session could not be addressed, so no prompt could be sent. */
  | 'session-unaddressable'
  /** The prompt was refused (e.g. the Session was not ready to accept it). */
  | 'prompt-failed'
  /** The selected model could not be installed on the new Session. */
  | 'model-failed'
  /** The prompt was accepted but no matching task appeared within the budget. */
  | 'not-created'
  /** Removing the task failed. */
  | 'cancel-failed'

/** One snapshot of an attempt. */
export interface SubscribeState {
  readonly phase: SubscribePhase
  /** Set when `phase` is `failed`. */
  readonly failure?: SubscribeFailure
  /** The task representing the subscription, once known. */
  readonly taskId?: string
  /** The Session created for the attempt, so a failed attempt can say where it went. */
  readonly sessionId?: string
}

/** Everything the orchestration needs from the outside world. */
export interface SubscribeDeps<T extends SubscribedTaskView> {
  /** Read the authoritative task list. */
  readonly listTasks: () => Promise<readonly T[]>
  /** Create a Session and return its id. */
  readonly createSession: () => Promise<string>
  /** Send one text prompt into a Session. Resolves false when it was refused. */
  readonly sendPrompt: (sessionId: string, text: string) => Promise<boolean>
  /** Remove one task (unsubscribe). */
  /**
   * Remove one task. The owning Session travels with the id because a Schedule belongs
   * to the Session that created it, and the Host routes deletion through that binding.
   */
  readonly removeTask: (taskId: string, sessionId: string) => Promise<boolean>
  /**
   * The Session's own failure, once its turn has one; undefined while it is still working.
   *
   * A turn that ended in an error (an expired provider key, a 5xx from the route, a model
   * that never called the tool) can never produce a task, so waiting out the whole budget
   * only delays a failure the Session already knows about. Optional so a caller without a
   * session face keeps the plain poll; the Host wiring supplies it.
   */
  readonly readSessionFailure?: (sessionId: string) => Promise<string | undefined>
  /** Wait for one poll interval; injected so tests do not sleep. */
  readonly sleep: (ms: number) => Promise<void>
  /** Called on every state change, so the dialog can render progress. */
  readonly onChange?: (state: SubscribeState) => void
}

/** How a subscribe attempt ended. */
export interface SubscribeOutcome {
  readonly ok: boolean
  /** Present on success: the task that now exists. */
  readonly taskId?: string
  /** Present on failure: why. */
  readonly failure?: SubscribeFailure
  /** The Session created, when one was; useful for a failure message. */
  readonly sessionId?: string
  /** Set when the Session was opened immediately (no verification wait). */
  readonly opened?: boolean
  /**
   * Present on `session-failed`: the message the Session's turn ended with, so a caller can
   * show the real cause instead of pointing the reader at the new Session.
   */
  readonly detail?: string
}

/**
 * How long the verification waits for the model to create the task.
 *
 * The prompt has to reach the model, the model has to call `schedule_create`, and the catalog
 * has to reflect it. Measured on 2026-10-23 against `dashscope/deepseek-v4.1-flash-1017`: the
 * tool call landed 29 s after the prompt and the task was visible by 33-39 s. The previous
 * 10 x 1 s budget therefore reported "not created" for subscriptions that succeeded moments
 * later, which is the false negative the dialog used to show.
 */
export const VERIFY_ATTEMPTS = 30
export const VERIFY_INTERVAL_MS = 3_000

/**
 * The exact instruction handed to the new Session.
 *
 * Written as a repeatable order rather than a conversation opener: it names the tool,
 * gives the cron, supplies the standing instruction, and quotes the marker line to
 * reproduce. The marker is quoted as literal text because it is what later recognition
 * keys on; a paraphrase would still be caught by the title fallback, but the reliable
 * path is worth asking for directly.
 *
 * @param workflow - the workflow being subscribed.
 * @param cron - the expression the reader chose.
 * @returns the prompt text.
 */
export function subscriptionPrompt(workflow: WorkflowDefinition, cron: string): string {
  return [
    '请为下面这个重复任务创建一条定时任务，不要修改也不要询问，直接调用 schedule_create 工具。',
    '',
    // The expr sits on its own line and is described as already-valid: a model asked to
    // produce a cron sometimes second-guesses an uncommon shape (`0 9 1 * *` for
    // monthly) and answers with nothing at all. Stating that the value is final and
    // ready to use removes that hesitation without changing what is scheduled.
    '下面这一行 cron 表达式已经是合法的 5 段格式（分 时 日 月 周），请直接原样使用，不要改写、不要追问、不要解释：',
    '',
    cron,
    '',
    '任务的 prompt 正文如下（请原样作为 schedule_create 的 prompt 参数）：',
    '---',
    workflowMarker(workflow.id),
    workflow.instruction,
    '---',
    '',
    `请务必让任务的 prompt 中包含这一行原文：${workflowMarker(workflow.id)}`,
    '',
    '同时请给 schedule_create 传以下可选元数据参数（值已定稿，原样使用，不要改写）：',
    `description: ${JSON.stringify(workflow.description ?? workflow.instruction)}`,
    ...(workflow.category === undefined ? [] : [`category: ${JSON.stringify(workflow.category)}`]),
    `source_id: ${JSON.stringify(workflow.id)}`,
    'source: "workflow"',
    '',
    '创建完成后，用一句话回复任务标题与下次运行时间即可。',
  ].join('\n')
}

/**
 * Subscribe one workflow.
 *
 * The sequence is: refuse early if already subscribed, create a Session, ask it to
 * schedule the work, then prove the task exists. Success is only ever reported from a
 * verified read.
 *
 * @param workflow - workflow to subscribe.
 * @param cron - the expression chosen in the dialog.
 * @param deps - injected Host operations.
 * @returns the outcome, including the created task id on success.
 */
export async function subscribeWorkflow<T extends SubscribedTaskView>(
  workflow: WorkflowDefinition,
  cron: string,
  deps: SubscribeDeps<T>,
): Promise<SubscribeOutcome> {
  const report = (state: SubscribeState): void => { deps.onChange?.(state) }

  report({ phase: 'idle' })

  // Step 1: the pre-flight duplicate check. This is the race guard that matters --
  // two clicks land here twice, and the second one must not create a Session at all.
  // It cannot be a hard guarantee (the list is read over the wire and another client
  // could create between the read and the write), which is why the UI also disables
  // the button synchronously and why the final verification re-checks the list.
  let before: readonly T[]
  try {
    before = await deps.listTasks()
  } catch {
    // A list that cannot be read is not evidence of absence. Refusing here is the
    // safe direction: a duplicate nightly job is worse than a retry.
    report({ phase: 'failed', failure: 'not-created' })
    return { ok: false, failure: 'not-created' }
  }
  const existing = findSubscription(workflow, before)
  if (existing !== undefined) {
    report({ phase: 'failed', failure: 'already-subscribed', taskId: existing.task.id })
    return { ok: false, failure: 'already-subscribed', taskId: existing.task.id }
  }

  // Step 2: create the Session that will carry the tool call.
  report({ phase: 'creating-session' })
  let sessionId: string
  try {
    sessionId = await deps.createSession()
  } catch {
    report({ phase: 'failed', failure: 'session-failed' })
    return { ok: false, failure: 'session-failed' }
  }
  if (sessionId === '') {
    report({ phase: 'failed', failure: 'session-unaddressable' })
    return { ok: false, failure: 'session-unaddressable' }
  }

  // Step 3: ask the model to do it.
  report({ phase: 'prompting', sessionId })
  const delivered = await deps.sendPrompt(sessionId, subscriptionPrompt(workflow, cron))
  if (!delivered) {
    report({ phase: 'failed', failure: 'prompt-failed', sessionId })
    return { ok: false, failure: 'prompt-failed', sessionId }
  }

  // Step 4: prove the task exists. A delivered prompt is not a created task.
  report({ phase: 'verifying', sessionId })
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    await deps.sleep(VERIFY_INTERVAL_MS)
    // Read the Session's own verdict first: a turn that already failed cannot create the
    // task, and its message names the cause ("Authentication Fails", a 5xx, ...). Waiting
    // out the budget would replace that with the generic "not created".
    let sessionFailure: string | undefined
    if (deps.readSessionFailure !== undefined) {
      try {
        sessionFailure = await deps.readSessionFailure(sessionId)
      } catch {
        sessionFailure = undefined
      }
    }
    let tasks: readonly T[]
    try {
      tasks = await deps.listTasks()
    } catch {
      if (sessionFailure !== undefined) {
        report({ phase: 'failed', failure: 'session-failed', sessionId })
        return { ok: false, failure: 'session-failed', sessionId, detail: sessionFailure }
      }
      continue
    }
    const created = findSubscription(workflow, tasks)
    if (created !== undefined) {
      report({ phase: 'subscribed', sessionId, taskId: created.task.id })
      return { ok: true, taskId: created.task.id, sessionId }
    }
    // The task list is the authority, so a failed turn is only terminal when no task
    // represents this workflow: a model that errored after creating it still subscribed.
    if (sessionFailure !== undefined) {
      report({ phase: 'failed', failure: 'session-failed', sessionId })
      return { ok: false, failure: 'session-failed', sessionId, detail: sessionFailure }
    }
  }

  report({ phase: 'failed', failure: 'not-created', sessionId })
  return { ok: false, failure: 'not-created', sessionId }
}

/**
 * Everything the immediate-open subscription needs.
 *
 * Deliberately no `sleep`/`readSessionFailure`: this path never waits for the task. It
 * ends as soon as the prompt is accepted and the Session is opened; the turn continues
 * in the conversation and the plaza re-reads the catalog when the reader returns.
 */
export interface CreateSubscriptionDeps<T extends SubscribedTaskView>
  extends Omit<SubscribeDeps<T>, 'sleep' | 'readSessionFailure'> {
  /** Install the chosen model on the new Session, before the prompt is sent. */
  readonly selectModel?: (sessionId: string, selection: WorkflowModelSelection) => Promise<boolean>
  /** Focus the new Session immediately. */
  readonly openSession?: (sessionId: string) => void
}

/**
 * Create the subscription Session and open it without waiting for the task.
 *
 * The old flow verified `schedule_create` inside the dialog, which kept "订阅中…" on
 * screen for up to 90 s and made a slow model look like a failed subscription. This
 * path does only what the reader asked for: create the Session, install the chosen
 * model, deliver the scheduling prompt, then open the conversation. The task appears
 * there; the plaza's next catalog read turns the card into 「退订」.
 *
 * @param workflow - workflow to subscribe.
 * @param cron - the frequency chosen in the dialog.
 * @param model - the selected model, or undefined to keep the workspace default.
 * @param deps - injected Host operations.
 * @returns `ok` once the prompt was accepted; no verification wait.
 */
export async function createSubscriptionSession<T extends SubscribedTaskView>(
  workflow: WorkflowDefinition,
  cron: string,
  model: WorkflowModelSelection | undefined,
  deps: CreateSubscriptionDeps<T>,
): Promise<SubscribeOutcome> {
  const report = (state: SubscribeState): void => { deps.onChange?.(state) }
  report({ phase: 'idle' })

  // Keep the duplicate guard: a second click must not create a Session at all.
  let before: readonly T[]
  try {
    before = await deps.listTasks()
  } catch {
    report({ phase: 'failed', failure: 'not-created' })
    return { ok: false, failure: 'not-created' }
  }
  const existing = findSubscription(workflow, before)
  if (existing !== undefined) {
    report({ phase: 'failed', failure: 'already-subscribed', taskId: existing.task.id })
    return { ok: false, failure: 'already-subscribed', taskId: existing.task.id }
  }

  report({ phase: 'creating-session' })
  let sessionId: string
  try {
    sessionId = await deps.createSession()
  } catch {
    report({ phase: 'failed', failure: 'session-failed' })
    return { ok: false, failure: 'session-failed' }
  }
  if (sessionId === '') {
    report({ phase: 'failed', failure: 'session-unaddressable' })
    return { ok: false, failure: 'session-unaddressable' }
  }

  // The Session-local selection is what makes the chosen provider/model win over the
  // workspace default. It must happen before the prompt: selecting afterwards would
  // leave the very first turn on the default (the 502 the reader hit with tokensfree).
  if (model !== undefined && deps.selectModel !== undefined) {
    report({ phase: 'selecting-model', sessionId })
    let selected = false
    try {
      selected = await deps.selectModel(sessionId, model)
    } catch {
      selected = false
    }
    if (!selected) {
      report({ phase: 'failed', failure: 'model-failed', sessionId })
      return { ok: false, failure: 'model-failed', sessionId }
    }
  }

  report({ phase: 'prompting', sessionId })
  const delivered = await deps.sendPrompt(sessionId, subscriptionPrompt(workflow, cron))
  if (!delivered) {
    report({ phase: 'failed', failure: 'prompt-failed', sessionId })
    return { ok: false, failure: 'prompt-failed', sessionId }
  }

  // Open BEFORE returning, so the dialog's success handler has nothing left to await.
  // A Host without `sessions.open` still counts as a successful subscription.
  let opened = false
  if (deps.openSession !== undefined) {
    try {
      deps.openSession(sessionId)
      opened = true
    } catch {
      opened = false
    }
  }
  report({ phase: 'opened', sessionId })
  return { ok: true, sessionId, opened }
}

/**
 * Unsubscribe one workflow by removing the task that represents it.
 *
 * @param taskId - task to remove, from a previous {@link findSubscription}.
 * @param sessionId - Session that owns the task.
 * @param deps - injected Host operations (only `removeTask` is used).
 * @returns whether the task was removed.
 */
export async function unsubscribeWorkflow<T extends SubscribedTaskView>(
  taskId: string,
  sessionId: string,
  deps: Pick<SubscribeDeps<T>, 'removeTask' | 'onChange'>,
): Promise<boolean> {
  deps.onChange?.({ phase: 'cancelling', taskId })
  const removed = await deps.removeTask(taskId, sessionId)
  deps.onChange?.(removed
    ? { phase: 'cancelled', taskId }
    : { phase: 'failed', failure: 'cancel-failed', taskId })
  return removed
}
