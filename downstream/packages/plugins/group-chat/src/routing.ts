/**
 * The routing rule that decides whether an incoming room event wakes this
 * workspace's agent.
 *
 * The rule is a single sentence: **only a member's own mention of themselves runs
 * that member's agent**. Everything else is recorded and read, never executed.
 *
 * The consequences are worth stating because they are the point of the design:
 *
 * - Nobody can drive someone else's agent, so nobody can spend another member's
 *   model budget or reach their files through a mention.
 * - `@everyone` and `@someone-else` are ordinary messages. They broadcast; they do
 *   not fan out into N agent runs.
 * - Every message still reaches every agent's context, so an agent answering later
 *   has read the whole conversation. Execution is gated; visibility is not.
 */
import type { RoomEvent, RoomMember } from './backend.ts'
import { MEMBER_MENTION_SOURCE } from './reference-ids.ts'

/** Identifies a member mentioned by an event. */
export interface MentionTarget {
  readonly memberId: string
  /** `all` is reserved for `@everyone`; it never equals a member id, so it never triggers. */
  readonly kind: 'member' | 'all'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads the `source` object off an event's `data`, if it is shaped like a message. */
export const eventSource = (event: RoomEvent): Record<string, unknown> | undefined => {
  if (!isRecord(event.data)) return undefined
  const source = event.data['source']
  return isRecord(source) ? source : undefined
}

/** The DataOps user a message came from, when the event identifies one. */
export const senderId = (event: RoomEvent): string | undefined => {
  const memberId = eventSource(event)?.['memberId']
  return typeof memberId === 'string' && memberId.length > 0 ? memberId : undefined
}

/** True when the event is a member's agent reply rather than a human message. */
export const isAgentReply = (event: RoomEvent): boolean =>
  eventSource(event)?.['authorKind'] === 'agent'

/**
 * True when the event was forwarded from an external channel.
 *
 * Those authors have no DataOps account and no member row, so an event carrying their id must
 * never be able to impersonate one — including the case where a bridge bug stamps this workspace's
 * own member id on it. The check is on the declared author kind, which the server sets, not on the
 * id shape.
 */
export const isExternalAuthor = (event: RoomEvent): boolean =>
  eventSource(event)?.['authorKind'] === 'external'

/** The global backend id carried on the event, used for local deduplication. */
export const messageId = (event: RoomEvent): string | undefined => {
  const id = eventSource(event)?.['messageId']
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Reads structured mentions off an event.
 *
 * Mentions are declared by the sender's client as member ids — never parsed out of
 * message text. Parsing text would misread a code sample containing `@`, and it
 * would let any message smuggle itself into an execution path.
 */
/**
 * Member ids a prompt's sender declared on its source, in pick order.
 *
 * The composer's roster source inserts chips with `appearance: 'mention'`, and the reference
 * pipeline hands those ids to the Host on the prompt; this reads them back. Only ids that source
 * owns qualify — another source's chip is a file, a session, or a quoted message, never a member.
 */
export const declaredMentions = (source: { readonly mentions?: unknown } | undefined): readonly string[] => {
  const raw = source?.mentions
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { readonly sourceId?: unknown; readonly itemId?: unknown }
    if (record.sourceId !== MEMBER_MENTION_SOURCE) continue
    const memberId = record.itemId
    if (typeof memberId !== 'string' || memberId.length === 0 || seen.has(memberId)) continue
    seen.add(memberId)
    out.push(memberId)
  }
  return out
}

export const mentionsOf = (event: RoomEvent): readonly MentionTarget[] => {
  const raw = eventSource(event)?.['mentions']
  if (!Array.isArray(raw)) return []
  const targets: MentionTarget[] = []
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.length > 0) targets.push({ memberId: entry, kind: 'member' })
  }
  return targets
}

/** A room's reply policy. Room-level, so it is the same for every member. */
export type AgentTriggerPolicy = 'mention' | 'always' | 'never'

/**
 * The decision the whole design turns on.
 *
 * Under the default `mention` policy this requires the sender to be this workspace's
 * member *and* to have mentioned that same member, which is the only combination that
 * may start a turn. `always` and `never` are the room's explicit overrides; both change
 * only whether a turn runs, never what is recorded or what each agent can read.
 */
