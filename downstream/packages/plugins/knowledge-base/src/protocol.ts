/**
 * The knowledge-base protocol contract.
 *
 * This module is the Client's authoritative declaration of what the
 * knowledge-base capability needs from its backend. A DataOps deployment
 * implements these endpoints; this package never talks to the NAS directly and
 * never decides authorization itself.
 *
 * Design boundary (see the design textbook, chapter 9):
 * - Transport is HTTPS with the DataOps session credential.
 * - Retrieval is NOT part of this protocol. Content search runs over the
 *   mounted copy with the official `grep` and `read` tools, because the mount
 *   makes the remote tree a local path. Only configuration, authorization
 *   changes, and index generation cross this boundary.
 * - File transfer is NOT part of this protocol. Files are read and written
 *   through the mount point.
 *
 * @module @sparkelf/dsh-knowledge-base/protocol
 */

/** How this capability identifies its remote backend to the user. */
export interface KnowledgeBackend {
  /** Base URL of the DataOps knowledge API, without a trailing slash. */
  baseUrl: string
  /** Credential reference holding the DataOps session token. */
  credentialRef: string
}

/**
 * Resolved mount layout, as reported by the backend.
 *
 * The backend owns these values because it also owns the authorization model:
 * the view root a user sees is derived from their grants, not from client
 * configuration.
 */
export interface KnowledgeConfig {
  /** Human-facing identifier of the storage host, for display only. */
  host: string
  /**
   * Absolute path of the authoritative file tree on the storage host.
   * Never mounted into a container.
   */
  actualRoot: string
  /**
   * Absolute path of the calling user's view tree on the storage host.
   * This is the directory a container mounts.
   */
  viewRoot: string
  /** Local deployments: configured storage base (default `~/kb`). */
  storageRoot?: string
  /** Absolute path where the view tree is mounted inside the container. */
  mountPoint: string
  /** NFS export host, when the deployment uses the NFS transport. */
  nfsServer?: string
  /** Read-only summaries the deployment wants shown beside the connection. */
  notes?: string[]
}

/**
 * One access grant.
 *
 * The fields mirror the DataOps permission store, whose resource type and id are
 * free-form strings, so a knowledge path needs no schema change: the file is
 * addressed as the resource id under the knowledge resource type.
 */
export interface KnowledgeGrant {
  /** Stable identifier of this grant. */
  id: string
  /** Path relative to {@link KnowledgeConfig.actualRoot}. */
  relPath: string
  /** Whether this entry authorizes a file or a whole directory. */
  kind: 'file' | 'directory'
  /** Principal kind the grant names. */
  principalType: KnowledgeGrantPrincipalType
  /** Principal id within its kind: a user id, role code, department code, or group id. */
  principalId: string
  /** Permission the grant confers. */
  action: string
  /** Display name of whoever granted it. */
  grantedBy: string
  /** ISO-8601 timestamp of the grant. */
  grantedAt: string
}

/** Principal kinds the DataOps permission store accepts. */
export type KnowledgeGrantPrincipalType = 'user' | 'role' | 'department' | 'group'

/** Progress of one index job. */
export interface KnowledgeIndexJob {
  /** Job identifier used for polling. */
  jobId: string
  /** Terminal or in-flight state. */
  state: 'queued' | 'running' | 'succeeded' | 'failed'
  /** Total files selected for this run. */
  total: number
  /** Files processed so far. */
  done: number
  /** Relative paths that failed, with their reasons. */
  failures: Array<{ relPath: string; reason: string }>
}

/**
 * Aggregated view and index state.
 *
 * Both halves are derived from the mounted tree rather than reported by a
 * backend: the count walks the mount, and indexing is the tree itself because
 * retrieval reads it with grep and read. A null count means the mount is absent,
 * which is an expected state before the storage host is attached.
 */
export type { KnowledgeSshView } from './api.ts'

export interface KnowledgeStatus {
  /** Files visible under the mount point, or null when nothing is mounted there. */
  visibleFiles: number | null
  /** ISO-8601 timestamp of the last successful view synchronization. */
  lastSyncAt: string | null
  /** The in-flight index job, when one is running. */
  indexing: { running: boolean; jobId?: string; progress?: number }
  /** Optional vector index coverage; reported only by hosts that have this feature. */
  vector?: {
    enabled: boolean
    provider?: string
    model?: string
    embeddedChunks: number
    totalChunks: number
    embeddedDocs: number
    totalDocs: number
    failed: number
    canManageVector?: boolean
    indexing: { running: boolean; total?: number; done?: number; embedded?: number; failed?: number; error?: string }
  }
}

/**
 * One grant to create.
 *
 * A path is addressed as the resource id under the knowledge resource type, and
 * the principal travels as a (kind, id) pair because the permission store keys
 * grants that way. The plugin therefore never builds a policy of its own: it
 * names the principal and lets DataOps decide whether that principal exists and
 * what the caller may do.
 */
