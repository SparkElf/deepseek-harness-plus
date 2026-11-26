/**
 * The same-origin API surface shared by this package's two halves.
 *
 * The Host registers one prefix and dispatches on the trailing method name; the
 * browser calls the same strings. Keeping them in one module is what stops the
 * two halves drifting apart, which is exactly the failure this file was written
 * to fix: the panel once called `/knowledge-base/config` while the Host served
 * `/knowledge-base/api/config`.
 *
 * This module must stay dependency-free so both bundles can import it: the
 * Client bundle rejects Node builtins and non-platform packages.
 *
 * @module @sparkelf/dsh-knowledge-base/api
 */

import type { VectorRetrievalConfig } from './embeddings.ts'

/** Prefix the Host registers and the browser calls. */
export const KB_API_PREFIX = '/knowledge-base/api'

/** Method names the Host dispatches on. */
export const KB_API = {
  /** Resolved layout plus whether the DataOps backend is wired. */
  config: 'config',
  /**
   * Persist the operator's storage choices.
   *
   * Separate from {@link KB_API.config} because it is the only route here that writes
   * deployment configuration: a read must never be able to change what a write controls.
   */
  configSet: 'config.set',
  /** Aggregated view and index status. */
  status: 'status',
  /** Authorized paths for the calling user. */
  grants: 'grants',
  /** Grant one principal access to one path. */
  grant: 'grant',
  /** Revoke one previously granted path. */
  revoke: 'revoke',
  /** List the principals that can be granted, so the surface can offer a picker. */
  principals: 'principals',
  roles: 'roles',
  trash: 'trash',
  trashRemove: 'trash.remove',
  trashRestore: 'trash.restore',
  /** Search the mounted tree by file name and text. */
  search: 'search',
  /**
   * Read the permission-filtered knowledge-graph tree.
   *
   * The graph tab's only data route and strictly read-only: it scans
   * `知识图谱/*` under the caller's scopes, asks `canReadPath` once per graph, and
   * returns the domain tree. No graph, topic or relation is created here.
   */
  graph: 'graph',
  /**
   * The canvas-only page the graph tab embeds.
   *
   * A page rather than a JSON route: the first version reuses the prototype's
   * mind-map canvas as-is, and the panel feeds it through `postMessage`.
   */
  graphCanvas: 'graph.canvas',
  /** List one directory level, with each entry's modification time. */
  list: 'list',
  /** Read one file for the preview, without needing a conversation session. */
  read: 'read',
  /** Resolve a kb://doc/<docId>/chunk/<chunkId> token to all page boxes. */
  chunk: 'chunk',
  /** Rebuild the caller's visible tree from what DataOps resolves for them. */
  viewsSync: 'views.sync',
  /** Rescan the mounted tree and report its shape. */
  index: 'index',
  /** Explicitly rebuild the whole optional vector index (requires confirmation). */
  vectorRebuild: 'vector.rebuild',
  /**
   * Report the mounted tree's per-directory shape.
   *
   * Separate from {@link KB_API.index}, which recounts and answers with a single
   * total: this one answers with the rows the indexing table renders, so opening
   * the page does not have to trigger a scan to have something to show.
   */
  indexDirs: 'index.dirs',
  /**
   * Start a document or folder in the authoritative tree.
   *
   * Not a per-user private space: the destination has no caller component, so a
   * document created here is shared with everyone DataOps resolves as a reader of
   * that path. That is the knowledge base's own semantic, and it is why the write
   * needs write access rather than merely read.
   */
  create: 'create',
  /**
   * Replace one existing document's bytes.
   *
   * Kept separate from `create` because the two differ in what they must not do:
   * a create refuses to overwrite, while an edit must write IN PLACE. Writing in
   * place is the requirement, not an implementation detail -- the caller's view
   * links this document to the authoritative copy by hardlink, and a
   * write-temp-then-rename save (which is how the host's own editor saves) replaces
   * the inode and silently leaves the view showing the old bytes.
   */
  edit: 'edit',
  /**
   * Record an edit that happened outside this plugin's write path.
   *
   * The host's file editor saves through its own route, so the knowledge base
   * cannot intercept it without owning that editor. This route is the side channel:
   * the page reports the save it observed, and the audit trail stays complete
   * without the host's write path knowing the knowledge base exists.
   */
  auditAppend: 'audit.append',
  /** Put one file's bytes into the authoritative tree under the same rules. */
  upload: 'upload',
  /**
   * List the templates a reader can start from.
   *
   * A template is a DataOps wiki page whose category is `report_template`, so the
   * Host relays `GET /api/resources/wiki/pages/templates` rather than keeping a
   * second copy to keep in step.
   */
  templates: 'templates',
  /**
   * Add or replace one template: a document file plus its metadata.
   *
   * A template is exactly a document plus a small record describing it, so this
   * route takes the file's text and the metadata in one body rather than modelling
   * a second kind of object. The document is written through the same create/upload
   * path a reader's own file uses, under a template directory the knowledge base
   * owns, and the metadata goes beside it.
   */
  templateSave: 'template.save',
  /** Remove one template: its document and its metadata record. */
  templateRemove: 'template.remove',
  /**
   * Read what this process knows about extraction.
   *
   * The queue lives in memory, so this reports the tasks of the running process only;
   * a file that is neither queued nor beside a `.md` sibling reads as never attempted,
   * which is a fact about this process rather than a claim about the document.
   */
  extractStatus: 'extract.status',
  /** Re-run extraction for one document that could not finish. */
  extractRetry: 'extract.retry',
  indexStatus: 'index.status',
  /** Read the caller's pinned paths. */
  favoritesGet: 'favorites.get',
  favoritesSet: 'favorites.set',
  pinsGet: 'pins.get',
  /** Replace the caller's pinned paths. */
  pinsSet: 'pins.set',
  /**
   * Read this knowledge base's review settings.
   *
   * Stored beside the pins and the view mode, in the caller's view directory. The answer
   * defaults to review OFF, which is what a deployment that never opened the settings
   * page must do.
   */
  settingsGet: 'settings.get',
  /**
   * Replace this knowledge base's review settings.
   *
   * Gated on write access rather than mere read: turning review on or off decides whether
   * other people's contributions take effect immediately, which is an operator decision.
   */
  settingsSet: 'settings.set',
  /**
   * Read the audit trail for this knowledge base, newest first.
   *
   * Append-only on the Host side; this route only reads.
   */
  auditList: 'audit.list',
  /**
   * Rename one entry in place, keeping it in its own directory.
   *
   * Separate from `move` on purpose: that route deliberately concatenates the entry's
   * CURRENT name onto the destination, so it cannot rename. Renaming is its own decision
   * and gets its own check at the resulting path.
   */
  rename: 'rename',
  /**
   * Read one file as bytes for a save-to-disk, as opposed to `read` for on-screen text.
   *
   * Answers base64 so a binary file survives the JSON round trip; a markdown file uses
   * the same route, because one download path is simpler than two.
   */
  download: 'download',
  /**
   * List the submissions waiting for review.
   *
   * Only meaningful when review is on, but it always answers: an empty queue is a
   * valid state and the page shows it rather than hiding the section.
   */
  pendingList: 'pending.list',
  /**
   * Accept one submission, writing its bytes into the authoritative tree.
   *
   * Requires write access, like every other operation that changes shared content.
   */
  pendingApprove: 'pending.approve',
  /**
   * Refuse one submission and discard its bytes.
   *
   * Requires write access for the same reason: refusing someone else's contribution
   * is a decision about shared content.
   */
  pendingReject: 'pending.reject',
  /**
   * Move or rename one entry inside the caller's tree.
   *
   * A rename rather than a copy, so the inode survives and every view's hardlink
   * to it stays meaningful; the Host resynchronizes the caller's view afterwards,
   * because a moved file's old path is a dead link until it does.
   */
  copy: 'copy',
  move: 'move',
  /** Read the caller's list/grid preference. */
  viewModeGet: 'viewMode.get',
  /** Replace the caller's list/grid preference. */
  viewModeSet: 'viewMode.set',
  /**
   * Read which folders the caller had open in the explorer.
   *
   * Beside the layout preference for the same reason: it describes how this reader
   * looks at the tree rather than what is in it, so it belongs to the caller's view
   * instead of one browser's storage.
   */
  treeStateGet: 'treeState.get',
  /** Replace the set of expanded folders. */
  treeStateSet: 'treeState.set',
  /** The ordered deployment steps and their recent runs. */
  deploySteps: 'deploy.steps',
  /** SSH hosts available as deployment targets. */
  deployHosts: 'deploy.hosts',
  /** Run one deployment step against one host. */
  deployRun: 'deploy.run',
} as const

