/**
 * Failures this browser session saw that the Host has no task for.
 *
 * A refused extraction never reaches `extract.status`: the Host answers 404 before it
 * creates a queue entry, so the progress panel -- which reads only the Host's snapshot --
 * could not show the one failure the reader just hit. This store is the panel's own
 * memory of those refusals.
 *
 * It lives at module scope rather than in component state for one reason: the knowledge
 * panel unmounts when the reader visits another destination, and a failure that vanished
 * on navigation would be indistinguishable from one the feature never recorded. The
 * store is per page load, which is the "this session" the reader means -- a reload is a
 * new session, and the filesystem (not this array) remains the authority on disk.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import type { FailedExtractionView } from './progressRules.ts'

/** Most failures kept; an unbounded array would grow for the life of the tab. */
export const SESSION_FAILURE_LIMIT = 50

/** The session's recorded failures, oldest first. */
const failures: FailedExtractionView[] = []

/**
 * Record one refused extraction.
 *
 * Re-recording a path REPLACES its earlier reason and moves it to the end: a reader who
 * retried and failed differently needs the newest reason, and the list reads newest-last.
 * @param entry - the path, the raw reason, and when it was observed (defaults to now).
 */
export function rememberExtractionFailure(entry: { relPath: string; reason: string; at?: number }): void {
  const at = entry.at ?? Date.now()
  const existing = failures.findIndex(failure => failure.relPath === entry.relPath)
  if (existing !== -1) failures.splice(existing, 1)
  failures.push({ relPath: entry.relPath, reason: entry.reason, at })
  if (failures.length > SESSION_FAILURE_LIMIT) failures.splice(0, failures.length - SESSION_FAILURE_LIMIT)
}

/**
 * Read the session's failures.
 * @returns A copy, so a caller cannot mutate the store by accident.
 */
export function readExtractionFailures(): FailedExtractionView[] {
  return failures.map(failure => ({ ...failure }))
}

/**
 * Drop one path's recorded failure, e.g. after a retry was accepted.
 * @param relPath - the document whose failure is no longer current.
 */
export function forgetExtractionFailure(relPath: string): void {
  const index = failures.findIndex(failure => failure.relPath === relPath)
  if (index !== -1) failures.splice(index, 1)
}

/** Clear every recorded failure. Exists for tests; no production path calls it. */
export function clearExtractionFailures(): void {
  failures.length = 0
}
