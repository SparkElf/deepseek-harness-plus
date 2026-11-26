/**
 * The glyph the left sidebar renders for the knowledge-base entry.
 *
 * `sidebar.panellist` is a list of icon buttons, so this component receives only a
 * size and never renders a surface. The page the entry selects is a separate
 * component registered against the `main` key.
 *
 * The glyph is the product's own icon component rather than a local path: the rail
 * sits directly beside the other panel icons, and a hand-drawn stroke read visibly
 * heavier than its neighbours. Using the product icon keeps the rail uniform and
 * lets the size the sidebar passes through unchanged.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { IconPlusOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/** Props the sidebar list passes to one entry. */
export interface KnowledgeMenuIconProps {
  /** Glyph edge length in pixels, chosen by the sidebar for its current width. */
  size?: number
  /** Whether this entry is the selected panel. */
  active?: boolean
}

/**
 * Render the knowledge-base glyph.
 * @param props - sidebar-supplied glyph size.
 * @returns The product icon sized for the sidebar rail.
 */
export function KnowledgeMenuIcon(props: KnowledgeMenuIconProps) {
  // `active` is accepted for the slot's contract; the product glyph takes its
  // colour from the row, so the selected state needs no second artwork.
  return <IconPlusOutlineRegular size={props.size ?? 18} />
}
