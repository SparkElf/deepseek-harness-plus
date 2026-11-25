/**
 * The DataOps backend client for group chat.
 *
 * Two directions, deliberately different in shape:
 *
 * - **Uplink** is `fetch` with an awaited acknowledgement. The backend assigns the
 *   globally ordered `id` and returns the finalized event, so the caller can append
 *   that exact event locally. A message that the backend rejects never reaches the
 *   append-only session log.
 * - **Downlink** is a pull by cursor. The backend is the only cross-container
 *   intersection point, so it is also the only authority on order; a cursor is the
 *   whole synchronization state.
 *
 * This module owns no policy: it does not decide who may post where, whether a
 * mention should wake an agent, or which events enter the model. It moves events.
 */
import { AUTHORIZATION_HEADER, type ServerTarget } from './identity.ts'

/** One durable room event as the backend stores it. */
export interface RoomEventRecord {
  /** Global order across every container, as a decimal string. */
  readonly id: string
  /** The complete DSH event envelope, stored without translation. */
  readonly event: RoomEvent
  readonly createdAt?: string
}

/**
 * The envelope half of a DSH event. `data` is `unknown` on purpose: the backend
 * stores it verbatim and this plugin re-appends it verbatim, so nothing here needs
 * to understand content blocks.
 */
export interface RoomEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data: unknown
  readonly surfaceOp?: string
}

/** A messaging platform a room can mirror. */
export type ExternalChannelKind = 'qqbot' | 'wecom' | 'dingtalk'

/**
 * An external system a room is bridged to.
 *
 * A room with an external channel accepts messages written by someone who has no DataOps account;
 * the bridge names the sender on each message it forwards, and the room shows it as foreign rather
 * than pretending the workspace said it.
 *
 * `externalGroupId` is the canonical group id for every platform. `groupOpenid` remains on the
 * shape because QQ rooms created by older deployments stored their group id under that name; a
 * reader must accept either, while a writer always fills `externalGroupId`.
 */
export interface ExternalChannel {
  readonly kind: ExternalChannelKind
  /** The external group this room mirrors. */
  readonly externalGroupId: string
  /** QQ's historical name for {@link externalGroupId}. Present on QQ rooms. */
  readonly groupOpenid?: string
  /** Platform chat id, when the platform distinguishes a chat from its group id. */
  readonly chatId?: string
  /** The bot that delivered the external group's messages. */
  readonly botId?: string
}

/** One message author that came from an external channel. */
export interface ExternalSender {
  readonly kind: ExternalChannelKind
  /** The sender's id inside the external system. */
  readonly senderId: string
  /** Display name the external system reported, already user-facing. */
  readonly senderName: string
  /** The bot that delivered this message. */
  readonly botId?: string
  /** When the platform received the message, as an ISO-8601 instant. */
  readonly receivedAt?: string
}

export interface RoomSummary {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string
  readonly invitePolicy: 'anyone' | 'admin'
  readonly discoverability: 'discoverable' | 'invite_only'
  /** The room's reply policy, which decides whether a message starts a turn. */
  readonly agentTrigger: 'mention' | 'always' | 'never'
  /**
   * The room's agent working directory, or null for the workspace root.
   *
   * Every member of a room shares this scope, so it is chosen at creation and is the
   * boundary the room's agent may act within on any member's behalf.
   */
  readonly cwd: string | null
  /**
   * Opaque connector identity the room acts for, when one was attached at creation.
   *
   * The room server stores it verbatim; the base never interprets it and this plugin only hands it
   * to the room's Session, where disclosure rules read it.
   */
  readonly actor?: unknown
  /** The room's agent preset, or null for the default. */
  readonly agentPreset: string | null
  /** The external system this room mirrors, when one is attached. */
  readonly externalChannel?: ExternalChannel
  /**
   * The model the room runs on, or nulls to follow the deployment default.
   *
   * A preset does not choose a model: the session's own model selection does, and a session
   * created without one runs the deployment default. When that default is not routable the
   * room can still open a session and start a turn, and the turn ends on an authentication
   * failure that reads like a defect in this plugin.
   */
  readonly modelProvider: string | null
  readonly model: string | null
  readonly reasoningEffort: string | null
  readonly memberCount: number
  readonly joined: boolean
  /** Unread messages for this account; computed by the room server. */
  readonly unreadCount?: number
  /** The subset of {@link unreadCount} that mention this account. */
  readonly mentionCount?: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface RoomMember {
  readonly userId: string
  readonly displayName: string
  /**
   * The member's picture, when the server has one.
   *
   * Optional because it is display-only: a server that omits it still renders initials,
   * while requiring it here would make every roster read fail over a missing avatar.
   */
  readonly avatarUrl?: string | null
  readonly owner: boolean
  readonly joinedAt: string
}

/**
 * One account that can still be added to a room.
 *
 * Deliberately not a {@link RoomMember}: a candidate is by definition *not* in the room, so
 * it carries the handle a picker searches on and has no join date or ownership — neither of
 * which exists before the invite is accepted.
 */
export interface InviteCandidate {
  readonly userId: string
  readonly displayName: string
  readonly username: string
  readonly avatarUrl?: string | null
}

export interface EventPage {
  readonly events: readonly RoomEventRecord[]
  /** Cursor to resume from; `null` when the room has no events yet. */
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

/** A backend refusal that carries the HTTP status so callers can distinguish them. */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
    this.name = 'BackendError'
  }
}


