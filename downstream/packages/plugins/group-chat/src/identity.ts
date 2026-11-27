/** @module @sparkelf/dsh-group-chat/identity */
import { join } from 'node:path'

/**
 * How this plugin learns where its server is and who it is.
 *
 * The **protocol**, not DataOps, is the contract: any server implementing the
 * documented room endpoints works, so nothing here is specific to DataOps. A
 * deployment supplies values through the plugin's own settings, and DataOps
 * additionally injects environment defaults into its workspace containers so the
 * first-run experience needs no typing.
 *
 * Resolution order is settings first, environment second:
 *
 * 1. An explicit setting always wins — that is what an operator edits, and it is
 *    how a workspace points at any conforming server.
 * 2. The DataOps environment variables fill whatever the settings leave blank.
 */

/** Environment variables DataOps injects into a managed workspace container. */
export const MANAGED_ENV = {
  /** Base URL of the server, e.g. `http://host.docker.internal:3101`. */
  baseUrl: 'DATAOPS_AI_WORKSPACE_BACKEND_BASE_URL',
  /** Workspace root, used as a room session's `cwd`. */
  mountPath: 'DATAOPS_AI_WORKSPACE_MOUNT_PATH',
  /** DSH's own home, where per-room directories live when nobody chose one. */
  home: 'DATAOPS_DSH_HOME',
  /**
   * Root of the shared tree a DataOps deployment bind-mounts into the container.
   *
   * Set by the deployment, not by a user: it names the mount point that outlives every
   * container, so a room's files survive a rebuild and two containers see the same tree.
   * Unset on an installation that does not provide one, where the per-room directory under
   * DSH's own home is still the fallback.
   */
  sharedRoot: 'DATAOPS_AI_WORKSPACE_GROUP_CHAT_PATH',
} as const

/** Directory under DSH's home that holds one directory per room. */
export const ROOMS_DIRECTORY = 'group-chat/rooms'

/**
 * Where a member's workspace exposes the room's shared tree.
 *
 * Lives at the workspace root so a relative path reaches it from where the session is: a
 * member types `group-shared/report.md` from their own workspace and lands in the shared
 * tree. The container creates this symlink on start because it must be re-created with the
 * volume, not stored in the image.
 */
export const ROOM_SHARED_LINK = 'group-shared'

/** Where this workspace keeps its group-chat UI preferences. */
export const PREFERENCES_FILE = 'group-chat/preferences.json'

/**
 * The file backing a user's group-chat UI preferences, under the workspace's own DSH home.
 *
 * A file in the workspace volume rather than a database column: the volume is already
 * per-user and already survives re-login, so "the same person sees the same layout" comes for
 * free, and the backend does not need a migration for a number that describes one panel's
 * height. It sits beside `schedule.json` and `workspace.json`, which are the same kind of
 * state.
 */
export const resolvePreferencesPath = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => join(homeDirectory(env), PREFERENCES_FILE)

/**
 * The workspace's DSH home, from the environment the managed launcher sets.
 * @param env - environment bag; defaults to `process.env`.
 * @returns an absolute directory path, which the caller must create before use.
 */
export const homeDirectory = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => nonEmpty(env[MANAGED_ENV.home]) ?? '/workspace/.dataops/dsh'

/**
 * How this plugin authenticates.
 *
 * A DataOps JWT, sent as `Authorization: Bearer`, resolved from the DSH credential
 * store on every request. This is the deployment's single identity and authorization
 * credential — the same one `dataops-managed` and `knowledge-base` use — so this
 * plugin mints no credential of its own and replicates no DataOps policy.
 *
 * The companion container that runs this DSH has no credential in its environment
 * by design, which is why reading the store is the only correct source: the JWT is
 * provisioned there for the workspace.
 */
export const AUTHORIZATION_HEADER = 'authorization'

/**
 * The default credential reference.
 *
 * It names the DataOps access token the workspace already holds in the DSH
 * credential store — the same reference `dataops-managed` and `knowledge-base`
 * use. That is what makes this work in a managed workspace: the companion
 * container has no credential in its environment by design, but the credential
 * store does carry this entry, and a deployment can point the setting at any other
 * reference for a different server.
 */
