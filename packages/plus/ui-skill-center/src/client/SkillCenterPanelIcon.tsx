/**
 * The sidebar's Skill Center glyph.
 *
 * The icon comes from the shared primitives library, so the row matches every
 * other sidebar entry instead of carrying a hand-drawn SVG.
 *
 * @module @sparkelf/dsh-client-ui-skill-center/client/SkillCenterPanelIcon
 */
import type { ReactNode } from 'react'
import { IconSkillOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Render the glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: requested edge and selected state.
 * @returns the icon element.
 */
export function SkillCenterPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconSkillOutline16 size={size} />
}
