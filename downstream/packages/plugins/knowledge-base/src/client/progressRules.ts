/**
 * The progress strip's two decisions, kept out of the component.
 *
 * Both are answers about data rather than about React: whether a batch is finished, and
 * whether a retry button would help. They live here because a `.tsx` module that imports
 * the UI primitives cannot be loaded by the test runner (the primitives package imports
 * CSS at module scope, which the runner cannot resolve), so a test that imported the
 * component would fail before reaching any assertion.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

/**
 * Whether a retry button would help for this state.
 *
 * Only a failure is worth retrying. `unsupported` means no extractor exists for the
 * type, so a retry fails identically and the button would be a lie; the pending and
 * running states are already being handled.
 * @param state - the extraction state.
 * @returns Whether to offer a retry.
 */
export function canRetryExtraction(state: string): boolean {
  return state === 'failed'
}

/**
 * A failure reason that survives a response which is not JSON.
 *
 * A gateway answering 502 sends HTML, and `response.json()` rejects on it. If that
 * rejection escaped, the row would report "failed" with no reason at all -- which is
 * exactly the silence this strip exists to remove. So the body is attempted, and an
 * unreadable body falls back to the status code, which still tells the reader whether
 * the server refused them (4xx) or broke (5xx).
 * @param body - the parsed body, when it parsed.
 * @param status - the HTTP status.
 * @returns A sentence a reader can act on.
 */
export function failureReason(body: { error?: unknown; code?: unknown } | undefined, status: number): string {
  if (typeof body?.error === 'string' && body.error !== '') return body.error
  if (body?.code === 'too-large') return 'file is too large'
  if (status === 413) return 'file is too large'
  if (status === 409) return 'the knowledge base is not configured'
  if (status === 403) return 'write access is required here'
  if (status >= 500) return 'the server failed while writing the file (HTTP ' + String(status) + ')'
  return 'the upload was refused (HTTP ' + String(status) + ')'
}

/** How a group of tasks breaks down, with every task counted exactly once. */
export interface TaskTally {
  /** Tasks that produced what the reader asked for. */
  done: number
  /** Tasks that ended without producing it, for any reason. */
  failed: number
  /** Tasks inside an unsupported format, kept apart from ordinary failures. */
  unsupported: number
  /** Tasks still queued or running. */
  active: number
  /** Every task in the group. */
  total: number
}

/**
 * Count a group of extraction tasks.
 *
 * The invariant this exists for: `done + failed + active === total`. A tally that drops a
 * state makes the summary read "0 extracted, 0 failed" beside a list holding one row --
 * the reader sees a task that neither succeeded nor failed and has no way to learn what
 * happened to it.
 *
 * `unsupported` is counted in BOTH its own field and in `failed`. The two audiences are
 * different: the summary groups it with failures (a reader who did not get their Markdown
 * does not care why), while the row still says "this file type has no extractor", which is
 * where the specific reason belongs.
 * @param tasks - the tasks to count.
 * @returns The breakdown.
 */
export function tallyExtraction(tasks: readonly { state: string }[]): TaskTally {
  let done = 0
  let failed = 0
  let unsupported = 0
  let active = 0
  for (const task of tasks) {
    if (task.state === 'succeeded') done += 1
    else if (task.state === 'failed') failed += 1
    else if (task.state === 'unsupported') {
      unsupported += 1
      // Counted as a failure for the summary: the reader asked for a document and did
      // not get one.
      failed += 1
    } else active += 1
  }
  return { done, failed, unsupported, active, total: tasks.length }
}

/**
 * Count a group of upload tasks.
 *
 * Same invariant as {@link tallyExtraction}, for the upload batch: every row is exactly
 * one of done, failed, or still in flight.
 * @param tasks - the upload rows.
 * @returns The breakdown.
 */
export function tallyUploads(tasks: readonly { state: string }[]): TaskTally {
  let done = 0
  let failed = 0
  let active = 0
  for (const task of tasks) {
    if (task.state === 'done') done += 1
    else if (task.state === 'failed') failed += 1
    // `waiting` and `uploading` are both "not finished yet": the reader waiting on the
    // batch does not need that distinction in a count.
    else active += 1
  }
  return { done, failed, unsupported: 0, active, total: tasks.length }
}

