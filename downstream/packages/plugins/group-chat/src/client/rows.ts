/**
 * The decisions the plugin's components make without a browser.
 *
 * They live outside their components on purpose. The components import the official
 * primitives, which bring CSS modules that this repository's test runner cannot transform,
 * so anything worth asserting has to be reachable without mounting a component. That
 * constraint turns out to match the risk: what an operator sees — which rows survive a
 * query, what a picture falls back to, who carries the owner tag, whether an empty
 * announcement area means "write one" or "this deployment cannot store one" — is exactly
 * what goes wrong quietly, and it is all decidable from plain values.
 *
 * @module @sparkelf/dsh-group-chat/client/rows
 */

import {
  RoomError, type InviteCandidate, type PresetOption, type RoomMember, type RoomSummary,
} from './api.ts'

/** One row a picker can draw. */
export interface PickerOption {
  readonly id: string
  readonly label: string
  /** What the operator searches by when the label is a display name. */
  readonly secondary?: string
  readonly avatarUrl?: string | null
  /** Initials and tint are keyed on this when it differs from the row's result id. */
  readonly avatarId?: string
  /**
   * Whether the row is shown but cannot be taken.
   *
   * Shown, not hidden: a row that is absent leaves the operator unable to tell a deployment
   * that never declared it from one that declared it unusable.
   */
  readonly disabled?: boolean
}

/**
 * The locale namespace the shipped presets publish their names in.
 *
 * Read as a foreign namespace rather than one this plugin registers: `standard` and the other
 * three are declared by the platform, and their copy is owned there. Reprinting that copy here
 * would freeze today's wording and drift from the hero chip the moment the platform changes it.
 */
export const PRESET_LOCALE_NS = 'settings.agentPreset'

/** Locale keys the shipped presets use, keyed by the id the registry publishes. */
const BUILT_IN_PRESET_KEYS: Readonly<Record<string, { name: string; description: string }>> = {
  standard: { name: 'presetStandardName', description: 'presetStandardDescription' },
  ptc: { name: 'presetPtcName', description: 'presetPtcDescription' },
  minimal: { name: 'presetMinimalName', description: 'presetMinimalDescription' },
  cordis: { name: 'presetCordisName', description: 'presetCordisDescription' },
}

/**
 * A preset's display copy, following the platform's own rule.
 *
 * A shipped preset publishes no `name`, so its copy is a locale lookup; a preset that names
 * itself in YAML owns its own words and is never translated. The split matters because the two
 * arrive as the same `{ id, name? }` shape — treating a published name as a locale key would
 * render the key itself, and treating a shipped id as self-named would render `standard`.
 *
 * @param preset - one roster row.
 * @param t - lookup for the preset locale namespace; a missing key resolves to the key, so the
 * fallback below is what keeps a renamed platform key from reaching the operator.
 * @returns the name and optional description to draw.
 */
export const presetDisplay = (
  preset: PresetOption,
  t: (key: string) => string,
): { readonly name: string; readonly description?: string } => {
  const keys = preset.name === undefined ? BUILT_IN_PRESET_KEYS[preset.id] : undefined
  if (keys === undefined) {
    return {
      name: preset.name ?? preset.id,
      ...preset.description === undefined ? {} : { description: preset.description },
    }
  }
  // An unresolved key comes back as itself; showing `presetStandardName` would be worse than
  // showing the id, so the id wins whenever the lookup did not actually resolve.
  const name = t(keys.name)
  const description = t(keys.description)
  return {
    name: name === keys.name ? preset.id : name,
    ...description === keys.description ? {} : { description },
  }
}

/**
 * Roster rows as picker rows, optional-broken preset included.
 *
 * A broken preset stays visible and disabled rather than disappearing: it is declared in the
 * deployment, so an operator who cannot see it has no way to learn why the room they are
 * about to create will not start. Selection is expressed through `primary`, which the caller
 * uses to keep the broken row out of reach.
 *
 * @param presets - roster rows in the order the Host reported them.
 * @param t - lookup for the preset locale namespace.
 * @returns picker rows, one per preset.
 */
export const presetOptions = (
  presets: readonly PresetOption[],
  t: (key: string) => string,
): readonly PickerOption[] =>
  presets.map((preset) => {
    const { name, description } = presetDisplay(preset, t)
    return {
      id: preset.id,
      label: name,
      ...description === undefined ? {} : { secondary: description },
      ...preset.broken === undefined ? {} : { disabled: true },
    }
  })

/**
 * Filter rows by what the operator typed.
 *
 * Matching happens here rather than only at the source because the source's answer arrives a
 * debounce behind the keystroke; re-filtering the rows already held narrows the list on the
 * same frame instead of one request later. `secondary` participates because a member's handle
 * is often what the operator knows them by.
 *
 * @param options - the rows currently held.
 * @param query - the raw input.
 * @returns the rows to draw, in their original order.
 */
