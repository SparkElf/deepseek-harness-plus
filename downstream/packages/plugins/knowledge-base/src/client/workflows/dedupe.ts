/**
 * Deciding whether a workflow is already subscribed.
 *
 * The plaza must not offer a second subscription for a workflow that already has a
 * task, and the answer has to survive a page refresh -- so it is read from the
 * authoritative Schedule list every time, never from component state. A local flag
 * would be a second opinion that starts lying the moment the page reloads.
 *
 * ## Why two ways of recognising a task
 *
 * A subscription is marked by putting `[workflow:<id>]` inside the Schedule's prompt.
 * That marker is written by our own code, but the prompt also passes through a model
 * that is asked to reproduce it verbatim -- and a model sometimes paraphrases. If
 * recognition depended on the marker alone, one paraphrased prompt would make a
 * subscribed workflow look unsubscribed, and the reader could subscribe twice.
 *
 * So recognition is deliberately generous: the marker OR the workflow's own title
 * appearing in the task's prompt/name counts. A false "already subscribed" is a much
 * smaller problem than a duplicate nightly job that reorganises someone's documents.
 *
 * @module @sparkelf/dsh-knowledge-base/client/workflows/dedupe
 */

import { workflowMarker, type WorkflowDefinition } from './registry.ts'

/** The part of a Schedule task this module needs, so it can be tested without one. */
export interface SubscribedTaskView {
  /** Task identity, used to unsubscribe. */
  readonly id: string
  /** Session the task belongs to; deletion is routed through it. */
  readonly sessionId?: string
  /** The task's prompt, which is where a subscription leaves its mark. */
  readonly prompt?: string
  /** The task's display name, when the list reports one. */
  readonly name?: string
}

/** One workflow found to be already subscribed. */
export interface ExistingSubscription<T extends SubscribedTaskView = SubscribedTaskView> {
  /** The workflow id that was found. */
  readonly workflowId: string
  /** The task that represents it. */
  readonly task: T
  /**
   * How it was recognised. `marker` is the reliable path; `title` means the marker was
   * lost and the title match carried it. Presented so a reader can be told the
   * subscription was found by name rather than by its tag.
   */
  readonly via: 'marker' | 'title'
}

/**
 * Whether one task's text mentions a workflow.
 *
 * @param text - the task's prompt and name, already joined.
 * @param workflow - workflow to look for.
 * @returns how it matched, or undefined when it did not.
 */
function matchText(text: string, workflow: WorkflowDefinition): 'marker' | 'title' | undefined {
  if (text.includes(workflowMarker(workflow.id))) return 'marker'
  // The title is copy, so a locale change could orphan this branch; it exists only as
  // a safety net for a prompt whose marker was paraphrased away.
  const title = text.toLowerCase()
  const id = workflow.id.toLowerCase()
  // The id is echoed in the prompt in human form too ("kb-organize-personal" reads as
  // words), so accept the id itself as a weaker title-level hit.
  if (title.includes(id)) return 'title'
  return undefined
}

/**
 * Find every workflow already represented among the scheduled tasks.
 *
 * @param tasks - the authoritative task list.
 * @param workflows - workflows the plaza offers.
 * @returns one entry per subscribed workflow, in the workflows' own order.
 */
export function findSubscriptions<T extends SubscribedTaskView>(
  tasks: readonly T[],
  workflows: readonly WorkflowDefinition[],
): Array<ExistingSubscription<T>> {
  const found: Array<ExistingSubscription<T>> = []
  for (const workflow of workflows) {
    for (const task of tasks) {
      const text = `${task.prompt ?? ''}\n${task.name ?? ''}`
      const via = matchText(text, workflow)
      if (via !== undefined) {
        found.push({ workflowId: workflow.id, task, via })
        break
      }
    }
  }
  return found
}

/**
 * Whether one workflow is already subscribed, and by which task.
 *
 * @param workflow - workflow the reader wants to subscribe.
 * @param tasks - the authoritative task list, read immediately before subscribing.
 * @returns the existing subscription, or undefined when there is none.
 */
export function findSubscription<T extends SubscribedTaskView>(
  workflow: WorkflowDefinition,
  tasks: readonly T[],
): ExistingSubscription<T> | undefined {
  return findSubscriptions(tasks, [workflow])[0]
}

/**
 * Index subscriptions by workflow id, for rendering card state.
 *
 * @param subscriptions - result of {@link findSubscriptions}.
 * @returns workflow id -> subscription, so a card asks one question instead of scanning.
 */
export function subscriptionIndex<T extends SubscribedTaskView>(
  subscriptions: readonly ExistingSubscription<T>[],
): Map<string, ExistingSubscription<T>> {
  return new Map(subscriptions.map(subscription => [subscription.workflowId, subscription]))
}
