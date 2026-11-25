/**
 * Human-agent group chat for DSH workspaces.
 *
 * A room is a message bus shared by its members. Each member's workspace keeps its
 * own copy of every message, and each member's agent is a local subscriber that
 * acts only on its own instructions:
 *
 * - A member's client posts a message; the **server** assigns the global order and
 *   returns the finalized event, which is appended here only after that
 *   acknowledgement. A refusal therefore never reaches the append-only log.
 * - The same broadcast reaches every member's workspace, where it is appended to
 *   that room's session so the local agent can read the whole conversation.
 * - Exactly one case starts an agent turn: the sender mentioned **themselves**.
 *   Everything else is recorded and read, never executed — so no member can drive
 *   another member's agent, spend their budget, or reach their files.
 *
 * The server is addressed by protocol, not by product: any server implementing the
 * room endpoints works. DataOps is the first deployment and supplies environment
 * defaults, so its workspaces need no configuration.
 *
 * The plugin registers nothing at all when no server is configured, which is what
 * keeps an ordinary DSH installation and every ordinary session unaffected.
 */
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, open, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ExternalChannel } from './backend.ts'
import { BackendError, GroupChatBackend, type ContentBlockLike, type RoomEvent, type RoomMember, type RoomSummary } from './backend.ts'
import type { GroupChatContext } from './context.ts'
import {
  DEFAULT_CREDENTIAL_REF,
  MANAGED_ENV,
  ROOM_SHARED_LINK,
  resolveRoomDirectory,
  resolveServerTarget,
  resolvePreferencesPath,
  resolveWorkspaceRoot,
  type ServerTarget,
} from './identity.ts'
import { declaredMentions, mentionedMemberIds, shouldTriggerAgent, speakerPrefix, textOfContent, withSpeakerPrefix, type AgentTriggerPolicy } from './routing.ts'
import { cleanupRoomSessions, type SessionPersistenceView, type WorkspaceArchiveView } from './session-maintenance.ts'
import { ensureRoomWorkspace, type RoomWorkspaceRegistry } from './room-workspace.ts'
import type { WorkspaceCatalogView } from './context.ts'
import { openRoomStream } from './stream.ts'

export const name = 'group-chat'

/**
 * Prefix of the message a new room sends to its own agent to produce a first turn.
 *
 * The turn exists so the shell will open the room at all (see `warmUp`), and it must never be
 * mistaken for something a member said — the room's history and its unread counts are read by
 * everyone. Recognized by id because that survives the round trip through the session.
 */
const WARM_UP_PREFIX = 'warm-up-'

/**
 * Source kind of the legacy quoted-message context (context snapshots before a model step).
 *
 * The plugin no longer injects these — replies now use the composer's native quote — but a room
 * may still hold history rows carrying the kind, so the publish path keeps skipping them rather
 * than republishing an old snapshot as if a member had typed it.
 */
const QUOTE_CONTEXT_KIND = 'group-chat-quote'

/** Host services this plugin needs beyond the room runtime. */
export const inject = ['agents', 'sessions', 'webServer', 'credentials', 'sessionController']

/**
 * Plugin configuration, rendered as editable fields in the DSH settings panel.
 *
 * Every field is optional: leaving them blank uses the environment defaults a
 * managed workspace already carries, so the common case needs no editing while a
 * workspace pointed at any other conforming server can be configured from the UI.
 */
export interface Config {
  /** Origin of the room server, e.g. `http://host.docker.internal:3101`. */
  baseUrl?: string
  /** Credential reference resolved per request; never a secret value. */
  credentialRef?: string
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default('').description(
    'Origin of the group-chat server. Blank uses the workspace environment default.',
  ),
  credentialRef: z.string().default('').description(
    `Credential reference this plugin resolves per request, sent as a bearer token. Blank uses ${DEFAULT_CREDENTIAL_REF}.`,
  ),
})

export {
  BackendError,
  GroupChatBackend,
  isTransportFailure,
  type EventPage,
  type RoomEvent,
  type RoomEventRecord,
  type RoomMember,
  type RoomSummary,
} from './backend.ts'
export {
  DEFAULT_CREDENTIAL_REF,
  MANAGED_ENV,
  resolveServerTarget,
  resolveWorkspaceRoot,
  type ServerTarget,
} from './identity.ts'
export {
  isAgentReply,
  mentionedMemberIds,
  mentionsOf,
  messageId,
  senderId,
  shouldTriggerAgent,
  type AgentTriggerPolicy,
  speakerPrefix,
  textOfContent,
  withSpeakerPrefix,
} from './routing.ts'

/** Browser-facing route the sidebar calls to list and read rooms. */
export const GROUP_CHAT_ROUTE = '/dsh-group-chat/api'

/**
 * Milliseconds between cursor pulls.
 *
 * Pulling is the fallback and currently the only downlink: it needs no second
 * transport, and a cursor is the whole synchronization state, so it survives a
 * restart without re-appending history. The interval trades a bounded delay for a
 * request the backend already serves.
 */
export const POLL_INTERVAL_MS = 3_000

// The binding is defined in its own module because the browser half reads it too; see there for
// why it cannot live in this file. Imported for local use and re-exported so existing importers
// of this entry keep working.
import { ROOM_SESSION_PREFIX, roomSessionId, roomIdOfSession } from './session-id.ts'
export { ROOM_SESSION_PREFIX, roomSessionId, roomIdOfSession }

/** The most recently appended event belonging to a room. */
export const lastRoomEvent = (session: Session, roomId: string): SessionEvent | undefined => {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const source = (events[index] as { data?: { source?: { roomId?: unknown } } }).data?.source
    if (source?.roomId === roomId) return events[index]
  }
  return undefined
}

/** Narrows the payload `followup` accepts; the check is structural because JSON crossed a boundary. */
export const isUserMessageData = (data: unknown): data is Parameters<Agent['followup']>[0] => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
  const record = data as { role?: unknown; content?: unknown; id?: unknown; source?: unknown }
  return record.role === 'user'
    && typeof record.id === 'string'
    && Array.isArray(record.content)
    && typeof record.source === 'object' && record.source !== null
}

/**
 * Tracks which room events this workspace already appended.
 *
 * The key is the backend's global id, never the local sequence: the backend owns
 * cross-container order, and the same event can arrive twice (a broadcast and a
 * catch-up pull). Without this the model would read one message twice.
 */
export class RoomEventTracker {
  private readonly seen = new Map<string, Set<string>>()

  /** Records an event and reports whether it was new. */
  accept(roomId: string, globalId: string): boolean {
    const room = this.seen.get(roomId) ?? new Set<string>()
    this.seen.set(roomId, room)
    if (room.has(globalId)) return false
    room.add(globalId)
    return true
  }

  has(roomId: string, globalId: string): boolean {
    return this.seen.get(roomId)?.has(globalId) ?? false
  }

  /**
   * Highest global id seen for a room, as the cursor to resume from.
   *
   * Only the backend's own row id is a cursor. The tracker also holds the message ids it
   * was seeded with, and those are the same value only while every row came from this
   * backend; an older or hand-inserted row carries something else, and `since` answers a
   * non-id with no events at all. Returning one of those would stall the poll permanently
   * rather than resuming it, so they are skipped and the room is re-read from the start.
   */
  cursorOf(roomId: string): string | undefined {
    const room = this.seen.get(roomId)
    if (room === undefined || room.size === 0) return undefined
    let highest: bigint | undefined
    let highestId: string | undefined
    for (const id of room) {
      // Digits only: `Number('')` is 0 and `Number('1e3')` is 1000, and neither is a row id.
      if (!/^\d+$/.test(id)) continue
      const magnitude = BigInt(id)
      if (highest === undefined || magnitude > highest) {
        highest = magnitude
        highestId = id
      }
    }
    return highestId
  }

  /**
   * Rebuilds the tracker from a room's own session log, so a restart resumes from
   * what this workspace already holds instead of re-appending the whole room.
   */
  seedFromSession(roomId: string, events: readonly SessionEvent[]): void {
    for (const event of events) {
      const source = (event as { data?: { source?: { roomId?: unknown; messageId?: unknown } } }).data?.source
      if (source?.roomId !== roomId) continue
      if (typeof source.messageId === 'string') this.accept(roomId, source.messageId)
    }
  }
}

/** Per-room state the runtime keeps while a room is open. */
interface RoomRuntime {
  readonly session: Session
  members: readonly RoomMember[]
  syncing: boolean
  /** The room's reply policy, refreshed whenever the room list is read. */
  policy: AgentTriggerPolicy
  /** The model this runtime was opened with, so a later change can be applied to it. */
  modelKey: string
  /** This room's poll loop, owned here so dissolving one room can stop only that loop. */
  readonly timer: ReturnType<typeof setInterval>
  /**
   * True while a turn is running in this room's session.
   *
   * Context injected mid-turn is folded into that turn's next step, which would make a mirrored
   * external message look like something the agent was asked to answer. Non-waking deliveries
   * therefore wait for `turn/end` instead of being handed to a running turn.
   */
  busy: boolean
  /** Mirrored lines waiting for an ordered, non-waking append. */
  pendingInject: unknown[]
  /** Debounce that groups a burst (poll page + stream push) before appending in id order. */
  lineTimer?: ReturnType<typeof setTimeout>
  /**
   * The last backend page cursor this runtime has consumed.
   *
   * Deliberately separate from the tracker's seen set: a stream push of this workspace's own
   * just-published reply carries a high row id, and using it as the cursor would skip every
   * room message id below it that this workspace never read (a mirror message posted before the
   * room was first opened is exactly that case). Only `sync` pages move it.
   */
  cursor?: string
}

/**
 * A room's model selection as the room server reports it.
 *
 * `null` and absent mean the same thing here ("this room did not choose"), which is why both
 * are accepted: the wire type says `null`, the local summary type says absent, and the code
 * that reads a selection should not have to know which one it got.
 */
interface RoomModelSelection {
  readonly modelProvider?: string | null
  readonly model?: string | null
  readonly reasoningEffort?: string | null
}

/** The identity of a room's model selection, for change detection. */
const modelKeyOf = (room: RoomModelSelection): string =>
  [room.modelProvider ?? '', room.model ?? '', room.reasoningEffort ?? ''].join('|')

/** Whether two selections address the same route and effort. */
const sameModelSelection = (
  left: { provider: string; model: string; reasoningEffort?: string },
  right: { provider: string; model: string; reasoningEffort?: string },
): boolean => left.provider === right.provider
  && left.model === right.model
  && (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')

/**
 * Apply a room's model without changing the user's deployment default.
 *
 * `sessionController.selectModel` saves the selection as `agent-default-model` in the
 * background. That is right for a user choosing in the composer, but a room applying
 * its stored model (especially on startup) would otherwise overwrite the user's last
 * explicit choice. Capture the default first and restore it after the background save
 * has had a chance to land.
 */
const selectRoomModel = async (
  ctx: GroupChatContext,
  request: { sessionId: string; provider: string; model: string; reasoningEffort?: string },
): Promise<void> => {
  const defaultModel = ctx.agentDefaultModel
  const before = defaultModel?.currentSelection()
  const changesDefault = before !== undefined
    && !sameModelSelection(before, { provider: request.provider, model: request.model, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) })
  await ctx.sessionController.selectModel(request)
  if (!changesDefault || before === undefined || defaultModel === undefined) return
  await new Promise((resolve) => setTimeout(resolve, 60))
  try {
    await defaultModel.saveSelection(before)
  } catch {
    // Losing the restore must not fail a room open; the next explicit user selection
    // rewrites the default anyway.
  }
}

/** Whether a controller failure is the precise "this session is not stored" answer. */
const isSessionNotFound = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && (error as { code?: unknown }).code === 'session/not-found'

/**
 * Read an optional host service without making it a required injection.
 *
 * The direct property is the usual path on a fully composed host. `ctx.get` is the fallback
 * for a host that exposes a lazily mounted service as a registry entry only; tests and
 * minimal hosts may provide neither, which must read as "service unavailable" rather than
 * as a crash while opening a room.
 */
const hostService = <T>(ctx: GroupChatContext, key: string): T | undefined => {
  try {
    const direct = (ctx as unknown as Record<string, unknown>)[key] as T | undefined
    if (direct !== undefined) return direct
  } catch {
    // A context that proxies an unknown service may throw on property access; the
    // registry lookup below is the supported fallback.
  }
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(ctx, key) as T
  } catch {
    return undefined
  }
}

/**
 * The model route a Session's own log records, or `''` when it has never selected one.
 *
 * A resolved room Session keeps the selection it was created with; a restarted host must
 * not silently leave it on a room whose configured model has since changed. Reading the
 * last `model/selection` event avoids a write on every open.
 */