/** One method name. */
export type KbApiMethod = (typeof KB_API)[keyof typeof KB_API]

/** Absolute URL for one API method. */
export function kbApiPath(method: KbApiMethod): string {
  return `${KB_API_PREFIX}/${method}`
}

/**
 * Read a knowledge-base response as JSON without trusting it to BE JSON.
 *
 * Every route in this plugin answers JSON, but a response is not always this plugin's:
 * a gateway, a proxy, an auth redirect, or a stopped DSH can all return HTML or plain
 * text with a 2xx status. Calling `response.json()` on that throws a parser message like
 * `Unexpected token 'D', "DataOps au"... is not valid JSON`, which then reached the page
 * verbatim -- an internal parser complaint shown to a reader as if it were the document.
 *
 * This reads the body once as text and decides from the CONTENT whether it parsed, so a
 * non-JSON answer becomes a sentence naming the status instead of a parser exception. The
 * status is still surfaced, because "the server said no" and "the body was not JSON" are
 * different problems an operator needs to tell apart.
 * @param response - the fetch response.
 * @returns The parsed body, or an object carrying a readable `error`.
 */
export async function readKnowledgeJson<T extends Record<string, unknown>>(
  response: Response,
): Promise<T & { error?: string }> {
  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  if (text.trim() === '') {
    // An empty 2xx is normal for a route that only reports success; an empty failure is
    // not, and it says so rather than parsing nothing.
    if (response.ok) return {} as T
    return { error: 'HTTP ' + String(response.status) } as T & { error?: string }
  }
  try {
    return JSON.parse(text) as T
  } catch {
    // Quote a short slice so the reader can recognise what came back (an HTML error page
    // and a bare proxy line look different), but keep it short enough for a caption.
    const preview = text.replace(/\s+/gu, ' ').trim().slice(0, 120)
    const status = 'HTTP ' + String(response.status)
    return { error: status + ': ' + preview } as T & { error?: string }
  }
}

