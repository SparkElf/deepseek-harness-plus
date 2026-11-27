/**
 * Settings styles.
 *
 * Inline rather than a CSS-module file: the browser bundle in this package has no CSS
 * pipeline (adding one would mean a `lightningcss` build dependency the other half does not
 * need), and this section is a handful of declarations that read the shell's own design
 * tokens. The tokens are what make it follow the theme; the rules here only place them.
 *
 * @module @sparkelf/dsh-ocr/client/styles
 */

import type { CSSProperties } from 'react'

/** The section's outer block: normal settings-page rhythm. */
export const section: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
}

/** A field label, matching the official settings page's 14px/22px label line. */
export const label: CSSProperties = {
  fontSize: '14px',
  fontWeight: 400,
  lineHeight: '22px',
}

/** A grouped field: label above control. */
export const field: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  // The field owns the section's width, not a narrower column: the action row below is
  // right-aligned to the section, so a narrower input would leave the buttons hanging
  // past the input's right edge -- the misalignment the reader sees as sloppy.
  width: '100%',
}

/**
 * The field row: the input primitive and the status tag share one box.
 *
 * A grid rather than a flex row because the primitive's wrapper is an inline-flex span:
 * as a grid item it stretches to the column width, which a flex item with `flex: 0 1 auto`
 * would not. The tag is positioned over the input's right edge, inside the border.
 */
export const addressBox: CSSProperties = {
  position: 'relative',
  display: 'grid',
  width: '100%',
}

/** The status tag's seat inside the input box. */
export const tagSlot: CSSProperties = {
  position: 'absolute',
  right: '8px',
  top: '50%',
  transform: 'translateY(-50%)',
  display: 'flex',
  alignItems: 'center',
  pointerEvents: 'auto',
}

/** A row of actions, right-aligned like the settings page's own footers. */
export const actions: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
  justifyContent: 'flex-end',
}

/**
 * The panel's bottom action row.
 *
 * Same width as the field, so the last button's right edge lands exactly on the input's
 * right edge. The extra top margin is deliberate: the row must not crowd the status line
 * under the input -- the failure reason and the buttons are different decisions, and a
 * reader scanning the reason should not hit a button by accident.
 */
export const actionsBar: CSSProperties = {
  ...actions,
  marginTop: '20px',
  width: '100%',
  boxSizing: 'border-box',
  // The Input primitive's native field sits 9px inside the section's right edge (its
  // wrapper keeps the primitive's inline inset). Reserve the same inset so the last
  // button's right edge lands on the input's right edge instead of 9px past it.
  paddingRight: '9px',
}

/** Secondary copy: what is stored, why it cannot be edited, what a result means. */
export const detail: CSSProperties = {
  margin: 0,
  fontSize: '12px',
  lineHeight: '18px',
  opacity: 0.72,
}

/**
 * A failed connection's reason.
 *
 * Red because the state is an error, smaller than body copy because it is supporting
 * evidence rather than a sentence to read at the same weight as the field, and still
 * selectable so an operator can copy the transport message into a ticket.
 */
export const errorDetail: CSSProperties = {
  margin: 0,
  fontSize: '12px',
  lineHeight: 1.5,
  color: 'var(--dsw-alias-state-error-primary)',
  overflowWrap: 'anywhere',
}

/** The confirmation block and the result block share this outline. */
export const panel: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '12px',
  border: '1px solid var(--dsw-alias-border-default, currentColor)',
  borderRadius: '8px',
  // Same width as the field and the action row: a narrower block would break the single
  // right edge the whole panel is aligned to.
  width: '100%',
  boxSizing: 'border-box',
}

/** The four result counts. */
export const counts: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(88px, 1fr))',
  gap: '8px',
  margin: 0,
}

/** One count: the number leads, the label under it. */
export const count: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
}

/** A count's number. */
export const countValue: CSSProperties = {
  margin: 0,
  fontSize: '20px',
  fontVariantNumeric: 'tabular-nums',
}