/** True when the request never reached the backend, so retrying cannot duplicate state. */
export const isTransportFailure = (error: unknown): boolean =>
  error instanceof Error && !(error instanceof BackendError)

export interface BackendClientOptions {
  /** Per-request timeout; a stalled backend must not hold a session append path. */
  readonly timeoutMs?: number
  /** Injected for tests. */
  readonly fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Resolves the credential for one request.
 *
 * The secret is fetched per request rather than captured at activation: a
 * credential can be rotated or added while the plugin is loaded, and caching it
 * would keep sending a stale value. Returning `undefined` means "no credential
 * available", which fails the request instead of sending an anonymous one.
 */
export type CredentialResolver = () => Promise<string | undefined>

/** Thin typed wrapper over the group-chat server protocol. */
/** One content block on the wire: `type` plus whatever that type carries. */
export interface ContentBlockLike {
  readonly type: string
  readonly [key: string]: unknown
}

export class GroupChatBackend {
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly target: ServerTarget,
    private readonly resolveCredential: CredentialResolver,
    options: BackendClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * Builds the headers for one call.
   *
   * The credential is a bearer token, so the request carries the deployment's own
   * identity rather than a plugin-specific one. The room routes are the same ones
   * a browser uses, which is why the plugin needs no parallel server surface.
   */
  private async headers(): Promise<Record<string, string>> {
    const credential = await this.resolveCredential()
    if (credential === undefined || credential.length === 0) {
      throw new Error('group-chat has no credential; configure one in the plugin settings')
    }
    return {
      [AUTHORIZATION_HEADER]: `Bearer ${credential}`,
      'content-type': 'application/json',
    }
  }

  /**
   * Rooms this workspace's member has joined.
   *
   * The response is validated rather than trusted, because a misconfigured base URL
   * does not fail loudly: a web tier in front of the API answers with its SPA
   * fallback, so the plugin receives a success status and a *string*. Iterating a
   * string yields its characters, so an unvalidated caller would treat each character
   * as a room and open a session per character. Rejecting the shape here keeps that
   * failure at the boundary, where the message names the real cause.
   */
  async listRooms(signal?: AbortSignal): Promise<readonly RoomSummary[]> {
    const rooms = await this.request<unknown>('GET', '/api/ai/chat/rooms', undefined, signal)
    if (!Array.isArray(rooms)) {
      throw new Error(
        `group-chat backend returned ${typeof rooms} instead of a room list; check that the base URL points at the API, not a web app`,
      )
    }
    // An entry without an id cannot address a room, and a session keyed on it would be
    // unreachable garbage, so it is filtered rather than opened.
    return rooms.filter((room): room is RoomSummary =>
      typeof room === 'object' && room !== null
      && typeof (room as RoomSummary).id === 'string'
      && (room as RoomSummary).id.length > 0)
  }

  /**
   * Rooms this account could join, which is a different question from the rooms it is in.
   *
   * `listRooms` answers "my rooms" and the server scopes it to membership. A `discoverable`
   * room the caller has not joined is therefore absent from that list, and a room the operator
   * can see no way to reach is indistinguishable from one that does not exist. This separate
   * read is what lets the picker offer them.
   */
  async listDiscoverableRooms(query?: string, signal?: AbortSignal): Promise<readonly RoomSummary[]> {
    const suffix = query === undefined || query.trim().length === 0
      ? ''
      : `?query=${encodeURIComponent(query.trim())}`
    const rooms = await this.request<unknown>('GET', `/api/ai/chat/rooms/search${suffix}`, undefined, signal)
    if (!Array.isArray(rooms)) return []
    // Same shape guard as `listRooms`, plus the `joined` filter: this server route deliberately
    // answers both questions at once (rooms you are in *and* rooms you could join), but a caller
    // asking for discovery wants only the second. Filtering here keeps that rule in the half
    // that owns the route, so the browser never has to remember it.
    return rooms.filter((room): room is RoomSummary =>
      typeof room === 'object' && room !== null
      && typeof (room as RoomSummary).id === 'string'
      && (room as RoomSummary).id.length > 0
      && (room as RoomSummary).joined === false)
  }

