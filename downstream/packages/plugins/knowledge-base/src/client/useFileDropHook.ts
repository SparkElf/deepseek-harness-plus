/**
 * The React shell around the drag-and-drop decisions.
 *
 * Everything that can be decided without a browser lives in `useFileDrop.ts` next to
 * this file -- the target rules, the path joining, the de-duplication, the summary.
 * What is left is the one thing that genuinely needs a component: which row is
 * currently painted as the drop target.
 *
 * Kept in its own module for two reasons. The pure module must stay importable from a
 * test that has no DOM (measured: the runner has `File`, but no `DataTransfer`,
 * `FileList` or `document`), and importing React into it would make that impossible.
 * And the component wiring is the part that has to wait for the in-flight edits to
 * `KnowledgeFileTree.tsx` / `KnowledgeHome.tsx` to land, so it is kept separate rather
 * than half-merged.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useRef, useState } from 'react'
import { acceptsDrop, planDrop } from './useFileDrop.ts'
import type { DropEventLike, DropPlan, DropTargetLike } from './useFileDrop.ts'

/** What a component gets back from {@link useFileDrop}. */
export interface FileDropHandle {
  /** The path of the row that should paint its drop highlight, or undefined. */
  highlighted: string | undefined
  /**
   * Call from a row's `onDragOver`.
   *
   * Returns whether the row accepts this drag, which the caller uses to decide
   * `event.preventDefault()`: without it the browser refuses the drop outright.
   * @param target - the row under the pointer.
   * @returns Whether the row would accept the drop.
   */
  onDragOver: (target: DropTargetLike | undefined) => boolean
  /**
   * Call from a row's `onDragEnter`.
   *
   * @param target - the row the pointer entered.
   * @returns Whether the row would accept the drop.
   */
  onDragEnter: (target: DropTargetLike | undefined) => boolean
  /**
   * Call from a row's `onDragLeave`, and from the surface's own `onDragLeave` for the
   * case where the pointer left the panel entirely.
   * @param target - the row the pointer left, if any.
   */
  onDragLeave: (target?: DropTargetLike | undefined) => void
  /**
   * Call from a row's `onDrop`. Clears the highlight and returns what to upload.
   * @param target - the row the pointer was over.
   * @param event - the drop payload.
   * @returns The upload to perform, or why nothing happens.
   */
  onDrop: (target: DropTargetLike | undefined, event: DropEventLike) => DropPlan
  /** Clear the highlight without a drop (Escape, or the drag leaving the window). */
  reset: () => void
}

/**
 * Track the drag state for one drop surface.
 *
 * Note the enter/leave counter. A drag crossing from a row onto its own child fires
 * `dragleave` on the parent BEFORE `dragenter` on the child, so clearing the highlight
 * on every `dragleave` makes it flicker off and back on. Counting enter/leave pairs is
 * what keeps it stable; the counter reaching zero is the real exit.
 * @returns The handle a component wires into its rows.
 */
export function useFileDrop(): FileDropHandle {
  const [highlighted, setHighlighted] = useState<string | undefined>(undefined)
  /** Net enter/leave depth; zero means the pointer is outside the surface. */
  const depth = useRef(0)

  const onDragEnter = useCallback((target: DropTargetLike | undefined): boolean => {
    const accepts = acceptsDrop(target)
    if (!accepts) return false
    depth.current += 1
    setHighlighted(target?.relativePath)
    return true
  }, [])

  const onDragOver = useCallback((target: DropTargetLike | undefined): boolean => {
    const accepts = acceptsDrop(target)
    // A drag over a NON-accepting row must also drop any highlight painted by a
    // previous row: leaving the old one lit would claim the file will land there.
    setHighlighted(accepts ? target?.relativePath : undefined)
    return accepts
  }, [])

  const onDragLeave = useCallback((target?: DropTargetLike | undefined): void => {
    depth.current = Math.max(0, depth.current - 1)
    // Always clear: the highlight belongs to whichever row last accepted, and that row
    // is the one the pointer is leaving. Keeping it lit until the counter drains would
    // paint a folder the pointer has already left whenever the drag moves outward.
    setHighlighted((current) => (
      target === undefined || current === target.relativePath ? undefined : current
    ))
  }, [])

  const onDrop = useCallback((target: DropTargetLike | undefined, event: DropEventLike): DropPlan => {
    depth.current = 0
    setHighlighted(undefined)
    return planDrop(target, event)
  }, [])

  const reset = useCallback((): void => {
    depth.current = 0
    setHighlighted(undefined)
  }, [])

  return { highlighted, onDragOver, onDragEnter, onDragLeave, onDrop, reset }
}
