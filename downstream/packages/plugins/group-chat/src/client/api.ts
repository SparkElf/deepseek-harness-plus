/**
 * Room-page transport.
 *
 * The browser talks only to the Host plugin's own route. The Host holds the
 * workspace credential and forwards to the server under the workspace identity, so
 * this module never sees a token and cannot disagree with the agent about who the
 * caller is.
 *
 * @module @sparkelf/dsh-group-chat/client/api
 */

/** The Host route registered by this plugin's own Host half. */
export const GC_API = '/dsh-group-chat/api'

/**
 * One event as the server stores it: the DSH envelope verbatim, with no
 * plugin-specific fields added.
 */
export interface RoomEvent {
  readonly id: string
  readonly event: {
    readonly type: string
    readonly seq?: number
    readonly time?: number
    readonly data?: Record<string, unknown>
  }
}

export interface RoomSummary {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string
  readonly invitePolicy: 'anyone' | 'admin'
  readonly discoverability: 'discoverable' | 'invite_only'
  /** The room's reply policy, which decides whether a message starts a turn. */
  readonly agentTrigger: 'mention' | 'always' | 'never'
  /** The room's agent working directory, or null for the workspace root. */
  readonly cwd: string | null
  /** The room's agent preset, or null for the default. */
  readonly agentPreset: string | null
  readonly memberCount: number
  readonly joined: boolean
  /**
   * Messages from others since this account last read the room.
   *
   * Absent on a deployment that predates the field: the sidebar then shows no badge rather
   * than claiming "0 unread", which would be indistinguishable from a room nobody wrote in.
   */
  readonly unreadCount?: number
  /** The subset of {@link unreadCount} that mentions this account. */
  readonly mentionCount?: number
  readonly createdAt: string
  readonly updatedAt: string
  /**
   * The room announcement, when this deployment stores one.
   *
   * `undefined` is a third state on purpose: it means the server answering this read has no
   * announcement feature at all (an older deployment, or one rolled back after the plugin
   * shipped), which the panel reports as unavailable. `null` is a feature that is present
   * and has nothing written in it — the distinction is what keeps an empty banner from
   * claiming the feature is broken.
   */
  readonly announcement?: string | null
}

export interface RoomMember {
  readonly userId: string
  readonly displayName: string
  readonly owner: boolean
  readonly joinedAt: string
  /** The member's picture, when DataOps has one. Absent means "draw initials instead". */
  readonly avatarUrl?: string | null
  /**
   * The member's role, when the server reports one.
   *
   * Absent on a server that predates roles; `owner` above already carries the same fact, so
   * the panel derives the role from it rather than showing every member as ordinary.
   */
  readonly role?: 'owner' | 'member'
}

/**
 * One account that can still be added to a room.
 *
 * Separate from {@link RoomMember} because it describes a person who is *not* in the room:
 * a candidate carries the handle and picture the picker searches and draws, and no join
 * date or ownership, because neither exists before the invite is accepted.
 */
export interface InviteCandidate {
  readonly userId: string
  readonly displayName: string
  readonly username: string
  readonly avatarUrl?: string | null
}

/** Directory names the room picker can browse, relative to the browsing root. */
export interface DirectoryListing {
  readonly path: string
  readonly parent: string | null
  readonly entries: readonly { readonly name: string; readonly path: string }[]
}

/**
 * One agent preset the deployment offers.
 *
 * `id` is the registry's own identifier — the `config.id` a preset declares, not the filename
 * of the patch that declares it. The two happen to match for every shipped preset, which is
 * exactly why the distinction has to be carried by the type: a deployment that renames a file
 * must not silently offer a name the registry will reject at room creation.
 */
export interface PresetOption {
  readonly id: string
  /** Present only for a preset that names itself; a shipped preset's copy is a locale key. */
  readonly name?: string
  readonly description?: string
  readonly order?: number
  /** Whether this is the deployment's default preset. */
  readonly isDefault?: boolean
  /** Non-empty when the preset is declared but could not be activated. */
  readonly broken?: string
}

/** Preset roster and the directories the create dialog needs. */
export interface RoomOptions {
  readonly presets: readonly PresetOption[]
}

