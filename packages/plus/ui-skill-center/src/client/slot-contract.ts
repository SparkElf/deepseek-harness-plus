/**
 * Slot contract for the skill center page: the section slot another plugin
 * contributes to.
 *
 * The slot carries one owner share, the page's current search text. The page draws a single
 * search field at its top for every skill it shows, and a contributed section shows skills too,
 * so the field has to reach it: a section that draws its own field duplicates the control and
 * filters only its own half.
 *
 * @module @sparkelf/dsh-client-ui-skill-center/client/slot-contract
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Owner props a contributed section receives.
 *
 * Declared here rather than inferred at the call site: the page and the section live in
 * different packages, so the type is the only thing keeping their props in step.
 */
export interface SkillCenterSectionOwnerProps {
  /** The page's current search text, unfiltered and untrimmed. */
  readonly query: string
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** A section contributed to the skill center page, below the skill list. */
    'skill-center.section': {
      kind: 'list'
      scope: 'root'
      owner: SkillCenterSectionOwnerProps
    }
  }
}