export interface KnowledgeGrantRequest {
  /** Path relative to {@link KnowledgeConfig.actualRoot}. */
  relPath: string
  /** Principal kind the grant names. */
  principalType: KnowledgeGrantPrincipalType
  /** Principal id within its kind. */
  principalId: string
  /** Permission to confer, defaulting to read. */
  action?: string
}

/** One grant to remove. The fields identify the row; the rest is untouched. */
export interface KnowledgeRevokeRequest {
  /** Path relative to {@link KnowledgeConfig.actualRoot}. */
  relPath: string
  /** Principal kind the grant names. */
  principalType: KnowledgeGrantPrincipalType
  /** Principal id within its kind. */
  principalId: string
  /** Permission the grant confers; identifies the row together with the above. */
  action: string
}

/** Request to index one path, or the whole tree when `relPath` is omitted. */
export interface KnowledgeIndexRequest {
  /** Path relative to {@link KnowledgeConfig.actualRoot}. */
  relPath?: string
  /** Rebuild even when the source seems unchanged. */
  force?: boolean
}

/**
 * Endpoint paths this protocol requires a backend to implement.
 *
 * Kept as data rather than free strings so Client and backend can share one
 * list and drift is caught by the type checker and by tests.
 *
 * Every path here was matched against a controller in `dataops/backend` rather
 * than assumed: the global prefix is `api`, and the permission routes belong to
 * `system/resource-permissions`. An earlier revision of this list invented an
 * `/api/kb/*` family that no controller ever served, so every call answered 404
 * while the plugin reported itself merely unconfigured. Config, status, and
 * indexing have no backend counterpart at all and are derived on the Host
 * instead; only the grants routes are remote.
 */
export const ENDPOINTS = {
  /**
   * Knowledge file grants. The permission store keys a grant by resource type
   * and id, and a knowledge path is addressed as the id under
   * {@link KB_RESOURCE_TYPE}; the kind travels in the request body.
   */
  grants: '/api/system/resource-permissions/grants',
  /**
   * Principal directories, so the permission surface can offer the subjects that
   * actually exist instead of asking an operator to transcribe a UUID.
   *
   * The permission store matches a user by primary key and everything else by
   * `code`, so these are the only places a valid identifier can come from. Each
   * one is a controller in `dataops/backend` and answers `{ items: [...] }`
   * except departments, which nests its rows under `departments`.
   */
  users: '/api/system/users',
  roles: '/api/system/roles',
  departments: '/api/system/departments',
  groups: '/api/system/groups',
  /**
   * Resolve one path's permissions for the CALLING user.
   *
   * This controller is `@SelfScoped`, so the answer is always about the caller and
   * no other identity can be asked about. That is what lets a per-user view be
   * built without this plugin evaluating a grant itself: it asks, per path,
   * whether the caller may read it, and links what the answer allows.
   */
  resolve: '/api/system/resource-permissions/resolve',
  /** The authenticated caller, whose id keys their view directory. */
  me: '/api/auth/me',
  /**
   * Templates a reader can start from, which are DataOps wiki pages carrying the
   * `report_template` category (`resource-wiki-core.controller.ts`, `@Get('pages/templates')`).
   *
   * The plugin keeps no template store: the pages a team already wrote ARE the
   * templates, and duplicating them here would create a second copy to keep in
   * step. The endpoint answers an empty list today because no page carries that
   * category yet.
   */
  templates: '/api/resources/wiki/pages/templates',
  /**
   * The MinerU address the 「文档识别」 plugin's administrator shares with the deployment.
   *
   * Read-only here. The knowledge base keeps its own per-caller address field, and when that
   * is empty this shared value is what the parser is called with. It is never written back:
   * a copy in this plugin's settings file would stop following the administrator's later
   * change and become a second source of truth.
   *
   * `AuthGuard`-only on the backend, so any signed-in member may read it: the address is not
   * a secret, and being allowed to USE it is not being allowed to CHANGE it (`canEdit`).
   */
  ocrConfig: '/api/ocr/config',
} as const

/**
 * Resource type the knowledge base records its paths under.
 *
 * The DataOps permission store treats the type as a free-form string, so the
 * knowledge tree needs no schema change to be grantable. The value is the one
 * `dataops/backend/src/system/resource-permissions/resource-permissions.types.ts`
 * exports for this purpose.
 */
export const KB_RESOURCE_TYPE = 'knowledge-base-file'

/**
 * Whether a backend serves remote knowledge state.
 *
 * Config, status, and indexing are derived on the Host from the mounted tree and
 * the local index, so they need no remote counterpart. Only the grant routes
 * reach DataOps, and this constant names the one path they use.
 */
export const REMOTE_GRANTS_PATH = ENDPOINTS.grants

/** Join a base URL and an endpoint path without doubling or dropping the slash. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}/${path.replace(/^\/+/u, '')}`
}
