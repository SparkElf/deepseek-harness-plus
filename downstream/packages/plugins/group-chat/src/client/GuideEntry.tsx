/**
 * The members page's box on the right sidebar's start guide, drawn only while a room is open.
 *
 * The start guide lists every registered page type so a reader can open one. Its list is
 * global — the registry builds it from every registration and offers no per-Session filter — so
 * a type that appears there is offered in every conversation, including ordinary ones that have
 * no room behind them. Picking it there would open a panel that can only say "not a group chat",
 * which is a dead end for the reader and noise in the guide.
 *
 * The guide renders each box through its own entry seat, keyed by the contributing type's id, so
 * a type may replace its own box. This draws the box while a room is open and nothing otherwise.
 * The cell wrapping it is a fixed-width, auto-height container with no border or background, so
 * an empty box leaves no gap.
 *
 * Rendering `null` rather than unregistering the type is deliberate: the guide is consulted once
 * per registration change, not per navigation, so a registration toggled by the current Session
 * would either be stale by the time the guide renders or churn on every room switch. The type
 * also has to stay registered for a placed tab to survive a reload.
 *
 * @module @sparkelf/dsh-group-chat/client/GuideEntry
 */

import type { ReactNode } from 'react'
import { roomIdOfSession } from '../session-id.ts'
import styles from './GuideEntry.module.css'

/**
 * What the guide passes to one entry box.
 *
 * `sessionId` is the guide's own scope: its entry seat is declared `scope: 'session'`, so the
 * framework supplies the Session the guide is drawing beside. `entryId` and `kind` identify which
 * box is being drawn, and the resolved title and description are the guide's own copy — a
 * replacement re-renders them rather than deriving them again.
 */
export interface MembersGuideEntryProps {
  /** The contributing entry's id, as registered in this type's `guide` array. */
  readonly entryId: string
  /** The page type this box opens. */
  readonly kind: string
  /** The box's title, already localized by the guide. */
  readonly title: string
  /** The one-line description, present only while the guide lists few enough boxes. */
  readonly description?: string
  /** The Session this guide is drawing beside. */
  readonly sessionId: string
  /** Reveal this page type; supplied by the plugin, since a box's own opener is not passed in. */
  readonly onPick?: () => void
}

/**
 * Draw the members box, or nothing when the open conversation is not a room.
 *
 * @param props - the box's copy, its Session, and how to open the page.
 * @returns the box, or `null` outside a room.
 */
export function MembersGuideEntry(props: MembersGuideEntryProps): ReactNode {
  const { title, description, sessionId, onPick } = props
  // An ordinary conversation has no room, and this page has nothing to show in one. Drawing
  // nothing is what keeps the box off the guide; the wrapping cell collapses to no height.
  if (roomIdOfSession({ id: sessionId }) === undefined) return null

  return (
    <button
      type="button"
      className={styles['entry']}
      // The guide's shared sheet addresses entries by this attribute: better-sidebar turns every
      // one of them into a square tile (column, centred, 22px glyph). A replacement that omits it
      // keeps the shell capsule and reads as a foreign control among the tiles.
      data-sidebar-right-guide-entry={props.kind}
      data-group-chat-guide-entry={props.entryId}
      onClick={() => { onPick?.() }}
    >
      <span className={styles['icon']} aria-hidden="true">
        {/* Drawn inline: this package carries no icon set, and one glyph does not justify a
            dependency. The paths are the familiar "people" mark, at the guide tile's 22px. */}
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </span>
      <span className={styles['text']}>
        <span className={styles['title']}>{title}</span>
        {description !== undefined && <span className={styles['description']}>{description}</span>}
      </span>
    </button>
  )
}
