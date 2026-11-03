/**
 * Package-local glyphs for controls whose primitives icon has no stable name.
 *
 * The shell owns `@deepseek-ai/dsh-client-ui-primitives`, and its icon exports
 * are renamed between releases (`IconLinkOutline16` in one, `IconLinkOutline`
 * and `IconLinkOutlineRegular` in the next). A client plugin is loaded against
 * whatever primitives the running shell bundles, so a missing export reaches
 * React as an undefined component and unmounts the whole slot. These two
 * glyphs are drawn here instead of imported so the connector tab and the
 * dialog close control render on every shell that mounts the plugin.
 *
 * @module @sparkelf/dsh-client-ui-skill-center/client/glyphs
 */
import type { ReactNode } from 'react'

/**
 * The chain-link glyph on a connector card.
 * @returns a 16px current-color SVG.
 */
export function ConnectorGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" data-connector-glyph>
      <path d="M6.6 9.4 9.4 6.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="m7.4 4.9 1-1a2.7 2.7 0 0 1 3.8 3.8l-1 1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="m8.6 11.1-1 1a2.7 2.7 0 0 1-3.8-3.8l1-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The close glyph shared by the dialog header and the search clear control.
 * @param props.size - rendered edge length in pixels.
 * @returns a current-color SVG.
 */
export function CloseGlyph({ size = 14 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
