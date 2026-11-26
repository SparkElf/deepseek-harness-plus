/**
 * The list/grid preference the rail renders.
 *
 * A document-level preference stored beside the pins, for the same reason they are:
 * a reader who switches to the grid on one machine expects it on the next. The
 * optimistic update exists because the toggle is a one-click gesture on a control
 * the reader is looking at, and waiting for a round trip before the layout changes
 * makes it feel broken when it is merely slow. A failed write reloads from the Host
 * rather than leaving the guess on screen.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useState } from 'react'
import { KB_API, kbApiPath, type ViewModeView } from '../api.ts'

/**
 * Which layout the rail is showing.
 *
 * `explorer` renders the product's own file explorer (see `KnowledgeFileTree`), which is
 * the tree a reader already knows from the workspace sidebar. It is a third option rather
 * than a replacement because the two layouts answer different questions: the listing shows
 * knowledge-base state the explorer has no concept of (whether a row is readable, its
 * pinned mark, multi-select for a batch grant), while the explorer brings the affordances a
 * file tree is expected to have (sort, inline rename, drag-and-drop, upload strip).
 */
export type ViewMode = 'list' | 'grid' | 'explorer'

/** What the hook exposes to the rail. */
export interface ViewModeStore {
  /** The stored layout. */
  mode: ViewMode
  /** Switch layouts, writing through to the Host. */
  setMode: (mode: ViewMode) => void
  /** Set when the last write was refused, so the surface can say why. */
  error: string | undefined
}

/**
 * Read and write the caller's layout preference.
 * @param enabled - false while the mount point is unknown, which is the only state
 *   where there is no view directory to hold the preference.
 * @returns The store.
 */
export function useViewMode(enabled: boolean): ViewModeStore {
  const [mode, setLocalMode] = useState<ViewMode>('explorer')
  const [error, setError] = useState<string | undefined>(undefined)

  const read = useCallback(async (): Promise<void> => {
    if (!enabled) return
    try {
      const response = await fetch(kbApiPath(KB_API.viewModeGet), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      const body = (await response.json()) as ViewModeView
      // Only the three layouts this build renders are accepted; anything else falls
      // back to the listing so an unrecognized value leaves the page renderable.
      // This narrowing used to accept just `grid` and turn everything else into
      // `list`, which silently discarded `explorer`: the preference round-tripped
      // correctly through the Host and then never reached the branch that renders
      // the explorer. Measured on the real page -- `.view-mode.json` held
      // {"mode":"explorer"} and the tree still rendered data-view-mode="list".
      setLocalMode(
        body.mode === 'grid' ? 'grid'
          : body.mode === 'explorer' ? 'explorer'
            : 'explorer',
      )
      setError(undefined)
    } catch (failure: unknown) {
      // A failed read leaves the default layout rather than a stale one.
      setLocalMode('explorer')
      setError(failure instanceof Error ? failure.message : undefined)
    }
  }, [enabled])

  useEffect(() => { void read() }, [read])

  const setMode = useCallback((next: ViewMode): void => {
    setLocalMode(next)
    void (async () => {
      try {
        const response = await fetch(kbApiPath(KB_API.viewModeSet), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: next }),
          cache: 'no-store',
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? 'HTTP ' + String(response.status))
        }
        setError(undefined)
      } catch (failure: unknown) {
        setError(failure instanceof Error ? failure.message : undefined)
        await read()
      }
    })()
  }, [read])

  return { mode, setMode, error }
}