/** One upload row, as the notification panel shows it. */
export interface UploadTaskView {
  /** The file's path relative to the drop target: the name the reader dropped. */
  name: string
  /** The tree-relative directory it is landing in, `''` for the mount root. */
  dir: string
  /** Where this file is in its own lifecycle. */
  state: 'waiting' | 'uploading' | 'done' | 'failed'
  /** Why it failed, in the Host's own words. */
  reason?: string
  /**
   * When this row was enqueued, ISO-8601. Used to order the unified task queue.
   */
  at?: string
  /**
   * Bytes sent, as 0-100.
   *
   * Absent while the browser cannot know it (a body without a known length) and on every
   * settled row: a percentage that never moves, or a track left behind after completion,
   * both claim something that is not true.
   */
  percent?: number
}

/**
 * How many tasks are still worth the reader's attention.
 *
 * This is the notification badge's number: uploads that have not settled, plus extractions
 * the Host is still queued on or running. Settled work is deliberately excluded -- a badge
 * that still shows a count after everything finished trains the reader to ignore it, and
 * the reason to open the panel is then gone.
 *
 * `unsupported` is settled too: no extractor exists for that format, so waiting on it
 * would leave the badge lit forever.
 * @param uploads - the current upload batch.
 * @param extractions - the extraction tasks the Host reports.
 * @returns The number of tasks still in flight.
 */
export function pendingCount(
  uploads: readonly { state: string; at?: string }[],
  extractions: readonly { state: string }[],
): number {
  // `waiting` and `uploading` are both pending; a file the reader just dropped counts
  // immediately, which is what makes the badge appear as soon as the drop happens.
  const uploading = uploads.filter(task => task.state === 'waiting' || task.state === 'uploading').length
  const extracting = extractions.filter(task => task.state === 'pending' || task.state === 'running').length
  // 上传刚完成的一小段时间里继续算 pending：服务端随后才会创建提取任务，如果 badge
  // 立刻归零，轮询就会停，卡片会永远停在「上传完成」而不是进入「提取中」。
  const now = Date.now()
  const awaitingExtraction = uploads.filter(task => {
    if (task.state !== 'done' || task.at === undefined) return false
    const at = Date.parse(task.at)
    return Number.isFinite(at) && now - at < UPLOAD_EXTRACTION_GRACE_MS
  }).length
  return uploading + extracting + awaitingExtraction
}

/** 上传完成后继续轮询提取任务的窗口。 */
export const UPLOAD_EXTRACTION_GRACE_MS = 30_000

/**
 * How long an optimistic extraction entry may wait for the Host to confirm it.
 *
 * A request can fail in ways the browser never reports (a dropped connection, a proxy that
 * swallows the body), so an entry added on click must expire on its own. Thirty seconds is
 * longer than a healthy `extract.status` round trip and short enough that a reader is not
 * left staring at a task that will never exist.
 */
export const OPTIMISTIC_TTL_MS = 30_000

/**
 * One row the reader asked for that the Host has not reported back yet.
 *
 * Kept separate from `ExtractionTaskView` on purpose: a server task has an authoritative
 * state, and this has only a request that was sent. Merging them would let a guess outlive
 * the truth.
 */
export interface OptimisticExtraction {
  /** The document the reader asked to extract. */
  relPath: string
  /** When the request was issued, in milliseconds. */
  requestedAt: number
}

/**
 * Whether an optimistic entry is still waiting for the Host to mention it.
 * @param entry - the pending request.
 * @param now - the current time in milliseconds.
 * @returns Whether it is still within its lifetime.
 */
export function optimisticAlive(entry: OptimisticExtraction, now: number): boolean {
  return now - entry.requestedAt < OPTIMISTIC_TTL_MS
}

/**
 * The entries the panel should still show as "queued".
 *
 * An entry is dropped for either of two reasons, and the distinction matters to the reader:
 *
 * - the Host has reported that document, so the authoritative row replaces the guess;
 * - it has been waiting longer than {@link OPTIMISTIC_TTL_MS}, so the task was never
 *   created and the panel has to stop claiming otherwise.
 * @param pending - the optimistic entries.
 * @param reported - the paths the Host currently reports.
 * @param now - the current time in milliseconds.
 * @returns The entries still worth showing.
 */
