/**
 * The room list both client surfaces read.
 *
 * It lives here rather than inside either component because the sidebar region and the
 * room page must never show different lists. It is a plain observable, not a framework
 * store: both consumers are components this plugin already owns.
 *
 * The slot caches the value its `inject` factory returns, so a snapshot taken at inject
 * time would freeze at the first read. Consumers therefore subscribe through
 * `useSyncExternalStore` and re-read on every change.
 *
 * @module @sparkelf/dsh-group-chat/client/store
 */

import {
  dissolveRoom, joinRoom, leaveRoom, removeMember, transferOwnership, listDiscoverableRooms, listMembers, listRooms, readSelf,
  type RoomMember, type RoomSummary, updateRoom,
} from './api.ts'
import type { GroupChatKey } from './locales.ts'

/** The three distinguishable failures the surfaces render as copy. */
export type RoomFailure = GroupChatKey | undefined

export interface RoomState {
  /** `undefined` until the first read completes, so the UI can tell loading from empty. */
  readonly rooms: readonly RoomSummary[] | undefined
  /** The room the main panel is showing, if any. */
  readonly activeRoomId: string | undefined
  readonly failure: RoomFailure
  /**
   * Why the last room selection could not be shown, when the Session it names is missing or the
   * view refused it. Separate from {@link failure}: that one means the room list itself could not
   * be read, and it replaces the list, while this one leaves every room selectable.
   */
  readonly openFailure: GroupChatKey | undefined
  /**
   * The sidebar's search box contents.
   *
   * Held here rather than in the region because the header collapses while a query is
   * present, and the region must survive that collapse with its text intact.
   */
  readonly searchQuery: string
  /**
   * This workspace's own account id, once the Host reports it.
   *
   * Held in the store because the message renderer needs it while rendering, and that
   * renderer is not a component that can wait on an effect: it decides a message's side
   * during the render in which the message appears. Undefined until the first read
   * completes, and the renderer treats "unknown" as "not mine" rather than guessing.
   */
  readonly selfId: string | undefined
  /**
   * Whether the deployment reports this reader as an administrator.
   *
   * Only used to decide whether to offer dissolving a room they do not own; the room server
   * decides on the request itself, so a stale `true` costs a refusal, not a wrong delete.
   */
  readonly administrator: boolean
  /**
   * Room members by room id, so a message can be drawn with its author's name and picture.
   *
   * A message event carries only the author's id. The name and the picture live on the roster,
   * which is a different request, so the renderer needs this lookup to avoid drawing a bare id
   * or initials derived from one.
   *
   * Kept per room rather than as one flat list because the same account can be a member of
   * several rooms and can leave some of them: a flat map would keep drawing a person in a room
   * they are no longer in.
   */
  readonly members: Readonly<Record<string, readonly RoomMember[]>>
  /**
   * Whether the create-room dialog is open.
   *
   * The sidebar's + button sets it and the page half renders the dialog: the sidebar seat
   * is a thin band, and a modal belongs to the surface that owns the window.
   */
  readonly pendingCreate: boolean
  /**
   * Rooms the operator could join, or `undefined` before the first discovery read.
   *
   * `undefined` rather than `[]` on purpose: an empty array means "the search answered, and
   * nothing is joinable", while `undefined` means "nobody has asked yet". Collapsing the two
   * would show an empty discovery section before the operator ever searched.
   */
  readonly discoverable: readonly RoomSummary[] | undefined
  /** The room dialog the row menu opened, if any. Rendered by the page half. */
  readonly dialog: RoomDialog | undefined
}

/**
 * A room dialog opened from a row's context menu.
 *
 * The menu lives in the sidebar and the dialogs live on the page, so the request travels
 * through the store rather than through component nesting.
 */
export type RoomDialog =
  | { readonly kind: 'invite'; readonly roomId: string }
  | { readonly kind: 'settings'; readonly roomId: string }
  | { readonly kind: 'members'; readonly roomId: string }
  /**
   * Hand the room over. Only reachable from the owner's own menu, because the action that
   * makes leaving possible for an owner is exactly this one.
   */
  | { readonly kind: 'transfer'; readonly roomId: string }

