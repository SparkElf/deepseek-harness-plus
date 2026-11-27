/**
 * Local persistence for the task queue.
 *
 * Only metadata is stored: a reader who comes back after a reload should still see what
 * they uploaded or extracted, not the document bytes. Records older than the retention
 * window are dropped on load, and the list is capped so a long-lived profile cannot grow
 * without bound.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

/** One task as it is remembered across reloads. */
export interface PersistedTask {
  /** Stable queue id (`upload:<path>` / `extract:<path>`). */
  id: string
  /** Display name of the source document. */
  fileName: string
  /** Which operation the task represents. */
  kind: 'upload' | 'extract'
  /** Last observed lifecycle state. */
  stage: 'uploading' | 'uploaded' | 'extracting' | 'done' | 'failed'
  /** Upload percentage, 0-100, when known. */
  progress?: number
  /** When the task was first seen, epoch milliseconds. */
  startedAt: number
  /** When it reached a terminal state, epoch milliseconds. */
  finishedAt?: number
  /** Failure reason, when the task failed. */
  error?: string
}

/** The localStorage key this plugin owns. */
export const TASK_QUEUE_STORAGE_KEY = 'dataops-kb-task-queue-v1'

/** How long a record is kept. */
export const TASK_QUEUE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Upper bound on records, newest first. */
export const TASK_QUEUE_MAX_RECORDS = 200

const STAGES = new Set<PersistedTask['stage']>(['uploading', 'uploaded', 'extracting', 'done', 'failed'])

/** Keep only records that are shaped like a task and are still inside the retention window. */
function sanitize(value: unknown, now: number): PersistedTask[] {
  if (!Array.isArray(value)) return []
  const records: PersistedTask[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id === '') continue
    if (typeof row.fileName !== 'string' || row.fileName === '') continue
    if (row.kind !== 'upload' && row.kind !== 'extract') continue
    if (typeof row.stage !== 'string' || !STAGES.has(row.stage as PersistedTask['stage'])) continue
    if (typeof row.startedAt !== 'number' || !Number.isFinite(row.startedAt)) continue
    if (now - row.startedAt > TASK_QUEUE_RETENTION_MS) continue
    records.push({
      id: row.id,
      fileName: row.fileName,
      kind: row.kind,
      stage: row.stage as PersistedTask['stage'],
      ...(typeof row.progress === 'number' && Number.isFinite(row.progress) ? { progress: row.progress } : {}),
      startedAt: row.startedAt,
      ...(typeof row.finishedAt === 'number' && Number.isFinite(row.finishedAt) ? { finishedAt: row.finishedAt } : {}),
      ...(typeof row.error === 'string' && row.error !== '' ? { error: row.error } : {}),
    })
  }
  return records
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, TASK_QUEUE_MAX_RECORDS)
}

/**
 * Read the retained queue.
 * @param now - current epoch milliseconds, injectable for tests.
 * @returns Newest-first records inside the retention window.
 */
export function loadTaskQueue(now: number = Date.now()): PersistedTask[] {
  try {
    const raw = window.localStorage.getItem(TASK_QUEUE_STORAGE_KEY)
    if (raw === null || raw === '') return []
    return sanitize(JSON.parse(raw), now)
  } catch {
    // Private mode, a disabled store, or corrupt JSON: run from memory this session.
    return []
  }
}

/**
 * Persist the queue, silently degrading when storage is unavailable.
 * @param records - the records to write, already ordered.
 */
export function saveTaskQueue(records: readonly PersistedTask[]): void {
  try {
    window.localStorage.setItem(TASK_QUEUE_STORAGE_KEY, JSON.stringify(records.slice(0, TASK_QUEUE_MAX_RECORDS)))
  } catch {
    // Quota exceeded or a privacy mode that rejects writes: keep the in-memory state.
  }
}

/**
 * Merge freshly observed rows into the stored history.
 *
 * A new observation wins for the mutable fields (stage/progress/error), while the first
 * `startedAt` and the first terminal `finishedAt` are preserved so a task does not appear
 * to restart on every poll.
 * @param current - stored records.
 * @param incoming - rows observed this render.
 * @param now - current epoch milliseconds.
 * @returns Newest-first merged records, capped.
 */
export function mergeTaskRecords(
  current: readonly PersistedTask[],
  incoming: readonly PersistedTask[],
  now: number = Date.now(),
): PersistedTask[] {
  const byId = new Map(current.map(record => [record.id, record]))
  for (const record of incoming) {
    const previous = byId.get(record.id)
    byId.set(record.id, {
      ...record,
      startedAt: previous?.startedAt ?? record.startedAt,
      ...(previous?.finishedAt !== undefined
        ? { finishedAt: previous.finishedAt }
        : record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    })
  }
  return [...byId.values()]
    .filter(record => now - record.startedAt <= TASK_QUEUE_RETENTION_MS)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, TASK_QUEUE_MAX_RECORDS)
}

/** Remove every stored record. */
export function clearTaskQueue(): void {
  try {
    window.localStorage.removeItem(TASK_QUEUE_STORAGE_KEY)
  } catch {
    // Nothing to do: the in-memory list is cleared by the caller.
  }
}