export interface EventPage {
  readonly events: readonly RoomEvent[]
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

/** A failure the page renders as copy rather than as an exception. */
export class RoomError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'RoomError'
  }
}

const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response
  try {
    response = await fetch(`${GC_API}${path}`, {
      ...init,
      headers: {
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init?.headers,
      },
      // Same-origin: the Host route is served from this page's own origin.
      credentials: 'same-origin',
    })
  } catch (cause) {
    throw new RoomError('unreachable', 0)
  }
  if (!response.ok) {
    // The Host relays the server's own status, so each failure keeps its cause instead of
    // collapsing into one generic sentence. 401 and 403 are distinct from 503: the plugin
    // did resolve a credential and the server refused it, which is what a logged-out or
    // expired DataOps session looks like — a reader who saw "unreachable" would go looking
    // at the network instead of signing in again.
    const status = response.status
    if (status === 503) throw new RoomError('credentialMissing', status)
    if (status === 401 || status === 403) throw new RoomError('credentialRejected', status)
    if (status === 404) throw new RoomError('notConfigured', status)
    // 409 is the server refusing a state change it will not make — the owner trying to leave
    // is the one this client can reach, and collapsing it into "unreachable" would send the
    // reader to inspect the network instead of transferring ownership.
    if (status === 409) throw new RoomError('ownerCannotLeave', status)
    throw new RoomError('unreachable', status)
  }
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

/**
 * The account this workspace acts as.
 *
 * The message renderer needs it to tell the operator's own messages from another member's,
 * and the browser holds no credential of its own to ask DataOps directly — the Host resolves
 * it from the same identity that decides message routing, so the two cannot disagree.
 *
 * @returns the account id, or `undefined` when the Host cannot identify this workspace.
 */
export const readSelf = async (): Promise<{ id: string; administrator: boolean } | undefined> => {
  try {
    // The host answers `roleCodes`, not the raw DataOps role objects: the client half never
    // talks to DataOps itself, so the host is what carries the account's roles across.
    const me = await call<{ id?: unknown; roleCodes?: unknown }>('/me')
    if (typeof me?.id !== 'string' || me.id.length === 0) return undefined
    // The room server owns the authoritative check; this flag only decides whether to *offer*
    // dissolving a room the reader does not own. These two role names are the ones the
    // deployment grants `system:admin:manage` to by default, so offering the entry matches what
    // the server will accept.
    const administrator = Array.isArray(me.roleCodes)
      && me.roleCodes.some((code) => code === '管理员' || code === '超级管理员')
    return { id: me.id, administrator }
  } catch {
    // An unidentified workspace still shows its rooms; its own messages simply stay where
    // the official renderer puts them rather than being claimed as the operator's.
    return undefined
  }
}

/** Rooms this workspace has joined. */
export const listRooms = (): Promise<readonly RoomSummary[]> => call('/rooms')

/**
 * Rooms this account could join, as opposed to the ones it is already in.
 *
 * Kept separate from {@link listRooms} because the two answer different questions: the sidebar
 * shows what you belong to, while this is consulted only when the operator is looking for
 * something to join. Merging them would make every list read ask for rooms the account has no
 * relationship with.
 *
 * @param query - optional narrowing keyword, applied by the server.
 * @returns matching rooms, each carrying `joined` so the caller can tell them apart.
 */
export const listDiscoverableRooms = (query?: string): Promise<readonly RoomSummary[]> => {
  const suffix = query === undefined || query.trim().length === 0
    ? ''
    : `?query=${encodeURIComponent(query.trim())}`
  return call(`/discover${suffix}`)
}

/**
 * Take a seat in a room the server allows this account to join.
 *
 * The decision to allow it is the server's: it re-reads discoverability, invite policy and
 * membership at the moment of the press, so a room offered a minute ago may still be refused.
 * That refusal arrives as a `RoomError` and is shown as-is rather than being pre-empted here.
 *
 * @param roomId - the room to join.
 * @returns the server's answer, including whether the account was already a member.
 */
