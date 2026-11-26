/**
 * First-run initialisation of the authoritative knowledge tree.
 *
 * A deployment that has never been used has no `global/`, `department/` or
 * `personal/` directory, and the reader finds a knowledge base that can hold
 * nothing. The buckets were previously created only as a side effect of some write
 * happening to need their parent, so a fresh share, or one whose buckets were
 * removed, stayed empty with no way to recover.
 *
 * Two rules shape everything here:
 *
 * 1. **Every run re-checks the directories.** A bucket someone deleted by hand must
 *    come back on the next start, so "did this already run" is the wrong question
 *    for them; the answer is recomputed from the filesystem each time and costs three
 *    `mkdir` calls.
 * 2. **The tutorial is written once, ever.** It is an ordinary document that the
 *    reader may edit, and an edit is worth more than a newer built-in version, so a
 *    second write is refused and the refusal is the success case.
 *
 * @module @sparkelf/dsh-knowledge-base
 */

/** Buckets that must exist before the knowledge base can hold anything. */
export const KNOWLEDGE_BUCKETS = ['global', 'department', 'personal'] as const

/**
 * File name of the bundled tutorial, both as shipped and as published.
 *
 * One constant for both so a rename cannot leave the writer looking for a file the
 * package no longer ships, or publishing under a name the template is not stored at.
 */
export const TUTORIAL_FILE_NAME = '万相AI使用教程.html'

/** Where the bundled tutorial is published inside the authoritative tree. */
export const TUTORIAL_REL_PATH = 'global/' + TUTORIAL_FILE_NAME

/** What one bucket did on this run. */
export type BucketOutcome = 'created' | 'exists' | 'failed'

/** What the tutorial did on this run. */
export type TutorialOutcome = 'written' | 'skipped' | 'failed'

/** The result of one initialisation attempt, per item. */
export interface InitReport {
  /** One entry per bucket, in the order they are checked. */
  buckets: { bucket: string; outcome: BucketOutcome }[]
  /** What happened to the tutorial document. */
  tutorial: TutorialOutcome
  /** Set when the run could not even reach the tree (a missing mount, a bad root). */
  error?: string
}

/** The write and read surface, injected so the rules can be tested without a NAS. */
export interface InitIo {
  /**
   * Whether the storage the root lives in is attached.
   *
   * Provisioning CREATES the root and its buckets, so it cannot require the root to
   * exist; what it does require is the thing the root lives in. On a real deployment
   * that is the mounted share, whose absence means provisioning would manufacture a
   * directory where a mount belongs -- and the next mount would then refuse it as
   * non-empty. Answering false leaves the tree untouched and the run unsuccessful, so
   * the next page load retries once the share appears.
   */
  isStorageReady: () => Promise<boolean>
  /** Create a directory under the authoritative root; throws `exists` when taken. */
  createDirectory: (relPath: string) => Promise<void>
  /** Create a document with exclusive semantics; throws `exists` when taken. */
  createDocument: (relPath: string, content: string) => Promise<void>
  /** The tutorial body to publish. */
  tutorialHtml: () => string
  /** Personal mode: create only the root, with no buckets or tutorial. */
  ensureRoot?: () => Promise<void>
}

/** One line of the run log; the caller decides where it goes. */
export interface InitLogLine {
  /** `bucket` or `tutorial`. */
  item: string
  /** The outcome word reported for this item. */
  outcome: BucketOutcome | TutorialOutcome
}

/** The initialiser, as the plugin holds it. */
export interface Initializer {
  /**
   * Make sure the tree is usable, at most one run in flight.
   *
   * Concurrent callers share one run rather than queueing: the work is idempotent, so
   * a second run would only repeat the first one's `mkdir` calls and race it on the
   * tutorial write. A caller arriving while a run is in flight awaits that run's
   * result.
   * @returns The report of the run this caller observed.
   */
  ensure: () => Promise<InitReport>
  /** Whether any run has completed without a fatal error, for the status route. */
  hasSucceeded: () => boolean
}

/**
 * Whether a refused write means "it is already there", which is success here.
 * @param error - the thrown value.
 * @returns true when the item already existed.
 */
function isAlreadyThere(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'exists'
}