const sessionModelKey = (session: Session): string => {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as {
      readonly type?: unknown
      readonly data?: { readonly provider?: unknown; readonly model?: unknown; readonly reasoningEffort?: unknown }
    }
    if (event?.type !== 'model/selection') continue
    if (typeof event.data?.provider !== 'string' || typeof event.data?.model !== 'string') continue
    return [
      event.data.provider,
      event.data.model,
      typeof event.data.reasoningEffort === 'string' ? event.data.reasoningEffort : '',
    ].join('|')
  }
  return ''
}

/**
 * The execution scope one room's session is created with.
 *
 * Grouped rather than passed as positional arguments because every field optional-but-paired
 * reads the same in a call: a provider without a model names no route, and dropping either half
 * silently sends the room back to the deployment default.
 */
export interface RoomSessionScope {
  /**
   * The room's own name, used as the workspace title when this room is the one that
   * registers its directory. Create-or-reuse keeps an existing title, so this never
   * renames a workspace an ordinary session already owns.
   */
  readonly name: string
  /**
   * Opaque connector identity the room acts for.
   *
   * Copied onto the room's Session (created or resumed) so the base's disclosure rules can read it
   * per Session. Absent leaves the Session untouched, which is every room today.
   */
  readonly actor?: unknown
  /**
   * The directory the room's creator chose, when they chose one.
   *
   * Absent means "derive the room's own directory" rather than "use the workspace root":
   * the effective path is resolved in {@link RoomSessions.ensure}, so every caller
   * cannot forget the derivation.
   */
  readonly cwd?: string
  readonly agentPreset?: string
  readonly modelProvider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/**
 * Resolves the DSH session backing one room.
 *
 * A room has exactly one Session, addressed by {@link roomSessionId}. Opening it must
 * therefore be a resolve-or-create, never a create alone:
 *
 * - `sessionController.create({ sessionId })` reuses the named Session only while it is
 *   **blank**. A room that has ever run a turn — every room does, because of the warm-up
 *   turn — is no longer blank, so the controller mints a fresh `session-<uuid>` in the
 *   same cwd instead of returning the room's Session.
 * - Checking only `ctx.sessions.get()` misses a persisted Session after a host restart,
 *   because the registry is process-local. The first open would then mint a replacement;
 *   the plugin's lookup by the deterministic id still returns nothing, the open fails, and
 *   the three-second discovery poll repeats the mint forever. That is how one room grew to
 *   16,004 Session directories.
 *
 * Resolving first also fixes the archived case: it loads the real Session and lets the
 * room unarchive it before running a turn, instead of creating an unrelated replacement.
 */
export class RoomSessions {
  /** One in-flight open per room, so two discovery passes cannot race the same identity. */
  private readonly pending = new Map<string, Promise<Session>>()

  constructor(private readonly ctx: GroupChatContext) {}

  existing(roomId: string): Session | undefined {
    return this.ctx.sessions.get(roomSessionId(roomId) as never)
  }

  /**
   * Open a room's persisted Session, or create it on the one occasion it is absent.
   *
   * @param roomId - the room the session belongs to.
   * @param room - the room's configured scope and model.
   * @returns the canonical room Session, with an agent bound to it.
   */
  async ensure(roomId: string, room: RoomSessionScope): Promise<Session> {
    const existing = this.existing(roomId)
    if (existing !== undefined) {
      // A live Session skips the open path entirely, so the identity is refreshed here as well:
      // the connector may replace the actor while the room is already open.
      this.applyActor(existing, room)
      this.titleRoomSession(existing, room.name)
      return existing
    }
    const pending = this.pending.get(roomId)
    if (pending !== undefined) return pending
    const opening = this.open(roomId, room).finally(() => {
      if (this.pending.get(roomId) === opening) this.pending.delete(roomId)
    })
    this.pending.set(roomId, opening)
    return opening
  }

  /**
   * Copy the room's connector identity onto its Session.
   *
   * `Session.actor` is opaque to the base: disclosure filters read it, nothing interprets it here.
   * A room without one is left exactly as it was, so a deployment that never attaches an actor sees
   * no change. The whole object is replaced rather than mutated, which is the contract the base
   * documents for refreshing an identity snapshot.
   * @param session - the room's Session, created or resumed.
   * @param room - the scope the room was opened with.
   */
  private applyActor(session: Session, room: RoomSessionScope): void {
    if (room.actor === undefined) return
    const target = session as Session & { actor?: unknown }
    target.actor = room.actor
  }

  private async open(roomId: string, room: RoomSessionScope): Promise<Session> {
    const sessionId = roomSessionId(roomId)
    const directory = resolveRoomDirectory(roomId, room.cwd)
    // The directory is made before anything is created: it is the boundary the room's agent
    // may touch, and `sessionController.create` resolves a bare `cwd` through `fs.realpath`.
    // `recursive` keeps this idempotent across restarts, which matters because the room
    // directory lives on the durable volume.
    await mkdir(directory, { recursive: true })

    const resumed = await this.resolvePersisted(sessionId, directory)
    if (resumed !== undefined) {
      this.applyActor(resumed, room)
      await this.installRoomModel(resumed, room, false)
      // Registered on every open, not only on creation: an image that predates this call (or a
      // workspace deleted and recreated under the room) still has to become selectable.
      return resumed
    }

    // Created with `cwd` and deliberately *not* with a `workspaceId`.
    //
    // A room is one conversation, so a workspace entry per room would fill the workspace list
    // with folders that never hold anything else, and dissolving a room would leave its entry
    // behind. A Session belongs to a Workspace only when it is registered against one of that
    // Workspace's sessions; passing `cwd` alone gives the agent the directory it needs without
    // claiming a row in that list. The session therefore lands in the shell's "Ungrouped"
    // bucket, which is exactly the bucket for sessions that belong to no workspace.
    //
    // Nothing attaches it to a Workspace, deliberately: a room's Session lives in its own
    // directory under the mounted root, and `attachSession` rejects a cwd that is not the
    // workspace path. Selection therefore has to work by id alone -- the shell's `openSession`
    // must not consult workspace membership, which is what makes the room open.
    const created = await this.ctx.sessionController.create({
      sessionId,
      cwd: directory,
      ...room.agentPreset === undefined ? {} : { agentPreset: room.agentPreset },
    })
    if (created.sessionId !== sessionId) {
      // The controller chose a replacement. Never return it: a minted conversation is not
      // the room, and adopting it would make the room's history disappear behind a new id.
      // Archive it (the reversible hide marker) so a failed open cannot leave a visible row,
      // then fail this open; the next poll resolves the canonical Session if it exists.
      await this.archiveReplacement(created.sessionId)
      throw new Error(
        `group-chat asked for room session ${sessionId} but the controller opened ${created.sessionId}`,
      )
    }
    const session = this.existing(roomId)
    if (session === undefined) {
      throw new Error(`group-chat could not open a session for room ${roomId}`)
    }
    this.applyActor(session, room)
    await this.installRoomModel(session, room, true)
    this.titleRoomSession(session, room.name)
    return session
  }

  /** Load a persisted room Session, or `undefined` only when the controller denies it exists. */
  private async resolvePersisted(sessionId: string, directory: string): Promise<Session | undefined> {
    let resolved: Awaited<ReturnType<GroupChatContext['sessionController']['resolveAgent']>>
    try {
      resolved = await this.ctx.sessionController.resolveAgent(sessionId as never)
    } catch (error) {
      if (isSessionNotFound(error)) return undefined
      throw error
    }
    if ('agent' in resolved) {
      const session = resolved.agent.session
      if (session.id !== sessionId) {
        throw new Error(`group-chat resolved room session ${sessionId} as ${session.id}`)
      }
      // A room's directory is fixed when its Session is created. Using the persisted
      // Session keeps the room's history readable if an administrator edits the room's cwd
      // afterwards; the alternative — replacing the Session — would silently lose history.
      if (session.header.cwd !== undefined && session.header.cwd !== directory) {
        this.ctx.logger?.warn?.(
          '[group-chat] room session directory differs from the room configuration; keeping the existing history',
          sessionId,
          session.header.cwd,
          directory,
        )
      }
      // A room that is still joined must be runnable. Archiving is how a Session was hidden
      // from grouping surfaces; the room's own sidebar entry is a clear request to use it.
      await this.unarchiveRoomSession(sessionId)
      return session
    }
    if (isSessionNotFound(resolved.error)) return undefined
    throw new Error(
      `group-chat could not resolve room session ${sessionId}: ${
        resolved.error instanceof Error ? resolved.error.message : String(resolved.error)
      }`,
    )
  }

  /** Install the room's model when the Session's log does not already carry it. */
  private async installRoomModel(session: Session, room: RoomSessionScope, strict: boolean): Promise<void> {
    if (room.modelProvider === undefined || room.model === undefined) return
    const target: RoomModelSelection = {
      modelProvider: room.modelProvider,
      model: room.model,
      ...room.reasoningEffort === undefined ? {} : { reasoningEffort: room.reasoningEffort },
    }
    if (sessionModelKey(session) === modelKeyOf(target)) return
    try {
      await selectRoomModel(this.ctx, {
        sessionId: session.id,
        provider: room.modelProvider,
        model: room.model,
        ...room.reasoningEffort === undefined ? {} : { reasoningEffort: room.reasoningEffort },
      })
    } catch (error) {
      // A newly created Session must not open on the wrong route — that is the failure this
      // installation exists to prevent. A persisted one already has history and a reachable
      // model; a stale room setting should be logged, not make its history unopenable.
      if (strict) throw error
      this.ctx.logger?.warn?.('[group-chat] keeping the room session on its existing model', session.id, error)
    }
  }

  /** The workspace registry's archive surface, looked up lazily because it is optional. */
  private get archiveRegistry(): WorkspaceArchiveView | undefined {
    return hostService<WorkspaceArchiveView>(this.ctx, 'workspaceRegistry')
  }


  /**
   * Give the room's Session the title a reader expects, once.
   *
   * A room Session starts titled from its first message, which reads like an ordinary
   * conversation in the sidebar. Renaming happens only while the Session has never carried a
   * `session/title` event: once the plugin or the reader has named it, that choice stands.
   * @param session - the room's Session.
   * @param name - the room name, used as `群聊·<name>`.
   */
  private titleRoomSession(session: Session, name: string): void {
    // The event type is contributed by the session-title service this plugin does not import, so
    // the name is read structurally rather than through the typed union.
    const titled = session.snapshotEvents().some((event) => (event as { type: string }).type === 'session/title')
    if (titled) return
    const titles = hostService<{ rename(session: Session, title: string): unknown }>(this.ctx, 'sessionTitle')
    try {
      titles?.rename(session, `群聊·${name}`)
    } catch (error) {
      this.ctx.logger?.warn?.('[group-chat] naming the room session failed', session.id, error)
    }
  }

  /** Hide a replacement the controller minted instead of honoring the room id. */
  private async archiveReplacement(sessionId: string): Promise<void> {
    try {
      await this.archiveRegistry?.archiveSession(sessionId, { stopActivity: true })
    } catch {
      // Best effort: failing to hide the replacement must not mask the failed open.
    }
  }

