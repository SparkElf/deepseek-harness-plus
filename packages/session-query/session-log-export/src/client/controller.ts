/** Browser download state shared by the Session Header button and `/export`. */

import { createSnapshotStore, type SessionId, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Lifecycle status of one session log download. */
export type SessionLogDownloadStatus = 'downloading' | 'success' | 'error'

/** Visible state for one session export request. */
export interface SessionLogDownloadEntry {
  /** Whether the download result notice is visible. */
  readonly open: boolean
  /** Current export request status. */
  readonly status: SessionLogDownloadStatus
  /** User-visible failure detail, or null outside the error state. */
  readonly error: string | null
}

/** Session-keyed export notice state. */
export interface SessionLogDownloadState {
  /** Current export notice for each session with download activity. */
  bySession: Record<string, SessionLogDownloadEntry | undefined>
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type Save = (url: string, filename: string) => void

const INITIAL: SessionLogDownloadState = { bySession: {} }

/** Build the exported ZIP filename for one session.
 * @param sessionId - Session being exported.
 * @returns A filesystem-safe ZIP filename.
 */
export function sessionLogZipFilename(sessionId: SessionId): string {
  return `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.zip`
}

/** Trigger a browser download for one URL.
 * @param url - Export URL to download.
 * @param filename - Suggested browser download filename.
 */
export function downloadUrl(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
}

/** Resolve logical Host routes below the runtime-injected document base. */
function hostBase(): string {
  if (typeof document !== 'undefined') return document.baseURI
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? `${origin}/` : 'http://dsh.internal/'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Coordinates one export request per session and publishes notice state. */
export class SessionLogDownloadController {
  /** Observable export notice state. */
  readonly store: SnapshotStore<SessionLogDownloadState> = createSnapshotStore(INITIAL)

  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()
  private disposed = false

  /** Create a download controller.
   * @param fetcher - HTTP carrier used to retrieve export archives.
   * @param save - Browser download trigger.
   */
  constructor(
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly save: Save = downloadUrl,
  ) {}

  /** Start or join one session export request.
   * @param sessionId - Session whose log and descendants are exported.
   * @returns The active export operation.
   */
  download(sessionId: SessionId): Promise<void> {
    const existing = this.active.get(sessionId)
    if (existing !== undefined) return existing.done
    if (this.disposed) return Promise.resolve()
    const abort = new AbortController()
    const done = this.run(sessionId, abort.signal).finally(() => {
      this.active.delete(sessionId)
    })
    this.active.set(sessionId, { abort, done })
    return done
  }

  /** Hide one session export notice without cancelling its request.
   * @param sessionId - Session notice to hide.
   */
  dismiss(sessionId: SessionId): void {
    const current = this.store.getSnapshot().bySession[String(sessionId)]
    if (current === undefined || !current.open) return
    this.publish(sessionId, { ...current, open: false })
  }

  /** Abort active requests and wait for their settlement.
   * @returns A promise settled after every active request stops.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const active = [...this.active.values()]
    for (const operation of active) operation.abort.abort()
    await Promise.allSettled(active.map(operation => operation.done))
  }

  private async run(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    this.publish(sessionId, { open: true, status: 'downloading', error: null })
    try {
      const url = new URL('api/session.export', hostBase())
      url.searchParams.set('sessionId', sessionId)
      url.searchParams.set('includeDescendants', 'true')
      const response = await this.fetcher(url, { method: 'HEAD', signal })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Export failed: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
      }
      this.save(url.toString(), sessionLogZipFilename(sessionId))
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'success', error: null })
    } catch (error: unknown) {
      if (signal.aborted) return
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'error', error: messageOf(error) })
    }
  }

  private publish(sessionId: SessionId, entry: SessionLogDownloadEntry): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: entry }
    })
  }
}