export interface RoomStore {
  getState: () => RoomState
  subscribe: (listener: () => void) => () => void
  /** Re-read the room list from the Host route. */
  refresh: () => Promise<void>
  /** Select a room; the main panel follows this. */
  open: (roomId: string) => void
  /** This workspace's own account id, or `undefined` while it is still unknown. */
  selfId: () => string | undefined
  administrator: () => boolean
  setFailure: (failure: RoomFailure) => void
  setSearch: (query: string) => void
  /**
   * Read the rooms this account could join.
   *
   * Separate from `refresh` because it is asked only when the operator is looking for
   * something to join: folding it into the sidebar's periodic read would put a second
   * cross-account query on every poll.
   *
   * @param query - optional narrowing keyword, applied by the server.
   */
  discover: (query?: string) => Promise<void>
  /**
   * Read one room's roster, so its messages can be drawn with their authors' names and pictures.
   *
   * Called when a room is opened rather than on every refresh: a roster changes rarely, and the
   * message stream does not require it to be current to be readable. A failed read leaves the
   * previous roster in place instead of clearing it, because an empty roster would redraw every
   * message in the room as an unknown author.
   *
   * @param roomId - the room whose roster to read.
   */
  loadMembers: (roomId: string) => Promise<void>
  /**
   * Join a room, then re-read both lists.
   *
   * The room moves from the discovery list to the sidebar in one step, so a successful join
   * cannot leave the same room visible in both places.
   *
   * @param roomId - the room to join.
   */
  join: (roomId: string) => Promise<void>
  /** Apply one policy to an existing room, then re-read so both surfaces agree. */
  setPolicy: (
    roomId: string,
    patch: { invitePolicy?: string; discoverability?: string; agentTrigger?: string },
  ) => Promise<void>
  /** Open the create-room dialog. */
  openCreate: () => void
  closeCreate: () => void
  /** Open one room dialog; `undefined` closes whatever is open. */
  setDialog: (dialog: RoomDialog | undefined) => void
  /**
   * Show the members panel for one room in the right sidebar.
   *
   * Supplied by the plugin's apply step rather than implemented here: opening a sidebar tab is a
   * shell concern, and this store owns room data only. Leaving it optional keeps the store
   * testable without a live sidebar and lets a profile without one keep the room list working.
   */
  openMembers: ((roomId: string) => void) | undefined
  /** Rename a room, then re-read so both surfaces show the new name. */
  rename: (roomId: string, name: string) => Promise<void>
  /** Leave a room. */
  leave: (roomId: string) => Promise<void>
  /**
   * Remove another member.
   *
   * Distinct from `leave`: this acts on someone else's membership, so the server restricts it
   * to the owner and refuses the owner as a target. Refreshing the list afterwards is what
   * updates every surface's roster.
   */
  removeMember: (roomId: string, userId: string) => Promise<void>
  /**
   * End a room for every member.
   *
   * Separate from `leave` on purpose: the two have different audiences and different
   * consequences, and a surface that offers one must not be mistaken for the other.
   */
  dissolve: (roomId: string) => Promise<void>
  /**
   * Hand ownership to another member.
   *
   * A room's owner cannot leave it, so this is the action that makes leaving possible for them.
   * The server decides both eligibility questions (is the caller the owner, is the target a
   * member), so the client only carries the choice.
   */
  transfer: (roomId: string, userId: string) => Promise<void>
}

/**
 * Create the shared store.
 * @returns a store whose `getState` returns a stable reference between changes, which is
 *   what `useSyncExternalStore` requires to avoid a render loop.
 */
/**
 * What the store needs from the shell to make a selected room the main view.
 *
 * Injected rather than imported so the module stays a pure state container: a test can assert
 * which Session was asked for without a layout, and the plugin wires the real catalog in.
 */
export interface RoomStoreDeps {
  /**
   * Make one room the view. The Host resolves the room's Session and the workspace that owns it,
   * then the shell selects that Session; the store only reports the outcome.
   */
  readonly openSession?: (roomId: string) => Promise<void>
}

