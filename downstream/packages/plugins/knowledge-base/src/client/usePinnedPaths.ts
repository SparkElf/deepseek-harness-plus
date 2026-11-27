/**
 * The pinned-path store the rail renders.
 *
 * Pins are a document-level preference, so they live in the caller's own view
 * directory on the share rather than in browser storage; the Host owns that file
 * and this hook only reads and writes it through the two routes. The optimistic
 * update exists because toggling a pin is a one-click gesture on a menu the reader
 * is looking at: waiting for a round trip before the row moves makes the control
 * feel broken when it is merely slow. A failed write reloads from the Host rather
 * than leaving the guess on screen.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useState } from 'react'
import { KB_API, kbApiPath, type PinnedView } from '../api.ts'

/** What the hook exposes to the rail. */
export interface PinnedStore {
  /** Pinned paths, in the order the Host returned them. */
  relPaths: readonly string[]
  /** Whether one path is pinned. */
  has: (relPath: string) => boolean
  /**
   * Add or remove one path.
   *
   * Idempotent in the direction asked for: pinning an already-pinned path leaves
   * the list alone rather than toggling it off, so a double click cannot silently
   * undo the first one.
   */
  setPinned: (relPath: string, pinned: boolean) => void
  /** Re-read from the Host. */
  refresh: () => void
  /** Set when the last write was refused, so the surface can say why. */
  error: string | undefined
}

/**
 * Read and write the caller's pins.
 * @param enabled - false while the mount point is unknown, which is the only state
 *   where a pin request would name a tree that does not exist yet.
 * @returns The store.
 */
export function usePinnedPaths(enabled: boolean): PinnedStore {
  const [relPaths, setRelPaths] = useState<readonly string[]>([])
  const [error, setError] = useState<string | undefined>(undefined)

  const read = useCallback(async (): Promise<void> => {
    if (!enabled) {
      setRelPaths([])
      return
    }
    try {
      const response = await fetch(kbApiPath(KB_API.pinsGet), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      const body = (await response.json()) as PinnedView
      setRelPaths(body.relPaths ?? [])
      setError(undefined)
    } catch (failure: unknown) {
      // A failed read leaves the list empty rather than stale: pins the Host did
      // not confirm are not shown as if they were stored.
      setRelPaths([])
      setError(failure instanceof Error ? failure.message : undefined)
    }
  }, [enabled])

  useEffect(() => { void read() }, [read])

  const write = useCallback(async (next: readonly string[]): Promise<void> => {
    try {
      const response = await fetch(kbApiPath(KB_API.pinsSet), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPaths: next }),
        cache: 'no-store',
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? 'HTTP ' + String(response.status))
      }
      const body = (await response.json()) as PinnedView
      setRelPaths(body.relPaths ?? [])
      setError(undefined)
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : undefined)
      await read()
    }
  }, [read])

  const has = useCallback((relPath: string): boolean => relPaths.includes(relPath), [relPaths])

  const setPinned = useCallback((relPath: string, pinned: boolean): void => {
    const current = relPaths
    const already = current.includes(relPath)
    // Asked-for state already holds: nothing to write, and no toggle back.
    if (pinned === already) return
    const next = pinned ? [...current, relPath] : current.filter(item => item !== relPath)
    setRelPaths(next)
    void write(next)
  }, [relPaths, write])

  return { relPaths, has, setPinned, refresh: () => { void read() }, error }
}
