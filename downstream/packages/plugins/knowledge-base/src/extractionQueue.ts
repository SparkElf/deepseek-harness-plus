/**
 * Background extraction of a document's Markdown sibling.
 *
 * Upload and extraction are two different promises. The bytes are the uploader's
 * deliverable and must be visible the moment the write lands; the `.md` sibling is
 * derived text that may take a minute (a scanned PDF goes through MinerU, a legacy
 * `.doc` through LibreOffice). Doing both inside the upload request made a slow
 * parse look like a slow upload -- and a failed parse look like a failed upload.
 *
 * This queue separates them. `enqueue` never blocks and never throws: a failed
 * extraction is a status, not an upload error. The queue lives in this process only
 * (see {@link MAX_FINISHED_TASKS}) because the file itself is already durable; a
 * restart loses the bookkeeping, and the manual `extract.retry` route is the recovery
 * path. Persisting a queue would add a second source of truth about files that the
 * filesystem already answers for.
 *
 * @module @sparkelf/dsh-knowledge-base/extractionQueue
 */

/** Lifecycle of one extraction task. */
export type ExtractionState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unsupported'
  /**
   * The document is already Markdown, so no extraction was needed.
   *
   * Distinct from `succeeded` (a sibling WAS written) and from `unsupported` (no reader
   * exists for the format). Reporting a `.md` file as `unsupported` told a reader their own
   * Markdown was unreadable, which is both wrong and alarming.
   */
  | 'already-markdown'

/** The visible stage after the parser accepted a document. */
export type ExtractionStep = 'parse' | 'chunk' | 'index' | 'done'

/** One extraction task, as a reader observes it. */
export interface ExtractionTask {
  /** Knowledge-relative path of the SOURCE document. */
  relPath: string
  /** Where the task is in its lifecycle. */
  state: ExtractionState
  /** Current Agentic RAG stage: parse → chunk → index → done. */
  step?: ExtractionStep
  /** When the task was accepted, ISO-8601. */
  queuedAt: string
  /** When the run started, ISO-8601. */
  startedAt?: string
  /** When the run reached a terminal state, ISO-8601. */
  finishedAt?: string
  /** The Markdown sibling that was written, when one was. */
  markdown?: string
  /** Which authority produced the text (`mineru`, `libreoffice`, `python`, `native`). */
  via?: string
  /** Why the extraction produced nothing, verbatim from the extractor. */
  reason?: string
}

/** What one run reports back to the queue. */
export interface ExtractionOutcome {
  /** Terminal state for this run. */
  state: Exclude<ExtractionState, 'pending' | 'running'>
  /** The written sibling, when the run produced one. */
  markdown?: string
  /** The authority that produced the text. */
  via?: string
  /** Why nothing was produced. */
  reason?: string
}

/**
 * How many extractions may run at once.
 *
 * One, deliberately. Every authority this drives is expensive in a way a second
 * concurrent run makes worse: LibreOffice spawns a headless process per conversion and
 * MinerU parses on the same small box the workspace already shares. Serializing also
 * makes the observable order the submission order, which is what a reader retrying one
 * file expects.
 */
export const MAX_CONCURRENT_EXTRACTIONS = 1

/**
 * Most finished tasks remembered for status reads.
 *
 * The map is bookkeeping, not storage: an evicted entry loses only its status line,
 * never a file. Bounded so a long-lived process does not accumulate one record per
 * upload it ever saw. Running and pending tasks are never evicted.
 */
export const MAX_FINISHED_TASKS = 200

/** A queued unit of work: the source path and the address to parse with. */
interface QueuedExtraction {
  /** Knowledge-relative path of the source document. */
  relPath: string
  /** Caller's own MinerU base URL, when their settings name one. */
  mineruBaseUrl?: string
}

/** What the queue needs from the surrounding plugin, injected so it stays testable. */
export interface ExtractionQueueOptions {
  /**
   * Run one extraction.
   *
   * Supplied by the plugin so this module owns scheduling only, not the extraction
   * itself: the caller keeps the permission-checked `extractBeside` path in one place.
   * @param relPath - the source document.
   * @param mineruBaseUrl - the caller's own parser address, when set.
   * @returns the terminal state of the run.
   */
  run: (
    relPath: string,
    mineruBaseUrl: string | undefined,
    reportStep?: (step: ExtractionStep) => void,
  ) => Promise<ExtractionOutcome>
  /**
   * Whether this path can be extracted at all.
   *
   * Asked before queueing so an unsupported file answers immediately rather than
   * occupying the single worker slot to discover it has no reader.
   */
  isExtractable: (relPath: string) => boolean
  /**
   * Whether this path is already Markdown, so no extraction is needed.
   *
   * Separate from `isExtractable` because the two answer different questions: `false`
   * from `isExtractable` means "no reader exists" (a failure), while `true` here means
   * "there is nothing to read" (a success). Collapsing them is what reported a reader's
   * own `.md` file as an unreadable format.
   */
  isAlreadyMarkdown: (relPath: string) => boolean
}

