/**
 * Group-chat Client plugin.
 *
 * Registers two official DSH surfaces:
 * - `sidebar.footer.action` renders the group-chat region at the sidebar foot, under the
 *   workspace list and above Settings. The shell positions it inside `footerActions`
 *   (full width, `flex: none`); this plugin draws the section header and the flat room
 *   list. It is an ordinary list seat, so no other plugin's contribution is disturbed.
 * - The matching `main` key gives the room page the region's rows select, so a room opens
 *   in the main column rather than replacing the navigation column.
 *
 * This half owns the room list so the two surfaces cannot disagree about which rooms
 * exist. Both read the one store below and both re-read through the same action.
 *
 * The page is a pure consumer of the Host plugin's `/dsh-group-chat/api` route, so every
 * room operation it performs is the same call the agent's own turn makes. The browser
 * never talks to DataOps directly and never handles a credential: the Host holds the
 * workspace identity, and this half only renders what that identity can already see.
 *
 * @module @sparkelf/dsh-group-chat/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Brings in the official `sidebarRight` / `sidebarRightTabs` members this plugin consumes, the
// right-sidebar slot names it registers into, and the merge map its page parameters are typed by.
// The augmentation lives in the package's `/client` entry, so importing it is what makes those
// names real in this compilation.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
// The slot this plugin shadows needs a local declaration; see the module doc comment.
import './contract.ts'
import { SidebarRooms, type SidebarRoomsInjected } from './SidebarRooms.tsx'
import { MessageSide } from './MessageSide.tsx'
import {
  MembersPanel, MEMBERS_TAB_KIND, MembersTabTitle,
  type MembersPanelInjected,
} from './MembersPanel.tsx'
import { MembersGuideEntry, type MembersGuideEntryProps } from './GuideEntry.tsx'
import { createRoomStore, type RoomStore } from './store.ts'
import { registerMessageSource, type InputTriggersLike } from './messageReference.ts'
import { registerMemberSource } from './memberReference.ts'
import { PRESET_LOCALE_NS } from './rows.ts'
import { roomSessionId } from '../session-id.ts'
import { openRoom, readRoomState } from './api.ts'
import { en, zh, type GroupChatKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.groupChat': GroupChatKey
  }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  /**
   * The navigation parameters this page type accepts.
   *
   * The official service types `openTab`'s `params` by this map, and a kind that declares none
   * accepts `undefined` only. Declaring the room here keeps the opener typed against the body's
   * real contract instead of casting the service to a looser shape.
   */
  interface SidebarRightTabParamsMap {
    groupChatMembers: { readonly roomId: string }
  }
}

const NS = 'settings.groupChat'

/**
 * The `user` cell this plugin shadows, and the one the official Chat renderer occupies.
 *
 * Named rather than inlined because shadowing is a two-sided fact: winning the cell means
 * reading past the winner to find what would have rendered.
 */
const CHAT_NODE_SLOT = 'conversation.chat.node'

/**
 * Every `user`-shaped cell of the chat-node seat.
 *
 * `user` and `steering` are separate cells that render the *same* official component: a room
 * message is `steering` once a turn has claimed it and `user` otherwise, so shadowing only
 * `user` would leave exactly the messages that arrived while the agent was working on the
 * right. Both are cell-local shadows, so neither reaches an ordinary Session: the side is
 * decided from the message's own room source, and an ordinary message has none.
 */
const CHAT_NODE_KEYS = ['user', 'steering'] as const

/** Priority this plugin claims its chat-node cells at; the official entries sit at `0`. */
const SHADOW_PRIORITY = -1

/**
 * This plugin's own chat-node renderer, so the lookup below cannot mistake it for the
 * official one. Compared by identity against the registered component.
 */
const OUR_VIEW = MessageSide

/**
 * The entry the shell would render for one cell without this plugin.
 *
 * The registry projects shadowing winners through `entriesOfSlot`, which is exactly the
 * wrong question here — this plugin is the winner. `entries` keeps the whole ledger, so the
 * official entry is still visible, and picking the lowest-priority live one other than this
 * plugin's own reproduces the pre-plugin choice.
 *
 * @param ledger - every registered entry for the chat-node slot.
 * @param key - the cell being claimed.
 * @param ours - this plugin's own component, excluded from the candidates.
 * @returns the official component, or `undefined` when nothing else is registered.
 */
