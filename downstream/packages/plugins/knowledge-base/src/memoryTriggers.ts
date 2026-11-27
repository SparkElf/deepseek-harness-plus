/**
 * Plugin-level memory triggers: session idle debounce and compaction notices.
 *
 * Both triggers do exactly one thing — deliver a message to the user's guardian
 * session through {@link sendToGuardian}. There is no queue, no task table and
 * no cron:
 *
 * - **idle**: after a session's `turn/end`, one 30-minute timer starts. Any
 *   `turn/start` or `user/message` clears it (the session is active again); a
 *   later `turn/end` starts a fresh timer. When it expires the guardian receives
 *   `reason=idle` with the source session id;
 * - **compaction**: `compaction/start` immediately notifies the guardian with
 *   `reason=compaction` and the compaction id. The listener never awaits the
 *   send, so compaction is not blocked. The same compaction id is sent once.
 *
 * Guardian sessions themselves are ignored, so the guardian cannot wake itself.
 * Detection is injected (`isGuardianSession`) because the durable identity is
 * guardian.json; there is no preset to test.
 *
 * Timers and the event source are injected so the debounce can be tested with a
 * deterministic clock.
 *
 * @module @sparkelf/dsh-knowledge-base/memory-triggers
 */
import { sendToGuardian, type GuardianSessionHost } from './guardianSession.ts'

/** Default idle window: 30 minutes after the last turn ends. */
export const IDLE_DEBOUNCE_MS = 30 * 60 * 1000

/** The session fields a trigger reads. */
export interface MemoryTriggerSession {
  readonly id: string
}

/** One `session/event` payload, structurally narrowed. */
export interface MemoryTriggerEvent {
  readonly type: string
  readonly data?: unknown
}

/** Injectable timer seam. */
export interface MemoryTriggerTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** Host seam implemented by the plugin wiring. */
export interface MemoryTriggerHost {
  /** The owner of the current plugin process (one user per deployment). */
  resolveUserId(): Promise<string>
  /** True when the session id is some user's guardian (guardian.json). */
  isGuardianSession(sessionId: string): Promise<boolean>
  /** Whether memory learning is enabled for the owner; paused skips both triggers. */
  isEnabled?(userId: string): Promise<boolean> | boolean
  /** `ctx.on('session/event', listener)`; returns the unsubscribe function. */
  onSessionEvent(listener: (session: MemoryTriggerSession, event: MemoryTriggerEvent) => void): () => void
  /** The same guardian send path the tool uses. */
  guardian: GuardianSessionHost
  timers?: MemoryTriggerTimers
  /** Override the 30-minute window in tests. */
  idleMs?: number
  log?: (message: string) => void
}

const IDLE_ACTIVITY_EVENTS = new Set(['turn/start', 'turn/end', 'user/message'])

/**
 * Install the idle and compaction triggers.
 *
 * @param host - event source, guardian send path and injected timers.
 * @returns an idempotent disposer that clears every timer and unsubscribes.
 */