  /**
   * Join a room the caller is entitled to join.
   *
   * Whether the caller may join is the server's decision, not this client's: discoverability,
   * invite policy and existing membership are all facts the server holds and can change between
   * the search that offered the room and the press that takes it. Repeating that rule here
   * would be a second, divergent copy — so the answer is forwarded verbatim.
   */
  async joinRoom(roomId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request<unknown>(
      'POST', `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/join`, undefined, signal,
    )
  }

  /**
   * The account this workspace acts as, asked of the server rather than configured.
   *
   * The bearer credential already identifies the caller, so the server is the only
   * correct source for "who am I": a configured value could disagree with the
   * credential and silently change which messages trigger this agent.
   */
  /**
   * Ask the server who this workspace is.
   *
   * The response wraps the account: `/api/auth/me` answers `{ user: { id, ... } }`, not a
   * bare account. Reading the id off the top level yields `undefined` for every call,
   * which would leave the workspace unidentified — and an unidentified workspace still
   * records every message but can never match "the sender is me", so no turn ever starts
   * and the agent is silent with nothing in the logs to say why.
   */
  async whoami(signal?: AbortSignal): Promise<{
    readonly id: string
    readonly displayName?: string
    /**
     * The account's role codes, when the server reports them.
     *
     * Carried here rather than fetched by the browser for the same reason as the name: the
     * client half never talks to DataOps directly. Only used to decide whether to offer
     * dissolving a room the reader does not own; the room server still decides the request.
     */
    readonly roleCodes?: readonly string[]
  } | undefined> {
    try {
      const me = await this.request<{
        user?: { id?: unknown; displayName?: unknown; roles?: readonly { code?: unknown }[] }
      }>(
        'GET', '/api/auth/me', undefined, signal,
      )
      const id = me.user?.id
      if (typeof id !== 'string' || id.length === 0) return undefined
      // The name travels alongside the id because the browser shows it — the roster and the
      // message prefix both come from the server, and re-reading `/api/auth/me` there would
      // be the browser talking to DataOps, which this client half never does.
      const displayName = me.user?.displayName
      const roleCodes = Array.isArray(me.user?.roles)
        ? me.user.roles.map((role) => role?.code).filter((code): code is string => typeof code === 'string')
        : undefined
      let out: { id: string; displayName?: string; roleCodes?: readonly string[] } = { id }
      if (typeof displayName === 'string' && displayName.length > 0) out = { ...out, displayName }
      if (roleCodes !== undefined && roleCodes.length > 0) out = { ...out, roleCodes }
      return out
    } catch {
      // An unidentified workspace still records every message; it simply never
      // starts a turn, because "the sender is me" cannot be established.
      return undefined
    }
  }

  async listMembers(roomId: string, signal?: AbortSignal): Promise<readonly RoomMember[]> {
    return this.request<readonly RoomMember[]>('GET', `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/members`, undefined, signal)
  }

  /**
   * Accounts that match `q` and are not already in the room.
   *
   * The search runs here, on the host, because the browser holds no credential of its own:
   * a client-side filter over a full directory is not an option, since the browser cannot
   * read one. An absent query is sent as no parameter rather than an empty one, because an
   * empty keyword is a browsable first page, which is what makes the picker useful before
   * anything is typed.
   */
  async inviteCandidates(
    roomId: string,
    q?: string,
    signal?: AbortSignal,
  ): Promise<readonly InviteCandidate[]> {
    const query = new URLSearchParams()
    if (q !== undefined && q.length > 0) query.set('q', q)
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    return this.request<readonly InviteCandidate[]>(
      'GET',
      `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/invite-candidates${suffix}`,
      undefined,
      signal,
    )
  }

  /**
   * Pull events after `cursor`. Omitting the cursor asks for the room from the start,
   * which is what a fresh container does on its first sync.
   */
  /**
   * Searches message text across the rooms this account can read.
   *
   * The visibility rule lives on the room server: it decides which rooms the caller may read and
   * narrows the query there. Forwarding the words alone is deliberate — a copy of that rule in
   * the plugin would be a second place to get authorization wrong.
   */
  async searchMessages(query: string, signal?: AbortSignal): Promise<readonly unknown[]> {
    const params = new URLSearchParams({ query })
    return this.request<readonly unknown[]>(
      'GET',
      `/api/ai/chat/rooms/messages/search?${params.toString()}`,
      undefined,
      signal,
    )
  }

  async listEvents(roomId: string, cursor?: string, limit?: number, signal?: AbortSignal): Promise<EventPage> {
    const query = new URLSearchParams()
    if (cursor !== undefined) query.set('cursor', cursor)
    if (limit !== undefined) query.set('limit', String(limit))
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    return this.request<EventPage>('GET', `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/events${suffix}`, undefined, signal)
  }

