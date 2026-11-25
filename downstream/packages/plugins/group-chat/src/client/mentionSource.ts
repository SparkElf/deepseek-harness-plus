/**
 * The member source a future composer mention provider will register.
 *
 * The official composer owns the `@` menu today; this module is the stable data shape the
 * group-chat plugin can hand that extension point once it exists. Keeping it separate from
 * the roster means the provider does not have to know about roles, join times or room state.
 *
 * @module @sparkelf/dsh-group-chat/client/mentionSource
 */

import type { RoomMember } from './api.ts'

/** One member as the composer's `@` menu needs it. */
export interface MentionSourceMember {
  /** Stable account id the server stores on the message. */
  id: string
  /** Name shown after `@` and matched by the search field. */
  displayName: string
  /** Picture, when the account has one; the menu falls back to initials. */
  avatarUrl?: string
}

/**
 * Build the member source for one room.
 * @param members - the room roster.
 * @param selfId - the caller's account id, excluded because mentioning yourself is not a way
 *   to notify anyone; the host's self-mention route handles waking the agent separately.
 * @returns id/name/avatar rows in roster order.
 */
export function mentionSourceOf (
  members: readonly RoomMember[],
  selfId?: string,
): MentionSourceMember[] {
  return members
    .filter((member) => member.userId !== selfId)
    .map((member) => ({
      id: member.userId,
      displayName: member.displayName.trim() === '' ? member.userId : member.displayName,
      ...(member.avatarUrl === undefined || member.avatarUrl === null || member.avatarUrl === ''
        ? {}
        : { avatarUrl: member.avatarUrl }),
    }))
}
