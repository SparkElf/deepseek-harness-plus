/**
 * The workspace a room's Session belongs to.
 *
 * A room's Session is created with a `cwd` and no workspace id, and the shell's `openSession`
 * only selects a Session that a Workspace owns -- so clicking a room moved the sidebar highlight
 * and the main column kept the previous conversation. Attaching alone is not enough either:
 * `attachSession` requires the Session's cwd to be exactly the workspace path, which is why the
 * workspace has to be created *at the room's own directory* rather than at some shared root.
 *
 * Creation is lazy. Discovery opens every joined room's Session, but a Workspace is only created
 * when someone actually opens the room: the sidebar must not fill with folders for rooms nobody
 * reads.
 *
 * @module @sparkelf/dsh-group-chat/room-workspace
 */

/** The registry surface this module needs; structural so tests need no DSH runtime. */
export interface RoomWorkspaceRegistry {
  resolveByPath(path: string): Promise<RoomWorkspaceView | undefined>
  create(path: string, title?: string): Promise<RoomWorkspaceView>
}

/** One workspace, reduced to what attaching a Session needs. */
export interface RoomWorkspaceView {
  readonly id?: string
  attachSession(sessionId: string): Promise<void>
}

/** What one call did, so the caller can report which workspace the room now belongs to. */
export interface RoomWorkspaceOutcome {
  readonly workspaceId: string | undefined
  readonly created: boolean
}

/**
 * Give a room's Session the workspace that makes it selectable.
 *
 * The path is the Session's own `cwd`: that is the one path `attachSession` will accept, and it
 * is stable for the life of the Session (a room's directory is fixed when the Session is
 * created). Reuse is by exact path, so opening the same room twice never creates a second
 * workspace.
 *
 * @param registry - the workspace registry, absent on a minimal host.
 * @param path - the room Session's directory.
 * @param title - display title for a newly created workspace.
 * @param sessionId - the room's canonical Session.
 * @returns which workspace the room belongs to, and whether this call created it.
 * @throws when the registry refuses the create or the attach; the caller decides how to report.
 */
export const ensureRoomWorkspace = async (
  registry: RoomWorkspaceRegistry | undefined,
  path: string,
  title: string,
  sessionId: string,
): Promise<RoomWorkspaceOutcome> => {
  if (registry === undefined) return { workspaceId: undefined, created: false }
  const existing = await registry.resolveByPath(path)
  const workspace = existing ?? await registry.create(path, title)
  await workspace.attachSession(sessionId)
  return { workspaceId: workspace.id, created: existing === undefined }
}