const officialViewFor = (
  ledger: readonly StoredEntry[],
  key: string,
  ours: unknown,
): StoredEntry['component'] | undefined =>
  ledger
    .filter((entry) => entry.options.key === key && entry.component !== ours)
    .reduce<StoredEntry | undefined>(
      (lowest, entry) =>
        lowest === undefined || (entry.options.priority ?? 0) < (lowest.options.priority ?? 0)
          ? entry
          : lowest,
      undefined,
    )?.component

/**
 * Report why one chat-node cell could not be claimed.
 *
 * A rejected claim is not fatal — the official renderer still draws that cell — but it does
 * mean the side never flips, which is invisible in the UI. The console is the only channel
 * this half has, and the message has to name the cell so the missing side can be traced to it.
 */
const logClaimFailure = (key: string, error: unknown): void => {
  console.warn(`[group-chat] could not claim the "${key}" chat-node cell; messages of this kind stay on the official side`, error)
}

/** Main-panel key the sidebar rows select. */
const PANEL_ID = 'group-chat' as MainPanelId


/**
 * The members tab type.
 *
 * `MEMBERS_TAB_ID` keys the type's slot entries; `MEMBERS_TAB_KIND` is what `openTab` resolves.
 * They are separate values because the sidebar stores a placed tab by kind while the slot ledger
 * is keyed by id — the same split the official schedule plugin makes.
 */
const MEMBERS_TAB_ID = '@sparkelf/dsh-group-chat/members'

/** Id of the pending-reply bar in the composer's dock. */
const QUOTE_DOCK_ID = '@sparkelf/dsh-group-chat/quote'

/**
 * The guide entry's own identity, and where it sorts on the start page.
 *
 * An id rather than the tab's: the guide lists one box per entry, and the id is what the
 * entry-level slot replacement below is keyed by. The order lands the box among the other
 * `extension` types instead of at either end.
 */
const MEMBERS_GUIDE_ID = '@sparkelf/dsh-group-chat/members-guide'
const MEMBERS_GUIDE_ORDER = 60
/** Client services required for these contributions. */
/**
 * The Workspace navigation service, declared structurally.
 *
 * `@deepseek-ai/dsh-client-ui-workspace` is not a dependency of this package and declaring it as
 * one would tie the plugin to the plugin that happens to own the service today. Only the one
 * method used here is named, which is also what keeps this honest: the room opens the way a
 * session row opens, and nothing else about that plugin is assumed.
 */
interface WorkspaceNavigation {
  /**
   * Select a Session and show its Conversation.
   * @param sessionId - the room's Session, which `roomSessionId` derives from the room.
   */
  openSession(sessionId: string): void
}

/**
 * The slice of the Workspace controller this package needs.
 *
 * A dissolved room's Session outlives the room: it is a durable record, so the shell keeps
 * listing it under whatever grouping it landed in. Archiving is the documented way to take a
 * Session off those surfaces without destroying it, and it is exactly what the shell's own
 * "archive session" action does.
 */
interface WorkspaceArchive {
  archiveSession(sessionId: string, options?: { readonly stopActivity?: boolean }): Promise<void>
  /** Remove a Workspace registration; its Sessions and files are kept. */
  delete(workspaceId: string): Promise<void>
  /** Host-authoritative Workspace rows, including each one's owning Session ids. */
  readonly list: { getSnapshot(): WorkspaceListSnapshot | undefined }
}

/** The fields of the Workspace snapshot this package reads. */
interface WorkspaceListSnapshot {
  readonly phase?: string
  readonly items: readonly {
    readonly workspaceId: string
    readonly path: string
    readonly sessionIds: readonly string[]
  }[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Workspace navigation, contributed by the workspace picker plugin. */
    readonly uiWorkspace: WorkspaceNavigation
    /** Workspace state and commands, contributed by the workspace controller plugin. */
    readonly workspaces: WorkspaceArchive
  }
}

export const inject = ['slots', 'locale', 'uiWorkspace', 'workspaces', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'layout']