/** Resolved layout as the panel renders it. */
export interface KnowledgeConfigView {
  /** Human-facing identifier of the storage host, empty when unconfigured. */
  host: string
  /** Absolute path of the authoritative tree on the storage host. */
  actualRoot: string
  /** Local deployments: configured storage path (default `~/kb`). */
  storageRoot?: string
  /** Absolute path of the caller's view tree on the storage host. */
  viewRoot: string
  /** Path where the view tree is mounted inside the container. */
  mountPoint: string
  /** NFS export host, when the deployment uses the NFS transport. */
  nfsServer?: string
  /** Whether a DataOps knowledge API base URL is configured. */
  backendConfigured: boolean
  /** Why the backend probe failed, when it did. */
  backendError?: { message: string; code?: string }
  /** How a remote deployment reaches its share; absent means `nfs`. */
  storageProtocol?: 'nfs' | 'sshfs'
  /** SSHFS transport, present so the panel can show and edit what it will mount. */
  ssh?: KnowledgeSshView
  /** Optional hybrid retrieval configuration, safe to render (credential reference only). */
  retrieval?: { vector: VectorRetrievalConfig }
}

/** One transport field the panel may persist. */
export interface KnowledgeConfigWrite {
  /** Storage shape to store. */
  storageMode?: 'local' | 'remote'
  /** Transport for a remote deployment. */
  storageProtocol?: 'nfs' | 'sshfs'
  /** NFS export host. */
  nfsServer?: string
  /** SSHFS transport fields; the key is named by reference only. */
  sshHost?: string
  sshUser?: string
  sshPort?: number
  sshRemotePath?: string
  sshMountOptions?: string
  sshKeyRef?: string
}

