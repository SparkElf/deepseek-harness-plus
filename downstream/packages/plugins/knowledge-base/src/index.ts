/**
 * Knowledge-base Host plugin.
 *
 * This package owns three things and nothing else:
 * 1. The protocol contract toward the DataOps knowledge API (`protocol.ts`).
 * 2. Idempotent deployment recipes for the remote pieces, run over the
 *    ssh-manager seam (`deploy.ts`, `remote.ts`).
 * 3. The same-origin HTTP surface the Settings panel reads, plus the
 *    model-facing `kb_search` / `kb_chunk_get` / `kb_outline` / `kb_file_*` tools.
 *
 * It owns no authorization logic. DataOps AuthGuard and PermissionGuard resolve
 * the caller's roles and grants from the session credential; this plugin only
 * forwards requests (AGENTS.md "Managed DataOps Authorization"). Which model-facing
 * tools exist is decided from that same permission projection in `toolDisclosure.ts`;
 * path-level checks and the backend remain the enforcement boundary.
 *
 * Content retrieval is deliberately absent. Once the view tree is mounted the
 * official `grep`, `read`, `write`, and `edit` tools operate on it as an
 * ordinary local path, so this capability does not duplicate them.
 *
 * @module @sparkelf/dsh-knowledge-base
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { appendFile, copyFile, link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { constants as fsConstants, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  ManagementToolError,
  createManagementTools,
  defaultPermissionsForRoles,
  hasPermission,
  isGlobalAdmin,
  normalizePublishScope,
  type ManagementAudit,
  type ManagementBucket,
  type ManagementContext,
  type ManagementGrant,
  type ManagementPending,
  type ManagementToolHost,
  type ManagementWorkflow,
} from './managementTools.ts'
import {
  createToolDisclosure,
  type ToolDisclosureCoordinator,
} from './toolDisclosure.ts'
import {
  WorkflowPublishError,
  listApprovedWorkflows,
  listPendingWorkflows,
  listWorkflowsForAuthor,
  publishDirOf,
  publishStorePath,
  publishWorkflow,
  resubmitPublishedWorkflow,
  reviewWorkflow,
  unpublishPublishedWorkflow,
  type WorkflowActor,
} from './workflowPublish.ts'
import z from '@deepseek-ai/schemastery'
import {
  ENDPOINTS,
  KB_RESOURCE_TYPE,
  joinUrl,
  type KnowledgeConfig,
  type KnowledgeGrant,
  type KnowledgeGrantPrincipalType,
  type KnowledgeGrantRequest,
  type KnowledgeRevokeRequest,
  type KnowledgeSshView,
  type KnowledgeStatus,
} from './protocol.ts'
import { localizedScopeForPath, resolveScopeAlias, scopeFromAlias, type ScopeLocale } from './scopeAliases.ts'
import { scanKnowledgeGraphs, type KnowledgeGraphScopeRoot } from './graph.ts'
import { listGraphs, loadGraph, type LoadedGraph } from './graphModel.ts'
import {
  graphScopeBase,
  mergeProjectedGraphs,
  projectGraphJsonScope,
  type ProjectedGraphJsonNode,
} from './graphJsonProjection.ts'
import { GRAPH_CANVAS_HTML } from './graphCanvas.ts'
import {
  KNOWLEDGE_GRAPH_FOLDER,
  knowledgeGraphsOf,
  type KnowledgeGraphCaller,
  type KnowledgeGraphScopeKey,
} from './graphTypes.ts'
import {
  appendOverviewGraphs,
  createKnowledgeGraphTools,
  invalidateOverviewCache,
  isOverviewGraph,
  JsonOverviewStoreProvider,
  OVERVIEW_STORE_FALLBACK_DIR,
  OverviewStoreManager,
  probeOverviewStoreDir,
  overviewScopesFromRoots,
  type KnowledgeGraphToolHost,
} from './graphTools.ts'
import { applySummaryWriteback, summarySnapshotPathFor } from './summaryWriteback.ts'
import { createMemoryTools, type MemoryToolHost } from './memoryTools.ts'
import { ensurePersonalMemoryGraph } from './memoryGraphBootstrap.ts'
import { MemoryStore } from './memoryStore.ts'
import { MemorySettingsStore } from './memorySettings.ts'
import { handleMemoryRoute } from './memoryRoutes.ts'
import { handleMemoryPromotionRoute } from './memoryPromotionRoutes.ts'
import { promotionStorePath, SHARED_MEMORY_GRAPH_ID } from './memoryPromotion.ts'
import { sharedMemoryScopeRoots } from './memoryShared.ts'
import { MemoryGraphWriter, PERSONAL_MEMORY_FOLDER } from './memoryGraphWriter.ts'
import {
  DEFAULT_GUARDIAN_TIMEOUT_MS,
  GuardianSessionStore,
  type GuardianAgentRef,
  type GuardianSessionHost,
} from './guardianSession.ts'
import { createMemoryGuardianTools, type MemoryGuardianToolHost } from './memoryGuardianTool.ts'
import { installMemoryTriggers } from './memoryTriggers.ts'
import { createMemoryRecordTools, type MemoryRecordToolHost } from './memoryRecordTool.ts'
import {
  appendAuditEntry,
  isContainedRelPath,
  isSafeUserId,
  moveEntry,
  bucketOf,
  copyEntry,
  discardPendingWrite,
  expectedViewPathFor,
  isPendingName,
  listPendingWrites,
  parkPendingWrite,
  pointMountAtView,
  readAuditEntries,
  readPendingContent,
  readFavorites,
  readPins,
  readSettings,
  normalizeMineruBaseUrl,
  storedMineruInvalid,
  readTemplates,
  removeTemplate,
  saveTemplate,
  templateBytes,
  readStorageSettings,
  readTreeState,
  readViewMode,
  storageSettingsOf,
  syncView,
  viewPathFor,
  writeFavorites,
  writePins,
  writeSettings,
  writeStorageSettings,
  writeTreeState,
  writeViewMode,
  usableDepartmentPath,
  type KnowledgeAuditEntry,
  type KnowledgeStorageSettings,
  type ResolvedPath,
  type ViewDelta,
} from './views.ts'
import { readLocalStorageSettings, writeLocalStorageRoot } from './localStorageSettings.ts'
import { resolveStorageRoot, storageActualRoot } from './localStoragePath.ts'
import {
  TUTORIAL_FILE_NAME,
  createInitializer,
  type Initializer,
} from './initialize.ts'
import {
  deploymentPlan,
  findStep,
  type DeployPlanContext,
  type DeployStep,
  type MineruBackend,
  type MineruTier,
} from './deploy.ts'
import { RemoteError, originFrom, sshManagerRunner, type RemoteHost, type RemoteRunner } from './remote.ts'
import {
  createExtractionQueue,
  type ExtractionOutcome,
  type ExtractionQueue,
  type ExtractionTask,
} from './extractionQueue.ts'
import { extractDocument, isAlreadyMarkdown, isExtractable, markdownSiblingOf, writeExtractedMarkdown, type MineruBlock } from './extract.ts'
import { BUILT_IN_ROLES, KNOWLEDGE_ACTIONS, isKnowledgeAction, permissionToDataOpsActions } from './permissions.ts'
import { addTombstone, readTrash, removeTombstone, writeTrash } from './trash.ts'
import {
  assertIndexOutsideTrees,
  attachProvenance,
  documentIndexStatus,
  ensureDocumentOutline,
  findChunkForPath,
  findChunkId,
  indexPathFor,
  isIndexableTextPath,
  readChunkProvenance,
  readDocumentOutline,
  rewriteDocumentOutline,
  saveDocumentOutline,
  searchIndex,
  syncIndex,
  type FtsIndexStats,
  type FtsSearchHit,
  type VectorSearchInput,
} from './ftsIndex.ts'
import {
  createKnowledgeFileTools,
  KB_FILE_TOOL_GUIDANCE,
  KnowledgeToolError,
  asKnowledgeToolError,
  type KnowledgeAuditOutcome,
  type KnowledgeFileEntry,
  type KnowledgeFileHit,
  type KnowledgeFileRead,
  type KnowledgeFileToolHost,
  type KnowledgeToolCaller,
  type KnowledgeViewSync,
} from './knowledgeTools.ts'
import { markInternalMutation, startExternalChangeWatcher } from './externalChange.ts'
import type { OutlineSectionSubmission } from './outlineGuard.ts'
import { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_VECTOR_RETRIEVAL,
  EmbeddingProviderError,
  embedTexts,
  normalizeVectorRetrieval,
  type VectorRetrievalConfig,
} from './embeddings.ts'
import {
  chunksForDocuments,
  embeddingContentHash,
  embeddingStates,
  ensureVectorSchema,
  putEmbedding,
  recordVectorFailure,
  vectorDocuments,
  vectorIndexStats,
  type VectorIndexStats,
} from './vectorIndex.ts'

/** The stable citation token shared by search, chunk and resolve responses. */
const citationTokenForChunk = (docId: number, chunkKey: string | undefined, chunkId: number): string => (
  `kb://doc/${String(docId)}/chunk/${String(chunkKey === undefined || chunkKey === '' ? chunkId : chunkKey)}`
)

/** Cordis plugin name. */
export const name = 'dsh-knowledge-base'

/**
 * Host services this plugin needs.
 *
 * `credentials` resolves the session token per request so a rotated token
 * reaches the next request without a restart. `webServer` serves the
 * same-origin routes the Settings panel reads. The SSH transport is reached
 * over HTTP at the ssh-manager's own route, so it is not injected here.
 * `systemPrompt` is the runtime memory instruction section's registry.
 */
export const inject = ['credentials', 'webServer', 'tools', 'systemPrompt', 'agentLoop', 'agents', 'sessionTitle', 'agentDefaultModel']

/** Plugin configuration. */
export interface Config {
  /**
   * Base URL of the DataOps knowledge API. Empty disables the DataOps-backed
   * status/index routes, leaving only the local deployment controls.
   */
  baseUrl: string
  /** Credential reference holding the DataOps session token. */
  credentialRef: string
  /** Request timeout in milliseconds for DataOps API calls. */
  timeoutMs: number
  /**
   * Where documents are stored.
   *
   * `local` keeps them in the workspace's own directory (`mountPoint`): no mount, no
   * sync, no remote round trip per read. `remote` keeps the synchronized shape, where
   * the browsable pointer is a per-user view inside an NFS share refreshed from
   * `actualRoot`. The two modes share listing, preview, edit, permission and audit and
   * differ only in where the bytes live.
   */
  storageMode: 'local' | 'remote'
  /**
   * How a `remote` deployment reaches its share.
   *
   * Orthogonal to {@link storageMode}: a local deployment stores nothing remotely, so it
   * ignores this. `nfs` is the original shape -- an export mounted on the Host at
   * {@link mountPoint}. `sshfs` reaches the same kind of directory over SSH instead, which
   * is what a host behind NAT needs: NFSv4 callbacks cannot traverse NAT, while an
   * outbound SSH connection can. The rest of the plugin does not branch on this: both
   * protocols end as a directory bound into the container at `mountPoint`.
   */
  storageProtocol: 'nfs' | 'sshfs'

  /** Path inside the container where the user's view tree is mounted. */
  mountPoint: string
  /** Absolute path of the authoritative tree on the storage host. */
  actualRoot: string
  /** Absolute path of the per-user view tree on the storage host. */
  viewRoot: string
  /** Local deployments: authoritative storage base, default `~/kb`. */
  storageRoot: string
  /** Where personal memory bindings live; empty means `<actualRoot>/.memory/users`. */
  memoryUsersRoot: string
  /** Where promoted skills are written; empty means `$DSH_HOME/skills` (or `~/.dsh/skills`). */
  memorySkillsRoot: string
  /** Idle minutes before a normal session notifies the memory guardian. */
  memoryIdleMinutes: number
  /**
   * DataOps permission whose holders start memory enabled when they have no
   * settings file yet.
   *
   * The default `kb:config:manage` is granted by the DataOps permission
   * manifest to the global administrator and super administrator roles only.
   * A deployment can point this at a stricter key, or set it to an empty string
   * to disable the default entirely; the KB package never hard-codes a role
   * name. An explicit `memoryEnabled: false` in the user's settings file always
   * wins over this default.
   */
  memoryDefaultEnabledPermission: string
  /** Comma-separated export spec of clients allowed to mount the NFS export. */
  permitted: string
  /** Host serving the export, as an address or `address:/path` pseudo root. */
  nfsServer: string

  /** SSHFS: remote host, as an address or hostname. */
  sshHost: string
  /** SSHFS: login user on that host. */
  sshUser: string
  /** SSHFS: TCP port the SSH daemon listens on. */
  sshPort: number
  /**
   * SSHFS: credential reference holding the private key.
   *
   * A reference, never the key itself: the panel reports only this name and whether it
   * resolves, so the secret stays in the credential store and out of the settings file.
   */
  sshKeyRef: string
  /** SSHFS: absolute path of the shared directory on the remote host. */
  sshRemotePath: string
  /**
   * SSHFS: extra `-o` options for the mount.
   *
   * Kept as one string because that is how `sshfs -o` takes them, and the operator is
   * the one who knows whether their host needs `allow_other` or a different identity
   * file. The mount step always adds the reconnect options this deployment needs.
   */
  sshMountOptions: string
  /** MinerU quality tier to deploy. */
  mineruTier: MineruTier
  /** MinerU small-model backend to deploy. */
  mineruBackend: MineruBackend
  /** TCP port the MinerU API listens on where it is deployed. */
  mineruPort: number
  /**
   * MinerU's full base address, or `''` to derive it from `mineruPort`.
   *
   * Deployment-level fallback for the setting a caller can change on the settings page.
   * Empty keeps the derivation, so a deployment that never sets this keeps working.
   */
  mineruBaseUrl: string
  /** Memory ceiling in MiB for the MinerU service, clamped to half the host's RAM. */
  mineruMemoryMaxMiB: number
  /**
   * Directory holding `published.json` for the workflow plaza.
   *
   * Empty keeps the profile-local default (`$DSH_HOME/workflow-plaza`): the store is
   * product metadata of this profile, not knowledge-tree content, so it deliberately
   * does not live under the mount or the view root.
   */
  publishDir: string
  /** Sidecar directory for the SQLite FTS5 index (outside the agent-visible tree). */
  indexDir?: string
  /**
   * Root for the materialized overview store (Relate/SQLite/JSON backend).
   *
   * Empty means `<actualRoot>/.overview`; the startup probe falls back to
   * `/var/lib/dataops/kb-overview` when the KB root is not writable (a NAS may be
   * read-only, unmounted, or not support the required lock/fsync semantics).
   */
  overviewStoreDir?: string
  /** Master switch for the computed 总图 rows and tool resolution. Default true. */
  overviewEnabled?: boolean
  /** Local fallback when `overviewStoreDir` cannot pass the startup probe. */
  overviewStoreFallbackDir?: string
  /** Idle TTL per level in minutes; clamped to the approved ranges by the manager. */
  overviewTtlMinutes?: { personal: number; department: number; global: number }
  /** LRU cap on cached overview stores. */
  overviewMaxStores?: number
  /** Soft memory budget in MiB for cached overview snapshots. */
  overviewMemoryBudgetMB?: number
  /** Optional hybrid retrieval. Disabled by default; no provider is called unless enabled. */
  retrieval: { vector: import('./embeddings.ts').VectorRetrievalConfig }
  /**
   * Outline generation policy.
   *
   * `autoGenerate: false` (the default) means upload/extraction build only the TOC and
   * section structure. Summaries are written later by the knowledge-base summarize flow through
   * `kb_outline_save`. `true` restores the legacy deterministic extractive summaries.
   */
  outline: { autoGenerate: boolean }
  /** Locale used for the virtual root aliases in search/citation display paths. */
  scopeLocale: ScopeLocale
}

/** Config schema; an invalid value fails the profile load loudly. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().default(''),
  credentialRef: z.string().role('credential-ref').default('DATAOPS_ACCESS_TOKEN'),
  timeoutMs: z.number().default(15_000),
  // The browsable knowledge tree: the POINTER the page browses, not the share's
  // mount point. A sync replaces this path with a symlink to the caller's own view,
  // so it has to be a dedicated location -- and it is deliberately nested one level
  // inside the share rather than being the share root.
  //
  // It used to default to `/workspace/kb` while `actualRoot`/`viewRoot` used
  // `/nas/kb`, which no single deployment could satisfy: the page reported "not
  // mounted" while the share sat one directory over. Pointing it at the share root
  // instead is NOT the fix -- a sync REPLACES its mountPoint, so retargeting
  // `/nas/kb` would delete the mounted export's `actual/` and every `views/`
  // directory on the server. Measured on 2026-10-17 during a near-miss; the guard in
  // `views.pointMountAtView` now refuses that shape outright.
  // The browsable entry point, inside the workspace rather than beside it.
  //
  // It points at `/workspace/kb` because that is where the product shows files: the same
  // tree the official workspace file browser and the model's own tools walk. The pointer
  // is a SYMLINK into the caller's view, and `pointMountAtView` replaces only the link --
  // which is why this path is safe even though it is one level from the share: the
  // dangerous shape is a real directory here, and the guards refuse that outright.
  /**
   * Where documents are stored.
   *
   * `local` keeps them in the workspace's own directory (`mountPoint`), which is where the
   * product's file browser and the model's tools already look. `remote` keeps the
   * synchronized shape: the browsable pointer is a per-user view inside an NFS share,
   * refreshed from `actualRoot`.
   *
   * Local is the default because it is the only shape that needs nothing beyond the
   * workspace: no mount, no sync, no remote round-trip per read. Remote stays supported
   * for deployments that already have a share -- the two modes share the listing,
   * preview, edit, permission and audit paths and differ only in where the bytes live and
   * whether a sync runs.
   */
  storageMode: z.union([z.const('local'), z.const('remote')]).default('local'),
  mountPoint: z.string().default('/workspace/kb'),
  actualRoot: z.string().default('/nas/kb/actual'),
  viewRoot: z.string().default('/nas/kb/views'),
  // Local deployments keep the authoritative copy here. Team deployments keep
  // using actualRoot/viewRoot; this field is ignored for them.
  storageRoot: z.string().default('~/kb'),
  // Personal bindings are local state, never Git content; the default keeps them
  // under the knowledge root's hidden `.memory/` directory.
  memoryUsersRoot: z.string().default(''),
  // Promoted SOPs become DSH skills. Empty keeps the standard home: $DSH_HOME/skills.
  memorySkillsRoot: z.string().default(''),
  // The idle debounce is a product default; operators may tune it.
  memoryIdleMinutes: z.number().default(30),
  // Admin/super-admin first-read default. `kb:config:manage` is the existing
  // DataOps permission granted to those two built-in roles; an explicit false
  // written by the user still wins because the default applies only when the
  // settings file is absent.
  memoryDefaultEnabledPermission: z.string().default('kb:config:manage'),
  permitted: z.string().default('*'),
    // Host serving the export. The mount step builds `address:/` from it, because `fsid=0`
    // in the export makes the share the NFSv4 pseudo root: clients mount the server root
    // rather than a path beneath it.
    nfsServer: z.string().default(''),
  // `nfs` is the default so an existing remote deployment keeps working unchanged: a
  // profile that names no protocol is the one this plugin has always driven.
  storageProtocol: z.union([z.const('nfs'), z.const('sshfs')]).default('nfs'),
  // SSHFS transport. Empty defaults mean "a local or NFS deployment", so nothing here
  // is required until the protocol is switched to `sshfs`; `sshfsMountStep` refuses to
  // render a command from an incomplete set rather than mounting `@:` somewhere.
  sshHost: z.string().default(''),
  sshUser: z.string().default(''),
  sshPort: z.number().default(22),
  // A reference name, not a key. The credential store holds the secret; this field is
  // the key it is looked up by, which is why it is safe to show and to persist.
  sshKeyRef: z.string().default('DATAOPS_KB_SSH_KEY'),
  sshRemotePath: z.string().default(''),
  // Deliberately no `allow_other` default: it needs `user_allow_other` in
  // /etc/fuse.conf, and a mount that silently fails is worse than one that asks the
  // operator for the options their host actually requires.
  sshMountOptions: z.string().default(''),
  // MinerU 4.x recognises exactly `basic` and `standard` as deployment tiers
  // (`mineru/types.py`: `DEPLOYMENT_TIERS`), and `models download --tier` validates against
  // that tuple, so anything else aborts the model download. `flash` is not one of them: it is
  // a *quality* tier used for the parsers that need no local weights at all (CSV, EPUB, HTML),
  // which is why offering it here would fail on a host that needs the download. Measured
  // 2026-10-15 against mineru 4.0.12.
  mineruTier: z.union([z.const('basic'), z.const('standard')]).default('basic'),
  mineruBackend: z.union([z.const('onnx'), z.const('torch')]).default('onnx'),
  mineruPort: z.number().default(8000),
  mineruBaseUrl: z.string().default(''),
  // Measured 2026-10-15 on a 7.9 GB host parsing a one-page PDF: the `basic` tier peaked at
  // 1.86 GB resident, which is already within a 2 GB ceiling and left `MemoryHigh` no headroom
  // at all. The service step clamps this to half of RAM, so the value below is a ceiling for a
  // roomy host rather than a claim about the floor.
  //
  // Headroom matters more than usual because `MemoryHigh` throttles continuously rather than
  // letting the process swap: a host with no swap device turns a cap set at the steady-state
  // size into a parse that stalls instead of one that runs slower.
  mineruMemoryMaxMiB: z.number().default(4096),
  publishDir: z.string().default(''),
  indexDir: z.string().default('/nas/kb/index'),
  overviewStoreDir: z.string().default(''),
  overviewEnabled: z.boolean().default(true),
  overviewStoreFallbackDir: z.string().default(''),
  overviewTtlMinutes: z.object({
    personal: z.number().default(10),
    department: z.number().default(20),
    global: z.number().default(45),
  }).default({ personal: 10, department: 20, global: 45 }),
  overviewMaxStores: z.number().default(64),
  overviewMemoryBudgetMB: z.number().default(32),
  retrieval: z.object({
    vector: z.object({
      enabled: z.boolean().default(false),
      provider: z.union([z.const('openai-compatible'), z.const('ollama')]).default('openai-compatible'),
      baseUrl: z.string().default(''),
      model: z.string().default(''),
      dimensions: z.number().default(0),
      credentialRef: z.string().default(''),
      rrfK: z.number().default(60),
      candidateK: z.number().default(50),
      ftsWeight: z.number().default(1),
      vectorWeight: z.number().default(0.5),
    }).default({
      enabled: false, provider: 'openai-compatible', baseUrl: '', model: '', dimensions: 0,
      credentialRef: '', rrfK: 60, candidateK: 50, ftsWeight: 1, vectorWeight: 0.5,
    }),
  }).default({
    vector: {
      enabled: false, provider: 'openai-compatible', baseUrl: '', model: '', dimensions: 0,
      credentialRef: '', rrfK: 60, candidateK: 50, ftsWeight: 1, vectorWeight: 0.5,
    },
  }),
  // Summaries are model work, not an upload side effect. Keep the structure (TOC and
  // section ids) automatic so navigation and citations work immediately; leave the
  // prose empty until the knowledge-base summarize flow calls `kb_outline_save`.
  outline: z.object({
    autoGenerate: z.boolean().default(false),
  }).default({ autoGenerate: false }),
  scopeLocale: z.union([z.const('zh'), z.const('en')]).default('zh'),
})

/** Why a knowledge-base request failed, with a stable machine-routable code. */
export type KnowledgeErrorCode =
  | 'not-configured'
  | 'unauthorized'
  | 'unreachable'
  | 'bad-response'
  // Personal-deployment path refusals. Each names the shape that was refused, so the
  // caller can tell "outside the knowledge root" from "absolute" from "NUL" instead of
  // reading one generic conflict for all of them.
  | 'escapes-knowledge-root'
  | 'absolute-path'
  | 'empty-path'
  | 'nul-byte'

/** Typed knowledge-base failure. */
export class KnowledgeError extends Error {
  readonly code: KnowledgeErrorCode

  constructor(message: string, code: KnowledgeErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'KnowledgeError'
    this.code = code
  }
}

/** Resolve the session token, or fail with a legible reason. */
async function requireToken(ctx: Context, config: Config): Promise<string> {
  const resolved = await ctx.credentials.resolve(credentialRef(config.credentialRef))
  if (resolved === undefined || resolved.value.trim() === '') {
    throw new KnowledgeError(
      `DataOps session credential "${config.credentialRef}" is not available`,
      'unauthorized',
    )
  }
  return resolved.value
}

/** Perform one authorized JSON request against the knowledge API. */
async function request<T>(
  ctx: Context,
  config: Config,
  path: string,
  init?: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; timeoutMs?: number },
): Promise<T> {
  // Every team call gates on `isTeamDeployment` before reaching this transport, so an empty
  // base URL here means a call site forgot that gate. Throwing keeps that a loud bug rather
  // than a request to the empty string, which would fail somewhere far less legible.
  if (!isTeamDeployment(config)) {
    throw new KnowledgeError(
      'this deployment has no DataOps backend, so the DataOps knowledge API cannot be called',
      'not-configured',
    )
  }
  const token = await requireToken(ctx, config)
  const url = joinUrl(config.baseUrl, path)
  let response: Response
  try {
    response = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      // A caller may ask for a shorter bound than the plugin's own. A list that
      // decorates a page is not worth the general timeout: if the shared backend is
      // busy with unrelated work, the surface should say so rather than make the
      // reader wait for a call that is not the point of the page.
      signal: AbortSignal.timeout(init?.timeoutMs ?? config.timeoutMs),
    })
  } catch (cause) {
    throw new KnowledgeError(`knowledge API is unreachable at ${url}`, 'unreachable', { cause })
  }
  if (response.status === 401 || response.status === 403) {
    // The backend decided the caller may not do this; do not second-guess it.
    throw new KnowledgeError(`knowledge API rejected the request (HTTP ${String(response.status)})`, 'unauthorized')
  }
  if (!response.ok) {
    // The backend explains a rejected write (an unknown principal, a missing
    // path) in its own words, and that message is what the operator needs: a
    // bare status code would send them looking in the wrong place.
    const detail = await readErrorMessage(response)
    throw new KnowledgeError(
      detail ?? `knowledge API failed (HTTP ${String(response.status)})`,
      'bad-response',
    )
  }
  try {
    return (await response.json()) as T
  } catch (cause) {
    throw new KnowledgeError('knowledge API returned invalid JSON', 'bad-response', { cause })
  }
}

/**
 * Read a backend error message from a failed response.
 * @param response - the failed response.
 * @returns The backend's message, or undefined when the body does not carry one.
 */
async function readErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown }
    if (typeof body.message === 'string' && body.message !== '') return body.message
    if (typeof body.error === 'string' && body.error !== '') return body.error
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Whether this deployment runs with a DataOps backend at all.
 *
 * `baseUrl` is the single fact that decides it: an empty value is a PERSONAL deployment, and
 * a filled one is a TEAM deployment whose accounts, permissions, grants, shared settings and
 * templates live in DataOps. This is an environment fact read from configuration, not a
 * feature flag chosen at runtime -- which is why the personal and team paths are the same
 * code with different gates rather than two branches selected by a boolean.
 *
 * Two consequences follow, and both are deliberate:
 *
 * 1. A personal deployment has NO accounts, NO permission model, NO shared settings and NO
 *    member management. Those are not disabled features; they do not exist without an
 *    authority to ask.
 * 2. Every route that used to answer "not configured" now answers normally, gated on the
 *    local filesystem instead. An unconfigured deployment is a supported shape, not an
 *    error state.
 *
 * @param config - resolved plugin config.
 * @returns true when a DataOps backend is configured.
 */
export function isTeamDeployment(config: Config): boolean {
  return config.baseUrl.trim() !== ''
}

/**
 * The identity a personal deployment acts as.
 *
 * A personal deployment has no caller to ask about: there is one operator, at the keyboard,
 * with the file permissions of the process. `viewPathFor` still keys a view directory by
 * user id, so this constant keeps that code path single rather than adding a second one for
 * "no user".
 */
export const LOCAL_USER_ID = 'local'

/**
 * The permission context a personal deployment discloses tools from.
 *
 * A personal deployment has no accounts, so there is nobody to ask: the local
 * operator owns every capability the product knows about. Kept as a function rather
 * than the inline object inside the management host so the disclosure coordinator
 * can register the personal tool surface synchronously at startup, instead of
 * waiting for a backend round trip that does not exist.
 *
 * @returns the full-capability context a local owner holds.
 */
export function localManagementContext(): ManagementContext {
  return {
    userId: 'local',
    username: 'local',
    displayName: '个人用户',
    primaryRole: 'LOCAL_OWNER',
    roleCodes: ['LOCAL_OWNER'],
    permissions: [
      'kb:file:read', 'kb:file:write', 'kb:file:delete', 'kb:file:extract',
      'kb:audit:read', 'kb:grant:manage', 'kb:review:decide', 'kb:config:manage',
      'workflow:read', 'workflow:publish', 'workflow:manage',
      'workflow:review:decide', 'workflow:review:global',
    ],
    departmentCode: null,
    departmentPathCodes: [],
    dataScope: { all: true, self: true, departmentCodes: [] },
    review: { canReview: true, canReviewGlobal: true, canManagePermissions: true, departments: [] },
  }
}

/**
 * Why a path was refused in a personal deployment.
 *
 * Named rather than silently refused: the reader asked for a file and the answer must say
 * whether the path left the knowledge root or was simply not there.
 */
export interface LocalPathRefusal {
  /** Machine-readable reason. */
  readonly code: 'escapes-knowledge-root' | 'absolute-path' | 'empty-path' | 'nul-byte'
  /** One sentence naming what was wrong with the path. */
  readonly reason: string
}

/**
 * Whether a personal deployment may read or write one path.
 *
 * A personal deployment has no OTHER users to protect a path from, so there is no grant to
 * consult -- but that is not the same as having no boundary. The boundary is the knowledge
 * root itself: a relative path that stays inside `actualRoot` is allowed, and anything that
 * climbs out is refused with a reason.
 *
 * The check is spelled out instead of relying on `join(root, relPath)` to clamp, because a
 * silent clamp would let `../../etc/passwd` resolve to something inside the tree and report
 * success for a request that should have been refused.
 *
 * @param relPath - the path as the caller sent it, relative to the knowledge root.
 * @returns undefined when the path is allowed, else why it is not.
 */
export function checkLocalPath(relPath: string): LocalPathRefusal | undefined {
  if (relPath.trim() === '') {
    return { code: 'empty-path', reason: 'the path is empty' }
  }
  if (relPath.includes('\0')) {
    return { code: 'nul-byte', reason: 'the path contains a NUL byte' }
  }
  if (relPath.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(relPath)) {
    return { code: 'absolute-path', reason: 'the path must be relative to the knowledge root' }
  }
  // `isContainedRelPath` is the same predicate the team path uses before it asks DataOps, so
  // a personal deployment refuses exactly the shapes a team deployment would never send.
  if (!isContainedRelPath(relPath)) {
    return {
      code: 'escapes-knowledge-root',
      reason: 'the path leaves the knowledge root; "..", "." and empty segments are not allowed',
    }
  }
  return undefined
}

/**
 * The local boundary's refusal for a PERSONAL deployment, or undefined.
 *
 * A team deployment sends the same path shapes to DataOps and reports a permission
 * answer; only the personal deployment owns a local boundary, and it is the one that has
 * to say WHICH shape was wrong. Keeping the projection here keeps a route from answering
 * a path escape with the generic "not configured" code it used to reuse.
 * @param config - resolved plugin config.
 * @param relPath - the path as the caller sent it.
 * @returns undefined when the deployment is a team one or the path is inside the root.
 */
function personalPathRefusal(config: Config, relPath: string): LocalPathRefusal | undefined {
  return isTeamDeployment(config) ? undefined : checkLocalPath(relPath)
}

/**
 * Normalize a PERSONAL write path to the caller's own subtree.
 *
 * The page's upload destination is the virtual bucket `personal`, so a file dropped
 * there arrives as `personal/<file>`. That spelling has no owner segment; writing it
 * literally would put the document beside the owners and force the permission layer
 * to grant the whole `personal` bucket, which resolves as shared across users.
 * Rewriting it to `personal/<callerId>/<file>` keeps the owner in the path, makes the
 * existing `personal/<userId>` grants sufficient, and keeps every user's personal
 * bucket disjoint. An explicit `personal/<uuid>/…` is left untouched so a cross-user
 * write still reaches the permission layer and is refused rather than silently
 * redirected.
 *
 * @param relPath - the path as the caller sent it.
 * @param callerId - the authenticated caller's user id.
 * @returns the caller-scoped personal path, or the input when it is not personal.
 */
export function normalizePersonalWritePath(relPath: string, callerId: string): string {
  const normalized = resolveScopeAlias(relPath)
  if (!normalized.startsWith('personal/')) return normalized
  if (normalized === `personal/${callerId}` || normalized.startsWith(`personal/${callerId}/`)) {
    return normalized
  }
  const rest = normalized.slice('personal/'.length)
  const head = rest.split('/')[0] ?? ''
  // A UUID-shaped first segment is an explicit owner; leave it for the permission
  // layer to allow (own) or refuse (someone else). Anything else is a file/folder
  // named directly under the virtual bucket and belongs to the caller.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(head)) {
    return normalized
  }
  return `personal/${callerId}/${rest}`
}

/**
 * The resolved layout, derived on the Host.
 *
 * There is no backend counterpart to ask: DataOps serves no knowledge config
 * route, so the mounted layout the container was started with is the answer. A
 * remote call here would only ever answer 404.
 * @param config - resolved plugin config.
 * @returns The layout the page renders.
 */
/** The authoritative root for a local deployment. */
export function localStorageRoot(config: Config): string {
  if (isTeamDeployment(config)) return config.actualRoot
  const configured = (config.storageRoot ?? '').trim()
  // A pre-setting local profile stored documents at its custom mountPoint. Keep
  // reading that tree until the operator explicitly chooses a different path.
  if (configured === '' || configured === '~/kb') {
    // A pre-setting personal profile may already point actualRoot at its real
    // directory; that is more authoritative than the container-style mountPoint.
    if ((config.actualRoot ?? '').trim() !== '' && (config.actualRoot ?? '').trim() !== '/nas/kb/actual') {
      return resolveStorageRoot(config.actualRoot)
    }
    if ((config.mountPoint ?? '').trim() !== '' && (config.mountPoint ?? '').trim() !== '/workspace/kb') {
      return resolveStorageRoot(config.mountPoint)
    }
  }
  return storageActualRoot(resolveStorageRoot(configured === '' ? '~/kb' : configured))
}

/** Overlay the profile-local storage-root setting on a config. */
export function withLocalStorageRoot(config: Config, storageRoot: string | undefined): Config {
  if (storageRoot === undefined || config.storageMode !== 'local') return config
  return { ...config, storageRoot }
}

export function localConfig(
  config: Config,
  /**
   * Whether the SSHFS credential currently resolves.
   *
   * Passed in rather than resolved here because this function is synchronous and called from
   * a dozen places that never touch the SSH transport. A caller that shows the panel resolves
   * it first; every other caller leaves it false, which only means "this answer does not
   * claim a key".
   */
  sshKeyConfigured = false,
): KnowledgeConfig & {
  backendConfigured: boolean
  storageProtocol: 'nfs' | 'sshfs'
  ssh: KnowledgeSshView
  retrieval: import('./embeddings.ts').VectorRetrievalConfig
} {
  const localRoot = localStorageRoot(config)
  return {
    mountPoint: isTeamDeployment(config)
      ? config.mountPoint
      : (config.mountPoint ?? '').trim() === '' || (config.mountPoint ?? '').trim() === '/workspace/kb'
        ? localRoot
        : config.mountPoint,
    actualRoot: isTeamDeployment(config) ? config.actualRoot : localRoot,
    viewRoot: isTeamDeployment(config)
      ? config.viewRoot
      : (config.viewRoot ?? '').trim() !== '' && config.viewRoot !== '/nas/kb/views'
        ? config.viewRoot
        // Personal audit/pin state is internal, not a document folder in the KB tree.
        : join(dirname(localRoot), '.kb-state'),
    storageRoot: config.storageRoot ?? '~/kb',
    nfsServer: config.nfsServer,
    host: !isTeamDeployment(config) ? '' : safeHost(config.baseUrl),
    backendConfigured: isTeamDeployment(config),
    storageProtocol: config.storageProtocol,
    // Every field here is safe to render. `keyConfigured` is derived, not the key: the panel
    // needs to know whether the mount step will find one, and nothing more.
    ssh: {
      host: config.sshHost,
      user: config.sshUser,
      port: config.sshPort,
      remotePath: config.sshRemotePath,
      mountOptions: config.sshMountOptions,
      keyRef: config.sshKeyRef,
      keyConfigured: sshKeyConfigured,
    },
    retrieval: config.retrieval?.vector ?? DEFAULT_VECTOR_RETRIEVAL,
  }
}

/** Read a base URL's host, tolerating a value that is not a URL at all. */
function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/**
 * Read the mounted tree's shape without consulting a backend.
 *
 * The count comes from the mounted directory itself, which is the same tree the
 * model's grep and read tools see, so the number the page reports cannot drift
 * from what retrieval actually reaches.
 * @param config - resolved plugin config.
 * @returns The visible file count, or null when the mount is absent.
 */
export async function localStatus(config: Config): Promise<KnowledgeStatus> {
  const mounted = await countFiles(localConfig(config).mountPoint)
  return {
    visibleFiles: mounted,
    lastSyncAt: null,
    indexing: { running: false },
  }
}

/**
 * Why the visible tree is not readable, when it is not.
 *
 * A null count used to be one condition and is really two, and the page told the
 * reader the wrong one. It means either the mounted tree is absent, or the pointer
 * at `mountPoint` has not been built yet -- a per-user symlink that only a view
 * sync creates. The second is the ordinary state for a caller who has been granted
 * nothing yet, and reporting it as "not mounted" sends the reader to inspect a
 * mount that is working.
 *
 * The distinction is a filesystem fact, not a policy: whether the configured path
 * exists at all, versus whether it is a pointer this plugin can build on demand.
 */
export type KnowledgeMountState = 'mounted' | 'pointer-missing' | 'absent'

/** The fields a sync reports beyond the filesystem delta. */
export interface SyncReportFields {
  /** The browsable path that was retargeted. */
  mountPoint: string
  /** Whether the pointer now points at this caller's view. */
  mountPointed: boolean
  /** The identity the view is keyed by. */
  userId: string
  /** Human-readable name of the caller, when the backend reported one. */
  label?: string
  /** Candidate paths considered. */
  considered: number
  /** Paths DataOps resolved as readable. */
  resolved: number
  /** The view directory this caller's files are linked into. */
  viewPath: string
}

/**
 * Classify why the browsable path does or does not yield a file count.
 *
 * Reads the configured path rather than inferring from the count, because a count
 * of null is compatible with both failure modes and cannot tell them apart.
 * @param config - resolved plugin config.
 * @returns The state, in order of increasing severity.
 */
export async function classifyMount(config: Config): Promise<KnowledgeMountState> {
  const mountPoint = localConfig(config).mountPoint
  if (mountPoint.trim() === '') return 'absent'
  try {
    const info = await stat(mountPoint)
    // Exists and is a directory: the tree is readable, whether it came from a mount
    // or from a pointer this plugin built.
    if (info.isDirectory()) return 'mounted'
    // A file where the pointer belongs is a configuration fault. Reporting it as
    // "not yet generated" would invite a retry that cannot succeed.
    return 'absent'
  } catch {
    // The path is missing. Either the share is not attached -- in which case the
    // parent is missing too -- or the share is fine and this plugin has yet to build
    // its pointer inside it. The parent tells the two apart.
    try {
      return (await stat(dirname(mountPoint))).isDirectory() ? 'pointer-missing' : 'absent'
    } catch {
      return 'absent'
    }
  }
}

/**
 * Rebuild the caller's visible tree and point the browsable path at it.
 *
 * Shared by the explicit `views.sync` route and the status route's first-load
 * repair, so both take exactly the same path: one implementation means the
 * automatic case cannot drift from the button the reader can press.
 *
 * It is idempotent and writes nothing when the resolved set is unchanged, which is
 * what makes it safe to run without being asked -- `syncView` returns
 * `unchanged > 0, linked: []` in that case.
 *
 * The decision stays with DataOps: the resolve route is self-scoped, and this
 * function only links what that answer allows.
 * @param host - the plugin context, for the backend calls.
 * @param config - resolved plugin config.
 * @param paths - candidate relative paths; omitted means walk the authoritative root.
 * @returns The sync report, or a refusal the caller should relay.
 */
export async function syncCallerView(
  host: Context,
  config: Config,
  paths?: string[],
  options: {
    /**
     * Called after a file that existed only in the view was imported into the
     * authoritative tree. The caller owns extraction/indexing because only it knows
     * the deployment's parser settings and queue.
     */
    onAdopted?: (adopted: { viewPath: string; actualRelPath: string }) => void | Promise<void>
  } = {},
): Promise<(ViewDelta & SyncReportFields & { status: number; error?: never }) | { status: number; error: string }> {
  const plan = localConfig(config)
  let caller
  try {
    caller = await fetchCaller(host, config)
  } catch (error) {
    // The identity is the key the view is stored under, so without it there is no
    // directory to build and no safe default. Reported rather than guessed.
    return { status: 502, error: describeError(error).message }
  }
  if (!isSafeUserId(caller.userId)) {
    return { status: 400, error: 'unsafe caller id; cannot key a view by it' }
  }
  const candidates = paths ?? await listRelativeFiles(plan.actualRoot)
  const allowed: ResolvedPath[] = []
  // The paths the caller explicitly asked about that did NOT resolve as readable.
  //
  // `canReadPath` fails closed, so a backend problem and a genuine denial both land
  // here. Reported rather than folded into the count because a WRITE route passes
  // exactly one path -- the one it just created -- and needs to know whether the
  // reader will be able to see it. Without this, "sync walked the tree" was
  // indistinguishable from "the new document is in the view".
  const unresolved: string[] = []
  for (const relPath of candidates) {
    if (!isContainedRelPath(relPath)) continue
    if (await canReadPath(host, config, relPath)) allowed.push({ relPath })
    else if (paths !== undefined) unresolved.push(relPath)
  }
  const viewOptions = {
    actualRoot: plan.actualRoot,
    viewRoot: plan.viewRoot,
    userId: caller.userId,
    ...(caller.departmentCode === undefined ? {} : { departmentCode: caller.departmentCode }),
    // The organization path is what nests the department bucket. Passed only when
    // DataOps reported a usable one, so an older backend leaves the bucket in its
    // single-level shape instead of being handed an empty hierarchy.
    ...(caller.departmentPathCodes === undefined
      ? {}
      : { departmentPathCodes: caller.departmentPathCodes }),
  }
  // The caller's removals filter the view they are about to get. An unreadable
  // record is treated as "nothing hidden" rather than as an error: failing the whole
  // sync over a bookkeeping file would take the tree away from a caller whose
  // documents are all still granted, which is worse than showing a removed file
  // until the record can be repaired.
  const trash = await readTrash(viewPathFor(viewOptions))
  if (trash.kind === 'unreadable') {
    host.logger?.warn?.(`knowledge-base: unusable trash record for ${caller.userId}: ${trash.reason}`)
  }
  // A tombstone stores the path the CALLER named, which is the authoritative one
  // (`personal/<uid>/note.md`). `syncView` compares against the VIEW path it is about
  // to create (`personal/note.md` -- the owner segment is dropped, see `bucketOf`).
  // For `global` and nested departments the two are the same string, which is why
  // removal appeared to work; for `personal` and legacy flat department paths they
  // differ, so the tombstone never matched and the deleted document stayed in the
  // list. Measured on the live deployment: deleting `personal/<uid>/probe.md` wrote
  // the tombstone and left the file visible.
  //
  // Both forms are emitted here rather than teaching `syncView` about two coordinate
  // systems: the view builder has ONE rule for what to hide, and the caller is what
  // knows where a path came from. Emitting both keeps old tombstones working with no
  // migration -- the raw form is already what they contain.
  const hidden = trash.kind === 'ready'
    ? trash.entries.flatMap(entry => {
      const placement = bucketOf(entry.relPath, usableDepartmentPath(caller.departmentPathCodes))
      const viewPath = placement === undefined ? undefined : placement.bucket + '/' + placement.inner
      return viewPath === undefined || viewPath === entry.relPath
        ? [entry.relPath]
        : [entry.relPath, viewPath]
    })
    : []
  // Two facts travel here that `syncView` cannot work out for itself.
  //
  // `fullScan`: `paths === undefined` means the candidate list came from walking the
  // authoritative root, so this set is the whole answer. When the caller named paths,
  // the rest of the view is unexamined and must not be pruned.
  //
  // `trustResolvedSet`: false when the scan considered files but resolved NONE of
  // them. `canReadPath` fails closed without reporting why, so that shape is a
  // wholesale failure at least as often as it is a total revoke -- and pruning on it
  // would delete every link the reader has. The view is kept and the refusal travels
  // back as `pruneSkipped`, which `status` reports.
  const trustResolvedSet = !(paths === undefined && candidates.length > 0 && allowed.length === 0)
  const delta = await syncView(
    {
      ...viewOptions,
      hidden,
      fullScan: paths === undefined,
      trustResolvedSet,
      // A file that is only in the view did not come through a write route. Import
      // it instead of deleting it, but only when the caller may write that path and
      // it is a document this deployment could ever index or extract.
      adoptOrphan: (viewPath, fullPath) => adoptViewFile(host, config, viewPath, {
        caller,
        fullPath,
      }).then(result => {
        if (!result.adopted) return false
        void Promise.resolve(options.onAdopted?.({
          viewPath,
          actualRelPath: result.actualRelPath ?? viewPath,
        })).catch(() => undefined)
        return true
      }),
    },
    allowed,
  )
  // Retarget the browsable mount at this user's view. Without it the page would
  // browse the shared export, so a grant would change the view on disk and nothing
  // the user can see.
  const mountPointed = await pointMountAtView(viewOptions, plan.mountPoint)
  return {
    status: 200,
    mountPoint: plan.mountPoint,
    mountPointed,
    userId: caller.userId,
    label: caller.label,
    considered: candidates.length,
    resolved: allowed.length,
    ...(unresolved.length === 0 ? {} : { unresolved }),
    viewPath: viewPathFor(viewOptions),
    ...delta,
  }
}

/**
 * Enumerate every file under the authoritative root, as relative paths.
 *
 * The view builder needs candidate paths to ask the permission store about. When a
 * caller does not supply them, this walks the tree and produces exactly the set a
 * view could ever hold: hidden names are skipped, matching what the explorer shows
 * and keeping editor scratch files out of every user's view.
 * @param root - the authoritative directory.
 * @returns Relative paths of the files under it.
 */
export async function listRelativeFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) found.push(full.slice(root.length + 1))
    }
  }
  await walk(root)
  return found
}

/**
 * One directory's measured shape, for the indexing table.
 *
 * Every field is a fact read from the filesystem: the count, the newest
 * modification instant, and whether the caller could read it. Nothing here is an
 * estimate of a job state, because this plugin has no index job to report.
 */
export interface DirectoryShape {
  /** Path relative to the mount point; an empty string is the mount itself. */
  relPath: string
  /** Files below this directory, counted recursively. */
  fileCount: number
  /** Newest modification instant in Unix ms, absent when nothing could be read. */
  mtimeMs?: number
  /** Whether this directory's own entries could be listed. */
  readable: boolean
  /**
   * Whether some part of this subtree could not be read, making `fileCount` a
   * lower bound rather than a total.
   *
   * Separate from {@link readable} because the two describe different things: a
   * directory can be listable itself while containing a subdirectory that is not.
   * Rolling both into one flag would either call a readable directory unreadable
   * or present a partial count as a whole one.
   */
  partial: boolean
}

/**
 * Report the mount's per-directory shape.
 *
 * The indexing page needs rows, and the only true rows available are directories
 * of the mounted tree: this plugin has no index of its own, so there is no
 * per-directory index status to report and none is invented. What is measurable
 * is how many files sit below each directory, when the newest one changed, and
 * whether the caller can read it.
 *
 * Only the first level is listed. A row per every nested directory would be a
 * tree dump rather than a table, and the children of an expanded directory are
 * already reachable from the file tree beside this page.
 *
 * Hidden entries are skipped, matching every other walk in this module: they are
 * editor scratch files rather than knowledge documents.
 * @param root - the directory to report on, normally the mount point.
 * @returns One row per visible child directory, plus the root's own row.
 */
export async function listDirectoryShapes(root: string): Promise<DirectoryShape[]> {
  if (root.trim() === '') return []
  /** Count files below one directory, and the newest instant among them. */
  const measure = async (dir: string): Promise<{ fileCount: number; mtimeMs?: number; readable: boolean; partial: boolean }> => {
    let fileCount = 0
    let mtimeMs: number | undefined
    // Whether THIS directory's own entries could be listed, and separately whether
    // the walk hit a refusal anywhere below it. A directory can be listable while
    // holding one that is not, so one flag cannot carry both facts: see the
    // interface above.
    let readable = true
    let partial = false
    const walk = async (current: string, isRoot: boolean): Promise<void> => {
      let entries
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch {
        // A refusal contributes no files rather than failing the whole table, but
        // it is recorded: the zero it produced must not read as "this directory is
        // empty", and an ancestor's total must not read as complete.
        if (isRoot) readable = false
        partial = true
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(full, false)
          continue
        }
        if (!entry.isFile()) continue
        fileCount += 1
        const when = await modifiedAt(full)
        if (when.mtimeMs !== undefined && (mtimeMs === undefined || when.mtimeMs > mtimeMs)) {
          mtimeMs = when.mtimeMs
        }
      }
    }
    await walk(dir, true)
    return { fileCount, ...(mtimeMs === undefined ? {} : { mtimeMs }), readable, partial }
  }

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    // A missing mount is a normal state, and the page says so rather than
    // rendering a row of zeroes that reads as an empty knowledge base.
    return []
  }
  const rows: DirectoryShape[] = []
  // The root's own row first: "all files" is the row a reader checks against the
  // count in the page header, so it leads rather than being buried among children.
  rows.push({ relPath: '', ...await measure(root) })
  const children = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of children) {
    const full = join(root, entry.name)
    rows.push({ relPath: entry.name, ...await measure(full) })
  }
  return rows
}

/** Count visible files under a mount point, or null when it is not mounted. */
async function countFiles(root: string): Promise<number | null> {
  if (root.trim() === '') return null
  try {
    let total = 0
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (entry.isFile()) total += 1
      }
    }
    await walk(root)
    return total
  } catch {
    // A missing mount is a normal state for a workspace whose storage host is
    // not attached yet, so it reports absence rather than failing the page.
    return null
  }
}

  /**
   * Fetch the grant table from the backend.
   *
   * The route answers `{ grants: [...] }`, not a bare array. Reading it as an array
   * would hand a `.map` call an object -- which is what the empty panel was
   * reporting as "map is not a function" -- so both shapes are accepted here: a
   * backend that answers the bare array keeps working, and the shape this
   * deployment returns is the one the panel sees.
   *
   * @param ctx - Host context.
  /**
   * Fetch the grant table from the backend.
   *
   * Two translations happen here, and both are the reason this is not a one-line
   * relay:
   *
   * 1. The route answers `{ grants: [...] }`, not a bare array. Reading it as an
   *    array handed a `.map` an object, which is what the empty panel reported as
   *    "map is not a function".
   * 2. A backend grant names its document `resourceId` and does not carry a
   *    `kind`, `grantedBy` or `grantedAt`. Those are this plugin's own vocabulary,
   *    so they are derived here: the path is the resource id, a path with an
   *    extension is a file, and the grantor and timestamp fall back to neutral
   *    answers rather than being invented.
   *
   * @param ctx - Host context.
   * @param config - resolved plugin config.
   * @returns the grants, empty when the body carries none.
   */
  export async function fetchGrants(ctx: Context, config: Config): Promise<KnowledgeGrant[]> {
    const body = await request<unknown>(ctx, config, ENDPOINTS.grants)
    const raw: unknown[] = Array.isArray(body)
      ? body
      : (Array.isArray((body as { grants?: unknown }).grants) ? (body as { grants: unknown[] }).grants : [])
    const grants: KnowledgeGrant[] = []
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      const relPath = typeof record.resourceId === 'string'
        ? record.resourceId
        : (typeof record.relPath === 'string' ? record.relPath : '')
      const id = typeof record.id === 'string' ? record.id : ''
      const principalId = typeof record.principalId === 'string' ? record.principalId : ''
      // A grant with no path or no principal cannot be shown or acted on; skipping
      // it is better than rendering a row whose every column is blank.
      if (relPath === '' || principalId === '' || id === '') continue
      const principalType = typeof record.principalType === 'string'
        ? record.principalType as KnowledgeGrantPrincipalType
        : 'user'
      grants.push({
        id,
        relPath,
        kind: typeof record.kind === 'string'
          ? record.kind as 'file' | 'directory'
          : (relPath.includes('.') ? 'file' : 'directory'),
        principalType,
        principalId,
        action: typeof record.action === 'string' ? record.action : 'read',
        grantedBy: typeof record.grantedBy === 'string' ? record.grantedBy : '',
        grantedAt: typeof record.grantedAt === 'string' ? record.grantedAt : '',
      })
    }
    return grants
  }

/** One match the search surface can render. */
export interface KnowledgeHit {
  /** Path relative to the mount point, which is also the grant's resource id. */
  relPath: string
  /** File name alone, for a compact row. */
  name: string
  /** Whether the term matched the file's text rather than only its name. */
  inContent: boolean
  /** Matching line, when the term matched inside the file. */
  line?: string
  /** 1-based line number of {@link line}. */
  lineNumber?: number
  /** Last-modified instant in Unix ms, when the stat succeeded. */
  mtimeMs?: number
}

/**
 * Search the mounted tree by file name and text.
 *
 * This is a direct walk rather than an index, matching how retrieval works here:
 * the tools read the mount with grep and read, so there is no separate index whose
 * contents could disagree with the files. Only text files are opened, and only up
 * to a byte budget, so a search over a large mount stays bounded.
 * @param root - the mount point to walk.
 * @param term - case-insensitive term to look for.
 * @param limit - maximum hits to return.
 * @returns The hits, name matches first.
 */
export async function searchKnowledge(root: string, term: string, limit = 50): Promise<KnowledgeHit[]> {
  if (root.trim() === '' || term.trim() === '') return []
  const needle = term.trim().toLowerCase()
  const byName: KnowledgeHit[] = []
  const byContent: KnowledgeHit[] = []

  // A file whose name matches is reported once, without being opened: the name is
  // what the caller searched for, and reading every match would cost the most for
  // the least added value.
  const walk = async (dir: string): Promise<void> => {
    if (byName.length + byContent.length >= limit * 4) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // An unreadable subdirectory is skipped rather than failing the whole search.
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      const rel = full.slice(root.length + 1)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const when = await modifiedAt(full)
      if (entry.name.toLowerCase().includes(needle)) {
        byName.push({ relPath: rel, name: entry.name, inContent: false, ...when })
        continue
      }
      const hit = await matchInside(full, needle)
      if (hit !== undefined) {
        byContent.push({ relPath: rel, name: entry.name, inContent: true, ...hit, ...when })
      }
    }
  }

  await walk(root)
  return [...byName, ...byContent].slice(0, limit)
}

/** One directory entry, as the page's own listing renders it. */
export interface KnowledgeEntry {
  /** Path relative to the mount point. */
  relPath: string
  /** Name alone. */
  name: string
  /** Whether this entry is a directory. */
  isDir: boolean
  /** Last-modified instant in Unix ms, when it could be read. */
  mtimeMs?: number
  /** Size in bytes for files. */
  size?: number
  /**
   * Whether the calling user may read this path; `true` on every row a permission
   * check produced.
   *
   * A row carries the file's name, size and modification time, so a denied path
   * cannot be published with a "not yours" marker on it: the marker is not what
   * discloses the file. Denied and undecided paths are removed from the result
   * instead (see {@link listDirectoryWithPermissions}), which is also why the flag
   * is redundant here and only kept for a row that was explicitly resolved.
   */
  readable?: boolean
  /** Number of direct children, for a directory row. */
  childCount?: number
  /**
   * Whether a reader exists for this file's format.
   *
   * Set on file rows only. The page uses it to decide whether "extract markdown" is a
   * meaningful action for this row, so the menu does not have to know the extractor's
   * extension list.
   */
  canExtract?: boolean
  /**
   * Whether this file's `.md` sibling already exists.
   *
   * Set on file rows only, and only for formats that have an extractor. Lets the page
   * say "already extracted" rather than offering a retry that would be refused.
   */
  hasMarkdown?: boolean
}

/**
 * List one directory level with each child's modification time.
 * @param root - the mount point, used to make paths relative.
 * @param dir - absolute directory to read.
 * @returns The entries, directories first then files, each in name order.
 */
export async function listDirectory(root: string, dir: string): Promise<KnowledgeEntry[]> {
  dir = resolveScopeAlias(dir)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const rows: KnowledgeEntry[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    const rel = full.slice(root.length + 1)
    if (entry.isDirectory()) {
      rows.push({ relPath: rel, name: entry.name, isDir: true, ...await modifiedAt(full) })
      continue
    }
    if (!entry.isFile()) continue
    const when = await modifiedAt(full)
    let size: number | undefined
    try {
      size = (await stat(full)).size
    } catch { size = undefined }
    rows.push({ relPath: rel, name: entry.name, isDir: false, ...when, size })
  }
  // Directories lead, then files, each alphabetically: a listing is scanned for the
  // folder a reader wants before the document inside it.
  rows.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1)))
  return rows
}

/**
 * List one directory level, keeping only the entries DataOps resolved as readable.
 *
 * The listing and the permission check are separate concerns, so this composes
 * them rather than growing {@link listDirectory}: a caller that only needs the
 * filesystem facts (the preview, the search) keeps using that one.
 *
 * Removing a row rather than tagging it is the whole point. A row carries the
 * file's name, size and modification time, so returning a denied path with a "not
 * yours" marker on it discloses precisely what the check was meant to withhold:
 * the marker is not what reveals the file, and a reader can still fetch its bytes.
 * Proving that a name is off limits is not a reason to show the name.
 *
 * Every unresolved case fails closed. An empty base URL, a missing caller id, and a
 * resolve call that throws all drop the row, because "the answer could not be
 * obtained" is not a licence to publish. Answering the unknown case with the full
 * listing is what made an unreachable backend publish every file.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @param root - the mount point.
 * @param dir - absolute directory to read.
 * @param userId - the caller whose view the answer is about.
 * @returns The rows DataOps resolved as readable, in listing order.
 */
export async function listDirectoryWithPermissions(
  ctx: Context,
  config: Config,
  root: string,
  dir: string,
  userId: string | undefined,
): Promise<KnowledgeEntry[]> {
  const rows = await listDirectory(root, dir)
  // A personal deployment filters nothing: there is one operator and no grants, so every row
  // the directory holds is a row this operator may read. Returning the rows instead of an
  // empty list is what makes the tree render at all -- an empty answer here is
  // indistinguishable from an empty folder, and the page would show a knowledge base with
  // nothing in it.
  //
  // The path boundary still applies, and it is enforced twice: `listDirectory` only walks
  // inside `dir`, and each row's `relPath` is checked here so a name that escapes the root
  // cannot appear as a row.
  if (!isTeamDeployment(config)) {
    return rows.filter(row => checkLocalPath(row.relPath) === undefined)
  }
  // Without an identity there is no question to ask, and a question that cannot be asked
  // cannot come back "yes". A team deployment whose caller could not be identified has
  // nothing verified to list, so the page reports that through `permissionsResolved`.
  if (userId === undefined) return []
  // Asked one path at a time on purpose: the resolve route is self-scoped and takes
  // a single resource, so batching would mean inventing a second decision path.
  // Rows are few (one directory level), and each answer is a boolean.
  // Annotated as a union rather than inferred: the mapping produces a required
  // `readable: true` on survivors, and `KnowledgeEntry` declares the flag optional, so the
  // inferred element type is not a subtype the filter can narrow to. Naming the parameter
  // keeps the predicate honest instead of widening the row type to satisfy the compiler.
  const resolved: Array<KnowledgeEntry | undefined> = await Promise.all(rows.map(async (row) => {
    try {
      // `readable` is set on the survivors only, so a row that reaches a caller
      // always carries an affirmative answer rather than an absent flag.
      return await canReadPath(ctx, config, row.relPath) ? { ...row, readable: true } : undefined
    } catch {
      return undefined
    }
  }))
  return resolved.filter((row): row is KnowledgeEntry => row !== undefined)
}

/**
 * Read a file's modification instant.
 *
 * The tree's own entry shape carries no timestamp, so a row cannot show one; the
 * search rows and the preview header are where a time can be shown honestly,
 * because each of those already touches the file.
 * @param full - absolute path to stat.
 * @returns The instant, or an empty object when it cannot be read.
 */
async function modifiedAt(full: string): Promise<{ mtimeMs?: number }> {
  try {
    return { mtimeMs: (await stat(full)).mtimeMs }
  } catch {
    return {}
  }
}

/** Largest file the search will open, so one large document cannot stall it. */
const SEARCH_MAX_FILE_BYTES = 20 * 1024 * 1024

/**
 * How much of a file the preview renders.
 *
 * A preview is for reading, not for loading a dataset into the DOM: past this size
 * the page reports the truncation instead of freezing on a multi-megabyte document.
 */
const PREVIEW_MAX_BYTES = 256 * 1024

/**
 * Look for the term inside one file.
 * @param full - absolute path to read.
 * @param needle - lowercase term.
 * @returns The matching line, or undefined when the file has no match.
 */
async function matchInside(
  full: string,
  needle: string,
): Promise<{ line: string; lineNumber: number } | undefined> {
  try {
    const info = await stat(full)
    if (info.size > SEARCH_MAX_FILE_BYTES) return undefined
    const body = await readFile(full, 'utf8')
    // A NUL byte is the usual signal that this is not text; decoding it as UTF-8
    // would otherwise turn a binary into a page of replacement characters.
    if (body.includes('\0')) return undefined
    const lines = body.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      if (line.toLowerCase().includes(needle)) {
        return { line: line.trim().slice(0, 200), lineNumber: index + 1 }
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Read one knowledge file for the preview.
 *
 * The preview must not depend on a conversation session. The listing is served by
 * this plugin's own route and needs none, so a session-backed read would leave the
 * page able to list files and unable to open them, which reads as a broken preview
 * rather than as a missing session. Containment is checked here because the path
 * arrives from the browser.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @param relPath - path relative to the mount point.
 * @returns The file's text, truncation flag and modification instant.
 */
export async function readKnowledgeFile(
  ctx: Context,
  config: Config,
  relPath: string,
): Promise<{ kind: 'text'; content: string; truncated: boolean; mtimeMs?: number } | { kind: 'binary'; size: number }> {
  relPath = resolveScopeAlias(relPath)
  const refusal = personalPathRefusal(config, relPath)
  if (refusal !== undefined) throw new KnowledgeError(refusal.reason, refusal.code)
  if (!isContainedRelPath(relPath)) {
    throw new KnowledgeError('path escapes the knowledge tree', 'not-configured')
  }
  const root = localConfig(config).mountPoint
  const full = join(root, relPath)
  const info = await stat(full)
  if (!info.isFile()) {
    throw new KnowledgeError('not a file', 'not-configured')
  }
  const raw = await readFile(full)
  // A NUL byte marks a file whose bytes are not text; rendering it as UTF-8 would
  // show a page of replacement characters instead of saying what it is.
  if (raw.includes(0)) return { kind: 'binary', size: info.size }
  const truncated = raw.byteLength > PREVIEW_MAX_BYTES
  const slice = truncated ? raw.subarray(0, PREVIEW_MAX_BYTES) : raw
  return { kind: 'text', content: slice.toString('utf8'), truncated, mtimeMs: info.mtimeMs }
}

/**
 * Read one file AFTER resolving the caller's permission for it.
 *
 * The HTTP `read` route used to rely on the caller's view hardlink alone: the file was
 * visible because a previous sync linked it, but a revoke or an unsynced view could
 * leave a readable link behind. Both the read route and the extraction path now share this
 * function, so the permission answer is DataOps' and the path boundary is still
 * enforced first.
 *
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @param relPath - path relative to the knowledge root, in view coordinates.
 * @returns The same shape `readKnowledgeFile` returns.
 * @throws KnowledgeToolError with a structured code for the model.
 */
export async function readAuthorized(
  ctx: Context,
  config: Config,
  relPath: string,
): Promise<KnowledgeFileRead> {
  relPath = resolveScopeAlias(relPath)
  const refusal = personalPathRefusal(config, relPath)
  if (refusal !== undefined) throw new KnowledgeToolError(refusal.code, refusal.reason, relPath)
  if (!isContainedRelPath(relPath)) {
    throw new KnowledgeToolError(
      'escapes-knowledge-root',
      'the path leaves the knowledge root; "..", "." and empty segments are not allowed',
      relPath,
    )
  }
  let allowed = false
  try {
    allowed = await canReadPath(ctx, config, relPath)
  } catch (error) {
    throw asKnowledgeToolError(error, relPath)
  }
  if (!allowed) {
    throw new KnowledgeToolError('forbidden', 'read access is required for this path', relPath)
  }
  try {
    return await readKnowledgeFile(ctx, config, relPath)
  } catch (error) {
    throw asKnowledgeToolError(error, relPath)
  }
}

/**
 * Read one file as raw bytes for a save-to-disk.
 *
 * Separate from {@link readKnowledgeFile}, which is shaped for the preview pane: that one
 * truncates a large text file and refuses a binary one, because the pane cannot show
 * more. A download has the opposite requirement -- the reader asked for THIS file, so it
 * is returned whole or refused with a reason, never silently shortened.
 *
 * Base64 rather than a byte array: the answer travels as JSON, and a `number[]` for a
 * megabyte file is several times the payload and slower to parse on both ends.
 * @param ctx - the plugin context.
 * @param config - resolved plugin config.
 * @param relPath - the file to read, relative to the mount point.
 * @returns The file's bytes and a suggested name, or a refusal reason.
 */
export async function readKnowledgeFileForDownload(
  ctx: Context,
  config: Config,
  relPath: string,
): Promise<{ name: string; base64: string; size: number; mime: string }> {
  relPath = resolveScopeAlias(relPath)
  const refusal = personalPathRefusal(config, relPath)
  if (refusal !== undefined) throw new KnowledgeError(refusal.reason, refusal.code)
  if (!isContainedRelPath(relPath)) {
    throw new KnowledgeError('path escapes the knowledge tree', 'not-configured')
  }
  const root = localConfig(config).mountPoint
  const full = join(root, relPath)
  const info = await stat(full)
  if (!info.isFile()) {
    throw new KnowledgeError('not a file', 'not-configured')
  }
  // A bound exists so one click cannot pull an unbounded file into the bridge; it is far
  // above any knowledge document and a refusal names the real limit.
  if (info.size > MAX_KNOWLEDGE_WRITE_BYTES) {
    throw new KnowledgeError(
      'file is too large to download through the page (' + String(info.size) + ' > '
      + String(MAX_KNOWLEDGE_WRITE_BYTES) + ' bytes)',
      'bad-response',
    )
  }
  const bytes = await readFile(full)
  const name = relPath.split('/').pop() ?? 'download'
  return { name, base64: bytes.toString('base64'), size: bytes.byteLength, mime: mimeForName(name) }
}

/**
 * The MIME type for a file name, for the browser's save dialog.
 *
 * Deliberately tiny: the download is written to disk either way, and a wrong type only
 * affects how a later open behaves. Anything unknown is `application/octet-stream`, which
 * every browser saves faithfully.
 * @param name - the file's name.
 * @returns A MIME type.
 */
function mimeForName(name: string): string {
  const dot = name.lastIndexOf('.')
  const extension = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  const known: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    csv: 'text/csv',
    html: 'text/html',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return known[extension] ?? 'application/octet-stream'
}

/** One row the permission surface offers as a principal. */
export interface PrincipalOption {
  /** Value the grant must carry: a user's UUID, or a code for every other kind. */
  id: string
  /** Human-facing name, falling back to the id when the backend sends none. */
  label: string
  /** Login name, for users only: two accounts can share a display name. */
  username?: string
  /**
   * Role codes this principal belongs to.
   *
   * Users only, and only when the directory reported it. The permission overview needs
   * this to answer "what does this PERSON have": a role grant confers access on every
   * member, so without the membership a reader whose access is entirely role-derived
   * would look like they hold nothing. Absent means the directory did not say -- which
   * the page reports as unavailable inheritance rather than as no inheritance.
   */
  roleCodes?: string[]
}

/**
 * Read the principals of one kind from the backend.
 *
 * The permission store matches a user by primary key and every other kind by
 * `code`, and there is nowhere else a valid value can come from. Reading the
 * directory here is what keeps the surface from asking an operator to transcribe
 * a UUID.
 *
 * Failures are reported as an empty list rather than thrown: the directories are
 * a convenience over a field that also accepts a typed value, so a caller whose
 * account may not read them can still grant by hand.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @param kind - principal kind to list.
 * @returns The options, in the order the backend returned them.
 */
export async function fetchPrincipals(
  ctx: Context,
  config: Config,
  kind: KnowledgeGrantRequest['principalType'],
): Promise<PrincipalOption[]> {
  const path = { user: ENDPOINTS.users, role: ENDPOINTS.roles, department: ENDPOINTS.departments, group: ENDPOINTS.groups }[kind]
  const body = await request<Record<string, unknown>>(ctx, config, path)
  // A user list nests its rows under `items`; departments nest under their own
  // name. Reading both here keeps the shape difference out of the browser.
  const rows = (body.items ?? body.departments ?? []) as Array<Record<string, unknown>>
  if (!Array.isArray(rows)) return []
  return rows
    .map((row) => {
      const code = typeof row.code === 'string' ? row.code : undefined
      const uuid = typeof row.id === 'string' ? row.id : undefined
      // Users carry an `id`; every other kind carries `code`.
      const id = kind === 'user' ? uuid : code
      if (id === undefined) return undefined
      const name = typeof row.displayName === 'string'
        ? row.displayName
        : (typeof row.name === 'string' ? row.name : (typeof row.username === 'string' ? row.username : id))
      // Users carry `roles: [{code,name}]` from DataOps' own projection; every other
      // kind has no membership to report. Read defensively: an older backend that
      // omits the field must leave it absent rather than look like "no roles".
      const roleCodes = kind === 'user' && Array.isArray(row.roles)
        ? row.roles
          .map(role => (role as Record<string, unknown>).code)
          .filter((code): code is string => typeof code === 'string' && code !== '')
        : undefined
      return {
        id,
        label: name,
        ...(kind !== 'user' || typeof row.username !== 'string' ? {} : { username: row.username }),
        ...(roleCodes === undefined ? {} : { roleCodes }),
      }
    })
    .filter((row): row is PrincipalOption => row !== undefined)
}

/** The calling user, as DataOps describes them. */
export interface KnowledgeCaller {
  /** Stable user id. Keys the caller's view directory, so it must be a safe name. */
  userId: string
  /** Human-facing name, for reporting. */
  label: string
  /** Role codes the backend reported. Kept for reporting, not for authorization. */
  roleCodes: string[]
  /**
   * DataOps department code, when the caller belongs to one.
   *
   * Read for LAYOUT only: it selects which `department/<code>/` subtree the view
   * links, and never decides whether a path may be read — {@link canReadPath}
   * stays the single authority for that. A caller with no department simply gets
   * no department bucket.
   */
  departmentCode?: string
  /** Department display name, for reporting beside the bucket. */
  departmentName?: string
  /**
   * The caller's organization path, root first, as DataOps reported it.
   *
   * Layout only, exactly like {@link departmentCode}: it decides how deep the
   * department bucket nests and never whether a path may be read. Empty when the
   * backend does not report it (an older DataOps), in which case the bucket keeps its
   * single-level shape rather than disappearing.
   */
  departmentPathCodes?: string[]
  /** The organization path's display names, index-aligned with the codes. */
  departmentPathNames?: string[]
  /**
   * DataOps permission keys resolved for the caller by `/auth/me`.
   *
   * Used by product defaults that must follow the existing permission model
   * (for example the administrator memory default). Authorization decisions
   * still go through the backend; this is the projection the plugin already
   * receives, not a second policy source.
   */
  permissions?: string[]
}

/**
 * Read a `{ code, name }` pair DataOps nests under the profile.
 *
 * The organization path arrays are read here too, but each is independent: a backend
 * that reports `code`/`name` without the arrays (every deployment today) still yields a
 * usable department, and the caller simply gets a single-level bucket. That is why the
 * two are separate fields rather than one required structure — the old shape must keep
 * working without a version check.
 *
 * A path is only used when the two arrays agree in length and the leaf matches `code`.
 * A mismatch means the profile contradicts itself, and half of a contradicting pair
 * would place documents under a folder the reader cannot recognize.
 *
 * @param value - the raw field, which is absent on older backends.
 * @returns The pair with a non-empty code plus any usable path, or undefined.
 */
export function readDepartmentOf(value: unknown): {
  code: string
  name: string
  pathCodes?: string[]
  pathNames?: string[]
} | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const code = typeof record.code === 'string' ? record.code.trim() : ''
  if (code === '') return undefined
  const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : code
  const pathCodes = readStringArray(record.pathCodes)
  const pathNames = readStringArray(record.pathNames)
  const pathUsable = pathCodes !== undefined
    && pathNames !== undefined
    && pathCodes.length === pathNames.length
    && pathCodes.length > 0
    && pathCodes[pathCodes.length - 1] === code
  return {
    code,
    name,
    ...(pathUsable ? { pathCodes, pathNames } : {}),
  }
}

/**
 * Read one string array from an untrusted field.
 *
 * A non-array, an array with a non-string member, or an array that trims down to empty
 * entries all answer undefined: a path is either fully usable or not used at all, since
 * a partially valid one would be a hierarchy with a missing level.
 * @param value - the raw field.
 * @returns The trimmed non-empty entries, or undefined.
 */
function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return undefined
    const trimmed = entry.trim()
    if (trimmed === '') return undefined
    entries.push(trimmed)
  }
  return entries.length === 0 ? undefined : entries
}

/**
 * Read the authenticated caller.
 *
 * The view directory is keyed by this id, so it is fetched from the authority
 * rather than inferred from a token or a header: the id has to be the one DataOps
 * itself will resolve grants against, or the view would be built for a different
 * identity than the grants describe.
 *
 * The role codes are read here because this is already the one call that reads the
 * profile, but they are NOT what authorizes anything: they are the role's display
 * names (measured 2026-10-16), so {@link canManageGrants} asks the enforced
 * permission point instead. They are returned so a caller can report them.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @returns The caller's id, display name and role codes.
 */

/**
 * Read one department's ancestor chain from the DataOps catalogue.
 *
 * `/auth/me` is the self-scoped answer and the one this plugin prefers, but a deployment
 * built before the chain was added to it still answers with the leaf department only.
 * The catalogue already answers with `pathCodes`/`pathNames`, and grant subjects already
 * read it, so the chain can be recovered there without asking DataOps for a new route.
 * A caller without access simply gets `undefined` and keeps the leaf-only shape, which
 * the tree renders as a code rather than pretending to know the hierarchy.
 */
async function readDepartmentPathFromCatalog(
  ctx: Context,
  config: Config,
  code: string,
): Promise<{ pathCodes: string[]; pathNames: string[] } | undefined> {
  const body = await request<Record<string, unknown>>(ctx, config, ENDPOINTS.departments)
  const rows = Array.isArray(body.departments) ? body.departments : []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as Record<string, unknown>
    if (record.code !== code) continue
    const pathCodes = readStringArray(record.pathCodes)
    const pathNames = readStringArray(record.pathNames)
    if (pathCodes === undefined || pathNames === undefined) return undefined
    if (pathCodes.length === 0 || pathCodes.length !== pathNames.length) return undefined
    return { pathCodes, pathNames }
  }
  return undefined
}

export async function fetchCaller(ctx: Context, config: Config): Promise<KnowledgeCaller> {
  // A personal deployment has no account system to ask, and its view is keyed by one fixed
  // id. Answering a synthetic caller rather than throwing is what lets `viewPathFor` and the
  // rest of the view plumbing stay a single code path: the difference between the two
  // deployments is WHERE the id comes from, not whether there is one.
  //
  // The label is deliberately the display name a reader would expect, and `roleCodes` is
  // empty because there are no roles -- a surface that renders role names must not invent
  // one for a deployment that has none.
  if (!isTeamDeployment(config)) {
    return { userId: LOCAL_USER_ID, label: '本地用户', roleCodes: [], permissions: [] }
  }
  const body = await request<Record<string, unknown>>(ctx, config, ENDPOINTS.me)
  // The route answers `{ user: {...} }`, not the profile at the top level. Read
  // both so a change in nesting shows up as a missing id rather than as a view
  // keyed by the literal string "undefined".
  const profile = (body.user ?? body) as Record<string, unknown>
  const userId = typeof profile.id === 'string' ? profile.id : ''
  if (userId === '') {
    throw new KnowledgeError('DataOps did not report the caller id', 'not-configured')
  }
  const label = typeof profile.displayName === 'string'
    ? profile.displayName
    : (typeof profile.username === 'string' ? profile.username : userId)
  const roleCodes = Array.isArray(profile.roles)
    ? profile.roles
      .map(role => (role as Record<string, unknown>).code)
      .filter((code): code is string => typeof code === 'string' && code !== '')
    : []
  // `/auth/me` carries the caller's resolved permission keys. Product defaults
  // that must follow the existing principal model (the administrator memory
  // default) read this list instead of hard-coding role names.
  const permissions = Array.isArray(profile.permissions)
    ? profile.permissions.filter((key): key is string => typeof key === 'string' && key !== '')
    : []
  let department = readDepartmentOf(profile.department)
  // Older deployments answer /auth/me with the leaf department only. Recover the chain
  // from the catalogue this plugin already reads for grant subjects, so the department
  // tree can still name the hierarchy instead of showing slugs.
  if (department !== undefined && department.pathCodes === undefined) {
    const recovered = await readDepartmentPathFromCatalog(ctx, config, department.code)
      .catch(() => undefined)
    if (recovered !== undefined && recovered.pathCodes[recovered.pathCodes.length - 1] === department.code) {
      department = { ...department, ...recovered }
    }
  }
  return {
    userId,
    label,
    roleCodes,
    permissions,
    ...(department === undefined
      ? {}
      : {
        departmentCode: department.code,
        departmentName: department.name,
        ...(department.pathCodes === undefined ? {} : { departmentPathCodes: department.pathCodes }),
        ...(department.pathNames === undefined ? {} : { departmentPathNames: department.pathNames }),
      }),
  }
}

/**
 * Ask DataOps whether the CALLER may read one path.
 *
 * The decision is the backend's, not this plugin's: the route is self-scoped, so
 * the answer is about the credential's own user and this function cannot be used
 * to ask about anyone else. That is what keeps a per-user view from becoming a
 * second permission implementation.
 *
 * A failed request answers `false` rather than throwing, so one unreadable path
 * cannot leave a view half-built. An unreachable backend therefore produces an
 * empty view instead of a wrong one.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @param relPath - path relative to the authoritative root.
 * @returns Whether the caller may read it.
 */
/**
 * The root resource id one knowledge-base-wide grant is stored under.
 *
 * A grant needs a non-empty `resourceId` (DataOps rejects an empty one with
 * "资源ID不能为空"), so "the whole knowledge base" is named explicitly rather than by an
 * empty string. A document can never have this id, because document ids come from titles
 * and never start with `@`.
 */
export const KB_ROOT_RESOURCE_ID = '@kb-root'

/**
 * The ancestor chain for one knowledge path, nearest parent first.
 *
 * DataOps resolves a permission by matching the resource's own id OR any ancestor named
 * here, so passing this chain is what turns "grant the knowledge base once" into "every
 * document inside it inherits that grant". Without it each file needs its own row, which
 * is why a freshly created document used to look unreadable to an administrator.
 *
 * The chain walks the path's parents (`a/b/c.md` → `a/b` → `a`) and ends at the root id,
 * so a grant on any level applies to everything beneath it and the most specific level
 * still wins for a deny.
 * @param relPath - the path being authorised; empty or the root id stands for the root.
 * @returns Ancestor references, nearest first, root last.
 */
export function knowledgeAncestorsFor(relPath: string): Array<{ resourceType: string; resourceId: string }> {
  const ancestors: Array<{ resourceType: string; resourceId: string }> = []
  const trimmed = relPath.trim()
  const normalized = trimmed === '' ? KB_ROOT_RESOURCE_ID : trimmed
  // Walk up the directories this path lives in, without including the path itself: the
  // path is already the resource being resolved.
  const segments = normalized.split('/').filter((segment) => segment !== '')
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    ancestors.push({ resourceType: KB_RESOURCE_TYPE, resourceId: segments.slice(0, depth).join('/') })
  }
  ancestors.push({ resourceType: KB_RESOURCE_TYPE, resourceId: KB_ROOT_RESOURCE_ID })
  return ancestors
}

export async function canReadPath(ctx: Context, config: Config, relPath: string): Promise<boolean> {
  relPath = resolveScopeAlias(relPath)
  // A personal deployment has nobody to ask: there is one operator and the path boundary is
  // the knowledge root. That boundary is still enforced -- `checkLocalPath` refuses anything
  // that climbs out -- so "allowed" here means "inside the tree", never "anything goes".
  if (!isTeamDeployment(config)) return checkLocalPath(relPath) === undefined
  try {
    // The page reads in VIEW coordinates (`personal/<file>`), while grants are written
    // against the owner-scoped path (`personal/<userId>/<file>`). Ask DataOps about the
    // owner-scoped spelling so a directory grant covers the caller's own documents and
    // a foreign path still reaches the resolver unchanged and is refused there.
    let permissionPath = relPath
    if (relPath.startsWith('personal/')) {
      const who = await fetchCaller(ctx, config).catch(() => undefined)
      if (who !== undefined && isSafeUserId(who.userId)) {
        permissionPath = normalizePersonalWritePath(relPath, who.userId)
      }
    }
    const body = await request<{ canRead?: boolean }>(ctx, config, ENDPOINTS.resolve, {
      method: 'POST',
      body: {
        resourceType: KB_RESOURCE_TYPE,
        resourceId: permissionPath,
        // The ancestors chain is what makes ONE grant cover a whole knowledge base.
        // Without it DataOps matches only an exact resourceId, so every document needs
        // its own grant -- which is not a permission model anybody wants and was the
        // reason a new document appeared unreadable to an administrator.
        ancestors: knowledgeAncestorsFor(permissionPath),
      },
    })
    return body.canRead === true
  } catch {
    return false
  }
}

/**
 * Ask DataOps whether the CALLER may write one path.
 *
 * The same self-scoped resolve route {@link canReadPath} uses, read for a different
 * field. A move needs this and not merely read: it destroys the source path, so a
 * caller who can only read must not be able to relocate a document out from under
 * the people who own it. The backend distinguishes the two (`canRead` and
 * `canWrite` are separate conclusions drawn from the same grants), and this reads
 * its answer rather than re-deriving one from the other.
 *
 * A failed request answers `false` rather than throwing, so an unreachable backend
 * refuses the move instead of authorizing it.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @param relPath - path relative to the authoritative root.
 * @returns Whether the caller may write it.
 */
export async function canWritePath(ctx: Context, config: Config, relPath: string): Promise<boolean> {
  relPath = resolveScopeAlias(relPath)
  // Same boundary as reads, and for the same reason: a personal deployment has no grants to
  // consult, but a path outside the knowledge root is still refused rather than written.
  if (!isTeamDeployment(config)) return checkLocalPath(relPath) === undefined
  try {
    let permissionPath = relPath
    if (relPath.startsWith('personal/')) {
      const who = await fetchCaller(ctx, config).catch(() => undefined)
      if (who !== undefined && isSafeUserId(who.userId)) {
        permissionPath = normalizePersonalWritePath(relPath, who.userId)
      }
    }
    const body = await request<{ canWrite?: boolean }>(ctx, config, ENDPOINTS.resolve, {
      method: 'POST',
      body: {
        resourceType: KB_RESOURCE_TYPE,
        resourceId: permissionPath,
        ancestors: knowledgeAncestorsFor(permissionPath),
      },
    })
    return body.canWrite === true
  } catch {
    return false
  }
}

/**
 * Largest document the create and upload routes will write.
 *
 * A knowledge document is text a person reads, not a data dump, and the route
 * buffers the body in memory before writing it. The ceiling is what keeps one
 * request from taking the Host's heap: without it a caller with write access could
 * post an arbitrarily large body, because nothing downstream limits the size of a
 * file on the share.
 */
// Raised from 1 MiB to 100 MiB on request: real documents (PDFs, Office files) routinely
export const MAX_KNOWLEDGE_WRITE_BYTES = 500 * 1024 * 1024

/**
 * How long the template list may take before the surface gives up.
 *
 * Shorter than the plugin's general timeout on purpose: a template list decorates a
 * page, and the shared backend can be busy with unrelated work for far longer than
 * a reader should wait to see some cards.
 */
export const TEMPLATE_READ_TIMEOUT_MS = 5_000

/**
 * The path whose write permission gates template maintenance.
 *
 * A template is shared content, so curating one is a write to the knowledge base like
 * any other and is asked of DataOps at this path. It names the library's own directory
 * because that is what the operation modifies.
 */
const TEMPLATE_WRITE_PATH = '.kb-templates'

/**
 * A refusal from the write path, with a code the route maps to a status.
 *
 * Kept apart from {@link KnowledgeError}, whose codes describe how a TRANSPORT
 * call ended. These say why a write was not performed, which is a different
 * question with different statuses: a name already taken is a conflict, a path
 * outside the root is a bad request, and a document over the ceiling is too large.
 */
export class KnowledgeWriteError extends Error {
  readonly code: 'bad-path' | 'exists' | 'too-large' | 'write-failed'

  constructor(message: string, code: KnowledgeWriteError['code'], options?: ErrorOptions) {
    super(message, options)
    this.name = 'KnowledgeWriteError'
    this.code = code
  }
}

/**
 * Create one document or directory in the authoritative tree.
 *
 * The path is written under `actualRoot` rather than under the caller's own view
 * directory, and that choice is the whole design:
 *
 * - The view is NOT storage. `syncView` mirrors the resolved grant set onto it, so
 *   a file that appears there is removed by the next sync unless DataOps resolves
 *   it as readable. Measured: a document written into a view was gone after the
 *   next `syncView` (`delta.unlinked` named it). Writing there would hand the
 *   reader a document that any later permission change silently deletes.
 * - `actual/` is the authoritative tree, so a document written there survives, and
 *   the grant system then decides who sees it. Creating is therefore SHARED by
 *   construction: the creator needs write access, and everyone DataOps resolves as
 *   a reader will find the document in their view at their next sync. That is what
 *   a knowledge base is for, and it is the semantic the product already has.
 *
 * There is deliberately no `userId` component in the path. `actual/` is shared and
 * has no per-user dimension; inventing `actual/<uid>/...` would create a shape the
 * rest of the plugin does not understand, because a view is built from grants and
 * not from a directory per user.
 *
 * The write is exclusive (`wx`), so the kernel refuses to replace an existing file.
 * A stat-then-write would leave a window in which another caller's document could
 * be overwritten, and the check would still be the thing that was raced.
 * @param config - resolved plugin config.
 * @param relPath - destination, relative to the authoritative root.
 * @param options - `directory` creates a directory; `content` is the file body.
 * @returns The path written.
 * @throws KnowledgeError when the path escapes the root, exists, or cannot be written.
 */
export async function createKnowledgeEntry(
  config: Config,
  relPath: string,
  options: {
    directory: boolean
    content?: string
    bytes?: Uint8Array
    /**
     * The ceiling this write is checked against.
     *
     * Defaults to {@link MAX_KNOWLEDGE_WRITE_BYTES}. It is injectable ONLY so a test can
     * verify the boundary with a small body: the production ceiling is a product decision
     * that has already moved (1 MiB → 500 MiB), and building a payload at the current
     * ceiling costs seconds of string work. A test that has to allocate the limit is
     * measuring the machine's memory bandwidth, not the check.
     */
    limitBytes?: number
  },
): Promise<{ relPath: string; kind: 'file' | 'directory' }> {
  relPath = resolveScopeAlias(relPath)
  const plan = localConfig(config)
  if (!isContainedRelPath(relPath)) {
    throw new KnowledgeWriteError('path escapes the knowledge root: ' + JSON.stringify(relPath), 'bad-path')
  }
  const full = join(plan.actualRoot, relPath)
  if (options.directory) {
    try {
      // The parent has to exist first, and in the nested department layout the target
      // is several levels deep (`department/<ancestor>/.../<own>/new-folder`). Without
      // this, creating a folder inside a hierarchy that has no documents yet failed
      // with a bare ENOENT, which read as a bug rather than as "the parent is missing".
      //
      // Only the PARENT is created with `recursive`; the leaf keeps `recursive: false`
      // so an existing folder is still reported as EEXIST instead of being silently
      // accepted. That distinction is what lets the dialog say "this name is taken".
      await mkdir(dirname(full), { recursive: true })
      await mkdir(full, { recursive: false })
    } catch (cause) {
      const code = (cause as { code?: string }).code
      if (code === 'EEXIST') {
        throw new KnowledgeWriteError('a document or folder already exists at ' + relPath, 'exists', { cause })
      }
      throw new KnowledgeWriteError('could not create ' + relPath, 'write-failed', { cause })
    }
    markInternalMutation(relPath)
    return { relPath, kind: 'directory' }
  }
  // A binary upload arrives as bytes and is written verbatim: decoding it as
  // UTF-8 first would replace every non-text byte and produce a file no reader
  // can open. Text uploads keep the string path so the limit is measured on the
  // encoded form rather than on a guess.
  const bytes = options.bytes
  const body = options.content ?? ''
  const payload: string | Uint8Array = bytes ?? body
  const payloadBytes = bytes === undefined
    ? Buffer.byteLength(body, 'utf8')
    : bytes.byteLength
  const limitBytes = options.limitBytes ?? MAX_KNOWLEDGE_WRITE_BYTES
  if (payloadBytes > limitBytes) {
    throw new KnowledgeWriteError('document exceeds the ' + String(limitBytes) + ' byte limit', 'too-large')
  }
  // The parent must exist and be inside the root: `wx` alone would otherwise let
  // `a/b/c.md` fail with a bare ENOENT that reads like a bug rather than a choice.
  try {
    await mkdir(dirname(full), { recursive: true })
  } catch {
    // Left to the write below, which reports the real reason.
  }
  try {
    // `wx` is the atomic "create, never replace": the kernel answers EEXIST when the
    // name is taken, so two concurrent creates cannot both believe they won.
    await writeFile(full, payload, bytes === undefined ? { encoding: 'utf8', flag: 'wx' } : { flag: 'wx' })
  } catch (cause) {
    const code = (cause as { code?: string }).code
    if (code === 'EEXIST') {
      throw new KnowledgeWriteError('a document or folder already exists at ' + relPath, 'exists', { cause })
    }
    throw new KnowledgeWriteError('could not write ' + relPath, 'write-failed', { cause })
  }
  markInternalMutation(relPath)
  return { relPath, kind: 'file' }
}

/**
 * Extract an uploaded document's text into a `.md` sibling.
 *
 * Called after the original is written, never before: the bytes the user chose
 * are the deliverable, and an extraction that fails must not take them down with
 * it. The sibling keeps the original extension in its name (`报告.docx.md`), so it
 * cannot collide with a handwritten `报告.md` and a reader can still tell which
 * document it came from.
 *
 * @param config - resolved plugin config, for the knowledge root and MinerU port.
 * @param relPath - the uploaded document's path, relative to the knowledge root.
 * @param mineruUrl - the caller's own stored address, when they have one.
 * @param readSharedUrl - reads the deployment's shared address. Called only when the caller
 *   has none of their own, so a deployment without the OCR plugin pays nothing.
 * @returns What happened, or undefined when the format needs no extraction.
 */
/**
 * Resolve a view-relative path to the authoritative path.
 *
 * The agent sees `/workspace/kb` = `views/<uid>`; personal files are flattened from
 * `actual/personal/<uid>/...`, and a department view may carry the organization chain.
 * Extraction and indexing must open the actual file, not the view alias, or MinerU gets
 * `no such document`.
 */
export async function actualRelPathForView(
  ctx: Context,
  config: Config,
  relPath: string,
  caller?: KnowledgeCaller,
): Promise<string> {
  if (!isTeamDeployment(config)) return relPath
  const who = caller ?? await fetchCaller(ctx, config)
  const plan = localConfig(config)
  const clean = relPath.replace(/^\/+/, '')
  const viewFile = join(plan.viewRoot, who.userId, clean)
  let viewInfo: Awaited<ReturnType<typeof stat>> | undefined
  try { viewInfo = await stat(viewFile) } catch { viewInfo = undefined }

  // No string reshaping of `global/…`: actual/global is a real directory, and a
  // view's global bucket can hardlink a source at the actual top level. Only paths
  // whose inode matches the view file are accepted below.
  const candidates: string[] = [clean]
  if (clean.startsWith('personal/')) {
    const rest = clean.slice('personal/'.length)
    if (!rest.startsWith(who.userId + '/') && rest !== who.userId) {
      candidates.push(`personal/${who.userId}/${rest}`)
    }
  }
  if (clean.startsWith('department/')) {
    const rest = clean.slice('department/'.length)
    const pathCodes = who.departmentPathCodes ?? (who.departmentCode === undefined ? [] : [who.departmentCode])
    if (pathCodes.length > 0) candidates.push(`department/${pathCodes.join('/')}/${rest}`)
    if (who.departmentCode !== undefined) candidates.push(`department/${who.departmentCode}/${rest}`)
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      const info = await stat(join(plan.actualRoot, candidate))
      // The view is built from hardlinks, so the inode is the authoritative
      // identity when both names exist; a same-named file in actual/global is not
      // necessarily the source of the view's global bucket.
      if (viewInfo === undefined || info.ino === viewInfo.ino) return candidate
    } catch {
      // Try the next shape.
    }
  }

  // Last resort: find the authoritative hardlink by inode. This is what handles a
  // `global/` view prefix whose source sits at the actual top level (for example
  // actual/dual-mode-verify/... shown as global/dual-mode-verify/...).
  if (viewInfo !== undefined) {
    const walk = async (dir: string, prefix: string): Promise<string | undefined> => {
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { return undefined }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const rel = prefix === '' ? entry.name : prefix + '/' + entry.name
        const absolute = join(dir, entry.name)
        if (entry.isDirectory()) {
          const found = await walk(absolute, rel)
          if (found !== undefined) return found
          continue
        }
        if (!entry.isFile()) continue
        try {
          const info = await stat(absolute)
          if (info.ino === viewInfo.ino && info.size === viewInfo.size) return rel
        } catch {
          // A file removed during the walk is absent from this pass.
        }
      }
      return undefined
    }
    const found = await walk(plan.actualRoot, '')
    if (found !== undefined) return found
  }
  return relPath
}

/** Outcome of importing a file that exists only in a caller's view. */
export interface ViewAdoptionResult {
  /** Whether the bytes now live at an authoritative path. */
  adopted: boolean
  /** The authoritative path, relative to `actualRoot`, when adopted. */
  actualRelPath?: string
  /** Why the file was not adopted. */
  reason?: string
}

/**
 * Import one view-only file into the authoritative tree.
 *
 * A view is a hardlink mirror of `actualRoot`; a new file placed in it by a shell
 * `cp` (or an editor's save-as) has no authoritative counterpart. The view sync
 * treats such a file as an orphan and unlinks it, which deletes the only copy the
 * reader has. This function is the alternative: copy the bytes to the authoritative
 * path the view path maps to, then replace the view entry with a hardlink to that
 * copy. The next sync then sees one file, DataOps keeps resolving it, and extraction
 * and indexing have a real document to work on.
 *
 * Refuses without a write grant, without a non-empty path, or when a DIFFERENT
 * authoritative file already owns the destination name — importing must never
 * overwrite a document.
 *
 * @param host - Host context, for the caller and the write grant.
 * @param config - resolved plugin config.
 * @param relPath - the view-relative path (as the reader sees it).
 * @param options - caller and the already-resolved view file, when known.
 * @returns whether the import happened, and where.
 */
export async function adoptViewFile(
  host: Context,
  config: Config,
  relPath: string,
  options: { caller?: { userId: string }; fullPath?: string } = {},
): Promise<ViewAdoptionResult> {
  if (!isTeamDeployment(config)) return { adopted: false, reason: 'a personal deployment has no view tree' }
  const clean = relPath.replace(/^\/+/u, '')
  if (!isContainedRelPath(clean)) return { adopted: false, reason: 'the path escapes the knowledge root' }
  if (clean.split('/').some(segment => segment.startsWith('.'))) {
    return { adopted: false, reason: 'a hidden path is not a document' }
  }
  const plan = localConfig(config)
  const who = options.caller ?? await fetchCaller(host, config)
  if (!isSafeUserId(who.userId)) return { adopted: false, reason: 'unsafe caller id; cannot import into a view keyed by it' }
  const viewFile = options.fullPath ?? join(plan.viewRoot, who.userId, clean)
  const info = await stat(viewFile).catch(() => undefined)
  if (info === undefined || !info.isFile()) return { adopted: false, reason: 'no such file in the view' }
  if (!await canWritePath(host, config, clean)) {
    return { adopted: false, reason: 'write access is required to import this file' }
  }
  const actualRelPath = toolScopedActualPath(clean, who.userId, true)
  if (!isContainedRelPath(actualRelPath)) return { adopted: false, reason: 'the path escapes the knowledge root' }
  const destination = join(plan.actualRoot, actualRelPath)
  const existing = await stat(destination).catch(() => undefined)
  if (existing !== undefined) {
    if (existing.ino === info.ino) return { adopted: true, actualRelPath }
    // A different authoritative file owns this name. Importing would overwrite a
    // document the caller may not even have read, so the view entry stays an orphan.
    return { adopted: false, reason: 'an authoritative file already exists at this path' }
  }
  try {
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(viewFile, destination, fsConstants.COPYFILE_EXCL)
  } catch (error) {
    return { adopted: false, reason: describeError(error).message }
  }
  // The plugin wrote this path, so the external-change watcher must not report it as
  // somebody else's edit: the import is already covered by the caller's write.
  markInternalMutation(actualRelPath)
  // Replace the view entry with a hardlink to the authoritative copy. Without this
  // the view keeps a second inode under a name the lock step already linked, and the
  // next sync would leave the shadow copy in place of the real document.
  const scratch = `${viewFile}.adopt-${randomUUID().slice(0, 8)}`
  try {
    await link(destination, scratch)
    await rename(scratch, viewFile)
  } catch {
    // The authoritative copy is the durable part; the next sync links the view path.
    await unlink(scratch).catch(() => undefined)
  }
  return { adopted: true, actualRelPath }
}

/**
 * The canonical VIEW path a model-facing file-tool path names.
 *
 * The `kb_file_*` tools speak view coordinates (`global/…`, `department/…`,
 * `personal/…` or a bare path). A bare path has no bucket, and the old code left
 * it untouched: `createKnowledgeEntry` then wrote it at the authoritative top
 * level, which the view renders as `global/…` because {@link bucketOf} treats an
 * unknown head as global. That is how a personal memory write silently became a
 * global document.
 *
 * On a team deployment a bare path belongs to the caller's PERSONAL bucket — the
 * only bucket one caller owns — so it is spelled `personal/<path>`. Explicit
 * scope spellings, including the localized aliases, are already canonical after
 * {@link resolveScopeAlias} and are returned unchanged. A local deployment keeps
 * the legacy flat tree, where there are no buckets, so nothing is prefixed.
 *
 * @param relPath - model-supplied path, already validated/alias-resolved or not.
 * @param team - `isTeamDeployment(config)`; false keeps the flat local layout.
 */
export function toolScopedViewPath(relPath: string, team: boolean): string {
  const canonical = resolveScopeAlias(relPath)
  if (!team || canonical === '') return canonical
  const head = canonical.split('/')[0] ?? ''
  return scopeFromAlias(head) === undefined ? `personal/${canonical}` : canonical
}

/**
 * The AUTHORITATIVE path a model-facing file-tool path names.
 *
 * A view drops the personal owner segment (`personal/note.md`), but the actual
 * tree keeps it (`personal/<uid>/note.md`). Writes, overwrites and existence
 * checks must use this form; reads/listings stay in view coordinates and use the
 * view root. Global and department paths are unchanged: their view and actual
 * spellings are already identical (or handled by their own layout rules).
 *
 * A path that already carries the caller's own id is returned untouched, so the
 * resolver is idempotent and graph tools (which pass actual paths) are safe.
 *
 * @param relPath - model-supplied path (view or already-actual).
 * @param userId - the caller whose personal tree owns a bare/personal path.
 * @param team - `isTeamDeployment(config)`; false keeps the flat local layout.
 */
export function toolScopedActualPath(relPath: string, userId: string, team: boolean): string {
  const viewPath = toolScopedViewPath(relPath, team)
  if (!team || viewPath === '' || viewPath === 'personal' || !viewPath.startsWith('personal/')) return viewPath
  const rest = viewPath.slice('personal/'.length)
  if (rest === userId || rest.startsWith(`${userId}/`)) return viewPath
  return `personal/${userId}/${rest}`
}

/** The caller's usable department chain, falling back to the leaf code. */
function callerDepartmentCodes(caller: KnowledgeCaller): readonly string[] {
  if (caller.departmentPathCodes !== undefined && caller.departmentPathCodes.length > 0) {
    return caller.departmentPathCodes
  }
  return caller.departmentCode === undefined || caller.departmentCode === ''
    ? []
    : [caller.departmentCode]
}

/**
 * Resolve the three knowledge-graph scope roots for one caller.
 *
 * `actualRelPathForView` is the authority for a FILE: it matches a view entry to its
 * source by inode. A scope directory has no view hardlink (directories cannot be hard
 * linked), so for `department/知识图谱` and `personal/知识图谱` it answers the view
 * spelling. The caller's own owner/chain segment therefore has to be composed here,
 * exactly as {@link bucketOf} composes it for the view: the personal root is
 * `personal/<uid>/知识图谱`, and the department root is
 * `department/<chain>/知识图谱` (legacy flat: `department/<code>/知识图谱`).
 *
 * The department view prefix is not always `department/知识图谱`: with an organization
 * path the view mirrors the chain, so the graph's view path carries it too. Choosing
 * the wrong one made every department document link point at a folder the view never
 * creates. The layout is picked from what exists on disk, with a legacy flat fallback.
 */
/**
 * Load every `.graphs/<id>/graph.json` graph under the caller's scope roots and
 * project it into the graph tab's domain shape.
 *
 * The graph route and the Host-side `kg_*` tools share this one loader so the
 * browser and the tools cannot disagree about which graphs exist. A graph folder
 * the Host denies is skipped before its manifest is read: a denied name is still
 * a disclosure. An absent `.graphs/` is normal, not an error.
 */
interface GraphJsonScopeSet {
  root: KnowledgeGraphScopeRoot
  graphs: LoadedGraph[]
}

/**
 * Load every `.graphs/<id>/graph.json` graph under the caller's scope roots.
 *
 * One loader serves the graph tab, the `kg_*` tools and the memory runtime, so
 * the three cannot disagree about which graphs exist. A graph folder the Host
 * denies is skipped before its manifest is read; an absent `.graphs/` is normal.
 */
async function loadGraphJsonScopeSets(
  host: Context,
  config: Config,
  roots: readonly KnowledgeGraphScopeRoot[],
  personalUserId?: string,
): Promise<GraphJsonScopeSet[]> {
  const sets: GraphJsonScopeSet[] = []
  // `root.actualPath` is relative to the knowledge root (that is what the
  // scanner reports and what the browser must never see); the loader needs the
  // absolute scope root, and the permission check needs the relative path.
  const actualRoot = localConfig(config).actualRoot
  for (const root of roots) {
    const actualRelBase = graphScopeBase(root.actualPath)
    const loadRoot = join(actualRoot, actualRelBase)
    if (root.key === 'personal' && personalUserId !== undefined) {
      // The graph tab is a catalogue of manifests; a user who never subscribed
      // has no personal graph, which reads as a missing feature. Create the
      // empty private manifest once so the tree always has a memory home.
      await ensurePersonalMemoryGraph({ scopeRoot: loadRoot, userId: personalUserId }).catch(() => undefined)
    }
    try {
      const summaries = await listGraphs(loadRoot)
      const graphs: LoadedGraph[] = []
      for (const summary of summaries) {
        if (!await canReadPath(host, config, [actualRelBase, '.graphs', summary.id].join('/'))) continue
        graphs.push(await loadGraph(loadRoot, summary.id))
      }
      if (graphs.length > 0) sets.push({ root, graphs })
    } catch {
      // No `.graphs/` under this scope (or an unreadable manifest) is not an
      // error: the legacy tree still answers.
    }
  }
  return sets
}

async function projectGraphJsonScopes(
  host: Context,
  config: Config,
  roots: readonly KnowledgeGraphScopeRoot[],
  personalUserId?: string,
): Promise<Partial<Record<KnowledgeGraphScopeKey, ProjectedGraphJsonNode[]>>> {
  const projectedByScope: Partial<Record<KnowledgeGraphScopeKey, ProjectedGraphJsonNode[]>> = {}
  for (const { root, graphs } of await loadGraphJsonScopeSets(host, config, roots, personalUserId)) {
    projectedByScope[root.key] = projectGraphJsonScope({
      key: root.key,
      viewBase: graphScopeBase(root.viewPath),
      actualBase: graphScopeBase(root.actualPath),
      groupKey: root.groupKey,
      groupLabel: root.groupLabel,
      graphs,
    })
  }
  return projectedByScope
}

export async function knowledgeGraphScopeRoots(
  host: Context,
  config: Config,
  caller: KnowledgeCaller,
): Promise<KnowledgeGraphScopeRoot[]> {
  const graphViewPath = (scope: 'global' | 'department' | 'personal'): string =>
    scope + '/' + KNOWLEDGE_GRAPH_FOLDER
  const plan = localConfig(config)
  const isDirectory = async (relPath: string): Promise<boolean> =>
    stat(join(plan.actualRoot, relPath)).then(info => info.isDirectory()).catch(() => false)

  const personalRoot = async (): Promise<string> => {
    const viewPath = graphViewPath('personal')
    const resolved = await actualRelPathForView(host, config, viewPath, caller).catch(() => viewPath)
    const prefix = 'personal/' + caller.userId + '/'
    return resolved.startsWith(prefix) ? resolved : prefix + KNOWLEDGE_GRAPH_FOLDER
  }

  /**
   * The department root and the view prefix its documents actually land under.
   *
   * Two layouts coexist. With an organization path the view mirrors the caller's
   * chain (`department/D1/D2/知识图谱/...`), so the graph's view path must carry
   * the same chain or its document links would point at a folder the view never
   * creates. A legacy flat graph (`department/OWN/知识图谱`) is linked at the
   * bucket root instead (`department/知识图谱/...`). Pick by what exists on disk;
   * when neither exists keep the nested shape so an empty tree still has the right
   * spelling.
   */
  const departmentRoot = async (): Promise<{ actualPath: string; viewPath: string } | undefined> => {
    const codes = callerDepartmentCodes(caller)
    if (codes.length === 0) return undefined
    const hasPath = caller.departmentPathCodes !== undefined && caller.departmentPathCodes.length > 0
    const chainActual = 'department/' + codes.join('/') + '/' + KNOWLEDGE_GRAPH_FOLDER
    const flatActual = 'department/' + codes[codes.length - 1] + '/' + KNOWLEDGE_GRAPH_FOLDER
    if (await isDirectory(chainActual)) {
      // `bucketOf` mirrors the chain only when the backend reported one; with only a
      // leaf code the department bucket keeps its legacy one-level spelling.
      return { actualPath: chainActual, viewPath: hasPath ? chainActual : graphViewPath('department') }
    }
    if (await isDirectory(flatActual)) {
      return { actualPath: flatActual, viewPath: graphViewPath('department') }
    }
    return { actualPath: chainActual, viewPath: hasPath ? chainActual : graphViewPath('department') }
  }

  const roots: KnowledgeGraphScopeRoot[] = []
  const globalViewPath = graphViewPath('global')
  const globalRoot = await actualRelPathForView(host, config, globalViewPath, caller).catch(() => globalViewPath)
  roots.push({ key: 'global', actualPath: globalRoot, viewPath: globalViewPath, groupKey: '', groupLabel: '' })

  const department = await departmentRoot()
  if (department !== undefined) {
    const codes = callerDepartmentCodes(caller)
    roots.push({
      key: 'department',
      actualPath: department.actualPath,
      viewPath: department.viewPath,
      groupKey: codes.join('/'),
      groupLabel: (caller.departmentPathNames ?? []).join(' / ') || caller.departmentName || codes.join(' / '),
    })
  }

  roots.push({ key: 'personal', actualPath: await personalRoot(), viewPath: graphViewPath('personal'), groupKey: '', groupLabel: '' })
  return roots
}

export async function extractBeside(
  config: Config,
  relPath: string,
  mineruUrl?: string,
  readSharedUrl?: () => Promise<string | undefined>,
  ctx?: Context,
): Promise<{ markdown: string; via?: string; reason?: string; blocks?: MineruBlock[] } | undefined> {
  if (!isExtractable(relPath)) return undefined
  const plan = localConfig(config)
  const actualRelPath = ctx === undefined ? relPath : await actualRelPathForView(ctx, config, relPath)
  const fullPath = join(plan.actualRoot, actualRelPath)
  // Three inputs in precedence order, and the caller's own choice comes first: an address
  // they typed outranks both the deployment's shared value and the port derivation.
  //
  // The shared value is read lazily, so a caller who configured their own address never
  // causes a backend round trip, and a deployment without the OCR plugin never calls one.
  const sharedUrl = mineruUrl !== undefined && mineruUrl !== ''
    ? undefined
    : await readSharedUrl?.().catch(() => undefined)
  const effectiveUrl = mineruUrl !== undefined && mineruUrl !== ''
    ? mineruUrl
    : mineruUrlFor(config, sharedUrl)
  const result = await extractDocument(fullPath, actualRelPath, { mineruUrl: effectiveUrl })
  if (result.markdown === undefined) {
    return { markdown: '', reason: result.reason ?? 'extraction produced no text' }
  }
  const sibling = markdownSiblingOf(actualRelPath)
  try {
    await createKnowledgeEntry(config, sibling, { directory: false, content: result.markdown })
  } catch (cause) {
    // A refusal here (already exists, size) is reported without failing the upload.
    return { markdown: sibling, reason: describeError(cause).message }
  }
  return {
    markdown: markdownSiblingOf(relPath),
    via: result.via ?? 'unknown',
    ...(result.blocks === undefined ? {} : { blocks: result.blocks }),
  }
}

/**
 * Translate {@link extractBeside}'s answer into a queue terminal state.
 *
 * The extractor reports three different outcomes through two fields, and they mean
 * different things to a reader deciding what to do next:
 *
 * - `markdown` set, no `reason` — the sibling was written (`succeeded`).
 * - `markdown` set WITH a `reason` — the text was produced but writing the sibling was
 *   refused, typically because it already exists. The reason is kept so a retry can
 *   report why nothing changed (`failed`, with the refusal verbatim).
 * - `markdown` empty, `reason` set — no authority could read the document; this is the
 *   `no-extractor-succeeded: …` case a reader retries after an upgrade.
 *
 * An `undefined` answer means the format has no extractor at all, which the queue
 * normally prevents by asking `isExtractable` first; it is mapped for the caller that
 * bypassed that gate rather than left to throw.
 *
 * @param outcome - what {@link extractBeside} returned.
 * @returns the state the queue records.
 */
export function extractionOutcomeOf(
  outcome: { markdown: string; via?: string; reason?: string } | undefined,
): ExtractionOutcome {
  if (outcome === undefined) {
    return { state: 'unsupported', reason: 'this file type has no extractor' }
  }
  if (outcome.markdown !== '' && outcome.reason === undefined) {
    return {
      state: 'succeeded',
      markdown: outcome.markdown,
      ...(outcome.via === undefined ? {} : { via: outcome.via }),
    }
  }
  return {
    state: 'failed',
    ...(outcome.markdown === '' ? {} : { markdown: outcome.markdown }),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  }
}

/**
 * Where the MinerU address this deployment uses came from.
 *
 * The settings page says which of the three applies, so a reader never mistakes a shared
 * value for their own: the caption under the field is the only thing distinguishing "you
 * typed this" from "your administrator set this" from "this deployment derives it".
 */
export type MineruUrlSource = 'own' | 'shared' | 'derived'

/** The effective MinerU address and where it came from. */
export interface MineruUrlResolution {
  /** The address to call, or undefined when nothing is configured. */
  readonly url: string | undefined
  /** Which input produced {@link url}. */
  readonly source: MineruUrlSource | undefined
}

/**
 * Resolve MinerU's base URL for this deployment, in the documented precedence order.
 *
 * Three inputs, and the order is the whole point:
 *
 * 1. **The caller's own stored address.** It is a deliberate choice, so nothing overrides it.
 * 2. **The shared address the 「文档识别」 plugin's administrator configured.** One value for
 *    the whole deployment; the reason a member never has to know MinerU exists.
 * 3. **The address this deployment derives from its configured port.** Only ever
 *    `127.0.0.1:<port>`, which is why it is last: it can name nothing but this machine.
 *
 * The shared value is READ, never written. This plugin has no business persisting another
 * plugin's setting, and a copy written back into `.kb-settings.json` would become a second
 * source of truth that silently stops following the administrator's later change.
 *
 * @param config - resolved plugin config.
 * @param sharedUrl - the deployment's shared address, when the caller has none of their own.
 * @returns the effective address and its origin.
 */
export function resolveMineruUrl(
  config: Config,
  sharedUrl?: string,
): MineruUrlResolution {
  // An explicit address wins over everything. It is the only way to reach a service that is
  // not on this machine, and it is the caller's own decision.
  const configured = normalizeMineruBaseUrl((config as { mineruBaseUrl?: string }).mineruBaseUrl)
  if (configured !== '') return { url: configured, source: 'own' }
  // The shared value is normalised here as well: it arrives over HTTP, so a malformed one
  // is a fact about the deployment rather than a caller error, and an unusable value must
  // fall through to the derivation instead of being handed to a parser that can only fail.
  const shared = normalizeMineruBaseUrl(sharedUrl)
  if (shared !== '') return { url: shared, source: 'shared' }
  const port = (config as { mineruPort?: number }).mineruPort
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
    return { url: undefined, source: undefined }
  }
  return { url: 'http://127.0.0.1:' + String(port), source: 'derived' }
}

/**
 * MinerU's base URL for this deployment, or undefined when it is not configured.
 *
 * The URL-only view of {@link resolveMineruUrl}, kept because the extractor only needs the
 * address and threading a source through it would make every caller unpack a field it does
 * not read.
 *
 * @param config - resolved plugin config.
 * @param sharedUrl - the deployment's shared address, when the caller has none of their own.
 * @returns the address to call, else undefined.
 */
export function mineruUrlFor(config: Config, sharedUrl?: string): string | undefined {
  return resolveMineruUrl(config, sharedUrl).url
}

/**
 * Read the shared MinerU address the 「文档识别」 plugin's administrator configured.
 *
 * A read-only peek at another plugin's setting, and deliberately tolerant: the OCR plugin is
 * optional, its backend route answers `''` when nobody has configured it, and an unreachable
 * backend must not stop a document upload. Every failure therefore answers "no shared value"
 * and the caller falls through to its own derivation, which is the behaviour a deployment
 * without the OCR plugin has.
 *
 * This never writes. The value belongs to the OCR plugin's administrator; copying it into
 * this plugin's settings file would make a stale duplicate of a value that is supposed to
 * change once for everyone.
 *
 * @param ctx - host context carrying the credential store.
 * @param config - resolved plugin config, for the backend origin and credential.
 * @returns the shared address, or undefined when none is configured or it cannot be read.
 */
export async function readSharedMineruUrl(ctx: Context, config: Config): Promise<string | undefined> {
  if (!isTeamDeployment(config)) return undefined
  try {
    const body = await request<{ mineruUrl?: unknown }>(ctx, config, ENDPOINTS.ocrConfig, {
      // Short bound: this sits in front of an upload, and a backend that is merely slow
      // should not delay the reader's own document. Falling through to the derived address
      // costs nothing when the answer does not arrive.
      timeoutMs: Math.min(config.timeoutMs, 5_000),
    })
    const value = typeof body.mineruUrl === 'string' ? body.mineruUrl.trim() : ''
    return value === '' ? undefined : value
  } catch {
    // Unreachable, unauthorized, or malformed: all of them mean "this deployment has no
    // shared address this caller can see", and the caller's own settings still apply.
    return undefined
  }
}



/**
 * Ask DataOps whether the CALLER may manage grants.
 *
 * The question is put to the authority instead of being inferred here. The route
 * read below is guarded by exactly `data:access-grant:manage` -- the permission the
 * grant and revoke calls require -- so the backend's own answer to the read is the
 * answer to "may this caller manage grants": a `200` means the permission is held,
 * a `403` means it is not. Nothing about the body is used, and the filter keeps the
 * response to this resource type rather than downloading the whole grant table.
 *
 * Every other outcome denies. An unreachable backend, a timeout, a rejected token
 * and a malformed body all leave the permission unproven, and an unproven permission
 * must not publish a management surface: an administrator who is wrongly denied
 * retries after the backend recovers, while a non-administrator who is wrongly
 * allowed keeps an entry point the backend would refuse anyway.
 *
 * Role names were considered as the judge and rejected on measured evidence, so that
 * the reason survives the next reader. `/auth/me` returns `roles[].code` as the
 * role's DISPLAY name -- measured 2026-10-16 against the running backend, which
 * answers `管理员` and `超级管理员` -- while `SUPER_ADMIN` / `ADMIN` are the separate
 * `system_key` values that route never exposes. Matching the constant names would
 * therefore deny every real administrator, and matching display names would let a
 * role rename silently change who may manage grants. The enforced permission point
 * has neither problem, which is why it is the only judge used here.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @returns Whether the caller holds the grant-management permission.
 */
export async function canManageGrants(ctx: Context, config: Config): Promise<boolean> {
  // There are no grants in a personal deployment, so there is nothing to manage: answering
  // false is the honest answer rather than a denial of some capability the operator lacks.
  // The surfaces that gate on this (the permission page, the storage write) are team
  // features and do not render without a backend anyway.
  if (!isTeamDeployment(config)) return false
  try {
    // A resource id no grant can carry, so the probe reads no grant rows at all:
    // the guard is what is being asked, not the body it returns.
    const path = `${ENDPOINTS.grants}?resourceType=${encodeURIComponent(KB_RESOURCE_TYPE)}`
      + `&resourceId=${encodeURIComponent(GRANT_PROBE_RESOURCE_ID)}`
    await request<unknown>(ctx, config, path, { method: 'GET' })
    return true
  } catch {
    return false
  }
}

/**
 * Who authors or reviews a plaza workflow.
 *
 * Team deployments must name the real DataOps caller: a publish record without a
 * responsible author is not reviewable. A personal deployment has no backend and no
 * second administrator, so its local operator is both author and reviewer.
 */
export async function resolveWorkflowActor(ctx: Context, config: Config): Promise<WorkflowActor> {
  if (!isTeamDeployment(config)) return { id: 'local', name: '个人用户' }
  const caller = await fetchCaller(ctx, config)
  return { id: caller.userId, name: caller.label ?? caller.userId }
}

/**
 * The backend permission one HTTP method needs.
 *
 * The named file operations are the routes the page and the file tools actually call;
 * leaving a route out is deliberate for read-only status/preferences surfaces whose
 * data is already scoped by the caller's grants.
 */
export function permissionForKbRoute(method: string): string | undefined {
  if (method === 'list' || method === 'read' || method === 'search' || method === 'graph') return 'kb:file:read'
  if (method === 'create' || method === 'edit' || method === 'move' || method === 'upload' || method === 'rename') return 'kb:file:write'
  if (method === 'trash' || method === 'trash.remove' || method === 'trash.restore') return 'kb:file:delete'
  // Memory management is a product surface over the caller's own personal tree:
  // reading the page needs read, correcting needs write, forgetting needs delete.
  if (method === 'memory.list' || method === 'memory.get' || method === 'memory.settings') return 'kb:file:read'
  if (method === 'memory.update' || method === 'memory.set-enabled' || method === 'memory.save-settings') return 'kb:file:write'
  if (method === 'memory.forget') return 'kb:file:delete'
  // Promotion is a review action: the shared list stays a normal read, while the
  // three management methods require the review capability. A department
  // administrator holds `kb:review:decide` but not `kb:config:manage`; the route
  // then narrows further to the departments that principal actually reviews.
  if (method === 'memory.shared') return 'kb:file:read'
  if (method === 'memory.promote' || method === 'memory.promotions' || method === 'memory.review-promotion') {
    return 'kb:review:decide'
  }
  if (method === 'index' || method === 'extract.retry') return 'kb:file:extract'
  if (method === 'index.status') return 'kb:file:read'
  if (method === 'audit.list') return 'kb:audit:read'
  if (method === 'grants' || method === 'grant' || method === 'revoke') return 'kb:grant:manage'
  if (method === 'pending.list' || method === 'pending.approve' || method === 'pending.reject') return 'kb:review:decide'
  if (method === 'config.set' || method === 'settings.get' || method === 'settings.set'
    || method === 'deploy.hosts' || method === 'deploy.run' || method === 'deploy.log' || method === 'deploy.steps') {
    return 'kb:config:manage'
  }
  if (method === 'workflow.mine' || method === 'workflow.public') return 'workflow:read'
  if (method === 'workflow.pending' || method === 'workflow.review') return 'workflow:review:decide'
  if (method === 'workflow.resubmit') return 'workflow:publish'
  if (method === 'workflow.unpublish') return 'workflow:manage'
  return undefined
}

/** Append one management-tool action to the profile-local audit trail. */
async function appendManagementAudit(
  config: Config,
  _ctx: Context,
  entry: { action: string; actor: string; detail: Record<string, unknown> },
): Promise<void> {
  const directory = publishDirOf(config.publishDir)
  await mkdir(directory, { recursive: true })
  await appendFile(join(directory, 'management-audit.jsonl'), JSON.stringify({
    at: new Date().toISOString(),
    ...entry,
  }) + '\n', 'utf8')
}

/**
 * Whether this caller may see and use the review tab.
 *
 * In a team deployment this is the same grant-management authority the permission page
 * uses. A personal deployment has no administrator and no grants; its owner is the
 * reviewer by construction.
 */
export async function canReviewWorkflows(ctx: Context, config: Config): Promise<boolean> {
  return isTeamDeployment(config) ? canManageGrants(ctx, config) : true
}

/**
 * The resource id the capability probe asks about.
 *
 * The response body is ignored, so this only has to keep the probe offline from
 * real data; a leading slash is the cheapest way to do that, because
 * {@link isContainedRelPath} refuses it and no legitimate grant can name it. The
 * filter also keeps the probe from reading the whole grant table.
 */
const GRANT_PROBE_RESOURCE_ID = '/__knowledge-grant-probe__'

/**
 * How long a rebuilt view is trusted before a read may rebuild it again.
 *
 * Long enough that a page which reads its status repeatedly does not walk the
 * shared tree each time, short enough that a permission changed in DataOps is
 * reflected without the reader doing anything. This is a refresh interval, not a
 * cache: the view on disk is always the last thing DataOps authorized, never a
 * stale answer to a question about the present.
 */
const AUTO_SYNC_INTERVAL_MS = 30_000

/**
 * How long one write waits for its own index pass before answering "indexing".
 *
 * Indexing is what makes a just-written document searchable, but it walks the tree
 * (stat every text file, read the changed ones) and the authoritative share can be a
 * network mount. A write must not hang on that: past this budget the pass keeps
 * running and the tool reports `indexing` instead of a row it does not have yet.
 */
const INDEX_AFTER_WRITE_WAIT_MS = 5_000

/**
 * Most callers whose last refresh instant is remembered.
 *
 * A bound rather than a policy: the map is bookkeeping, so an evicted caller at
 * worst triggers one extra check. Without a cap it would grow with every user the
 * process ever served.
 */
const MAX_TRACKED_CALLERS = 500

/**
 * Create one grant in the backend permission store.
 *
 * The plugin names the principal and the path; DataOps decides whether the
 * principal exists and whether the caller may write the grant at all. That split
 * is why this is a thin relay rather than a policy of its own.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @param body - the grant to create.
 * @returns The backend's acknowledgement.
 */
export function createGrant(
  ctx: Context,
  config: Config,
  body: KnowledgeGrantRequest,
): Promise<unknown> {
  return request<unknown>(ctx, config, ENDPOINTS.grants, {
    method: 'POST',
    body: {
      // The store keys a grant by resource type and id, so a knowledge path is
      // addressed in the resource-id slot rather than under its own field.
      resourceType: KB_RESOURCE_TYPE,
      resourceId: body.relPath,
      principalType: body.principalType,
      principalId: body.principalId,
      action: body.action ?? 'read',
    },
  })
}

/** Remove one grant from the backend permission store. */
export function revokeGrant(
  ctx: Context,
  config: Config,
  body: KnowledgeRevokeRequest,
): Promise<unknown> {
  return request<unknown>(ctx, config, ENDPOINTS.grants, {
    method: 'DELETE',
    body: {
      resourceType: KB_RESOURCE_TYPE,
      resourceId: body.relPath,
      principalType: body.principalType,
      principalId: body.principalId,
      action: body.action,
    },
  })
}

/**
 * Overlay the operator's stored choices onto the deployment configuration.
 *
 * Two sources answer "which storage shape": the profile, which is fixed when the container is
 * created, and `.kb-settings.json`, which the panel writes. The file wins, because it is the
 * one the operator can still change -- a saved choice that the running process ignored would
 * be the same dead control this route exists to replace.
 *
 * Only the fields the panel owns are overlaid. `mountPoint`, `actualRoot`, `viewRoot` and
 * `permitted` stay as the deployment declares them: those are bind mounts and export specs,
 * decided when the container starts, so a file that changed them would point the plugin at
 * paths nothing serves.
 * @param config - the deployment configuration.
 * @param stored - what the settings file holds.
 * @returns The configuration the request should use.
 */
export function withStoredStorage(config: Config, stored: KnowledgeStorageSettings): Config {
  const next: Config = { ...config }
  if (stored.storageMode !== undefined) next.storageMode = stored.storageMode
  if (stored.storageProtocol !== undefined) next.storageProtocol = stored.storageProtocol
  if (stored.nfsServer !== undefined) next.nfsServer = stored.nfsServer
  if (stored.sshHost !== undefined) next.sshHost = stored.sshHost
  if (stored.sshUser !== undefined) next.sshUser = stored.sshUser
  if (stored.sshPort !== undefined) next.sshPort = stored.sshPort
  if (stored.sshRemotePath !== undefined) next.sshRemotePath = stored.sshRemotePath
  if (stored.sshMountOptions !== undefined) next.sshMountOptions = stored.sshMountOptions
  if (stored.sshKeyRef !== undefined) next.sshKeyRef = stored.sshKeyRef
  if (stored.retrieval !== undefined) {
    next.retrieval = { vector: { ...(config.retrieval?.vector ?? DEFAULT_VECTOR_RETRIEVAL), ...stored.retrieval.vector } }
  }
  return next
}

/** Build the substitution context for the deployment recipes. */
export function planContext(config: Config): DeployPlanContext {
  return {
    actualRoot: config.actualRoot,
    viewRoot: config.viewRoot,
    tier: config.mineruTier,
    backend: config.mineruBackend,
    port: config.mineruPort,
    memoryMaxMiB: config.mineruMemoryMaxMiB,
    permitted: config.permitted,
    server: config.nfsServer,
    mountPoint: config.mountPoint,
    protocol: config.storageProtocol,
    sshHost: config.sshHost,
    sshUser: config.sshUser,
    sshPort: config.sshPort,
    sshRemotePath: config.sshRemotePath,
    sshMountOptions: config.sshMountOptions,
  }
}

/** One recorded step execution. */
export interface StepRun {
  stepId: string
  hostId: string
  state: 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt: string | null
  /** Human-readable transcript assembled from per-command results. */
  log: string[]
}

/** Read a JSON request body, tolerating an empty one. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text) as Record<string, unknown>)
      } catch (error) {
        reject(new Error('request body is not valid JSON', { cause: error }))
      }
    })
    req.on('error', (error: Error) => { reject(error) })
  })
}

/** Write one JSON reply. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * The status a completed write answers with when the view could not follow it.
 *
 * Deliberately not 200: the write DID happen, but the reader's next action is to
 * look for a document that is not there. A success code would leave the page with
 * nothing to say, which is the failure this whole path exists to stop. 207 is
 * "the operation happened, now read this": the body still carries the created
 * record, and `viewSyncWarning` says why the tree does not show it yet.
 */
const VIEW_SYNC_FAILED_STATUS = 207

/**
 * Build a write route's reply, naming a view refresh that did not take effect.
 *
 * The write itself already succeeded, so this never turns a completed mutation into
 * an error: it attaches the reason the tree will not reflect it yet, and answers 207
 * so the client cannot mistake it for a clean success. The page shows the warning
 * and offers a retry, which is the only honest account of what happened.
 *
 * @param payload - the route's own success body.
 * @param refresh - the outcome {@link refreshViewIfStale} reported for this write.
 * @returns the status and body to send.
 */
function writeReplyAfterSync(
  payload: Record<string, unknown>,
  refresh: { synced: boolean; delta?: ViewDelta; failure?: string },
): { status: number; body: Record<string, unknown> } {
  if (refresh.failure === undefined) {
    return {
      status: 200,
      body: { ...payload, ...(refresh.delta === undefined ? {} : { view: refresh.delta }) },
    }
  }
  return {
    status: VIEW_SYNC_FAILED_STATUS,
    body: {
      ...payload,
      viewSyncWarning: {
        message: 'the change was saved, but the file tree could not be refreshed',
        reason: refresh.failure,
      },
    },
  }
}

/** Serialize a thrown value for the browser. */
/**
 * Map a write refusal to the status that describes it.
 *
 * Separated from the message so the two cannot drift: a name already taken is a
 * conflict rather than a bad request, and a body over the ceiling is refused for
 * its size rather than for its content. 507 is not used because the limit is this
 * plugin's own, not the filesystem's.
 * @param code - the refusal's code.
 * @returns The HTTP status to answer with.
 */
/**
 * The HTTP status for a typed knowledge-base failure.
 *
 * The routes below answer 500 for an uncaught error, which is right for a bug but wrong
 * for a decision the backend already made: an expired token came back as "500 Internal
 * Server Error", sending the operator to look for a crash that was not there. Mapping the
 * code keeps the answer honest, and `unauthorized` additionally tells the page to ask for
 * a fresh credential rather than retry.
 * @param code - the typed failure code.
 * @returns The status to answer with.
 */
function knowledgeStatusFor(code: KnowledgeErrorCode): number {
  if (code === 'unauthorized') return 401
  if (code === 'not-configured') return 409
  if (code === 'unreachable') return 502
  // The personal boundary's refusals are malformed requests: the caller sent a path this
  // deployment can never accept, and 409 described a configuration problem that is not
  // there. The four codes are answered alike, and each body still carries which one.
  if (code === 'escapes-knowledge-root' || code === 'absolute-path' || code === 'empty-path' || code === 'nul-byte') {
    return 400
  }
  return 502
}

/** HTTP status for a structured knowledge tool error, used by the shared read route. */
function knowledgeToolStatus(code: KnowledgeToolError['code']): number {
  switch (code) {
    case 'empty-path':
    case 'nul-byte':
    case 'absolute-path':
    case 'escapes-knowledge-root':
    case 'not-a-directory':
    case 'not-a-file': return 400
    case 'forbidden': return 403
    case 'not-found': return 404
    case 'exists': return 409
    case 'too-large': return 413
    case 'binary': return 415
    case 'unauthorized': return 401
    case 'not-configured': return 409
    case 'unreachable':
    case 'bad-response': return 502
    default: return 500
  }
}

function writeStatusFor(code: KnowledgeWriteError['code']): number {
  switch (code) {
    case 'bad-path': return 400
    case 'exists': return 409
    case 'too-large': return 413
    case 'write-failed': return 500
  }
}

function describeError(error: unknown): { message: string; code?: string } {
  if (error instanceof KnowledgeError || error instanceof RemoteError) {
    return { message: error.message, code: error.code }
  }
  return { message: error instanceof Error ? error.message : String(error) }
}

/**
 * Register the knowledge-base routes and tools.
 * @param ctx - Host context carrying credentials, tools, and the Web server.
 * @param config - resolved plugin configuration.
 */
/** Provider name this plugin registers its bundle skill under. */
export const KNOWLEDGE_SKILL_PROVIDER = 'dsh-knowledge-base'

/** Name the model sees in the skill catalog. */
export const KNOWLEDGE_SKILL_NAME = 'knowledge-base'

/**
 * One bundled memory skill: the guardian, extraction subagent, and SOP evaluation
 * subagent rules moved into `references/` under this single catalog entry.
 */
export const MEMORY_SKILL_NAME = 'memory'

/**
 * Short description shown in the skill list.
 *
 * Kept beside the SKILL.md body rather than parsed out of its frontmatter: the
 * catalog answers `list()` without reading any skill content, so the text has to
 * be available before the file is opened.
 */
export const KNOWLEDGE_SKILL_DESCRIPTION =
  '知识库统一入口：检索、浏览、新建、上传、改名、移动、删除全局 / 部门 / 个人文档；需要整理归档、生成文档摘要、定向向量化或读写知识图谱时，按需加载 references 中的对应流程。'
  + 'Cite with the stable kb://doc/<docId>/chunk/<key> token, never with line or block numbers.'

/**
 * Where this package's SKILL.md lives, from either build layout.
 *
 * The build emits `lib/index.js`, so the file sits one level up; a source run
 * resolves from `src/`, which is also one level up. Both answer the same path,
 * which is why this does not need to believe in a single layout.
 *
 * @returns absolute path of the SKILL.md this plugin ships.
 */
export function knowledgeSkillPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  return join(moduleDirectory, '..', 'SKILL.md')
}

/** Where the bundled one-entry `memory` skill lives. */
export function memorySkillPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  return join(moduleDirectory, '..', 'skills', MEMORY_SKILL_NAME, 'SKILL.md')
}

/** Short description of the unified memory skill. */
export const MEMORY_SKILL_DESCRIPTION =
  '个人记忆系统的统一入口：记忆守护会话、记忆抽取子代理与 SOP 评估子代理都先读它，再按角色加载 references 中的对应准则。'

/**
 * Where this package's tutorial document lives, from either build layout.
 *
 * Resolved the same way {@link knowledgeSkillPath} is, and for the same reason: the
 * build emits `lib/index.js` while a source run executes from `src/`, and both sit one
 * level below the package root. The file is shipped by `files[]` in package.json, so a
 * published install answers the same path without a second mechanism.
 *
 * @returns absolute path of the tutorial this plugin ships.
 */
export function tutorialTemplatePath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  return join(moduleDirectory, '..', TUTORIAL_FILE_NAME)
}

/**
 * The skill provider that teaches the model how to use this knowledge base.
 *
 * One bundled skill, read from disk on `get()` rather than kept in memory: the
 * body is documentation, and a host that never asks for it should not pay for
 * holding it.
 *
 * @returns a provider the skill registry can list and read.
 */
export const KNOWLEDGE_SKILL_RANK = 640

/** The memory skill is a specialised role bundle, so it sorts after the general KB skill. */
export const MEMORY_SKILL_RANK = 670

/** Both a human and the model may invoke this skill. */
export const KNOWLEDGE_SKILL_INVOCATION = { modelInvocable: true, userInvocable: true } as const

/**
 * The skill provider that teaches the model how to use this knowledge base.
 *
 * One bundled skill, read from disk on `get()` rather than kept in memory: the
 * body is documentation, and a host that never asks for it should not pay for
 * holding it.
 *
 * `rank` places it after the bundled GenUI skill (600): a task that needs both
 * wants the fence reference first, because the knowledge skill's own answers are
 * mostly prose and shell commands.
 *
 * @returns a provider the skill registry can list and read.
 */
export function knowledgeBaseSkillProvider(): {
  readonly name: string
  readonly list: (options: { readonly cwd?: string; readonly signal?: AbortSignal }) => Promise<readonly SkillCandidateLike[]>
  readonly get: (candidate: SkillCandidateLike, options: { readonly cwd?: string; readonly signal?: AbortSignal }) => Promise<SkillDefinitionLike | undefined>
} {
  const candidates: SkillCandidateLike[] = [
    {
      name: KNOWLEDGE_SKILL_NAME,
      description: KNOWLEDGE_SKILL_DESCRIPTION,
      invocation: KNOWLEDGE_SKILL_INVOCATION,
      source: 'bundled',
      provider: KNOWLEDGE_SKILL_PROVIDER,
      path: knowledgeSkillPath(),
      resourceBase: { kind: 'directory', path: dirname(knowledgeSkillPath()) },
      rank: KNOWLEDGE_SKILL_RANK,
      locator: knowledgeSkillPath(),
    },
    {
      name: MEMORY_SKILL_NAME,
      description: MEMORY_SKILL_DESCRIPTION,
      invocation: KNOWLEDGE_SKILL_INVOCATION,
      source: 'bundled',
      provider: KNOWLEDGE_SKILL_PROVIDER,
      path: memorySkillPath(),
      resourceBase: { kind: 'directory', path: dirname(memorySkillPath()) },
      rank: MEMORY_SKILL_RANK,
      locator: memorySkillPath(),
    },
  ]
  return {
    name: KNOWLEDGE_SKILL_PROVIDER,
    list: () => Promise.resolve(candidates),
    get: (candidate) => {
      const resolved = candidates.find(entry => entry.name === candidate.name)
        ?? candidates.find(entry => entry.path === candidate.path)
        ?? candidates[0]!
      return Promise.resolve({ ...resolved, content: readFileSync(resolved.path, 'utf8') })
    },
  }
}

/**
 * One catalog entry, shaped like the host's `SkillCandidate`.
 *
 * Declared here instead of imported: this plugin does not depend on the skill
 * package (the registry is an optional injection), so the structural contract is
 * restated rather than turning an optional neighbour into a build requirement. The
 * registry merges these by the fields it reads, so a shape that satisfies them is
 * the whole contract.
 */
export interface SkillCandidateLike {
  readonly name: string
  readonly description: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly source: 'bundled'
  readonly provider: string
  readonly path: string
  readonly resourceBase: { readonly kind: 'directory'; readonly path: string }
  readonly rank: number
  readonly locator: string
}

/** One loaded skill, shaped like the host's `SkillDefinition`. */
export interface SkillDefinitionLike extends SkillCandidateLike {
  readonly content: string
}

/**
 * Per-plugin-instance disclosure coordinators, keyed by the Host context.
 *
 * `apply` is synchronous and the Host does not hand a plugin a return value, but
 * the coordinator must be reachable for two legitimate callers: the host integration
 * that wants to force a refresh, and the tests that drive `apply` directly. A
 * WeakMap keeps this a discovery seam rather than a second lifecycle owner.
 */
const toolDisclosures = new WeakMap<object, ToolDisclosureCoordinator>()

/**
 * The permission-based tool disclosure coordinator this plugin instance registered.
 *
 * @param host - the Host context the plugin was applied to.
 * @returns the coordinator, or undefined when this context has no knowledge-base plugin.
 */
export function knowledgeBaseToolDisclosure(host: object): ToolDisclosureCoordinator | undefined {
  return toolDisclosures.get(host)
}

export function apply(ctx: Context, deploymentConfig: Config): void {
  // Routes re-resolve this per request (see the handler below), so the name a route reads is
  // the merged view rather than the deployment's own value.
  const config = deploymentConfig
  const host = ctx
  // The runner needs an absolute origin: a Host-side `fetch` cannot use the
  // relative paths a browser would accept.
  const runner: RemoteRunner = sshManagerRunner({ origin: originFrom(host.webServer) })
  const context = planContext(config)
  /** Completed and in-flight step runs, newest last. */
  const runs: StepRun[] = []
  /**
   * First-run provisioning of the authoritative tree.
   *
   * The buckets are re-checked on every start rather than once, because a bucket someone
   * deleted must come back; only the tutorial is write-once. The IO is bound to the
   * resolved root through the ordinary write path, so a provisioned document obeys the
   * same containment and exclusivity rules as one the reader creates.
   */
  const initializer = createInitializer(
    {
      // TEMPORARY (lead-approved): supplied while src/initialize.ts is mid-flight; owner
      // should confirm semantics.
      //
      // `InitIo.isStorageReady` asks whether the storage the root lives in is ATTACHED --
      // not whether the root exists, since provisioning is what creates the root. The
      // plugin already answers exactly that question in `classifyMount`, which reads the
      // configured mount point and separates "share attached" from "share attached but
      // this plugin has not built its pointer yet". A share that is attached in either
      // shape is ready for provisioning; only `absent` is not.
      //
      // Reusing that classifier rather than inventing an `access()` probe keeps one
      // definition of "the share is there": a second implementation here would be free
      // to disagree with the status route that already reports this state to the reader.
      isStorageReady: async () => {
        if (!isTeamDeployment(config)) {
          // The local authoritative directory is created on first write; its parent
          // only has to exist so a first run is not mistaken for a missing mount.
          try {
            return (await stat(dirname(localStorageRoot(config)))).isDirectory()
          } catch {
            return false
          }
        }
        return (await classifyMount(config)) !== 'absent'
      },
      createDirectory: async relPath => {
        await createKnowledgeEntry(config, relPath, { directory: true })
      },
      createDocument: async (relPath, content) => {
        await createKnowledgeEntry(config, relPath, { directory: false, content })
      },
      tutorialHtml: () => readFileSync(tutorialTemplatePath(), 'utf8'),
      ensureRoot: async () => { await mkdir(localStorageRoot(config), { recursive: true }) },
    },
    line => {
      // One line per item, so a deployment that comes up without its buckets says which
      // one stopped it rather than only that something failed.
      const message = `knowledge-base: init ${line.item}: ${line.outcome}`
      if (line.outcome === 'failed') host.logger?.warn?.(message)
      else host.logger?.info?.(message)
    },
    { personal: !isTeamDeployment(config) },
  )
  /**
   * Background extraction, one worker for this deployment.
   *
   * Upload and extraction are separate promises (see `extractionQueue.ts`): the bytes
   * must be visible when the upload answers, while the `.md` sibling may take a minute
   * on a scanned PDF. `run` reuses the same permission-checked `extractBeside` path the
   * upload used, so a background run and a manual retry cannot diverge. One queue per
   * registration means one worker per process, which is what keeps two parses from
   * competing for the same small box.
   */
  const extractionQueue: ExtractionQueue = createExtractionQueue({
    isExtractable: relPath => isExtractable(relPath),
    isAlreadyMarkdown: relPath => isAlreadyMarkdown(relPath),
    run: async (relPath, mineruBaseUrl, reportStep) => {
      reportStep?.('parse')
      // `config` is the alias declared above (`const config = deploymentConfig`), named
      // here because this is the ONE place production code calls `extractBeside`: both
      // the upload path and the manual retry go through this runner, so the caller's
      // stored address reaches the extractor exactly once per document.
      //
      // The caller's own address arrives as `mineruBaseUrl`; when they have none, the
      // deployment's shared value from the 「文档识别」 plugin applies, and only then the
      // port-derived address. `extractBeside` consults the shared value itself so this
      // runner cannot be the one place that forgets it.
      const outcome = await extractBeside(config, relPath, mineruBaseUrl, () => readSharedMineruUrl(ctx, config), ctx)
      if (outcome !== undefined && outcome.markdown !== '' && outcome.reason === undefined) {
        reportStep?.('chunk')
        reportStep?.('index')
        await syncKnowledgeIndex(true).catch(() => undefined)
        if (outcome.blocks !== undefined && outcome.blocks.length > 0) {
          const actualRelPath = await actualRelPathForView(ctx, config, relPath).catch(() => relPath)
          await attachProvenance({
            indexPath: knowledgeIndexPath(),
            markdownPath: markdownSiblingOf(actualRelPath),
            sourcePath: join(localConfig(config).actualRoot, actualRelPath),
            blocks: outcome.blocks,
          }).catch(() => undefined)
        }
        reportStep?.('done')
      }
      return extractionOutcomeOf(outcome)
    },
  })
  /**
   * Finish the retrieval pipeline for a document that just landed in the tree.
   *
   * Every write path uses this so a document is never durable-but-invisible: an
   * extractable format is queued (its worker chunks and indexes the derived `.md`),
   * and a plain-text format is indexed immediately. The two are exclusive on purpose —
   * indexing a binary as text is not possible and indexing it after extraction would
   * duplicate the work.
   *
   * @param relPath - the path the write used (authoritative or view spelling).
   * @param caller - the acting caller, for their parser settings.
   * @param options.replaceSibling - set when an existing source was overwritten.
   * @param options.mineruBaseUrl - an address already resolved by the caller.
   * @returns the `extraction` and/or `index` fields to merge into the reply.
   */
  const afterDocumentWrite = async (
    relPath: string,
    caller: KnowledgeCaller,
    options: { replaceSibling?: boolean; mineruBaseUrl?: string } = {},
  ): Promise<Record<string, unknown>> => {
    if (isExtractable(relPath)) {
      let mineruBaseUrl = options.mineruBaseUrl
      if (mineruBaseUrl === undefined && isTeamDeployment(config)) {
        const plan = localConfig(config)
        mineruBaseUrl = (await readSettings(viewPathFor({
          actualRoot: plan.actualRoot,
          viewRoot: plan.viewRoot,
          userId: caller.userId,
        })).catch(() => ({ mineruBaseUrl: undefined }))).mineruBaseUrl
      }
      const viewRelPath = toolViewPath(relPath)
      if (options.replaceSibling === true) {
        // The source changed under its sibling; see `enqueueExtraction`'s host twin.
        const actualRelPath = await actualRelPathForView(host, config, viewRelPath, caller).catch(() => relPath)
        await unlink(join(localConfig(config).actualRoot, markdownSiblingOf(actualRelPath))).catch(() => undefined)
      }
      const task = extractionQueue.enqueue(viewRelPath, mineruBaseUrl)
      return {
        extraction: task,
        index: { status: task.state === 'pending' ? 'pending-extraction' : 'skipped' },
      }
    }
    if (!isIndexableTextPath(relPath)) return {}
    const actualRelPath = isTeamDeployment(config)
      ? await actualRelPathForView(host, config, relPath, caller).catch(() => relPath)
      : relPath
    const pass = syncKnowledgeIndex(true).catch(() => undefined)
    const finished = await Promise.race([
      pass.then(() => true),
      new Promise<boolean>(resolve => { setTimeout(() => { resolve(false) }, INDEX_AFTER_WRITE_WAIT_MS) }),
    ])
    const status = documentIndexStatus(knowledgeIndexPath(), actualRelPath)
    if (status.found) {
      return {
        index: {
          status: 'indexed',
          docId: status.docId,
          chunks: status.chunks,
          ...(status.indexedAt === undefined ? {} : { indexedAt: status.indexedAt }),
        },
      }
    }
    return { index: { status: finished ? 'failed' : 'indexing' } }
  }
  /**
   * Callers whose missing pointer has already been repaired once this process.
   *
   * A caller with nothing granted never gains a pointer from a sync, so without
   * this the repair below would re-walk the shared tree and re-ask DataOps about
   * every file on every load. The set lives with the registration rather than in
   * the config so it is per-process state, not a persisted decision.
   */
  const repairedCallers = new Set<string>()
  /**
   * When each caller's view was last rebuilt by the routine refresh.
   *
   * Bounded on purpose: an unbounded per-caller map would grow with every user the
   * process ever served, and this is bookkeeping rather than a record. When the cap
   * is reached the oldest entry is dropped, which at worst costs one extra rebuild
   * for the caller unlucky enough to be evicted.
   *
   * In-memory only, so a restart forgets it. That is acceptable because the refresh
   * below only ever reads it to decide whether to refresh, and the sync itself is
   * idempotent: losing the map costs one redundant check, never a wrong answer.
   */
  const viewSyncedAt = new Map<string, number>()
  /**
   * Earliest instant the next routine refresh may run.
   *
   * Checked before any other work, so a page that reads its status inside the
   * interval costs one integer comparison and nothing else: no filesystem walk and
   * no backend call. That ordering is the whole point, because the mounted tree
   * lives on NFS where a walk is real latency.
   */
  let nextRoutineSyncAt = 0
  /**
   * Why the last refresh produced no view update, when it did not.
   *
   * Without this a failed sync and a sync with nothing to do are the same answer,
   * and the difference is what a reader needs: "your grants did not change" is the
   * ordinary case, while "the view could not be rebuilt" is a fault that has to be
   * reported. Reported through `status` so the page can say which one happened
   * instead of leaving a newly created document invisible with no explanation.
   */
  let lastSyncFailure: string | undefined
  /**
   * Why the last full scan declined to prune, when it did.
   *
   * Exposed through `status` so a deployment can see "this round resolved nothing, so
   * the view was left as-is" without reading logs. The condition is guarded (see
   * `syncView`), so its presence is the observable signal that the permission backend
   * answered nothing -- which is otherwise indistinguishable from a caller who has
   * legitimately lost every grant.
   */
  let lastPruneSkipped: string | undefined

  /**
   * Rebuild the caller's view when grants may have moved, at most once per interval.
   *
   * Grants decide what a user may read, but they put nothing on disk by themselves,
   * so a view that is never rebuilt shows yesterday's authorization. Making the
   * reader press a button for that was the design error: the mechanism is internal,
   * and the ordinary case should be invisible.
   *
   * The interval is what keeps this from being a per-request walk. Everything the
   * page reads goes through the gate below, while a mutation passes `force` because
   * it has just made the answer stale on purpose. The sync itself writes nothing
   * when the resolved set is unchanged (`syncView` reports `unchanged > 0,
   * linked: []`), so even a forced repeat costs a comparison rather than a rebuild.
   * @param force - rebuild even inside the interval, for a change this process made.
   * @returns What changed, so a caller can report or ignore it.
   */
  const refreshViewIfStale = async (
    force = false,
    // The authoritative path a WRITE just created or moved. Passed so the refresh can
    // verify the reader will see it instead of trusting "the sync ran": the sync
    // answers 200 even when every per-path resolve was denied, so a status-only check
    // reported success for a document that never reached the view.
    expectVisible?: string,
  ): Promise<{ synced: boolean; delta?: ViewDelta; failure?: string }> => {
    // The zero-IO fast path, and the reason a read may call this at all. A closed
    // gate returns here without touching disk or the backend; a forced call skips
    // it, because the caller has already changed the grants this view reflects.
    if (!force && Date.now() < nextRoutineSyncAt) return { synced: false }
    if (!isTeamDeployment(config)) return { synced: false }
    // Opened before the work rather than after: a failed attempt must not invite a
    // retry on the very next read, or an unreachable backend turns every request
    // into another walk of the shared tree.
    nextRoutineSyncAt = Date.now() + AUTO_SYNC_INTERVAL_MS
    // Forced callers are the write routes, so a failure there means the reader was
    // just told "done" about a document they cannot see. Twice, not more: a backend
    // that is down is not made up by a third attempt, and the second covers the
    // transient case a write actually produces (a resolve that raced the write).
    const attempts = force ? 2 : 1
    let lastFailure: string | undefined
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const plan = localConfig(config)
        const caller = await fetchCaller(host, config)
        if (!isSafeUserId(caller.userId)) {
          lastFailure = 'unsafe caller id; cannot key a view by it'
          continue
        }
        if (!force) {
          const previous = viewSyncedAt.get(caller.userId)
          if (previous !== undefined && Date.now() - previous < AUTO_SYNC_INTERVAL_MS) {
            return { synced: false }
          }
        }
        const result = await syncCallerView(host, config, undefined, {
          // A file that was only in the view was just imported into the authoritative
          // tree. Complete its pipeline so the next search and the status column see
          // it, without making the sync itself wait on a parser or an index pass.
          onAdopted: async adopted => { await afterDocumentWrite(adopted.viewPath, caller) },
        })
        if ('error' in result) {
          // The status the sync answered with is the reason: 409 is an unconfigured
          // backend, 502 an unreachable one, 400 an unsafe identity. Carrying it out
          // is what turns "nothing happened" into something a reader can act on.
          lastFailure = `view sync answered HTTP ${String(result.status)}: ${result.error}`
          continue
        }
        // The verify step. `expectVisible` is authoritative; the view path it should
        // appear at is derived from the same layout the sync used, then looked for on
        // disk. A miss is a failed refresh, not a success with nothing to do.
        if (expectVisible !== undefined) {
          const verifyOptions = {
            actualRoot: plan.actualRoot,
            viewRoot: plan.viewRoot,
            userId: caller.userId,
            ...(caller.departmentCode === undefined ? {} : { departmentCode: caller.departmentCode }),
            ...(caller.departmentPathCodes === undefined
              ? {}
              : { departmentPathCodes: caller.departmentPathCodes }),
          }
          const expected = expectedViewPathFor(verifyOptions, expectVisible)
          const landed = expected === undefined
            ? false
            : await stat(join(viewPathFor(verifyOptions), expected))
              .then(info => info.isFile() || info.isDirectory())
              .catch(() => false)
          if (!landed) {
            lastFailure = `the view does not show ${JSON.stringify(expectVisible)} after the refresh`
            continue
          }
        }
        viewSyncedAt.set(caller.userId, Date.now())
        if (viewSyncedAt.size > MAX_TRACKED_CALLERS) {
          const oldest = viewSyncedAt.keys().next()
          if (!oldest.done) viewSyncedAt.delete(oldest.value)
        }
        lastSyncFailure = undefined
        lastPruneSkipped = result.pruneSkipped
        return { synced: true, delta: result }
      } catch (error) {
        // An unreadable identity or an unreachable backend leaves the view as found.
        // The page reports the mounted state it actually sees, and a later read
        // retries once the interval has passed.
        lastFailure = describeError(error).message
      }
    }
    // Recorded rather than swallowed: this is the difference between a reader whose
    // grants genuinely changed nothing and a reader whose view silently stopped
    // following the grants. The caller below decides whether to surface it.
    lastSyncFailure = lastFailure
    host.logger?.warn?.(`knowledge-base: view refresh did not complete: ${lastFailure ?? 'unknown reason'}`)
    return { synced: false, ...(lastFailure === undefined ? {} : { failure: lastFailure }) }
  }

  /**
   * Permission-based tool disclosure, assigned once the host seams exist below.
   *
   * Declared before the HTTP surface because the route handler closes over it: the
   * route gate is one of the two existing places this plugin already reads the
   * caller's permission context, so it is also where a changed context refreshes the
   * model-facing tool surface.
   */
  let toolDisclosure: ToolDisclosureCoordinator | undefined

  ctx.effect(() => host.webServer.register({
    kind: 'prefix',
    path: '/knowledge-base/api',
    handler: async (req, res) => {
      const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice('/knowledge-base/api/'.length)
      try {
        // The operator's saved choices sit on top of the deployment config, and an
        // instance of the plugin is a long-lived closure: without this re-read, a save
        // would not change the answer any route gives until the process restarted, which
        // is precisely the dead-control failure the settings write exists to remove.
        // A read is a small stat-backed file, so it costs less than the route below it.
        //
        // Deliberately shadows the closure's `config` for this handler's whole body: every
        // route below must answer from one merged view, and a name that meant two different
        // things depending on the line would be the same class of bug as the dead control.
        const config = withStoredStorage(deploymentConfig, await readStorageSettings(deploymentConfig.mountPoint))
        const requiredPermission = permissionForKbRoute(method)
        if (requiredPermission !== undefined && isTeamDeployment(config)) {
          let permissionContext: Awaited<ReturnType<typeof managementHost.context>> | undefined
          try {
            // A slow/unreachable review context must not turn into an authorization
            // bypass. Bound the wait so a stalled backend cannot hang the page, then
            // refuse the permission-declaring route (503) instead of running it.
            permissionContext = await Promise.race([
              managementHost.context().catch(() => undefined),
              new Promise<undefined>(resolve => setTimeout(() => { resolve(undefined) }, 750)),
            ])
          } catch {
            permissionContext = undefined
          }
          if (permissionContext === undefined) {
            return writeJson(res, 503, {
              error: '权限上下文暂时不可用，请稍后重试',
              code: 'permission-context-unavailable',
              required: requiredPermission,
            })
          }
          // A route that carries a real context also refreshes the disclosed tool
          // surface. A disclosure failure must not change this request's answer.
          try {
            await toolDisclosure?.syncToolDisclosure(permissionContext)
          } catch {
            // The permission decision below still uses the context just read.
          }
          // An explicit empty list is a caller with zero permissions, not an older
          // backend: `managementHost.context()` always returns an array. Only a
          // non-array/missing list falls back to the route's own grant checks.
          const permissionKeys = (permissionContext as { permissions?: unknown }).permissions
          if (Array.isArray(permissionKeys) && !hasPermission(permissionContext, requiredPermission)) {
            return writeJson(res, 403, {
              error: `缺少权限 ${requiredPermission}`,
              code: 'forbidden',
              required: requiredPermission,
            })
          }
        }
        switch (method) {
          case 'graph.canvas': {
            // The graph tab embeds the prototype's canvas as a same-origin page. It
            // carries no data and makes no request of its own; the panel posts the
            // permission-filtered payload into it. Serving it here rather than from a
            // static asset keeps the deployment one `docker cp` of `lib/`, which is
            // how every other part of this plugin ships.
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            })
            res.end(GRAPH_CANVAS_HTML)
            return
          }
          case 'graph': {
            // Read-only domain tree for the graph tab.
            //
            // The scanner is handed the AUTHORITATIVE roots and one permission seam.
            // It asks `canReadPath` once per graph folder and never returns a denied
            // folder's name; the browser receives only what DataOps resolved.
            //
            // The caller is resolved here, not accepted from the request. Without an
            // identity there is no personal root and no grant question to ask, so the
            // answer is a refusal rather than an empty tree that looks like "no graphs".
            let caller
            try {
              caller = await fetchCaller(host, config)
            } catch (error) {
              return writeJson(res, 403, {
                error: 'the permission service did not identify this caller',
                code: 'forbidden',
                detail: describeError(error).message,
              })
            }
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 403, { error: 'unsafe caller id', code: 'forbidden' })
            }
            const plan = localConfig(config)
            const roots = await knowledgeGraphScopeRoots(host, config, caller)
            const graphCaller: KnowledgeGraphCaller = {
              userId: caller.userId,
              label: caller.label,
              ...(caller.departmentPathCodes === undefined
                ? {}
                : { departmentPathCodes: caller.departmentPathCodes }),
              ...(caller.departmentPathNames === undefined
                ? {}
                : { departmentPathNames: caller.departmentPathNames }),
            }
            const graphTree = await scanKnowledgeGraphs({
              actualRoot: plan.actualRoot,
              roots,
              caller: graphCaller,
              canRead: relPath => canReadPath(host, config, relPath),
            })
            // `.graphs/<id>/graph.json` is the current model; the folder tree above is
            // the legacy layout. Both are scanned so a half-migrated scope still
            // browses, but only the new model is writable. A graph folder the Host
            // denies is dropped before its manifest is read, exactly like the legacy
            // scanner: a denied name is still a disclosure.
            const projectedByScope = await projectGraphJsonScopes(host, config, roots, caller.userId)
            for (const scope of graphTree.scopes) {
              for (const group of scope.groups) {
                for (const graph of group.graphs) {
                  const tagged = graph as typeof graph & { format?: 'legacy' | 'graph-json'; readOnly?: boolean }
                  tagged.format ??= 'legacy'
                  tagged.readOnly = true
                }
              }
            }
            mergeProjectedGraphs(graphTree, projectedByScope)
            // The computed overviews are views over the permission-filtered graphs,
            // not stored manifests: one per scope the caller resolved. Append them
            // after the merge so they are siblings of the real graphs and never part
            // of their own aggregate.
            const overviewRows = config.overviewEnabled === false
              ? []
              : (await appendOverviewGraphs(
                  graphToolHost,
                  knowledgeGraphsOf(graphTree),
                  overviewScopesFromRoots(roots),
                  graphCaller,
                )).filter(isOverviewGraph)
            for (const row of overviewRows) {
              const targetScope = graphTree.scopes.find(scope => scope.key === row.scope)
              if (targetScope === undefined) continue
              const firstGroup = targetScope.groups[0]
              if (firstGroup === undefined) {
                targetScope.groups.push({ key: '', label: '', graphs: [row] })
              } else {
                firstGroup.graphs.push(row)
              }
            }
            // The scanner keeps each graph's authoritative path for the Host-side
            // tools. It must not cross into the browser: on a personal scope that
            // path contains the caller's uid.
            const forBrowser = {
              ...graphTree,
              scopes: graphTree.scopes.map(scope => ({
                ...scope,
                groups: scope.groups.map(group => ({
                  ...group,
                  graphs: group.graphs.map((graph) => {
                    const copy = { ...graph }
                    delete copy.actualPath
                    return copy
                  }),
                })),
              })),
            }
            return writeJson(res, 200, forBrowser)
          }
          case 'workflow.mine': {
            if (!isTeamDeployment(config)) {
              const records = await listWorkflowsForAuthor(
                publishStorePath(publishDirOf(config.publishDir)),
                'local',
              )
              return writeJson(res, 200, {
                workflows: records.map(record => ({
                  id: record.id,
                  title: record.title,
                  description: record.description,
                  instruction: record.instruction,
                  cronHint: record.cronHint,
                  category: record.category,
                  reviewStatus: record.status,
                  status: record.status,
                  visibility: record.visibility,
                  departmentCode: record.departmentCode ?? null,
                  ownerId: record.authorId,
                  ownerName: record.authorName,
                  reviewNote: record.reviewNote ?? null,
                  updatedAt: record.updatedAt,
                  submittedAt: record.createdAt,
                })),
              })
            }
            const result = await request<{ items?: unknown[] }>(host, config, '/api/ai/workflow-publications/mine')
            return writeJson(res, 200, { workflows: result.items ?? [] })
          }
          case 'workflow.unpublish': {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            if (id === '') return writeJson(res, 400, { error: 'id is required', code: 'invalid' })
            if (!isTeamDeployment(config)) {
              await unpublishPublishedWorkflow(
                publishStorePath(publishDirOf(config.publishDir)),
                id,
                { id: 'local', name: '个人用户' },
              )
              return writeJson(res, 200, { success: true })
            }
            const result = await request(host, config, '/api/ai/workflow-publications/' + encodeURIComponent(id), { method: 'DELETE' })
            return writeJson(res, 200, result ?? { success: true })
          }
          case 'workflow.resubmit': {
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            if (id === '') return writeJson(res, 400, { error: 'id is required', code: 'invalid' })
            if (!isTeamDeployment(config)) {
              const record = await resubmitPublishedWorkflow(
                publishStorePath(publishDirOf(config.publishDir)),
                id,
                { id: 'local', name: '个人用户' },
              )
              return writeJson(res, 200, { workflow: record })
            }
            // In-place PUT: the backend keeps the id, resets the review state, and the
            // mine list therefore stays at one card. This replaced the old
            // "POST a copy, then DELETE the old row" workaround.
            const patch: Record<string, unknown> = {}
            for (const key of ['title', 'description', 'instruction', 'cronHint', 'category', 'visibility', 'departmentCode', 'sourceSessionId']) {
              if (body[key] !== undefined) patch[key] = body[key]
            }
            const updated = await request<Record<string, unknown>>(
              host,
              config,
              '/api/ai/workflow-publications/' + encodeURIComponent(id),
              { method: 'PUT', body: patch },
            )
            return writeJson(res, 200, { workflow: updated })
          }
          case 'workflow.public': {
            // Approved records only. Built-ins live in the client registry; this route
            // deliberately says nothing about pending/rejected records, which may contain
            // an unreviewed prompt.
            // Public response is deliberately narrower than the stored record: reviewer
            // identity, audit history and review notes stay admin-only.
            const workflows = (await listApprovedWorkflows(publishStorePath(publishDirOf(config.publishDir))))
              .map(({ id, title, description, instruction, cronHint, category, authorName, createdAt }) => ({
                id, title, description, instruction, cronHint, category, authorName, createdAt,
              }))
            return writeJson(res, 200, { workflows })
          }
          case 'workflow.pending': {
            if (!(await canReviewWorkflows(host, config))) {
              return writeJson(res, 403, {
                error: 'workflow review requires grant-management access',
                code: 'forbidden',
              })
            }
            if (!isTeamDeployment(config)) {
              const workflows = await listPendingWorkflows(publishStorePath(publishDirOf(config.publishDir)))
              return writeJson(res, 200, { workflows })
            }
            // Team review queues live in the shared backend; the profile-local store is
            // only the standalone/personal fallback. Reading the local store here made a
            // freshly resubmitted row invisible in the Review tab.
            const result = await request<{ items?: unknown[] }>(
              host,
              config,
              '/api/ai/review/workflows?status=pending&limit=100',
            )
            return writeJson(res, 200, { workflows: result.items ?? [] })
          }
          case 'workflow.review': {
            if (!(await canReviewWorkflows(host, config))) {
              return writeJson(res, 403, {
                error: 'workflow review requires grant-management access',
                code: 'forbidden',
              })
            }
            const body = await readJsonBody(req)
            const id = typeof body.id === 'string' ? body.id : ''
            const decision = body.decision === 'approve' || body.decision === 'reject' ? body.decision : undefined
            if (id === '' || decision === undefined) {
              return writeJson(res, 400, {
                error: 'workflow.review needs id and decision=approve|reject',
                code: 'invalid',
              })
            }
            if (isTeamDeployment(config)) {
              const result = await request<{ items?: unknown[] }>(host, config, '/api/ai/review/decide', {
                method: 'POST',
                body: {
                  workflows: [id],
                  decision,
                  ...(typeof body.note === 'string' ? { note: body.note } : {}),
                  authorization: { confirmed: true, reason: 'Workflow Plaza review tab' },
                },
              })
              return writeJson(res, 200, { workflow: (result.items ?? [])[0] ?? result })
            }
            const actor = await resolveWorkflowActor(host, config)
            const workflow = await reviewWorkflow(
              publishStorePath(publishDirOf(config.publishDir)),
              id,
              decision,
              actor,
              typeof body.note === 'string' ? body.note : undefined,
            )
            return writeJson(res, 200, { workflow })
          }
          case 'config.set': {
            // Persist the operator's storage choices.
            //
            // This is a deployment decision, so it needs the same authority as the other
            // operator-level writes here: read access is not enough. With no backend to ask,
            // the route refuses rather than assuming -- an unconfigured deployment has no one
            // who can legitimately claim to be an operator.
            const body = await readJsonBody(req)
            // Only the fields the panel owns are accepted. Everything else is refused
            // explicitly rather than ignored, because a silent drop would let the panel
            // report a save that did not happen.
            const allowed = new Set([
              'storageMode', 'storageProtocol', 'nfsServer',
              'sshHost', 'sshUser', 'sshPort', 'sshRemotePath', 'sshMountOptions', 'sshKeyRef', 'retrieval', 'storageRoot',
            ])
            const refused: { field: string; reason: string }[] = []
            for (const field of Object.keys(body)) {
              if (!allowed.has(field)) {
                refused.push({ field, reason: 'not a storage setting this route may write' })
              }
            }
            const storageManage = await canManageGrants(host, config)
            const vectorManage = await canManageVectorConfig()
            if (!storageManage && !vectorManage) {
              return writeJson(res, 403, {
                error: 'changing deployment settings requires grant-management or config-management access',
                refused: [{ field: '*', reason: 'authorization' }],
              })
            }
            const storageFields = new Set([
              'storageMode', 'storageProtocol', 'nfsServer',
              'sshHost', 'sshUser', 'sshPort', 'sshRemotePath', 'sshMountOptions', 'sshKeyRef', 'storageRoot',
            ])
            if (!storageManage && Object.keys(body).some(field => storageFields.has(field))) {
              return writeJson(res, 403, {
                error: 'changing storage requires grant-management access',
                refused: [{ field: '*', reason: 'authorization' }],
              })
            }
            if (!vectorManage && body.retrieval !== undefined) {
              return writeJson(res, 403, {
                error: 'changing vector retrieval requires kb:config:manage',
                refused: [{ field: 'retrieval', reason: 'authorization' }],
              })
            }
            const patch: KnowledgeStorageSettings = storageSettingsOf(body)
            // A value the validator rejected is a refusal, not a drop: the caller asked to
            // store something and must not be told it succeeded.
            for (const field of Object.keys(body)) {
              if (allowed.has(field) && (patch as Record<string, unknown>)[field] === undefined) {
                refused.push({ field, reason: 'not a recognized value' })
              }
            }
            // `storageRoot` belongs to the profile-local file. Keep it out of the
            // deployment storage record, which is stored under the path it replaces.
            const requestedRoot = typeof body.storageRoot === 'string' ? body.storageRoot.trim() : undefined
            delete (patch as { storageRoot?: string }).storageRoot
            let savedRoot: string | undefined
            if (requestedRoot !== undefined) {
              try {
                savedRoot = await writeLocalStorageRoot(requestedRoot)
              } catch (error) {
                return writeJson(res, 400, {
                  error: describeError(error).message,
                  refused: [{ field: 'storageRoot', reason: 'invalid storage path' }],
                })
              }
            }
            const saved = Object.keys(patch).length === 0
              ? await readStorageSettings(config.mountPoint)
              : await writeStorageSettings(config.mountPoint, patch)
            // The wall this route cannot climb: mountPoint/actualRoot/viewRoot are bind
            // mounts created with the container, so a shape change is recorded now and takes
            // effect when the workspace restarts. `storageRoot` is a local path and applies
            // immediately. Saying so is the difference between a saved setting and a control
            // that looks broken.
            const live = withLocalStorageRoot(withStoredStorage(deploymentConfig, saved), savedRoot ?? (await readLocalStorageSettings()).storageRoot)
            const restartRequired = live.storageMode !== config.storageMode
              || live.storageProtocol !== config.storageProtocol
              || live.nfsServer !== config.nfsServer
              || live.sshHost !== config.sshHost
              || live.sshRemotePath !== config.sshRemotePath
            return writeJson(res, 200, {
              saved: [...Object.keys(saved), ...(savedRoot === undefined ? [] : ['storageRoot'])],
              restartRequired,
              config: localConfig(live),
              ...(refused.length === 0 ? {} : { refused }),
            })
          }
          case 'config': {
            // The mounted layout is the answer, and it is the container's own fact rather
            // than a remote one, so nothing is fetched from DataOps here. The SSH key is the
            // one exception: whether the credential resolves is what decides if the mount
            // step can run, and only the credential store can answer it. The panel's saved
            // choices (including the vector group) must read back immediately.
            const liveConfig = withLocalStorageRoot(
              withStoredStorage(config, await readStorageSettings(config.mountPoint)),
              (await readLocalStorageSettings()).storageRoot,
            )
            const sshKeyConfigured = await ctx.credentials
              .resolve(credentialRef(liveConfig.sshKeyRef))
              .then(resolved => resolved !== undefined && resolved.value.trim() !== '')
              .catch(() => false)
            return writeJson(res, 200, localConfig(liveConfig, sshKeyConfigured))
          }
          case 'status': {
            // Provision the tree before answering, because this reply describes it.
            //
            // This is the request that owns the tree's shape: the page is about to read
            // the buckets, so answering before provisioning would report the
            // pre-provisioning shape and the reader would open an empty knowledge base.
            // Doing it here rather than at registration also means the write belongs to a
            // request that will be awaited: an unawaited run at boot would still be
            // writing while a caller (a test, or a teardown) removed the very directory it
            // was writing into, and the failure would surface as an unrelated ENOTEMPTY.
            //
            // `ensure` re-checks the buckets every time (they are the part that must
            // self-heal), is write-once for the tutorial, and shares one in-flight run so
            // two concurrent page loads cannot race.
            if (!initializer.hasSucceeded()) await initializer.ensure()
            // The page asks this once on mount, so the capability flag travels here
            // rather than in `config`: `config` is derived from the container's own
            // layout and stays a pure filesystem fact, while this flag is a decision
            // that costs a backend round trip.
            //
            // The decision is the Host's, never the browser's. A client that computed
            // it would be copying the authorization policy into a process the user
            // controls, where hiding a row is a rendering choice rather than a check:
            // the backend still refuses the writes, but the page would show a surface
            // it cannot use. An unconfigured backend short-circuits to false because
            // there is no authority to ask.
            const canManage = isTeamDeployment(config) && await canManageGrants(host, config)
            // The sidebar hides entries by the same backend permission keys the routes
            // enforce. A missing permissions list (older backend) keeps the old
            // role-based fallback rather than inventing a grant the caller may not have.
            let permissionKeys: string[] = []
            let permissionContext: ManagementContext | undefined
            if (isTeamDeployment(config)) {
              try {
                permissionContext = await managementHost.context()
                permissionKeys = [...permissionContext.permissions]
              } catch {
                permissionKeys = []
              }
            } else {
              // One list rather than a second copy that can drift from the context
              // the disclosure coordinator uses.
              permissionContext = localManagementContext()
              permissionKeys = [...permissionContext.permissions]
            }
            // The page load is the second existing permission read, and the one a
            // role change reaches first in a normal session. Applying the context
            // here keeps the model-facing surface in step without a per-call check.
            if (permissionContext !== undefined) {
              await toolDisclosure?.syncToolDisclosure(permissionContext)
            }
            // Build the view pointer on the first load that finds it missing.
            //
            // Without this the reader sees an empty tree and a "not generated yet"
            // notice until they find the rebuild button, even when DataOps has
            // already resolved files for them: the pointer is what the page browses,
            // and only a sync creates it. Repairing it here makes the ordinary case
            // invisible.
            //
            // Only when the pointer is missing AND a backend can answer, so a
            // healthy deployment pays no per-load cost on the NFS share: a mounted
            // pointer is classified above and never reaches this branch.
            //
            // The attempt is remembered per caller as well. A caller with nothing
            // granted gets no pointer from a sync -- there is nothing to link -- so
            // the state stays `pointer-missing` and an unguarded repair would walk
            // the shared tree and ask DataOps about every file on EVERY load. One
            // attempt per caller is enough to make the ordinary case invisible; a
            // grant that arrives later is picked up by the routine refresh below
            // rather than by the reader finding a button.
              // Local mode stores documents in the workspace itself, so there is no mount
              // to classify and nothing to synchronize. Reporting the remote vocabulary
              // here (`pointer-missing`, a sync timestamp) would describe machinery this
              // deployment does not run -- and would send the reader to a deployment screen
              // for a problem that cannot exist.
              if (config.storageMode === 'local') {
                const localOnly = await localStatus(config)
                let localCaller: {
                  userId: string
                  label: string
                  departmentCode?: string
                  departmentName?: string
                  departmentPathCodes?: string[]
                  departmentPathNames?: string[]
                } | undefined
                if (isTeamDeployment(config)) {
                  try {
                    const resolved = await fetchCaller(host, config)
                    if (isSafeUserId(resolved.userId)) {
                      // The department is forwarded, not just the id: the page tells
                      // the reader which 「部门」 tree they are looking at, and a
                      // department administrator's own scope comes from this value.
                      // Dropping it here would leave that bucket unlabeled even
                      // though the view was built from it.
                      //
                      // The organization path travels with it for the same reason one
                      // level deeper: the tree renders the folders that are on disk,
                      // and the names beside them come from here. Without the path the
                      // hierarchy still exists but every level would print its code.
                      localCaller = {
                        userId: resolved.userId,
                        label: resolved.label,
                        ...(resolved.departmentCode === undefined
                          ? {}
                          : { departmentCode: resolved.departmentCode, departmentName: resolved.departmentName ?? resolved.departmentCode }),
                        ...(resolved.departmentPathCodes === undefined
                          ? {}
                          : {
                            departmentPathCodes: resolved.departmentPathCodes,
                            departmentPathNames: resolved.departmentPathNames ?? resolved.departmentPathCodes,
                          }),
                      }
                    }
                  } catch {
                    localCaller = undefined
                  }
                }
                // The mount is still classified, not asserted: local storage says
                // where the bytes live, not whether the pointer exists. A local
                // deployment whose mount point is missing has to report `absent` for
                // the page to show the mount wording -- answering a fixed "local"
                // told every state the same story and left the page with no sentence
                // to choose, so a broken local deployment looked healthy.
                const localMountState = await classifyMount(config)
                return writeJson(res, 200, {
                  ...localOnly,
                  storageMode: "local",
                  storageProtocol: config.storageProtocol,
                  lastSyncAt: null,
                  mountState: localMountState,
                  canManageGrants: canManage,
                  canReviewWorkflows: permissionKeys.length === 0 || permissionKeys.includes('workflow:review:decide'),
                  permissions: permissionKeys,
                  ...(localCaller === undefined ? {} : { caller: localCaller }),
                  // A local deployment still answers writes, so a refresh that failed
                  // here has to be reported the same way: the reader is looking at the
                  // same tree and the same missing document.
                  ...(lastSyncFailure === undefined ? {} : { lastSyncFailure }),
                  ...(lastPruneSkipped === undefined ? {} : { pruneSkipped: lastPruneSkipped }),
                  vector: await vectorStatusPayload(),
                })
              }

            let mountState = await classifyMount(config)
            let lastSyncAt: string | null = null
            // Keyed by identity, fetched only when a repair might run: this route is
            // also the one the page calls on every load, so it must not add a backend
            // round trip to the path that needs no repair.
            let repairKey: string | null = null
            if (mountState === 'pointer-missing' && isTeamDeployment(config)) {
              try {
                const caller = await fetchCaller(host, config)
                if (isSafeUserId(caller.userId)) repairKey = caller.userId
              } catch {
                // No identity means no key to store a view under; the sync below
                // reports it rather than guessing one.
              }
            }
            if (mountState === 'pointer-missing' && isTeamDeployment(config) && (repairKey === null || !repairedCallers.has(repairKey))) {
              try {
                const repaired = await syncCallerView(host, config)
                if (!('error' in repaired)) {
                  lastSyncAt = new Date().toISOString()
                  // Remember the caller only once the attempt actually ran, so a
                  // refusal (unconfigured backend, unreadable identity) can be
                  // retried when the condition clears rather than being cached.
                  if (repairKey !== null) repairedCallers.add(repairKey)
                  // Re-classify rather than assume: a caller with no readable files
                  // still gets no pointer, because a link to a missing directory
                  // would render as "you have no files" instead of as "nothing was
                  // granted yet". Both are empty trees, so the state must come from
                  // the filesystem rather than from the sync having been attempted.
                  mountState = await classifyMount(config)
                }
              } catch {
                // A failed repair leaves the state as found; the page reports it and
                // the reader can retry with the button of their own accord.
              }
            }
            const status = await localStatus(config)
            // The routine refresh, after the one-shot repair above: that branch
            // handles a pointer that does not exist yet, while this one keeps an
            // existing view in step with grants that changed in DataOps. It is
            // gated, so a page that reads its status repeatedly pays a comparison
            // rather than another walk of the mounted tree.
            const routine = await refreshViewIfStale()
            const viewDelta = routine.delta
            if (viewDelta !== undefined) mountState = await classifyMount(config)
            // The page needs to name its caller for two things that are not
            // authorization: the save-actor registration (the editor announces "who"
            // with each save so the audit trail can record it) and the trail's own
            // display. `repairKey` already holds this identity when a repair ran, so it
            // is reused rather than fetched twice; when it did not run, one call resolves
            // it here. An unconfigured backend has no authority to ask.
            let callerIdentity: { userId: string; label: string } | undefined
            if (isTeamDeployment(config)) {
              if (repairKey !== null) {
                callerIdentity = { userId: repairKey, label: repairKey }
              } else {
                try {
                  const resolved = await fetchCaller(host, config)
                  if (isSafeUserId(resolved.userId)) {
                    callerIdentity = { userId: resolved.userId, label: resolved.label }
                  }
                } catch {
                  callerIdentity = undefined
                }
              }
            }
            return writeJson(res, 200, {
              ...status,
              storageMode: "remote",
              storageProtocol: config.storageProtocol,
              lastSyncAt: viewDelta === undefined ? lastSyncAt : new Date().toISOString(),
              mountState,
              canManageGrants: canManage,
              canReviewWorkflows: permissionKeys.length === 0 || permissionKeys.includes('workflow:review:decide'),
              permissions: permissionKeys,
            ...(callerIdentity === undefined ? {} : { caller: callerIdentity }),
              // The delta travels to the page so "did the view follow my grants"
              // is answerable without pressing anything: an unchanged set reports
              // `unchanged > 0, linked: []`, which is the zero-write case.
              ...(viewDelta === undefined ? {} : { view: viewDelta }),
              // A refresh that could not complete is a different fact from one with
              // nothing to do, and the page has to be able to say which happened.
              ...(routine.failure === undefined ? {} : { viewSyncFailure: routine.failure }),
              ...(routine.failure === undefined && lastSyncFailure === undefined
                ? {}
                : { lastSyncFailure: routine.failure ?? lastSyncFailure }),
              // The prune refusal is the signal that a full scan resolved nothing:
              // the view was kept rather than emptied, and this says so.
              ...(lastPruneSkipped === undefined ? {} : { pruneSkipped: lastPruneSkipped }),
            })
          }
          case 'trash': {
            // The caller's own removals. Scoped to the caller because removal is a
            // view decision: two people sharing a document may disagree about whether
            // it belongs in their tree, and one person's removal must not hide it
            // from the other.
            const who = await fetchCaller(host, config)
            if (!isSafeUserId(who.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id' })
            }
            const viewDir = viewPathFor({
              actualRoot: config.actualRoot,
              viewRoot: config.viewRoot,
              userId: who.userId,
            })
            const record = await readTrash(viewDir)
            if (record.kind === 'absent') return writeJson(res, 200, { entries: [] })
            if (record.kind === 'unreadable') {
              // Reported rather than emptied: an unreadable record may be hiding
              // entries, and answering "nothing removed" would offer a Restore that
              // restores nothing while the files stay hidden.
              return writeJson(res, 200, { entries: [], error: 'trash record unreadable: ' + record.reason })
            }
            return writeJson(res, 200, { entries: record.entries })
          }
          case 'trash.remove': {
            // Removing records a tombstone; it does not touch the file. See trash.ts
            // for why an unlink cannot express this on a hardlinked shared tree.
            const body = await readJsonBody(req)
            const relPath = typeof body.relPath === 'string' ? body.relPath.trim() : ''
            if (relPath === '' || !isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'a contained relPath is required' })
            }
            const who = await fetchCaller(host, config)
            if (!isSafeUserId(who.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id' })
            }
            const viewDir = viewPathFor({
              actualRoot: config.actualRoot,
              viewRoot: config.viewRoot,
              userId: who.userId,
            })
            const existing = await readTrash(viewDir)
            if (existing.kind === 'unreadable') {
              return writeJson(res, 409, { error: 'trash record unreadable: ' + existing.reason })
            }
            const entries = existing.kind === 'ready' ? existing.entries : []
            const next = addTombstone(entries, {
              relPath,
              kind: typeof body.kind === 'string' && body.kind === 'directory' ? 'directory' : 'file',
              removedBy: who.label,
              removedAt: new Date().toISOString(),
              originalPath: relPath,
            })
            await writeTrash(viewDir, next)
            // Rebuild straight away: the caller just asked for this to disappear, and
            // waiting for the next routine refresh would show it back in the listing
            // they are looking at.
            const after = await refreshViewIfStale(true)
            const reply = writeReplyAfterSync({ entries: next }, after)
            return writeJson(res, reply.status, reply.body)
          }
          case 'trash.restore': {
            // Restoring deletes the tombstone. It cannot restore a grant: the next sync
            // links only what DataOps still allows, so a document whose access was
            // withdrawn while it sat in the trash stays gone.
            const body = await readJsonBody(req)
            const relPath = typeof body.relPath === 'string' ? body.relPath.trim() : ''
            if (relPath === '' || !isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'a contained relPath is required' })
            }
            const who = await fetchCaller(host, config)
            if (!isSafeUserId(who.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id' })
            }
            const viewDir = viewPathFor({
              actualRoot: config.actualRoot,
              viewRoot: config.viewRoot,
              userId: who.userId,
            })
            const existing = await readTrash(viewDir)
            if (existing.kind === 'unreadable') {
              return writeJson(res, 409, { error: 'trash record unreadable: ' + existing.reason })
            }
            const entries = existing.kind === 'ready' ? existing.entries : []
            const result = removeTombstone(entries, relPath)
            if (!result.restored) {
              return writeJson(res, 404, { error: 'not in the trash: ' + relPath })
            }
            await writeTrash(viewDir, result.entries)
            const after = await refreshViewIfStale(true)
            // The rebuilt view is reported too, because a restore can legitimately bring
            // back nothing: the grant may have gone while the document was hidden, and
            // the caller needs to see that rather than assume the tree is broken.
            const reply = writeReplyAfterSync({ entries: result.entries }, after)
            return writeJson(res, reply.status, reply.body)
          }
          case 'grants': {
            // Authorization lives in DataOps; this route relays what the backend
            // reports and holds no policy of its own. An unconfigured backend is
            // reported as unsupported rather than as an empty grant list, so the
            // page can say why it has nothing to show.
            if (!isTeamDeployment(config)) {
              return writeJson(res, 200, { grants: [], supported: false })
            }
            try {
              const grants = await fetchGrants(host, config)
              return writeJson(res, 200, {
                grants: grants.map(grant => ({
                  id: grant.id,
                  relPath: grant.relPath,
                  kind: grant.kind,
                  principalType: grant.principalType,
                  principalId: grant.principalId,
                  action: grant.action,
                  grantedBy: grant.grantedBy,
                  grantedAt: grant.grantedAt,
                })),
                supported: true,
              })
            } catch (error) {
              return writeJson(res, 200, { grants: [], supported: true, error: describeError(error) })
            }
          }
          case 'grant': {
            const body = await readJsonBody(req)
            const request: KnowledgeGrantRequest = {
              relPath: String(body.relPath ?? ''),
              principalType: String(body.principalType ?? 'user') as KnowledgeGrantRequest['principalType'],
              principalId: String(body.principalId ?? ''),
              action: typeof body.action === 'string' ? body.action : 'read',
            }
            if (request.relPath === '' || request.principalId === '') {
              return writeJson(res, 400, { error: 'relPath and principalId are required' })
            }
            // The product's five actions are translated into the DataOps actions
            // that would satisfy them, and the translation is refused outright for
            // an action DataOps cannot express. Recording a made-up action would
            // store a grant that authorizes nothing while the screen shows it as
            // held, which is the one failure mode a permission table must not have.
            if (!isKnowledgeAction(request.action)) {
              return writeJson(res, 400, {
                error: 'unknown action: ' + JSON.stringify(request.action),
                accepted: [...KNOWLEDGE_ACTIONS],
              })
            }
            const dataOpsActions = permissionToDataOpsActions(request.action)
            if (dataOpsActions.length === 0) {
              return writeJson(res, 400, { error: 'action cannot be expressed in DataOps: ' + request.action })
            }
            const created = await createGrant(host, config, request)
            // A grant just changed what this caller may read, so the view is rebuilt
            // before the page re-reads it. This is the moment the change is certain
            // rather than suspected, which is why it does not wait for the interval.
            const afterGrant = await refreshViewIfStale(true)
            const reply = writeReplyAfterSync({ grant: created }, afterGrant)
            return writeJson(res, reply.status, reply.body)
          }
          case 'templates': {
            // The template library: a document plus a small metadata record for each.
            //
            // The library used to relay DataOps wiki pages carrying the
            // `report_template` category, which made the surface read-only and, in
            // practice, permanently empty -- the wiki holds no page in that category.
            // A template is just a document with a description, so it is stored as
            // exactly that: the file under a directory the knowledge base owns, and a
            // sibling JSON index for the metadata. No second data model, and no write
            // endpoint added to DataOps.
            //
            // Read from the AUTHORITATIVE tree rather than the caller's view, because
            // a template is shared content: a view is rewritten by the next sync.
            const plan = localConfig(config)
            try {
              const records = await readTemplates(plan.actualRoot)
              const templates = await Promise.all(records.map(async record => {
                const bytes = await templateBytes(plan.actualRoot, record.fileName)
                const dot = record.fileName.lastIndexOf('.')
                return {
                  id: record.id,
                  title: record.title,
                  description: record.description,
                  category: record.category,
                  tags: record.tags,
                  fileName: record.fileName,
                  extension: dot === -1 ? '' : record.fileName.slice(dot + 1).toLowerCase(),
                  bytes,
                  updatedAt: record.updatedAt,
                  relPath: '.kb-templates/' + record.fileName,
                }
              }))
              return writeJson(res, 200, { templates })
            } catch (error) {
              // "Could not read" is a different fact from "there are none", so the
              // two are never merged into one empty list.
              return writeJson(res, 200, { templates: [], error: describeError(error).message })
            }
          }
          case 'template.save': {
            // Add or replace one template. Gated on write access to the template
            // directory, asked of DataOps like every other write here, so a template
            // cannot be curated by someone who may not write the knowledge base.
            const body = await readJsonBody(req)
            const fileName = String(body.fileName ?? '').trim()
            const title = String(body.title ?? '').trim()
            if (fileName === '' || title === '') {
              return writeJson(res, 400, { error: 'title and fileName are required' })
            }
            const relPath = TEMPLATE_WRITE_PATH
            if (!await canWritePath(host, config, relPath)) {
              return writeJson(res, 403, { error: 'write access is required to maintain templates' })
            }
            try {
              const plan = localConfig(config)
              const saved = await saveTemplate(plan.actualRoot, {
                title,
                description: String(body.description ?? ''),
                category: String(body.category ?? ''),
                tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
                fileName,
                ...(typeof body.content === 'string' ? { content: body.content } : {}),
                ...(typeof body.id === 'string' && body.id !== '' ? { id: body.id } : {}),
              })
              const dot = saved.fileName.lastIndexOf('.')
              return writeJson(res, 200, {
                template: {
                  id: saved.id,
                  title: saved.title,
                  description: saved.description,
                  category: saved.category,
                  tags: saved.tags,
                  fileName: saved.fileName,
                  extension: dot === -1 ? '' : saved.fileName.slice(dot + 1).toLowerCase(),
                  bytes: await templateBytes(plan.actualRoot, saved.fileName),
                  updatedAt: saved.updatedAt,
                  relPath: '.kb-templates/' + saved.fileName,
                },
              })
            } catch (error) {
              return writeJson(res, 400, { error: describeError(error).message })
            }
          }
          case 'template.remove': {
            // Take one template offline: its document and its metadata record.
            const body = await readJsonBody(req)
            const id = String(body.id ?? '').trim()
            if (id === '') return writeJson(res, 400, { error: 'id is required' })
            if (!await canWritePath(host, config, TEMPLATE_WRITE_PATH)) {
              return writeJson(res, 403, { error: 'write access is required to maintain templates' })
            }
            const plan = localConfig(config)
            return writeJson(res, 200, { removed: await removeTemplate(plan.actualRoot, id) })
          }
          case 'create': {
            // Start a document or a folder in the authoritative tree.
            //
            // The path lands under `actual/`, not the caller's view, and the reason
            // is in `createKnowledgeEntry`: a view is a mirror that the next sync
            // rewrites, so a document stored there is deleted by any later
            // permission change. `actual/` is the tree that survives, which makes
            // creating a SHARED act by construction.
            //
            // Write access is required and is asked of DataOps BEFORE anything is
            // written, so a caller without it gets a refusal rather than a file they
            // cannot see. The decision is the backend's; this route only relays it,
            // the same way every other route does.
            const body = await readJsonBody(req)
            let relPath = String(body.relPath ?? '')
            const directory = body.kind === 'directory'
            const refusal = personalPathRefusal(config, relPath)
            if (refusal !== undefined) {
              return writeJson(res, 400, { error: refusal.reason, code: refusal.code, refused: [relPath] })
            }
            if (relPath.trim() === '') {
              return writeJson(res, 400, { error: 'relPath is required' })
            }
            if (!isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'path escapes the knowledge root', refused: [relPath] })
            }
            const caller = await fetchCaller(host, config).catch(() => undefined)
            if (caller === undefined || !isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe or unreadable caller id' })
            }
            relPath = normalizePersonalWritePath(relPath, caller.userId)
            if (!isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'path escapes the knowledge root', refused: [relPath] })
            }
            if (!await canWritePath(host, config, relPath)) {
              // Fail closed: an unreadable answer is a refusal, and the refusal
              // happens here rather than after a partial write.
              return writeJson(res, 403, { error: 'write access is required to create this path', refused: [relPath] })
            }
            try {
              // Review is a setting, not a second code path: when it is on, the write
              // is PARKED with its bytes so an approver can read exactly what was
              // submitted, and nothing appears in the shared tree until it is applied.
              // When it is off (the default) the write applies and the audit trail is
              // the only record, which is the behaviour the operator chose.
              const createPlan = localConfig(config)
              const createViewDir = viewPathFor({
                actualRoot: createPlan.actualRoot,
                viewRoot: createPlan.viewRoot,
                userId: caller.userId,
              })
              const createSettings = await readSettings(createViewDir)
              if (createSettings.reviewRequired) {
                const at = new Date().toISOString()
                await parkPendingWrite(createPlan.actualRoot, {
                  userId: caller.userId,
                  relPath,
                  content: typeof body.content === 'string' ? body.content : '',
                  at,
                })
                await appendAuditEntry(createViewDir, {
                  at,
                  actor: caller.userId,
                  actorLabel: caller.label,
                  action: 'create',
                  relPath,
                  outcome: 'pending',
                }).catch(() => undefined)
                return writeJson(res, 202, { pending: relPath, reviewRequired: true })
              }
              const created = await createKnowledgeEntry(config, relPath, {
                directory,
                ...(typeof body.content === 'string' ? { content: body.content } : {}),
              })
              // Record what just happened before answering, but never let a recording
              // failure change the answer: the document is already on disk, so reporting
              // an error here would describe a failure that did not occur. The view dir
              // resolved above is reused rather than recomputed.
              await appendAuditEntry(createViewDir, {
                at: new Date().toISOString(),
                actor: caller.userId,
                actorLabel: caller.label,
                action: 'create',
                relPath,
                outcome: 'applied',
              }).catch(() => undefined)
              // The creator should see their own document at once rather than after
              // the routine interval, and this is the moment the view is known to be
              // stale because this process just changed what it must contain.
              const afterWrite = await refreshViewIfStale(true, created.relPath)
              // A folder has nothing to extract or index. A file completes the pipeline
              // here, so the document the creator just made is searchable without a
              // second action.
              const pipeline = directory ? {} : await afterDocumentWrite(created.relPath, caller)
              const reply = writeReplyAfterSync({ created, ...pipeline }, afterWrite)
              return writeJson(res, reply.status, reply.body)
            } catch (error) {
              if (error instanceof KnowledgeWriteError) {
                return writeJson(res, writeStatusFor(error.code), { error: error.message, code: error.code })
              }
              return writeJson(res, 500, { error: describeError(error).message })
            }
          }
          case 'edit': {
            // Replace one existing document's bytes, IN PLACE.
            //
            // This route exists because the host's own editor saves with
            // write-temp-then-rename, and a rename replaces the inode. The caller's
            // view holds this document as a hardlink to the authoritative copy, so a
            // renamed file leaves the view pointing at the old bytes -- measured:
            // editing through the host's editor updated `actual/` to inode 1486290
            // while `views/<user>/` still reported the old content from inode
            // 1486289. Writing in place keeps the link whole, so every view sees the
            // save immediately.
            //
            // Authorization is the write action on this path, asked of DataOps. The
            // page hides the editor for callers without it, but that is a rendering
            // choice: this check is the one that decides.
            const body = await readJsonBody(req)
            const relPath = String(body.relPath ?? '')
            const content = typeof body.content === 'string' ? body.content : undefined
            const refusal = personalPathRefusal(config, relPath)
            if (refusal !== undefined) {
              return writeJson(res, 400, { error: refusal.reason, code: refusal.code, refused: [relPath] })
            }
            if (relPath === '') return writeJson(res, 400, { error: 'relPath is required' })
            if (content === undefined) return writeJson(res, 400, { error: 'content is required' })
            if (!isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'path escapes the knowledge root', refused: [relPath] })
            }
            try {
              if (!await canWritePath(host, config, relPath)) {
                return writeJson(res, 403, { error: 'the caller may not write this document', code: 'forbidden' })
              }
              const plan = localConfig(config)
              const full = join(plan.actualRoot, relPath)
              // Refuse to create through an edit: "replace the bytes of a document
              // that exists" is a different operation from "make a document", and one
              // route that quietly did both would make an audit trail unable to say
              // which happened.
              const existing = await stat(full).catch(() => undefined)
              if (existing === undefined || !existing.isFile()) {
                return writeJson(res, 404, { error: 'no document at ' + relPath, code: 'not-found' })
              }
              // `writeFile` with no flag truncates in place, which is exactly the
              // semantic this route exists for.
              await writeFile(full, content, { encoding: 'utf8' })
              markInternalMutation(relPath)
              const after = await stat(full).catch(() => undefined)
              const caller = await fetchCaller(host, config).catch(() => undefined)
              let auditWritten = false
              if (caller !== undefined && isSafeUserId(caller.userId)) {
                const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
                try {
                  await appendAuditEntry(viewDir, {
                    at: new Date().toISOString(),
                    actor: caller.userId,
                    actorLabel: caller.label,
                    action: 'edit',
                    relPath,
                    outcome: 'applied',
                  })
                  auditWritten = true
                } catch {
                  // The save already landed. An audit write that fails must not turn a
                  // successful edit into an error the reader has to guess about.
                  auditWritten = false
                }
              }
              // The save is durable; indexing it is the next step, not a condition of success.
              const editCaller: KnowledgeCaller = caller ?? {
                userId: LOCAL_USER_ID,
                label: 'local',
                roleCodes: [],
              }
              const pipeline = await afterDocumentWrite(relPath, editCaller, { replaceSibling: true })
              return writeJson(res, 200, {
                relPath,
                auditWritten,
                ...pipeline,
                ...(after === undefined ? {} : { mtimeMs: after.mtimeMs, size: after.size }),
              })
            } catch (error: unknown) {
              if (error instanceof KnowledgeWriteError) {
                return writeJson(res, writeStatusFor(error.code), { error: error.message, code: error.code })
              }
              return writeJson(res, 500, { error: describeError(error).message })
            }
          }
          case 'audit.append': {
            // Record a save this plugin did not perform.
            //
            // The host's file editor writes through its own route. Rather than
            // intercepting that route (which would mean owning the editor), the page
            // reports the save it observed and the trail stays complete. The record is
            // side-band: a failure here never blocks or undoes the save that already
            // happened, so this route is safe to call from a best-effort reporter.
            const body = await readJsonBody(req)
            const relPath = String(body.relPath ?? '')
            const action = body.action === 'edit' || body.action === 'create' ? body.action : 'edit'
            if (relPath === '') return writeJson(res, 400, { error: 'relPath is required' })
            if (!isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'path escapes the knowledge root', refused: [relPath] })
            }
            try {
              const caller = await fetchCaller(host, config)
              if (!isSafeUserId(caller.userId)) {
                return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
              }
              const plan = localConfig(config)
              const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
              await appendAuditEntry(viewDir, {
                at: new Date().toISOString(),
                actor: caller.userId,
                actorLabel: caller.label,
                action,
                relPath,
                outcome: 'applied',
              })
              return writeJson(res, 200, { recorded: true })
            } catch (error: unknown) {
              return writeJson(res, 200, { recorded: false, error: describeError(error).message })
            }
          }
          case 'upload': {
            // The same landing place and the same permission gate as `create`; only
            // the body differs. Size is checked before the write because the body is
            // buffered in memory, so an uncaught large post would be paid for in heap
            // rather than answered with a refusal.
            const body = await readJsonBody(req)
            let relPath = String(body.relPath ?? '')
            // A dropped binary file arrives base64-encoded: the browser reads it as
            // bytes and this route must not decode it as UTF-8, which would replace
            // every non-text byte and write a document nobody can open.
            const encoding = body.encoding === 'base64' ? 'base64' : 'utf8'
            const content = typeof body.content === 'string' ? body.content : ''
            const refusal = personalPathRefusal(config, relPath)
            if (refusal !== undefined) {
              return writeJson(res, 400, { error: refusal.reason, code: refusal.code, refused: [relPath] })
            }
            if (relPath.trim() === '') {
              return writeJson(res, 400, { error: 'relPath is required' })
            }
            if (!isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'path escapes the knowledge root', refused: [relPath] })
            }
            const payloadBytes = encoding === 'base64'
              ? Buffer.from(content, 'base64')
              : Buffer.from(content, 'utf8')
            if (payloadBytes.byteLength > MAX_KNOWLEDGE_WRITE_BYTES) {
              return writeJson(res, 413, {
                error: 'file exceeds the ' + String(MAX_KNOWLEDGE_WRITE_BYTES) + ' byte limit',
                code: 'too-large',
                limitBytes: MAX_KNOWLEDGE_WRITE_BYTES,
              })
            }
            const caller = await fetchCaller(host, config).catch(() => undefined)
            if (caller === undefined || !isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe or unreadable caller id' })
            }
            relPath = normalizePersonalWritePath(relPath, caller.userId)
            if (!isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'path escapes the knowledge root', refused: [relPath] })
            }
            if (!await canWritePath(host, config, relPath)) {
              return writeJson(res, 403, { error: 'write access is required to upload here', refused: [relPath] })
            }
            try {
              // Same review gate as `create`: the switch decides whether this lands
              // in the shared tree now or waits with its bytes for an approver.
              const uploadPlan = localConfig(config)
              const uploadViewDir = viewPathFor({
                actualRoot: uploadPlan.actualRoot,
                viewRoot: uploadPlan.viewRoot,
                userId: caller.userId,
              })
              const uploadSettings = await readSettings(uploadViewDir)
              if (uploadSettings.reviewRequired) {
                const at = new Date().toISOString()
                await parkPendingWrite(uploadPlan.actualRoot, {
                  userId: caller.userId,
                  relPath,
                  content,
                  at,
                })
                await appendAuditEntry(uploadViewDir, {
                  at,
                  actor: caller.userId,
                  actorLabel: caller.label,
                  action: 'upload',
                  relPath,
                  outcome: 'pending',
                }).catch(() => undefined)
                return writeJson(res, 202, { pending: relPath, reviewRequired: true })
              }
              const created = await createKnowledgeEntry(config, relPath, {
                directory: false,
                content: encoding === 'base64' ? undefined : content,
                ...(encoding === 'base64' ? { bytes: payloadBytes } : {}),
              })
              // Recorded before answering, and a recording failure never changes the
              // answer: the bytes are already on disk.
              await appendAuditEntry(uploadViewDir, {
                at: new Date().toISOString(),
                actor: caller.userId,
                actorLabel: caller.label,
                action: 'upload',
                relPath,
                outcome: 'applied',
              }).catch(() => undefined)
              const afterWrite = await refreshViewIfStale(true, created.relPath)
              // Extraction is enqueued AFTER the reply is built, and never awaited.
              //
              // The document's bytes are what the uploader handed over, and the tree must
              // show them now. The `.md` sibling is derived text that can take a minute
              // (MinerU on a scanned PDF, LibreOffice on a legacy .doc); waiting for it
              // here made a slow parse read as a slow upload, and a failed parse read as
              // a failed upload. `enqueue` cannot throw, so the upload's answer is already
              // decided by the two calls above and nothing below can change it.
              //
              // The accepted task travels back as `extraction`, so the page can show
              // "extracting…" instead of guessing, and a reader can read the outcome
              // through `extract.status` once it finishes.
              const extraction = extractionQueue.enqueue(relPath, uploadSettings.mineruBaseUrl)
              // A Markdown/text upload has nothing to extract, so the queue resolves it
              // at `already-markdown` and no index pass would ever run for it. Index it
              // here instead; the two are exclusive so a binary is never indexed twice.
              const pipeline = isIndexableTextPath(relPath)
                ? await afterDocumentWrite(created.relPath, caller, { mineruBaseUrl: uploadSettings.mineruBaseUrl })
                : { extraction }
              const reply = writeReplyAfterSync({ created, ...pipeline }, afterWrite)
              return writeJson(res, reply.status, reply.body)
            } catch (error) {
              if (error instanceof KnowledgeWriteError) {
                return writeJson(res, writeStatusFor(error.code), { error: error.message, code: error.code })
              }
              return writeJson(res, 500, { error: describeError(error).message })
            }
          }
          case 'revoke': {
            const body = await readJsonBody(req)
            const request: KnowledgeRevokeRequest = {
              relPath: String(body.relPath ?? ''),
              principalType: String(body.principalType ?? 'user') as KnowledgeRevokeRequest['principalType'],
              principalId: String(body.principalId ?? ''),
              action: typeof body.action === 'string' ? body.action : 'read',
            }
            if (request.relPath === '' || request.principalId === '') {
              return writeJson(res, 400, { error: 'relPath and principalId are required' })
            }
            const revoked = await revokeGrant(host, config, request)
            // A revoke removes access, so the view must shrink before the next read
            // rather than at the next interval: leaving a revoked path linked would
            // keep it visible for up to that long.
            const afterRevoke = await refreshViewIfStale(true)
            const reply = writeReplyAfterSync({ revoked }, afterRevoke)
            return writeJson(res, reply.status, reply.body)
          }
          case 'list': {
            // A directory listing that carries each entry's modification time.
            //
            // The borrowed tree's own entry shape has no timestamp, so a row built
            // from it can never show one. This route reads the same directory but
            // stats each child, which is what lets the page show when a document
            // last changed.
            //
            // Every row here has been resolved as readable by DataOps, and a row
            // that could not be resolved is not returned at all. `permissionsResolved`
            // therefore says whether the permission question could be ASKED (a
            // configured backend and a caller id), not whether each answer was yes:
            // when it is true the listing is the caller's verified set, and when it
            // is false the listing is empty because nothing was verified.
            const body = await readJsonBody(req)
            const rel = String(body.path ?? '')
            const root = localConfig(config).mountPoint
            const target = rel === '' ? root : join(root, rel)
            const wantPermissions = body.permissions !== false
            // A personal deployment resolves permissions without asking anybody: the
            // operator may read the tree, bounded by the knowledge root. It therefore takes
            // the ordinary path below rather than this early return, with a synthetic caller
            // id, so the listing a reader sees is built by the same code either way.
            //
            // `permissionsResolved` stays honest: it reports whether a permission question
            // was answered, and in a personal deployment the answer is the local boundary.
            const personal = !isTeamDeployment(config)
            // Only a caller that explicitly asked for an unfiltered listing short-circuits.
            // A personal deployment continues to the listing below: its "permission answer"
            // is the local boundary, and the rows are filtered by it inside
            // `listDirectoryWithPermissions`. Returning early here would show an empty tree.
            if (!wantPermissions) {
              return writeJson(res, 200, { entries: [], permissionsResolved: false })
            }
            // The tree is what the reader is looking at, so it is the read that
            // repairs itself. The call is gated by the interval above and returns
            // on an integer comparison while the gate is closed, which is what keeps
            // this from walking an NFS tree on every level the reader expands.
            await refreshViewIfStale()
            let callerId: string | undefined
            let callerFailure: string | undefined
            if (personal) {
              // No account system to ask; the view is keyed by the fixed local id so the
              // view plumbing below runs unchanged.
              callerId = LOCAL_USER_ID
            } else {
              try {
                callerId = (await fetchCaller(host, config)).userId
              } catch (error) {
                callerId = undefined
                callerFailure = describeError(error).message
              }
            }
            // A listing the permission service could not answer is reported as an
            // unavailable decision, never as an empty directory.
            //
            // It used to answer 200 with `entries: []` in this case. That is
            // indistinguishable from "this folder has no documents", so a reader whose
            // credential had merely gone stale was told their knowledge base was empty --
            // and the page had nothing to act on. The empty result is a fact about the
            // permission check, not about the directory, so it travels with a status and
            // a reason.
            if (callerId === undefined) {
              return writeJson(res, 403, {
                entries: [],
                permissionsResolved: false,
                error: 'the permission service did not identify this caller',
                detail: callerFailure,
              })
            }
            const visible = await listDirectoryWithPermissions(host, config, root, target, callerId)
            // Two derived flags per row, so the page can offer "extract markdown"
            // without asking the Host about each file it renders.
            //
            // `canExtract` answers whether a reader exists for this format. `hasMarkdown`
            // answers whether the sibling is already on disk, which is what lets the menu
            // show "already extracted" instead of running a parse that would be refused.
            // Both are computed from the names in this one listing, so a directory of N
            // rows costs one readdir, not N stats.
            const present = new Set(visible.map(entry => entry.name))
            const entries: KnowledgeEntry[] = visible.map((entry) => {
              if (entry.isDir) return entry
              const extractable = isExtractable(entry.relPath)
              return {
                ...entry,
                canExtract: extractable,
                hasMarkdown: extractable ? present.has(entry.name + '.md') : false,
              }
            })
            return writeJson(res, 200, {
              entries,
              // The number of rows in this directory level before any client-side
              // paging. `list` returns a whole level rather than a page, so this is also
              // what a paginator needs for its page count without counting rows itself.
              // Named explicitly so a future server-side page can keep the field's
              // meaning while `entries` shrinks.
              total: entries.length,
              permissionsResolved: true,
            })
          }
          case 'extract.status': {
            // What this process knows about extraction, which is deliberately all it
            // knows: the queue is in memory, so a task that survived a restart is gone.
            //
            // A file that is neither in `tasks` nor beside an `.md` sibling is therefore
            // "never attempted in this process" or "attempted, then the process restarted"
            // -- and `list`'s `hasMarkdown` is what tells those two apart from the disk,
            // which is the authority. The snapshot never claims something is running that
            // is not: `running` is read from the worker itself, not from a stored flag.
            return writeJson(res, 200, extractionQueue.snapshot())
          }
          case 'index.status': {
            // Read-only view of the plugin's own SQLite index. The DataOps backend has
            // no per-document index view, and the file list only needs counts.
            //
            // Routed through `documentIndexStatus` so this answer and the one a write
            // reports cannot disagree. It matches the SOURCE path too: the index stores
            // the text file it chunked (`报告.docx.md`), while the reader clicks the
            // document (`报告.docx`).
            const body = await readJsonBody(req)
            const relPath = typeof body.path === 'string' ? body.path.trim() : ''
            const docId = Number(body.docId)
            if (Number.isInteger(docId) && docId > 0) {
              const db = new DatabaseSync(indexPathFor(config.indexDir))
              try {
                const row = db.prepare('select id, path, scope, mtime from kb_docs where id = ?').get(docId) as
                  { id: number; path: string; scope: string; mtime: number } | undefined
                if (row === undefined) return writeJson(res, 200, { found: false })
                const count = db.prepare('select count(*) as n from kb_chunks where doc_id = ?').get(row.id) as { n?: number } | undefined
                return writeJson(res, 200, {
                  found: true,
                  docId: row.id,
                  path: row.path,
                  scope: row.scope,
                  chunks: Number(count?.n ?? 0),
                  indexedAt: row.mtime,
                })
              } finally {
                db.close()
              }
            }
            if (relPath === '') return writeJson(res, 200, { found: false })
            // The page asks with its VIEW spelling; the index stores authoritative
            // paths, so resolve the hardlink first (and fall back to the spelling the
            // caller sent when the file is already authoritative).
            const actualRelPath = await actualRelPathForView(host, config, relPath).catch(() => relPath)
            const status = documentIndexStatus(indexPathFor(config.indexDir), actualRelPath)
            return writeJson(res, 200, status.found
              ? {
                found: true,
                docId: status.docId,
                path: status.path,
                scope: status.scope,
                chunks: status.chunks,
                indexedAt: status.indexedAt,
              }
              : { found: false })
          }
          case 'extract.retry': {
            // Re-run extraction for one document, for the case the upload path could not
            // finish: a scanned PDF whose parser was down, a legacy `.doc` with no
            // LibreOffice, a file dropped in by a copy that bypassed upload entirely.
            //
            // Permission is the same gate as `upload`/`create`: a caller who may not write
            // the path may not spend the deployment's parser on it either.
            const body = await readJsonBody(req)
            const relPath = String(body.relPath ?? '')
            const refusal = personalPathRefusal(config, relPath)
            if (refusal !== undefined) {
              return writeJson(res, 400, { error: refusal.reason, code: refusal.code, refused: [relPath] })
            }
            if (relPath.trim() === '') {
              return writeJson(res, 400, { error: 'relPath is required' })
            }
            if (!isContainedRelPath(relPath)) {
              return writeJson(res, 400, { error: 'path escapes the knowledge root', refused: [relPath] })
            }
            // The tree speaks the caller's VIEW path (`global/…`, `personal/…`), while
            // the queue and the filesystem speak the AUTHORITATIVE path. Resolve by inode
            // before touching the disk: the view's `global` bucket can hardlink a file
            // that actually lives at the actual root, and a personal row hides the owner
            // segment. Without this a right-click answered `404 no such file`.
            const actualRelPath = await actualRelPathForView(host, config, relPath).catch(() => relPath)
            // A Markdown document is already the thing an extraction produces, so there is
            // nothing to run. This is checked BEFORE the "no extractor" branch: `.md` is
            // not in `EXTRACTABLE_EXTENSIONS`, so it used to fall through and be reported
            // as an unreadable format, which told a reader their own Markdown file could
            // not be read.
            if (isAlreadyMarkdown(actualRelPath)) {
              // Recorded as a task so the progress panel shows the request and its
              // outcome: a click that leaves no trace reads as a broken button. The queue
              // resolves it immediately at `already-markdown` because there is no work to
              // do -- this is a terminal success, not a failure.
              // No parser settings needed: nothing will be run for this task.
              extractionQueue.enqueue(actualRelPath, '')
              return writeJson(res, 200, {
                outcome: 'already-markdown',
                relPath: actualRelPath,
                message: 'this document is already Markdown',
              })
            }
            // No reader for this format is a definite answer, not a failure: the caller
            // asked and the honest reply is that this file type is never extractable.
            if (!isExtractable(actualRelPath)) {
              return writeJson(res, 200, {
                outcome: 'unsupported',
                relPath: actualRelPath,
                message: 'this file type has no extractor',
              })
            }
            const localRoot = localConfig(config)
            const target = join(localRoot.actualRoot, actualRelPath)
            const source = await stat(target).catch(() => undefined)
            if (source === undefined || !source.isFile()) {
              return writeJson(res, 404, { error: 'no such file' })
            }
            if (!await canWritePath(host, config, actualRelPath)) {
              return writeJson(res, 403, { error: 'write access is required to extract here', refused: [relPath] })
            }
            // Already extracted: report it instead of overwriting. A sibling the reader
            // may have edited by hand must not be silently replaced by a retry.
            const sibling = markdownSiblingOf(actualRelPath)
            const existing = await stat(join(localRoot.actualRoot, sibling)).catch(() => undefined)
            if (existing !== undefined && existing.isFile()) {
              return writeJson(res, 200, { outcome: 'exists', relPath: actualRelPath, markdown: sibling })
            }
            const viewDir = viewPathFor({
              actualRoot: localRoot.actualRoot,
              viewRoot: localRoot.viewRoot,
              userId: (await fetchCaller(host, config).catch(() => undefined))?.userId ?? '',
            })
            const settings = await readSettings(viewDir)
            // ONE extraction, whichever way the caller asked.
            //
            // Both branches enqueue and then wait on the TASK, never running an
            // extraction of their own. An earlier version ran `extractBeside` inline and
            // enqueued a second copy so the status surface would stay current: that
            // parsed the document twice, and the route answered from one run while
            // `extract.status` reported the other. `settled(relPath)` is what keeps a
            // single truth -- the state this route returns IS the state the status
            // surface shows for that path.
            const accepted = extractionQueue.enqueue(actualRelPath, settings.mineruBaseUrl)
            // `wait` lets the menu be a single call for the common case while still
            // allowing a caller to fire-and-poll when the parse is long.
            if (body.wait === false) {
              return writeJson(res, 202, { outcome: 'queued', relPath: actualRelPath, extraction: accepted })
            }
            const settled = await extractionQueue.settled(actualRelPath)
            // Unreachable in practice (`enqueue` above always records a task), but a
            // route must not dereference a missing task: an unknown outcome is reported
            // as a failure with a reason rather than as a success.
            const outcome: ExtractionOutcome = settled === undefined
              ? { state: 'failed', reason: 'the extraction task was not recorded' }
              : {
                state: settled.state === 'succeeded' ? 'succeeded' : settled.state === 'unsupported' ? 'unsupported' : 'failed',
                ...(settled.markdown === undefined ? {} : { markdown: settled.markdown }),
                ...(settled.via === undefined ? {} : { via: settled.via }),
                ...(settled.reason === undefined ? {} : { reason: settled.reason }),
              }
            if (outcome !== undefined && outcome.markdown !== '' && outcome.reason === undefined) {
              // The sibling is a new file in the tree, so the reader's view needs the
              // same refresh any other write gets; 207 reports a refresh that failed.
              const afterWrite = await refreshViewIfStale(true, sibling)
              const reply = writeReplyAfterSync({
                outcome: 'extracted',
                relPath,
                markdown: outcome.markdown,
                ...(outcome.via === undefined ? {} : { via: outcome.via }),
              }, afterWrite)
              return writeJson(res, reply.status, reply.body)
            }
            return writeJson(res, 200, {
              outcome: outcome.state === 'unsupported' ? 'unsupported' : 'failed',
              relPath,
              ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
              ...(outcome.markdown === undefined ? {} : { markdown: outcome.markdown }),
            })
          }
          case 'search': {
            const body = await readJsonBody(req)
            const term = String(body.term ?? '')
            const root = localConfig(config).mountPoint
            return writeJson(res, 200, { hits: await searchKnowledge(root, term) })
          }
          case 'chunk': {
            // The citation viewer resolves a chunk token here: the token itself stays
            // compact (kb://doc/<id>/chunk/<id>) while the boxes remain in SQLite.
            const body = await readJsonBody(req)
            const docId = Number(body.docId)
            if (!Number.isInteger(docId) || docId <= 0) {
              return writeJson(res, 400, { error: 'docId must be a positive integer' })
            }
            const chunkId = await findChunkId({
              indexPath: knowledgeIndexPath(),
              docId,
              chunkId: typeof body.chunkId === 'string' ? body.chunkId : Number(body.chunkId),
            })
            if (chunkId === undefined) {
              return writeJson(res, 404, { error: 'chunk not found', code: 'not-found' })
            }
            const chunk = await readChunkProvenance({
              indexPath: knowledgeIndexPath(),
              docId,
              chunkId,
              ...(typeof body.query === 'string' ? { query: body.query } : {}),
            })
            if (chunk === undefined) return writeJson(res, 404, { error: 'chunk not found' })
            if (!await canReadPath(host, config, chunk.path)) {
              return writeJson(res, 403, { error: 'read access is required', code: 'forbidden' })
            }
            // Return the mounted view path of the ORIGINAL source (pdf/docx/xlsx),
            // plus the derived Markdown path as an internal-reading hint.
            const caller = await fetchCaller(host, config)
            const plan = localConfig(config)
            const viewOptions = {
              actualRoot: plan.actualRoot,
              viewRoot: plan.viewRoot,
              userId: caller.userId,
              ...(caller.departmentCode === undefined || caller.departmentCode === null ? {} : { departmentCode: caller.departmentCode }),
              ...(caller.departmentPathCodes === undefined ? {} : { departmentPathCodes: caller.departmentPathCodes }),
            }
            const sourceActual = chunk.sourcePath ?? chunk.path
            const markdownActual = chunk.markdownPath ?? chunk.path
            return writeJson(res, 200, {
              ...chunk,
              path: expectedViewPathFor(viewOptions, sourceActual) ?? sourceActual,
              displayPath: localizedScopeForPath(expectedViewPathFor(viewOptions, sourceActual) ?? sourceActual, config.scopeLocale),
              markdownPath: expectedViewPathFor(viewOptions, markdownActual) ?? markdownActual,
              citation: citationTokenForChunk(chunk.docId, chunk.chunkKey, chunk.chunkId),
            })
          }
          case 'resolve': {
            // Inline markdown links carry a derived path (`x.docx.md`) and a line.
            // Resolve that pair to the original document's chunk so the viewer can
            // open the source and draw boxes instead of opening the `.md` sibling.
            const body = await readJsonBody(req)
            const rawPath = typeof body.path === 'string' ? body.path.trim() : ''
            if (rawPath === '') return writeJson(res, 400, { error: 'path is required' })
            const lineValue = body.line === undefined ? undefined : Number(body.line)
            if (lineValue !== undefined && (!Number.isInteger(lineValue) || lineValue <= 0)) {
              return writeJson(res, 400, { error: 'line must be a positive integer' })
            }
            // A pre-fix index stored drifted chunk line anchors. Read the requested markdown
            // line and let the resolver prefer the chunk that actually contains it, so a
            // `x.docx.md:193` link does not land on the last chunk until the index is rebuilt.
            const plan = localConfig(config)
            let lineText: string | undefined
            if (lineValue !== undefined) {
              const relative = rawPath
                .replace(/^\/workspace\/kb\//u, '')
                .replace(/^global\//u, '')
                .replace(/^全局\//u, '')
              try {
                const text = await readFile(join(plan.actualRoot, relative), 'utf8')
                lineText = text.split('\n')[lineValue - 1]?.trim()
              } catch {
                lineText = undefined
              }
            }
            const match = await findChunkForPath({
              indexPath: knowledgeIndexPath(),
              path: rawPath,
              ...(lineValue === undefined ? {} : { line: lineValue }),
              ...(lineText === undefined || lineText === '' ? {} : { lineText }),
            })
            if (match === undefined) {
              return writeJson(res, 404, { error: 'no chunk for this path/line', code: 'not-found' })
            }
            const chunk = await readChunkProvenance({
              indexPath: knowledgeIndexPath(),
              docId: match.docId,
              chunkId: match.chunkId,
            })
            if (chunk === undefined) return writeJson(res, 404, { error: 'no chunk for this path/line', code: 'not-found' })
            if (!await canReadPath(host, config, chunk.path)) {
              return writeJson(res, 403, { error: 'read access is required', code: 'forbidden' })
            }
            const caller = await fetchCaller(host, config)
            const viewOptions = {
              actualRoot: plan.actualRoot,
              viewRoot: plan.viewRoot,
              userId: caller.userId,
              ...(caller.departmentCode === undefined || caller.departmentCode === null ? {} : { departmentCode: caller.departmentCode }),
              ...(caller.departmentPathCodes === undefined ? {} : { departmentPathCodes: caller.departmentPathCodes }),
            }
            const sourceActual = chunk.sourcePath ?? chunk.path
            const viewPath = expectedViewPathFor(viewOptions, sourceActual) ?? sourceActual
            return writeJson(res, 200, {
              docId: chunk.docId,
              chunkId: chunk.chunkId,
              path: viewPath,
              displayPath: localizedScopeForPath(viewPath, config.scopeLocale),
              citation: citationTokenForChunk(chunk.docId, chunk.chunkKey, chunk.chunkId),
              quote: chunk.quote,
              heading: chunk.heading,
              paragraph: chunk.paragraph,
              chunkOrdinal: chunk.chunkOrdinal,
              ordinal: chunk.chunkOrdinal,
              chunkKey: chunk.chunkKey,
              paragraphText: chunk.paragraphText,
              chunkText: chunk.chunkText,
              paragraphs: chunk.paragraphs,
              sheet: chunk.sheet,
              cell: chunk.cell,
              ...(chunk.boxes[0] === undefined ? {} : { page: chunk.boxes[0].page }),
              boxes: chunk.boxes,
              unionBoxes: chunk.unionBoxes,
              snippet: chunk.snippet,
            })
          }
          case 'read': {
            // Served from the mount point rather than through the session-backed
            // file API, so opening a file needs no conversation. The permission check
            // is shared with the read route: a view hardlink alone is not an answer
            // after a revoke or before a sync.
            const body = await readJsonBody(req)
            try {
              return writeJson(res, 200, await readAuthorized(host, config, String(body.path ?? '')))
            } catch (error) {
              if (error instanceof KnowledgeToolError) {
                return writeJson(res, knowledgeToolStatus(error.code), { error: error.message, code: error.code })
              }
              if (error instanceof KnowledgeError) {
                return writeJson(res, knowledgeStatusFor(error.code), { error: error.message, code: error.code })
              }
              return writeJson(res, 500, { error: describeError(error).message })
            }
          }
          case 'views.sync': {
            // Rebuild the CALLER's visible tree from what DataOps resolves for them.
            //
            // This is the step that makes a grant mean something on disk: the
            // workspace mounts the shared export, so without a per-user view every
            // user would see every file no matter what the permission store says.
            // The decision stays with DataOps (the resolve route is self-scoped);
            // this route only links what that decision allows.
            const body = await readJsonBody(req)
            const syncCaller = await fetchCaller(host, config).catch(() => undefined)
            const result = await syncCallerView(host, config, Array.isArray(body.paths) ? body.paths.map(String) : undefined, {
              // Imported view-only files become documents here too; the page's sync
              // button is the same operation as the model's `kb_sync` tool.
              onAdopted: async adopted => {
                if (syncCaller === undefined || !isSafeUserId(syncCaller.userId)) return
                await afterDocumentWrite(adopted.viewPath, syncCaller)
              },
            })
            if ('error' in result) return writeJson(res, result.status, { error: result.error })
            return writeJson(res, 200, result)
          }
          case 'favorites.get': {
            // The caller's own favourites, read from their own view directory.
            //
            // Shaped exactly like `pins.get`, including the readability re-check: a
            // revoke can land while a star is stored, and a star on a path the caller
            // may no longer read must not be drawn. That is why the answer reports
            // what it dropped rather than just answering a shorter list.
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            const stored = await readFavorites(viewDir)
            const relPaths: string[] = []
            const dropped: string[] = []
            for (const relPath of stored) {
              if (!isContainedRelPath(relPath)) {
                dropped.push(relPath)
                continue
              }
              if (await canReadPath(host, config, relPath)) relPaths.push(relPath)
              else dropped.push(relPath)
            }
            return writeJson(res, 200, { relPaths, dropped })
          }
          case 'favorites.set': {
            // Replace the caller's favourites.
            //
            // Refuses rather than silently pruning a path it may not read, for the
            // same reason `pins.set` does: the caller asked for that path, and a 200
            // answering with a shorter list would let a typo read as success.
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const body = await readJsonBody(req)
            if (!Array.isArray(body.relPaths)) {
              return writeJson(res, 400, { error: 'relPaths must be an array of strings' })
            }
            const wanted = body.relPaths.map(String)
            const refused: string[] = []
            const allowed: string[] = []
            for (const relPath of wanted) {
              if (!isContainedRelPath(relPath)) {
                refused.push(relPath)
                continue
              }
              if (await canReadPath(host, config, relPath)) allowed.push(relPath)
              else refused.push(relPath)
            }
            if (refused.length > 0) {
              return writeJson(res, 403, {
                error: 'cannot favourite a path this caller may not read',
                refused,
              })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            const relPaths = await writeFavorites(viewDir, allowed)
            return writeJson(res, 200, { relPaths, dropped: [] })
          }
          case 'pins.get': {
            // The caller's own pins, read from their own view directory.
            //
            // The directory is derived from the identity DataOps reports rather than
            // taken from the request, so there is no field a browser could point at
            // another user's pins. Every pin is re-checked for readability on the way
            // out: a revoke can land while a pin is stored, and a pin the caller may
            // no longer read must not be drawn.
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            const stored = await readPins(viewDir)
            const relPaths: string[] = []
            const dropped: string[] = []
            for (const relPath of stored) {
              if (!isContainedRelPath(relPath)) {
                dropped.push(relPath)
                continue
              }
              if (await canReadPath(host, config, relPath)) relPaths.push(relPath)
              else dropped.push(relPath)
            }
            return writeJson(res, 200, { relPaths, dropped })
          }
          case 'pins.set': {
            // Replace the caller's pins, keeping only what they may still read.
            //
            // Writes are refused rather than silently pruned when a named path is not
            // readable: the caller asked for that path, and a 200 answering with a
            // shorter list would let a typo read as success. The client distinguishes
            // the two by comparing what it sent with what came back.
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const body = await readJsonBody(req)
            if (!Array.isArray(body.relPaths)) {
              return writeJson(res, 400, { error: 'relPaths must be an array of strings' })
            }
            const wanted = body.relPaths.map(String)
            const refused: string[] = []
            const allowed: string[] = []
            for (const relPath of wanted) {
              if (!isContainedRelPath(relPath)) {
                refused.push(relPath)
                continue
              }
              if (await canReadPath(host, config, relPath)) allowed.push(relPath)
              else refused.push(relPath)
            }
            if (refused.length > 0) {
              return writeJson(res, 403, {
                error: 'cannot pin a path this caller may not read',
                refused,
              })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            const relPaths = await writePins(viewDir, allowed)
            return writeJson(res, 200, { relPaths, dropped: [] })
          }
          case 'settings.get': {
            // This knowledge base's review settings, read from the caller's view.
            //
            // The settings live beside the pins in the view directory, so a caller
            // without a view yet reads the defaults, which is exactly the behaviour a
            // deployment that never opened the page must have: review OFF.
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            const settings = await readSettings(viewDir)
            // Whether this caller may CHANGE the setting is a different question from
            // whether they may read it, and it is DataOps' answer, not ours: the page
            // renders the control read-only when this is false.
            const canEdit = await canManageGrants(host, config)
            // The address that is actually in effect, resolved by the same function the
            // extractor uses. An empty `mineruBaseUrl` means "fall back", so the stored
            // value alone leaves the page with nothing to show for a deployment that
            // works -- the field came up blank while the service was reachable. Sent so
            // the page can display the effective address without recomputing the
            // precedence in the browser, where a second copy of the rule would drift.
            //
            // `mineruSource` is what lets the caption distinguish the three cases: the
            // caller's own address, the one the 「文档识别」 plugin's administrator shared,
            // or this deployment's port derivation. Without it the page would show a
            // shared value in the same box a reader types their own into.
            const resolution = resolveMineruUrl(config, await readSharedMineruUrl(host, config))
            // A stored address the normaliser refused is reported so the page can say the
            // value it shows is a fallback rather than what the reader saved.
            const invalidStored = await storedMineruInvalid(viewDir)
            return writeJson(res, 200, {
              settings,
              canEdit,
              ...(resolution.url === undefined ? {} : { mineruUrl: resolution.url }),
              ...(resolution.source === undefined ? {} : { mineruSource: resolution.source }),
              ...(invalidStored ? { mineruInvalid: true } : {}),
            })
          }
          case 'settings.set': {
            // Replace the review settings, but only for a caller who may write here.
            //
            // This is an operator decision: it decides whether other people's
            // contributions take effect immediately or wait. Read access is therefore
            // not enough, and the check is DataOps' write answer rather than a local
            // guess about roles.
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const body = await readJsonBody(req)
            if (typeof body.reviewRequired !== 'boolean') {
              return writeJson(res, 400, { error: 'reviewRequired must be a boolean' })
            }
            if (!(await canManageGrants(host, config))) {
              return writeJson(res, 403, {
                error: 'changing knowledge base settings requires grant-management access',
              })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            // The address is optional and absent means "leave it alone": an older client
            // that only sends the review toggle must not silently clear a configured
            // service. A present value must be an absolute http(s) address or empty.
            let mineruBaseUrl: string
            if (body.mineruBaseUrl === undefined) {
              mineruBaseUrl = (await readSettings(viewDir)).mineruBaseUrl
            } else if (typeof body.mineruBaseUrl !== 'string') {
              return writeJson(res, 400, { error: 'mineruBaseUrl must be a string' })
            } else {
              const candidate = body.mineruBaseUrl.trim()
              if (candidate !== '') {
                let parsed: URL
                try {
                  parsed = new URL(candidate)
                } catch {
                  return writeJson(res, 400, { error: 'mineruBaseUrl must be an absolute http(s) address' })
                }
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                  return writeJson(res, 400, { error: 'mineruBaseUrl must use http or https' })
                }
              }
              mineruBaseUrl = candidate
            }
            const settings = await writeSettings(viewDir, { reviewRequired: body.reviewRequired, mineruBaseUrl })
            return writeJson(res, 200, { settings })
          }
          case 'audit.list': {
            // The append-only trail, newest first. Read-only by construction: this
            // module exposes no update or delete path for audit entries.
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            // External changes have no caller to key a view by, so the watcher records
            // them once under views/_system instead of duplicating one entry per user.
            // Merging here keeps the audit page a single newest-first trail.
            const [own, system] = await Promise.all([
              readAuditEntries(viewDir, 200),
              readAuditEntries(join(plan.viewRoot, '_system'), 200),
            ])
            const entries = [...own, ...system]
              .sort((left, right) => right.at.localeCompare(left.at))
              .slice(0, 200)
            return writeJson(res, 200, { entries })
          }
          case 'pending.list': {
            // The review queue. Reading it needs no write access: knowing that
            // something is waiting is not the same as being allowed to decide it, and
            // the page renders the buttons disabled when the caller cannot act.
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const settings = await readSettings(
              viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId }),
            )
            const pending = await listPendingWrites(plan.actualRoot)
            const canDecide = await canManageGrants(host, config)
            return writeJson(res, 200, { pending, reviewRequired: settings.reviewRequired, canDecide })
          }
          case 'pending.approve': {
            // Accept one submission by writing its bytes into the authoritative tree.
            //
            // The submitted path is re-authorised HERE rather than trusted from the
            // queue: a grant can be revoked between submitting and approving, and the
            // approver must not be able to publish into a path they cannot write.
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const body = await readJsonBody(req)
            if (!isPendingName(body.name)) {
              return writeJson(res, 400, { error: 'name must be one pending submission name' })
            }
            if (!(await canManageGrants(host, config))) {
              return writeJson(res, 403, { error: 'approving requires grant-management access' })
            }
            const queue = await listPendingWrites(plan.actualRoot)
            const submission = queue.find((candidate) => candidate.name === body.name)
            if (submission === undefined) {
              return writeJson(res, 404, { error: 'no such pending submission' })
            }
            // Review is a two-person control: the submitter cannot approve their own
            // parked write. The queue carries the submitter id, so enforce it here rather
            // than relying on the review UI to hide the button.
            if (submission.userId === caller.userId) {
              return writeJson(res, 403, {
                error: 'a submission cannot be approved by its submitter',
                code: 'SELF_APPROVAL_FORBIDDEN',
              })
            }
            const content = await readPendingContent(plan.actualRoot, body.name)
            if (content === null) {
              return writeJson(res, 404, { error: 'the pending content is gone' })
            }
            const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
            if (!(await canWritePath(host, config, submission.relPath))) {
              return writeJson(res, 403, {
                error: 'write access is required at the submitted path',
                refused: [submission.relPath],
              })
            }
            try {
              const created = await createKnowledgeEntry(config, submission.relPath, {
                directory: false,
                content,
              })
              // The parked copy is discarded only AFTER the bytes are in the tree, so a
              // failure leaves the submission recoverable rather than losing it.
              await discardPendingWrite(plan.actualRoot, body.name)
              await appendAuditEntry(viewDir, {
                at: new Date().toISOString(),
                actor: caller.userId,
                actorLabel: caller.label,
                action: 'approve',
                relPath: submission.relPath,
                outcome: 'applied',
              }).catch(() => undefined)
              const afterWrite = await refreshViewIfStale(true, created.relPath)
              // An approved document is a stored document, and every stored document is
              // supposed to be searchable. Extraction normally happens on the upload
              // path, but a reviewed upload was PARKED before it could happen: the bytes
              // only reached the tree here. Skipping it would make "review required" a
              // silent choice against retrievability, which the uploader never made.
              //
              // The parser address comes from the APPROVER's settings rather than the
              // uploader's: the submission is pinned bytes with no settings attached, and
              // the approver is the identity this request can resolve. A deployment-wide
              // address is the fallback either way.
              const approveSettings = await readSettings(viewDir)
              const extraction = extractionQueue.enqueue(created.relPath, approveSettings.mineruBaseUrl)
              // Same split as the upload path: an approved Markdown document is indexed
              // here because the queue has no extraction work to do for it.
              const pipeline = isIndexableTextPath(created.relPath)
                ? await afterDocumentWrite(created.relPath, caller, { mineruBaseUrl: approveSettings.mineruBaseUrl })
                : { extraction }
              const reply = writeReplyAfterSync({ approved: created, ...pipeline }, afterWrite)
              return writeJson(res, reply.status, reply.body)
            } catch (error) {
              if (error instanceof KnowledgeWriteError) {
                return writeJson(res, writeStatusFor(error.code), { error: error.message, code: error.code })
              }
              return writeJson(res, 500, { error: describeError(error).message })
            }
          }
          case 'pending.reject': {
            // Refuse one submission and forget it, recording that a decision was made.
            //
            // The trail entry is what stops a rejection from being indistinguishable
            // from a submission that was never reviewed at all.
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const body = await readJsonBody(req)
            if (!isPendingName(body.name)) {
              return writeJson(res, 400, { error: 'name must be one pending submission name' })
            }
            if (!(await canManageGrants(host, config))) {
              return writeJson(res, 403, { error: 'rejecting requires grant-management access' })
            }
            const queue = await listPendingWrites(plan.actualRoot)
            const submission = queue.find((candidate) => candidate.name === body.name)
            if (submission === undefined) {
              return writeJson(res, 404, { error: 'no such pending submission' })
            }
            await discardPendingWrite(plan.actualRoot, body.name)
            await appendAuditEntry(
              viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId }),
              {
                at: new Date().toISOString(),
                actor: caller.userId,
                actorLabel: caller.label,
                action: 'reject',
                relPath: submission.relPath,
                outcome: 'rejected',
              },
            ).catch(() => undefined)
            return writeJson(res, 200, { rejected: submission.relPath })
          }
          case 'rename': {
            // Rename one entry, keeping it in its own directory.
            //
            // Separate from `move` because that route takes the name from the source on
            // purpose -- it answers "put this elsewhere" and nothing else. A rename has
            // to choose a name, so it validates one here and re-checks authority at the
            // resulting path rather than trusting the source's grant.
            const body = await readJsonBody(req)
            const from = String(body.from ?? '')
            const newName = String(body.name ?? '').trim()
            if (!isContainedRelPath(from) || from === '') {
              return writeJson(res, 400, { error: 'from must be a contained relative path' })
            }
            // One path segment, and not a traversal: a name carrying a separator would
            // move the entry to another directory, which is `move`'s job, not a rename.
            if (newName === '' || newName.includes('/') || newName.includes('\\')
              || newName === '.' || newName === '..' || newName.includes('\0')) {
              return writeJson(res, 400, { error: 'name must be one path segment' })
            }
            const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
            const to = parent === '' ? newName : parent + '/' + newName
            if (!isContainedRelPath(to)) {
              return writeJson(res, 400, { error: 'the resulting path is not contained' })
            }
            if (to === from) {
              // A no-op rename would report success for a change that did not happen.
              return writeJson(res, 200, { from, to, unchanged: true })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config).catch(() => undefined)
            const callerId = caller?.userId
            if (callerId === undefined || !isSafeUserId(callerId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const canRenameFrom = await canWritePath(host, config, from)
            const canRenameTo = await canWritePath(host, config, to)
            if (!canRenameFrom || !canRenameTo) {
              return writeJson(res, 403, {
                error: 'cannot rename a path this caller may not write',
                refused: [!canRenameFrom ? from : undefined, !canRenameTo ? to : undefined].filter(Boolean),
              })
            }
            try {
              const renamed = await moveEntry(
                { actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: callerId },
                from,
                to,
              )
              await appendAuditEntry(
                viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: callerId }),
                {
                  at: new Date().toISOString(),
                  actor: callerId,
                  actorLabel: caller?.label,
                  action: 'move',
                  relPath: renamed.from,
                  toRelPath: renamed.to,
                  outcome: 'applied',
                },
              ).catch(() => undefined)
              const delta = await syncCallerView(host, config)
              if ('error' in delta) {
                return writeJson(res, 200, {
                  from: renamed.from,
                  to: renamed.to,
                  delta: { linked: 0, unlinked: 0, unchanged: 0 },
                  warning: delta.error,
                })
              }
              return writeJson(res, 200, {
                from: renamed.from,
                to: renamed.to,
                delta: { linked: delta.linked.length, unlinked: delta.unlinked.length, unchanged: delta.unchanged },
              })
            } catch (error) {
              return writeJson(res, 409, { error: describeError(error).message })
            }
          }
          case 'download': {
            // One file's bytes, whole, for the browser to save.
            //
            // Read from the caller's own view rather than the authoritative tree: the view
            // is what their grants produced, so downloading through it cannot hand out a
            // file a revoke already removed from their sight.
            const body = await readJsonBody(req)
            const relPath = String(body.path ?? '')
            try {
              const file = await readKnowledgeFileForDownload(host, config, relPath)
              return writeJson(res, 200, file)
            } catch (error) {
              if (error instanceof KnowledgeError) {
                return writeJson(res, knowledgeStatusFor(error.code), { error: error.message, code: error.code })
              }
              // A bare ENOENT names the server's absolute path, which tells the browser
              // about a filesystem it has no business knowing. The reader only needs to
              // hear that the file is not there.
              const code = (error as { code?: string }).code
              if (code === 'ENOENT') {
                return writeJson(res, 404, { error: 'the file is not there', code: 'not-found' })
              }
              return writeJson(res, 404, { error: 'could not read this file', code: 'unreadable' })
            }
          }
          case 'copy': {
            // Copy one entry, with its subtree, to a new path.
            //
            // The authorization is the pair the move route checks, in the direction a
            // copy actually needs: READ on the source (the bytes are being taken) and
            // WRITE on the destination (something new appears there). It is not
            // "write on both": a copy leaves the source untouched, so demanding write
            // there would refuse a caller who may legitimately read a document out of
            // a read-only folder into their own.
            //
            // DataOps decides both answers through `canReadPath` / `canWritePath`;
            // this route never re-implements the policy.
            const body = await readJsonBody(req)
            const from = String(body.from ?? '')
            const to = String(body.to ?? '')
            if (!isContainedRelPath(from) || !isContainedRelPath(to)) {
              return writeJson(res, 400, { error: 'from and to must be contained relative paths' })
            }
            // The destination is the parent directory plus the source's own name, the
            // same rule the move route uses: a copy cannot rename, because renaming is
            // a separate decision with its own route. `to === ''` means the root.
            const name = from.split('/').pop() ?? ''
            const target = to === '' ? name : to + '/' + name
            if (!isContainedRelPath(target)) {
              return writeJson(res, 400, { error: 'the resolved destination is not a contained relative path' })
            }
            // Copying a directory into itself (or into its own subtree) cannot
            // terminate, so it is refused before the walk rather than discovered by it.
            if (target === from || target.startsWith(from + '/')) {
              return writeJson(res, 400, { error: 'cannot copy an entry into itself', refused: [target] })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config).catch(() => undefined)
            const callerId = caller?.userId
            if (callerId === undefined || !isSafeUserId(callerId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            const canReadSource = await canReadPath(host, config, from)
            const canWriteTarget = to === '' ? true : await canWritePath(host, config, to)
            if (!canReadSource || !canWriteTarget) {
              return writeJson(res, 403, {
                error: 'cannot copy a path this caller may not read, or into a folder it may not write',
                refused: [!canReadSource ? from : undefined, !canWriteTarget ? to : undefined].filter(Boolean),
              })
            }
            try {
              const copied = await copyEntry(
                { actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: callerId },
                from,
                target,
              )
              // Recorded as a `create` at the destination rather than as a new action
              // kind: the audit vocabulary answers "who first put this here", and a copy
              // is exactly that. Adding a seventh action would force every reader of the
              // trail to learn a distinction the review question does not make.
              await appendAuditEntry(
                viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: callerId }),
                {
                  at: new Date().toISOString(),
                  actor: callerId,
                  actorLabel: caller?.label,
                  action: 'create',
                  relPath: target,
                  outcome: 'applied',
                },
              ).catch(() => undefined)
              const after = await refreshViewIfStale(true, copied.to)
              const reply = writeReplyAfterSync({
                from: copied.from,
                to: copied.to,
                entries: copied.entries,
                bytes: copied.bytes,
              }, after)
              return writeJson(res, reply.status, reply.body)
            } catch (error) {
              const message = describeError(error).message
              // A refusal (destination taken, too large, self-nested) is the caller's
              // to act on, so it answers 409 rather than 500 -- the reader renamed or
              // deleted something and retried, which is the intended flow.
              return writeJson(res, 409, { error: message })
            }
          }
          case 'move': {
            // Relocate one entry the caller may WRITE, then resynchronize their view.
            //
            // The filesystem work is a rename inside the authoritative tree; the
            // authorization is still DataOps'. Both paths are asked about, because a
            // move is a write to the source (it stops existing there) and to the
            // destination (something new appears there), and a caller trusted for
            // only one of the two must not be able to perform it. The destination is
            // the PARENT directory when the drag names a folder to move INTO, which
            // is why the caller sends the resolved target path rather than a drop
            // point: this route never concatenates a name the caller chose.
            const body = await readJsonBody(req)
            const from = String(body.from ?? '')
            const to = String(body.to ?? '')
            if (!isContainedRelPath(from) || !isContainedRelPath(to)) {
              return writeJson(res, 400, { error: 'from and to must be contained relative paths' })
            }
            // A path into a directory is expressed as the directory plus the entry's
            // own name, and that name comes from the source rather than the request:
            // a caller cannot rename by moving, which keeps this route's authority to
            // exactly "put it elsewhere" and leaves renaming a separate decision.
            const target = to === '' ? from.split('/').pop() ?? '' : to + '/' + (from.split('/').pop() ?? '')
            if (!isContainedRelPath(target)) {
              return writeJson(res, 400, { error: 'the resolved destination is not a contained relative path' })
            }
            const plan = localConfig(config)
            const caller = await fetchCaller(host, config).catch(() => undefined)
            const callerId = caller?.userId
            if (callerId === undefined || !isSafeUserId(callerId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; cannot key a view by it' })
            }
            // Source and destination parent both need write authority. The check is
            // deliberately not short-circuited into "the source is enough": moving a
            // file into a folder the caller cannot write would place content where
            // they could then read it back out.
            const canWriteSource = await canWritePath(host, config, from)
            const canWriteTarget = to === '' ? true : await canWritePath(host, config, to)
            if (!canWriteSource || !canWriteTarget) {
              return writeJson(res, 403, {
                error: 'cannot move a path this caller may not write',
                refused: [!canWriteSource ? from : undefined, !canWriteTarget ? to : undefined].filter(Boolean),
              })
            }
            try {
              const moved = await moveEntry(
                { actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: callerId },
                from,
                target,
              )
              // Recorded once for both success branches below, before the resync, so a
              // resync warning cannot lose the fact that the move happened.
              await appendAuditEntry(
                viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: callerId }),
                {
                  at: new Date().toISOString(),
                  actor: callerId,
                  actorLabel: caller?.label,
                  action: 'move',
                  relPath: moved.from,
                  toRelPath: moved.to,
                  outcome: 'applied',
                },
              ).catch(() => undefined)
              // The view holds hardlinks, and a rename gives the entry a new path
              // while the old link still points at the inode. Without this resync
              // the reader is left with a live-looking entry at the old path and
              // nothing at the new one.
              //
              // Retried once for the same reason the create route retries: the
              // rename just changed which paths exist, and a resolve that raced it
              // answers about the world before the move. One attempt would turn that
              // race into "the move worked but you cannot see it".
              let movedDelta = await syncCallerView(host, config)
              if ('error' in movedDelta) movedDelta = await syncCallerView(host, config)
              if ('error' in movedDelta) {
                // The move itself succeeded, so this is reported as a partial result
                // rather than a failure: telling the caller the move failed would
                // invite a retry that now has no source to move.
                lastSyncFailure = `move view sync answered HTTP ${String(movedDelta.status)}: ${movedDelta.error}`
                host.logger?.warn?.(`knowledge-base: ${lastSyncFailure}`)
                return writeJson(res, VIEW_SYNC_FAILED_STATUS, {
                  from: moved.from,
                  to: moved.to,
                  delta: { linked: 0, unlinked: 0, unchanged: 0 },
                  viewSyncWarning: {
                    message: 'the change was saved, but the file tree could not be refreshed',
                    reason: lastSyncFailure,
                  },
                })
              }
              lastSyncFailure = undefined
              return writeJson(res, 200, {
                from: moved.from,
                to: moved.to,
                delta: { linked: movedDelta.linked.length, unlinked: movedDelta.unlinked.length, unchanged: movedDelta.unchanged },
              })
            } catch (error) {
              return writeJson(res, 409, { error: describeError(error).message })
            }
          }
          case 'viewMode.get': {
            // Read the layout preference from the mount point, which IS the caller's view.
            //
            // It used to resolve the caller's identity through DataOps and then build a
            // view path from it. That made a layout preference fail whenever the credential
            // was stale -- and `get` swallowed the failure into `list`, so a reader's choice
            // silently never persisted while the page looked fine. The mount point is
            // already the answer to "which view is this caller looking at": `views.sync`
            // points it at their own directory, so the preference file beside the documents
            // is theirs by construction and needs no second lookup.
            const plan = localConfig(config)
            return writeJson(res, 200, { mode: await readViewMode(plan.mountPoint) })
          }
          case 'viewMode.set': {
            // Write the layout preference into the mount point, for the same reason.
            const body = await readJsonBody(req)
            // Three layouts, each drawn by a different component. An unrecognized value
            // falls back to the list rather than reaching the renderer as a mode it cannot
            // draw, which is the same rule the read side applies.
            const mode = body.mode === 'grid' ? 'grid' : body.mode === 'explorer' ? 'explorer' : 'list'
            const plan = localConfig(config)
            // The mount point exists only after a sync has pointed it at a view. Writing
            // through a missing path would create a directory where a symlink belongs,
            // which the next sync would then have to refuse as a non-empty directory --
            // so this reports "not mounted" instead of manufacturing that state.
            try {
              const info = await stat(plan.mountPoint)
              if (!info.isDirectory()) {
                return writeJson(res, 409, { error: 'the mount point is not a directory yet; sync first' })
              }
            } catch {
              return writeJson(res, 409, { error: 'the mount point is not mounted yet; sync first' })
            }
            return writeJson(res, 200, { mode: await writeViewMode(plan.mountPoint, mode) })
          }
          case 'treeState.get': {
            // The folders this caller had open, read from their own view directory.
            //
            // Keyed by the mount point for the same reason `viewMode.get` is: the mount
            // point already IS the caller's view (`views.sync` points it at their own
            // directory), so the file beside their documents is theirs by construction
            // and the answer never depends on a second identity lookup that a stale
            // credential could fail.
            //
            // Never fails on a bad file. A missing, truncated, or hand-edited
            // `.kb-tree-state.json` answers the empty list, which is the tree's own
            // default; the reader gets a fully collapsed tree rather than an error.
            const plan = localConfig(config)
            return writeJson(res, 200, { expanded: await readTreeState(plan.mountPoint) })
          }
          case 'treeState.set': {
            // Replace the stored set of expanded folders.
            //
            // Deliberately lenient about the payload compared with `pins.set`, which
            // refuses anything the caller may not read. An expanded folder is a view
            // state, not a claim on content: the worst outcome of a stale entry is a
            // folder that reopens closed because its row is gone, and the worst
            // outcome of resolving every entry against the permission store first
            // would be a save that fails while the reader is clicking around their
            // own tree. `readTreeState` drops anything that is not a plausible
            // absolute path, so the file cannot be grown without bound.
            const body = await readJsonBody(req)
            if (!Array.isArray(body.expanded)) {
              return writeJson(res, 400, { error: 'expanded must be an array of strings' })
            }
            const plan = localConfig(config)
            // A mount point that does not exist yet is not an error: the folder a
            // reader expanded may be the first thing they do after a page load, and
            // `writeTreeState` creates the directory.
            //
            // But creating it is only safe where it is meant to be a REAL directory.
            // In remote/NAS storage the mount point is a symlink a sync installs, so
            // writing through an absent one would manufacture a real directory where
            // that link belongs -- and the next sync would then have to refuse it as
            // non-empty. That is the same rule `viewMode.set` already applies, and a
            // preference is still not a reason to materialise a mount point.
            const localMode = config.storageMode === 'local'
            try {
              const info = await stat(plan.mountPoint)
              if (!info.isDirectory()) {
                return writeJson(res, 409, { error: 'the mount point is not a directory yet; sync first' })
              }
            } catch {
              if (!localMode) {
                return writeJson(res, 409, { error: 'the mount point is not mounted yet; sync first' })
              }
            }
            return writeJson(res, 200, { expanded: await writeTreeState(plan.mountPoint, body.expanded.map(String)) })
          }
          case 'roles': {
            // The two built-in roles plus every custom role that a grant names.
            //
            // A custom role is DEFINED by the grants that name it: there is no
            // separate role table to keep in step, so a role cannot exist without
            // resources nor outlive them. The screen lists what the grant table
            // already says rather than a second source of truth.
            return writeJson(res, 200, {
              builtIn: BUILT_IN_ROLES.map(role => ({
                id: role.id,
                name: role.name,
                description: role.description,
                actions: [...role.actions],
                departmentScoped: role.departmentScoped,
                removable: role.removable,
              })),
              actions: [...KNOWLEDGE_ACTIONS],
            })
          }
          case 'principals': {
            // The directories live behind the same credential the grants do, so a
            // browser cannot read them directly and this route relays them.
            if (!isTeamDeployment(config)) {
              return writeJson(res, 200, { options: [] })
            }
            const body = await readJsonBody(req)
            const kind = String(body.principalType ?? 'user') as KnowledgeGrantRequest['principalType']
            try {
              return writeJson(res, 200, { options: await fetchPrincipals(host, config, kind) })
            } catch (error) {
              return writeJson(res, 200, { options: [], error: describeError(error) })
            }
          }
          case 'index': {
            // Indexing is not a remote job: the index is what the mounted tree
            // already serves, so a rebuild reports the tree's current shape
            // rather than pretending to have scheduled work elsewhere.
            return writeJson(res, 200, {
              ...await localStatus(config),
              vector: await vectorStatusPayload(),
            })
          }
          case 'vector.rebuild': {
            if (!(await canManageVectorConfig())) {
              return writeJson(res, 403, { error: 'rebuilding the vector index requires kb:config:manage', code: 'forbidden' })
            }
            const body = await readJsonBody(req)
            if (body.confirmed !== true) {
              return writeJson(res, 400, { error: 'full vector rebuild requires explicit confirmation', code: 'confirmation-required' })
            }
            const vector = await liveVectorConfig()
            if (!vector.enabled || vector.baseUrl.trim() === '' || vector.model.trim() === '') {
              return writeJson(res, 400, { error: 'vector retrieval is disabled or has no provider configured', code: 'not-configured' })
            }
            // Refresh the chunk table before enumerating it, then let the job run in the
            // background; the settings page polls `status.vector` for progress.
            await syncKnowledgeIndex(true, false)
            startVectorJob(true)
            return writeJson(res, 200, { started: true })
          }
          case 'index.dirs': {
            // The table the indexing page renders. Read-only and derived from the
            // caller's own mount point, so it needs no permission question of its
            // own: the tree it measures is already the caller's view, and a path
            // outside it is not reachable from here.
            return writeJson(res, 200, {
              directories: await listDirectoryShapes(localConfig(config).mountPoint),
            })
          }
          case 'deploy.steps':
            return writeJson(res, 200, { steps: deploymentPlan(context).map(publicStep), runs: runs.slice(-10) })
          case 'deploy.hosts': {
            try {
              return writeJson(res, 200, { hosts: await runner.listHosts() })
            } catch (error) {
              return writeJson(res, 200, { hosts: [], error: describeError(error) })
            }
          }
          case 'deploy.run': {
            const body = await readJsonBody(req)
            const stepId = String(body.stepId ?? '')
            const hostId = String(body.hostId ?? '')
            const step = findStep(stepId, context)
            if (step === undefined) return writeJson(res, 400, { error: `unknown step ${stepId}` })
            if (hostId === '') return writeJson(res, 400, { error: 'hostId is required' })
            // Steps mutate a remote host, so they are rejected while one runs.
            if (runs.some(run => run.state === 'running')) {
              return writeJson(res, 409, { error: 'a deployment step is already running' })
            }
            const record: StepRun = {
              stepId,
              hostId,
              state: 'running',
              startedAt: new Date().toISOString(),
              finishedAt: null,
              log: [],
            }
            runs.push(record)
            try {
              await executeStep(runner, step, hostId, record)
              record.state = 'succeeded'
            } catch (error) {
              record.state = 'failed'
              record.log.push(`ERROR: ${describeError(error).message}`)
            } finally {
              record.finishedAt = new Date().toISOString()
            }
            return writeJson(res, 200, record)
          }
          case 'deploy.log': {
            const jobId = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('stepId') ?? ''
            const found = [...runs].reverse().find(run => run.stepId === jobId)
            return writeJson(res, 200, found ?? { error: 'no such run' })
          }
          case 'memory.list':
          case 'memory.get':
          case 'memory.update':
          case 'memory.forget':
          case 'memory.settings':
          case 'memory.set-enabled':
          case 'memory.save-settings': {
            // The memory page manages ONLY the caller's own personal tree. Identity
            // comes from the request (never the body); the stores are built from the
            // same `<actualRoot>/personal/<userId>` root the guardian writes.
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; memory is scoped to the authenticated user' })
            }
            const body = await readJsonBody(req)
            const personalScope = personalScopeRootFor(caller.userId)
            // First-read default for the administrator: use the existing DataOps
            // permission projection already resolved for this request. No role
            // name is hard-coded here, and an explicit setting in the user's
            // settings.json is read before this default is considered.
            const defaultEnabled = config.memoryDefaultEnabledPermission.trim() !== ''
              && (caller.permissions ?? []).includes(config.memoryDefaultEnabledPermission)
            const result = await handleMemoryRoute({
              method,
              body,
              caller: { userId: caller.userId, ...(caller.label === undefined ? {} : { label: caller.label }) },
              store: new MemoryStore(join(personalScope, PERSONAL_MEMORY_FOLDER)),
              settings: new MemorySettingsStore(memoryUsersRoot),
              defaultEnabled,
              graphWriter: new MemoryGraphWriter({ scopeRoot: personalScope }),
            })
            return writeJson(res, result.status, result.body)
          }
          case 'memory.promote':
          case 'memory.promotions':
          case 'memory.review-promotion':
          case 'memory.shared': {
            // Promotion crosses the personal boundary, so it needs the review
            // projection rather than the personal-page caller. DataOps remains the
            // authority for the target read/write decision; the projection only
            // narrows which queue a caller sees and answers 403 with a reason.
            const caller = await fetchCaller(host, config)
            if (!isSafeUserId(caller.userId)) {
              return writeJson(res, 400, { error: 'unsafe caller id; memory is scoped to the authenticated user' })
            }
            let reviewContext: Awaited<ReturnType<typeof managementHost.context>> | undefined
            if (isTeamDeployment(config)) {
              reviewContext = await managementHost.context()
            }
            const reviewer = reviewContext === undefined
              // A personal deployment has one operator and no grants; the local
              // owner is the reviewer by construction, and there is no department.
              ? {
                  userId: caller.userId,
                  name: caller.label ?? caller.userId,
                  isGlobalAdmin: true,
                  canManageConfig: true,
                  reviewDepartments: [] as string[],
                  visibleDepartmentCodes: [] as string[],
                }
              : {
                  userId: caller.userId,
                  name: caller.label ?? caller.userId,
                  // Do NOT reuse managementTools.isGlobalAdmin here: it treats a broad
                  // data scope as platform administration. A department administrator
                  // can report `dataScope.all` while `review.canReviewGlobal` is false
                  // (MASTER E12 found the same amplification), and promotion must not
                  // turn that into authority over every department's review queue.
                  isGlobalAdmin: reviewContext.review.canReviewGlobal === true
                    || reviewContext.roleCodes.some(code => code === 'SUPER_ADMIN' || code === 'ADMIN'),
                  canManageConfig: hasPermission(reviewContext, 'kb:config:manage'),
                  ...(caller.departmentCode === undefined ? {} : { departmentCode: caller.departmentCode }),
                  ...(caller.departmentName === undefined ? {} : { departmentName: caller.departmentName }),
                  ...(caller.departmentPathCodes === undefined
                    ? (reviewContext.departmentPathCodes === undefined
                        ? {}
                        : { departmentPathCodes: [...reviewContext.departmentPathCodes] })
                    : { departmentPathCodes: [...caller.departmentPathCodes] }),
                  reviewDepartments: [...reviewContext.review.departments],
                  visibleDepartmentCodes: [...reviewContext.dataScope.departmentCodes],
                }
            const body = await readJsonBody(req)
            const personalScope = personalScopeRootFor(caller.userId)
            const result = await handleMemoryPromotionRoute({
              method,
              body,
              actor: { id: caller.userId, name: caller.label ?? caller.userId },
              reviewer,
              store: new MemoryStore(join(personalScope, PERSONAL_MEMORY_FOLDER)),
              queuePath: promotionStorePath(memoryUsersRoot),
              actualRoot: localConfig(config).actualRoot,
              canWrite: relPath => canWritePath(host, config, relPath),
              canRead: relPath => canReadPath(host, config, relPath),
            })
            return writeJson(res, result.status, result.body)
          }
          default:
            return writeJson(res, 404, { error: `unknown knowledge-base method: ${method}` })
        }
      } catch (error) {
        // Publish-store failures are decisions too: validation, identity and review
        // state each have a status the caller can act on.
        if (error instanceof WorkflowPublishError) {
          const status = error.code === 'invalid' ? 400
            : error.code === 'not-found' ? 404
            : error.code === 'already-reviewed' ? 409
            : 500
          return writeJson(res, status, { error: error.message, code: error.code })
        }
        // A typed failure is a decision, not a crash: answer with the status its code
        // names so an expired token does not read as an internal error.
        if (error instanceof KnowledgeError) {
          return writeJson(res, knowledgeStatusFor(error.code), {
            error: error.message,
            code: error.code,
          })
        }
        return writeJson(res, 500, describeError(error))
      }
    },
  }), 'dsh-knowledge-base: settings API')

  // The skill teaches the MODEL how to use this tree. `inject` rather than a hard
  // dependency entry: the dependency fiber starts when a skill registry becomes
  // available and unloads its registration before either side is replaced, which is
  // how this plugin keeps working on a host that has no registry at all.
  //
  // The provider is built against a restated structural contract rather than the
  // registry's own types: `skills` is optional here, and importing its package
  // would turn that neighbour into a build requirement.
  const hostWithInject = host as unknown as { inject?: (deps: readonly string[], run: (scoped: { skills: { registerProvider: (provider: () => unknown) => unknown } }) => void) => void }
  if (typeof hostWithInject.inject === 'function') {
    hostWithInject.inject(['skills'], (scoped) => {
      scoped.skills.registerProvider(() => knowledgeBaseSkillProvider() as never)
    })
  }

  // Publication is disclosed with the `publish` group (`workflow:publish`); the
  // global-visibility scope check stays inside the body because it is a property of
  // the individual call, not of the tool's existence.
  const workflowPublishTool = defineTool({
    name: 'workflow_publish',
    description: 'Publish one workflow from this conversation to the Workflow Plaza. '
      + 'The record is created as PENDING; it does NOT appear in the public plaza until an administrator approves it. '
      + '发布后需管理员审核，通过后才出现在广场。'
      + 'Use this only when the user explicitly asks to publish/share the workflow. '
      + 'Do not use it to edit an existing workflow or to run a task now. '
      + 'Provide the standing instruction that will run on the chosen schedule, in the user\'s language. '
      + 'cronHint should be a 5-field cron expression when the user gave one; category is a short group label.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short workflow title shown on the card (<=120 characters).' },
      description: { type: 'string', required: true, description: 'One or two sentences describing what the workflow does.' },
      instruction: {
        type: 'string',
        required: true,
        description: 'The standing prompt the scheduled session will execute, including scope and constraints.',
      },
      cronHint: { type: 'string', description: 'Optional 5-field cron expression suggested by the user, e.g. 0 9 * * 1.' },
      category: { type: 'string', description: 'Optional short category label, e.g. 知识整理 / 客户成功.' },
      visibility: { type: 'string', description: 'global | department | private. Default private; global is admin-only.' },
      departmentCode: { type: 'string', description: 'Department code for department visibility; defaults to the caller department.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          duplicate: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    execute: async (args, exec) => {
      const actor = await resolveWorkflowActor(host, config)
      // `workflow:publish` was proven when this tool was registered; the context is
      // read here for the SCOPE decision (global visibility also needs the global
      // review key), not to re-authorize the tool's existence.
      const context = await managementHost.context()
      if (args.visibility === 'global' && !hasPermission(context, 'workflow:review:global')) {
        throw new ManagementToolError('forbidden', '缺少权限 workflow:review:global（global workflow publish）')
      }
      const scope = normalizePublishScope(
        context,
        args.visibility as 'global' | 'department' | 'private' | undefined,
        args.departmentCode,
      )
      const sessionId = exec.agent?.session.id
      const result = await publishWorkflow(
        publishStorePath(publishDirOf(config.publishDir)),
        { ...args, visibility: scope.visibility, departmentCode: scope.departmentCode },
        actor,
        sessionId === undefined ? undefined : String(sessionId),
      )
      const prefix = result.duplicate
        ? `An identical pending workflow already exists (${result.record.id}); it was not duplicated.`
        : `Workflow published as pending (${result.record.id}).`
      return {
        id: result.record.id,
        status: result.record.status,
        duplicate: result.duplicate,
        report: `${prefix} 管理员审核通过后才会出现在工作流广场；当前状态：待审核。`,
      }
    },
  })

  // The host seam the model tools compose. Every method is the SAME implementation the
  // matching HTTP route uses: permission decisions stay with DataOps, and paths stay in
  // view coordinates (mountPoint), never the authoritative root.
  /** Sidecar path, guarded against living inside the agent-visible tree. */
  const knowledgeIndexPath = (): string => {
    const plan = localConfig(config)
    const target = indexPathFor(config.indexDir)
    assertIndexOutsideTrees(target, [plan.actualRoot, plan.viewRoot, config.mountPoint])
    return target
  }

  /** One document's vectorization outcome. */
  interface VectorizeDocumentReport {
    docId: number
    path: string
    chunks: number
    embedded: number
    skipped: number
    failed: number
    wouldEmbed?: number
    error?: string
  }

  interface VectorizeReport {
    ok: boolean
    dryRun: boolean
    rebuild: boolean
    model: string
    documents: VectorizeDocumentReport[]
    denied: Array<{ docId: number; path: string; reason: string }>
    totals: { documents: number; chunks: number; embedded: number; skipped: number; failed: number; wouldEmbed: number }
    stats: VectorIndexStats
  }

  /** Read the live vector settings; the panel may have changed them since boot. */
  const liveVectorConfig = async (): Promise<VectorRetrievalConfig> => {
    const live = withStoredStorage(config, await readStorageSettings(config.mountPoint))
    return live.retrieval?.vector ?? DEFAULT_VECTOR_RETRIEVAL
  }

  /** Resolve the embedding credential. The value lives only in this call frame. */
  const vectorApiKey = async (vector: VectorRetrievalConfig): Promise<string> => {
    if (vector.credentialRef.trim() === '') return ''
    const resolved = await ctx.credentials.resolve(credentialRef(vector.credentialRef)).catch(() => undefined)
    if (resolved === undefined || resolved.value.trim() === '') {
      throw new EmbeddingProviderError(`embedding credential "${vector.credentialRef}" is not available`)
    }
    return resolved.value
  }

  /** Open the existing sidecar and ensure the vector tables exist. */
  const openVectorDatabase = (): DatabaseSync => {
    const db = new DatabaseSync(knowledgeIndexPath())
    ensureVectorSchema(db)
    return db
  }

  /** Counts shown by the settings page and the explicit tool. */
  const readVectorStats = (model: string): VectorIndexStats => {
    const db = openVectorDatabase()
    try { return vectorIndexStats(db, model) } finally { db.close() }
  }

  let vectorAutoAt = 0
  let vectorJob: Promise<void> | undefined
  let vectorProgress: {
    running: boolean
    total: number
    done: number
    embedded: number
    failed: number
    startedAt: string
    finishedAt?: string
    error?: string
  } | undefined

  /**
   * Vectorize explicit targets, or (for the settings rebuild) the whole index.
   *
   * One document is the transaction boundary: a provider error records failures for that
   * document and leaves its old vectors untouched, then the next document still runs.
   */
  const vectorizeTargets = async (input: {
    docId?: number
    path?: string
    scope?: string
    rebuild?: boolean
    dryRun?: boolean
    all?: boolean
    checkRead?: boolean
    onProgress?: (progress: { total: number; done: number; embedded: number; failed: number }) => void
  }): Promise<VectorizeReport> => {
    const vector = await liveVectorConfig()
    if (!vector.enabled) throw new Error('vector retrieval is disabled; enable retrieval.vector in knowledge-base settings first')
    if (vector.baseUrl.trim() === '' || vector.model.trim() === '') {
      throw new Error('vector retrieval needs a provider baseUrl and model before documents can be vectorized')
    }
    // dryRun must be safe before a credential is configured: it only counts targets.
    const apiKey = input.dryRun === true ? '' : await vectorApiKey(vector)
    const db = openVectorDatabase()
    try {
      const targets = vectorDocuments(db, {
        ...(input.docId === undefined ? {} : { docId: input.docId }),
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.all === true ? { all: true } : {}),
      })
      const reports: VectorizeDocumentReport[] = []
      const denied: Array<{ docId: number; path: string; reason: string }> = []
      let totals = { documents: 0, chunks: 0, embedded: 0, skipped: 0, failed: 0, wouldEmbed: 0 }
      if (targets.length === 0) {
        const stats = vectorIndexStats(db, vector.model)
        return { ok: true, dryRun: input.dryRun === true, rebuild: input.rebuild === true, model: vector.model, documents: [], denied, totals, stats }
      }
      const perDocumentBatch = 16
      input.onProgress?.({ total: targets.length, done: 0, embedded: 0, failed: 0 })
      for (const target of targets) {
        if (input.checkRead !== false && !await canReadPath(host, config, target.path)) {
          denied.push({ docId: target.id, path: target.path, reason: 'forbidden: read access is required' })
          continue
        }
        const chunks = chunksForDocuments(db, [target.id])
        const states = embeddingStates(db, vector.model, chunks.map(chunk => chunk.id))
        const pending = chunks.filter(chunk => input.rebuild === true
          || states.get(chunk.id)?.contentHash !== embeddingContentHash(chunk.content))
        const report: VectorizeDocumentReport = {
          docId: target.id,
          path: target.path,
          chunks: chunks.length,
          embedded: 0,
          skipped: chunks.length - pending.length,
          failed: 0,
          ...(input.dryRun === true ? { wouldEmbed: pending.length } : {}),
        }
        totals.documents += 1
        totals.chunks += chunks.length
        totals.skipped += report.skipped
        if (input.dryRun === true) {
          totals.wouldEmbed += pending.length
          reports.push(report)
          continue
        }
        if (pending.length > 0) {
          try {
            const vectors: number[][] = []
            for (let offset = 0; offset < pending.length; offset += perDocumentBatch) {
              const batch = pending.slice(offset, offset + perDocumentBatch)
              vectors.push(...await embedTexts(vector, batch.map(chunk => chunk.content), apiKey))
            }
            if (vectors.length !== pending.length) throw new Error('embedding response count did not match chunk count')
            db.exec('BEGIN')
            try {
              const now = new Date().toISOString()
              for (const [index, chunk] of pending.entries()) {
                putEmbedding(db, {
                  chunkId: chunk.id,
                  docId: chunk.docId,
                  path: chunk.path,
                  model: vector.model,
                  vector: vectors[index] as number[],
                  contentHash: embeddingContentHash(chunk.content),
                  updatedAt: now,
                })
              }
              db.exec('COMMIT')
            } catch (error) {
              db.exec('ROLLBACK')
              throw error
            }
            report.embedded = pending.length
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            report.failed = pending.length
            report.error = message
            const now = new Date().toISOString()
            for (const chunk of pending) {
              recordVectorFailure(db, { chunkId: chunk.id, docId: chunk.docId, path: chunk.path, model: vector.model, error: message, updatedAt: now })
            }
          }
        }
        totals.embedded += report.embedded
        totals.failed += report.failed
        reports.push(report)
        input.onProgress?.({ total: targets.length, done: totals.documents, embedded: totals.embedded, failed: totals.failed })
      }
      const stats = vectorIndexStats(db, vector.model)
      return {
        ok: reports.every(report => report.failed === 0),
        dryRun: input.dryRun === true,
        rebuild: input.rebuild === true,
        model: vector.model,
        documents: reports,
        denied,
        totals,
        stats,
      }
    } finally {
      db.close()
    }
  }

  /** Start one background whole-index pass, coalescing callers into the active job. */
  const startVectorJob = (rebuild: boolean): void => {
    if (vectorJob !== undefined) return
    vectorProgress = {
      running: true,
      total: 0,
      done: 0,
      embedded: 0,
      failed: 0,
      startedAt: new Date().toISOString(),
    }
    vectorJob = (async () => {
      try {
        const report = await vectorizeTargets({
          all: true,
          rebuild,
          checkRead: false,
          onProgress: progress => {
            vectorProgress = {
              ...vectorProgress!,
              total: progress.total,
              done: progress.done,
              embedded: progress.embedded,
              failed: progress.failed,
            }
          },
        })
        vectorProgress = {
          ...vectorProgress!,
          running: false,
          total: report.totals.documents,
          done: report.totals.documents,
          embedded: report.totals.embedded,
          failed: report.totals.failed,
          finishedAt: new Date().toISOString(),
        }
      } catch (error) {
        vectorProgress = {
          ...vectorProgress!,
          running: false,
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        }
      } finally {
        vectorJob = undefined
      }
    })()
  }

  /** Who may edit the vector group: local owner, or a team caller with kb:config:manage. */
  const canManageVectorConfig = async (): Promise<boolean> => {
    if (!isTeamDeployment(config)) return true
    try {
      return (await managementHost.context()).permissions.includes('kb:config:manage')
    } catch {
      return false
    }
  }

  /** Status payload for the settings page; never throws into the status route. */
  const vectorStatusPayload = async (): Promise<Record<string, unknown>> => {
    let vector: VectorRetrievalConfig
    try { vector = await liveVectorConfig() } catch { return { enabled: false, indexing: { running: false } } }
    let stats: VectorIndexStats | undefined
    if (vector.model.trim() !== '') {
      try { stats = readVectorStats(vector.model) } catch { stats = undefined }
    }
    return {
      enabled: vector.enabled,
      provider: vector.provider,
      model: vector.model,
      embeddedChunks: stats?.embeddedChunks ?? 0,
      totalChunks: stats?.totalChunks ?? 0,
      embeddedDocs: stats?.embeddedDocs ?? 0,
      totalDocs: stats?.totalDocs ?? 0,
      failed: stats?.failed ?? 0,
      canManageVector: await canManageVectorConfig(),
      indexing: vectorProgress === undefined ? { running: false } : {
        running: vectorProgress.running,
        total: vectorProgress.total,
        done: vectorProgress.done,
        embedded: vectorProgress.embedded,
        failed: vectorProgress.failed,
        ...(vectorProgress.error === undefined ? {} : { error: vectorProgress.error }),
      },
    }
  }

  /** Kick a missing/stale pass after a sync, at most once a minute. */
  const scheduleVectorAutoIndex = (): void => {
    if (vectorJob !== undefined) return
    if (Date.now() - vectorAutoAt < 60_000) return
    vectorAutoAt = Date.now()
    void liveVectorConfig().then(vector => {
      if (vector.enabled && vector.baseUrl.trim() !== '' && vector.model.trim() !== '') startVectorJob(false)
    }).catch(() => undefined)
  }

  let lastIndexSyncAt = 0
  let lastIndexStats: FtsIndexStats | undefined
  /**
   * Incremental sync shared by search/index/status. A short freshness window avoids
   * walking the tree for every query; an explicit rebuild bypasses it.
   */
  const syncKnowledgeIndex = async (force = false, scheduleAuto = true): Promise<FtsIndexStats> => {
    if (!force && lastIndexStats !== undefined && Date.now() - lastIndexSyncAt < 3_000) return lastIndexStats
    const stats = await syncIndex({
      actualRoot: localConfig(config).actualRoot,
      indexPath: knowledgeIndexPath(),
      autoGenerateSummaries: config.outline?.autoGenerate === true,
    })
    // Summaries follow the same incremental signal the index just produced: only
    // changed/added/removed documents are reconsidered, and a model-authored
    // (`llm`) summary is never overwritten. A summary failure must not fail the
    // index pass, so it is logged and retried on the next change.
    if (stats.indexed > 0 || stats.removed > 0 || !existsSync(summarySnapshotPathFor(stats.indexPath))) {
      try {
        await applySummaryWriteback({
          root: localConfig(config).actualRoot,
          indexPath: stats.indexPath,
        })
      } catch (error) {
        host.logger?.warn?.('knowledge-base: incremental summary write-back failed: '
          + (error instanceof Error ? error.message : String(error)))
      }
    }
    lastIndexStats = stats
    lastIndexSyncAt = Date.now()
    if (scheduleAuto) scheduleVectorAutoIndex()
    return stats
  }

  /** Embed the query for hybrid retrieval; a provider failure degrades to FTS. */
  const prepareVectorQuery = async (query: string): Promise<{ vector?: VectorSearchInput; warning?: string }> => {
    let vectorConfig: VectorRetrievalConfig
    try { vectorConfig = await liveVectorConfig() } catch { return {} }
    if (!vectorConfig.enabled) return {}
    if (vectorConfig.baseUrl.trim() === '' || vectorConfig.model.trim() === '') {
      return { warning: 'vector retrieval is enabled but provider baseUrl/model is not configured' }
    }
    let stats: VectorIndexStats
    try { stats = readVectorStats(vectorConfig.model) } catch (error) {
      return { warning: `vector index is unavailable: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (stats.embeddedChunks === 0) {
      // No vectors yet: FTS is the honest answer, and no provider call is wasted.
      return { vector: {
        model: vectorConfig.model,
        queryVector: [],
        candidateK: vectorConfig.candidateK,
        rrfK: vectorConfig.rrfK,
        ftsWeight: vectorConfig.ftsWeight,
        vectorWeight: vectorConfig.vectorWeight,
        coverage: 0,
      } }
    }
    try {
      const apiKey = await vectorApiKey(vectorConfig)
      const [queryVector] = await embedTexts(vectorConfig, [query], apiKey)
      if (queryVector === undefined) throw new Error('embedding provider returned no query vector')
      const coverage = stats.totalDocs === 0 ? 0 : stats.embeddedDocs / stats.totalDocs
      return { vector: {
        model: vectorConfig.model,
        queryVector,
        candidateK: vectorConfig.candidateK,
        rrfK: vectorConfig.rrfK,
        ftsWeight: vectorConfig.ftsWeight,
        vectorWeight: vectorConfig.vectorWeight,
        coverage,
      } }
    } catch (error) {
      return { warning: `vector query embedding failed; using FTS only: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /**
   * Resolve one model tool path for the two coordinate systems it has to cross.
   *
   * `toolViewPath` stays in the caller's view (what the tree shows and what
   * `mountPoint` contains). `toolActualPath` gains the personal owner segment for
   * writes/overwrites/permission checks, which live under `actualRoot`. Both are
   * idempotent for paths that already carry a scope or an owner id, so graph
   * tools that pass authoritative paths keep working unchanged.
   */
  const toolViewPath = (relPath: string): string => toolScopedViewPath(relPath, isTeamDeployment(config))
  const toolActualPath = async (relPath: string, caller?: { userId: string }): Promise<string> => {
    const team = isTeamDeployment(config)
    const viewPath = toolScopedViewPath(relPath, team)
    // Global/department paths and local trees need no owner segment, so they never
    // pay for a caller lookup.
    if (!team || viewPath === '' || viewPath === 'personal' || !viewPath.startsWith('personal/')) return viewPath
    const rest = viewPath.slice('personal/'.length)
    if (caller !== undefined && (rest === caller.userId || rest.startsWith(`${caller.userId}/`))) return viewPath
    const who = caller ?? await fetchCaller(host, config)
    if (!isSafeUserId(who.userId)) {
      throw new KnowledgeToolError('forbidden', 'unsafe caller id; cannot resolve a personal path')
    }
    return toolScopedActualPath(viewPath, who.userId, true)
  }

  /**
   * Replace one file's bytes in place.
   *
   * A write-temp-then-rename would replace the inode and leave the caller's view
   * hardlink pointing at the old bytes (the edit route explains this at length), so
   * this truncates the existing file. Text and bytes share the path: the only
   * difference is what is handed to `writeFile`.
   */
  const overwriteInPlace = async (relPath: string, content: string | Uint8Array): Promise<void> => {
    const scoped = await toolActualPath(relPath)
    if (!isContainedRelPath(scoped)) {
      throw new KnowledgeToolError('escapes-knowledge-root', 'the path leaves the knowledge root', relPath)
    }
    const full = join(localConfig(config).actualRoot, scoped)
    const info = await stat(full)
    if (!info.isFile()) {
      throw new KnowledgeToolError('not-a-file', 'not a regular file', relPath)
    }
    await writeFile(full, content)
    markInternalMutation(scoped)
  }

  const knowledgeToolHost: KnowledgeFileToolHost = {
    vectorize: async input => {
      try {
        await syncKnowledgeIndex(false, false)
        const scoped = input.path === undefined ? input : { ...input, path: await toolActualPath(input.path) }
        return await vectorizeTargets(scoped) as unknown as Record<string, unknown>
      } catch (error) {
        // The explicit tool reports a disabled/misconfigured vector feature as a
        // structured failure; it never silently runs a pure-FTS pass.
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          documents: [],
          denied: [],
          totals: { documents: 0, chunks: 0, embedded: 0, skipped: 0, failed: 0, wouldEmbed: 0 },
        }
      }
    },
    searchIndex: async (input) => {
      const context = await managementHost.context()
      await syncKnowledgeIndex()
      scheduleVectorAutoIndex()
      const vectorQuery = await prepareVectorQuery(input.query)
      const departments = [...new Set([
        ...context.dataScope.departmentCodes,
        ...(context.departmentCode === null || context.departmentCode === undefined ? [] : [context.departmentCode]),
        ...context.review.departments,
      ])]
      const result = await searchIndex({
        indexPath: knowledgeIndexPath(),
        query: input.query,
        topK: input.topK,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        locale: config.scopeLocale,
        caller: { callerId: context.userId, departmentCodes: departments, global: isGlobalAdmin(context) },
        canRead: relPath => canReadPath(host, config, relPath),
        ...(vectorQuery.vector === undefined ? {} : { vector: vectorQuery.vector }),
      })
      const plan = localConfig(config)
      const mapHit = (hit: FtsSearchHit): FtsSearchHit => {
        const viewOptions = {
          actualRoot: plan.actualRoot,
          viewRoot: plan.viewRoot,
          userId: context.userId,
          ...(context.departmentCode === null || context.departmentCode === undefined ? {} : { departmentCode: context.departmentCode }),
          ...(context.departmentPathCodes === undefined ? {} : { departmentPathCodes: context.departmentPathCodes }),
        }
        const canonicalPath = expectedViewPathFor(viewOptions, hit.path) ?? hit.path
        return {
          ...hit,
          path: canonicalPath,
          displayPath: localizedScopeForPath(canonicalPath, config.scopeLocale),
          markdownPath: expectedViewPathFor(viewOptions, hit.markdownPath) ?? hit.markdownPath,
        }
      }
      return {
        ...result,
        hits: result.hits.map(mapHit),
        ...(vectorQuery.warning === undefined ? {} : { vectorWarning: vectorQuery.warning }),
      }
    },
    chunkGet: async (input) => {
      // A citation token carries the stable chunk_key (16 hex); legacy rows may still
      // carry a numeric id. Resolve either to the current numeric id before reading.
      const resolvedChunkId = await findChunkId({
        indexPath: knowledgeIndexPath(),
        docId: input.docId,
        chunkId: input.chunkId,
      })
      if (resolvedChunkId === undefined) {
        throw new KnowledgeToolError('not-found', 'no such document chunk', `${String(input.docId)}/${String(input.chunkId)}`)
      }
      const chunk = await readChunkProvenance({
        indexPath: knowledgeIndexPath(),
        docId: input.docId,
        chunkId: resolvedChunkId,
      })
      if (chunk === undefined) {
        throw new KnowledgeToolError('not-found', 'no such document chunk', `${String(input.docId)}/${String(input.chunkId)}`)
      }
      if (!await canReadPath(host, config, chunk.path)) {
        throw new KnowledgeToolError('forbidden', 'read access is required')
      }
      const context = await managementHost.context()
      const plan = localConfig(config)
      const viewPath = expectedViewPathFor({
        actualRoot: plan.actualRoot,
        viewRoot: plan.viewRoot,
        userId: context.userId,
        ...(context.departmentCode === null || context.departmentCode === undefined ? {} : { departmentCode: context.departmentCode }),
        ...(context.departmentPathCodes === undefined ? {} : { departmentPathCodes: context.departmentPathCodes }),
      }, chunk.path) ?? chunk.path
      return {
        docId: chunk.docId,
        chunkId: chunk.chunkId,
        ...(chunk.chunkKey === undefined ? {} : { chunkKey: chunk.chunkKey }),
        citation: citationTokenForChunk(chunk.docId, chunk.chunkKey, chunk.chunkId),
        path: viewPath,
        displayPath: localizedScopeForPath(viewPath, config.scopeLocale),
        ...(chunk.quote === undefined ? {} : { quote: chunk.quote }),
        ...(chunk.heading === undefined ? {} : { heading: chunk.heading }),
        ...(chunk.paragraph === undefined ? {} : { paragraph: chunk.paragraph }),
        ...(chunk.chunkOrdinal === undefined ? {} : { chunkOrdinal: chunk.chunkOrdinal }),
        ...(chunk.paragraphText === undefined ? {} : { paragraphText: chunk.paragraphText }),
        ...(chunk.sheet === undefined ? {} : { sheet: chunk.sheet }),
        ...(chunk.cell === undefined ? {} : { cell: chunk.cell }),
        ...(chunk.boxes[0] === undefined ? {} : { page: chunk.boxes[0].page }),
        boxes: chunk.boxes,
        snippet: chunk.snippet,
      }
    },
    outline: async (input) => {
      const indexPath = knowledgeIndexPath()
      // Read the document reference BEFORE rebuilding: a legacy index has chunks but no
      // outline, and permission must be decided on the source path either way. A caller who
      // may not read the document gets 403 and never causes an outline write.
      const reference = await readDocumentOutline({ indexPath, docId: input.docId })
      if (reference === undefined) {
        throw new KnowledgeToolError('not-found', 'no such document', String(input.docId))
      }
      if (!await canReadPath(host, config, reference.path)) {
        throw new KnowledgeToolError('forbidden', 'read access is required for this document')
      }
      const outline = await ensureDocumentOutline({
        indexPath,
        docId: input.docId,
        autoGenerate: config.outline?.autoGenerate === true,
      })
      if (outline === undefined) {
        throw new KnowledgeToolError('not-found', 'no such document', String(input.docId))
      }
      const context = await managementHost.context()
      const plan = localConfig(config)
      const viewPath = expectedViewPathFor({
        actualRoot: plan.actualRoot,
        viewRoot: plan.viewRoot,
        userId: context.userId,
        ...(context.departmentCode === null || context.departmentCode === undefined ? {} : { departmentCode: context.departmentCode }),
        ...(context.departmentPathCodes === undefined ? {} : { departmentPathCodes: context.departmentPathCodes }),
      }, outline.path) ?? outline.path
      return {
        docId: outline.docId,
        path: viewPath,
        displayPath: localizedScopeForPath(viewPath, config.scopeLocale),
        summary: outline.summary,
        summaryKind: outline.summaryKind ?? (outline.summary.trim() === '' ? 'none' : 'extractive'),
        summaryStatus: outline.summaryStatus ?? (outline.summary.trim() === '' ? 'missing' : 'ready'),
        ...((outline.summaryStatus ?? (outline.summary.trim() === '' ? 'missing' : 'ready')) === 'missing'
          ? { hint: '按 knowledge-base 技能的摘要流程生成摘要' }
          : {}),
        ...(outline.summaryVersion === undefined ? {} : { summaryVersion: outline.summaryVersion }),
        sourceChunkIds: outline.sourceChunkIds,
        toc: outline.toc,
        sections: outline.sections.map(section => ({
          sectionId: section.sectionId,
          sectionPath: section.headingPath,
          level: section.level,
          summary: section.summary,
          keyFacts: section.keyFacts,
          chunkIds: section.chunkIds,
          sourceChunkIds: section.sourceChunkIds,
        })),
        indexPath: outline.indexPath,
      }
    },
    outlineRewrite: async (input: { docId: number }) => {
      const indexPath = knowledgeIndexPath()
      const reference = await readDocumentOutline({ indexPath, docId: input.docId })
      if (reference === undefined) {
        throw new KnowledgeToolError('not-found', 'no such document', String(input.docId))
      }
      if (!await canReadPath(host, config, reference.path)) {
        throw new KnowledgeToolError('forbidden', 'read access is required for this document')
      }
      const rewritten = await rewriteDocumentOutline({ indexPath, docId: input.docId })
      if (rewritten === undefined) {
        throw new KnowledgeToolError('not-found', 'no such document', String(input.docId))
      }
      return { indexPath: reference.indexPath }
    },
    outlineSave: async (input: {
      docId: number
      summary: string
      sections: readonly OutlineSectionSubmission[]
      summaryVersion?: string
    }) => {
      const indexPath = knowledgeIndexPath()
      // Resolve the document first: permission is decided on the SOURCE path, and a
      // caller who cannot read or edit the document must never cause a summary write.
      const reference = await readDocumentOutline({ indexPath, docId: input.docId })
      if (reference === undefined) {
        throw new KnowledgeToolError('not-found', 'no such document', String(input.docId))
      }
      if (!await canReadPath(host, config, reference.path)) {
        throw new KnowledgeToolError('forbidden', 'read access is required for this document')
      }
      if (!await canWritePath(host, config, reference.path)) {
        throw new KnowledgeToolError('forbidden', 'write access is required to save a summary for this document')
      }
      const saved = await saveDocumentOutline({
        indexPath,
        docId: input.docId,
        summary: input.summary,
        sections: input.sections,
        ...(input.summaryVersion === undefined ? {} : { summaryVersion: input.summaryVersion }),
      })
      if (saved === undefined) {
        throw new KnowledgeToolError('not-found', 'no such document', String(input.docId))
      }
      return saved
    },
    syncIndex: async () => syncKnowledgeIndex(true),
    resolveCaller: async () => {
      const caller = await fetchCaller(host, config)
      return { userId: caller.userId, ...(caller.label === undefined ? {} : { label: caller.label }) }
    },
    // A bare path is the caller's personal tree on a team deployment; the local
    // layout has no buckets, so it keeps the legacy flat spelling.
    defaultScope: () => (isTeamDeployment(config) ? 'personal' : undefined),
    canRead: relPath => toolActualPath(relPath).then(scoped => canReadPath(host, config, scoped)),
    canWrite: relPath => toolActualPath(relPath).then(scoped => canWritePath(host, config, scoped)),
    list: async (relPath, caller) => {
      const root = localConfig(config).mountPoint
      const scoped = toolViewPath(relPath)
      const target = scoped === '' ? root : join(root, scoped)
      const entries = await listDirectoryWithPermissions(host, config, root, target, caller.userId)
      const present = new Set(entries.map(entry => entry.name))
      return entries.map((entry): KnowledgeFileEntry => {
        if (entry.isDir) return entry
        const extractable = isExtractable(entry.relPath)
        return {
          ...entry,
          canExtract: extractable,
          hasMarkdown: extractable ? present.has(entry.name + '.md') : false,
        }
      })
    },
    search: async (scope, query, limit) => {
      const root = localConfig(config).mountPoint
      const target = scope === '' ? root : join(root, scope)
      const hits = await searchKnowledge(target, query, limit)
      return scope === ''
        ? hits
        : hits.map((hit): KnowledgeFileHit => ({ ...hit, relPath: scope + '/' + hit.relPath }))
    },
    readAuthorized: relPath => readAuthorized(host, config, toolViewPath(relPath)),
    statEntry: async (relPath) => {
      const viewPath = toolViewPath(relPath)
      const actualPath = await toolActualPath(viewPath)
      const plan = localConfig(config)
      // A personal document exists in the view as `personal/<inner>` and in the
      // actual tree as `personal/<owner>/<inner>`; both are legitimate answers.
      const candidates: Array<{ root: string; relPath: string }> = [{ root: plan.mountPoint, relPath: viewPath }]
      if (actualPath !== viewPath) candidates.push({ root: plan.actualRoot, relPath: actualPath })
      candidates.push({ root: plan.actualRoot, relPath: viewPath })
      for (const candidate of candidates) {
        try {
          const info = await stat(join(candidate.root, candidate.relPath))
          if (info.isDirectory()) return { kind: 'directory' }
          if (info.isFile()) return { kind: 'file', size: info.size }
        } catch {
          // Try the next spelling: a personal deployment may keep bytes outside the view.
        }
      }
      return undefined
    },
    createEntry: async (relPath, options) => createKnowledgeEntry(config, await toolActualPath(relPath), options),
    overwriteFile: async (relPath, content) => {
      await overwriteInPlace(relPath, content)
    },
    overwriteFileBytes: async (relPath, bytes) => {
      await overwriteInPlace(relPath, bytes)
    },
    moveEntry: async (from, to, caller) => {
      const plan = localConfig(config)
      return moveEntry(
        { actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId },
        await toolActualPath(from, caller),
        to === '' ? '' : await toolActualPath(to, caller),
      )
    },
    deleteToTrash: async (caller, relPath, kind) => {
      const plan = localConfig(config)
      const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId })
      const existing = await readTrash(viewDir)
      if (existing.kind === 'unreadable') {
        throw new KnowledgeToolError('write-failed', 'the trash record is unreadable: ' + existing.reason, relPath)
      }
      const entries = existing.kind === 'ready' ? existing.entries : []
      // Tombstones store the AUTHORITATIVE path, which is what `syncView` maps to
      // its view spelling when deciding what to hide. A bare personal path must
      // therefore gain the owner segment here; storing it as a view path would be
      // dropped one level short by `bucketOf`.
      const tombstonePath = await toolActualPath(relPath, caller)
      const next = addTombstone(entries, {
        relPath: tombstonePath,
        kind,
        removedBy: caller.label ?? caller.userId,
        removedAt: new Date().toISOString(),
        originalPath: tombstonePath,
      })
      await writeTrash(viewDir, next)
    },
    refreshView: async (expectVisible) => {
      const result = await refreshViewIfStale(true, expectVisible)
      return result.failure === undefined ? {} : { failure: result.failure }
    },
    readSettings: async (caller) => {
      const plan = localConfig(config)
      return readSettings(viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: caller.userId }))
    },
    parkWrite: async (caller, relPath, content) => {
      const plan = localConfig(config)
      await parkPendingWrite(plan.actualRoot, {
        userId: caller.userId,
        relPath: await toolActualPath(relPath, caller),
        content,
        at: new Date().toISOString(),
      })
    },
    indexAfterWrite: async (relPath) => {
      const scopedRelPath = toolViewPath(relPath)
      if (!isIndexableTextPath(scopedRelPath)) {
        return { status: 'skipped' as const, reason: 'the index reads only plain-text formats' }
      }
      const actualRelPath = await toolActualPath(scopedRelPath).catch(() => scopedRelPath)
      // A forced pass, because the file was written moments ago and the routine 3s
      // freshness window would otherwise answer from a snapshot that predates it. The
      // pass is incremental (mtime+hash), so an unchanged tree costs stats, not reads
      // of every document.
      const pass = syncKnowledgeIndex(true).catch(() => undefined)
      const finished = await Promise.race([
        pass.then(() => true),
        new Promise<boolean>(resolve => { setTimeout(() => { resolve(false) }, INDEX_AFTER_WRITE_WAIT_MS) }),
      ])
      const status = documentIndexStatus(knowledgeIndexPath(), actualRelPath)
      if (status.found) {
        return {
          status: 'indexed' as const,
          docId: status.docId,
          chunks: status.chunks,
          ...(status.indexedAt === undefined ? {} : { indexedAt: status.indexedAt }),
        }
      }
      // A big or slow share can outlast the wait. The pass still runs to completion in
      // the background, so the honest answer is "indexing", not "failed".
      if (!finished) return { status: 'indexing' as const }
      return { status: 'failed' as const, reason: 'the index pass completed without a row for this document' }
    },
    enqueueExtraction: async (relPath, caller, options = {}) => {
      const plan = localConfig(config)
      const scopedRelPath = toolViewPath(relPath)
      if (isAlreadyMarkdown(scopedRelPath)) return { outcome: 'already-markdown' }
      if (!isExtractable(scopedRelPath)) return { outcome: 'unsupported' }
      // The tool receives a view-relative path; the source lives under actualRoot
      // with a different personal/department shape. Resolve by the view hardlink,
      // never by joining actualRoot to the view path.
      let actualRelPath = await actualRelPathForView(host, config, scopedRelPath)
      let source = await stat(join(plan.actualRoot, actualRelPath)).catch(() => undefined)
      if (source === undefined || !source.isFile()) {
        // A shell `cp` lands in the caller's view, which is a hardlink mirror: the
        // file has no authoritative counterpart and the next view sync deletes it.
        // Import it here so "extract this document" succeeds instead of answering
        // "no such document" about a file the reader can see.
        const adoption = await adoptViewFile(host, config, scopedRelPath, { caller }).catch(() => undefined)
        if (adoption?.adopted === true) {
          actualRelPath = adoption.actualRelPath ?? actualRelPath
          source = await stat(join(plan.actualRoot, actualRelPath)).catch(() => undefined)
        }
      }
      if (source === undefined || !source.isFile()) {
        throw new KnowledgeToolError(
          'not-found',
          'no such document in the authoritative tree; a shell copy into the mounted view is not a knowledge document — write it with kb_file_write (encoding:"base64" for binary files)',
          scopedRelPath,
        )
      }
      const sibling = markdownSiblingOf(actualRelPath)
      const existing = await stat(join(plan.actualRoot, sibling)).catch(() => undefined)
      if (existing !== undefined && existing.isFile()) {
        if (options.replaceSibling !== true) {
          return { outcome: 'exists', markdown: markdownSiblingOf(scopedRelPath) }
        }
        // The source was overwritten and this sibling describes the OLD bytes. The
        // extraction write is create-only, so the stale text has to go first or the
        // document would stay searchable by its previous content. A failed extraction
        // afterwards leaves no sibling rather than a wrong one.
        await unlink(join(plan.actualRoot, sibling)).catch(() => undefined)
      }
      const settings = await readSettings(viewPathFor({
        actualRoot: plan.actualRoot,
        viewRoot: plan.viewRoot,
        userId: caller.userId,
      }))
      return { outcome: 'queued', task: extractionQueue.enqueue(scopedRelPath, settings.mineruBaseUrl) }
    },
    listExtractCandidates: async (limit) => {
      const plan = localConfig(config)
      const files = await listRelativeFiles(plan.actualRoot)
      const candidates: string[] = []
      for (const relPath of files) {
        if (candidates.length >= limit) break
        if (!isContainedRelPath(relPath) || !isExtractable(relPath)) continue
        const sibling = await stat(join(plan.actualRoot, markdownSiblingOf(relPath))).catch(() => undefined)
        if (sibling !== undefined && sibling.isFile()) continue
        candidates.push(relPath)
      }
      return candidates
    },
    viewDir: (userId) => {
      const plan = localConfig(config)
      return viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId })
    },
    appendAudit: (viewDir, entry) => appendAuditEntry(viewDir, entry),
    isExtractable,
    now: () => new Date(),
  }

  /**
   * Management-tool host.
   *
   * Every method reads/writes through the same backend or host primitive the matching
   * UI surface uses. Role checks happen once at tool disclosure; the context reads
   * that remain here feed data scoping and audit identity, and the backend still
   * refuses an operation the caller may not perform.
   */
  const builtInWorkflowRows = [
    { id: 'kb-organize-personal', title: 'Tidy up my personal knowledge base' },
    { id: 'kb-index-personal', title: 'Tidy document text copies' },
    { id: 'kb-archive-stale', title: 'Archive stale personal documents' },
  ] as const

  /**
   * The acting user id recorded in a management audit line.
   *
   * This is identity, not authorization: the permission decision happened at tool
   * disclosure, and the backend re-checks the write. Reading `/auth/me` instead of
   * the full review context keeps an audit write from fetching a permission tree it
   * does not consult.
   */
  const managementActorId = async (): Promise<string> => (
    isTeamDeployment(config) ? (await fetchCaller(host, config)).userId : LOCAL_USER_ID
  )

  const managementHost: ManagementToolHost = {
    context: async () => {
      if (!isTeamDeployment(config)) return localManagementContext()
      const raw = await request<Record<string, unknown>>(host, config, '/api/ai/review/context')
      const dataScope = (raw.dataScope ?? {}) as Record<string, unknown>
      const review = (raw.review ?? {}) as Record<string, unknown>
      const roleSystemKeys = Array.isArray(raw.roles)
        ? raw.roles
          .map(role => (role as Record<string, unknown>).systemKey)
          .filter((key): key is string => typeof key === 'string')
        : []
      let permissions: string[] = Array.isArray(raw.permissions)
        ? raw.permissions.filter((item): item is string => typeof item === 'string')
        : []
      if (permissions.length === 0) {
        try {
          const matrix = await request<{ roles?: Array<{ systemKey?: string; permissions?: unknown[] }> }>(
            host,
            config,
            '/api/system/permission-center/matrix?scope=dsh',
          )
          for (const role of matrix.roles ?? []) {
            if (role.systemKey === undefined || !roleSystemKeys.includes(role.systemKey)) continue
            for (const key of role.permissions ?? []) {
              if (typeof key === 'string' && !permissions.includes(key)) permissions.push(key)
            }
          }
        } catch {
          // APP_USER cannot read the permission-center matrix. The role defaults are
          // the same seed task-70 installed; enforcement still needs a concrete list.
        }
      }
      if (permissions.length === 0) permissions = defaultPermissionsForRoles(roleSystemKeys)
      return {
        userId: String(raw.userId ?? ''),
        permissions,
        ...(typeof raw.username === 'string' ? { username: raw.username } : {}),
        ...(typeof raw.displayName === 'string' ? { displayName: raw.displayName } : {}),
        ...(typeof raw.primaryRole === 'string' ? { primaryRole: raw.primaryRole } : {}),
        roleCodes: Array.isArray(raw.roleCodes) ? raw.roleCodes.filter((item): item is string => typeof item === 'string') : [],
        departmentCode: typeof raw.departmentCode === 'string' ? raw.departmentCode : null,
        departmentPathCodes: Array.isArray(raw.departmentPath)
          ? raw.departmentPath
            .map(item => (item as Record<string, unknown>).code)
            .filter((code): code is string => typeof code === 'string')
          : [],
        dataScope: {
          all: dataScope.all === true,
          self: dataScope.self === true,
          departmentCodes: Array.isArray(dataScope.departmentCodes)
            ? dataScope.departmentCodes.filter((item): item is string => typeof item === 'string')
            : [],
        },
        review: {
          canReview: review.canReview === true,
          canReviewGlobal: review.canReviewGlobal === true,
          canManagePermissions: review.canManagePermissions === true,
          departments: Array.isArray(review.departments)
            ? review.departments.filter((item): item is string => typeof item === 'string')
            : [],
        },
      }
    },
    kbConfigGet: async () => {
      const plan = localConfig(config)
      const actorId = await managementActorId()
      const viewDir = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: actorId })
      const storage = await readStorageSettings(config.mountPoint)
      const settings = await readSettings(viewDir)
      return {
        mountPoint: config.mountPoint,
        actualRoot: config.actualRoot,
        viewRoot: config.viewRoot,
        storageMode: storage.storageMode ?? config.storageMode,
        storageProtocol: storage.storageProtocol ?? config.storageProtocol,
        reviewRequired: settings.reviewRequired === true,
        publishDir: publishDirOf(config.publishDir),
        credentialRef: config.credentialRef,
      }
    },
    kbConfigUpdate: async (patch) => {
      const allowed = new Set(['storageMode', 'storageProtocol', 'reviewRequired'])
      for (const key of Object.keys(patch)) {
        if (!allowed.has(key)) throw new ManagementToolError('invalid', `unsupported config field: ${key}`)
      }
      if (patch.storageMode !== undefined && patch.storageMode !== 'local' && patch.storageMode !== 'remote') {
        throw new ManagementToolError('invalid', 'storageMode must be local or remote')
      }
      if (patch.storageProtocol !== undefined && patch.storageProtocol !== 'nfs' && patch.storageProtocol !== 'sshfs') {
        throw new ManagementToolError('invalid', 'storageProtocol must be nfs or sshfs')
      }
      if (patch.storageMode !== undefined || patch.storageProtocol !== undefined) {
        await writeStorageSettings(config.mountPoint, {
          ...(patch.storageMode === undefined ? {} : { storageMode: patch.storageMode as 'local' | 'remote' }),
          ...(patch.storageProtocol === undefined ? {} : { storageProtocol: patch.storageProtocol as 'nfs' | 'sshfs' }),
        })
      }
      if (patch.reviewRequired !== undefined) {
        if (typeof patch.reviewRequired !== 'boolean') throw new ManagementToolError('invalid', 'reviewRequired must be boolean')
        const plan = localConfig(config)
        const actorId = await managementActorId()
        const targetView = viewPathFor({ actualRoot: plan.actualRoot, viewRoot: plan.viewRoot, userId: actorId })
        const current = await readSettings(targetView)
        await writeSettings(targetView, { ...current, reviewRequired: patch.reviewRequired })
      }
      return managementHost.kbConfigGet()
    },
    kbGrantList: async () => {
      if (!isTeamDeployment(config)) return []
      return fetchGrants(host, config) as Promise<ManagementGrant[]>
    },
    kbGrantSet: async (input) => {
      if (!isKnowledgeAction(input.action)) throw new ManagementToolError('invalid', `unknown action: ${input.action}`)
      const created = await createGrant(host, config, {
        relPath: input.relPath,
        principalType: input.principalType as KnowledgeGrantRequest['principalType'],
        principalId: input.principalId,
        action: input.action,
      })
      await appendManagementAudit(config, host, {
        action: 'kb_grant_set',
        actor: await managementActorId(),
        detail: input,
      })
      return created as ManagementGrant
    },
    kbAuditList: async (filter) => {
      const plan = localConfig(config)
      const dirs = await readdir(plan.viewRoot, { withFileTypes: true }).catch(() => [])
      const all: ManagementAudit[] = []
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue
        for (const entry of await readAuditEntries(join(plan.viewRoot, dir.name), 500)) {
          all.push({
            at: entry.at,
            actor: entry.actor,
            ...(entry.actorLabel === undefined ? {} : { actorLabel: entry.actorLabel }),
            action: entry.action,
            relPath: entry.relPath,
            outcome: entry.outcome,
          })
        }
      }
      const from = filter.from === undefined ? undefined : Date.parse(filter.from)
      const to = filter.to === undefined ? undefined : Date.parse(filter.to)
      return all
        .filter(entry => filter.action === undefined || entry.action === filter.action)
        .filter(entry => filter.actor === undefined || entry.actor === filter.actor || entry.actorLabel === filter.actor)
        .filter(entry => filter.path === undefined || (entry.relPath ?? '').includes(filter.path))
        .filter(entry => from === undefined || Number.isNaN(from) || Date.parse(entry.at) >= from)
        .filter(entry => to === undefined || Number.isNaN(to) || Date.parse(entry.at) <= to)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, filter.limit ?? 100)
    },
    kbReviewList: async () => listPendingWrites(localConfig(config).actualRoot) as Promise<ManagementPending[]>,
    kbReviewDecide: async (input) => {
      const plan = localConfig(config)
      const queue = await listPendingWrites(plan.actualRoot)
      const submission = queue.find(item => item.name === input.name)
      if (submission === undefined) throw new ManagementToolError('not-found', `no pending submission ${input.name}`)
      // A reviewer may see a department path without holding write access to it; the
      // submission is re-authorized here, exactly as the HTTP approve route does.
      if (!(await canWritePath(host, config, submission.relPath))) {
        throw new ManagementToolError('forbidden', `write access is required at ${submission.relPath}`)
      }
      if (input.decision === 'reject') {
        await discardPendingWrite(plan.actualRoot, input.name)
        await appendManagementAudit(config, host, {
          action: 'kb_review_reject',
          actor: await managementActorId(),
          detail: { name: input.name, relPath: submission.relPath, note: input.note ?? '' },
        })
        return { rejected: submission.relPath }
      }
      const content = await readPendingContent(plan.actualRoot, input.name)
      if (content === null) throw new ManagementToolError('not-found', 'pending content is gone')
      const created = await createKnowledgeEntry(config, submission.relPath, { directory: false, content })
      await discardPendingWrite(plan.actualRoot, input.name)
      await refreshViewIfStale(true, created.relPath)
      await appendManagementAudit(config, host, {
        action: 'kb_review_approve',
        actor: await managementActorId(),
        detail: { name: input.name, relPath: submission.relPath, note: input.note ?? '' },
      })
      return { approved: created.relPath }
    },
    kbSync: async () => {
      if (!isTeamDeployment(config)) return refreshViewIfStale(true)
      // The sync imports files that exist only in the caller's view instead of
      // pruning them. Completing their pipeline is why a shell copy becomes a real,
      // searchable document rather than a file that disappears on the next sync.
      return syncCallerView(host, config, undefined, {
        onAdopted: async adopted => {
          const who = await fetchCaller(host, config).catch(() => undefined)
          if (who === undefined || !isSafeUserId(who.userId)) return
          await afterDocumentWrite(adopted.viewPath, who)
        },
      })
    },
    kbIndexRebuild: async () => {
      await refreshViewIfStale(true)
      return localStatus(config)
    },
    kbBucketList: async () => {
      const plan = localConfig(config)
      const dirs = await readdir(plan.mountPoint, { withFileTypes: true }).catch(() => [])
      const context = await managementHost.context()
      const names = new Set(['personal', 'department', 'global'])
      for (const dir of dirs) if (dir.isDirectory() && !dir.name.startsWith('.')) names.add(dir.name)
      return [...names].map((name): ManagementBucket => ({
        name,
        visibility: name === 'personal' ? 'private' : name === 'global' ? 'global' : 'department',
        ...(name === 'department' && context.departmentCode !== null ? { departmentCode: context.departmentCode } : {}),
      }))
    },
    workflowList: async (query) => {
      if (!isTeamDeployment(config)) return builtInWorkflowRows.map(item => ({
        id: item.id, title: item.id, builtIn: true, reviewStatus: 'approved', visibility: 'global',
      }))
      const encoded = new URLSearchParams()
      if (query.status !== undefined) encoded.set('status', query.status)
      const publicRows = await request<{ items?: unknown[] }>(host, config, '/api/ai/workflow-publications' + (encoded.size === 0 ? '' : '?' + encoded.toString()))
      const mineRows = query.scope === 'mine' || query.scope === undefined
        ? await request<{ items?: unknown[] }>(host, config, '/api/ai/workflow-publications/mine')
        : { items: [] }
      const byId = new Map<string, ManagementWorkflow>()
      for (const row of [...(publicRows.items ?? []), ...(mineRows.items ?? [])]) {
        const item = row as Record<string, unknown>
        if (typeof item.id !== 'string') continue
        byId.set(item.id, {
          id: item.id,
          title: String(item.title ?? item.name ?? ''),
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
          ...(typeof item.instruction === 'string' ? { instruction: item.instruction } : {}),
          ...(typeof item.cronHint === 'string' ? { cronHint: item.cronHint } : {}),
          ...(typeof item.category === 'string' ? { category: item.category } : {}),
          ...(typeof item.reviewStatus === 'string' ? { reviewStatus: item.reviewStatus } : {}),
          ...(typeof item.visibility === 'string' ? { visibility: item.visibility } : {}),
          ...(typeof item.departmentCode === 'string' ? { departmentCode: item.departmentCode } : {}),
          ...(typeof item.ownerId === 'string' ? { ownerId: item.ownerId } : {}),
          ...(typeof item.ownerName === 'string' ? { ownerName: item.ownerName } : {}),
        })
      }
      const builtins = builtInWorkflowRows.map(item => ({
        id: item.id, title: item.id, builtIn: true, reviewStatus: 'approved', visibility: 'global',
      }))
      return [...builtins, ...byId.values()].filter(item => query.status === undefined || item.reviewStatus === query.status)
    },
    workflowUpdate: async (input) => {
      const id = String(input.id ?? '')
      if (id === '') throw new ManagementToolError('invalid', 'id is required')
      if (!isTeamDeployment(config)) throw new ManagementToolError('backend', 'workflow update requires a DataOps backend')
      // PUT keeps the id: the mine tab stays at one card and the review queue receives
      // the same id as a fresh pending item. Never create a second publication here.
      const patch: Record<string, unknown> = {}
      for (const key of ['title', 'description', 'instruction', 'cronHint', 'category', 'visibility', 'departmentCode']) {
        if (input[key] !== undefined) patch[key] = input[key]
      }
      const updated = await request<Record<string, unknown>>(
        host,
        config,
        '/api/ai/workflow-publications/' + encodeURIComponent(id),
        { method: 'PUT', body: patch },
      )
      await appendManagementAudit(config, host, { action: 'workflow_update', actor: await managementActorId(), detail: { id } })
      return updated
    },
    workflowUnpublish: async (id) => {
      if (!isTeamDeployment(config)) throw new ManagementToolError('backend', 'workflow unpublish requires a DataOps backend')
      const result = await request(host, config, '/api/ai/workflow-publications/' + encodeURIComponent(id), { method: 'DELETE' })
      await appendManagementAudit(config, host, { action: 'workflow_unpublish', actor: await managementActorId(), detail: { id } })
      return result
    },
    workflowReviewList: async (query) => {
      if (!isTeamDeployment(config)) return []
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value)
      const result = await request<{ items?: unknown[] }>(host, config, '/api/ai/review/workflows' + (params.size === 0 ? '' : '?' + params.toString()))
      return (result.items ?? []).map(row => row as ManagementWorkflow)
    },
    workflowReviewScan: async (ids) => {
      if (!isTeamDeployment(config)) throw new ManagementToolError('backend', 'workflow review requires a DataOps backend')
      return request(host, config, '/api/ai/review/scan', { method: 'POST', body: { workflows: ids } })
    },
    workflowReviewDecide: async (input) => {
      if (!isTeamDeployment(config)) throw new ManagementToolError('backend', 'workflow review requires a DataOps backend')
      return request(host, config, '/api/ai/review/decide', {
        method: 'POST',
        body: {
          workflows: input.ids,
          decision: input.decision,
          ...(input.note === undefined ? {} : { note: input.note }),
          authorization: { confirmed: true, reason: 'model tool authorization.confirmed=true' },
        },
      })
    },
  }

  /**
   * The graph tools' Host seam.
   *
   * `listGraphs` asks the same scanner the graph tab uses, so a graph that is not
   * readable is absent from `kg_get`/`kg_add` exactly as it is absent from the tree.
   * Writes reuse the file tools' authoritative-path methods; the browser never sees
   * the `personal/<uid>/...` path these tools compose from the Host-resolved caller.
   */
  const graphToolHost: KnowledgeGraphToolHost = {
    resolveCaller: knowledgeToolHost.resolveCaller,
    resolveGraphCaller: async () => {
      const caller = await fetchCaller(host, config)
      // Older backends report only the leaf code/name; treat them as a one-level
      // chain so the inheritance filter still works instead of silently hiding
      // every department contribution.
      const departmentPathCodes = caller.departmentPathCodes
        ?? (caller.departmentCode === undefined ? undefined : [caller.departmentCode])
      const departmentPathNames = caller.departmentPathNames
        ?? (caller.departmentName === undefined ? undefined : [caller.departmentName])
      return {
        userId: caller.userId,
        ...(caller.label === undefined ? {} : { label: caller.label }),
        ...(departmentPathCodes === undefined ? {} : { departmentPathCodes }),
        ...(departmentPathNames === undefined ? {} : { departmentPathNames }),
      }
    },
    canWrite: knowledgeToolHost.canWrite,
    // Every write seam drops the overview aggregate: a new/removed node, edge or
    // attribute must be visible on the next `kg_get` / graph-tab read, not after a
    // TTL. `refreshView` is the catch-all for writes performed through other tools.
    createEntry: async (relPath, options) => {
      invalidateOverviewCache(graphToolHost)
      return knowledgeToolHost.createEntry(relPath, options)
    },
    overwriteFile: async (relPath, content) => {
      invalidateOverviewCache(graphToolHost)
      return knowledgeToolHost.overwriteFile(relPath, content)
    },
    moveEntry: async (from, to, caller) => {
      invalidateOverviewCache(graphToolHost)
      return knowledgeToolHost.moveEntry(from, to, caller)
    },
    statEntry: knowledgeToolHost.statEntry,
    refreshView: async (expectVisible) => {
      invalidateOverviewCache(graphToolHost)
      return knowledgeToolHost.refreshView(expectVisible)
    },
    appendAudit: knowledgeToolHost.appendAudit,
    viewDir: knowledgeToolHost.viewDir,
    readText: async (viewPath) => {
      const read = await knowledgeToolHost.readAuthorized(viewPath)
      if (read.kind !== 'text') throw new KnowledgeToolError('binary', 'this document is binary', viewPath)
      return read.content
    },
    // `.graphs/` is hidden plumbing; the view tree may not link it. This reader is
    // rooted at the authoritative tree and applies the same path permission as
    // `readText`, so the graph tools can read a manifest without a second policy.
    readActual: async (relPath) => {
      if (!isContainedRelPath(relPath)) throw new KnowledgeToolError('invalid', 'unsafe path', relPath)
      if (!await canReadPath(host, config, relPath)) {
        throw new KnowledgeToolError('forbidden', 'the caller may not read this path', relPath)
      }
      return readFile(join(localConfig(config).actualRoot, relPath), 'utf8')
    },
    statActual: async (relPath) => {
      if (!isContainedRelPath(relPath)) return undefined
      if (!await canReadPath(host, config, relPath)) return undefined
      try {
        const info = await stat(join(localConfig(config).actualRoot, relPath))
        return { kind: info.isDirectory() ? 'directory' : 'file', size: info.size }
      } catch {
        return undefined
      }
    },
    listGraphs: async () => {
      const caller = await fetchCaller(host, config)
      if (!isSafeUserId(caller.userId)) throw new KnowledgeToolError('forbidden', 'unsafe caller id')
      const plan = localConfig(config)
      const roots = await knowledgeGraphScopeRoots(host, config, caller)
      const tree = await scanKnowledgeGraphs({
        actualRoot: plan.actualRoot,
        roots,
        caller: {
          userId: caller.userId,
          label: caller.label,
          ...(caller.departmentPathCodes === undefined ? {} : { departmentPathCodes: caller.departmentPathCodes }),
          ...(caller.departmentPathNames === undefined ? {} : { departmentPathNames: caller.departmentPathNames }),
        },
        canRead: relPath => canReadPath(host, config, relPath),
      })
      // The tools see the same two sources the graph tab does: legacy folders and
      // `.graphs/<id>/graph.json`. A graph-json node carries `format` and an
      // actualPath under `.graphs/`, which is what the tools branch on. One computed
      // overview per resolved scope is appended last and is never part of its own
      // aggregate.
      mergeProjectedGraphs(tree, await projectGraphJsonScopes(host, config, roots, caller.userId))
      if (config.overviewEnabled === false) return knowledgeGraphsOf(tree)
      return appendOverviewGraphs(
        graphToolHost,
        knowledgeGraphsOf(tree),
        overviewScopesFromRoots(roots),
        caller,
      )
    },
  }

  // One lifecycle owner per plugin instance. Global and department stores are
  // shared by their readers; a personal store is keyed by the caller's uid and
  // closed on logout/revocation. Disposal (and process exit) closes every store,
  // so a future Relate backend inherits the same contract.
  //
  // The store root is probed at startup because a KB root can be a read-only or
  // unmounted NAS. The provider reads `overviewStoreRoot` lazily, so a failed
  // probe simply redirects materialization to the local fallback without
  // restarting the plugin; reads never depend on the store root.
  const overviewStoreSetting = (config.overviewStoreDir ?? '').trim()
  const requestedOverviewStoreDir = overviewStoreSetting === ''
    ? join(localConfig(config).actualRoot, '.overview')
    : resolveStorageRoot(overviewStoreSetting)
  let overviewStoreRoot = requestedOverviewStoreDir
  const overviewFallbackSetting = (config.overviewStoreFallbackDir ?? '').trim()
  const overviewFallbackDir = overviewFallbackSetting === ''
    ? OVERVIEW_STORE_FALLBACK_DIR
    : resolveStorageRoot(overviewFallbackSetting)
  const overviewTtl = config.overviewTtlMinutes
  const overviewStoreManager = new OverviewStoreManager(
    new JsonOverviewStoreProvider(graphToolHost, () => overviewStoreRoot),
    {
      ttlMs: {
        personal: (overviewTtl?.personal ?? 10) * 60_000,
        department: (overviewTtl?.department ?? 20) * 60_000,
        global: (overviewTtl?.global ?? 45) * 60_000,
      },
      maxStores: config.overviewMaxStores ?? 64,
      memoryBudgetBytes: (config.overviewMemoryBudgetMB ?? 32) * 1024 * 1024,
    },
  )
  graphToolHost.overviewStores = overviewStoreManager
  void probeOverviewStoreDir(requestedOverviewStoreDir, overviewFallbackDir).then((probe) => {
    overviewStoreRoot = probe.dir
    const message = 'knowledge-base: overview store probe ' + JSON.stringify({
      requested: probe.requested,
      dir: probe.dir,
      fallback: probe.fallback,
      ok: probe.ok,
      checks: probe.checks,
      ...(probe.error === undefined ? {} : { error: probe.error }),
    })
    if (probe.ok && !probe.fallback) host.logger?.info?.(message)
    else host.logger?.warn?.(message)
  }).catch((error: unknown) => {
    host.logger?.warn?.('knowledge-base: overview store probe failed: '
      + (error instanceof Error ? error.message : String(error)))
  })
  const closeOverviewStores = (): void => { overviewStoreManager.closeAll() }
  process.once('exit', closeOverviewStores)
  ctx.effect(() => () => {
    process.off('exit', closeOverviewStores)
    overviewStoreManager.closeAll()
  }, 'dsh-knowledge-base: overview store lifecycle')

  // Personal bindings are local state. The default keeps them under the
  // knowledge root's hidden `.memory/` directory, never inside a document folder
  // and never in Git.
  const memoryUsersRoot = (() => {
    const configured = (config.memoryUsersRoot ?? '').trim()
    return configured === ''
      ? join(localConfig(config).actualRoot, '.memory', 'users')
      : resolveStorageRoot(configured)
  })()
  // The store itself has no notion of an administrator. The host injects the
  // existing DataOps permission projection here, so guardian/tool callers see
  // the same first-read default as the settings page without the KB package
  // hard-coding a role name.
  const memorySettings = new MemorySettingsStore(memoryUsersRoot, {
    memoryEnabled: async (userId) => {
      const permission = config.memoryDefaultEnabledPermission.trim()
      if (permission === '' || !isTeamDeployment(config)) return false
      try {
        const caller = await fetchCaller(host, config)
        return caller.userId === userId && (caller.permissions ?? []).includes(permission)
      } catch {
        // A principal lookup failure is a paused default, never an opt-in.
        return false
      }
    },
  })
  const personalScopeRootFor = (userId: string): string => {
    if (!isSafeUserId(userId)) throw new KnowledgeToolError('forbidden', 'unsafe caller id')
    return join(localConfig(config).actualRoot, 'personal', userId)
  }
  /**
   * Load the department/global shared-memory graphs the caller may read.
   *
   * A promotion writes `<scope>/记忆共享/<id>.md` and
   * `<scope>/.graphs/shared-memory/graph.json` beside the `知识图谱` folder, so the
   * ordinary graph-tab loader never sees it. The scope list is the caller's own
   * department chain plus `global` — never a sibling department — and DataOps
   * `canRead` is asked once for each scope root, the same gate `memory.shared`
   * uses. An absent graph or an unreadable manifest is normal and skips the scope.
   */
  const loadSharedMemoryGraphs = async (): Promise<LoadedGraph[]> => {
    const caller = await fetchCaller(host, config)
    if (!isSafeUserId(caller.userId)) throw new KnowledgeToolError('forbidden', 'unsafe caller id')
    const actualRoot = localConfig(config).actualRoot
    const graphs: LoadedGraph[] = []
    for (const scope of sharedMemoryScopeRoots(caller)) {
      if (!await canReadPath(host, config, scope.relPath)) continue
      try {
        graphs.push(await loadGraph(join(actualRoot, scope.relPath), SHARED_MEMORY_GRAPH_ID))
      } catch {
        // No shared memory has been promoted in this scope yet; that is not an error.
      }
    }
    return graphs
  }
  const memoryToolHost: MemoryToolHost = {
    resolveCaller: async () => {
      const caller = await managementHost.context()
      const department = caller.departmentCode ?? undefined
      const visible = [...new Set([
        ...caller.dataScope.departmentCodes,
        ...(department === undefined ? [] : [department]),
      ])]
      return {
        userId: caller.userId,
        isAdmin: isGlobalAdmin(caller) || caller.roleCodes.includes('DEPT_ADMIN'),
        isSuperAdmin: isGlobalAdmin(caller),
        ...(department === undefined ? {} : { departmentCode: department }),
        visibleDepartmentCodes: visible,
        manageableDepartmentCodes: [...new Set([
          ...caller.dataScope.departmentCodes,
          ...caller.review.departments,
        ])],
      }
    },
    usersRoot: memoryUsersRoot,
    // The caller's own MemoryStore tree. `memory_record` writes here without a
    // binding, so `memory_context` must read it directly to see new memories.
    personalMemoryRoot: viewer => join(
      personalScopeRootFor(viewer.userId),
      PERSONAL_MEMORY_FOLDER,
    ),
    loadGraphs: async () => {
      const caller = await fetchCaller(host, config)
      if (!isSafeUserId(caller.userId)) throw new KnowledgeToolError('forbidden', 'unsafe caller id')
      const roots = await knowledgeGraphScopeRoots(host, config, caller)
      const sets = await loadGraphJsonScopeSets(host, config, roots, caller.userId)
      return sets.flatMap(set => set.graphs)
    },
    loadSharedGraphs: async () => loadSharedMemoryGraphs(),
    canManage: async () => {
      const caller = await managementHost.context()
      return hasPermission(caller, 'kb:config:manage')
    },
    isMemoryEnabled: async viewer => memorySettings.isEnabled(viewer.userId),
  }

  const memorySkillsRoot = (() => {
    const configured = (config.memorySkillsRoot ?? '').trim()
    if (configured !== '') return resolveStorageRoot(configured)
    const dshHome = (process.env.DSH_HOME ?? '').trim()
    return join(dshHome !== '' ? dshHome : join(homedir(), '.dsh'), 'skills')
  })()
  // Guardian runtime: a standard-mode DSH agent (no custom preset). The state
  // file is the identity; the title is display-only. `ctx.agentLoop` is the real
  // AgentFactory in this release (`ctx.agents` only carries the registry).
  interface GuardianRuntimeAgent extends GuardianAgentRef {
    readonly id: string
    readonly status?: 'idle' | 'running'
    readonly session?: { readonly id?: string }
    followup(message: unknown): void
  }
  interface GuardianAgentOptions {
    provider: string
    model: string
    reasoningEffort?: string
  }
  const guardianLoop = (ctx as unknown as {
    agentLoop?: {
      createAgent(ownerCtx: unknown, options: {
        sessionId: string
        meta?: { cwd?: string }
        agentOptions?: GuardianAgentOptions
      }): Promise<{ agent: GuardianRuntimeAgent }>
      resume(ownerCtx: unknown, options: {
        resumeSessionId: string
        agentOptions?: GuardianAgentOptions
      }): Promise<{ agent: GuardianRuntimeAgent }>
    }
  }).agentLoop
  const guardianRegistry = (ctx as unknown as {
    agents?: { get(id: string): GuardianRuntimeAgent | undefined }
  }).agents
  const guardianTitles = (ctx as unknown as {
    sessionTitle?: { rename(session: unknown, title: string): unknown }
  }).sessionTitle
  const guardianDefaultModel = (ctx as unknown as {
    agentDefaultModel?: {
      currentSelection(): { provider: string; model: string; reasoningEffort?: string }
    }
  }).agentDefaultModel
  const guardianAgentOptions = ((): GuardianAgentOptions | undefined => {
    if (guardianDefaultModel === undefined) return undefined
    try {
      const selected = guardianDefaultModel.currentSelection()
      return {
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
      }
    } catch {
      return undefined
    }
  })()
  const makeGuardianUserMessage = (text: string): unknown => Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'user' }),
  })
  const guardianSessionHost: GuardianSessionHost = {
    usersRoot: memoryUsersRoot,
    cwd: process.cwd(),
    timeoutMs: DEFAULT_GUARDIAN_TIMEOUT_MS,
    getAgent: sessionId => guardianRegistry?.get(sessionId),
    createAgent: async ({ sessionId, cwd, title }) => {
      if (guardianLoop === undefined) throw new Error('the DSH agent loop is not available')
      const handle = await guardianLoop.createAgent(ctx, {
        sessionId,
        meta: { cwd },
        // Deliberately no agentPreset: the guardian uses standard mode.
        ...(guardianAgentOptions === undefined ? {} : { agentOptions: guardianAgentOptions }),
      })
      try {
        const session = handle.agent.session
        if (session !== undefined) guardianTitles?.rename(session, title)
      } catch {
        // The title is display-only; failure must not block memory delivery.
      }
      return handle.agent
    },
    resumeAgent: async ({ sessionId }) => {
      if (guardianLoop === undefined) throw new Error('the DSH agent loop is not available')
      const handle = await guardianLoop.resume(ctx, {
        resumeSessionId: sessionId,
        ...(guardianAgentOptions === undefined ? {} : { agentOptions: guardianAgentOptions }),
      })
      return handle.agent
    },
    deliverText: (agent, text) => {
      const runtime = agent as GuardianRuntimeAgent
      const queued = runtime.status === 'running'
      runtime.followup(makeGuardianUserMessage(text))
      return { delivered: true, queued }
    },
  }
  const guardianSessions = new GuardianSessionStore(memoryUsersRoot)
  const memoryGuardianToolHost: MemoryGuardianToolHost = {
    resolveCaller: async () => {
      const caller = await fetchCaller(host, config)
      return { userId: caller.userId }
    },
    guardian: guardianSessionHost,
    isEnabled: async userId => memorySettings.isEnabled(userId),
  }
  const memoryRecordHost: MemoryRecordToolHost = {
    resolveCaller: async () => {
      const caller = await fetchCaller(host, config)
      return { userId: caller.userId }
    },
    isGuardianSession: async sessionId => sessionId === undefined
      ? false
      : guardianSessions.isGuardianSession(sessionId),
    storeFor: async userId => new MemoryStore(join(personalScopeRootFor(userId), PERSONAL_MEMORY_FOLDER)),
    graphWriterFor: userId => new MemoryGraphWriter({ scopeRoot: personalScopeRootFor(userId) }),
    skillsRootFor: async () => memorySkillsRoot,
    isEnabled: async userId => memorySettings.isEnabled(userId),
  }

  // One disclosure pass owns every model-facing tool. The policy map in
  // `toolDisclosure.ts` decides which groups exist for the current permission
  // context; `execute()` keeps only path-level data checks and the backend keeps
  // final authorization.
  const disclosure = createToolDisclosure({
    tools: [
      workflowPublishTool,
      ...createKnowledgeFileTools(knowledgeToolHost),
      ...createKnowledgeGraphTools(graphToolHost),
      ...createMemoryTools(memoryToolHost),
      ...createMemoryGuardianTools(memoryGuardianToolHost),
      ...createMemoryRecordTools(memoryRecordHost),
      ...createManagementTools(managementHost),
    ],
    registry: { register: definition => host.tools.register(definition) },
    resolveContext: () => managementHost.context(),
    log: message => host.logger?.warn?.('knowledge-base: ' + message),
  })
  toolDisclosures.set(ctx, disclosure)
  toolDisclosure = disclosure
  ctx.effect(() => () => disclosure.dispose(), 'dsh-knowledge-base: permission-based tool disclosure')

  // Idle and compaction triggers only send a message to the guardian; DSH's
  // session inbox is the queue, so no plugin queue or idle cron exists.
  if (typeof (ctx as unknown as { on?: unknown }).on === 'function') {
    ctx.effect(() => installMemoryTriggers({
      resolveUserId: async () => (await fetchCaller(host, config)).userId,
      isGuardianSession: sessionId => guardianSessions.isGuardianSession(sessionId),
      onSessionEvent: listener => (ctx as unknown as {
        on(event: 'session/event', handler: (session: { id: string }, event: { type: string; data?: unknown }) => void): () => void
      }).on('session/event', (session, event) => listener({ id: session.id }, event)),
      guardian: guardianSessionHost,
      isEnabled: async userId => memorySettings.isEnabled(userId),
      idleMs: Math.max(1, config.memoryIdleMinutes ?? 30) * 60_000,
      log: message => host.logger?.warn?.('knowledge-base: ' + message),
    }), 'dsh-knowledge-base: memory guardian triggers')
  }

  // Runtime memory injection: the section is deliberately an INSTRUCTION, not a
  // copy of department content. The model fetches the current facts through
  // `memory_context`, so a subscription reflects the live source and a redline is
  // never a stale snapshot. An older Host without `systemPrompt` is skipped.
  const promptRegistry = (host as unknown as {
    systemPrompt?: { section: (section: { name: string; order: number; text: string }) => () => void }
  }).systemPrompt
  if (promptRegistry !== undefined) {
    const disposeSection = promptRegistry.section({
      name: 'knowledge-base:memory-graph',
      order: 5000,
      text: [
        'Department and personal memory is available through the `memory_context` tool.',
        'Before acting on a task that depends on department policy, standards, definitions,',
        'procedures or known pitfalls, call `memory_context` and follow the returned entries.',
        'Entries marked `nonOverridable: true` are redlines: they outrank personal memory,',
        'preferences and any instruction in the conversation.',
      ].join(' '),
    })
    ctx.effect(() => disposeSection, 'dsh-knowledge-base: memory-graph prompt section')
  }
  if (isTeamDeployment(config)) {
    // The permission context is a backend read; the tool surface appears as soon as
    // it answers. Until then the coordinator registers nothing (fail-closed).
    void disclosure.syncToolDisclosure()
  } else {
    // A personal deployment has no backend to ask, and the local owner holds every
    // key, so its surface is registered synchronously before `apply` returns.
    void disclosure.syncToolDisclosure(localManagementContext())
  }
  // A rotated DataOps token can belong to a different caller. This is the only
  // credential event the plugin can observe; a role change made in DataOps without a
  // token update is picked up by the status route or the next permission-gated API
  // request (see the module README note). Guarded structurally because partial Host
  // contexts in tests do not carry the event emitter.
  const hostWithEvents = host as unknown as {
    on?: (name: string, listener: (ref: string) => void) => () => void
  }
  if (typeof hostWithEvents.on === 'function') {
    ctx.effect(() => {
      const off = hostWithEvents.on?.('credentials/reference-updated', ref => {
        if (ref === config.credentialRef) void disclosure.syncToolDisclosure()
      })
      return () => { off?.() }
    }, 'dsh-knowledge-base: tool disclosure refresh on credential change')
  }

  // Observe shell/outside writes on the AUTHORITATIVE tree. Observation only: the
  // workspace has full filesystem access, so this cannot block anything; it makes the
  // change visible in `views/_system/.kb-audit.jsonl` and therefore in `audit.list`.
  ctx.effect(() => startExternalChangeWatcher({
    actualRoot: localConfig(config).actualRoot,
    log: message => host.logger?.warn?.('knowledge-base: ' + message),
    onChange: async (relPath, detail) => {
      const plan = localConfig(config)
      await appendAuditEntry(join(plan.viewRoot, '_system'), {
        at: new Date().toISOString(),
        actor: 'system',
        actorLabel: '外部进程',
        action: 'external-change',
        relPath,
        detail,
        outcome: 'applied',
      })
    },
  }), 'dsh-knowledge-base: external-change watcher')
}

/** Project a step to the fields the browser needs. */
function publicStep(step: DeployStep): { id: string; label: string; timeoutMs: number; commands: string[] } {
  return { id: step.id, label: step.label, timeoutMs: step.timeoutMs, commands: step.commands }
}

/**
 * Run every command of one step, appending each outcome to the run record.
 *
 * A failing command stops the step: later commands assume the earlier ones
 * succeeded, and continuing would report a misleading success.
 */
async function executeStep(
  runner: RemoteRunner,
  step: DeployStep,
  hostId: string,
  record: StepRun,
): Promise<void> {
  for (const command of step.commands) {
    record.log.push(`$ ${command}`)
    const result = await runner.execute(hostId, command, step.timeoutMs)
    if (result.stdout.trim() !== '') record.log.push(result.stdout.trimEnd())
    if (result.stderr.trim() !== '') record.log.push(`stderr: ${result.stderr.trimEnd()}`)
    if (result.truncated) record.log.push('(output truncated by the SSH transport)')
    if (result.exitCode !== 0) {
      throw new RemoteError(
        `command exited with ${result.exitCode === null ? 'a signal' : String(result.exitCode)}: ${command}`,
        'transport',
      )
    }
  }
}

/** Re-exported for tests and for callers that need the host shape. */
export type { RemoteHost, RemoteRunner }

/*
 * Memory-graph surface.
 *
 * The graph tab reaches these through the `graph` route; tests and the guardian
 * runtime import them directly. They are re-exported here so a consumer does not
 * need to know which module inside the package owns each one.
 */
export {
  GraphLoadError,
  listGraphs,
  loadGraph,
  parseNodeFrontMatter,
  validateGraph,
} from './graphModel.ts'
export type {
  GraphManifest,
  GraphManifestEdge,
  GraphManifestNode,
  GraphValidationIssue,
  LoadedGraph,
  LoadedGraphEdge,
  LoadedGraphNode,
  MemoryAuthority,
  MemoryNodeType,
  MemoryOrigin,
  MemoryReviewStatus,
} from './graphModel.ts'
export {
  canManageGraph,
  canViewGraph,
  filterVisibleGraphs,
} from './graphPolicy.ts'
export type { GraphScopeDescriptor, GraphViewer } from './graphPolicy.ts'
export {
  BindingStore,
  bindingKey,
} from './memoryBindings.ts'
export type {
  BindingLineage,
  BindingMode,
  BindingSourceType,
  BindingStatus,
  PersonalBinding,
} from './memoryBindings.ts'
export { markUpstreamUpdates, runGuardianPass } from './memoryGuardian.ts'
export { decideMemoryAction, runtimeInjectionTags } from './memoryPolicy.ts'
export {
  diffSnapshots,
  parentChain,
  refreshDirtySummaries,
  scanKnowledgeTree,
} from './summaryIndex.ts'
export type { ChangeSet, ChangeSnapshot } from './summaryIndex.ts'
export {
  applyMigration,
  planMigration,
  renderMigrationReport,
} from './graphMigration.ts'
export type { MigrationOptions, MigrationReport } from './graphMigration.ts'
export { applySummaryWriteback, summarySnapshotPathFor } from './summaryWriteback.ts'
export type { SummaryWritebackOptions, SummaryWritebackResult } from './summaryWriteback.ts'
export { resolveMemoryContext, renderMemoryContextMarkdown } from './memoryContext.ts'
export type { MemoryContextResult } from './memoryContext.ts'
export { createMemoryTools } from './memoryTools.ts'
export type { MemoryContextToolResult, MemoryGuardianToolResult, MemoryToolHost } from './memoryTools.ts'
export {
  MemoryStore,
  MemoryStoreError,
  MEMORY_LOG_DIR,
  MEMORY_SOP_DIR,
  MEMORY_PREFERENCE_FILE,
  MEMORY_PITFALL_FILE,
  MEMORY_FACT_FILE,
} from './memoryStore.ts'
export type {
  MemoryStoreOptions,
  MemoryIndex,
  MemoryLogSummary,
  AppendLogOptions,
  AppendLogResult,
  PreferenceUpsertResult,
  PitfallUpsertResult,
  FactUpsertResult,
  SopWriteResult,
  SopUpdateResult,
  SopPatch,
} from './memoryStore.ts'
export {
  MemoryGraphWriter,
  MemoryGraphWriterError,
  syncPersonalMemoryGraph,
  PERSONAL_MEMORY_FOLDER,
  PERSONAL_MEMORY_GRAPH_ID,
} from './memoryGraphWriter.ts'
export type { MemoryGraphWriterOptions, PersonalMemoryGraphResult } from './memoryGraphWriter.ts'
export {
  MEMORY_TYPES,
  PRIVACY_VALUES,
  FACT_KINDS,
  SOP_STATUSES,
  MEMORY_ENTRY_MARKER,
  isMemoryType,
  isPrivacy,
  isFactKind,
  isSopStatus,
  isSafeMemorySlug,
  validateMemoryEntry,
  assertValidMemoryEntry,
  parseMemoryEntries,
  serializeMemoryEntry,
  newMemoryId,
} from './memoryTypes.ts'
export type {
  MemoryType,
  Privacy,
  FactKind,
  AppId,
  SopStatus,
  MemoryEntry,
  Preference,
  Pitfall,
  Episodic,
  Fact,
  Sop,
  AnyMemoryEntry,
  MemoryEntryInput,
  MemoryValidationIssue,
  MemoryValidationError,
} from './memoryTypes.ts'
export {
  GuardianSessionStore,
  resolveOrCreateGuardian,
  sendToGuardian,
  GUARDIAN_SESSION_TITLE,
  GUARDIAN_SKILL_NAME,
} from './guardianSession.ts'
export type {
  GuardianReason,
  GuardianMessage,
  GuardianSessionState,
  GuardianAgentRef,
  GuardianDelivery,
  CreateGuardianAgentInput,
  GuardianSessionHost,
  ResolvedGuardian,
  GuardianSendResult,
} from './guardianSession.ts'
export { createMemoryGuardianTools } from './memoryGuardianTool.ts'
export type { MemoryGuardianToolHost, MemoryGuardianSendArgs, MemoryGuardianSendValue } from './memoryGuardianTool.ts'
export { installMemoryTriggers, IDLE_DEBOUNCE_MS } from './memoryTriggers.ts'
export type { MemoryTriggerHost, MemoryTriggerSession, MemoryTriggerEvent, MemoryTriggerTimers } from './memoryTriggers.ts'
export { createMemoryRecordTools } from './memoryRecordTool.ts'
export type { MemoryRecordToolHost } from './memoryRecordTool.ts'
export { promoteSopToSkill, deleteSopAfterPromotion } from './memorySkillPromotion.ts'
export type { PromoteSopInput, DeleteSopInput, SopDraft } from './memorySkillPromotion.ts'