/**
 * Register the sidebar region and the room page.
 * @param ctx - DSH client context with locale and slot registries.
 */
export function apply(ctx: ClientContext): void {
  const context = ctx as unknown as {
    sidebarRight?: { openTab(kind: string, options: { params: { url: string } }): void }
    get?: (name: string) => unknown
  }
  const sidebarRight = (context.sidebarRight ?? context.get?.('sidebarRight')) as
    { openResource?(address: string): void } | undefined
  const openRoomFile = (attachment: { attachmentId: string; name: string; bytes: number }, roomId: string): void => {
    const query = 'attachmentId=' + encodeURIComponent(attachment.attachmentId)
      + '&name=' + encodeURIComponent(attachment.name)
      + '&bytes=' + encodeURIComponent(String(attachment.bytes))
    void (async () => {
      const materialized = await fetch('/dsh-group-chat/api/attachment-materialize?' + query)
      if (!materialized.ok) throw new Error('附件预览准备失败')
      const target = await materialized.json() as { path?: string }
      if (typeof target.path !== 'string') throw new Error('附件预览路径缺失')
      const sessionId = 'group-room-' + roomId
      const address = 'dsh-resource://file/session/' + encodeURIComponent(sessionId)
        + '/' + target.path.split('/').map((part) => encodeURIComponent(part)).join('/')
      if (sidebarRight !== undefined && sidebarRight.openResource !== undefined) {
        sidebarRight.openResource(address)
        return
      }
      const fallback = new URL('/dsh-group-chat/api/attachment-preview?' + query, window.location.origin).toString()
      window.open(fallback, '_blank', 'noopener,noreferrer')
    })().catch((error) => {
      console.error('[group-chat] file preview failed', error)
    })
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'group-chat: copy')
  const t = ctx.locale.bind(NS) as (key: GroupChatKey) => string
  // A second binding rather than a merged dictionary: the preset copy belongs to the platform's
  // `settings.agentPreset` namespace, and a preset name this plugin translated itself would
  // drift from the hero chip that shows the same preset under the same id.
  const tPreset = ctx.locale.bind(PRESET_LOCALE_NS) as (key: string) => string

  // One store shared by both surfaces, created here because the sidebar must show the
  // same list the page is operating on.
  // The store selects the room's Session; the catalog is the shell's, so it is wired here rather
  // than imported there. `hasSession` keeps a room the Host has not opened yet from silently
  // replacing the main view with an unknown id.
  // `uiWorkspace.openSession` is the shell's own "show this Session" entry: it selects the Session
  // and leaves the panel mode, which is exactly what a sidebar click does. The `sessions` service
  // exposes the catalog, not navigation, so it is the wrong handle here.
  const navigation = ctx.get('uiWorkspace') as { openSession?: (sessionId: string) => void } | undefined
  if (navigation?.openSession === undefined) {
    // Without navigation a selected room cannot become the view; say so once rather than letting
    // every click look like a dead button.
    console.warn('[group-chat] uiWorkspace.openSession is unavailable; room selection cannot navigate')
  }
  // A panel left open would keep the main column on itself, so the same call the shell's own
  // navigation makes clears it after the Session is selected.
  const layout = ctx.get('layout') as { selectPanel?: (panel: null) => void } | undefined
  // The catalog was read before the room had a workspace, so the Session the Host just made
  // selectable is not in it yet; `openSession` refuses an unknown id. Re-reading the list first is
  // what turns the freshly attached Session into a selectable one.
  const catalog = ctx.get('sessions') as { refresh?: () => Promise<void> } | undefined
  const base = createRoomStore({
    // The Host makes the room selectable (its Session belongs to a workspace it creates on
    // demand) and answers with the Session id the shell should select.
    openSession: async (roomId) => {
      const opened = await openRoom(roomId)
      // The room acts for the member who is looking at it, so the managed plugin stores this
      // request's gateway-attached DataOps JWT in the Session's own credential slot. Fire and
      // forget: the room opens on the workspace credential when the plugin is not mounted, and the
      // next message retries the slot.
      void fetch('integrations/dataops/managed-auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: opened.sessionId }),
      }).catch(() => { /* no managed plugin in this deployment */ })
      await catalog?.refresh?.()
      navigation?.openSession?.(opened.sessionId)
      layout?.selectPanel?.(null)
    },
  })
  // The one action that means "show me this room" is opening its Session, so every caller —
  // the row today, a keyboard shortcut or a deep link later — goes through it and no caller has
  // to remember a second step.
  const store: RoomStore = {
    ...base,
    open: (roomId) => {
      base.open(roomId)
      // Wait for the host to have the room's Session before asking the shell to open it.
      //
      // The host creates room Sessions on its own startup poll; a member who clicks a room in
      // the first seconds after the plugin comes up otherwise retains an id that does not exist
      // yet. That failure is quiet — the history still draws — but nothing written afterwards
      // lands, because the composer is bound to a session scope with no session behind it.
      void (async () => {
        for (let attempt = 0; attempt < 25; attempt += 1) {
          try {
            if ((await readRoomState(roomId)).open) break
          } catch {
            // A read that fails says nothing about readiness; the open below is still the best
            // thing to try, and the shell reports its own failure if the session is missing.
            break
          }
          await new Promise((resolve) => { setTimeout(resolve, 300) })
        }
        ctx.uiWorkspace.openSession(roomSessionId(roomId))
      })()
      // Opening a room is the operator saying "show me this conversation", and the roster is the
      // other half of it: who is in here, and what the room has announced. The tab is revealed
      // rather than forced — `openTab` focuses an already-placed tab of this type instead of
      // stacking a second one, so re-entering a room keeps whatever the operator had open beside
      // it, and a reader who closed the roster stays closed because nothing re-opens it later.
      // Reached through the store's own action so the timing rule lives in one place: the room has
      // to be the mounted Session before a right-sidebar tab can be placed beside it.
      queueMicrotask(() => { store.openMembers?.(roomId) })
    },
    /**
     * Dissolve a room, then take its Session off the shell's grouping surfaces.
     *
     * The room row disappears because the server deleted it, but the Session is a durable
     * record that outlives the room: `dissolveRoom` cannot reach it, so without this the
     * room's leftover workspace (from before rooms stopped registering one) and its Session
     * entry would stay listed for a conversation that no longer exists. Archiving is the
     * documented, reversible way to remove a Session from those surfaces — the same action
     * the shell's own "archive session" uses.
     *
     * Runs after the delete so a refused dissolve leaves the Session alone.
     */
    dissolve: async (roomId) => {
      await base.dissolve(roomId)
      try {
        await ctx.workspaces.archiveSession(roomSessionId(roomId), { stopActivity: true })
        // A room opened before rooms stopped registering one still owns a Workspace entry,
        // and dissolving it has to take that entry with it. Matched by the Session it owns
        // rather than by path: the path is the room's directory, and a room may have been
        // pointed at a directory a real workspace also uses — deleting by path would remove
        // that one.
        const sessionId = roomSessionId(roomId)
        const snapshot = ctx.workspaces.list.getSnapshot()
        for (const workspace of snapshot?.items ?? []) {
          if (!workspace.sessionIds.includes(sessionId)) continue
          await ctx.workspaces.delete(workspace.workspaceId)
        }
      } catch {
        // The room is gone either way; a Session that could not be archived is a leftover
        // row, not a failed dissolve. Saying so would make the delete look unsuccessful.
      }
    },
    /**
     * Open the members panel for a room.
     *
     * Two steps, in this order and not the other way round: the room has to be the *mounted*
     * Session before a right-sidebar tab can be placed beside it, because `openTab` acts on the
     * mounted seat and throws when there is none. `openSession` is synchronous in what it records
     * but the seat re-binds on the next frame, so the tab is opened on a zero-delay task rather
     * than inline — inline would aim at the session the operator is leaving.
     */
    openMembers: (roomId) => {
      // `sidebarRight` is injected, so it is live for this whole turn. Reading it through
      // `ctx.get` was the one-shot lookup that cannot see a service another plugin provides.
      const open = (): void => {
        // A page type that is not `multiple` is recorded under one address, and the official
        // service reveals the tab already at that address instead of stacking a second copy — so
        // re-entering a room focuses the page the reader already had, with no probing here.
        ctx.sidebarRight.openTab(MEMBERS_TAB_KIND, { params: { roomId } })
      }
      if (base.getState().activeRoomId === roomId) open()
      else setTimeout(open, 0)
    },
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: PANEL_ID,
    order: 20,
    inject: (): SidebarRoomsInjected => ({ t, tPreset, store }),
  }, SidebarRooms))

  /**
   * The members panel, as a tab in the official right sidebar.
   *
   * Three registrations, because the sidebar keeps three separate facts about a tab: the type it
   * belongs to (so navigation can resolve and persist it), the body to draw, and the chip that
   * labels it. `id` identifies the type's slot entries; `kind` is what `openTab` takes. They are
   * not the same value — the official schedule plugin uses
   * `"@deepseek-ai/dsh-client-ui-schedule/task"` and `"scheduleTask"` respectively — and
   * collapsing them would make `openTab` throw where nobody can see it.
   *
   * The panel is registered for every profile and decides at render time whether the Session it
   * was opened beside is a room. Registering conditionally instead would lose a placed tab on the
   * next reload: a tab whose type is gone cannot be restored.
   */
  // Registered through `ctx.inject`, not a one-shot `ctx.get`: the official right sidebar is a
  // separate plugin, so this one may load before the registry it contributes to exists. `inject`
  // runs the body when the service is present and re-runs it if the provider is replaced, which
  // is also what keeps the panel alive across an HMR of either side. A profile without the right
  // sidebar simply never runs this body, so the room list still comes up.
  //
  // The guide box is registered in the same body. That is deliberate: both entries are faces of
  // one page type, and a type that appears on the start page must be openable from it.
  /**
   * Open this plugin's page type from the start guide.
   *
   * The guide's shipped box opens through the guide's own `openTab`; a replacement box is not
   * handed that callback, so it goes through the same service the plugin already holds.
   */
  const openTabFromGuide = (kind: string): void => {
    // The shipped box opens through the guide's own `tab.actions.openTab`, which a replacement
    // box is not handed. This reaches the same service directly, so a click behaves exactly like
    // one on a shipped box: the type opens beside the guide the reader is looking at.
    // A click that cannot reach the sidebar is a wiring fault, not a reader's mistake: surface it
    // rather than leaving a dead box behind.
    try {
      ctx.sidebarRight.openTab(kind)
    } catch (error) {
      console.error('[group-chat] opening the members page failed', error)
    }
  }

  // The page type, its body, its title, and its start-guide box. `sidebarRightTabs` and
  // `sidebarRight` are injected (see the module's `inject`), so by the time `apply` runs they
  // are live: the official right sidebar always loads before the types that contribute to it.
  // A profile without that sidebar does not load this plugin at all, which is the intended
  // outcome — there would be nowhere to put the page.
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: MEMBERS_TAB_ID,
    kind: MEMBERS_TAB_KIND,
    // `extension` is the band for a type from outside the product; the default already means
    // exactly that, and naming it keeps the choice visible next to `builtin` types.
    priority: 'extension',
    title: () => t('membersTitle'),
    // The guide entry is what puts this type on the right sidebar's start page, beside Files,
    // Database and the rest. Omitting `guide` is the documented way to stay off that page.
    guide: [{
      id: MEMBERS_GUIDE_ID,
      order: MEMBERS_GUIDE_ORDER,
      title: () => t('membersTitle'),
      description: () => t('membersGuideHint'),
    }],
  }), 'group-chat: members tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: MEMBERS_TAB_ID,
    locale: NS,
    // The seat hands the inject factory the Session id and its bound actions, not a props
    // object; the panel needs the id to know which room it belongs to.
    inject: ((sessionId: string): MembersPanelInjected => ({ sessionId, t, store })) as never,
  }, MembersPanel)), 'group-chat: members tab body')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: MEMBERS_TAB_ID,
    locale: NS,
    inject: () => ({ t }),
  }, MembersTabTitle)), 'group-chat: members tab title')

  // Replace this type's own box on the start guide. The seat is keyed by the contributing
  // type's id, and the replacement decides per Session whether the box is drawn: the guide's
  // own list is global, so this is the only place the decision can be made.
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({
    name: 'sidebar.right.tab.guide.entry',
    key: MEMBERS_TAB_ID,
    locale: NS,
    // The seat calls an inject factory with the Session id; the box's own copy arrives as owner
    // props at render time, so this returns only what the factory itself must supply.
    inject: ((sessionId: string): Partial<MembersGuideEntryProps> => ({
      sessionId,
      onPick: () => { openTabFromGuide(MEMBERS_TAB_KIND) },
    })) as never,
  }, MembersGuideEntry)), 'group-chat: members guide box')

  // A file card lives inside the official Chat renderer, including occurrences that are
  // emitted before the room wrapper claims a cell. Delegate from the document so every file
  // card in a room opens the same right-Sidebar preview, regardless of which cell drew it.
  ctx.effect(() => {
    const onFileClick = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const card = target.closest('[data-message-attachments] > *')
      const roomId = store.getState().activeRoomId
      if (!(card instanceof HTMLElement) || roomId === undefined) return
      const name = (card.getAttribute('title') ?? card.innerText.split('\n')[0] ?? '').trim()
      if (name === '') return
      void (async () => {
        try {
          let cursor: string | null = null
          let found: { attachmentId: string; name: string; bytes: number } | undefined
          for (let page = 0; page < 20 && found === undefined; page += 1) {
            const suffix = cursor === null ? '' : '?cursor=' + encodeURIComponent(cursor)
            const response = await fetch('/dsh-group-chat/api/rooms/' + encodeURIComponent(roomId) + '/events' + suffix)
            if (!response.ok) return
            const payload = await response.json() as { events?: Array<{ event?: Record<string, unknown> }>; nextCursor?: string | null; hasMore?: boolean }
            for (const record of payload.events ?? []) {
              const data = record.event?.data as Record<string, unknown> | undefined
              const content = data?.content
              if (!Array.isArray(content)) continue
              for (const block of content) {
                if (block === null || typeof block !== 'object') continue
                const item = block as Record<string, unknown>
                const attachment = item.attachment as Record<string, unknown> | undefined
                if (item.type === 'file' && attachment?.name === name
                  && typeof attachment.attachmentId === 'string' && typeof attachment.bytes === 'number') {
                  found = { attachmentId: attachment.attachmentId, name, bytes: attachment.bytes }
                  break
                }
              }
              if (found !== undefined) break
            }
            if (payload.hasMore !== true || payload.nextCursor === null || payload.nextCursor === undefined) break
            cursor = payload.nextCursor
          }
          if (found !== undefined) openRoomFile(found, roomId)
        } catch (error) {
          console.error('[group-chat] file preview lookup failed', error)
        }
      })()
    }
    document.addEventListener('click', onFileClick, true)
    return () => { document.removeEventListener('click', onFileClick, true) }
  }, 'group-chat: file preview delegation')

  // A room is a Session. Its messages are ordinary `user/message` events on that Session's log,
  // so the shell's own Conversation already renders them — bubbles, markdown, tool calls,
  // streaming, scrollback. Opening the room is therefore one navigation action, not a panel to
  // draw: `openSession` is the same call the workspace list makes for its own rows.
  //
  // Anything the plugin drew here instead would be a second renderer that has to keep pace with
  // the first, and would silently drop every feature the Conversation gains.
  //
  // One thing the official renderer cannot know is which side a message belongs on: in an
  // ordinary Session the only author is the operator, so its user row is unconditionally
  // right-aligned. A room has several authors. Shadowing the `user`-shaped cells at a
  // negative priority is how those cells are reached — the renderer picks the lowest live
  // entry, and the official one sits at `0`. The shadowing entries render the official
  // component read back out of this same registry, so the bubble itself is not
  // reimplemented; only its placement is decided here.
  //
  // This waits for the official entries rather than reading the ledger once. `slots.inject`
  // re-runs on a *declaration* change, and the Chat node slot is declared by the shell's
  // root before any of its renderers register — so at this point the ledger can hold a
  // different cell's entry and nothing else. Reading it once would find no official `user`
  // view, and registering nothing is invisible: the cells would simply keep their official
  // alignment, with no error anywhere to say why. Subscribing to the slot is what makes the
  // claim happen whenever the official renderers actually arrive.
  ctx.slots.inject('conversation.chat.node', () => {
    let claims: (() => void)[] = []
    const release = (): void => {
      for (const dispose of claims) dispose()
      claims = []
    }
    const reconcile = (): void => {
      const ledger = ctx.slots.entries('conversation.chat.node')
      // Cells already claimed are left alone: re-registering at the same priority throws, and
      // the throw would take the whole contribution down. Occupancy is read from key and
      // priority rather than from component identity, because the client bundle can be
      // evaluated more than once in a page (a reload, or the HMR receiver re-running the
      // factory): each evaluation gets its own `OUR_VIEW` object, so an identity check misses
      // the previous evaluation's entry and the re-registration throws. `SHADOW_PRIORITY` is
      // ours alone — the official entries sit at the default `0` — so a `-1` occupant of this
      // cell is always a previous evaluation of this plugin, never something to displace.
      const claimed = new Set(
        ledger
          .filter((entry) => (entry.options.priority ?? 0) === SHADOW_PRIORITY)
          .map((entry) => entry.options.key),
      )
      for (const key of CHAT_NODE_KEYS) {
        if (claimed.has(key)) continue
        const official = officialViewFor(ledger, key, OUR_VIEW)
        // Without the official view there is nothing to place: registering a wrapper that
        // renders nothing would blank every message of that cell in every Session, which is
        // far worse than leaving the bubble on its official (right) side. The subscription is
        // what gives this another chance once the renderer does arrive.
        if (official === undefined) continue
        // Wrapped because a lost race must not take the plugin down with it. The guard above
        // covers the ordinary case, but the slot core can also reject a registration this
        // plugin cannot observe first (another evaluation mid-flight). Throwing here would
        // abort the whole `inject` callback — losing the room list's own renderer wiring — so a
        // rejected claim is skipped, leaving that cell with the official placement.
        let dispose: (() => void) | undefined
        try {
          dispose = ctx.slots.register({
          name: 'conversation.chat.node',
          key,
          priority: SHADOW_PRIORITY,
          // Required, not cosmetic: the seat synthesizes the `t` prop from the *registering*
          // entry's namespace, so this entry must name the official Chat namespace. Declaring
          // our own here would leave the official bubble's copy looking up keys that namespace
          // does not hold. `chat` is already registered by the shell, so naming it adds no
          // dictionary and cannot collide with the shell's own registration.
          locale: 'chat',
        }, (props: Record<string, unknown>) =>
          MessageSide({
            ...props,
            Official: official,
            // Read as a snapshot rather than captured: identity arrives after the first paint,
            // and a value captured when this renderer was registered would stay `undefined` for
            // the life of the page, leaving every message on the unknown-author side forever.
            getSelfId: store.selfId,
            subscribeSelf: store.subscribe,
            // Reads through the live store rather than a captured value: the roster arrives after
            // the first paint, and a snapshot taken here would stay `undefined` for the life of
            // the page, leaving every other author's bubble unlabelled.
            getRoster: (roomId: string) => store.getState().members[roomId],
            sided: props['node'] !== undefined,
          }))
        } catch (error) {
          logClaimFailure(key, error)
        }
        if (dispose !== undefined) claims.push(dispose)
      }
    }
    // Registration mutates the ledger, so the notification that a claim triggers would
    // re-enter this. `reconcile` is idempotent through the `claimed` set, which makes the
    // re-entry a no-op rather than a loop.
    const unsubscribe = ctx.slots.subscribe('conversation.chat.node', reconcile)
    reconcile()
    return () => { unsubscribe(); release() }
  })

  // Room messages join the official `@` menu. This is the only route to a real inline
  // reference: the pipeline owns chip insertion, so a plugin-provided pick is what makes a
  // reference look and behave like a session reference instead of a second, parallel widget.
  const inputTriggers = ctx.get('inputTriggers') as InputTriggersLike | undefined
  if (inputTriggers !== undefined) {
    ctx.effect(() => registerMessageSource(inputTriggers, store))
    // Members are a second group in the same menu. Only a room answers it, and a pick declares
    // `appearance: 'mention'`, which is what carries the member ids to the Host as prompt.mentions.
    ctx.effect(() => registerMemberSource(inputTriggers, store))
  }

  void PANEL_ID
}