  /**
   * Send one human message. `rpcId` is the idempotency key: a retry that reuses it
   * returns the original row instead of creating a second one, so a timed-out
   * request is safe to repeat.
   */
  async sendMessage(
    roomId: string,
    input: {
      /**
       * The message's content blocks, or plain text.
       *
       * Blocks rather than a string because a member's message can carry an image or an
       * attachment, and flattening it here would drop them before the server ever saw them.
       * A plain string stays accepted for the callers that only ever send words.
       */
      readonly content: string | readonly ContentBlockLike[]
      readonly rpcId: string
      readonly mentions?: readonly string[]
    },
    signal?: AbortSignal,
  ): Promise<{ readonly id: string; readonly event: RoomEvent; readonly deduplicated: boolean }> {
    return this.request('POST', `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/messages`, input, signal)
  }

  /**
   * Create a room.
   *
   * `cwd` and the preset decide what the room's agent may touch on any member's behalf, so
   * they are creation-time scopes rather than later settings.
   */
  async createRoom(
    name: string,
    execution?: {
      readonly cwd?: string
      readonly agentPreset?: string
      readonly actor?: unknown
      readonly externalChannel?: ExternalChannel
    },
    signal?: AbortSignal,
  ): Promise<RoomSummary> {
    return this.request<RoomSummary>('POST', '/api/ai/chat/rooms', {
      name,
      ...execution === undefined ? {} : execution,
    }, signal)
  }

  /** Apply a room's policy fields. Only the room's owner may do this. */
  async updateRoom(
    roomId: string,
    patch: {
      readonly name?: string
      readonly invitePolicy?: string
      readonly discoverability?: string
      readonly agentTrigger?: string
    },
    signal?: AbortSignal,
  ): Promise<RoomSummary> {
    return this.request<RoomSummary>(
      'POST',
      `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/update`,
      patch,
      signal,
    )
  }

  /**
   * Set or clear a room's announcement.
   *
   * Who may write it is the server's decision, not this client's: ownership is a fact the
   * server holds and can change between the roster read that rendered the editor and the save
   * that commits it, so repeating that rule here would be a second, divergent copy — and one
   * that could hide the editor from an owner the server will actually accept.
   */
  async setAnnouncement(roomId: string, announcement: string, signal?: AbortSignal): Promise<unknown> {
    return this.request<unknown>(
      'POST',
      `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/announcement`,
      { announcement },
      signal,
    )
  }

  /** Add members to a room, subject to that room's invite policy. */
  async inviteMembers(
    roomId: string,
    userIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request('POST', `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/members`, { userIds }, signal)
  }

  /**
   * Remove one member from a room.
   *
   * The server decides who may do this (owner only) and refuses the owner as a target; this
   * call only carries the request, so a refusal surfaces as the server's own status code.
   */
  async removeMember(roomId: string, userId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(
      'DELETE',
      `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}`,
      undefined,
      signal,
    )
  }

  /** Leave a room. Its history stays on the server; the owner cannot leave. */
  async leaveRoom(roomId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('DELETE', `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/members/me`, undefined, signal)
  }

  /**
   * End a room for every member.
   *
   * A different request from {@link leaveRoom}, not a variant: that one removes this caller's
   * membership and leaves the room standing, while this one deletes the room itself. The server
   * decides who may do it, so a refusal is forwarded rather than pre-empted here.
   */
  async transferOwnership(roomId: string, userId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(
      'POST',
      `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/transfer`,
      { userId },
      signal,
    )
  }

  async dissolveRoom(roomId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('DELETE', `/api/ai/chat/rooms/${encodeURIComponent(roomId)}`, undefined, signal)
  }

  /**
   * Report one agent reply. Only the turn's final `assistant/message` is sent —
   * intermediate steps stay in this container by construction.
   */
  async reportAgentEvent(
    roomId: string,
    input: { readonly rpcId: string; readonly event: RoomEvent },
    signal?: AbortSignal,
  ): Promise<{ readonly id: string; readonly event: RoomEvent; readonly deduplicated: boolean }> {
    return this.request('POST', `/api/ai/chat/rooms/${encodeURIComponent(roomId)}/agent-events`, input, signal)
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    // The credential is resolved before the attempt, so a missing one fails here
    // rather than travelling as an anonymous request.
    const headers = await this.headers()
    let response: Response
    try {
      response = await this.fetchImpl(`${this.target.baseUrl}${path}`, {
        method,
        headers,
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: composed,
      })
    } catch (error) {
      // Network and timeout failures are not backend decisions; the caller may retry.
      throw new Error(`group-chat backend unreachable: ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }

    const text = await response.text()
    const parsed: unknown = text.length === 0 ? undefined : safeJson(text)
    if (!response.ok) {
      throw new BackendError(
        `group-chat backend rejected ${method} ${path} (${response.status})`,
        response.status,
        parsed,
      )
    }
    return parsed as T
  }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