export const filterOptions = (
  options: readonly PickerOption[],
  query: string,
): readonly PickerOption[] => {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return options
  return options.filter((option) =>
    option.label.toLowerCase().includes(needle)
    || (option.secondary ?? '').toLowerCase().includes(needle))
}

/**
 * Add or remove one person from the invite selection.
 *
 * The selection is kept apart from the search result rows because the two answer different
 * questions: the rows are "what the current query found", while the selection is "who will be
 * invited". A narrowed query legitimately hides a person already picked, and deriving the
 * selection from the visible rows would drop them the moment the operator typed another name.
 *
 * The row is stored whole, not by id, so a chip can still draw the name and picture after the
 * search that produced it has been replaced.
 *
 * @param chosen - the current selection, in pick order.
 * @param candidate - the row the operator pressed.
 * @returns the new selection; a second press on the same id removes it, and identity is stable
 *   when the press changed nothing.
 */
export const toggleChosen = <T extends { readonly userId: string }>(
  chosen: readonly T[],
  candidate: T,
): readonly T[] =>
  chosen.some((member) => member.userId === candidate.userId)
    ? chosen.filter((member) => member.userId !== candidate.userId)
    : [...chosen, candidate]

/**
 * Narrow the invite candidates to what the operator typed.
 *
 * The same rule the server applies, applied again to the rows already held, for one reason:
 * the server's answer arrives a debounce behind the keystroke, and the list would otherwise
 * sit still while the operator types. Re-filtering locally makes the narrowing immediate; the
 * server request still happens, and its answer replaces these rows a moment later.
 *
 * Both the display name and the handle participate, because the handle is often what a
 * colleague is known by — the server's search matches the same pair.
 *
 * @param candidates - the rows currently held, from the last answer.
 * @param query - the raw input.
 * @returns the rows to draw, in their original order.
 */
export const filterCandidates = (
  candidates: readonly InviteCandidate[],
  query: string,
): readonly InviteCandidate[] => {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return candidates
  return candidates.filter((candidate) =>
    candidate.displayName.toLowerCase().includes(needle)
    || candidate.username.toLowerCase().includes(needle))
}

/**
 * Whether one candidate row is part of the selection.
 *
 * @param chosen - the current selection.
 * @param userId - the row's account id.
 * @returns whether the row draws as selected.
 */
export const isChosen = (
  chosen: readonly { readonly userId: string }[],
  userId: string,
): boolean => chosen.some((member) => member.userId === userId)

/**
 * Up to two initials from a display name.
 *
 * Names arriving here are DataOps display names, which are as often Chinese as Latin. A CJK
 * name has no spaces to split on, so the first two characters are taken as-is; a Latin name
 * takes the first letter of its first two words. Both paths return at most two glyphs, which
 * is what keeps the circle from overflowing at either size.
 *
 * @param name - the display name, possibly empty.
 * @returns one or two characters, or `'?'` when the name carries nothing to draw.
 */
export const initialsOf = (name: string): string => {
  const trimmed = name.trim()
  if (trimmed.length === 0) return '?'
  // CJK ranges: a leading character here means the name is written without word spaces.
  if (/^[\u3400-\u9fff\uf900-\ufaff]/u.test(trimmed)) return [...trimmed].slice(0, 2).join('')
  const words = trimmed.split(/\s+/u).filter((word) => word.length > 0)
  if (words.length === 1) return [...words[0]!].slice(0, 2).join('').toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}


/**
 * The rooms worth offering as joinable.
 *
 * Two filters, for two different failures. `joined` is belt-and-braces: the Host already strips
 * joined rooms from discovery, but this list arrives from a request the sidebar did not wait
 * for, so a room the operator joined a moment ago can still be in the response.
 *
 * The member-id check covers the other window: the discovery read and the sidebar's own list
 * come from separate requests, so a room can be in both for a moment. Without it the same room
 * would appear twice, and the copy under the discovery heading would offer a Join button that
 * can only fail.
 *
 * @param discoverable - what the discovery read returned.
 * @param memberIds - ids of the rooms the sidebar is already showing.
 * @returns the rooms to render under the discovery heading.
 */
export const joinableRooms = (
  discoverable: readonly RoomSummary[],
  memberIds: ReadonlySet<string>,
): readonly RoomSummary[] =>
  discoverable.filter((room) => !room.joined && !memberIds.has(room.id))