export const joinRoom = (roomId: string): Promise<unknown> =>
  call(`/rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST' })

export const listMembers = (roomId: string): Promise<readonly RoomMember[]> =>
  call(`/rooms/${encodeURIComponent(roomId)}/members`)

/**
 * Accounts that match `query` and are not yet in the room.
 *
 * The search runs on the Host, which holds the credential: the browser has no DataOps token
 * of its own, so a client-side filter over a full directory is not an option here. An empty
 * query is valid and returns a browsable first page rather than nothing, which is what makes
 * the picker usable before the operator has typed anything.
 */
export const searchInviteCandidates = (
  roomId: string,
  query: string,
): Promise<readonly InviteCandidate[]> => {
  const suffix = query.length === 0 ? '' : `?q=${encodeURIComponent(query)}`
  return call(`/rooms/${encodeURIComponent(roomId)}/invite-candidates${suffix}`)
}

/** Preset names this deployment offers. An empty list means the picker falls back to typing. */
export const readOptions = (): Promise<RoomOptions> => call('/options')

/** Child directories of `path`, for the working-directory picker. */
export const listDirectories = (path?: string): Promise<DirectoryListing> => {
  const suffix = path === undefined || path.length === 0 ? '' : `?path=${encodeURIComponent(path)}`
  return call(`/directories${suffix}`)
}

/**
 * Whether the host has this room's session up.
 *
 * The host creates a room's session on its own poll, which starts when the plugin does. A
 * member who opens a room before that poll reaches it makes the shell retain an id the host
 * has not created yet — the open then fails with `sessions.retain: unknown session`, and the
 * room shows its history against a session scope nothing can write into.
 */
export interface RoomState {
  readonly roomId: string
  readonly open: boolean
  readonly memberCount: number
}

export const readRoomState = (roomId: string): Promise<RoomState> =>
  call<RoomState>(`/rooms/${encodeURIComponent(roomId)}/state`)

export const listEvents = (roomId: string, cursor?: string): Promise<EventPage> => {
  const suffix = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`
  return call(`/rooms/${encodeURIComponent(roomId)}/events${suffix}`)
}

/**
 * Create a room.
 *
 * `cwd` and the preset are sent at creation because they decide the scope every member
 * will share; the server does not accept them afterwards.
 */
export const createRoom = (
  name: string,
  execution?: { cwd?: string; agentPreset?: string },
): Promise<RoomSummary> =>
  call('/rooms', { method: 'POST', body: JSON.stringify({ name, ...execution }) })

/**
 * Set or clear a room's announcement.
 *
 * Only the room owner may write it; the server decides that, so a refusal is surfaced as-is
 * rather than pre-empted here. An empty string clears the announcement — the server stores
 * that as no announcement, which is why the panel treats `''` and `null` alike when reading.
 *
 * @param roomId - the room whose announcement to write.
 * @param announcement - the new text, or an empty string to clear it.
 */
export const setAnnouncement = (roomId: string, announcement: string): Promise<unknown> =>
  call(`/rooms/${encodeURIComponent(roomId)}/announcement`, {
    method: 'POST',
    body: JSON.stringify({ announcement }),
  })

export const updateRoom = (
  roomId: string,
  patch: { name?: string; invitePolicy?: string; discoverability?: string; agentTrigger?: string },
): Promise<RoomSummary> =>
  call(`/rooms/${encodeURIComponent(roomId)}/update`, { method: 'POST', body: JSON.stringify(patch) })

/**
 * Hand ownership of a room to another member.
 *
 * The reason this exists at all is that a room's owner cannot leave it: leaving would strand the
 * room with nobody able to change its settings. Transferring is the way out, so the server owns
 * the rule (owner only, target must be a member) and this only carries the request.
 */
export const transferOwnership = (roomId: string, userId: string): Promise<unknown> =>
  call(`/rooms/${encodeURIComponent(roomId)}/transfer`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  })

export const inviteMembers = (roomId: string, userIds: readonly string[]): Promise<unknown> =>
  call(`/rooms/${encodeURIComponent(roomId)}/members`, {
    method: 'POST',
    body: JSON.stringify({ userIds }),
  })

