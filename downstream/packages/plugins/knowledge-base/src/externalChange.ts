/**
 * Filesystem watcher for changes made OUTSIDE the knowledge-base write routes.
 *
 * The plugin cannot stop a shell command: the workspace has normal filesystem access
 * and the authoritative tree lives on a mounted share. What it CAN do is make the
 * change visible in the audit trail. This module owns that observation, plus the
 * suppression map that keeps the plugin's own writes (which already have an audit
 * entry) from being reported a second time.
 *
 * Boundaries, deliberately:
 * - observation only; no blocking, no rollback, no attribution to a real user;
 * - `fs.watch` on the authoritative root, so view hardlinks rebuilt by a sync do not
 *   trigger it;
 * - NFS/SSHFS may not deliver events, and time while the process is down is missed.
 */
import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

const MARK_TTL_MS = 3_000
const MARKS_MAX = 5_000
const DEFAULT_DEBOUNCE_MS = 500
const DEFAULT_RETRY_MS = 30_000

/** Paths this process just wrote, with the instant after which they stop being ours. */
const internalMutations = new Map<string, number>()

const normalize = (value: string): string => value
  .replaceAll('\\', '/')
  .replace(/^\.\/+/u, '')
  .replace(/^\/+/u, '')

const pruneMarks = (now: number): void => {
  for (const [relPath, until] of internalMutations) {
    if (until <= now) internalMutations.delete(relPath)
  }
  while (internalMutations.size > MARKS_MAX) {
    const oldest = internalMutations.keys().next()
    if (oldest.done) break
    internalMutations.delete(oldest.value)
  }
}

/** Record a path this process is about to write, so the watcher can ignore its event. */
export const markInternalMutation = (relPath: string): void => {
  const normalized = normalize(relPath)
  if (normalized === '') return
  const now = Date.now()
  internalMutations.set(normalized, now + MARK_TTL_MS)
  pruneMarks(now)
}

/** Whether an event belongs to a write this process already audited. */
export const isInternalMutation = (relPath: string, now = Date.now()): boolean => {
  const normalized = normalize(relPath)
  const until = internalMutations.get(normalized)
  if (until === undefined) return false
  if (until <= now) {
    internalMutations.delete(normalized)
    return false
  }
  return true
}

/** Clear the suppression map between tests. */
export const resetInternalMutationsForTests = (): void => {
  internalMutations.clear()
}

export type ExternalChangeDetail = 'updated' | 'renamed' | 'deleted'

export interface ExternalChangeWatcherOptions {
  /** The authoritative tree, not the per-user view. */
  actualRoot: string
  /** Called once per debounced path. May be async; rejections are logged, not thrown. */
  onChange: (relPath: string, detail: ExternalChangeDetail) => void | Promise<void>
  /** Optional warning sink; defaults to silent. */
  log?: (message: string) => void
  debounceMs?: number
  retryMs?: number
}

const isPlausibleRelPath = (relPath: string): boolean => {
  if (relPath === '' || relPath.includes('\0')) return false
  if (relPath.startsWith('/') || /^[A-Za-z]:\//u.test(relPath)) return false
  return relPath.split('/').every(segment => (
    segment !== '' && segment !== '.' && segment !== '..' && !segment.startsWith('.')
  ))
}

/**
 * Start observing the authoritative tree.
 *
 * Returns a disposer. The watcher retries when the root does not exist yet (the
 * plugin can load before a workspace provisions its tree) and is closed on dispose.
 * `persistent: false` keeps the watcher from holding the process alive on its own.
 */
export const startExternalChangeWatcher = (
  options: ExternalChangeWatcherOptions,
): (() => void) => {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  const pending = new Map<string, NodeJS.Timeout>()
  let watcher: FSWatcher | undefined
  let retry: NodeJS.Timeout | undefined
  let closed = false

  const report = async (relPath: string, eventType: 'rename' | 'change'): Promise<void> => {
    if (closed || isInternalMutation(relPath)) return
    let detail: ExternalChangeDetail = eventType === 'change' ? 'updated' : 'renamed'
    try {
      await stat(join(options.actualRoot, relPath))
    } catch {
      detail = 'deleted'
    }
    try {
      await options.onChange(relPath, detail)
    } catch (error) {
      options.log?.(
        `external change audit failed for ${relPath}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const schedule = (eventType: 'rename' | 'change', filename: string | Buffer | null): void => {
    if (closed || filename === null) return
    const relPath = normalize(String(filename))
    if (!isPlausibleRelPath(relPath)) return
    const existing = pending.get(relPath)
    if (existing !== undefined) clearTimeout(existing)
    pending.set(relPath, setTimeout(() => {
      pending.delete(relPath)
      void report(relPath, eventType)
    }, debounceMs))
  }

  const arm = (): void => {
    if (closed) return
    try {
      watcher = watch(
        options.actualRoot,
        { recursive: true, persistent: false },
        (eventType, filename) => schedule(eventType, filename),
      )
      watcher.on('error', (error) => {
        options.log?.(`external change watcher error: ${error.message}`)
        watcher?.close()
        watcher = undefined
        if (!closed) retry = setTimeout(arm, retryMs)
      })
    } catch (error) {
      options.log?.(
        `external change watcher unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
      if (!closed) retry = setTimeout(arm, retryMs)
    }
  }

  arm()

  return () => {
    closed = true
    if (retry !== undefined) clearTimeout(retry)
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
    watcher?.close()
  }
}