/** What a config write actually stored, and what it could not. */
export interface KnowledgeConfigWriteResult {
  /** Fields written to the settings file. */
  saved: string[]
  /**
   * True when the running deployment differs from what was just saved, so a restart is
   * required before the change takes effect. The file is the record; the process read its
   * configuration at startup.
   */
  restartRequired: boolean
  /** The config as it will read back after a restart. */
  config: KnowledgeConfigView
  /** Fields refused, with the reason. */
  refused?: { field: string; reason: string }[]
}

/**
 * The SSHFS transport as the panel may see it.
 *
 * Every field here is safe to render: a host, a user, a port, a path, mount options, and
 * a credential REFERENCE. The private key itself is never part of this shape -- there is
 * no field it could travel in. `keyConfigured` is the resolved answer to "will the mount
 * step find a key", which is the only thing the panel needs to know about it.
 */
export interface KnowledgeSshView {
  /** Remote host, address or hostname. */
  host: string
  /** Login user on that host. */
  user: string
  /** TCP port the SSH daemon listens on. */
  port: number
  /** Absolute path of the shared directory on the remote host. */
  remotePath: string
  /** Extra `-o` options, as the operator typed them. */
  mountOptions: string
  /** Name of the credential holding the private key. A reference, never the key. */
  keyRef: string
  /** Whether that credential currently resolves to a usable key. */
  keyConfigured: boolean
}

/** Aggregated view and index status as the panel renders it. */
export interface KnowledgeStatusView {
  /**
   * Which storage shape this deployment runs.
   *
   * `local` stores documents in the workspace itself; `remote` keeps the synchronized
   * NFS shape. The settings page keys its whole storage section off this, so a reader
   * never sees mount controls for a workspace that has no mount.
   */
  storageMode?: 'local' | 'remote'
  /**
   * How a remote deployment reaches its share.
   *
   * Reported for both modes so the panel can show the configured transport even while the
   * deployment runs locally: a reader switching to remote needs to see what it will use
   * before they commit to it.
   */
  storageProtocol?: 'nfs' | 'sshfs'

  /**
   * Who this page is acting as, as DataOps resolved them.
   *
   * Absent when the backend is unconfigured or did not answer. The page uses it to
   * name the actor on editor saves, so the audit trail records a person rather than
   * an anonymous edit.
   *
   * The organization path is optional because the backend may not report it: an older
   * DataOps answers only `code`/`name`, and the tree then labels the department bucket
   * with that single name exactly as it did before hierarchy existed. Code that
   * assumed the path was present would break against such a backend.
   */
  /** Backend DSH permission keys for this caller; used only to hide dead-end menus. */
  permissions?: readonly string[]
  /** Optional vector index coverage/progress. */
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
  caller?: {
    userId: string
    label: string
    departmentCode?: string
    departmentName?: string
    departmentPathCodes?: string[]
    departmentPathNames?: string[]
  }
  /** Visible file count, or null when the backend is not configured. */
  visibleFiles: number | null
  /** ISO-8601 time of the last successful synchronization. */
  lastSyncAt: string | null
  /** In-flight index state. */
  indexing: { running: boolean; jobId?: string; progress?: number }
  /**
   * Which of the two empty states applies when there is no file count.
   *
   * `null` for a count is compatible with a mount that is absent and with a pointer
   * this plugin has not built yet, and those need different sentences: the first
   * sends the reader to the deployment, the second resolves itself. The Host
   * reports which one it is.
   *
   * Optional because a response from an older Host does not carry it; a reader that
   * finds it absent falls back to the mount-not-present wording, which is the
   * message that was correct before the two were told apart.
   */
  mountState?: 'mounted' | 'pointer-missing' | 'absent'
  /**
   * Whether the Host verified that this caller may manage grants.
   *
   * Decided on the Host by asking DataOps, and deliberately not derived here: a
   * client-side decision would duplicate the policy in a process the user controls,
   * where it governs rendering rather than access. Absent or false both mean "do not
   * offer the surface", so a response from an older Host hides it rather than
   * showing a menu whose writes the backend would reject.
   */
  canManageGrants?: boolean
}

