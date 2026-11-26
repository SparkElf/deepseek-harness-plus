/**
 * The rail's section bands: a name with an optional trailing glyph cluster.
 *
 * Copied from the shell's own browser header,
 * `ui-workspace/src/client/rows/WorkspaceBrowser.module.css` (`.sectionHeader` /
 * `.sectionLabel` + `.iconButton`). That band is the one a reader compares this
 * page against, because it is what the right sidebar shows for 工作区 in the same
 * window. The metrics were also measured live on the running shell on 2026-10-17
 * and agree with the stylesheet exactly: a 36px row, `gap: 4px`,
 * `padding-left: 4px`, a label at 14px/20px, and 28x28 buttons on an 8px radius.
 *
 * Two details are the stylesheet's own and easy to get wrong:
 *
 * - The label is *not* bold. `--dsw-font-s-14` is 14px/22px, while this band's
 *   line-height is an explicit 20px, so the shorthand is paired with the measured
 *   line-height rather than allowed to win.
 * - The name inherits the band's ink, which the stylesheet sets to
 *   `--dsw-alias-label-tertiary`; the buttons carry
 *   `--dsw-alias-label-secondary` of their own. Measured live, the name is
 *   `#adb2b8` and the buttons `#cfd3d6`, which is that same split.
 *
 * The band is a plain `div` with a name span and a button cluster rather than a
 * heading element: it labels a region that already carries its own landmark, and
 * a second heading level here would put an unlabelled h3 in the heading outline.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import type { ReactNode } from 'react'
import styles from './KnowledgePanel.module.css'

/** Props for one section band. */
export interface KnowledgeSectionHeaderProps {
  /** Localized section name, rendered at the measured 14px/20px. */
  name: ReactNode
  /**
   * The trailing controls.
   *
   * Optional because the pinned band's only control is the fold toggle, while
   * the tree band carries three; a band with none renders the name alone.
   */
  actions?: ReactNode
  /** Extra class for the band, so a caller can add its own spacing. */
  className?: string
}

/**
 * Render one section band.
 * @param props - the name, its trailing controls, and optional placement.
 * @returns The band.
 */
export function KnowledgeSectionHeader(props: KnowledgeSectionHeaderProps) {
  return (
    <div className={props.className === undefined ? styles.sectionHeader : styles.sectionHeader + ' ' + props.className}>
      <span className={styles.sectionName}>{props.name}</span>
      {props.actions !== undefined && <div className={styles.sectionActions}>{props.actions}</div>}
    </div>
  )
}

/** Props for one 28px glyph button in a band's cluster. */
export interface KnowledgeIconButtonProps {
  /** Localized accessible name; also the tooltip, as the shell's own buttons do. */
  label: string
  /** The glyph, sized by the caller to the band's 16px step. */
  children: ReactNode
  /** Invoked on activation. */
  onClick: () => void
  /** Whether the control refuses activation. */
  disabled?: boolean
  /** Whether the control's action is currently engaged, so it can report `aria-pressed`. */
  pressed?: boolean
}

/**
 * Render one glyph button.
 *
 * A native button with the band's own class rather than the `Button` primitive:
 * that primitive is the product's labelled action at a 36px control height, while
 * this is the 28x28 icon control the band is specified around.
 * @param props - the accessible name, glyph, and activation handler.
 * @returns The button.
 */
export function KnowledgeIconButton(props: KnowledgeIconButtonProps) {
  return (
    <button
      type="button"
      className={styles.iconButton}
      aria-label={props.label}
      title={props.label}
      {...(props.pressed === undefined ? {} : { 'aria-pressed': props.pressed })}
      {...(props.disabled === true ? { disabled: true } : {})}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}