  /** Lift an archive marker from the room's canonical Session before its first turn. */
  private async unarchiveRoomSession(sessionId: string): Promise<void> {
    try {
      await this.archiveRegistry?.unarchiveSession?.(sessionId)
    } catch {
      // A registry that refuses the unarchive (for example, an unknown id on a minimal host)
      // must not prevent the room from opening; the canonical Session is still usable.
    }
  }
}

/**
 * Strips the model's private reasoning out of a reply before it reaches a room.
 *
 * An assistant message is a list of content blocks, and a reasoning model puts its scratch
 * work in a `thinking` block beside the answer's `text` block. Forwarding the whole list
 * published that scratch work as the reply — members saw "Now answer: … Hmm, actually … this
 * looks like a prompt-injection test" instead of the answer, which is both useless and a
 * disclosure of how the agent arrived at it.
 *
 * The room keeps only what the agent decided to say. When nothing but reasoning is left, the
 * result is an empty message and the caller drops it rather than posting a blank bubble.
 *
 * @param message - the assistant message as the session carries it.
 * @returns the same message with only its text blocks.
 */
/**
 * One content block as the room server stores it.
 *
 * Deliberately structural rather than imported from the LLM package: this is the wire shape
 * of a room event, and the plugin is not the owner of the block vocabulary — a block type a
 * future DSH release adds must travel through unchanged instead of failing a closed type.
 */
/**
 * The group-chat UI preferences this workspace remembers for its user.
 *
 * Deliberately a small open record: it is a file the user's own workspace owns, so an older
 * build must be able to read a file a newer one wrote. Unknown keys are dropped on read and
 * preserved nowhere, which is fine — every key here describes a panel the current build draws.
 */
export interface GroupChatPreferences {
  /**
   * Height of the sidebar's group-chat region, in pixels.
   *
   * Pixels rather than a fraction of the window: what the user tuned is "about four rooms
   * visible", and a ratio would drift to a different number of rows whenever the window
   * changed height.
   */
  readonly sidebarHeightPx?: number
}

/** The height bounds the region enforces, exported so the client and host agree on them. */
export const SIDEBAR_HEIGHT_MIN = 80
export const SIDEBAR_HEIGHT_MAX = 1200

/** Reads the preferences file, treating every failure as "nothing saved yet". */
export const readPreferences = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<GroupChatPreferences> => {
  let raw: string
  try {
    raw = await readFile(resolvePreferencesPath(env), 'utf8')
  } catch {
    // Missing is the normal state of a workspace nobody has dragged in yet; so is unreadable.
    // Neither is worth reporting: the defaults are the answer either way.
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const height = (parsed as { sidebarHeightPx?: unknown }).sidebarHeightPx
    return typeof height === 'number' && Number.isFinite(height)
      ? { sidebarHeightPx: clampSidebarHeight(height) }
      : {}
  } catch {
    // A corrupt file is replaced on the first save rather than reported: it holds one number.
    return {}
  }
}

/** Clamps a requested height into the range the region can actually draw. */
export const clampSidebarHeight = (value: number): number =>
  Math.min(SIDEBAR_HEIGHT_MAX, Math.max(SIDEBAR_HEIGHT_MIN, Math.round(value)))

/**
 * Writes the preferences file atomically.
 *
 * Temp file plus rename, like the room uploads: a reader must never see half a JSON document,
 * and the file lives in the workspace volume where a crash mid-write would otherwise leave a
 * truncated one that reads as "no preferences".
 */
export const writePreferences = async (
  preferences: GroupChatPreferences,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<GroupChatPreferences> => {
  const path = resolvePreferencesPath(env)
  const normalised: GroupChatPreferences = preferences.sidebarHeightPx === undefined
    ? {}
    : { sidebarHeightPx: clampSidebarHeight(preferences.sidebarHeightPx) }
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${String(process.pid)}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(normalised, null, 2)}\n`, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  return normalised
}

export type UserContent = readonly ContentBlockLike[]

/** True when `data` looks like a `user/message` payload this workspace composed itself. */
/**
 * True when a `user/message` carries runtime bookkeeping rather than something a member typed.
 *
 * These arrive on the same channel with the same shape, so they have to be told apart by what
 * they say: every one of them is a wrapper the shell injects, either a `<system-reminder>`
 * block or a snapshot opening with one of the known prefixes. Matching on the text is
 * imperfect in principle — a member could type the same words — but the alternative is
 * publishing the deployment's instructions into every room, which is far worse.
 */
const RUNTIME_INJECTED_PREFIXES = [
  '<system-reminder>',
  'Current runtime context',
  'Time sampled while preparing',
] as const

export const isRuntimeInjectedData = (data: unknown): boolean => {
  if (typeof data !== 'object' || data === null) return false
  const content = (data as Record<string, unknown>)['content']
  if (!Array.isArray(content)) return false
  const text = content
    .filter((block): block is { type?: unknown; text?: unknown } =>
      typeof block === 'object' && block !== null)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
    .trimStart()
  return RUNTIME_INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix))
}

export const isLocalUserMessage = (data: unknown): data is { id?: string; content: UserContent } => {
  if (typeof data !== 'object' || data === null) return false
  const record = data as Record<string, unknown>
  const content = record['content']
  if (!Array.isArray(content) || content.length === 0) return false
  const source = record['source']
  if (typeof source !== 'object' || source === null) return true
  // A message the room poll delivered is stamped with the room it came from. Publishing it
  // again would duplicate every line: once from the poll, once from this echo.
  const fromRoom = (source as Record<string, unknown>)['roomId']
  return fromRoom === undefined || fromRoom === null
}

export const publishableReply = (message: unknown): unknown => {
  if (typeof message !== 'object' || message === null) return message
  const record = message as Record<string, unknown>
  const content = record['content']
  if (!Array.isArray(content)) return message
  const textBlocks = content.filter((block) => {
    if (typeof block !== 'object' || block === null) return false
    const type = (block as Record<string, unknown>)['type']
    return type === 'text'
  })
  return { ...record, content: textBlocks }
}

/**
 * Wire the room runtime.
 *
 * Returns `undefined` on an unmanaged DSH: no route, no listener, no timer. That is
 * the mechanism behind "ordinary sessions are byte-identical with and without this
 * plugin".
 */
export const apply = (ctx: GroupChatContext, config: Config = {}): (() => void) | undefined => {
  // Settings win over the environment defaults DataOps injects, so an operator can
  // point this workspace at any server that implements the protocol.
  const target = resolveServerTarget({
    baseUrl: config.baseUrl,
    credentialRef: config.credentialRef,
  })
  if (target === undefined) return undefined
  return activate(ctx, target)
}

/** The activated runtime; separated so target resolution stays independently testable. */
export const activate = (ctx: GroupChatContext, target: ServerTarget): (() => void) => {
  // One credential path for both faces. The stream and the REST client authenticate as
  // the same principal through the same store entry, so there is no second mechanism to
  // keep in step.
  /** Temporary: the platform logger's destination is not captured by the service. */
  const credential = async (): Promise<string> => {
    const resolved = await ctx.credentials.resolve(credentialRef(target.credentialRef))
    if (resolved?.value === undefined || resolved.value.length === 0) {
      throw new Error('group-chat has no credential to present')
    }
    return resolved.value
  }
  const backend = new GroupChatBackend(target, credential)
  const tracker = new RoomEventTracker()
  const sessions = new RoomSessions(ctx)
  /**
   * Declared before the stream because the stream's sink delivers into it, and the stream
   * is opened before the rooms exist.
   */
  let deliver: (roomId: string, record: { id: string; event: RoomEvent }) => void = () => {}
  const stream = openRoomStream({
    baseUrl: target.baseUrl,
    token: credential,
    onEvent: (pushed) => deliver(pushed.roomId, { id: pushed.id, event: pushed.event }),
    // Logged only. The poll is the fallback, so a transport problem is not an outage.
    onError: (error) => log?.error?.('[group-chat] stream unavailable; polling continues', error),
  })
  const runtimes = new Map<string, RoomRuntime>()
  const timers = new Set<ReturnType<typeof setInterval>>()

  /**
   * Stop one room's runtime and forget it.
   *
   * Dissolving deletes the room on the server, so the poll loop and the runtime entry that
   * describe it would otherwise keep running against a room that no longer exists. The loop
   * is cleared through its own handle rather than by clearing every timer, because the other
   * rooms are still live.
   */
  const closeRoom = (roomId: string): void => {
    const runtime = runtimes.get(roomId)
    if (runtime === undefined) return
    clearInterval(runtime.timer)
    if (runtime.lineTimer !== undefined) clearTimeout(runtime.lineTimer)
    timers.delete(runtime.timer)
    runtimes.delete(roomId)
  }
  const log = ctx.logger
  /** The turn's most recent assistant message, published when the turn closes. */
  let pendingReply: { roomId: string; event: RoomEvent } | undefined
  /**
   * The account this workspace acts as, learned from the server on first use.
   *
   * Resolved once and cached because it changes only if the credential is replaced,
   * and until it is known no message can be recognized as this member's own — so
   * nothing triggers, and messages are still recorded for the agent to read.
   */
  let selfId: string | undefined
  let selfIdResolved = false

  const cwd = (): string => resolveWorkspaceRoot()


  /**
   * Whether this session already has the protected `system/message` surface head.
   *
   * Appending a `user/message` before that head makes the reader reject the whole session
   * ("system/message requires a protected first surface head"), so a room that has never
   * completed a turn holds its mirrored lines until the warm-up creates the head.
   */
  const hasSurfaceHead = (session: Session): boolean =>
    session.snapshotEvents().some((event) => event.type === 'system/message')

  /** Append one mirrored message to the room's visible log without starting a turn. */
  const appendRoomLine = (session: Session, message: unknown): void => {
    try {
      session.append('user/message', message as never, { surfaceOp: 'append' })
    } catch (error) {
      log?.warn?.('[group-chat] appending a mirrored room message failed', error)
    }
  }

  /**
   * Whether the session's last turn boundary is a start with no matching end.
   *
   * A process killed mid-turn leaves that shape on disk. Treating it as idle would append
   * mirrored lines into a turn the runtime may resume, which is exactly how a mirror message
   * ends up answered. The flag stays set until a real `turn/end` arrives.
   */
  const isTurnOpen = (session: Session): boolean => {
    const events = session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].type === 'turn/end') return false
      if (events[index].type === 'turn/start') return true
    }
    return false
  }

  /** The backend row id a mirrored line carries, used only to order a burst. */
  const lineOrder = (message: unknown): bigint | undefined => {
    const id = (message as { source?: { messageId?: unknown } }).source?.messageId
    return typeof id === 'string' && /^\d+$/.test(id) ? BigInt(id) : undefined
  }

  const sortLines = (lines: unknown[]): unknown[] =>
    lines.sort((left, right) => {
      const a = lineOrder(left)
      const b = lineOrder(right)
      if (a === undefined || b === undefined || a === b) return 0
      return a < b ? -1 : 1
    })

  /** Append the queued mirrored lines in backend order, but only past the protected head. */
  const flushRoomLines = (runtime: RoomRuntime): void => {
    if (runtime.lineTimer !== undefined) {
      clearTimeout(runtime.lineTimer)
      runtime.lineTimer = undefined
    }
    if (runtime.busy) return
    const queued = sortLines(runtime.pendingInject.splice(0))
    if (queued.length === 0) return
    if (!hasSurfaceHead(runtime.session)) {
      runtime.pendingInject.unshift(...queued)
      return
    }
    for (const line of queued) appendRoomLine(runtime.session, line)
  }

  /**
   * Queue a mirrored line.
   *
   * Both the poll page and the push stream call here, and the two can hand over the same burst
   * in either order. A short debounce lets one sort cover the whole burst, so the transcript
   * always follows the backend's ids rather than whichever transport spoke first.
   */
  const enqueueRoomLine = (runtime: RoomRuntime, message: unknown): void => {
    if (runtime.pendingInject.length >= 100) return
    runtime.pendingInject.push(message)
    sortLines(runtime.pendingInject)
    if (runtime.busy || runtime.lineTimer !== undefined) return
    runtime.lineTimer = setTimeout(() => { flushRoomLines(runtime) }, 120)
  }

  deliver = (roomId: string, record: { id: string; event: RoomEvent }): void => {
    const runtime = runtimes.get(roomId)
    if (runtime === undefined) return
    if (!tracker.accept(roomId, record.id)) return
    // The message is not written here. `followup` below owns that: its contract is to
    // "queue an ordinary follow-up turn" whose item "becomes the sole ordinary message of its
    // own turn", and the driver writes the surface when it runs that turn — `system/message`
    // first, the user message after. Writing it here as well put a `user/message` on the
    // surface before any turn had run, and the log's first surface node must be the protected
    // `system/message`: the reader rejects the session outright once a surface exists without
    // that head ("system/message requires a protected first surface head"). The prefix still
    // has to be applied, because it is what carries the speaker into the model's view.
    const prefix = speakerPrefix(record.event, runtime.members)
    // `withSpeakerPrefix` rewrites the envelope; both official channels take the message
    // inside it (`UserMessage`), so the envelope is unwrapped here rather than handed on.
    const local = withSpeakerPrefix(record.event, prefix)
    const message = (local as { data?: unknown }).data
    // The rule needs an identified actor, and the answer can arrive after the first
    // message does, so it is decided per delivery rather than only at activation. Until
    // the account is known nothing can be recognized as this member's own, so the delivery
    // is decided again once it resolves rather than being dropped.
    const route = (): void => {
      if (selfId !== undefined && shouldTriggerAgent(record.event, selfId, runtime.members, runtime.policy)) {
        void deliverToAgent(roomId, message, true)
        return
      }
      void deliverToAgent(roomId, message, false)
    }
    if (selfId !== undefined || selfIdResolved) route()
    else void resolveSelfId().then(route)
  }

  /** Learns this workspace's account once, so a slow answer delays rather than loses a trigger. */
  const resolveSelfId = async (): Promise<void> => {
    if (selfIdResolved) return
    selfIdResolved = true
    const me = await backend.whoami()
    selfId = me?.id
    if (selfId === undefined) {
      log?.warn?.('[group-chat] the server did not identify this workspace; messages are recorded but no agent turn starts')
    }
  }

  const sync = async (roomId: string): Promise<void> => {
    const runtime = runtimes.get(roomId)
    if (runtime === undefined || runtime.syncing) return
    runtime.syncing = true
    try {
      // Start from this runtime's own page cursor, not from the highest id the tracker has
      // seen: a pushed reply can be newer than messages this workspace has not read yet.
      let cursor = runtime.cursor
      for (;;) {
        const page = await backend.listEvents(roomId, cursor)
        for (const record of page.events) deliver(roomId, record)
        if (page.nextCursor !== null) runtime.cursor = page.nextCursor
        if (!page.hasMore || page.nextCursor === null || page.events.length === 0) break
        cursor = page.nextCursor
      }
    } catch (error) {
      // A transport failure is retryable and must not tear the room down; the next
      // interval retries from the same cursor because nothing was acknowledged.
      log?.error?.('[group-chat] room sync failed', roomId, error)
    } finally {
      runtime.syncing = false
    }
  }

  /**
   * Keep the shared tree reachable from the workspace root.
   *
   * A symlink, not a hardlink: the shared tree is a separate bind mount, and a hardlink
   * across mount points fails with EXDEV on every Linux kernel. Re-created on every room
   * open rather than once at start because it lives in the workspace volume, which is
   * replaced when the container is rebuilt — a link that outlived its target would silently
   * point nowhere.
   *
   * Best-effort by design: a workspace where the link cannot be created (no shared mount,
   * read-only root) still opens its rooms. The link only decides whether a *relative* path
   * can reach the shared tree; an absolute one works either way.
   */
  const ensureSharedLink = async (): Promise<void> => {
    const sharedRoot = sharedRootPath()
    if (sharedRoot === undefined) return
    const link = join(resolveWorkspaceRoot(), ROOM_SHARED_LINK)
    try {
      // Re-point a link whose target moved: the mount path is deployment configuration, so
      // a workspace that outlives a configuration change would otherwise keep the old
      // destination and look correct until someone tried to read through it.
      const current = await readlink(link).catch(() => undefined)
      if (current === sharedRoot) return
      if (current !== undefined) await rm(link, { force: true })
      await symlink(sharedRoot, link, 'dir')
    } catch (error) {
      log?.warn?.('[group-chat] the shared folder link could not be created', link, error)
    }
  }

  /**
   * Point a room's session at the room's current model.
   *
   * Failure is logged and swallowed: the poll that called this is not the place to surface a
   * model error, and a room whose selection cannot be applied should keep working on its old
   * one rather than stop entirely. The next `discover` retries because `modelKey` is only
   * advanced on success.
   *
   * @param session - the room's session.
   * @param room - the room carrying the target selection.
   */
  const applyModelSelection = async (
    session: Session,
    room: RoomModelSelection,
  ): Promise<void> => {
    // Both halves are required; a room selecting neither runs the deployment default, which
    // is a supported state and needs no call here.
    if (room.modelProvider === null || room.modelProvider === undefined) return
    if (room.model === null || room.model === undefined) return
    try {
      await selectRoomModel(ctx, {
        sessionId: session.id,
        provider: room.modelProvider,
        model: room.model,
        ...room.reasoningEffort === null || room.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: room.reasoningEffort },
      })
    } catch (error) {
      log?.warn?.('[group-chat] applying the room model selection failed', error)
    }
  }

  const open = async (room: RoomSummary): Promise<void> => {
    if (runtimes.has(room.id)) return
    // Subscribed before the session is built so an event that lands while the room is
    // still opening is not lost: the tracker de-duplicates it against the poll.
    stream.follow(room.id)
    const session = await sessions.ensure(room.id, {
      // The room's name titles the workspace it registers. Absent is the common case and
      // means "derive the room's own directory", which `ensure` resolves.
      name: room.name,
      ...room.actor === undefined ? {} : { actor: room.actor },
      ...room.cwd === null ? {} : { cwd: room.cwd },
      agentPreset: room.agentPreset ?? undefined,
      modelProvider: room.modelProvider ?? undefined,
      model: room.model ?? undefined,
      reasoningEffort: room.reasoningEffort ?? undefined,
    })
    let members: readonly RoomMember[] = []
    try {
      members = await backend.listMembers(room.id)
    } catch (error) {
      log?.error?.('[group-chat] reading room members failed', room.id, error)
    }
    // Registered before the warm-up and the first sync: a mirrored message pulled by `sync`
    // must see the room's `busy` flag, or it is injected into the warm-up turn's next step and
    // the model answers a message nobody addressed to it.
    const timer = setInterval(() => { void sync(room.id) }, POLL_INTERVAL_MS)
    timers.add(timer)
    runtimes.set(room.id, {
      session,
      members,
      syncing: false,
      policy: room.agentTrigger,
      modelKey: modelKeyOf(room),
      timer,
      busy: isTurnOpen(session),
      pendingInject: [],
      cursor: undefined,
    })
    // A session that has never run a turn is the one the shell lists as `blank`, and the
    // conversation view refuses to bind to it: the member gets an empty pane with no composer
    // on a room they just created. Config events and seeds are written at creation, so counting
    // events would miss it — the marker is that no turn has ever started.
    if (!session.snapshotEvents().some((event) => event.type === 'turn/start')) {
      void warmUp(room.id, session)
    }
    tracker.seedFromSession(room.id, session.snapshotEvents())
    await sync(room.id)
  }

  /**
   * Wake this workspace's own agent for a self-mention.
   *
   * `followup` queues an ordinary next-turn prompt and wakes the driver; it takes a
   * complete `UserMessage`, not the raw event payload, so the event this plugin just
   * appended is rebuilt as one — same identity, same content, same source. That
   * keeps the model's history and the inbox item describing the same message.
   */
  /**
   * Run one turn on a room whose session has never had one.
   *
   * The shell's conversation view binds through `sessions.retain`, which refuses a session the
   * host still lists as `blank` — so a freshly created room opens to an empty pane with no
   * composer, and the room looks broken even though everything about it is fine. A single
   * completed turn clears that flag for good.
   *
   * The prompt is an instruction to the room's own agent rather than a message from a member,
   * and its id carries {@link WARM_UP_PREFIX} so the publish path drops it: it writes the
   * session, but a member must never find it in the room's history.
   */
  const warmUp = async (roomId: string, session: Session): Promise<void> => {
    // Holds non-waking deliveries from the moment the warm-up is queued until its turn ends:
    // resolving the agent takes an await, and an inject that lands in that window would be
    // folded into the warm-up turn's first step.
    const runtime = runtimes.get(roomId)
    if (runtime !== undefined) runtime.busy = true
    try {
      const sessionId = roomSessionId(roomId)
      let agent = ctx.agents.get(sessionId as never)
      if (agent === undefined) {
        const resolved = await ctx.sessionController.resolveAgent(sessionId as never)
        if (!('agent' in resolved)) return
        agent = resolved.agent
      }
      // Re-checked after the await: two opens racing on the same room must not both queue a
      // turn, and a member may have sent the first message while the agent was resolving.
      if (session.snapshotEvents().some((event) => event.type === 'turn/start')) {
        if (runtime !== undefined) runtime.busy = false
        return
      }
      const prompt = {
        id: `${WARM_UP_PREFIX}${roomId}`,
        role: 'user' as const,
        content: [{
          type: 'text' as const,
          text: '这是一条初始化指令，不是成员发言：请只回复两个字「就绪」，不要执行任何操作。',
        }],
        source: { kind: 'user' as const },
      }
      if (isUserMessageData(prompt)) agent.followup(prompt)
    } catch (error) {
      // A warm-up that fails is not worth failing the open over: the room works, it just opens
      // empty until someone sends the first message. Its queued injects still have to flow, so
      // the busy flag is released here rather than waiting for a turn that never started.
      if (runtime !== undefined) runtime.busy = false
      log?.warn?.('[group-chat] warming up a new room session failed', roomId, error)
    }
  }

  const deliverToAgent = async (roomId: string, prompt: unknown, wake: boolean): Promise<void> => {
    // The prompt is the message `deliver` already built for this record, not a re-read of the
    // session's last event: the surface holds whatever the driver last committed, which after a
    // turn is the assistant's reply rather than the message that triggered it.
    if (!isUserMessageData(prompt)) return
    const runtime = runtimes.get(roomId)
    const authorKind = (prompt as { source?: { authorKind?: unknown } }).source?.authorKind
    if (!wake && authorKind === 'external') {
      // Mirrored messages are shown by appending them to the room's own log, not by handing
      // them to the driver. `inject` writes them only as part of a turn's next step, so a
      // message that arrives mid-turn either gets answered or waits invisibly for a turn that
      // may never come. A direct append has no such coupling: it is visible immediately and
      // enters model history on the next turn like any other line.
      if (runtime === undefined) return
      enqueueRoomLine(runtime, prompt)
      return
    }
    const sessionId = roomSessionId(roomId)
    // A room session exists but carries no agent until one is resolved onto it, so the
    // live lookup is expected to miss on the first message. `resolveAgent` resumes the
    // session through the controller's own path, which is what binds one.
    let agent = ctx.agents.get(sessionId as never)
    if (agent === undefined) {
      const resolved = await ctx.sessionController.resolveAgent(sessionId as never)
      // The result is a union keyed on which field is present, not on an `ok` flag: a
      // missing `agent` is the failure, and it is what the log must show.
      if (!('agent' in resolved)) {
        log?.warn?.('[group-chat] could not resolve an agent for the room session', roomId, resolved.error)
        return
      }
      agent = resolved.agent
    }
    try {
      // `followup` "queue[s] an ordinary follow-up turn and wake[s] the driver", so the agent
      // answers; `inject` only queues context for a later step, which is how every message
      // around the agent stays readable without starting a turn.
      if (wake) {
        if (runtime !== undefined) runtime.busy = true
        agent.followup(prompt)
      } else {
        agent.inject(prompt)
      }
    } catch (error) {
      if (runtime !== undefined) runtime.busy = false
      log?.warn?.('[group-chat] delivering a room message to the agent failed', roomId, error)
    }
  }

  /**
   * Publish the agent's reply when its turn closes.
   *
   * Only the turn's final `assistant/message` is sent: intermediate steps, file
   * reads, and tool output stay in this workspace by construction, which is what
   * keeps them out of a shared room.
   */
  const onSessionEvent = (session: Session, event: SessionEvent): void => {
    const roomId = roomIdOfSession(session)
    if (roomId === undefined) return
    const runtime = runtimes.get(roomId)
    if (event.type === 'turn/start') {
      if (runtime !== undefined) runtime.busy = true
      return
    }
    if (event.type === 'turn/end') {
      if (runtime !== undefined) {
        runtime.busy = false
        // Flush what arrived during the turn now that no step is running: `inject` adds it to
        // the session without waking the driver, so a mirrored message can never answer itself.
        flushRoomLines(runtime)
      }
      if (pendingReply === undefined) return
      const reply = pendingReply
      pendingReply = undefined
      backend
        .reportAgentEvent(roomId, { rpcId: `${roomId}:${String((event as { seq?: number }).seq ?? 'end')}`, event: reply.event })
        .catch((error: unknown) => { log?.error?.('[group-chat] reporting the agent reply failed', roomId, error) })
      return
    }
    if (event.type === 'user/message') {
      // Only what the member actually typed is published. The runtime delivers its own
      // bookkeeping as `user/message` too — workspace instructions, reminders, the state
      // snapshot — and forwarding those would put the deployment's plumbing into a room
      // everyone can read.
      const data = (event as { data?: unknown }).data
      if (isRuntimeInjectedData(data)) return
      // A message this workspace's own member typed. It must be published to the room, or the
      // member sees their own words and nobody else ever does — the room would be a private
      // chat with the agent that happens to show other people's replies.
      //
      // Two things keep this from echoing: an event that arrived *from* the room already
      // carries `source.roomId` (the poll path), and the backend de-duplicates on `rpcId`.
      if (!isLocalUserMessage(data)) return
      const messageId = (data as { id?: unknown }).id
      // A warm-up reaches the session through `followup` exactly like a real message, so it is
      // filtered here or the room's history opens with an instruction nobody wrote.
      if (typeof messageId === 'string' && messageId.startsWith(WARM_UP_PREFIX)) return
      // A quoted-message context is background for the model, not something a member said. The
      // source kind is what makes it recognizable here; publishing it would put the raw snapshot
      // in the room's history under the member's name.
      if ((data as { source?: { kind?: unknown } }).source?.kind === QUOTE_CONTEXT_KIND) return
      // Member ids the composer declared, in the order the user picked them. A picked roster entry
      // rides the prompt's `mentions` (the chip carries `appearance: 'mention'`), so routing reads
      // identity and never parses `@name` out of the text.
      //
      // The text pass stays as a fallback for a draft composed before the roster source existed
      // (or from a cached bundle): those prompts carry the words alone. Delete it once every
      // served client declares ids.
      const content = (data as { content: UserContent }).content
      const declared = declaredMentions((data as { source?: { mentions?: unknown } }).source)
      const mentions = declared.length > 0
        ? declared
        : mentionedMemberIds(textOfContent(content), runtimes.get(roomId)?.members ?? [])
      backend
        .sendMessage(roomId, {
          // The blocks travel unchanged: an attachment, an image, an @ reference, or the
          // composer's own quote node is in them, and flattening to text here would silently
          // drop everything but the words.
          content,
          rpcId: typeof messageId === 'string' && messageId.length > 0
            ? messageId
            : `local-${String(Date.now())}`,
          ...mentions.length === 0 ? {} : { mentions },
        })
        .catch((error: unknown) => {
          log?.error?.('[group-chat] publishing the member message failed', roomId, error)
        })
      return
    }
    if (event.type === 'assistant/message') {
      // DSH wraps an assistant message as `data.message` (a user message is `data`
      // itself), so the reply is published as that inner message and the backend
      // rebuilds the envelope. Reading `data.role` here would silently publish
      // nothing, because the outer object carries no role.
      const message = (event as { data?: { message?: unknown } }).data?.message
      if (message !== undefined) {
        pendingReply = { roomId, event: { type: 'assistant/message', data: publishableReply(message) } }
      }
      return
    }
  }

  ctx.on('session/event', onSessionEvent)

  /**
   * The browser-facing room API.
   *
   * Registered through `ctx.effect` so unloading the plugin removes the route, and
   * registered before any outbound call because registration order is the contract:
   * a server that is unreachable at startup is exactly the state the settings panel
   * must be able to show, so a failed connection must never prevent the route from
   * existing. The route reports the failure instead.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: GROUP_CHAT_ROUTE,
    handler: async (req: unknown, res: unknown) => {
      const request = req as { url?: string; method?: string; on?: unknown }
      const response = res as { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string | Uint8Array): void }
      const url = new URL(request.url ?? '/', 'http://dsh.internal')
      const route = url.pathname.slice(GROUP_CHAT_ROUTE.length).replace(/^\/+/u, '')
      try {
        if (request.method === 'GET' && route === 'attachment-materialize') {
          const attachmentId = url.searchParams.get('attachmentId') ?? ''
          const name = url.searchParams.get('name') ?? 'attachment'
          const bytes = Number(url.searchParams.get('bytes') ?? '0')
          if (!attachmentId.startsWith('sha256:') || !Number.isSafeInteger(bytes) || bytes <= 0) {
            throw new RouteRefusal('attachment-materialize requires a sha256 attachmentId and byte count', 400)
          }
          const attachments = hostService<{ readFileStream(ref: unknown): AsyncIterable<Uint8Array> }>(ctx, 'attachments')
          if (attachments === undefined) throw new RouteRefusal('attachment store is unavailable', 501)
          const chunks: Uint8Array[] = []
          for await (const chunk of attachments.readFileStream({ attachmentId, name, bytes })) chunks.push(chunk)
          const safeName = basename(name).replace(/[^\p{L}\p{N}._-]+/gu, '_') || 'attachment'
          const directory = join(resolveWorkspaceRoot(), '.dsh-attachment-preview')
          await mkdir(directory, { recursive: true })
          const relativePath = '.dsh-attachment-preview/' + attachmentId.slice('sha256:'.length, 'sha256:'.length + 12) + '-' + safeName
          await writeFile(join(resolveWorkspaceRoot(), relativePath), Buffer.concat(chunks))
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ path: relativePath, name: safeName }))
          return
        }
        if (request.method === 'GET' && route === 'attachment-preview') {
          const attachmentId = url.searchParams.get('attachmentId') ?? ''
          const name = url.searchParams.get('name') ?? 'attachment'
          const bytes = Number(url.searchParams.get('bytes') ?? '0')
          if (!attachmentId.startsWith('sha256:') || !Number.isSafeInteger(bytes) || bytes <= 0) {
            throw new RouteRefusal('attachment-preview requires a sha256 attachmentId and byte count', 400)
          }
          const attachments = hostService<{ readFileStream(ref: unknown): AsyncIterable<Uint8Array> }>(ctx, 'attachments')
          if (attachments === undefined) throw new RouteRefusal('attachment store is unavailable', 501)
          const chunks: Uint8Array[] = []
          for await (const chunk of attachments.readFileStream({ attachmentId, name, bytes })) chunks.push(chunk)
          const body = Buffer.concat(chunks)
          const extension = name.toLowerCase().split('.').pop() ?? ''
          const contentType = extension === 'png' ? 'image/png'
            : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
              : extension === 'gif' ? 'image/gif'
                : extension === 'webp' ? 'image/webp'
                  : extension === 'pdf' ? 'application/pdf'
                    : extension === 'md' ? 'text/markdown; charset=utf-8'
                      : extension === 'json' ? 'application/json; charset=utf-8'
                        : extension === 'txt' || extension === 'log' ? 'text/plain; charset=utf-8'
                          : 'application/octet-stream'
          response.writeHead(200, {
            'content-type': contentType,
            'content-length': String(body.length),
            'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
            'cache-control': 'private, no-store',
          })
          response.end(body)
          return
        }
        const payload = await readJsonBody(request)
        const body = await handleRoomRequest(
          route, request.method ?? 'GET', payload, url, backend, runtimes, closeRoom, ctx,
        )
        // `JSON.stringify(undefined)` is `undefined`, and `end(undefined)` ends the response
        // with no body — which a client that always parses JSON reads as a parse error. A
        // handler that returns nothing (the dissolve does: the server answers 204) therefore
        // still needs an explicit empty object to be a valid JSON response.
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(body ?? null))
      } catch (error) {
        // A reachable route that cannot reach the server answers 503 with the
        // reason, so the UI can distinguish "not installed" from "server down".
        // A refusal the route reached on its own keeps its own status: "you may not
        // list that directory" is a different answer from "the server is down", and
        // collapsing them would send a reader to inspect the network.
        //
        const status = error instanceof BackendError || error instanceof RouteRefusal
          ? error.status
          : 503
        log?.error?.('[group-chat] room request failed', request.method, url.pathname, error)
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      }
    },
  }), 'group-chat: room API route')

  /**
   * Opens every room this member has joined, and keeps looking for new ones.
   *
   * A single startup read is not enough: a member joins a room, or a peer adds them
   * to one, while this container is already running, and a room nobody opened is a
   * room whose messages never reach the agent. Re-reading on the same cadence as the
   * per-room sync is what makes membership actually take effect without a restart.
   */
  const discover = async (): Promise<void> => {
    // Here rather than in `open`: an already-open room hits the `runtimes.has` branch below
    // and would never run the link check, which is exactly the state a rebuilt container
    // starts in (the volume lost the link, the plugin is freshly started).
    await ensureSharedLink()
    try {
      const joined = await backend.listRooms()
      for (const room of joined) {
        if (runtimes.has(room.id)) {
          // The policy is a live setting, so an open room picks up a change here
          // rather than keeping the value it was opened with.
          const runtime = runtimes.get(room.id)
          if (runtime !== undefined && runtime.policy !== room.agentTrigger) {
            runtime.policy = room.agentTrigger
          }
          // The model is the same kind of live setting, and the failure it causes when stale
          // is much worse than a wrong reply: the session keeps the old selection, so the room
          // keeps failing on a credential the operator already replaced. Re-applied on change
          // only — `selectModel` per poll would be a write every three seconds.
          if (runtime !== undefined && runtime.modelKey !== modelKeyOf(room)) {
            void applyModelSelection(runtime.session, room)
            runtime.modelKey = modelKeyOf(room)
          }
          continue
        }
        await open(room)
      }
    } catch (error) {
      // Logged only: the route stays up so the settings panel can report the problem.
      log?.error?.('[group-chat] opening rooms failed', error)
    }
  }

  void (async () => {
    await discover()
    // Asked after the rooms are open so a slow identity lookup cannot delay them.
    await resolveSelfId()
  })()

  const discoverTimer = setInterval(() => { void discover() }, POLL_INTERVAL_MS)
  timers.add(discoverTimer)

  const dispose = (): void => {
    // The socket goes first: it holds a live connection and a reconnect timer, and an
    // event arriving after the runtimes are gone would be delivered to nothing.
    stream.close()
    for (const timer of timers) clearInterval(timer)
    timers.clear()
    runtimes.clear()
  }

  void { open }
  return dispose
}

/**
 * Directory names the room picker can browse.
 *
 * `parent` is what lets the picker move back up without the caller re-deriving the tree, and
 * is `null` at the browsing root — there is deliberately no way to go above it.
 */
export interface DirectoryListing {
  readonly path: string
  readonly parent: string | null
  readonly entries: readonly { readonly name: string; readonly path: string }[]
}

/**
 * One agent preset as the create dialog offers it.
 *
 * `id` is the value the session controller accepts, which is the definition's own
 * `config.id` rather than the file it was declared in: the registry is indexed on the id, so
 * a name taken from a filename is a different value the moment the two disagree.
 *
 * Only `id` is always present. The rest are the registry's own optional metadata, passed
 * through rather than filled in here: a shipped preset publishes no `name` and is displayed
 * through its locale copy by the browser, and inventing a placeholder would make "no name
 * published" indistinguishable from "named after the id".
 */
export interface PresetOption {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  /** Whether the registry currently selects this preset for new sessions. */
  readonly isDefault?: boolean
  /** Present when the preset is declared but failed to activate; the browser decides what to do. */
  readonly broken?: string
}

/**
 * Serves one browser request under {@link GROUP_CHAT_ROUTE}.
 *
 * The browser reaches this through the workspace gateway, which forwards same-origin
 * requests to the DSH host, so the routes are same-origin and need no separate
 * transport or credential.
 */
export const handleRoomRequest = async (
  route: string,
  httpMethod: string,
  payload: Record<string, unknown> | undefined,
  url: URL,
  backend: GroupChatBackend,
  runtimes: ReadonlyMap<string, { session: Session; members: readonly RoomMember[] }>,
  closeRoom: (roomId: string) => void,
  ctx: GroupChatContext,
): Promise<unknown> => {
  const [resource, roomId, ...rest] = route.split('/').filter((part) => part.length > 0)
  const action = rest.join('/')

  /**
   * Batch maintenance for the throwaway Sessions an older build minted under a room.
   *
   * Report is the default; archiving needs `dryRun: false`, and deleting additionally needs
   * `purge: true` plus `confirm` equal to the room id. The canonical room Session is never a
   * candidate, and neither is another room's Session or a subagent child.
   */
  /**
   * Make one room the view: resolve its Session, give it the workspace that makes it selectable,
   * and answer with the Session id. The browser cannot do any of this itself -- it has no registry
   * and no workspace, and `openSession` refuses a Session no workspace owns.
   */
  const openMatch = /^rooms\/([^/]+)\/open$/u.exec(route)
  if (openMatch !== null && openMatch[1] !== undefined) {
    if (httpMethod !== 'POST') throw new RouteRefusal('opening a room accepts POST', 405)
    const targetRoomId = decodeURIComponent(openMatch[1])
    const room = (await backend.listRooms()).find((candidate) => candidate.id === targetRoomId)
    if (room === undefined) throw new RouteRefusal('this account is not a member of that room', 404)
    const session = await new RoomSessions(ctx).ensure(targetRoomId, {
      name: room.name,
      ...room.actor === undefined ? {} : { actor: room.actor },
      ...room.cwd === null ? {} : { cwd: room.cwd },
      agentPreset: room.agentPreset ?? undefined,
      modelProvider: room.modelProvider ?? undefined,
      model: room.model ?? undefined,
      reasoningEffort: room.reasoningEffort ?? undefined,
    })
    const directory = session.header.cwd ?? resolveRoomDirectory(targetRoomId, room.cwd)
    const workspace = await ensureRoomWorkspace(
      hostService<RoomWorkspaceRegistry>(ctx, 'workspaceRegistry'),
      directory,
      `群聊·${room.name}`,
      session.id,
    )
    return { sessionId: session.id, workspaceId: workspace.workspaceId, workspaceCreated: workspace.created }
  }

  const cleanupMatch = /^rooms\/([^/]+)\/sessions\/cleanup$/u.exec(route)
  if (cleanupMatch !== null && cleanupMatch[1] !== undefined) {
    if (httpMethod !== 'POST') throw new RouteRefusal('session cleanup accepts POST', 405)
    const targetRoomId = decodeURIComponent(cleanupMatch[1])
    let room: RoomSummary | undefined
    try {
      room = (await backend.listRooms()).find((candidate) => candidate.id === targetRoomId)
    } catch {
      // Cleanup is local maintenance: a room server that is down must not prevent a
      // workspace from cleaning up directories it already owns. Without the room record the
      // caller must name the project directory explicitly.
    }
    const requestedDirectory = payload?.['directory']
    if (requestedDirectory !== undefined
      && (typeof requestedDirectory !== 'string' || !isAbsolute(requestedDirectory))) {
      throw new RouteRefusal('directory must be an absolute path', 400)
    }
    const configuredDirectory = (requestedDirectory as string | undefined)
      ?? (room === undefined ? undefined : resolveRoomDirectory(targetRoomId, room.cwd))
    if (configuredDirectory === undefined) {
      throw new RouteRefusal(
        'room is no longer listed; pass the room directory explicitly to clean its session records',
        404,
      )
    }
    // The controller records the session's `cwd` after resolving it through `fs.realpath`.
    // Matching the raw configured spelling would miss every record when the room directory is
    // reached through a symlink or a bind-mount alias.
    const directory = await realpath(configuredDirectory).catch(() => configuredDirectory)
    // A room pointed at the workspace root would make every ordinary session in that
    // directory a cleanup candidate. A dedicated room directory is the only safe scope.
    if (resolve(directory) === resolve(resolveWorkspaceRoot())) {
      throw new RouteRefusal('refusing to clean sessions whose cwd is the workspace root', 400)
    }
    const persistence = hostService<SessionPersistenceView>(ctx, 'sessionPersistence')
    if (persistence === undefined) {
      throw new RouteRefusal('session persistence is unavailable on this host', 501)
    }
    const archive = hostService<WorkspaceArchiveView>(ctx, 'workspaceRegistry')
    const dryRun = payload?.['dryRun'] !== false
    const purge = payload?.['purge'] === true
    if (purge && payload?.['confirm'] !== targetRoomId) {
      throw new RouteRefusal('purging session directories requires confirm set to the room id', 400)
    }
    return cleanupRoomSessions({
      roomId: targetRoomId,
      directory,
      primarySessionId: roomSessionId(targetRoomId),
      persistence,
      ...archive === undefined ? {} : { archive },
      // A shared explicit cwd can hold several rooms' canonical Sessions. This process knows
      // the ones it has opened; every `group-room-*` id is excluded inside the module, so a
      // room this process has not opened is protected by the same rule.
      protectedSessionIds: [...runtimes.keys()].map((openRoomId) => roomSessionId(openRoomId)),
      dryRun,
      purge,
    })
  }

  // Message search is not scoped to one room, so it cannot go through the per-room dispatch
  // below: `rooms/messages/search` would parse as a room named `messages`. It is answered first
  // and forwarded to the room server, which owns the visibility rule.
  if (resource === 'rooms' && roomId === 'messages' && action === 'search') {
    if (httpMethod !== 'GET') throw new RouteRefusal('message search accepts GET', 405)
    const query = url.searchParams.get('query') ?? ''
    return backend.searchMessages(query)
  }

  // Who this workspace acts as, for the one client-side decision that needs it: which
  // messages are the operator's own. Read from the same account the Host already resolves
  // for routing, so the browser and the trigger rule cannot disagree about identity.
  // This workspace's own UI preferences. Served here rather than through the room server
  // because the file lives in this workspace's volume, which is what makes it survive a
  // re-login; the room server has no access to that volume.
  if (resource === 'preferences') {
    if (httpMethod === 'GET') return readPreferences()
    if (httpMethod === 'PATCH' || httpMethod === 'POST') {
      const height = payload?.['sidebarHeightPx']
      if (height !== undefined && (typeof height !== 'number' || !Number.isFinite(height))) {
        throw new RouteRefusal('sidebarHeightPx must be a finite number', 400)
      }
      // A patch that names no field returns what is stored rather than writing an empty file,
      // so a client that re-sends its current state cannot clear the other fields by omission.
      const current = await readPreferences()
      return writePreferences({
        ...current,
        ...height === undefined ? {} : { sidebarHeightPx: height },
      })
    }
    throw new RouteRefusal('preferences accepts GET and PATCH', 405)
  }

  if (resource === 'me' && httpMethod === 'GET') {
    const me = await backend.whoami()
    return {
      id: me?.id ?? null,
      displayName: me?.displayName ?? null,
      // Role codes ride along so the browser can decide whether to *offer* dissolving a
      // room it does not own. The room server still authorizes the request itself; this
      // only keeps the entry off a roster the server would refuse.
      roleCodes: me?.roleCodes ?? null,
    }
  }

  // Deployment-wide choices, answered here rather than forwarded. Neither is a room, and
  // neither can be answered by the browser: it cannot enumerate a container's directories,
  // and the preset names live in the bundle the Host was started from rather than in the
  // room server. Both therefore answer from the Host's own environment, with no credential
  // in play — a picker that needed the room server to render would be unusable exactly when
  // the server is the thing that is down.
  if (resource === 'options' && httpMethod === 'GET') {
    return { presets: await listPresetOptions(ctx) }
  }
  if (resource === 'directories' && httpMethod === 'GET') {
    return listDirectories(url.searchParams.get('path') ?? undefined)
  }

  // One room's shared folder. Separate from `directories`: that resource is the create
  // dialog's picker over the whole workspace, while this one is a member-facing view of the
  // folder their room shares, and the two must not share an authorization boundary.
  const filesMatch = /^rooms\/([^/]+)\/files$/u.exec(route)
  if (filesMatch !== null && httpMethod === 'GET' && filesMatch[1] !== undefined) {
    const rooms = await backend.listRooms()
    const room = rooms.find((candidate) => candidate.id === decodeURIComponent(filesMatch[1]))
    return listRoomFiles(
      decodeURIComponent(filesMatch[1]),
      room?.cwd,
      url.searchParams.get('path'),
    )
  }

  // One file's contents. The path travels in the query rather than the route so a file
  // whose name contains `/` (a subfolder) does not need escaping that differs per client.
  // Upload: the body carries the name and the bytes, so one request is one file. A multipart
  // parser would be a second body format for no gain — the same JSON envelope the rest of this
  // API uses already carries both fields.
  const uploadMatch = /^rooms\/([^/]+)\/files$/u.exec(route)
  if (uploadMatch !== null && httpMethod === 'POST' && uploadMatch[1] !== undefined) {
    const roomId = decodeURIComponent(uploadMatch[1])
    const rooms = await backend.listRooms()
    const room = rooms.find((candidate) => candidate.id === roomId)
    const name = typeof payload?.['name'] === 'string' ? payload['name'] : ''
    const data = typeof payload?.['data'] === 'string' ? payload['data'] : ''
    if (name.trim().length === 0) throw new RouteRefusal('group-chat needs a file name to upload', 400)
    if (data.length === 0) throw new RouteRefusal('group-chat needs file data to upload', 400)
    return writeRoomFile(roomId, name, data, room?.cwd)
  }

  const fileContentMatch = /^rooms\/([^/]+)\/file-content$/u.exec(route)
  if (fileContentMatch !== null && httpMethod === 'GET' && fileContentMatch[1] !== undefined) {
    const roomId = decodeURIComponent(fileContentMatch[1])
    const rooms = await backend.listRooms()
    const room = rooms.find((candidate) => candidate.id === roomId)
    return readRoomFile(roomId, url.searchParams.get('path') ?? '', room?.cwd)
  }

  // Rooms this account could join, which is a different question from the rooms it is in.
  //
  // A distinct resource rather than a flag on `/rooms`: the two answer different questions, and
  // a shared route would have to widen the sidebar's list or silently ignore the flag. The
  // query only narrows what the server already decided is visible; it never grants visibility.
  if (resource === 'discover' && httpMethod === 'GET') {
    return backend.listDiscoverableRooms(url.searchParams.get('query') ?? undefined)
  }

  if (resource !== 'rooms') throw new Error(`unknown group-chat request: ${httpMethod} ${route}`)

  if (roomId === undefined) {
    if (httpMethod === 'GET') return backend.listRooms()
    if (httpMethod === 'POST') {
      const name = typeof payload?.['name'] === 'string' ? payload['name'] : ''
      if (name.trim().length === 0) throw new Error('group-chat create needs a room name')
      return backend.createRoom(name, readExecution(payload))
    }
    throw new Error(`unknown group-chat request: ${httpMethod} ${route}`)
  }

  // A pending reply, registered by the browser so the publish path can attach it. It never
  // reaches the room server: the message itself is submitted by the official composer, and this
  // plugin only sees the resulting session event, so the quote waits here until that event
  // arrives and is consumed then.
  if (action === 'join' && httpMethod === 'POST') return backend.joinRoom(roomId)

  if (httpMethod === 'GET') {
    if (action === 'events') {
      const cursor = url.searchParams.get('cursor') ?? undefined
      const limit = url.searchParams.get('limit')
      return backend.listEvents(roomId, cursor, limit === null ? undefined : Number(limit))
    }
    if (action === 'members') return backend.listMembers(roomId)
    // Forwarded unchanged: the server owns who may be invited and who is already a member,
    // so filtering here would be a second, divergent copy of that policy.
    if (action === 'invite-candidates') {
      const q = url.searchParams.get('q')
      return backend.inviteCandidates(roomId, q === null ? undefined : q)
    }
    if (action === 'state') {
      const runtime = runtimes.get(roomId)
      return {
        roomId,
        open: runtime !== undefined,
        memberCount: runtime?.members.length ?? 0,
      }
    }
  }

  if (httpMethod === 'POST') {
    /**
     * The upstream path, and the order is the contract.
     *
     * The message reaches the server first and this returns the event the server settled;
     * the room's own poll then delivers that same event back through {@link deliver},
     * which is what appends it to the local session. Appending locally first would put a
     * message in the agent's context that the server might never accept, and the two
     * copies would then disagree about the room's history.
     */
    if (action === 'messages') {
      // Text or content blocks. Reading only the string case would turn a message that carries
      // an image into an empty one, and the server would reject it as blank — which looks like
      // the route being broken rather than the block list being dropped here.
      const raw = payload?.['content']
      const content = typeof raw === 'string'
        ? raw
        : Array.isArray(raw) ? raw as readonly ContentBlockLike[] : ''
      const rpcId = typeof payload?.['rpcId'] === 'string' && payload['rpcId'].length > 0
        ? payload['rpcId']
        : `web-${String(Date.now())}`
      // Structured mentions, forwarded as ids rather than parsed from the text: the room's
      // reply policy turns on whether the sender mentioned *this* workspace's member, and a
      // regex over the words would both miss display-name variants and match a name in prose.
      const rawMentions = payload?.['mentions']
      const mentions = Array.isArray(rawMentions)
        ? rawMentions.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : undefined
      return backend.sendMessage(roomId, {
        content,
        rpcId,
        ...mentions === undefined || mentions.length === 0 ? {} : { mentions },
      })
    }
    if (action === 'update') return backend.updateRoom(roomId, readPolicyPatch(payload))
    // Forwarded unchanged for the same reason as the invite: the server owns which member may
    // write the announcement, and a copy of that rule here could deny the owner or, worse, let
    // the browser believe a save succeeded that the server refuses. The type is checked because
    // the backend's DTO would reject a non-string anyway — and a silently coerced empty string
    // would read as "clear the announcement", which is a destructive default to take for a
    // caller that simply sent the wrong shape.
    if (action === 'announcement') {
      const announcement = payload?.['announcement']
      if (!isString(announcement)) {
        throw new RouteRefusal('group-chat set announcement needs an announcement string', 400)
      }
      return backend.setAnnouncement(roomId, announcement)
    }
    if (action === 'members') {
      const userIds = Array.isArray(payload?.['userIds']) ? payload['userIds'].filter(isString) : []
      return backend.inviteMembers(roomId, userIds)
    }
    // Who may hand a room over, and to whom, is the server's rule; only the shape is checked
    // here so a malformed call fails as a 400 instead of reaching the server as an empty id.
    if (action === 'transfer') {
      const userId = payload?.['userId']
      if (!isString(userId) || userId.length === 0) {
        throw new RouteRefusal('group-chat transfer needs a userId string', 400)
      }
      return backend.transferOwnership(roomId, userId)
    }
}

  // Leaving is matched before the parameterised removal below: both are
  // `DELETE rooms/<id>/members/<x>`, and only this order keeps the reserved word `me` from
  // being read as a user id. The server refuses the owner as a removal target anyway, so the
  // order decides which route answers, not who is allowed to do what.
  if (httpMethod === 'DELETE' && action === 'members/me') return backend.leaveRoom(roomId)

  // Removing another member. `members/<userId>` is checked here rather than as an exact
  // action so the id can be any value the server issued.
  const removal = /^members\/([^/]+)$/u.exec(action)
  if (httpMethod === 'DELETE' && removal !== null && removal[1] !== undefined) {
    return backend.removeMember(roomId, decodeURIComponent(removal[1]))
  }

  // Dissolving deletes the room itself, so it is the one DELETE that takes no action segment.
  // Kept last so it cannot shadow the nested routes above, which all carry one.
  if (httpMethod === 'DELETE' && action === '') {
    const dissolved = await backend.dissolveRoom(roomId)
    // The server is now the only authority on whether this room exists; once it says it is
    // gone, the local half must stop describing it. Clearing the poll loop first keeps a
    // queued tick from re-reading a room the server already deleted.
    closeRoom(roomId)
    return dissolved
  }

  throw new Error(`unknown group-chat request: ${httpMethod} ${route}`)
}

const isString = (value: unknown): value is string => typeof value === 'string'

/**
 * Read the create-time execution scope.
 *
 * `cwd` and the preset decide what the room's agent may touch on any member's behalf, so
 * they travel with creation and are never accepted as later updates.
 */
/**
 * The platforms a room may mirror.
 *
 * A closed list rather than any string: the backend stores the channel and later trusts it when
 * it stamps incoming messages, so an unknown kind would create a room that claims a bridge no
 * consumer can render.
 */
const EXTERNAL_CHANNEL_KINDS: readonly ExternalChannel['kind'][] = ['qqbot', 'wecom', 'dingtalk']

/** Read a well-formed external channel from a create/update payload. */
const externalChannelOf = (payload: Record<string, unknown> | undefined): ExternalChannel | undefined => {
  const raw = payload?.['externalChannel']
  if (typeof raw !== 'object' || raw === null) return undefined
  const channel = raw as Record<string, unknown>
  const kind = channel['kind']
  if (typeof kind !== 'string' || !(EXTERNAL_CHANNEL_KINDS as readonly string[]).includes(kind)) return undefined
  const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
  const groupOpenid = text(channel['groupOpenid'])
  const chatId = text(channel['chatId'])
  // QQ rooms predate `externalGroupId`, so its group id is accepted from either field. Every
  // other platform has only the canonical field; `chatId` is an alias, not a second group.
  const externalGroupId = text(channel['externalGroupId']) || groupOpenid || chatId
  if (externalGroupId.length === 0) return undefined
  return {
    kind: kind as ExternalChannel['kind'],
    externalGroupId,
    ...kind === 'qqbot' ? { groupOpenid: groupOpenid || externalGroupId } : {},
    ...chatId.length === 0 ? {} : { chatId },
    ...text(channel['botId']).length === 0 ? {} : { botId: text(channel['botId']) },
  }
}

/** Exposed for tests: the exact shape a create/update may forward. */
export const externalChannelOfForTest = externalChannelOf

const readExecution = (
  payload: Record<string, unknown> | undefined,
): { cwd?: string; agentPreset?: string; actor?: unknown; externalChannel?: ExternalChannel } => ({
  ...payload?.['actor'] === undefined ? {} : { actor: payload['actor'] },
  // Only a well-formed channel is forwarded: the backend stores what it is given, so a malformed
  // value would create a room that claims a bridge it does not have.
  ...externalChannelOf(payload) === undefined ? {} : { externalChannel: externalChannelOf(payload) },
  ...typeof payload?.['cwd'] === 'string' && payload['cwd'].trim().length > 0
    ? { cwd: payload['cwd'].trim() } : {},
  ...typeof payload?.['agentPreset'] === 'string' && payload['agentPreset'].trim().length > 0
    ? { agentPreset: payload['agentPreset'].trim() } : {},
})

/** Read the room-policy fields an update may carry, dropping anything else. */
const readPolicyPatch = (payload: Record<string, unknown> | undefined) => ({
  ...typeof payload?.['name'] === 'string' ? { name: payload['name'] } : {},
  ...typeof payload?.['invitePolicy'] === 'string' ? { invitePolicy: payload['invitePolicy'] } : {},
  ...typeof payload?.['discoverability'] === 'string' ? { discoverability: payload['discoverability'] } : {},
  ...typeof payload?.['agentTrigger'] === 'string' ? { agentTrigger: payload['agentTrigger'] } : {},
  // Attaching or detaching the bridge is a policy edit like the rest; a malformed value is dropped
  // rather than forwarded, and its absence leaves the room's channel exactly as it was.
  ...externalChannelOf(payload) === undefined ? {} : { externalChannel: externalChannelOf(payload) },
})

/** A refusal this route reached on its own, carrying the status the browser should see. */
class RouteRefusal extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'RouteRefusal'
  }
}

/** Extension that marks a preset file, and therefore what a preset name is not. */
const PRESET_SUFFIX = '.patch.yml'

/**
 * Where the presets the running Host accepts are declared.
 *
 * Resolved from the DSH entry that is actually running rather than from a fixed path: a
 * deployment can carry several installs of the same package, and only the copy the Host was
 * started from backs the preset ids it will accept. A name read off any other copy would be
 * offered by the picker and then rejected at creation.
 *
 * The managed image install is kept as a fallback because this plugin also loads where the
 * resolution fails — a Host started from a bundle whose dependencies are not resolvable —
 * and an empty list is the one outcome that would take the picker away entirely.
 */
const presetDirectories = (): readonly string[] => {
  const candidates: string[] = []
  for (const anchor of [process.argv[1], import.meta.url]) {
    if (anchor === undefined) continue
    try {
      candidates.push(join(dirname(createRequire(anchor).resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets'))
    } catch {
      // Not resolvable from this anchor; the remaining candidates still apply.
    }
  }
  candidates.push('/opt/dsh-plus/node_modules/@deepseek-ai/dsh-web-app/presets')
  return candidates
}

/**
 * Preset names the deployment offers.
 *
 * Every candidate directory is read because a name present in any of them is still a name
 * this Host may accept; the union is de-duplicated by name, which is what makes the answer
 * stable across a deployment that carries more than one copy.
 *
 * @returns the names, sorted; an empty list when no directory could be read at all.
 */
const listPresetNames = async (): Promise<readonly string[]> => {
  const names = new Set<string>()
  for (const directory of presetDirectories()) {
    let files: string[]
    try {
      files = await readdir(directory)
    } catch {
      // An unreadable candidate is not a failure: the picker falls back to typing, and an
      // error here would instead take the whole create dialog down with it.
      continue
    }
    for (const file of files) {
      if (!file.endsWith(PRESET_SUFFIX)) continue
      const preset = file.slice(0, -PRESET_SUFFIX.length)
      if (preset.length > 0) names.add(preset)
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

/** The slice of the official preset registry this route reads; everything else is unused here. */
interface AgentPresetRoster {
  list(): Promise<readonly PresetRosterRow[]>
  readonly defaultId: string
}

interface PresetRosterRow {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly broken?: string
}

/**
 * The preset roster as the browser should offer it.
 *
 * The registry is the authority and the filenames are not: a definition is indexed by its
 * own `config.id`, so the two agree only by coincidence — the shipped four happen to — and a
 * deployment that adds one where they differ would have the picker offer a name the session
 * controller rejects, with the failure surfacing at room creation instead of here.
 *
 * Looked up rather than injected on purpose. The registry is part of this deployment's
 * composition, but this plugin must also load where it is absent — a headless or otherwise
 * trimmed profile — and declaring it a hard dependency would keep the room runtime from
 * starting over a picker's data source. `undefined` therefore means "fall back", not "fail".
 *
 * @param ctx - the activated plugin's context, used only for this optional service lookup.
 * @returns roster rows sorted by the registry's own order; filenames only when no registry
 * answered, in which case each row carries nothing but its id.
 */
const listPresetOptions = async (ctx: GroupChatContext): Promise<readonly PresetOption[]> => {
  let presets: AgentPresetRoster | undefined
  try {
    presets = ctx.get('agentPresets') as AgentPresetRoster | undefined
  } catch {
    // A context whose lookup itself throws is indistinguishable from one without the
    // service, and the picker must still render.
    presets = undefined
  }
  if (presets !== undefined) {
    try {
      const roster = await presets.list()
      const defaultId = presets.defaultId
      return roster.map((row) => ({
        id: row.id,
        // Each optional field is forwarded only when the registry published it: a filled-in
        // default here would be this plugin's wording, not the preset's, and the browser
        // distinguishes "named in YAML" from "shipped, translated by locale" by its absence.
        ...row.name === undefined ? {} : { name: row.name },
        ...row.description === undefined ? {} : { description: row.description },
        ...row.order === undefined ? {} : { order: row.order },
        ...row.id === defaultId ? { isDefault: true } : {},
        // A broken preset is still declared, so it is reported rather than hidden: the
        // browser shows it disabled, which is the only way an operator learns why a room on
        // it will not start.
        ...row.broken === undefined ? {} : { broken: row.broken },
      }))
    } catch {
      // A registry that cannot enumerate is a degraded deployment, not a broken picker.
    }
  }
  // Fallback: the filenames, ids only, for a deployment whose preset files are all that can
  // be read. `isDefault` is omitted rather than guessed — nothing here knows the selection.
  return (await listPresetNames()).map((id) => ({ id }))
}

/** The one directory tree the picker may browse, and therefore the boundary it may not cross. */
const browseRoot = (): string =>
  resolve(process.env[MANAGED_ENV.mountPath]?.trim() || '/workspace')

/** The shared tree's mount point, or undefined when this deployment has none. */
const sharedRootPath = (): string | undefined => {
  const value = process.env[MANAGED_ENV.sharedRoot]?.trim()
  return value === undefined || value.length === 0 ? undefined : resolve(value)
}

/** One file in a room's shared folder. */
export interface SharedFile {
  /** Path relative to the room's folder, which is what a message quotes. */
  readonly path: string
  readonly name: string
  readonly size: number
  /** True when the entry is a directory, so the browser can show it as one. */
  readonly directory: boolean
}

/** The shared folder of one room, as the browser lists it. */
export interface RoomFiles {
  /** The room's folder, or null when this deployment has no shared tree. */
  readonly path: string | null
  /** Where this listing is, relative to the room folder. Empty at the top. */
  readonly relativePath: string
  /** One entry per level from the room folder down to here, for breadcrumbs. */
  readonly crumbs: readonly { readonly name: string; readonly path: string }[]
  readonly files: readonly SharedFile[]
  /** Why the folder could not be read, when it could not. */
  readonly error?: string
}

/**
 * List one room's shared folder.
 *
 * The room id is the only thing the browser supplies, and it is validated as a single path
 * segment rather than trusted: a value like `../../etc` would otherwise walk out of the
 * shared tree. Everything else — the mount point, the folder layout — comes from the host's
 * own environment, so the browser cannot aim this at another location.
 *
 * @param roomId - the room whose folder to read.
 * @returns the listing, or an empty one when no shared tree is configured.
 */
const listRoomFiles = async (
  roomId: string,
  configured?: string | null,
  subPath?: string | null,
): Promise<RoomFiles> => {
  const root = sharedRootPath()
  if (root === undefined) return { path: null, relativePath: '', crumbs: [], files: [] }
  // One segment only: this rejects `..`, separators, and anything that would leave the tree.
  if (!/^[A-Za-z0-9._-]+$/u.test(roomId) || roomId === '.' || roomId === '..') {
    throw new RouteRefusal('group-chat needs a plain room id to list its files', 400)
  }
  // A room whose cwd already points inside the shared tree lists *that* folder: the creator
  // chose it, and a room that names its own folder would otherwise show a different one than
  // its agent writes to. Everything else falls back to the per-room convention. The cwd is
  // only honoured when it resolves inside the tree, so it cannot be used to list elsewhere.
  const chosen = configured?.trim()
  const folder = chosen === undefined || chosen.length === 0 ? join(root, roomId) : resolve(chosen)
  const roomFolder = withinRoot(resolve(root), folder) ? folder : join(root, roomId)
  if (!withinRoot(root, roomFolder)) {
    throw new RouteRefusal('group-chat will not list outside the shared tree', 403)
  }
  // A subfolder is resolved against the room's folder and re-checked, so `../..` in the
  // browser's request cannot walk up out of the room even though the browser supplies it.
  const trimmedSub = subPath?.trim() ?? ''
  const directory = trimmedSub.length === 0 ? roomFolder : resolve(roomFolder, trimmedSub)
  if (!withinRoot(roomFolder, directory)) {
    throw new RouteRefusal('group-chat will not list outside the room folder', 403)
  }

  const relativePath = relative(roomFolder, directory).split(sep).join('/')
  const crumbs: { name: string; path: string }[] = []
  for (let index = 1; index <= (relativePath === '' ? 0 : relativePath.split('/').length); index += 1) {
    const slice = relativePath.split('/').slice(0, index).join('/')
    crumbs.push({ name: slice.split('/').at(-1) ?? slice, path: slice })
  }

  let dirents: Dirent[]
  try {
    dirents = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    // A room whose folder does not exist yet is not an error: the folder appears on the
    // first upload or the first thing the agent writes. Report it as empty instead.
    const missing = (error as { code?: string }).code === 'ENOENT'
    return {
      path: directory,
      relativePath,
      crumbs,
      files: [],
      ...missing ? {} : { error: 'unreadable' },
    }
  }

  const files: SharedFile[] = []
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue
    const absolute = join(directory, dirent.name)
    let size = 0
    try {
      const info = await stat(absolute)
      size = info.size
    } catch {
      continue
    }
    files.push({ path: dirent.name, name: dirent.name, size, directory: dirent.isDirectory() })
  }
  files.sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1
    return left.name.localeCompare(right.name)
  })
  return { path: directory, relativePath, crumbs, files }
}

/** True when `target` is `root` itself or sits underneath it. */
const withinRoot = (root: string, target: string): boolean => {
  const offset = relative(root, target)
  return offset.length === 0 || (!offset.startsWith('..') && !isAbsolute(offset))
}

/**
 * The directories directly under `requested`.
 *
 * A directory picker is the one place this plugin lets the browser name a path, so the root
 * is a boundary rather than a default. Two checks enforce it because they stop different
 * things: the resolved path is compared lexically, which catches `../`, and the canonical
 * path is compared too, which catches a symlink that leaves the tree while still spelling
 * like it belongs to it. The root is canonicalized for the same reason — a bind-mounted
 * `/workspace` would otherwise fail every comparison against its own contents.
 *
 * @param requested - an absolute path, or nothing for the root of the tree.
 * @returns the listing; an unreadable directory answers empty rather than failing, because a
 * picker that errors cannot be used to navigate back out of a path that went away.
 */
const listDirectories = async (requested?: string): Promise<DirectoryListing> => {
  const root = browseRoot()
  const asked = requested === undefined || requested.trim().length === 0 ? root : resolve(requested.trim())

  // Best-effort: an unresolvable root is still a usable boundary lexically.
  const realRoot = await realpath(root).catch(() => root)
  const canonical = await realpath(asked).catch(() => undefined)

  const allowed = canonical === undefined ? withinRoot(root, asked) : withinRoot(realRoot, canonical)
  if (!allowed) throw new RouteRefusal(`group-chat will not list outside ${root}`, 403)

  const target = canonical ?? asked
  const parent = target === realRoot || target === root ? null : dirname(target)

  let dirents: Dirent[]
  try {
    dirents = await readdir(target, { withFileTypes: true })
  } catch {
    return { path: target, parent, entries: [] }
  }

  const entries: { name: string; path: string }[] = []
  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: join(target, dirent.name) })
      continue
    }
    // A symlink is listed only when it lands back inside the tree: the picker's own rows
    // travel back as paths, so one that pointed out would be a way to browse the container
    // and then to aim a room's agent at it.
    if (!dirent.isSymbolicLink()) continue
    const linked = join(target, dirent.name)
    const real = await realpath(linked).catch(() => undefined)
    if (real === undefined || !withinRoot(realRoot, real)) continue
    if (!(await stat(real)).isDirectory()) continue
    entries.push({ name: dirent.name, path: linked })
  }

  entries.sort((left, right) => left.name.localeCompare(right.name))
  return { path: target, parent, entries }
}

/** One shared file's text, as the preview shows it. */
export interface SharedFileText {
  readonly path: string
  readonly name: string
  /** Truncated to {@link MAX_PREVIEW_BYTES}; `truncated` says whether it was. */
  readonly text: string
  readonly truncated: boolean
  /** False for a binary file, so the preview says so instead of showing mojibake. */
  readonly textLike: boolean
  /**
   * Data URL for an image the panel can draw inline, when the file is a supported image.
   *
   * Inline bytes rather than a URL to fetch: the browser cannot reach this folder on its own
   * (it is a container path), and a second authenticated route for one `<img>` would be more
   * surface than the picture is worth. Images are capped far below the text preview limit —
   * a 256 KB data URL is already a large DOM attribute.
   */
  readonly image?: string
}

/** Images the panel draws inline. Anything else is reported as a binary file. */
const INLINE_IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

/** Larger images are reported as files rather than inlined: a data URL this big stalls the panel. */
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024

/** How much of a file the preview reads. A shared folder holds reports, not datasets. */
const MAX_PREVIEW_BYTES = 256 * 1024

/**
 * Read one file out of a room's shared folder.
 *
 * The caller supplies a path relative to the folder, and it is resolved against the folder
 * rather than used as given: `..` and absolute paths are refused before touching the
 * filesystem, so a request cannot name a file outside the shared tree even if the room's own
 * folder is deep inside it.
 *
 * @param roomId - the room whose folder to read from.
 * @param relativePath - the file's path inside that folder.
 * @param configured - the room's own `cwd`, which decides the folder (same rule as listing).
 * @returns the file's text, or a refusal when it cannot be read as text.
 */
const readRoomFile = async (
  roomId: string,
  relativePath: string,
  configured?: string | null,
): Promise<SharedFileText> => {
  const listing = await listRoomFiles(roomId, configured)
  if (listing.path === null) throw new RouteRefusal('this deployment has no shared folder', 404)

  const trimmed = relativePath.trim()
  if (trimmed.length === 0) throw new RouteRefusal('group-chat needs a file path to read', 400)
  const folder = resolve(listing.path)
  const target = resolve(folder, trimmed)
  // Lexical containment first: it rejects `..` and absolute paths without touching the disk.
  if (!withinRoot(folder, target) || target === folder) {
    throw new RouteRefusal('group-chat will not read outside the room folder', 403)
  }
  // Canonical containment second: a symlink that spells like it belongs here but points out.
  const realFolder = await realpath(folder).catch(() => folder)
  const realTarget = await realpath(target).catch(() => undefined)
  if (realTarget === undefined) throw new RouteRefusal('file not found', 404)
  if (!withinRoot(realFolder, realTarget)) {
    throw new RouteRefusal('group-chat will not read outside the room folder', 403)
  }

  let handle
  try {
    handle = await open(realTarget, 'r')
  } catch {
    throw new RouteRefusal('file not found', 404)
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new RouteRefusal('not a regular file', 400)
    const length = Math.min(info.size, MAX_PREVIEW_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    // An image is recognised by extension, not content sniffing: the panel only needs to know
    // whether it can draw the bytes, and a wrong guess there costs a broken `<img>` while a
    // wrong guess here costs the same. The whole file is read only when it is small enough to
    // inline, so a large image is reported as a file without being buffered.
    const extension = basename(realTarget).toLowerCase().slice(basename(realTarget).lastIndexOf('.'))
    const imageType = INLINE_IMAGE_TYPES[extension]
    if (imageType !== undefined && info.size <= MAX_INLINE_IMAGE_BYTES) {
      const whole = info.size <= length
        ? buffer.subarray(0, info.size)
        : await readFile(realTarget)
      return {
        path: relativePath,
        name: basename(relativePath),
        text: '',
        truncated: false,
        textLike: false,
        image: `data:${imageType};base64,${whole.toString('base64')}`,
      }
    }

    // NUL bytes in the first chunk are the cheap, reliable "this is not text" signal; a
    // stricter test would need a charset detector to say the same thing less clearly.
    const textLike = !buffer.includes(0)
    return {
      path: relativePath,
      name: basename(relativePath),
      text: textLike ? buffer.toString('utf8') : '',
      truncated: info.size > MAX_PREVIEW_BYTES,
      textLike,
    }
  } finally {
    await handle.close()
  }
}

/** What an upload reported after writing. */
export interface SharedFileWrite {
  readonly path: string
  readonly name: string
  readonly size: number
}

/**
 * Write one uploaded file into a room's shared folder.
 *
 * The name is rebuilt rather than trusted: a browser sends whatever the file was called, and
 * a name like `../../.ssh/authorized_keys` would otherwise write outside the room. Only the
 * final path segment is kept, and leading dots are stripped so an upload cannot shadow a
 * hidden file the container may rely on. The result is re-checked against the folder after
 * joining, so a name that survives sanitizing but still escapes is refused.
 *
 * Overwriting is allowed on purpose: the shared folder is a working tree that members and the
 * room's agent both write, and "upload the new version of the deck" is the common case.
 *
 * @param roomId - the room whose folder to write into.
 * @param name - the client-supplied file name.
 * @param base64 - the file's bytes, base64 encoded.
 * @param configured - the room's own `cwd`, which decides the folder.
 * @returns the written file.
 */
const writeRoomFile = async (
  roomId: string,
  name: string,
  base64: string,
  configured?: string | null,
): Promise<SharedFileWrite> => {
  const listing = await listRoomFiles(roomId, configured)
  if (listing.path === null) throw new RouteRefusal('this deployment has no shared folder', 404)
  const folder = resolve(listing.path)

  const leaf = basename(name.trim().replaceAll('\\', '/')).replace(/^\.+/u, '')
  if (leaf.length === 0) throw new RouteRefusal('group-chat needs a file name to upload', 400)
  if (leaf === '.' || leaf === '..') throw new RouteRefusal('group-chat refused that file name', 400)
  const target = resolve(folder, leaf)
  if (!withinRoot(folder, target) || target === folder) {
    throw new RouteRefusal('group-chat will not write outside the room folder', 403)
  }

  // Base64 with no data URL prefix: the browser sends `btoa` output, and accepting a prefix
  // would mean guessing which decoder to use for a payload we could just have validated.
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0) throw new RouteRefusal('group-chat refused an empty file', 400)
  if (bytes.length > MAX_UPLOAD_BYTES) throw new RouteRefusal('file is too large', 413)

  // The folder appears on first write. `recursive` keeps a room usable before anyone has put
  // anything in it, which is the normal state of a new room.
  await mkdir(folder, { recursive: true })
  // Written to a sibling temp file and renamed into place. `rename` is atomic within one
  // filesystem, so a reader never sees a half-written file — which matters on the NAS mount:
  // two members uploading the same name, or the room's agent reading while one uploads, would
  // otherwise be able to observe a truncated document. A direct `writeFile` also leaves the
  // previous version destroyed the moment the upload fails midway.
  const temp = join(folder, `.upload-${String(process.pid)}-${randomUUID()}`)
  try {
    await writeFile(temp, bytes)
    await rename(temp, target)
  } catch (error) {
    // A failed upload must not leave debris in the shared folder: the temp name is hidden
    // from listings (leading dot) but it is still bytes on the NAS.
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  const info = await stat(target)
  return { path: leaf, name: leaf, size: info.size }
}

/**
 * Read and parse a JSON request body.
 *
 * The route owns the full response lifecycle, so no framework body parser has run: the
 * stream is read here. A body larger than {@link MAX_REQUEST_BYTES} is refused rather
 * than buffered, since the only bodies this route accepts are small JSON objects.
 */
const readJsonBody = async (req: { on?: unknown }): Promise<Record<string, unknown> | undefined> => {
  const stream = req as AsyncIterable<Uint8Array>
  if (typeof stream[Symbol.asyncIterator] !== 'function') return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > MAX_UPLOAD_BYTES) throw new Error('group-chat request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    throw new Error('group-chat request body is not valid JSON')
  }
}

/** Largest request body this route accepts; the largest legitimate one is a message. */
/** Limit for the small JSON bodies (names, ids, announcements). */
const MAX_REQUEST_BYTES = 64 * 1024
/**
 * Limit for a shared-folder upload.
 *
 * The body is base64 JSON, so the wire size is ~4/3 of the file. 16 MB on the wire is a 12 MB
 * file — enough for a report or a deck, small enough that a mistaken upload cannot fill the
 * NAS from one request. Larger files belong on the NAS directly; the folder is a shared tree,
 * not an upload endpoint for datasets.
 */
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024