/** One extraction queue. One instance per plugin registration. */
export interface ExtractionQueue {
  /**
   * Accept a source document for background extraction.
   *
   * Never throws and never waits: the upload that calls this has already written its
   * bytes, and nothing about a parse may change that answer. A repeat for the same
   * path while one is still pending or running returns the existing task instead of
   * queueing a second run.
   * @param relPath - the source document, relative to the knowledge root.
   * @param mineruBaseUrl - the caller's own parser address, when set.
   * @returns the task as it stands right after the call.
   */
  enqueue: (relPath: string, mineruBaseUrl?: string) => ExtractionTask
  /**
   * Read one task.
   * @param relPath - the source document.
   * @returns the task, or undefined when this process never saw it.
   */
  get: (relPath: string) => ExtractionTask | undefined
  /**
   * Snapshot the queue for a status surface.
   * @returns every remembered task plus what is running.
   */
  snapshot: () => { running: string | undefined; size: number; tasks: ExtractionTask[] }
  /**
   * Wait for one path's task to reach a terminal state.
   *
   * The manual-retry route waits on its own document, and it must wait on the TASK
   * rather than on `drain()`. Two reasons, both about there being one truth:
   *
   * 1. `drain()` also waits for unrelated uploads queued ahead, so a retry would
   *    report a delay that has nothing to do with this file.
   * 2. The retry must NOT run its own extraction and then enqueue a second copy to
   *    keep the status surface current. That is two runs of one document, and an
   *    answer built from one run while `extract.status` reports the other -- the
   *    exact split this method exists to remove.
   *
   * Resolves with the terminal task, or immediately with `undefined` when this
   * process never queued that path (a restart, or a path it has not seen). Never
   * rejects: the caller is a route, and the queue is not allowed to become an error
   * path for an upload.
   * @param relPath - the source document.
   * @returns the terminal task, or undefined when the path was never queued.
   */
  settled: (relPath: string) => Promise<ExtractionTask | undefined>
  /**
   * Wait for the queue to go idle.
   *
   * For tests and for a caller that asked to wait on one specific run; a reader never
   * needs it. Resolves when nothing is pending or running.
   * @returns when the worker has drained.
   */
  drain: () => Promise<void>
}

/**
 * Create an extraction queue.
 *
 * @param options - the runner and the predicate that decides whether a path has a reader.
 * @returns a queue that runs at most {@link MAX_CONCURRENT_EXTRACTIONS} task at a time.
 */