/**
 * The members panel's decisions, made away from the component.
 *
 * Same reason as the pickers above: the panel imports primitives whose CSS modules this
 * repository's test runner cannot transform, so everything worth asserting — who is pinned
 * to the top, who carries a role tag, what a search removes, which of the announcement's
 * three states a room is in — has to be decidable from plain values.
 */

/** One row the members panel draws. */
export interface MemberRow {
  readonly userId: string
  readonly name: string
  readonly avatarUrl?: string | null
  /** Whether the row carries the owner tag; plain members are deliberately unmarked. */
  readonly owner: boolean
  /** Whether this row is the operator, marked so they can find themselves in a long roster. */
  readonly self: boolean
}

/**
 * Whether a member owns the room.
 *
 * `owner` is the field every server has ever sent, `role` is the one the announcement work
 * added. Preferring `role` and falling back to `owner` keeps the tag correct against either
 * server, and costs nothing: the two carry the same fact.
 *
 * @param member - one roster row.
 * @returns whether the row is the room's owner.
 */
export const memberIsOwner = (member: RoomMember): boolean =>
  member.role === undefined ? member.owner === true : member.role === 'owner'

/**
 * Roster rows for the panel, owner pinned first.
 *
 * Only the owner is moved. Everyone else keeps the order the server sent, which is join
 * order — a roster re-sorted alphabetically would scramble the one fact a reader can
 * actually see in it (who has been here longest), and would do so differently for a CJK
 * name than for a Latin one.
 *
 * @param members - the roster as the store holds it.
 * @param selfId - this workspace's account id, `undefined` while identity is still unknown.
 * @returns rows to draw.
 */
export const memberRows = (
  members: readonly RoomMember[],
  selfId: string | undefined,
): readonly MemberRow[] => {
  const rows = members.map((member): MemberRow => ({
    userId: member.userId,
    name: member.displayName.length > 0 ? member.displayName : member.userId,
    avatarUrl: member.avatarUrl,
    owner: memberIsOwner(member),
    self: selfId !== undefined && member.userId === selfId,
  }))
  // `Array.prototype.sort` is stable, so the non-owners keep the server's order.
  return rows.slice().sort((left, right) => Number(right.owner) - Number(left.owner))
}

/**
 * Narrow the roster to what the operator typed.
 *
 * The account id participates because it is what another member is often known by — the
 * invite picker searches the handle for the same reason.
 *
 * @param rows - the roster rows currently held.
 * @param query - the raw input.
 * @returns rows to draw, in their order.
 */
export const filterMemberRows = (
  rows: readonly MemberRow[],
  query: string,
): readonly MemberRow[] => {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return rows
  return rows.filter((row) =>
    row.name.toLowerCase().includes(needle) || row.userId.toLowerCase().includes(needle))
}

/**
 * What the announcement area has to draw, as one of exactly three states.
 *
 * The middle state matters: a feature that is present and empty must offer to add an
 * announcement, while a deployment that never shipped the field must not pretend the
 * operator can write one. `undefined` is the absence of the field, `null` or a blank string
 * is the empty one — so the distinction has to be made here, once, rather than by every
 * caller.
 */
export type AnnouncementView =
  | { readonly state: 'unavailable' }
  | { readonly state: 'empty' }
  | { readonly state: 'text'; readonly text: string }

/**
 * Read one room's announcement into the state its area draws.
 *
 * @param announcement - the room summary's field.
 * @returns the state to render.
 */
export const announcementView = (announcement: string | null | undefined): AnnouncementView => {
  if (announcement === undefined) return { state: 'unavailable' }
  // `null` and a blank string are the same fact to the reader: the feature is here and
  // nothing is written in it. The server reads a cleared announcement back as `null`.
  const text = (announcement ?? '').trim()
  return text.length === 0 ? { state: 'empty' } : { state: 'text', text }
}

/**
 * Whether a failed write means this deployment has no announcement feature.
 *
 * A rolled-back deployment answers the route with 404 (no route) or 501/405 (a route that
 * refuses the method). Those are the only failures that should switch the area to
 * "unavailable": a 401 or a 5xx is this request's problem, and reporting it as a missing
 * feature would send the operator looking at the wrong thing.
 *
 * @param error - whatever the write threw.
 * @returns whether the feature should be regarded as absent.
 */
export const announcementMissing = (error: unknown): boolean =>
  error instanceof RoomError
  && (error.status === 404 || error.status === 405 || error.status === 501)

/**
 * The announcement text a save should send.
 *
 * Trimming here rather than in the component keeps "clearing is allowed" a stated rule: the
 * server reads an empty string as "remove the announcement", and a field holding only spaces
 * must mean the same thing rather than storing invisible text.
 *
 * @param draft - what the editor holds.
 * @returns the body to send, empty when the announcement should be cleared.
 */
export const announcementDraft = (draft: string): string => draft.trim()
