/**
 * The favourites store the tree's star column renders.
 *
 * A star is a document-level preference, so it lives beside `.pinned.json` and
 * `.kb-tree-state.json` in the caller's own view directory rather than in browser
 * storage: a reader who stars a report on one machine expects to find it starred on
 * the next, and a browser profile is not the unit a knowledge base follows.
 *
 * The write path is deliberately the same shape as `useTreeState`'s. A reader who
 * stars a few rows in a row makes one gesture per row, and writing through
 * immediately would put a round trip behind each click; saves are therefore
 * coalesced behind one timer, only one is ever on the wire, and the latest state
 * always wins. The optimistic update exists because a star is a one-click
 * affordance on the row the reader is looking at -- waiting for a round trip
 * before it fills in makes the control feel broken when it is merely slow.
 *
 * Keeping this a separate hook rather than extending `useTreeState` is a
 * consequence of the two having different payload shapes and different failure
 * costs: a lost expansion collapses a folder, while a lost star loses the mark the
 * reader was just told had been saved.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { KB_API, kbApiPath, type FavoritesView } from '../api.ts'

/**
 * How long to wait after the last star toggle before writing.
 *
 * Matches the tree-state window: long enough to swallow a reader starring several
 * rows in quick succession, short enough that the state is on disk before a reload
 * the reader is likely to perform.
 */
const SAVE_DEBOUNCE_MS = 400

/** What the hook exposes to the tree. */
export interface FavoritesStore {
  /** Relative paths of the starred rows, as the Host last answered. */
  relPaths: readonly string[]
  /** Whether one path is starred. */
  has: (relPath: string) => boolean
  /**
   * Star or unstar one path.
   *
   * Idempotent in the direction asked for, like `setPinned`: asking for the state
   * that already holds writes nothing, so a double click cannot toggle a star back
   * off by accident.
   */
  setFavorite: (relPath: string, favorite: boolean) => void
  /** Re-read from the Host. */
  refresh: () => void
  /** Set when the last write was refused, so the surface can say why. */
  error: string | undefined
}

/**
 * Read and write the caller's favourites.
 * @param enabled - false while the mount point is unknown, which is the only state
 *   where a favourites request would name a view that does not exist yet.
 * @returns The store; `relPaths` is empty until the first read answers.
 */
export function useFavorites(enabled: boolean): FavoritesStore {
  const [relPaths, setRelPaths] = useState<readonly string[]>([])
  const [error, setError] = useState<string | undefined>(undefined)

  /**
   * The state the next save will send.
   *
   * A ref rather than the state variable because the debounce timer fires outside a
   * render and must read what is current at that moment, not what was current when
   * the timer was armed.
   */
  const pending = useRef<readonly string[]>([])
  /** The coalescing timer, or undefined when no save is armed. */
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** True when a toggle arrived while a save was in flight. */
  const dirty = useRef(false)
  /** True while one save is on the wire, so they are never overlapped. */
  const saving = useRef(false)
  /** Set on unmount so a late response cannot touch a gone component. */
  const gone = useRef(false)
  /**
   * True once the reader has toggled something.
   *
   * The read is a round trip and the reader can click before it lands; without this
   * flag that late answer would overwrite the star they just set with the state the
   * file held before they touched it.
   */
  const touched = useRef(false)
  /** Whether this store has a view to address at all, readable from the timer. */
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const send = useCallback(async (): Promise<void> => {
    if (saving.current) {
      dirty.current = true
      return
    }
    saving.current = true
    dirty.current = false
    try {
      const response = await fetch(kbApiPath(KB_API.favoritesSet), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPaths: pending.current }),
        cache: 'no-store',
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? 'HTTP ' + String(response.status))
      }
      const body = (await response.json()) as FavoritesView
      if (gone.current) return
      // The Host normalises and filters, so its answer -- not the request -- is what
      // the page treats as stored. A reader who toggled again while this was on the
      // wire already has a newer value in `pending`, and adopting this answer then
      // would un-star the row they just clicked.
      if (dirty.current) return
      setRelPaths(body.relPaths ?? [])
      pending.current = body.relPaths ?? []
      setError(undefined)
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : undefined)
      // A failed write reloads from the Host rather than leaving the guess on
      // screen, because a star that says "saved" when it was not is worse than one
      // that visibly reverted.
      void (async () => {
        try {
          const response = await fetch(kbApiPath(KB_API.favoritesGet), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
            cache: 'no-store',
          })
          if (!response.ok) return
          const body = (await response.json()) as FavoritesView
          if (gone.current) return
          setRelPaths(body.relPaths ?? [])
          pending.current = body.relPaths ?? []
        } catch {
          // Still failing: leave the optimistic value; the next toggle retries.
        }
      })()
    } finally {
      saving.current = false
      if (dirty.current && !gone.current) {
        dirty.current = false
        timer.current = setTimeout(() => { timer.current = undefined; void send() }, SAVE_DEBOUNCE_MS)
      }
    }
  }, [])

  /** Arm the coalescing timer, or leave the already-armed one in place. */
  const schedule = useCallback((): void => {
    if (timer.current !== undefined) return
    timer.current = setTimeout(() => {
      timer.current = undefined
      void send()
    }, SAVE_DEBOUNCE_MS)
  }, [send])

  const read = useCallback(async (): Promise<void> => {
    if (!enabledRef.current) {
      setRelPaths([])
      pending.current = []
      return
    }
    try {
      const response = await fetch(kbApiPath(KB_API.favoritesGet), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      const body = (await response.json()) as FavoritesView
      if (gone.current) return
      // The reader can click before this round trip lands; adopting the answer then
      // would un-star the row they just set.
      if (touched.current) return
      setRelPaths(body.relPaths ?? [])
      pending.current = body.relPaths ?? []
      setError(undefined)
    } catch (failure: unknown) {
      if (!gone.current && !touched.current) setRelPaths([])
      setError(failure instanceof Error ? failure.message : undefined)
    }
  }, [])

  const has = useCallback((relPath: string): boolean => relPaths.includes(relPath), [relPaths])

  const setFavorite = useCallback((relPath: string, favorite: boolean): void => {
    const already = pending.current.includes(relPath)
    // Asked-for state already holds: nothing to write, and no toggle back.
    if (favorite === already) return
    touched.current = true
    const next = favorite
      ? [...pending.current, relPath]
      : pending.current.filter(entry => entry !== relPath)
    pending.current = next
    setRelPaths(next)
    schedule()
  }, [schedule])

  useEffect(() => {
    gone.current = false
    touched.current = false
    void read()
    return () => {
      gone.current = true
      if (timer.current !== undefined) {
        // Flush rather than drop: the reader may have starred a row and then
        // navigated away, and discarding that would lose exactly the gesture this
        // hook exists to remember. The request outlives the component harmlessly --
        // its result is ignored once `gone` is set.
        clearTimeout(timer.current)
        timer.current = undefined
        void send()
      }
    }
  }, [enabled, read, send])

  return { relPaths, has, setFavorite, refresh: () => { void read() }, error }
}
