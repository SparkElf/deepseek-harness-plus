/**
 * Slot contract for the skill center page: the section slot another plugin
 * contributes to.
 *
 * The slot carries no owner share. A contributing section registers through its
 * own plugin and reads its own locale namespace, the same way every other client
 * plugin owns its copy.
 *
 * @module @deepseek-ai/dsh-client-ui-skill-center/client/slot-contract
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Owner props a contributed section receives. The slot passes none today; the type exists so a
 * consumer can name the slot's owner share without importing the page.
 */
export interface SkillCenterSectionOwnerProps {
  /** Reserved for an owner share the panel may add; currently empty. */
  readonly reserved?: never
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** A section contributed to the skill center page, below the skill list. */
    'skill-center.section': {
      kind: 'list'
      scope: 'root'
    }
  }
}