export function survivingOptimistic(
  pending: readonly OptimisticExtraction[],
  reported: readonly { relPath: string }[],
  now: number,
): OptimisticExtraction[] {
  const known = new Set(reported.map(task => task.relPath))
  // The host reports the AUTHORITATIVE path while the click named the VIEW path
  // (`global/…` vs the actual top-level folder). Match the basename too, otherwise the
  // optimistic row survives its own result and the card shows both forever.
  const knownNames = new Set(reported.map(task => task.relPath.slice(task.relPath.lastIndexOf('/') + 1)))
  const basename = (value: string): string => value.slice(value.lastIndexOf('/') + 1)
  return pending.filter(entry => !known.has(entry.relPath) && !knownNames.has(basename(entry.relPath)) && optimisticAlive(entry, now))
}

/**
 * The rows the panel draws, with optimistic entries folded in.
 *
 * A path the Host reports ALWAYS wins: the guess exists only to cover the gap before the
 * first `extract.status` answer, and showing both would read as two tasks.
 * @param reported - what the Host reports, in its own order.
 * @param pending - the optimistic entries, oldest first.
 * @param now - the current time in milliseconds.
 * @returns One row per document, plus the rows only the guest knows about.
 */
export function mergeOptimistic<T extends { relPath: string }>(
  reported: readonly T[],
  pending: readonly OptimisticExtraction[],
  now: number,
): { rows: T[]; queued: OptimisticExtraction[] } {
  return { rows: [...reported], queued: survivingOptimistic(pending, reported, now) }
}

/**
 * Turn a failed extraction request into a sentence a reader can act on.
 *
 * The menu's entry used to discard the response entirely, which is why a failed click
 * looked identical to a successful one. Each status here means something different about
 * what to do next, so they are not collapsed into "failed".
 * @param status - the HTTP status, or 0 when the request never completed.
 * @param body - the parsed body, when it was JSON.
 * @returns A reason for the reader.
 */
export function extractionFailureReason(
  status: number,
  body: { error?: unknown; message?: unknown } | undefined,
): string {
  const fromBody = typeof body?.error === 'string' && body.error !== ''
    ? body.error
    : typeof body?.message === 'string' && body.message !== '' ? body.message : undefined
  if (fromBody !== undefined) return fromBody
  if (status === 0) return 'the request did not reach the server'
  if (status === 403) return 'write access is required to extract here'
  if (status === 404) return 'the document no longer exists'
  if (status === 409) return 'the knowledge base is not configured'
  if (status === 400) return 'the document could not be read'
  return 'the extraction request failed (HTTP ' + String(status) + ')'
}

/** A failed extraction the panel knows about even when the Host has no task for it. */
export interface FailedExtractionView {
  /** Knowledge-relative path of the SOURCE document, as the request named it. */
  relPath: string
  /** The raw reason, exactly as the Host or the transport reported it. */
  reason: string
  /** When the failure was observed, in milliseconds. */
  at: number
}

/** Why an extraction produced nothing, as far as the reader is concerned. */
export type ExtractionFailureKind =
  /** The source document is no longer at the path the tree showed. */
  | 'missing-file'
  /** Anything else: keep the Host's own wording. */
  | 'other'

/**
 * Classify one raw extraction failure.
 *
 * The Host answers `no such file` when the authoritative path it was given has no file.
 * That string is the server's own words, not a sentence a reader can act on, so it is
 * the one case with a dedicated translation; every other reason is shown verbatim
 * because inventing a friendlier sentence for an unknown failure would hide the detail
 * the operator needs.
 * @param reason - the raw reason from the Host or transport.
 * @returns The kind the UI maps to localized copy.
 */
export function classifyExtractionFailure(reason: string): ExtractionFailureKind {
  const normalized = reason.toLowerCase()
  if (normalized.includes('no such file') || normalized.includes('enoent')) return 'missing-file'
  return 'other'
}

/**
 * The client-side failure rows the panel should draw.
 *
 * A path the Host already reports always wins: after a retry the Host's own task is the
 * authority, and showing both would read as two failures for one document. The same rule
 * applies to a queued guess -- the click is newer than the recorded failure.
 * @param reported - the tasks the Host reports.
 * @param failures - the session's recorded request failures.
 * @param queued - optimistic entries still waiting for the Host.
 * @returns One row per document that only the client knows failed.
 */
export function survivingClientFailures<T extends { relPath: string }>(
  reported: readonly T[],
  failures: readonly FailedExtractionView[],
  queued: readonly { relPath: string }[],
): FailedExtractionView[] {
  const known = new Set<string>([
    ...reported.map(task => task.relPath),
    ...queued.map(entry => entry.relPath),
  ])
  return failures.filter(failure => !known.has(failure.relPath))
}
