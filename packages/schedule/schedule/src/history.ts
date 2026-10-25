/**
 * Run-log projection over the durable Schedule stream.
 *
 * Dispatch and run changes are append-only receipts; this module derives the
 * recent-run list without adding a second history store.
 * @module @deepseek-ai/dsh-schedule/history
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { decodeScheduleChange } from './domain.ts'
import type { ScheduleId, ScheduleRunLogEntry } from './types.ts'

/** Whether two run entries describe the same durable dispatch. */
function sameRun(left: ScheduleRunLogEntry, right: ScheduleRunLogEntry): boolean {
  return left.scheduleId === right.scheduleId && left.at === right.at
}

/**
 * Derive durable run receipts newest first.
 *
 * Explicit `run` changes win over the older dispatch-only stream; a Session
 * written before run receipts existed still reports its dispatches.
 * @param events - Ordered Session events (live suffix or stored log).
 * @param inheritedEventCount - Inherited prefix excluded from child ownership.
 * @param scheduleId - Optional exact reminder filter.
 * @returns Run entries newest first.
 */
export function scheduleRunLogs(
  events: readonly SessionEvent[],
  inheritedEventCount = 0,
  scheduleId?: ScheduleId,
): ScheduleRunLogEntry[] {
  const explicit: ScheduleRunLogEntry[] = []
  const dispatches: ScheduleRunLogEntry[] = []
  for (const event of events.slice(inheritedEventCount)) {
    if (event.type !== 'schedule/change') continue
    const change = decodeScheduleChange(event.data)
    if (change.operation === 'run') {
      const { run } = change
      explicit.push({
        runId: run.runId,
        scheduleId: run.scheduleId,
        at: run.at,
        status: run.status,
        trigger: run.trigger,
        ...run.error === undefined ? {} : { error: run.error },
        ...run.durationMs === undefined ? {} : { durationMs: run.durationMs },
      })
      continue
    }
    if (change.operation === 'dispatch') {
      dispatches.push({
        runId: `dispatch-${event.seq}`,
        scheduleId: change.id,
        at: new Date(event.time).toISOString(),
        status: 'dispatched',
        trigger: 'due',
        durationMs: 0,
      })
    }
  }
  const entries = [
    ...explicit,
    ...dispatches.filter(dispatch => !explicit.some(run => sameRun(run, dispatch))),
  ]
  const filtered = scheduleId === undefined
    ? entries
    : entries.filter(entry => entry.scheduleId === scheduleId)
  return filtered.reverse()
}

/**
 * Return the latest run receipt for one reminder.
 * @param events - Ordered Session events.
 * @param inheritedEventCount - Inherited prefix excluded from child ownership.
 * @param scheduleId - Exact reminder filter.
 * @returns The newest entry, or `undefined` when the reminder never ran.
 */
export function latestScheduleRun(
  events: readonly SessionEvent[],
  inheritedEventCount: number,
  scheduleId: ScheduleId,
): ScheduleRunLogEntry | undefined {
  return scheduleRunLogs(events, inheritedEventCount, scheduleId)[0]
}
