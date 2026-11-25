/**
 * Maintenance for the sessions a room owns in one workspace.
 *
 * A room has exactly one canonical Session, addressed by {@link roomSessionId}. Before
 * this module existed, a host restart could instead leave behind throwaway
 * `session-<uuid>` records in the room's project directory: the controller's
 * `create({ sessionId })` mints a new Session whenever the named one has already
 * started a turn, and the room code treated that minted identity as a failed open and
 * retried on every discovery poll. The result was thousands of idle Session
 * directories, all with the same `cwd`, which slowed every `session/list`.
 *
 * The cleanup endpoint therefore works on the *physical* project directory rather
 * than on a plugin-owned index: legacy garbage was never indexed, and a workspace
 * upgraded from an affected build must be able to find it. Candidate selection is
 * intentionally narrow — only minted `session-<uuid>` records, only in the named
 * directory, never the canonical room Session, never another room's Session, and
 * never a subagent child. A cleanup run cannot delete an ordinary named Session or a
 * conversation someone deliberately created.
 *
 * @module @sparkelf/dsh-group-chat/session-maintenance
 */
import { rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { SessionPersistenceView, WorkspaceArchiveView } from './context.ts'
import { ROOM_SESSION_PREFIX } from './session-id.ts'

export type { SessionPersistenceView, WorkspaceArchiveView } from './context.ts'

/** Snapshot shapes this module reads; kept structural so tests need no DSH runtime. */
export interface RoomSessionRecord {
  readonly header: {
    readonly id: string
    readonly cwd?: string
    readonly origin?: string
    readonly parentSession?: string
  }
}

/** What one cleanup run did, or would do on a dry run. */
export interface RoomSessionCleanupResult {
  readonly roomId: string
  readonly directory: string
  readonly primarySessionId: string
  readonly mode: 'report' | 'archive' | 'purge'
  /** Every stored Session the backend reported, across all directories. */
  readonly scanned: number
  /** Minted throwaway Sessions belonging to this room. */
  readonly candidates: readonly string[]
  /** Sessions that received the durable archive marker in this run. */
  readonly archived: readonly string[]
  /** Session directories physically removed in this run. */
  readonly removed: readonly string[]
  /** Per-session failures; a failed archive does not stop the others. */
  readonly errors: readonly { readonly sessionId: string; readonly message: string }[]
}

/** Inputs to one cleanup run. */
export interface RoomSessionCleanupInput {
  readonly roomId: string
  /** The room's project directory, exactly as its Sessions recorded it. */
  readonly directory: string
  /** The one Session a room is supposed to have. */
  readonly primarySessionId: string
  readonly persistence: SessionPersistenceView
  readonly archive?: WorkspaceArchiveView
  /**
   * Canonical Sessions of other open rooms that share this directory.
   *
   * Every `group-room-*` id is already excluded; this set covers the same rule for
   * callers that know about a room the current process has not opened yet.
   */
  readonly protectedSessionIds?: Iterable<string>
  /** Defaults to true: a cleanup request never deletes unless it says so. */
  readonly dryRun?: boolean
  /** Delete candidates instead of only archiving them. Requires an explicit request. */
  readonly purge?: boolean
}

/**
 * A Session identity minted by the controller for a conversation that asked for a
 * different named id. Only this shape is ever a cleanup candidate.
 */
export const isMintedSessionId = (sessionId: string): boolean =>
  /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(sessionId)

/** Whether a stored Session is a throwaway record this room's cleanup may touch. */
export const isRoomSubSession = (
  record: RoomSessionRecord,
  directory: string,
  primarySessionId: string,
  protectedSessionIds: ReadonlySet<string> = new Set(),
): boolean => {
  const header = record.header
  if (header.cwd !== directory) return false
  if (header.id === primarySessionId) return false
  if (protectedSessionIds.has(header.id)) return false
  // Every canonical room Session, including one for a room this process has not opened,
  // shares the `group-room-` namespace. Deleting one would destroy another room's history.
  if (header.id.startsWith(ROOM_SESSION_PREFIX)) return false
  // A subagent is legitimate conversation lineage, not a duplicate room record.
  if (header.origin === 'subagent' || header.parentSession !== undefined) return false
  return isMintedSessionId(header.id)
}

/**
 * The JSONL backend's readable project directory name.
 *
 * Mirrors the storage layout documented by `dsh-session-persistence-jsonl`: separators
 * collapse to one `-`, unsafe code units use `~XXXX`, and the result is bounded for
 * filesystem component limits. The plugin needs the physical directory only to purge;
 * a backend whose layout differs must keep its `root` unset so purge is refused.
 */
export const roomProjectKey = (cwd: string): string => {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/u.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/u, '') || 'root').slice(0, 251)}--`
}

/** The JSONL backend's escaped single path segment. */
export const sessionIdSegment = (sessionId: string): string => {
  if (sessionId.length === 0) throw new Error('cannot encode an empty session id')
  if (sessionId === '.') return '~002E'
  if (sessionId === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < sessionId.length; index += 1) {
    const code = sessionId.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character !== '~' && /^[A-Za-z0-9._-]$/u.test(character)) out += character
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** The physical directory one stored Session owns, validated to stay under `root`. */
export const roomSessionDirectory = (root: string, directory: string, sessionId: string): string => {
  const rootPath = resolve(root)
  const target = resolve(join(rootPath, roomProjectKey(directory), sessionIdSegment(sessionId)))
  if (target === rootPath || !target.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`session directory escapes the configured root: ${sessionId}`)
  }
  return target
}

/**
 * Find and, when asked, archive or delete a room's throwaway Sessions.
 *
 * `dryRun` defaults to true and `purge` to false, so the safe call reports before it
 * changes anything. An archive run writes DSH's official archive marker, which removes
 * the Sessions from grouping surfaces without touching their files; a purge run removes
 * the physical directories and leaves the canonical room Session alone.
 */
export const cleanupRoomSessions = async (
  input: RoomSessionCleanupInput,
): Promise<RoomSessionCleanupResult> => {
  const dryRun = input.dryRun !== false
  const purge = !dryRun && input.purge === true
  const mode: RoomSessionCleanupResult['mode'] = dryRun ? 'report' : purge ? 'purge' : 'archive'
  if (purge && (input.persistence.root === undefined || input.persistence.root.length === 0)) {
    throw new Error('the session backend exposes no physical root; purge is unavailable')
  }
  const protectedIds = new Set(input.protectedSessionIds ?? [])
  const records = await input.persistence.list()
  const candidates = records
    .filter((record) => isRoomSubSession(record, input.directory, input.primarySessionId, protectedIds))
    .map((record) => record.header.id)

  if (mode === 'archive' && input.archive === undefined) {
    throw new Error('the workspace registry exposes no archive marker; archive is unavailable')
  }

  const archived: string[] = []
  const removed: string[] = []
  const errors: { sessionId: string; message: string }[] = []

  if (mode !== 'report') {
    for (const sessionId of candidates) {
      try {
        if (mode === 'archive') {
          await input.archive?.archiveSession(sessionId, { stopActivity: true })
          archived.push(sessionId)
          continue
        }
        const target = roomSessionDirectory(input.persistence.root as string, input.directory, sessionId)
        await rm(target, { recursive: true, force: true })
        removed.push(sessionId)
      } catch (error) {
        errors.push({ sessionId, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  return {
    roomId: input.roomId,
    directory: input.directory,
    primarySessionId: input.primarySessionId,
    mode,
    scanned: records.length,
    candidates,
    archived,
    removed,
    errors,
  }
}