export function installMemoryTriggers(host: MemoryTriggerHost): () => void {
  const timers = host.timers ?? defaultTimers()
  const idleMs = host.idleMs ?? IDLE_DEBOUNCE_MS
  const idleTimers = new Map<string, unknown>()
  const sentCompactions = new Set<string>()
  let disposed = false
  let userIdPromise: Promise<string> | undefined

  const log = (message: string): void => {
    try {
      host.log?.(message)
    } catch {
      // A diagnostic sink must never break a trigger.
    }
  }

  const currentUserId = (): Promise<string> => {
    if (userIdPromise === undefined) {
      userIdPromise = host.resolveUserId().catch((error: unknown) => {
        userIdPromise = undefined // allow a later event to retry
        throw error
      })
    }
    return userIdPromise
  }

  const clearIdle = (sessionId: string): void => {
    const handle = idleTimers.get(sessionId)
    if (handle !== undefined) {
      timers.clearTimeout(handle)
      idleTimers.delete(sessionId)
    }
  }

  const resetIdle = (sessionId: string): void => {
    clearIdle(sessionId)
    const handle = timers.setTimeout(() => {
      idleTimers.delete(sessionId)
      void fireIdle(sessionId)
    }, idleMs)
    idleTimers.set(sessionId, handle)
  }

  const fireIdle = async (sessionId: string): Promise<void> => {
    if (disposed) return
    try {
      const userId = await currentUserId()
      if (disposed) return
      if (host.isEnabled !== undefined && !await host.isEnabled(userId)) return
      await sendToGuardian(host.guardian, userId, { reason: 'idle', sessionId })
    } catch (error) {
      log(`idle guardian message failed: ${messageOf(error)}`)
    }
  }

  const fireCompaction = async (sessionId: string, compactionId: string | undefined): Promise<void> => {
    if (disposed) return
    try {
      const userId = await currentUserId()
      if (disposed) return
      if (host.isEnabled !== undefined && !await host.isEnabled(userId)) return
      await sendToGuardian(host.guardian, userId, {
        reason: 'compaction',
        sessionId,
        ...(compactionId === undefined || compactionId === '' ? {} : { compactionId }),
      })
    } catch (error) {
      log(`compaction guardian message failed: ${messageOf(error)}`)
    }
  }

  const handle = (session: MemoryTriggerSession, event: MemoryTriggerEvent): void => {
    if (disposed) return
    const type = event.type
    if (!IDLE_ACTIVITY_EVENTS.has(type) && type !== 'compaction/start') return

    // Resolve the owner while the event still carries the request's caller
    // context. The idle timer fires later from a bare timer, where a remote
    // deployment can no longer ask the backend who the user is; caching the
    // answer now is what makes the idle message deliverable.
    void currentUserId().catch((error: unknown) => log(`owner resolution failed: ${messageOf(error)}`))

    void (async () => {
      if (disposed) return
      let guardian = false
      try {
        guardian = await host.isGuardianSession(session.id)
      } catch (error) {
        // Cannot prove the session is ordinary; fail closed and ignore it
        // rather than risk waking the guardian with its own activity.
        log(`guardian-session check failed for ${session.id}: ${messageOf(error)}`)
        guardian = true
      }
      if (disposed) return
      if (guardian) {
        clearIdle(session.id)
        return
      }

      if (type === 'compaction/start') {
        const compactionId = readString(event.data, 'compactionId')
        // A compaction is activity; do not let an almost-expired idle timer
        // fire during the compaction itself.
        resetIdle(session.id)
        if (compactionId !== undefined) {
          const key = `${session.id}\u0000${compactionId}`
          if (sentCompactions.has(key)) return
          sentCompactions.add(key)
        }
        // Fire-and-forget: the compaction path must never wait for the guardian.
        void fireCompaction(session.id, compactionId)
        return
      }

      if (type === 'turn/end') resetIdle(session.id)
      else clearIdle(session.id)
    })().catch((error: unknown) => log(`memory trigger failed: ${messageOf(error)}`))
  }

  const unsubscribe = host.onSessionEvent(handle)

  return (): void => {
    if (disposed) return
    disposed = true
    for (const handle of idleTimers.values()) {
      try {
        timers.clearTimeout(handle)
      } catch {
        // A timer implementation that already fired may reject its clear; ignore.
      }
    }
    idleTimers.clear()
    sentCompactions.clear()
    try {
      unsubscribe()
    } catch {
      // The event source may already be gone during plugin teardown.
    }
  }
}

function readString(data: unknown, key: string): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const value = (data as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultTimers(): MemoryTriggerTimers {
  return {
    setTimeout(callback, ms) {
      const handle = setTimeout(callback, ms)
      // A pending 30-minute idle timer must not keep the host process alive.
      if (typeof (handle as { unref?: () => void }).unref === 'function') {
        (handle as { unref: () => void }).unref()
      }
      return handle
    },
    clearTimeout(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
  }
}
