/**
 * Room members as `@` mentions in the composer.
 *
 * The `@` menu is a multi-source pipeline: every source owns one group, and a pick becomes an
 * official inline chip. A member is picked the same way a room message is, but the chip declares
 * itself with `appearance: 'mention'`, which is what makes the composer hand the picked ids to the
 * Host as `prompt.mentions` instead of leaving them to be re-parsed out of the prompt text. The
 * Host's routing reads ids by design ("never parsed out of message text"): text parsing would
 * misread a code sample containing `@` and would let any message smuggle itself into an execution
 * path.
 *
 * The group appears only in a room: `candidates` answers an empty list everywhere else, and an
 * empty group closes itself, so a normal session's `@` menu is unchanged.
 *
 * @module @sparkelf/dsh-group-chat/client/memberReference
 */

import { MEMBER_MENTION_SOURCE } from '../reference-ids.ts'
import { roomSessionId } from '../session-id.ts'
import { listMembers } from './api.ts'
import { mentionSourceOf } from './mentionSource.ts'
import type { RoomStore } from './store.ts'
import type { InputTriggersLike } from './messageReference.ts'

/** Unique source name; duplicate `(trigger, name)` pairs throw at registration. */
const SOURCE_NAME = MEMBER_MENTION_SOURCE

/** How many members the menu offers at once. */
const MAX_CANDIDATES = 20

/** Reference id → the display name the chip and the clipboard need. */
const names = new Map<string, string>()

/**
 * Registers the room-member mention source.
 *
 * @param inputTriggers - the trigger pipeline service (`ctx.get('inputTriggers')`).
 * @param store - room store, read for the room the composer is writing into.
 * @returns the disposer.
 */
export const registerMemberSource = (inputTriggers: InputTriggersLike, store: RoomStore): (() => void) => {
  const source = {
    trigger: '@',
    name: SOURCE_NAME,
    // The menu shows this instead of the package-path source id; identity stays `name`.
    label: '成员',
    // Above room messages (30): a member is the more common address in a group chat.
    order: 20,
    showGroupTitle: true,
    async candidates(session: { readonly sessionId?: string }, request: { readonly query: string; readonly signal: AbortSignal }) {
      const roomId = store.getState().activeRoomId
      if (roomId === undefined) return []
      // `activeRoomId` outlives the room view: switching to an ordinary Session leaves it set. The
      // Session being composed is what decides, so a stale id cannot put the roster into a session
      // that is not the room.
      if (session.sessionId !== undefined && session.sessionId !== roomSessionId(roomId)) return []
      const members = await listMembers(roomId)
      const roster = mentionSourceOf(members)
      const owners = new Set(members.filter(member => member.owner).map(member => member.userId))
      const needle = request.query.trim().toLowerCase()
      const out: {
        name: string
        description?: string
        icon: string
        value: string
      }[] = []
      for (const member of roster) {
        if (request.signal.aborted) break
        if (needle.length > 0 && !member.displayName.toLowerCase().includes(needle)) continue
        names.set(member.id, member.displayName)
        out.push({
          name: member.displayName,
          ...owners.has(member.id) ? { description: '群主' } : {},
          icon: 'mention',
          value: member.id,
        })
        if (out.length >= MAX_CANDIDATES) break
      }
      return out
    },
    onPick(pick: { readonly candidate: { readonly value?: string; readonly name: string } }) {
      const memberId = pick.candidate.value
      if (memberId === undefined) return undefined
      const name = names.get(memberId) ?? pick.candidate.name
      return {
        insert: {
          source: SOURCE_NAME,
          ref: memberId,
          // The chip shows the same words the clipboard and the model carry, so the prompt text
          // and the declared ids cannot disagree about who was addressed.
          label: name,
          appearance: 'mention',
          clipboardText: `@${name}`,
        },
      }
    },
    codec: {
      /** What lands in the draft and the clipboard: the human-facing mention. */
      clipboardText: (ref: string): string => `@${names.get(ref) ?? ref}`,
      /** What the model reads in place of the chip. The id rides the prompt's `mentions`. */
      serialize: (ref: string): Promise<string> => Promise.resolve(`@${names.get(ref) ?? ref}`),
    },
  }
  return inputTriggers.registerSource(source)
}