export function createExtractionQueue(options: ExtractionQueueOptions): ExtractionQueue {
  /** Tasks by source path, in submission order. */
  const tasks = new Map<string, ExtractionTask>()
  /** Work waiting for the single worker slot. */
  const waiting: QueuedExtraction[] = []
  /** Resolvers waiting for the queue to drain. */
  let idleWaiters: Array<() => void> = []
  /**
   * Resolvers waiting for ONE path's task to become terminal, keyed by that path.
   *
   * Per-task rather than a single queue-wide signal: a retry must not be woken by an
   * unrelated upload finishing, and a caller that registered a waiter must receive the
   * terminal state of its own task even if the bound evicts the record afterwards.
   */
  const taskWaiters = new Map<string, Array<(task: ExtractionTask) => void>>()
  let running: string | undefined
  let started = false

  /** Forget the oldest finished task once the bound is exceeded. */
  function evictFinished(): void {
    if (tasks.size <= MAX_FINISHED_TASKS) return
    for (const [relPath, task] of tasks) {
      if (task.state === 'pending' || task.state === 'running') continue
      tasks.delete(relPath)
      if (tasks.size <= MAX_FINISHED_TASKS) return
    }
  }

  /** Resolve everyone waiting on an idle queue. */
  function settleIdle(): void {
    if (running !== undefined || waiting.length > 0) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  /** Run one task, recording its terminal state. */
  async function runOne(item: QueuedExtraction): Promise<void> {
    const task = tasks.get(item.relPath)
    if (task === undefined) return
    const startedAt = new Date().toISOString()
    task.state = 'running'
    task.step = 'parse'
    task.startedAt = startedAt
    running = item.relPath
    try {
      const outcome = await options.run(item.relPath, item.mineruBaseUrl, step => { task.step = step })
      task.state = outcome.state
      if (outcome.state === 'succeeded' || outcome.state === 'already-markdown') task.step = 'done'
      if (outcome.markdown !== undefined) task.markdown = outcome.markdown
      if (outcome.via !== undefined) task.via = outcome.via
      if (outcome.reason !== undefined) task.reason = outcome.reason
    } catch (error) {
      // A thrown run is a failed extraction, never a failed upload: the caller let
      // this go on purpose. The message is kept because "why" is the whole value of
      // a status surface when nothing appears beside the document.
      task.state = 'failed'
      // A blank reason renders as "失败：" with nothing after the colon, which tells the
      // reader less than no message at all -- they cannot tell whether to retry. Every
      // failure therefore carries text, falling back to the error's own name and then to a
      // literal, so the field is never empty.
      const message = error instanceof Error ? error.message.trim() : String(error).trim()
      task.reason = message !== '' ? message
        : error instanceof Error && error.name !== 'Error' ? error.name
          : 'the extractor failed without reporting a reason'
    } finally {
      task.finishedAt = new Date().toISOString()
      running = undefined
      // Released BEFORE eviction: a waiter that was promised a terminal state must
      // receive it even when the record is about to be dropped. The snapshot is taken
      // first so the caller holds its own copy and cannot observe a later mutation.
      const waiters = taskWaiters.get(item.relPath)
      if (waiters !== undefined) {
        taskWaiters.delete(item.relPath)
        const terminal = { ...task }
        for (const resolve of waiters) resolve(terminal)
      }
      evictFinished()
    }
  }

  /** Pull work until the queue is empty, then let idle waiters go. */
  async function work(): Promise<void> {
    if (started) return
    started = true
    try {
      while (waiting.length > 0) {
        const item = waiting.shift()
        if (item === undefined) break
        // A task removed between queueing and running (eviction, or a duplicate that
        // was superseded) has nothing left to do.
        if (!tasks.has(item.relPath)) continue
        await runOne(item)
      }
    } finally {
      started = false
      running = undefined
      settleIdle()
    }
  }

  return {
    enqueue(relPath, mineruBaseUrl) {
      const existing = tasks.get(relPath)
      // A duplicate while the first is still in flight joins it: a reader pressing
      // "extract" twice must not spend two parses on one document.
      if (existing !== undefined && (existing.state === 'pending' || existing.state === 'running')) {
        return { ...existing }
      }
      // A Markdown document is already the extraction's own output, so it resolves at
      // `already-markdown` without occupying the worker. Checked before the
      // "unsupported" branch: `.md` is not in the extractable list, so it used to be
      // reported as an unreadable format.
      const alreadyMarkdown = options.isAlreadyMarkdown(relPath)
      const task: ExtractionTask = {
        relPath,
        state: alreadyMarkdown ? 'already-markdown'
          : options.isExtractable(relPath) ? 'pending'
            : 'unsupported',
        queuedAt: new Date().toISOString(),
      }
      if (task.state === 'pending') {
        waiting.push({ relPath, ...(mineruBaseUrl === undefined ? {} : { mineruBaseUrl }) })
      } else {
        // Nothing to schedule, so answering now is both faster and honest, and it keeps
        // the single worker free for real work.
        if (!alreadyMarkdown) task.reason = 'this file type has no extractor'
        task.finishedAt = task.queuedAt
      }
      tasks.set(relPath, task)
      evictFinished()
      // Started on a microtask rather than inline: `enqueue` must return the task as
      // ACCEPTED (pending), because the upload that calls it reports this value and a
      // reader is owed "queued", not "already running". Starting inline would advance
      // the state to `running` before the caller could read its own acceptance.
      if (task.state === 'pending') void Promise.resolve().then(() => work())
      return { ...task }
    },
    get(relPath) {
      const task = tasks.get(relPath)
      return task === undefined ? undefined : { ...task }
    },
    snapshot() {
      const visible: ExtractionTask[] = []
      for (const task of tasks.values()) visible.push({ ...task })
      return {
        running,
        size: waiting.length + (running === undefined ? 0 : 1),
        tasks: visible,
      }
    },
    settled(relPath) {
      const task = tasks.get(relPath)
      // Never queued by this process -- a restart, or a path it has not seen. Resolving
      // `undefined` rather than inventing a task is deliberate: a fabricated "pending"
      // here would be the phantom state `extract.status` exists to avoid.
      if (task === undefined) return Promise.resolve(undefined)
      // Already terminal: answer at once. Every caller that awaits this is asking
      // "what happened", not "please start something".
      if (task.state !== 'pending' && task.state !== 'running') {
        return Promise.resolve({ ...task })
      }
      return new Promise<ExtractionTask | undefined>(resolve => {
        const pending = taskWaiters.get(relPath) ?? []
        pending.push(value => resolve(value))
        taskWaiters.set(relPath, pending)
      })
    },
    drain() {
      if (running === undefined && waiting.length === 0) return Promise.resolve()
      return new Promise<void>(resolve => { idleWaiters.push(resolve) })
    },
  }
}