export const DEFAULT_CREDENTIAL_REF = 'DATAOPS_ACCESS_TOKEN'

/** What the plugin needs in hand before it can talk to a server. */
export interface ServerTarget {
  /** Origin with any trailing slash removed. */
  readonly baseUrl: string
  /** Credential reference to resolve per request. */
  readonly credentialRef: string
}

export interface ResolveTargetInput {
  /** Value from the settings panel, if the operator set one. */
  readonly baseUrl?: string
  readonly credentialRef?: string
  /** Environment bag; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/**
 * Resolves the server target, or `undefined` when this workspace is not configured.
 *
 * `undefined` means "do not activate": no route, no listener, no timer. A
 * half-configured workspace is treated as unconfigured rather than failing loudly,
 * because a plugin that cannot reach a server has nothing useful to do at startup
 * and must not disturb ordinary sessions.
 *
 * The actor is deliberately absent: a bearer credential identifies the account
 * server-side, so the plugin never states who it is and cannot disagree with the
 * server about it.
 */
export const resolveServerTarget = (input: ResolveTargetInput = {}): ServerTarget | undefined => {
  const env = input.env ?? process.env
  const rawBaseUrl = nonEmpty(input.baseUrl) ?? nonEmpty(env[MANAGED_ENV.baseUrl])
  if (rawBaseUrl === undefined) return undefined

  let parsed: URL
  try {
    parsed = new URL(rawBaseUrl)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined

  return {
    baseUrl: rawBaseUrl.replace(/\/+$/u, ''),
    credentialRef: nonEmpty(input.credentialRef) ?? DEFAULT_CREDENTIAL_REF,
  }
}

/** The workspace root a room session uses as its `cwd`. */
export const resolveWorkspaceRoot = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => nonEmpty(env[MANAGED_ENV.mountPath]) ?? process.cwd()

/**
 * The directory one room's session runs in.
 *
 * The room's session works **in the member's own workspace**, not in the shared tree. That
 * is what keeps every path a member already knows working: the knowledge base (`/nas/kb`),
 * the workspace files, and any relative path they type all resolve exactly as they do in an
 * ordinary session. Pointing the cwd at the shared tree instead made `kb/x.md` resolve under
 * it and fail with ENOENT — a shared folder must add a place to look, not move the place
 * every other path is measured from.
 *
 * The shared tree is reached through {@link ROOM_SHARED_LINK}, a symlink the container keeps
 * at the workspace root. A symlink rather than a hardlink is the only option that works
 * across the two mounts: a directory cannot be hardlinked at all, and a file hardlink across
 * mount points fails with EXDEV. It also keeps the two views independent, which is what a
 * shared folder needs — adding or removing a file must not touch the other name.
 *
 * `room.cwd` still wins: a creator who named a directory meant it, and a room whose members
 * deliberately share one scope is a supported configuration.
 *
 * @param roomId - the room the directory belongs to.
 * @param configured - the room's own `cwd`, when its creator set one.
 * @param env - environment bag; defaults to `process.env`.
 * @returns an absolute directory path, which the caller must create before use.
 */
export const resolveRoomDirectory = (
  roomId: string,
  configured?: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const chosen = nonEmpty(configured ?? undefined)
  if (chosen !== undefined) return chosen
  // A directory per room, under this workspace's own DSH home.
  //
  // Not the workspace root itself: several rooms would then share one cwd, and the sessions
  // collide — the room opens, the message is written to its journal, and the agent never
  // runs a turn. A room whose cwd equals another live session's cwd is not a room any more,
  // it is a second name for the same place.
  //
  // Not a directory inside the shared tree either: the room's own files and the shared ones
  // would interleave, and pointing the cwd there made a relative path like `kb/x.md` resolve
  // against the shared tree instead of the member's workspace. The shared tree is reached
  // through the `group-shared` symlink instead, so a room adds a place to look without
  // moving the place every other path is measured from.
  // `join` rather than a hardcoded separator so the derivation stays correct wherever this
  // runs; the home falls back to the conventional location the managed launcher sets, so an
  // unmanaged run still has a stable place to put the directories.
  return join(homeDirectory(env), ROOMS_DIRECTORY, roomId)
}