export const leaveRoom = (roomId: string): Promise<unknown> =>
  call(`/rooms/${encodeURIComponent(roomId)}/members/me`, { method: 'DELETE' })

/** One file in a room's shared folder. */
export interface SharedFile {
  readonly path: string
  readonly name: string
  readonly size: number
  readonly directory: boolean
}

/** The shared folder of one room. */
/**
 * The group-chat UI preferences this workspace remembers.
 *
 * Read from and written to a file in this workspace's own volume, so they follow the user
 * across re-logins and browsers rather than living in one browser's storage.
 */
export interface GroupChatPreferences {
  /** Height of the sidebar's group-chat region, in pixels. */
  readonly sidebarHeightPx?: number
}

/** Reads the stored preferences. Never fails: an unreadable file reads as "nothing saved". */
export const readPreferences = async (): Promise<GroupChatPreferences> => {
  try {
    return await call<GroupChatPreferences>('/preferences')
  } catch {
    // The panel's height is not worth surfacing an error for; the default is a fine answer.
    return {}
  }
}

/** Stores the preferences and returns what the host settled on, clamped. */
export const savePreferences = (patch: GroupChatPreferences): Promise<GroupChatPreferences> =>
  call<GroupChatPreferences>('/preferences', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

export interface RoomFiles {
  readonly path: string | null
  /** Where this listing is, relative to the room folder. Empty at the top. */
  readonly relativePath?: string
  /** One entry per level from the room folder down to here. */
  readonly crumbs?: readonly { readonly name: string; readonly path: string }[]
  readonly files: readonly SharedFile[]
}

/**
 * List a room's shared folder.
 *
 * An empty `path` means this deployment has no shared tree, which the panel renders as
 * "not available" rather than as an empty folder — the two read differently to a member.
 */
export const listRoomFiles = (roomId: string, path?: string): Promise<RoomFiles> =>
  call(`/rooms/${encodeURIComponent(roomId)}/files${
    path === undefined || path.length === 0 ? '' : `?path=${encodeURIComponent(path)}`
  }`)

/** One shared file's text, as the preview shows it. */
export interface SharedFileText {
  readonly path: string
  readonly name: string
  readonly text: string
  readonly truncated: boolean
  readonly textLike: boolean
  /** Data URL when the file is an image the panel can draw inline. */
  readonly image?: string
}

/** Read one file out of a room's shared folder. */
export const getRoomFile = (roomId: string, path: string): Promise<SharedFileText> =>
  call(`/rooms/${encodeURIComponent(roomId)}/file-content?path=${encodeURIComponent(path)}`)

/** Where an upload landed. */
export interface SharedFileWrite {
  readonly path: string
  readonly name: string
  readonly size: number
}

/**
 * Upload one file into a room's shared folder.
 *
 * Base64 in JSON rather than multipart: the plugin's request path reads one JSON envelope for
 * every operation, and a second body format would need its own parser, limits, and error
 * mapping for no gain.
 *
 * @param roomId - the room whose folder receives the file.
 * @param file - the browser's File object.
 * @returns the written file.
 */
export const uploadRoomFile = async (roomId: string, file: File): Promise<SharedFileWrite> => {
  const buffer = new Uint8Array(await file.arrayBuffer())
  // Chunked: `String.fromCharCode(...bytes)` overflows the argument limit on a file of a few
  // hundred kilobytes, and the spread is what makes the one-liner tempting.
  let binary = ''
  for (let index = 0; index < buffer.length; index += 1) {
    binary += String.fromCharCode(buffer[index] as number)
  }
  return call(`/rooms/${encodeURIComponent(roomId)}/files`, {
    method: 'POST',
    body: JSON.stringify({ name: file.name, data: btoa(binary) }),
  })
}

/**
 * Remove one member from a room.
 *
 * The reserved word `me` keeps its meaning: removal always names another account, and the
 * server rejects the owner as a target. Leaving therefore never goes through this call.
 */
export const removeMember = (roomId: string, userId: string): Promise<unknown> =>
  call(`/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })

/**
 * Dissolve a room outright.
 *
 * Distinct from {@link leaveRoom}: leaving removes one membership and the room keeps existing
 * for everyone else, while dissolving ends the room for every member. The server decides who
 * may do it (the owner, or an administrator), so a refusal surfaces as copy rather than being
 * pre-empted here.
 */
export const dissolveRoom = (roomId: string): Promise<unknown> =>
  call(`/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' })

/**
 * Send one message.
 *
 * `rpcId` is the idempotency key: the server keys a retry on it, so a send that
 * succeeded but whose response was lost does not post twice.
 */
/** One content block, as the room server stores it. */
export interface ContentBlock {
  readonly type: string
  readonly [key: string]: unknown
}

/**
 * Sends a message that carries more than text.
 *
 * The server's block type is open (`{ type: string; ... }`), so a quote rides through as its own
 * block instead of being flattened into the text — flattening would lose the message id the
 * renderer needs to draw the bar, and would make the quote look like something the author typed.
 */
/** One message the room search matched, with enough context to open it. */
export interface MessageHit {
  readonly eventId: string
  readonly roomId: string
  readonly roomName: string
  readonly authorName: string | null
  readonly authorKind: 'human' | 'agent' | null
  readonly text: string
  readonly createdAt: string
}

/**
 * Searches message text across the rooms this account can read.
 *
 * The room server owns the visibility rule; this only passes the words. An empty query is not
 * sent at all — every message would match it.
 */
export const searchMessages = (query: string): Promise<MessageHit[]> => {
  const trimmed = query.trim()
  if (trimmed.length === 0) return Promise.resolve([])
  return call<MessageHit[]>(`/rooms/messages/search?query=${encodeURIComponent(trimmed)}`)
}

/**
 * Registers a pending reply with the host.
 *
 * The message itself is submitted by the official composer, which this plugin neither wraps nor
 * intercepts, so the quote travels beside it rather than inside it: the host attaches it to the
 * next message this member sends in the room and then forgets it.
 */
export const registerQuote = (
  roomId: string,
  quote: { readonly messageId: string; readonly preview: string; readonly authorName?: string },
): Promise<unknown> =>
  call(`/rooms/${encodeURIComponent(roomId)}/quote`, {
    method: 'POST',
    body: JSON.stringify(quote),
  })

/** Drops a pending reply that will not be sent. */
export const clearQuote = (roomId: string): Promise<unknown> =>
  call(`/rooms/${encodeURIComponent(roomId)}/quote`, { method: 'DELETE' })

/**
 * Ask the Host to make one room the view: it resolves the room's Session and the workspace that
 * owns it, then hands back the Session id the shell should select.
 *
 * The browser cannot do this itself: the Session belongs to no workspace until the Host creates
 * one at the Session's own directory, and `openSession` only selects a Session a workspace owns.
 * @param roomId - the room to open.
 * @returns the Session to select.
 */
export const openRoom = (roomId: string): Promise<{ readonly sessionId: string }> =>
  call(`/rooms/${encodeURIComponent(roomId)}/open`, { method: 'POST' })

export const sendBlocks = (
  roomId: string,
  content: readonly ContentBlock[],
  rpcId: string,
  mentions?: readonly string[],
): Promise<unknown> =>
  call(`/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      rpcId,
      ...mentions === undefined || mentions.length === 0 ? {} : { mentions },
    }),
  })

export const sendMessage = (roomId: string, content: string, rpcId: string): Promise<unknown> =>
  call(`/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, rpcId }),
  })

/** Text carried by an event, ignoring any non-text block. */
export const eventText = (record: RoomEvent): string => {
  const content = (record.event.data as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text?: string } =>
      typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/** Who wrote an event, and whether an agent wrote it. */
export const eventAuthor = (record: RoomEvent): { name: string; isAgent: boolean; isSelf: boolean } => {
  const source = (record.event.data as { source?: Record<string, unknown> } | undefined)?.source ?? {}
  return {
    name: String(source.memberName ?? source.agentOwnerId ?? '—'),
    isAgent: source.authorKind === 'agent',
    isSelf: source.isSelf === true,
  }
}
