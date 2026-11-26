/**
 * When to keep waiting for a freshly created conversation, and when to give up.
 *
 * Lifted out of the picker's `createNew` because the part worth testing is a decision,
 * not a render: "retry, insert, or report failure" is a pure function of two booleans
 * and a clock, and the failure mode when it is wrong is silence — the dialog closes and
 * nothing happens, which is exactly the bug class this whole surface exists to end.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

/** What one readiness attempt found. */
export interface ReadinessProbe {
  /** Whether a session id could be resolved at all (the catalog has it). */
  hasTarget: boolean
  /** Whether the insert actually landed (the workspace could resolve the root). */
  inserted: boolean
}

/** What the caller should do next. */
export type ReadinessAction =
  /** Try again shortly: the ordinary race, not a refusal. */
  | 'retry'
  /** Everything landed. */
  | 'done'
  /** Out of time with no session to target. */
  | 'failed-no-target'
  /** Out of time with a session but nothing inserted. */
  | 'failed-insert'

/**
 * Decide the next move for one readiness attempt.
 *
 * The deadline is passed in rather than read here so the decision is reproducible in a
 * test: a function that read the clock itself could only be tested by waiting.
 *
 * The ordering matters. "No target yet" and "target but no insert" are different
 * failures and get different messages; collapsing them would tell a reader "could not
 * insert" when in fact no conversation was ever identified.
 * @param probe - what this attempt observed.
 * @param expired - whether the wait budget is already spent.
 * @returns The action the caller should take.
 */
export function decideReadiness(probe: ReadinessProbe, expired: boolean): ReadinessAction {
  if (!probe.hasTarget) return expired ? 'failed-no-target' : 'retry'
  if (probe.inserted) return 'done'
  return expired ? 'failed-insert' : 'retry'
}

/**
 * Whether the wait budget is spent.
 *
 * Split out and tested because the naive version of this comparison is what broke: a
 * deadline computed inside the retry function is recomputed on every pass, so it never
 * expires and the "report a failure" branch becomes unreachable. A test that pins
 * `deadline === now` to `true` is the cheapest way to keep that from coming back.
 * @param now - current epoch milliseconds.
 * @param deadline - the instant the budget runs out.
 * @returns True once `now` has reached the deadline.
 */
export function isExpired(now: number, deadline: number): boolean {
  return now >= deadline
}

/**
 * The deadline for a wait that starts now.
 * @param now - current epoch milliseconds.
 * @param budgetMs - how long the caller is willing to wait.
 * @returns The instant the budget runs out.
 */
export function deadlineFrom(now: number, budgetMs: number): number {
  return now + budgetMs
}