/** The principal kinds the DataOps backend accepts on a grant. */
export type KnowledgeGrantSubjectType = 'user' | 'role' | 'department' | 'group'

/**
 * One grant as the permissions surface renders it.
 *
 * The shape mirrors what the backend stores, so the page can echo a row back when
 * revoking it without keeping a second copy of the fields.
 */
export interface GrantView {
  /** Stable row identifier. */
  id: string
  /** Path the grant covers, relative to the knowledge mount point. */
  relPath: string
  /** Whether the path is a file or a directory. */
  kind: 'file' | 'directory'
  /** Principal kind the grant names. */
  principalType: KnowledgeGrantSubjectType
  /** Principal id within its kind. */
  principalId: string
  /** Permission the grant confers. */
  action: string
  /** Who created the grant. */
  grantedBy: string
  /** ISO-8601 creation time. */
  grantedAt: string
}

/** One deployment step as the browser receives it. */
export interface DeployStepView {
  id: string
  label: string
  timeoutMs: number
  commands: string[]
}

/** One recorded deployment run. */
export interface DeployRunView {
  stepId: string
  hostId: string
  state: 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt: string | null
  log: string[]
}

/** One SSH host offered as a deployment target. */
export interface DeployHostView {
  id: string
  name: string
  hostname: string
  username: string
  port: number
  credentialConfigured: boolean
}

/**
 * The caller's pinned paths, as the browser renders them.
 *
 * Pins are a document-level preference rather than a per-device one, so they live
 * in the caller's own view directory on the share rather than in browser storage:
 * a reader who pins a folder on one machine expects it pinned on the next. The
 * list is addressed by `relPath` only, because every path it may name has already
 * been resolved as readable for this caller.
 */
export interface PinnedView {
  /** Paths the caller pinned, relative to the mount point. */
  relPaths: string[]
  /**
   * Paths that were dropped because the caller may no longer read them.
   *
   * Reported rather than silently discarded: a pin that disappears without a word
   * reads as a bug, while a count explains a revoke.
   */
  dropped: string[]
}

/**
 * The caller's favourited paths, as the browser renders them.
 *
 * A star marks a row the reader wanted to find again, so the list is addressed by
 * `relPath` only: every entry has already been resolved as readable for this caller.
 * Kept apart from {@link PinnedView} deliberately -- see `favoritesPathFor`.
 */
export interface FavoritesView {
  /** Paths the caller starred, relative to the mount point. */
  relPaths: string[]
  /**
   * Paths dropped because the caller may no longer read them.
   *
   * Reported rather than silently discarded, so a star that disappears after a
   * revoke can be explained instead of looking like a bug.
   */
  dropped: string[]
}

/**
 * One entry the caller may move, as the move route reports it.
 *
 * Returned instead of a bare boolean so the caller can tell a refusal apart from a
 * move that did nothing: the route answers 403 for the first and 200 with both
 * paths for the second.
 */
export interface MoveResultView {
  /** The path the entry held before the move. */
  from: string
  /** The path it holds now. */
  to: string
  /**
   * What the caller's view sync changed, so the surface can report a relink.
   *
   * A move changes two paths in the view -- the new one is linked and the old one
   * is dropped -- and the reader is looking at the old one, so the count is the
   * evidence that the tree they are about to re-read is current.
   */
  delta: { linked: number; unlinked: number; unchanged: number }
}

/**
 * The caller's list/grid preference.
 *
 * A document-level preference rather than a per-device one, stored beside the pins
 * for the same reason: a reader who switches to the grid on one machine expects it
 * on the next.
 */