/**
 * Build the initialiser.
 *
 * The IO is injected rather than imported so the four rules this exists to enforce --
 * idempotent buckets, self-healing, write-once tutorial, single concurrent run -- can
 * be exercised against a fake tree that can be inspected and mutated between runs.
 * @param io - the write surface and the tutorial body.
 * @param log - sink for the per-item report lines.
 * @returns the initialiser the plugin stores.
 */
export function createInitializer(
  io: InitIo,
  log: (line: InitLogLine) => void,
  options: { personal?: boolean } = {},
): Initializer {
  /** The run in flight, if any. Shared so concurrent callers cannot start a second. */
  let inFlight: Promise<InitReport> | undefined
  /** Set once a run has finished having reached and repaired the tree. */
  let succeeded = false

  /**
   * The run itself.
   *
   * Never throws: a failure is reported in the returned value and in the log. Provisioning
   * runs from `apply()` and from the status route, and neither may fail because a share is
   * not mounted yet -- an unmounted NAS must leave the plugin registered, then heal on the
   * next attempt.
   * @returns the per-item report.
   */
  async function run(): Promise<InitReport> {
    const buckets: InitReport['buckets'] = []
    let tutorial: TutorialOutcome = 'failed'
    let fatal: string | undefined

    if (options.personal === true) {
      // A personal KB is an empty root, not the team tree. No global/department/
      // personal buckets and no tutorial: the reader's first document creates its
      // own folders.
      try {
        if (!(await io.isStorageReady())) {
          return { buckets, tutorial: 'skipped', error: 'storage is not ready' }
        }
        if (io.ensureRoot === undefined) {
          return { buckets, tutorial: 'skipped', error: 'personal initializer has no root creator' }
        }
        await io.ensureRoot()
        succeeded = true
        return { buckets, tutorial: 'skipped' }
      } catch (error: unknown) {
        return { buckets, tutorial: 'skipped', error: error instanceof Error ? error.message : String(error) }
      }
    }

    for (const bucket of KNOWLEDGE_BUCKETS) {
      let outcome: BucketOutcome
      try {
        await io.createDirectory(bucket)
        outcome = 'created'
      } catch (error: unknown) {
        outcome = isAlreadyThere(error) ? 'exists' : 'failed'
        // The first bucket failing means the root is unreachable, which is a different
        // report from one bucket being refused: the tutorial cannot be written either.
        if (outcome === 'failed') fatal ??= error instanceof Error ? error.message : String(error)
      }
      buckets.push({ bucket, outcome })
      log({ item: 'bucket:' + bucket, outcome })
    }

    // The tutorial is skipped when the tree itself is unreachable: a write into a root
    // that could not even take a directory would only produce a second, less specific
    // failure on top of the one already reported.
    if (fatal === undefined) {
      try {
        await io.createDocument(TUTORIAL_REL_PATH, io.tutorialHtml())
        tutorial = 'written'
      } catch (error: unknown) {
        // An existing file is the success case, not a failure: the reader may have edited
        // it, and their version outranks the built-in one.
        tutorial = isAlreadyThere(error) ? 'skipped' : 'failed'
        if (tutorial === 'failed') fatal = error instanceof Error ? error.message : String(error)
      }
      log({ item: 'tutorial', outcome: tutorial })
    }

    // Only a run that reached the tree and created or found every bucket counts as
    // success. A partially created tree must be retried on the next start.
    if (fatal === undefined && buckets.every(entry => entry.outcome !== 'failed')) {
      succeeded = true
    }

    return { buckets, tutorial, ...(fatal === undefined ? {} : { error: fatal }) }
  }

  return {
    ensure: async (): Promise<InitReport> => {
      // Reuse the in-flight run rather than starting a second: the tutorial write is
      // exclusive, so a duplicate would report `exists` and hide which run wrote it.
      if (inFlight !== undefined) return await inFlight
      const started = run()
      inFlight = started
      try {
        return await started
      } finally {
        // Cleared in `finally` so a caller that arrives after a failure starts a fresh
        // attempt instead of awaiting a settled promise forever.
        inFlight = undefined
      }
    },
    hasSucceeded: () => succeeded,
  }
}