export const shouldTriggerAgent = (
  event: RoomEvent,
  workspaceUserId: string,
  roomMembers: readonly RoomMember[],
  policy: AgentTriggerPolicy = 'mention',
): boolean => {
  // Settled before any per-message reasoning: under `never` a message that would
  // otherwise qualify still starts nothing.
  if (policy === 'never') return false
  // An external author has no DataOps account. Even if a bridge stamped a member id on the
  // event, the message is not that member speaking, so it can never run an agent.
  if (isExternalAuthor(event)) return false
  const sender = senderId(event)
  if (sender === undefined || sender !== workspaceUserId) return false
  // An agent's own reply must never re-trigger an agent; that is an infinite echo, and
  // it stays forbidden under `always`.
  if (isAgentReply(event)) return false
  if (policy === 'always') return true
  // A mention of a non-member does not resolve, so it cannot trigger anything.
  const memberIds = new Set(roomMembers.map((member) => member.userId))
  return mentionsOf(event).some((target) =>
    target.kind === 'member' && target.memberId === sender && memberIds.has(target.memberId))
}

/**
 * Renders the name prefix for a message this workspace did not author.
 *
 * DSH's compaction summarizes raw `role` + `content` and carries no speaker field,
 * so identity must live inside `content` to survive summarization. This mirrors the
 * shipped `agent-team` plugin, which prefixes `Team message from <name>:`.
 */
export const speakerPrefix = (event: RoomEvent, roomMembers: readonly RoomMember[]): string => {
  const source = eventSource(event)
  if (source === undefined) return ''
  const memberId = typeof source['memberId'] === 'string' ? source['memberId'] : undefined
  const known = memberId === undefined ? undefined : roomMembers.find((member) => member.userId === memberId)
  const name = known?.displayName
    ?? (typeof source['memberName'] === 'string' && source['memberName'].length > 0 ? source['memberName'] : undefined)
    ?? '未知成员'
  return isAgentReply(event) ? `[${name} 的 agent] ` : `${name}：`
}

/** Prepends the speaker to each text block so the model can attribute the message. */
export const withSpeakerPrefix = (event: RoomEvent, prefix: string): RoomEvent => {
  if (prefix.length === 0 || !isRecord(event.data)) return event
  const content = event.data['content']
  if (!Array.isArray(content)) return event
  const rewritten = content.map((block) => {
    if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') return block
    return { ...block, text: `${prefix}${block['text']}` }
  })
  return { ...event, data: { ...event.data, content: rewritten } }
}

/**
 * Reads member ids out of an `@name` convention in the message text.
 *
 * The composer's own `@` menu offers files and sessions, not the room's roster, and the plugin
 * cannot add a category to it. Rather than replace the composer, the roster is addressed the way
 * people already write it: `@显示名`. The host half turns the names it can resolve into the
 * structured `mentions` the room server stores, which is what the reply policy reads.
 *
 * Resolution is exact and longest-name-first. Longest first matters because `@张三丰` also
 * contains `@张三`, and a shorter prefix would mention the wrong member. A name that matches
 * nobody mentions nobody — guessing at a near match would let a typo summon the wrong agent.
 *
 * @param text - the message text, as typed.
 * @param members - the room's roster.
 * @returns member ids, in the order they appear, without duplicates.
 */
export const mentionedMemberIds = (
  text: string,
  members: readonly RoomMember[],
): readonly string[] => {
  if (text.length === 0 || members.length === 0) return []
  // Longest first so a name that is a prefix of another cannot win by being checked earlier.
  const ordered = [...members].sort((left, right) => right.displayName.length - left.displayName.length)
  const placed: { at: number; userId: string }[] = []
  const seen = new Set<string>()
  // Spans already claimed by a longer name. Without this, `@张三丰` matches the longer member and
  // *also* contains `@张三`, so the shorter one joins the list as a second mention of a person
  // nobody addressed. Sorting longest-first only decides who matches first; it cannot stop the
  // shorter name from finding its own substring inside the same characters.
  const claimed: { start: number; end: number }[] = []
  const overlaps = (start: number, end: number): boolean =>
    claimed.some((span) => start < span.end && span.start < end)
  for (const member of ordered) {
    const name = member.displayName.trim()
    if (name.length === 0) continue
    const needle = `@${name}`
    const at = text.indexOf(needle)
    if (at < 0) continue
    if (overlaps(at, at + needle.length)) continue
    claimed.push({ start: at, end: at + needle.length })
    if (seen.has(member.userId)) continue
    seen.add(member.userId)
    placed.push({ at, userId: member.userId })
  }
  // Reading order rather than roster order: the ids are stored beside the text, and a reader
  // comparing the two expects them to line up.
  return placed.sort((left, right) => left.at - right.at).map((entry) => entry.userId)
}

/** The plain text of a message's blocks, ignoring everything that is not text. */
export const textOfContent = (content: unknown): string => {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type?: unknown; text?: unknown } =>
      typeof block === 'object' && block !== null)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}