export interface ViewModeView {
  /** The stored layout. */
  mode: 'list' | 'grid' | 'explorer'
}

/**
 * The folders the caller had open in the explorer, as absolute paths.
 *
 * Absolute rather than tree-relative because that is the vocabulary the explorer
 * speaks: it reports `onToggle` with the absolute path of the row and takes
 * `expanded` the same way. Storing them in that form means neither side has to
 * re-derive the root, and a folder that a grant revoke removed simply never
 * matches a row again rather than pointing at some other directory's new occupant.
 *
 * An empty list is the correct answer both for "the reader has collapsed
 * everything" and for "nothing was ever stored", which is why the two share one
 * representation: the tree's default state IS all-collapsed.
 */
export interface TreeStateView {
  /** Absolute paths of the folders the reader had expanded. */
  expanded: string[]
}

/**
 * One template: a document plus the metadata that describes it.
 *
 * Deliberately a flat record rather than a model with its own identity rules: the
 * `id` is derived from the file name inside the template directory, so a template
 * cannot exist without its document and deleting one cannot leave the other behind.
 */
export interface KnowledgeTemplateView {
  /** Stable id, derived from the stored file's name. */
  id: string
  /** Display name. */
  title: string
  /** One-line description shown on the card. */
  description: string
  /** Grouping label, e.g. `report` or `meeting`. */
  category: string
  /** Free-form tags, already split. */
  tags: string[]
  /** The document's file name including its extension. */
  fileName: string
  /** Extension without the dot, lower-cased; drives the card's file badge. */
  extension: string
  /** Document size in bytes. */
  bytes: number
  /** Last-modified instant, ISO-8601. */
  updatedAt: string
  /** Where the document lives, relative to the knowledge root. */
  relPath: string
}

/** The template library as the Host answers it. */
export interface KnowledgeTemplatesView {
  /** Every stored template, newest first. */
  templates: KnowledgeTemplateView[]
  /** Set when the list was read but the store could not be (never both). */
  error?: string
}

/** The body of one template save. */
export interface KnowledgeTemplateSaveInput {
  /** Display name; also used to derive the file name when the document is new. */
  title: string
  /** One-line description. */
  description: string
  /** Grouping label. */
  category: string
  /** Free-form tags. */
  tags: string[]
  /** The document's text. Required when creating, omitted when only metadata changes. */
  content?: string
  /** The file name to store, including its extension. */
  fileName: string
  /** Set when editing an existing template, so its document is replaced in place. */
  id?: string
}

/** Where one extraction task is in its lifecycle, as the Host reports it. */
export type ExtractionStateView = 'pending' | 'running' | 'succeeded' | 'failed' | 'unsupported' | 'already-markdown'

/**
 * One extraction task.
 *
 * Mirrors the Host's own record: the source path, the state, and whatever it managed to
 * learn about the outcome. `reason` is the extractor's verbatim text, which is the only
 * thing that tells a reader whether to retry or give up.
 */
export interface ExtractionTaskView {
  /** Knowledge-relative path of the source document. */
  relPath: string
  /** Where the task is in its lifecycle. */
  state: ExtractionStateView
  /** Current Agentic RAG stage (parse/chunk/index/done), when running. */
  step?: 'parse' | 'chunk' | 'index' | 'done'
  /** When the task was accepted, ISO-8601. */
  queuedAt: string
  /** When the run started, ISO-8601. */
  startedAt?: string
  /** When the run reached a terminal state, ISO-8601. */
  finishedAt?: string
  /** The Markdown sibling that was written, when one was. */
  markdown?: string
  /** Which authority produced the text. */
  via?: string
  /** Why the extraction produced nothing. */
  reason?: string
}

/** The extraction queue's snapshot. */
export interface ExtractionStatusView {
  /** The path of the task running right now, when one is. */
  running?: string
  /** How many tasks are queued or running. */
  size: number
  /** Every task this process knows about. */
  tasks: ExtractionTaskView[]
}
