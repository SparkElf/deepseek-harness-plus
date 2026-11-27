/**
 * The glyph the left sidebar renders for the 「工作流广场」 entry.
 *
 * A calendar outline rather than the knowledge-base document glyph: two entries with
 * the same artwork would be indistinguishable on the rail. Sized by the sidebar and
 * coloured by `currentColor`, so it follows the selected/idle row state.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

/** Props the sidebar list passes to one entry. */
export interface WorkflowMenuIconProps {
  /** Glyph edge length in pixels, chosen by the sidebar for its current width. */
  size?: number
  /** Whether this entry is the selected panel. */
  active?: boolean
}

/**
 * Render the workflow-plaza glyph.
 * @param props - sidebar-supplied glyph size.
 * @returns The calendar outline sized for the sidebar rail.
 */
export function WorkflowMenuIcon(props: WorkflowMenuIconProps) {
  const size = props.size ?? 18
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4M7 13h3M14 13h3M7 17h3M14 17h3" />
    </svg>
  )
}
