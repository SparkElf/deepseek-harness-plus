/**
 * The set of folders the reader has open in the explorer, remembered across visits.
 *
 * Expansion is a document-level preference, so it lives beside `.pinned.json` and
 * `.view-mode.json` in the caller's view directory rather than in browser storage: a
 * reader who opens `department/platform` on one machine expects to find it open on the
 * next, and a browser profile is not the unit a knowledge base follows.
 *
 * Two costs shape the implementation.
 *
 * The read is a Host round trip, so the tree renders collapsed first and expands once
 * the answer lands. Rendering it collapsed is the honest initial state: it is exactly
 * what a reader who never opened a folder sees, and the alternative -- holding the whole
 * tree back until a preference resolves -- would trade a flicker for a blank panel.
 *
 * The write happens on every toggle, and a reader opening a deep path toggles once per
 * level, so writing through immediately would put four round trips behind one gesture.
 * Saves are therefore coalesced: the first toggle arms a timer, later toggles inside the
 * window replace the pending payload, and the timer sends whatever the latest state is.
 * A save still in flight when the reader keeps clicking leaves a dirty flag rather than
 * queueing a second request, so the wire never carries more than one save at a time and
 * the last state always wins.
 *
 * A failed write is not surfaced as a page error. This is a view preference whose worst
 * outcome is a folder that comes back closed, and shouting at a reader for it would be
 * worse than the outcome; the next successful save repairs it.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { KB_API, kbApiPath, type TreeStateView } from '../api.ts'

/**
 * How long to wait after the last toggle before writing.
 *
 * Long enough to swallow a reader opening a path level by level (four or five clicks
 * land inside one window), short enough that the state is on disk before a reload a
 * reader is likely to perform. Purely a coalescing window: it never delays what the
 * tree renders, only what is persisted.
 */
const SAVE_DEBOUNCE_MS = 400

/** What the hook exposes to the rail. */
export interface TreeStateStore {
  /** Absolute paths of the expanded folders, as the Host last answered. */
  expanded: readonly string[]
  /** Toggle one directory open or closed. */
  toggle: (path: string) => void
  /** Set the whole set at once (a reveal, or a Host round trip). */
  setExpanded: (paths: readonly string[]) => void
}

/**
 * Keep only the paths this tree could actually draw.
 *
 * The stored set outlives a grant change, so a folder that was expanded yesterday may
 * no longer exist today. That is harmless for the tree -- an entry no row matches is
 * simply never rendered -- but it would otherwise accumulate forever and be re-sent on
 * every save. Filtering to the current root on the way in is what bounds the file.
 * @param paths - candidate absolute paths.
 * @param root - the knowledge root, or '' while it is still unknown.
 * @returns The entries under `root`, in their original order.
 */
function withinRoot(paths: readonly string[], root: string): readonly string[] {
  // An unknown root means the page has not resolved its config yet; filtering then
  // would discard every entry and lose the reader's state on a slow first load.
  if (root === '') return paths
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  return paths.filter(path => path === base || path.startsWith(base + '/'))
}

/**
 * Read and write the caller's expanded folders.
 * @param enabled - false while the mount point is unknown, which is the only state
 *   where there is no view directory holding the preference.
 * @param root - the knowledge root, used to bound what is stored; '' while unknown.
 * @returns The store; `expanded` is empty until the first read answers.
 */
export function useTreeState(enabled: boolean, root = ''): TreeStateStore {
  const [expanded, setLocalExpanded] = useState<readonly string[]>([])

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
   * flag that late answer would overwrite the folder they just opened with the state
   * the file held before they touched it.
   */
  const touched = useRef(false)
  /** The current root, readable from the debounce timer without re-arming it. */
  const rootRef = useRef(root)
  rootRef.current = root

  const send = useCallback(async (): Promise<void> => {
    if (saving.current) {
      // A save is already out; it will re-check this flag when it returns, which is
      // what keeps two writes from racing and the older one winning.
      dirty.current = true
      return
    }
    saving.current = true
    dirty.current = false
    try {
      const response = await fetch(kbApiPath(KB_API.treeStateSet), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expanded: pending.current }),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      const body = (await response.json()) as TreeStateView
      if (gone.current) return
      // The Host normalises (drops junk and duplicates), so its answer -- not the
      // request -- is what the page treats as stored. Skipping this would let the
      // page keep a value the file does not hold, and a reload would then disagree
      // with what was on screen.
      //
      // A reader who toggled again while this was on the wire already has a newer
      // value in `pending`; adopting this answer then would collapse the folder they
      // just opened. `dirty` is exactly that case, so only a clean save is adopted.
      if (dirty.current) return
      const stored = withinRoot(body.expanded ?? [], rootRef.current)
      setLocalExpanded(stored)
      pending.current = stored
    } catch {
      // Best effort, deliberately silent: the reader's next toggle retries, and a
      // preference that failed to persist is not a page-level failure.
    } finally {
      saving.current = false
      if (dirty.current && !gone.current) {
        // Something changed while that save was out. Arm the timer again so the
        // newer state is not stranded behind the older request.
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

  const setExpanded = useCallback((paths: readonly string[]): void => {
    const bounded = withinRoot(paths, rootRef.current)
    touched.current = true
    setLocalExpanded(bounded)
    pending.current = bounded
    schedule()
  }, [schedule])

  const toggle = useCallback((path: string): void => {
    setLocalExpanded((current) => {
      const next = current.includes(path)
        ? current.filter(entry => entry !== path)
        : [...current, path]
      // Written here rather than after the updater because the save must send the
      // same value the tree is about to render, and this callback is the only place
      // that value exists at the moment it is decided.
      pending.current = next
      return next
    })
    touched.current = true
    schedule()
  }, [schedule])

  useEffect(() => {
    gone.current = false
    // A new enabled/root cycle is a fresh read of a possibly different view, so the
    // previous cycle's "the reader already clicked" must not suppress it.
    touched.current = false
    if (!enabled) {
      setLocalExpanded([])
      pending.current = []
      return
    }
    void (async () => {
      try {
        const response = await fetch(kbApiPath(KB_API.treeStateGet), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          cache: 'no-store',
        })
        if (!response.ok) throw new Error('HTTP ' + String(response.status))
        const body = (await response.json()) as TreeStateView
        if (gone.current) return
        // The reader can click before this round trip lands. Adopting the answer
        // then would collapse the folder they just opened, so a touched store keeps
        // what the reader did and lets the next save reconcile it with the Host.
        if (touched.current) return
        const stored = withinRoot(body.expanded ?? [], rootRef.current)
        setLocalExpanded(stored)
        pending.current = stored
      } catch {
        // A failed read leaves the tree collapsed rather than stale, which is the
        // tree's own default and the state a first visit has.
        if (!gone.current && !touched.current) setLocalExpanded([])
      }
    })()
    return () => {
      gone.current = true
      if (timer.current !== undefined) {
        // Flush rather than drop: the reader may have toggled and then navigated
        // away, and discarding that would lose exactly the gesture this hook
        // exists to remember. The request outlives the component harmlessly --
        // its result is ignored once `gone` is set.
        clearTimeout(timer.current)
        timer.current = undefined
        void send()
      }
    }
  }, [enabled, send])

  return { expanded, toggle, setExpanded }
}