export function createRoomStore(deps: RoomStoreDeps = {}): RoomStore {
  let state: RoomState = {
    rooms: undefined,
    activeRoomId: undefined,
    failure: undefined,
    openFailure: undefined,
    searchQuery: '',
    selfId: undefined,
    administrator: false,
    members: {},
    pendingCreate: false,
    // Undefined, not empty: nobody has searched yet, which is a different fact from
    // "searched and found nothing joinable".
    discoverable: undefined,
    dialog: undefined,
  }
  const listeners = new Set<() => void>()

  const set = (patch: Partial<RoomState>): void => {
    // A fresh object per change, so `getState` is referentially stable between changes.
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  /**
   * Read one room's roster into the store.
   *
   * A failure leaves the previous roster in place rather than clearing it: the room is still
   * readable without names (the renderer falls back to an unlabelled bubble), and a stale name is
   * still the right person far more often than no name at all.
   *
   * @param roomId - the room whose roster to read.
   */
  const loadMembersInto = async (roomId: string): Promise<void> => {
    try {
      const roster = await listMembers(roomId)
      set({ members: { ...state.members, [roomId]: roster } })
    } catch {
      // Deliberately silent: a roster that could not be read is not a room failure, and the
      // message list keeps working with what it already has.
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh: async () => {
      // Resolved alongside the room list rather than in its own pass: identity is what the
      // message renderer needs, and a list that arrived while identity was still unknown
      // would draw the operator's own first messages on the wrong side.
      void readSelf().then((self) => {
        if (self !== undefined) set({ selfId: self.id, administrator: self.administrator })
      })
      try {
        const rooms = await listRooms()
        set({ rooms, failure: undefined })
        // Read every joined room's roster, not only the open one. A reload lands directly on a
        // room's Session without going through `open`, and a message must be attributable the
        // first time it paints — waiting for an interaction would leave the first screen of
        // every room unlabelled. Only rooms without a roster are read, so the periodic refresh
        // does not repeat this for data that rarely changes.
        for (const room of rooms) {
          if (!room.joined || state.members[room.id] !== undefined) continue
          void loadMembersInto(room.id)
        }
      } catch (error) {
        // The sidebar may load before the server is reachable; the page shows the
        // reason, and the next refresh clears it.
        set({ failure: failureOf(error) })
      }
    },
    open: (roomId) => {
      // Opening a room is the reader's acknowledgement: clear the mention/unread badge
      // immediately rather than waiting for the next room-list refresh, which is also what
      // makes the badge disappear the moment the conversation is on screen.
      set({
        activeRoomId: roomId,
        openFailure: undefined,
        ...(state.rooms === undefined
          ? {}
          : { rooms: state.rooms.map(room => room.id === roomId ? { ...room, unreadCount: 0, mentionCount: 0 } : room) }),
      })
      // Read on open rather than on every side-bar refresh: the roster changes rarely, and the
      // side bar refreshes every few seconds — fetching it there would be a steady stream of
      // requests for data that almost never differs.
      void loadMembersInto(roomId)
      // Selecting the room IS selecting its Session: a room has exactly one, its id is
      // deterministic, and the Host resolved-or-created it when it opened the room. Without this
      // the sidebar highlight moved while the main column kept the previous Session -- the room
      // looked open and the composer under it belonged to a different conversation.
      // The Host owns Session and workspace resolution: the browser cannot attach a Session to a
      // workspace, and selecting one that no workspace owns leaves the previous view up. Awaiting
      // it also lets a refusal surface instead of looking like a dead button.
      void Promise.resolve()
        .then(() => deps.openSession?.(roomId))
        .catch((error: unknown) => {
          console.error('[group-chat] opening the room failed', roomId, error)
          set({ openFailure: 'roomOpenFailed' })
        })
    },
    discover: async (query) => {
      try {
        set({ discoverable: await listDiscoverableRooms(query) })
      } catch (error) {
        // An unreadable discovery list is not a broken sidebar: the joined rooms are still
        // there and still usable, so the failure is reported without clearing the list.
        set({ discoverable: [], failure: failureOf(error) })
      }
    },
    join: async (roomId) => {
      await joinRoom(roomId)
      // Re-read both lists: the room is now a member room, so leaving it in `discoverable`
      // would let the operator press Join again on a room they are already in.
      set({ rooms: await listRooms(), discoverable: await listDiscoverableRooms() })
    },
    selfId: () => state.selfId,
    administrator: () => state.administrator,
    setFailure: (failure) => set({ failure }),
    setSearch: (searchQuery) => set({ searchQuery }),
    loadMembers: loadMembersInto,
    setPolicy: async (roomId, patch) => {
      await updateRoom(roomId, patch)
      set({ rooms: await listRooms() })
    },
    openCreate: () => set({ pendingCreate: true }),
    closeCreate: () => set({ pendingCreate: false }),
    setDialog: (dialog) => set({ dialog }),
    openMembers: undefined,
    rename: async (roomId, name) => {
      await updateRoom(roomId, { name })
      set({ rooms: await listRooms() })
    },
    leave: async (roomId) => {
      await leaveRoom(roomId)
      // The room stays listed under the "show left rooms" filter, so the selection is
      // cleared by refreshing rather than by forgetting the room.
      set({ rooms: await listRooms(), activeRoomId: undefined })
    },
    removeMember: async (roomId, userId) => {
      await removeMember(roomId, userId)
      // The roster is the only thing that changed; the room list itself keeps the same
      // rooms, so a full re-read is enough and refreshes the member count too.
      set({ rooms: await listRooms() })
    },
    dissolve: async (roomId) => {
      await dissolveRoom(roomId)
      // Unlike leaving, the room is gone for everyone: there is no "left rooms" entry to
      // refresh into, so the selection is cleared and the list re-read without it.
      set({ rooms: await listRooms(), activeRoomId: undefined })
    },
    transfer: async (roomId, userId) => {
      await transferOwnership(roomId, userId)
      // Ownership is a field on the room, so the refreshed list is what updates everyone's
      // notion of who runs it — including this reader's, who is now an ordinary member.
      set({ rooms: await listRooms() })
    },
  }
}

/** Map a transport failure onto the copy key the surfaces render. */
export const failureOf = (error: unknown): GroupChatKey => {
  const message = error instanceof Error ? error.message : ''
  if (message === 'credentialMissing') return 'credentialMissing'
  if (message === 'credentialRejected') return 'credentialRejected'
  if (message === 'notConfigured') return 'notConfigured'
  if (message === 'ownerCannotLeave') return 'ownerCannotLeave'
  return 'unreachable'
}
