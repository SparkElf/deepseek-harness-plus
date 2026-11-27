/** DataOps-managed JWT intake and credential-backed MCP composition. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentAuthState, noteAccepted, noteExpired, resetAuthState } from './auth-state.ts'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import * as McpClient from '@sparkelf/dsh-plugin-mcp-credentials'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import { ModelSync, type SyncStateStore } from './model-sync.ts'
import {
  SECTION_SYNC_DEFAULT,
  SettingsSync,
  type PublishedSection,
  type SectionSyncState,
  type SectionSyncStore,
} from './settings-sync.ts'
import { SkillPlaza, readLocalSkills } from './skill-plaza.ts'
import { ReviewApi } from './review-api.ts'
import { resolveWorkspaceBrandLogo, WorkspaceBrandingSource } from './branding.ts'
import { AiToolManager } from './tool-manager.ts'
import {
  AI_TOOL_ACCESS,
  declaredMcpToolName,
  hasPermission,
  isAdmin,
  isSuperAdmin,
  sessionHidesSkill,
  sessionHidesTool,
  skillPermissions,
  type AiToolName,
} from './tool-scope.ts'
import { mintScopedCredential, scopedCredentialRef } from './scoped-credential.ts'
import {
  OpenResourceHub,
  OPEN_RESOURCE_EVENTS_PATH,
  RESOURCE_TAB_CONFIG_PATH,
  resolveResourceTabConfig,
} from './resource-tab.ts'
import {
  BROWSER_BRIDGE_CONNECTOR_ID,
  BROWSER_BRIDGE_INSTALLER_PATH,
  CONNECTORS_PATH,
  DATAOPS_CONNECTOR_ID,
  buildBrowserBridgeConnectorView,
  buildConnectorView,
  hasCapability,
  readBrowserBridgeState,
  readConnectorState,
  writeBrowserBridgeState,
  writeConnectorState,
} from './connector-state.ts'
import {
  WorkspaceLimits,
  WorkspaceLimitsRejection,
  currentWorkspaceLimits,
  setWorkspaceLimits,
} from './workspace-limits.ts'
import { WorkspaceUpgrade, WorkspaceUpgradeError, recoverWorkspaceUpgradeAfterBoot } from './workspace-upgrade.ts'
import {
  BrowserBridgeSession,
  type BrowserBridgeMcpHandle,
} from './browser-bridge-session.ts'

/** Cordis plugin name for the DataOps-managed integration. */
export const name = 'dataops-managed'
/** Host services required by managed JWT and MCP ownership. */
export const inject = ['credentials', 'webServer', 'tools', 'settings', 'skills', 'approval', 'agents']

export const MANAGED_AUTH_PATH = '/integrations/dataops/managed-auth'
/** Where the connector mints one room Session's scoped credential. */
export const SCOPED_TOKEN_PATH = '/integrations/dataops/scoped-token'

/** This plugin's profile entry id, which owns its Config and sync state. */
export const MANAGED_PLUGIN_ID = 'dataops-managed'

/** Same-origin route the workspace settings pages use to read and change model sharing. */
export const MODEL_SYNC_PATH = '/integrations/dataops/model-sync'

/** Same-origin route the skill center uses to read and change plaza sharing. */
export const SKILL_PLAZA_PATH = '/integrations/dataops/skill-plaza'
/** Caller role and review capability. */
export const REVIEW_CONTEXT_PATH = '/integrations/dataops/review-context'
/** Notification inbox and read receipts. */
export const REVIEW_NOTIFICATIONS_PATH = '/integrations/dataops/review-notifications'
/** AI scan and the administrator's decision. */
export const REVIEW_ACTION_PATH = '/integrations/dataops/review'
/** Permission-centre reads and writes. */
export const RBAC_PATH = '/integrations/dataops/rbac'
/** The three plaza-review switches. */
export const REVIEW_SETTINGS_PATH = '/integrations/dataops/review-settings'
/** Department CRUD bridge (task-67). */
export const DEPARTMENTS_PATH = '/integrations/dataops/departments'

/** Same-origin route the workspace shell uses to read the portal's brand. */
export const BRANDING_PATH = '/integrations/dataops/branding'

/** Same-origin route the Settings panel uses to read and change this workspace's limits. */
export const WORKSPACE_LIMITS_PATH = '/integrations/dataops/workspace-limits'

/** Same-origin route the Settings panel uses to read and change the tool-call timeout. */
export const TOOL_TIMEOUT_PATH = '/integrations/dataops/tool-timeout'

/** Same-origin route reporting what the last DataOps answer said about the credential. */
export const AUTH_STATE_PATH = '/integrations/dataops/auth-state'

/** Same-origin route the DSH page uses to detect and start a workspace image upgrade. */
export const WORKSPACE_UPGRADE_PATH = '/integrations/dataops/workspace-upgrade'

/** The ends a tool-call timeout may take, in whole seconds. */
export const TOOL_TIMEOUT_MIN_SECONDS = 1
export const TOOL_TIMEOUT_MAX_SECONDS = 3600

/** The live sync instance, so the settings routes can act on it after activation. */
let modelSyncRef: ModelSync | undefined

/** The live plaza instance, so the skill center routes can act on it after activation. */
let skillPlazaRef: SkillPlaza | undefined

/** The live review API, once this plugin activated. */
let reviewApiRef: ReviewApi | undefined

/** The live skill plaza, once this plugin activated. */
export function currentSkillPlaza(): SkillPlaza | undefined {
  return skillPlazaRef
}

/** The live model-sync instance, once this plugin activated. */
export function currentModelSync(): ModelSync | undefined {
  return modelSyncRef
}

export { currentWorkspaceLimits }

/** The live settings-sync instance, once this plugin activated. */
let settingsSyncRef: SettingsSync | undefined

/** @returns The live instance, or undefined before this plugin activated. */
export function currentSettingsSync(): SettingsSync | undefined {
  return settingsSyncRef
}

/**
 * A volatile config reference.
 *
 * A field marked volatile is not stored with the plugin's own configuration: the settings
 * service keeps it in this workspace's document and hands the plugin a reference that it
 * updates in place, so a value written through the Settings panel is visible without a
 * restart. Reading the field directly therefore reads the reference, not the value.
 */
interface VolatileRef<T> {
  /** The current value behind the reference. */
  get(): T
}

/**
 * Read the value behind a possibly-volatile field.
 *
 * A volatile field always arrives as a reference, but the plain shape is accepted too so a
 * caller that validated the config without a settings service still reads its value.
 * @param field - The config field as the runtime supplied it.
 * @param fallback - Value to use when nothing is stored yet.
 * @returns The current value.
 */
function volatileValue<T>(field: T | VolatileRef<T> | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && 'get' in field && typeof field.get === 'function') {
    return (field as VolatileRef<T>).get() ?? fallback
  }
  return field as T
}

/** Configuration for the DataOps-managed MCP connection. */
export interface Config {
  /** DataOps browser/API origin reachable from the DSH Host. */
  baseUrl: string
  /**
   * Browser-facing DataOps origin used by the resource sidebar iframe.
   *
   * `baseUrl` may point at a container-internal API address. Leave this empty in a
   * same-origin portal deployment (the request Host is the correct origin) and set it
   * only for a split-origin deployment where the browser reaches DataOps elsewhere.
   */
  webBaseUrl?: string
  /** Local namespace for DataOps MCP tools. */
  serverName: string
  /** DSH credential reference that stores the current DataOps access JWT. */
  credentialRef: string
  /**
   * Per-tool-call timeout forwarded to the MCP client.
   *
   * Volatile, so the settings service stores the platform default in this workspace's document
   * and the panel can raise it without a profile edit. The read goes through `volatileValue`.
   */
  toolCallTimeoutMs: number | VolatileRef<number>
  /**
   * Model-sync state this workspace keeps.
   *
   * Volatile, so the settings service stores it in this workspace's own document. It belongs
   * to the workspace rather than to DataOps because it records whether the user here wrote
   * their own models, which is a fact about this workspace.
   *
   * Volatile, so the runtime supplies a reference and the read goes through `volatileValue`.
   */
  modelSync: ModelSyncState | VolatileRef<ModelSyncState>
  /**
   * Settings-distribution state this workspace keeps.
   *
   * Volatile, like the model-sync state beside it, and for the same reason: it records whether
   * the user here wrote their own values, which is a fact about this workspace.
   *
   * Volatile, like the field above, so the read goes through `volatileValue`.
   */
  settingsSync: SectionSyncState | VolatileRef<SectionSyncState>
  /**
   * Settings namespaces this deployment distributes to other workspaces.
   *
   * Empty by default: a deployment that publishes nothing offers no defaults, and a reader takes
   * its own values. Naming a namespace here is what puts it in every publication.
   */
  distributedSettingsNamespaces: string[]
}

/** What this workspace remembers about sharing model configuration. */
export interface ModelSyncState {
  /** The user here chose their own models, so adoption stops for them. */
  detached: boolean
  /** Model ids adoption last wrote, so a later edit can be told apart from one of them. */
  adoptedModelIds: string[]
  /** Model ids the administrator keeps private; every other model is offered by default. */
  privateModelIds: string[]
}

/**
 * Per-tool-call timeout a workspace starts with.
 *
 * Named rather than inlined so the schema default and the read fallback cannot drift: the field is
 * volatile, so a workspace that never changed it reads no value at all and both places have to
 * answer the same number.
 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 300_000

/** Default sync state before this workspace stored anything. */
const MODEL_SYNC_DEFAULT: ModelSyncState = {
  detached: false,
  adoptedModelIds: [],
  privateModelIds: [],
}

/** Schemastery parser for managed DataOps configuration. */
export const Config: z<Config> = z.object({
  baseUrl: z.string().default('http://host.docker.internal:3101'),
  webBaseUrl: z.string().default(''),
  serverName: z.string().default('dataops'),
  credentialRef: z.string().role('credential-ref').default('DATAOPS_ACCESS_TOKEN'),
  /**
   * Volatile so the settings service persists it in this workspace's document: the timeout an
   * operator needs depends on the query behind a tool, which is deployment knowledge the profile
   * that mounts this plugin does not have.
   *
   * `z.any()` like the sync state above, and for the same reason: a volatile field is delivered
   * to `apply` as a reference rather than a value, so a narrowed schema would describe a shape
   * the runtime does not pass. The range is enforced where the value is read.
   */
  toolCallTimeoutMs: z.any().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  /**
   * Volatile so the settings service persists it in this workspace's document. The shape is
   * left open because the sync state is this plugin's own record, not user configuration.
   */
  modelSync: z.any().default(MODEL_SYNC_DEFAULT),
  /** Volatile for the same reason as `modelSync`: it is this plugin's own record. */
  settingsSync: z.any().default(SECTION_SYNC_DEFAULT),
  /**
   * Namespaces offered in a publication. Validated as strings so a malformed profile entry fails
   * at load rather than producing a publication no reader can apply.
   */
  distributedSettingsNamespaces: z.array(z.string()).default([]).description(
    'Settings namespaces offered to other workspaces when this one publishes.',
  ),
})

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization?.trim() ?? ''
  if (!authorization.startsWith('Bearer ')) return null
  const token = authorization.slice(7).trim()
  return token === '' ? null : token
}

/**
 * Adopt the JWT the browser gateway attached to one request.
 *
 * Every browser request reaches this workspace through the DataOps gateway, which resolves the
 * caller's session and forwards a fresh `authorization: Bearer <jwt>` — so the current credential
 * arrives continuously, without any push, handshake or refresh protocol. The routes below are
 * the only place this plugin can see that header, and reading it here is what keeps the stored
 * credential from going stale: the value in it was captured once, while the caller's session is
 * renewed by DataOps for as long as they stay signed in.
 *
 * A request without the header is normal rather than an error (same-origin fetches from inside
 * the workspace do carry it, but a probe or a health check may not), so this only ever improves
 * the stored value and never rejects the request.
 *
 * @param request - the incoming request, whose headers the gateway filled in.
 * @returns once the credential has been updated, or immediately when there is nothing to adopt.
 */
export function adoptRequestJwt(
  ctx: Context,
  accessRef: ReturnType<typeof credentialRef>,
  request: IncomingMessage,
): Promise<void> {
  const token = bearerToken(request)
  // Re-storing the same value would rewrite the credential document and wake its watchers on
  // every request; comparing first keeps adoption to the moments the token actually changed.
  if (token === null) return Promise.resolve()
  return (async () => {
    const current = await ctx.credentials.resolve(accessRef)
    if (current?.value === token) { resetAuthState(); return }
    await ctx.credentials.set(accessRef, token)
    // A new portal session replaces the credential above. The old observation belonged to the
    // previous credential and must not keep the sign-in prompt on screen.
    resetAuthState()
  })().catch((error: unknown) => {
    // A credential write that fails must not fail the request that carried it: the caller asked
    // for the page, not for this housekeeping, and the next request will try again.
    ctx.logger.warn('dataops-managed: request JWT could not be adopted')
    ctx.logger.warn(error)
  })
}

/** The skill this plugin contributes: how to answer a DataOps data question. */
const QUERY_SKILL_NAME = 'dataops-query'
/** Location of the skill document inside the published package. */
const QUERY_SKILL_FILE = new URL('../skills/dataops-query/SKILL.md', import.meta.url)
/** Package root, which the skill loads its relative resources against. */
const QUERY_SKILL_ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * Describe the query skill to the catalog without reading it.
 *
 * The description repeats what the skill file declares, because a catalog listing must
 * answer whether the skill applies before its content is loaded.
 */
const QUERY_SKILL = {
  name: QUERY_SKILL_NAME,
  description:
    '用户问数、取数、查数据、要报表时使用。包含选表策略（优先总表；有地域区分时先大后小）、取数前与用户确认资源清单、以及超时时主动分批次。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: QUERY_SKILL_NAME,
  source: 'bundled',
  resourceBase: { kind: 'directory', path: QUERY_SKILL_ROOT },
  rank: BUNDLED_SKILL_RANK,
  locator: QUERY_SKILL_FILE,
} as const

/** Serve the query skill to the catalog. */
const querySkillProvider = {
  name: QUERY_SKILL_NAME,
  list: () => Promise.resolve([QUERY_SKILL]),
  async get() {
    return { ...QUERY_SKILL, content: await readFile(QUERY_SKILL_FILE, 'utf8') }
  },
}

/** The skill this plugin contributes: turn one spreadsheet into a queryable resource. */
const COLLECT_SKILL_NAME = 'dataops-collect'
/** Location of the collection skill document inside the published package. */
const COLLECT_SKILL_FILE = new URL('../skills/dataops-collect/SKILL.md', import.meta.url)
/** Skill directory, which the skill loads its relative `references/*.md` against. */
const COLLECT_SKILL_ROOT = fileURLToPath(new URL('../skills/dataops-collect/', import.meta.url))

/**
 * Describe the collection skill to the catalog without reading it.
 *
 * The description carries the natural-language triggers so a request like "把这份表格建成
 * 能问数的资源" selects this skill before the model sees the body.
 */
const COLLECT_SKILL = {
  name: COLLECT_SKILL_NAME,
  description:
    '把表格 / Excel / CSV 建成可问数的数据资源，或把新表格追加到已有资源时使用。包含新建与追加的分岔、计划确认、建表写入、权限入口和结果汇报；确认计划前绝不建表。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: COLLECT_SKILL_NAME,
  source: 'bundled',
  resourceBase: { kind: 'directory', path: COLLECT_SKILL_ROOT },
  rank: BUNDLED_SKILL_RANK,
  locator: COLLECT_SKILL_FILE,
} as const

/** Connector authoring skill: only superadmins hold `data:connector:authoring`. */
const CONNECTOR_SKILL_NAME = 'api-connector-authoring'
const CONNECTOR_SKILL_FILE = new URL('../skills/api-connector-authoring/SKILL.md', import.meta.url)
const CONNECTOR_SKILL_ROOT = fileURLToPath(new URL('../', import.meta.url))

/** 该技能的门禁：只有持有 `data:connector:authoring` 的超管能看到（只对超管授权）。 */
const CONNECTOR_SKILL_PERMISSION = 'data:connector:authoring'

const CONNECTOR_SKILL = {
  name: CONNECTOR_SKILL_NAME,
  metadata: { permissions: [CONNECTOR_SKILL_PERMISSION] },
  description:
    '从接口文档（OpenAPI / Swagger / 接口说明）创建 API Connector 并导入为接口资源时使用。包含文档解析、导入粒度判断、资源命名与目录治理、GenUI 预览和用户确认后才导入的流程。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: CONNECTOR_SKILL_NAME,
  source: 'bundled',
  resourceBase: { kind: 'directory', path: CONNECTOR_SKILL_ROOT },
  rank: BUNDLED_SKILL_RANK,
  locator: CONNECTOR_SKILL_FILE,
} as const

/**
 * 当前 DataOps 身份是否允许看到连接器作者技能。
 *
 * 核心层对 provider 的列表是 fail-open 的：不认识的技能一律展示。所以门禁必须在这里做——
 * 没有权限时返回空列表，`get` 也拒绝，避免只靠 SKILL.md 里的 frontmatter 声明。
 */
let connectorSkillAllowed: () => boolean = () => false

/** Admin data-governance skill: imports resources, writes metadata, and reads full platform metadata. */
const GOVERNANCE_SKILL_NAME = 'dataops-governance'
const GOVERNANCE_SKILL_FILE = new URL('../skills/dataops-governance/SKILL.md', import.meta.url)
const GOVERNANCE_SKILL_ROOT = fileURLToPath(new URL('../skills/dataops-governance/', import.meta.url))
const GOVERNANCE_SKILL = {
  name: GOVERNANCE_SKILL_NAME,
  description: '管理员/超管导入资源、维护资源/列/指标/血缘与可见性、查询全量平台元数据时使用。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: GOVERNANCE_SKILL_NAME,
  source: 'bundled',
  resourceBase: { kind: 'directory', path: GOVERNANCE_SKILL_ROOT },
  rank: BUNDLED_SKILL_RANK,
  locator: GOVERNANCE_SKILL_FILE,
} as const
const governanceSkillProvider = {
  name: GOVERNANCE_SKILL_NAME,
  list: () => Promise.resolve([GOVERNANCE_SKILL]),
  async get() {
    return { ...GOVERNANCE_SKILL, content: await readFile(GOVERNANCE_SKILL_FILE, 'utf8') }
  },
}
/** Synonym-governance skill: discovers and maintains synonym groups for resource search. */
const SYNONYM_SKILL_NAME = 'dataops-synonym-governance'
const SYNONYM_SKILL_FILE = new URL('../skills/dataops-synonym-governance/SKILL.md', import.meta.url)
const SYNONYM_SKILL_ROOT = fileURLToPath(new URL('../skills/dataops-synonym-governance/', import.meta.url))
const SYNONYM_SKILL = {
  name: SYNONYM_SKILL_NAME,
  description: '超管维护资源检索的同义词组：从数据目录自底向上抽词、判定等价、确认后写入。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: SYNONYM_SKILL_NAME,
  source: 'bundled',
  resourceBase: { kind: 'directory', path: SYNONYM_SKILL_ROOT },
  rank: BUNDLED_SKILL_RANK,
  locator: SYNONYM_SKILL_FILE,
} as const
const synonymSkillProvider = {
  name: SYNONYM_SKILL_NAME,
  list: () => Promise.resolve([SYNONYM_SKILL]),
  async get() {
    return { ...SYNONYM_SKILL, content: await readFile(SYNONYM_SKILL_FILE, 'utf8') }
  },
}
/** Metadata optimizer skill: inventories metadata and proposes governance improvements. */
const METADATA_OPTIMIZER_SKILL_NAME = 'dataops-metadata-optimizer'
const METADATA_OPTIMIZER_SKILL_FILE = new URL('../skills/dataops-metadata-optimizer/SKILL.md', import.meta.url)
const METADATA_OPTIMIZER_SKILL_ROOT = fileURLToPath(new URL('../skills/dataops-metadata-optimizer/', import.meta.url))
const METADATA_OPTIMIZER_SKILL = {
  name: METADATA_OPTIMIZER_SKILL_NAME,
  description: '盘点资源/列/指标/血缘，识别命名、口径、冗余与缺失问题，生成治理提案并预览影响。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: METADATA_OPTIMIZER_SKILL_NAME,
  source: 'bundled',
  resourceBase: { kind: 'directory', path: METADATA_OPTIMIZER_SKILL_ROOT },
  rank: BUNDLED_SKILL_RANK,
  locator: METADATA_OPTIMIZER_SKILL_FILE,
} as const
const metadataOptimizerSkillProvider = {
  name: METADATA_OPTIMIZER_SKILL_NAME,
  list: () => Promise.resolve([METADATA_OPTIMIZER_SKILL]),
  async get() {
    return { ...METADATA_OPTIMIZER_SKILL, content: await readFile(METADATA_OPTIMIZER_SKILL_FILE, 'utf8') }
  },
}

const connectorSkillProvider = {
  name: CONNECTOR_SKILL_NAME,
  list: () => Promise.resolve(connectorSkillAllowed() ? [CONNECTOR_SKILL] : []),
  async get() {
    if (!connectorSkillAllowed()) throw new Error('connector skill is not available for this account')
    return { ...CONNECTOR_SKILL, content: await readFile(CONNECTOR_SKILL_FILE, 'utf8') }
  },
}

const PREFECT_SCRIPT_SKILL_NAME = 'prefect-script-authoring'
const PREFECT_SCRIPT_SKILL_FILE = new URL('../skills/prefect-script-authoring/SKILL.md', import.meta.url)
const PREFECT_SCRIPT_SKILL_ROOT = fileURLToPath(new URL('../', import.meta.url))

/** 该技能只对超级管理员展示：它驱动的四个 workflow MCP 工具同样只对超管注册。 */
const PREFECT_SCRIPT_SKILL = {
  name: PREFECT_SCRIPT_SKILL_NAME,
  metadata: { permissions: ['automation:workflow:create'] },
  description:
    '用纯 Prefect Python（@flow/@task）编写 DataOps 工作流定义、发布部署并运行；通过 workflow_query / workflow_definition / workflow_deployment / workflow_run_control 操作时使用。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PREFECT_SCRIPT_SKILL_NAME,
  source: 'bundled',
  resourceBase: { kind: 'directory', path: PREFECT_SCRIPT_SKILL_ROOT },
  rank: BUNDLED_SKILL_RANK,
  locator: PREFECT_SCRIPT_SKILL_FILE,
} as const

let prefectScriptSkillAllowed: () => boolean = () => false

const prefectScriptSkillProvider = {
  name: PREFECT_SCRIPT_SKILL_NAME,
  list: () => Promise.resolve(prefectScriptSkillAllowed() ? [PREFECT_SCRIPT_SKILL] : []),
  async get() {
    if (!prefectScriptSkillAllowed()) throw new Error('prefect script skill is not available for this account')
    return { ...PREFECT_SCRIPT_SKILL, content: await readFile(PREFECT_SCRIPT_SKILL_FILE, 'utf8') }
  },
}

/**
 * The browser entry skill: one catalog entry that routes headless scraping, the
 * local companion, and legacy Chrome-install troubleshooting through its
 * `references/` documents. The old `browser-headless` and
 * `browser-bridge-companion` entries were merged into it so the skill center
 * exposes one browser skill instead of three overlapping ones.
 */
const BROWSER_SKILL_NAME = 'browser'
const BROWSER_SKILL_FILE = new URL('../skills/browser/SKILL.md', import.meta.url)
const BROWSER_SKILL_ROOT = fileURLToPath(new URL('../skills/browser/', import.meta.url))

const BROWSER_SKILL = {
  name: BROWSER_SKILL_NAME,
  description:
    '浏览器自动化总入口。抓取网页/大屏/表格、登录后取数、或用用户本地 Chrome/Edge 操作内网系统时使用。默认工作区 Playwright headless；只有用户明确要求本地浏览器、已登录 Chrome 或 Companion 才走 Browser Bridge。包含 headless、Companion 桥接与旧 Chrome 安装排查三套按需参考。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: BROWSER_SKILL_NAME,
  source: 'bundled',
  resourceBase: { kind: 'directory', path: BROWSER_SKILL_ROOT },
  rank: BUNDLED_SKILL_RANK,
  locator: BROWSER_SKILL_FILE,
} as const

const browserSkillProvider = {
  name: BROWSER_SKILL_NAME,
  list: () => Promise.resolve([BROWSER_SKILL]),
  async get() {
    return { ...BROWSER_SKILL, content: await readFile(BROWSER_SKILL_FILE, 'utf8') }
  },
}

const PROVISIONING_SKILL_NAME = 'skill-provisioning'
const PROVISIONING_SKILL_FILE = new URL('../skills/skill-provisioning/SKILL.md', import.meta.url)
const PROVISIONING_SKILL_ROOT = fileURLToPath(new URL('../', import.meta.url))

/** 该技能只对持有 `skill:manage` 的身份展示：它驱动的分配工具使用同一能力。 */
const PROVISIONING_SKILL = {
  name: PROVISIONING_SKILL_NAME,
  metadata: { permissions: ['skill:manage'] },
  description:
    '给指定用户或部门批量分配技能时使用。先预览部门+子部门、受影响用户数与覆盖/冲突，用户明确确认后才绑定或应用；部门绑定只改配置，现有用户需 apply 才生效。',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVISIONING_SKILL_NAME,
  source: 'bundled',
  resourceBase: { kind: 'directory', path: PROVISIONING_SKILL_ROOT },
  rank: BUNDLED_SKILL_RANK,
  locator: PROVISIONING_SKILL_FILE,
} as const

let provisioningSkillAllowed: () => boolean = () => false

const provisioningSkillProvider = {
  name: PROVISIONING_SKILL_NAME,
  list: () => Promise.resolve(provisioningSkillAllowed() ? [PROVISIONING_SKILL] : []),
  async get() {
    if (!provisioningSkillAllowed()) throw new Error('skill provisioning is not available for this account')
    return { ...PROVISIONING_SKILL, content: await readFile(PROVISIONING_SKILL_FILE, 'utf8') }
  },
}

/**
 * 万相 AI 中台管理技能：管理员/超管的中台管理操作手册。
 *
 * 技能本身只是路由与安全规则，具体字段走 `references/` 和 `dataops_api_docs`；它只对持有
 * `system:admin:manage` 的管理员/超管展示，部门管理员与普通用户看不到。
 */
const WANXIANG_ADMIN_SKILL_NAME = 'wanxiang-ai-admin'
const WANXIANG_ADMIN_SKILL_FILE = new URL('../skills/wanxiang-ai-admin/SKILL.md', import.meta.url)
const WANXIANG_ADMIN_SKILL_ROOT = fileURLToPath(new URL('../skills/wanxiang-ai-admin/', import.meta.url))
/** 该技能的门禁：管理员/超管默认持有，部门管理员没有。 */
const WANXIANG_ADMIN_SKILL_PERMISSION = 'system:admin:manage'

const WANXIANG_ADMIN_SKILL = {
  name: WANXIANG_ADMIN_SKILL_NAME,
  metadata: { permissions: [WANXIANG_ADMIN_SKILL_PERMISSION] },
  description: '万相 AI 中台管理：用户/角色/资源授权/技能与工作区管理',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: WANXIANG_ADMIN_SKILL_NAME,
  source: 'bundled',
  resourceBase: { kind: 'directory', path: WANXIANG_ADMIN_SKILL_ROOT },
  rank: BUNDLED_SKILL_RANK,
  locator: WANXIANG_ADMIN_SKILL_FILE,
} as const

let wanxiangAdminSkillAllowed: () => boolean = () => false

const wanxiangAdminSkillProvider = {
  name: WANXIANG_ADMIN_SKILL_NAME,
  list: () => Promise.resolve(wanxiangAdminSkillAllowed() ? [WANXIANG_ADMIN_SKILL] : []),
  async get() {
    if (!wanxiangAdminSkillAllowed()) throw new Error('wanxiang AI admin skill is not available for this account')
    return { ...WANXIANG_ADMIN_SKILL, content: await readFile(WANXIANG_ADMIN_SKILL_FILE, 'utf8') }
  },
}

/** Serve the collection skill to the catalog. */
const collectSkillProvider = {
  name: COLLECT_SKILL_NAME,
  list: () => Promise.resolve([COLLECT_SKILL]),
  async get() {
    return { ...COLLECT_SKILL, content: await readFile(COLLECT_SKILL_FILE, 'utf8') }
  },
}
/**
 * Accept the current DataOps JWT and expose DataOps MCP tools through its credential.
 * @param ctx - DSH Host context with credentials, Web routes, and tools.
 * @param config - Managed DataOps origin and MCP settings.
 * @returns Startup readiness after an existing JWT is connected when present.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const baseUrl = new URL(config.baseUrl).origin
  /**
   * 门户 origin：本机 Companion 的配对 API 需要用它作为 serverUrl，才能经门户
   * 的同源代理（`/api` 与 `/browser-bridge-ws`）回到 backend。优先取配置的第一个
   * `webBaseUrl`，否则退回 backend origin。
   */
  const portalOrigin = (): string => {
    const configured = (config.webBaseUrl ?? '')
      .split(',')
      .map(value => value.trim())
      .find(value => value !== '' && URL.canParse(value))
    return configured === undefined ? baseUrl : new URL(configured).origin
  }
  const accessRef = credentialRef(config.credentialRef)
  let mcpFiber: Fiber | undefined

  // The query skill ships with the plugin: a data question is the plugin's own subject, so its
  // guidance travels with the DataOps integration rather than the deployment profile.
  ctx.skills.registerProvider(() => querySkillProvider)
  // The collection skill is the product's main entry: a normal conversation request is what
  // triggers it, so the guidance must ship with the plugin rather than be pasted into a prompt.
  ctx.skills.registerProvider(() => collectSkillProvider)
  ctx.skills.registerProvider(() => governanceSkillProvider)
  ctx.skills.registerProvider(() => synonymSkillProvider)
  ctx.skills.registerProvider(() => metadataOptimizerSkillProvider)
  ctx.skills.registerProvider(() => connectorSkillProvider)
  ctx.skills.registerProvider(() => prefectScriptSkillProvider)
  ctx.skills.registerProvider(() => provisioningSkillProvider)
  ctx.skills.registerProvider(() => wanxiangAdminSkillProvider)
  // One browser entry: headless, companion, and legacy install details live as
  // references under the skill directory, so the skill center lists one skill and
  // the model loads only the playbook it needs.
  ctx.skills.registerProvider(() => browserSkillProvider)

  const ensureMcp = async (): Promise<void> => {
    if (mcpFiber !== undefined && mcpFiber.uid !== null) return
    const fiber = ctx.plugin(McpClient, {
      transport: 'streamable-http',
      serverName: config.serverName,
      url: `${baseUrl}/api/ai/data-query/mcp`,
      headers: {},
      bearerTokenRef: config.credentialRef,
      toolCallTimeoutMs: volatileValue(config.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS),
    })
    mcpFiber = fiber
    try {
      await fiber.await()
      ctx.logger.warn('dataops-managed: browser bridge MCP connected')
    } catch (error) {
      if (mcpFiber === fiber) mcpFiber = undefined
      await fiber.dispose()
      throw error
    }
  }

  /**
   * The browser bridge, reached through the DataOps gateway.
   *
   * The gateway is the only entry. With the current DataOps JWT the plugin asks for a session
   * and receives an `mcpUrl` whose ticket is the connection capability; the profile and the
   * environment carry no bridge address, so a workspace cannot point itself at another user's
   * companion. `connectMcp` creates exactly one MCP client per session; the session module
   * owns token refresh and closure.
   */
  const browserBridge = new BrowserBridgeSession({
    baseUrl,
    resolveToken: async () => (await ctx.credentials.resolve(accessRef))?.value,
    isEnabled: async () => (await readBrowserBridgeState()).enabled,
    connectMcp: async (mcpUrl, bridgeToken): Promise<BrowserBridgeMcpHandle> => {
      const fiber = ctx.plugin(McpClient, {
        transport: 'streamable-http',
        serverName: 'browser-bridge',
        url: mcpUrl,
        headers: { authorization: `Bearer ${bridgeToken}` },
        toolCallTimeoutMs: volatileValue(config.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS),
      })
      try {
        await fiber.await()
      } catch (error) {
        if (fiber.uid !== null) await fiber.dispose()
        throw error
      }
      return {
        alive: () => fiber.uid !== null,
        dispose: async () => {
          if (fiber.uid !== null) await fiber.dispose()
        },
      }
    },
    // The logger receives already-sanitized text: the MCP URL carries a session ticket and
    // never reaches a log line.
    logger: { warn: message => ctx.logger.warn(message) },
  })

  ctx.effect(() => async () => {
    const fiber = mcpFiber
    mcpFiber = undefined
    if (fiber !== undefined && fiber.uid !== null) await fiber.dispose()
    // Closes the bridge session best-effort and clears every timer the session owns.
    await browserBridge.dispose()
  }, 'dataops-managed: MCP lifecycle')

  /**
   * Connect the MCP client when a JWT is already stored.
   *
   * A connect can fail for reasons this plugin does not own — the stored JWT may have expired,
   * or DataOps may be unreachable at this moment — and those are states the settings routes
   * report and recover from. Awaiting it here would abort activation, leaving the plugin with
   * no routes at all: the panel then cannot read the very state that explains the failure, and
   * the browser reports a connection error instead. The routes below are registered first, and
   * a failed connect is reported rather than thrown.
   */
  const connectExisting = async (): Promise<void> => {
    if (await ctx.credentials.resolve(accessRef) === undefined) {
      // No credential means no scope to disclose from. Drop a set that belonged to a previous
      // session before waiting for the next adoption.
      aiTools.clear()
      return
    }
    // Tool disclosure follows the credential, but it must never sit on the startup path: an
    // unreachable DataOps is a state the settings routes report, not a reason to delay them.
    void aiTools.refresh()
    try {
      await ensureMcp()
    } catch (error) {
      ctx.logger.warn('dataops-managed: connecting the DataOps MCP server failed; the settings routes stay up so a new JWT can be connected')
      ctx.logger.warn(error)
    }
    // The bridge is optional and off by default. `start` reads the persisted connector switch
    // and returns without a request when it is off; when it is on, the first attempt must not
    // delay activation, so an offline companion is reported rather than thrown.
    void browserBridge.start()
  }

  /**
   * The sync state lives in this plugin's own Config, so the settings service persists it in
   * the workspace document and it survives a restart.
   */
  const syncStore: SyncStateStore = {
    read: () => {
      const state = volatileValue(config.modelSync, MODEL_SYNC_DEFAULT)
      return {
        detached: state?.detached === true,
        adoptedModelIds: Array.isArray(state?.adoptedModelIds) ? state.adoptedModelIds : [],
        privateModelIds: Array.isArray(state?.privateModelIds) ? state.privateModelIds : [],
      }
    },
    write: async (next) => {
      await ctx.settings.update(MANAGED_PLUGIN_ID, { modelSync: next })
    },
  }
  /**
   * The settings-distribution state lives in this plugin's own Config, so the settings service
   * persists it in the workspace document and it survives a restart.
   */
  const sectionStore: SectionSyncStore = {
    read: () => {
      const state = volatileValue(config.settingsSync, SECTION_SYNC_DEFAULT)
      return {
        sections: typeof state?.sections === 'object' && state.sections !== null ? state.sections : {},
      }
    },
    write: async (next) => {
      await ctx.settings.update(MANAGED_PLUGIN_ID, { settingsSync: next })
    },
  }
  const settingsSync = new SettingsSync(ctx, sectionStore)
  settingsSyncRef = settingsSync

  /**
   * The namespaces this deployment distributes.
   *
   * Listed here rather than inside the sync because what a deployment offers is its own choice:
   * the sync knows how to carry a section, and this decides which ones travel.
   */
  const distributedNamespaces = (): string[] => {
    const configured = config.distributedSettingsNamespaces
    return Array.isArray(configured) ? configured.filter((ns): ns is string => typeof ns === 'string' && ns !== '') : []
  }

  /**
   * Read the sections this workspace would publish.
   *
   * A namespace no plugin owns is skipped: publishing a section this deployment cannot apply
   * would offer readers values nothing on their side reads.
   */
  const collectSections = async (): Promise<PublishedSection[]> => {
    const collected: PublishedSection[] = []
    for (const ns of distributedNamespaces()) {
      const descriptor = ctx.settings.describe().find((entry) => entry.ns === ns)
      if (descriptor === undefined) continue
      const value = descriptor.value
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      collected.push({ ns, value: value as Record<string, unknown> })
    }
    return collected
  }

  const modelSync = new ModelSync(
    ctx,
    { baseUrl, credentialRef: config.credentialRef, collectSections },
    syncStore,
  )
  modelSyncRef = modelSync
  const skillPlaza = new SkillPlaza(ctx, { baseUrl, credentialRef: config.credentialRef })
  skillPlazaRef = skillPlaza
  const reviewApi = new ReviewApi(ctx, { baseUrl, credentialRef: config.credentialRef })
  reviewApiRef = reviewApi
  /**
   * The portal brand, read without a credential.
   *
   * Both settings are public, so the shell can render the right name and logo before the
   * workspace has a DataOps session. The source owns the short cache; the route is a plain
   * same-origin read so a browser reload never reaches DataOps directly.
   */
  const branding = new WorkspaceBrandingSource(baseUrl)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BRANDING_PATH,
    handler: async (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
        response.writeHead(405, { allow: 'GET', 'content-length': '0' })
        response.end()
        return
      }
      const current = await branding.read()
      writeJson(response, 200, {
        name: current.name,
        logo: resolveWorkspaceBrandLogo(current.logo, config.webBaseUrl),
      })
    },
  }), 'dataops-managed: portal branding route')
  // One workspace-local fan-out for "open the DataOps resource tab". The model tool publishes
  // here; the client half is the only code that calls betterSidebar.openTab.
  const resourceTabHub = new OpenResourceHub(ctx.logger)
  ctx.effect(() => () => resourceTabHub.dispose(), 'dataops-managed: resource tab SSE clients')
  /**
   * Mint the scoped credential one room Session uses.
   *
   * The connector calls this after it created (or adopted) the room Session with an actor, passing
   * the DataOps user the room acts for. The token is stored under the Session-specific ref the MCP
   * bridge derives from the same Session id; a failed mint answers 502 and leaves the room on the
   * workspace credential, which is what it would have used anyway.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SCOPED_TOKEN_PATH,
    handler: async (request, response) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
        response.writeHead(405).end()
        return
      }
      const body = await readJson(request).catch(() => null)
      const sessionId = typeof body?.['sessionId'] === 'string' ? body['sessionId'] : ''
      const actorUserId = typeof body?.['actorUserId'] === 'string' ? body['actorUserId'] : ''
      if (sessionId === '' || actorUserId === '') {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: 'sessionId and actorUserId are required' }))
        return
      }
      const ref = await mintScopedCredential({
        request: (path, init) => reviewApi.request(path, init),
        set: async (name, value) => { await ctx.credentials.set(credentialRef(name), value) },
        warn: (message, error) => { ctx.logger.warn(`dataops-managed: ${message}`, error) },
      }, config.credentialRef ?? 'DATAOPS_ACCESS_TOKEN', sessionId, actorUserId)
      response.writeHead(ref === undefined ? 502 : 200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(ref === undefined ? { error: 'scoped token was not minted' } : { ref }))
    },
  }), 'dataops-managed: scoped credential route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_RESOURCE_EVENTS_PATH,
    handler: (request, response) => resourceTabHub.subscribe(request, response),
  }), 'dataops-managed: resource tab SSE route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RESOURCE_TAB_CONFIG_PATH,
    handler: async (request, response) => {
      const payload = resolveResourceTabConfig(request, config.webBaseUrl)
      // The tab hands this token to the embed page through the URL fragment; a fragment never
      // reaches the server or access logs, and the page strips it after storing it. This is the
      // only way a cross-origin portal iframe can start with the workspace's identity.
      let token: string | undefined
      try { token = (await ctx.credentials.resolve(accessRef))?.value } catch { token = undefined }
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(JSON.stringify(token === undefined ? payload : { ...payload, token }))
    },
  }), 'dataops-managed: resource tab config route')
  /**
   * Same-origin resource reads for the tab's native fallback.
   *
   * A DSH page served from its own origin (for example the workspace port) cannot open the
   * portal's `/embed/resources` iframe with a session: that document is cross-origin and its
   * sessionStorage token is unreachable. The tab then renders the list in React and reads the
   * same DataOps resources through this route, where the Host still owns the JWT.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/integrations/dataops/resources',
    handler: async (request, response) => {
      const method = (request.method ?? 'GET').toUpperCase()
      const url = new URL(request.url ?? '/', 'http://dsh.internal')
      const rest = url.pathname.slice('/integrations/dataops/resources'.length).replace(/^\/+/u, '').replace(/\/+$/u, '')
      // Reads cover the list, catalog-tree and preference pages; writes are limited to the
      // two per-resource preference flags the cards expose.
      const preferenceWrite = /^\d+\/(?:favorite|pin)$/u.test(rest)
      if (method !== 'GET' && !(preferenceWrite && (method === 'PUT' || method === 'DELETE'))) {
        response.writeHead(405, { allow: 'GET, PUT, DELETE', 'content-length': '0' })
        response.end()
        return
      }
      const target = rest === ''
        ? '/api/resources' + (url.search || '')
        : '/api/resources/' + encodeURIComponent(rest) + (url.search || '')
      const result = await reviewApi.request(target, { method })
      writeJson(response, result.status, result.body)
    },
  }), 'dataops-managed: resource list bridge')
  /**
   * The managed tool list follows the workspace's DataOps scope.
   *
   * `AiToolManager` registers only the skill/review tools the current principal can use and
   * disposes them when the role changes. The credential event below is the existing auth-sync
   * path: JWT adoption and the managed-auth route both go through `credentials.set`, which
   * publishes this event after the write commits. The manager also observes the review-context
   * route's answer, because a role edit does not change the JWT but does change the scope.
   */
  const aiTools = new AiToolManager(ctx, reviewApi, resourceTabHub)
  connectorSkillAllowed = () => {
    const scope = aiTools.currentScope()
    if (scope === undefined) return false
    return (scope.permissions ?? scope.permissionKeys ?? []).includes(CONNECTOR_SKILL_PERMISSION)
  }
  prefectScriptSkillAllowed = () => {
    const scope = aiTools.currentScope()
    return scope !== undefined && isSuperAdmin(scope)
  }
  provisioningSkillAllowed = () => {
    const scope = aiTools.currentScope()
    return scope !== undefined && hasPermission(scope, 'skill:manage')
  }
  /**
   * 万相 AI 中台管理技能只对管理员/超管展示。
   *
   * 角色判定在前面：`hasPermission` 在缺少权限列表的旧上下文里会按角色兜底，部门管理员会
   * 因此拿到一个本该只属于管理员的键。超管是 DataOps 的权限旁路角色，上下文只带了部分
   * 权限键时不应被藏掉；管理员仍要求实际持有 `system:admin:manage`。
   */
  wanxiangAdminSkillAllowed = () => {
    const scope = aiTools.currentScope()
    if (scope === undefined) return false
    if (!isAdmin(scope)) return false
    return isSuperAdmin(scope) || hasPermission(scope, WANXIANG_ADMIN_SKILL_PERMISSION)
  }
  ctx.effect(() => () => aiTools.dispose(), 'dataops-managed: skill and review tool disclosure')

  /**
   * Per-session disclosure.
   *
   * The registration set above is global to the workspace; a group-chat room acts for one member,
   * so its Session carries that member's scope as an opaque actor and the base asks these rules
   * while it assembles the step. Both registries are optional: an older base without them keeps
   * today's workspace-wide behaviour, and `addVisibilityFilter` is only called when it exists.
   */
  ctx.effect(() => {
    const tools = ctx.tools as typeof ctx.tools & {
      addVisibilityFilter?: (filter: {
        appliesTo: (tool: { name: string }) => boolean
        hidden: (session: { actor?: unknown } | undefined, tool: { name: string }) => boolean
      }) => () => void
    }
    const skills = ctx.skills as typeof ctx.skills & {
      addVisibilityFilter?: (filter: {
        appliesTo: (candidate: { metadata?: Readonly<Record<string, unknown>> }) => boolean
        hidden: (session: { actor?: unknown } | undefined, candidate: { metadata?: Readonly<Record<string, unknown>> }) => boolean
      }) => () => void
    }
    const disposers: (() => void)[] = []
    /**
     * Resolve one model-facing name to the managed name this table declares.
     *
     * `dataops_*` tools are registered here and are already the declared name. The backend's MCP
     * workflow tools arrive as `mcp__<serverName>__<rawName>`; mapping them back lets the same
     * declaration hide them from a Session acting for a non-super-administrator, which is what the
     * bridge cannot do before it executes the call.
     */
    const managedName = (name: string): AiToolName | undefined => name.startsWith('dataops_')
      ? (Object.hasOwn(AI_TOOL_ACCESS, name) ? name as AiToolName : undefined)
      : declaredMcpToolName(name, config.serverName)
    if (typeof tools.addVisibilityFilter === 'function') {
      disposers.push(tools.addVisibilityFilter({
        // Only the tools this plugin registers and the MCP tools its access table declares;
        // everything else in the process is not ours to judge.
        appliesTo: tool => managedName(tool.name) !== undefined,
        hidden: (session, tool) => {
          const name = managedName(tool.name)
          // The base consults `hidden` only after `appliesTo` accepted the tool; a missing name
          // means a changed contract, and hiding is the safe answer.
          return name === undefined || sessionHidesTool(name, session?.actor, aiTools.currentScope())
        },
      }))
    }
    if (typeof skills.addVisibilityFilter === 'function') {
      disposers.push(skills.addVisibilityFilter({
        // A skill that declares permissions opts into this rule; one without a declaration keeps
        // whatever the connector gate already decided.
        appliesTo: candidate => skillPermissions(candidate.metadata).length > 0,
        hidden: (session, candidate) => sessionHidesSkill(skillPermissions(candidate.metadata), session?.actor, aiTools.currentScope()),
      }))
    }
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  }, 'dataops-managed: per-session tool and skill disclosure')
  ctx.effect(() => ctx.on('credentials/reference-updated', (ref) => {
    if (String(ref) !== config.credentialRef) return
    // A new token can belong to a different principal, so supersede any read that may still
    // be answering for the previous one.
    void aiTools.refresh(true)
    // The bridge control plane speaks with this same JWT. A login after an expiry resumes the
    // session's clocks without disturbing the MCP connection its ticket already authorizes.
    void browserBridge.onCredentialRefresh()
  }), 'dataops-managed: tool disclosure follows the DataOps credential')
  const workspaceLimits = new WorkspaceLimits(ctx, { baseUrl, credentialRef: config.credentialRef })
  setWorkspaceLimits(workspaceLimits)
  const workspaceUpgrade = new WorkspaceUpgrade(ctx, { baseUrl, credentialRef: config.credentialRef })

  /**
   * Adopt the publisher's models once the workspace has a session.
   *
   * Adoption waits for the JWT because the publication is read with it; a workspace that has
   * not been authorized yet simply tries again when its session arrives.
   */
  const adoptNow = async (): Promise<void> => {
    try {
      await modelSync.adopt()
    } catch (error) {
      ctx.logger.warn('dataops-managed: model sync could not adopt the published models')
      ctx.logger.warn(error)
    }
    try {
      // The sections come from the same publication the models did, so a workspace that just
      // adopted models applies the settings that publication carried in the same pass.
      const published = await modelSync.readPublishedSections()
      if (published.length > 0) await settingsSync.adopt(published)
    } catch (error) {
      ctx.logger.warn('dataops-managed: distributed settings could not be adopted')
      ctx.logger.warn(error)
    }
  }
  // Adoption talks to the backend and may be slow (model publication, distributed
  // settings). It must never delay route registration: the workspace readiness probe
  // asks for `/integrations/dataops/model-sync`, and a stalled adoption used to leave
  // every managed route at 404 while the process was still booting. The function
  // catches and reports its own failures, so starting it without awaiting is safe.
  if (await ctx.credentials.resolve(accessRef) !== undefined) void adoptNow()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MANAGED_AUTH_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'content-length': '0' })
        response.end()
        return
      }
      // The browser cannot read its own httpOnly cookie, so it cannot put the JWT in this
      // request's body. That is fine: the gateway already attached the same token to the header,
      // and reading it there is what makes a bare POST (no body, no client-side token) enough to
      // re-authenticate the workspace after the caller signs in again.
      await adoptRequestJwt(ctx, accessRef, request)
      const token = bearerToken(request)
      if (token === null) {
        response.writeHead(401, { 'content-length': '0' })
        response.end()
        return
      }
      // A room Session keeps its member's own JWT in a Session-scoped slot so the room's MCP calls
      // act as that member. The caller names the Session; without one the workspace slot is written
      // exactly as before, which is every ordinary conversation.
      const body = await readJson(request).catch(() => null)
      const sessionId = typeof body?.['sessionId'] === 'string' ? body['sessionId'] : ''
      if (sessionId === '') {
        await ctx.credentials.set(accessRef, token)
      } else {
        const scopedRef = credentialRef(scopedCredentialRef(config.credentialRef, sessionId))
        const current = await ctx.credentials.resolve(scopedRef).catch(() => undefined)
        if (current?.value !== token) {
          try {
            await ctx.credentials.set(scopedRef, token)
          } catch (error: unknown) {
            // The room keeps working on the workspace credential; the next message retries.
            ctx.logger.warn(`dataops-managed: session credential for ${sessionId} was not stored`, error)
          }
        }
      }
      resetAuthState()
      // A re-login can change the principal behind the workspace; re-read the scope before the
      // next model turn. It stays off the response path for the same reason as activation;
      // `force` makes it win over a read that captured the old token.
      void aiTools.refresh(true)
      // The same new JWT is what the bridge control plane needs after an expiry. The
      // credential event above also observes it; the explicit call keeps the intake route
      // working the same way even if the value was re-adopted without a change notification.
      void browserBridge.onCredentialRefresh()
      await ensureMcp()
      await adoptNow()
      response.writeHead(204, { 'cache-control': 'no-store' })
      response.end()
    },
  }), 'dataops-managed: JWT intake route')

  /**
   * The settings surface the workspace's own pages read and write.
   *
   * Same-origin only: the browser reaches these through the gateway that already authenticated
   * it, and the DataOps JWT they act with is the one this plugin holds, never a value the page
   * supplies.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MODEL_SYNC_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const sync = currentModelSync()
      if (sync === undefined) {
        writeJson(response, 503, { error: 'model sync is not active' })
        return
      }
      try {
        if (request.method === 'GET') {
          writeJson(response, 200, {
            ...await sync.status(),
            // The sections travel beside the models because the panel shows both, and a separate
            // request would let the two rows disagree about which publication they describe.
            sections: settingsSyncRef === undefined ? [] : settingsSyncRef.status(distributedNamespaces()),
          })
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'GET, POST', 'content-length': '0' })
          response.end()
          return
        }
        const body = await readJson(request)
        const action = typeof body?.action === 'string' ? body.action : ''
        if (action === 'publish') {
          const sharingEnabled = body?.sharingEnabled === true
          await sync.publish(sharingEnabled)
          writeJson(response, 200, await sync.status())
          return
        }
        if (action === 'publish-defaults') {
          // One action that copies whatever this workspace holds: the models plus every namespace
          // the deployment distributes. Sharing stays on so a reader picks it up.
          await sync.publish(true)
          writeJson(response, 200, {
            ...await sync.status(),
            sections: settingsSyncRef === undefined ? [] : settingsSyncRef.status(distributedNamespaces()),
          })
          return
        }
        if (action === 'detach') {
          await sync.detach()
          writeJson(response, 200, await sync.status())
          return
        }
        if (action === 'detach-section') {
          const ns = typeof body?.ns === 'string' ? body.ns.trim() : ''
          if (ns === '') {
            writeJson(response, 400, { error: 'detach-section needs a namespace' })
            return
          }
          await settingsSyncRef?.detach(ns)
          writeJson(response, 200, {
            ...await sync.status(),
            sections: settingsSyncRef === undefined ? [] : settingsSyncRef.status(distributedNamespaces()),
          })
          return
        }
        if (action === 'resume') {
          await sync.resumeFollowing()
          await sync.adopt()
          writeJson(response, 200, await sync.status())
          return
        }
        if (action === 'private-models') {
          const ids = Array.isArray(body?.privateModelIds)
            ? body.privateModelIds.filter((id): id is string => typeof id === 'string')
            : []
          await sync.setPrivateModels(ids, body?.sharingEnabled === true)
          writeJson(response, 200, await sync.status())
          return
        }
        writeJson(response, 400, { error: 'unknown action' })
      } catch (error) {
        ctx.logger.warn('dataops-managed: model sync request failed')
        ctx.logger.warn(error)
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: model sync routes')

  /**
   * The skill plaza surface the workspace's skill center reads and writes.
   *
   * Same-origin only, like the model routes: the browser reaches these through the gateway
   * that already authenticated it, and the DataOps JWT they act with is the one this plugin
   * holds rather than a value the page supplies.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SKILL_PLAZA_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const plaza = currentSkillPlaza()
      if (plaza === undefined) {
        writeJson(response, 503, { error: 'skill plaza is not active' })
        return
      }
      try {
        if (request.method === 'GET') {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const mine = url.searchParams.get('mine') === '1'
          const page = await plaza.listPage({
            tag: url.searchParams.get('tag') ?? undefined,
            query: url.searchParams.get('q') ?? undefined,
            status: url.searchParams.get('status') ?? undefined,
            scope: mine ? 'mine' : url.searchParams.get('scope') ?? undefined,
            departmentCode: url.searchParams.get('departmentCode') ?? undefined,
          })
          writeJson(response, 200, {
            skills: mine ? page.skills.filter(skill => skill.sharedByMe) : page.skills,
            tags: mine ? [] : await plaza.tags(),
            ...(page.counts === undefined ? {} : { counts: page.counts }),
          })
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'GET, POST', 'content-length': '0' })
          response.end()
          return
        }
        const body = await readJson(request)
        const action = typeof body?.action === 'string' ? body.action : ''
        if (action === 'local-skills') {
          writeJson(response, 200, { skills: await readLocalSkills(ctx) })
          return
        }
        if (action === 'share' || action === 'submit') {
          const name = typeof body?.name === 'string' ? body.name : ''
          const instruction = typeof body?.instruction === 'string' ? body.instruction : ''
          const description = typeof body?.description === 'string' ? body.description : undefined
          const tags = Array.isArray(body?.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : []
          if (name.trim() === '' || instruction.trim() === '') {
            writeJson(response, 400, { error: 'name and instruction are required' })
            return
          }
          const shared = await plaza.share({ name, description, instruction, tags })
          writeJson(response, 200, { ok: true, skill: shared })
          return
        }
        if (action === 'review') {
          const api = reviewApiRef
          if (api === undefined) { writeJson(response, 503, { error: 'review api is not active' }); return }
          const id = typeof body?.id === 'number' ? body.id : undefined
          const decision = body?.decision === 'reject' ? 'reject' : body?.decision === 'approve' ? 'approve' : null
          if (id === undefined || decision === null) { writeJson(response, 400, { error: 'id and decision are required' }); return }
          const result = await api.request('/api/ai/review/decide', {
            method: 'POST',
            body: JSON.stringify({
              skills: [id],
              workflows: [],
              decision,
              note: typeof body?.note === 'string' ? body.note : '',
              authorization: { confirmed: true, reason: 'skill-plaza-review' },
            }),
          })
          writeJson(response, result.status, result.body)
          return
        }
        if (action === 'unshare') {
          if (typeof body?.id === 'number') await plaza.unshare(body.id)
          writeJson(response, 200, { success: true })
          return
        }
        if (action === 'install') {
          const result = typeof body?.id === 'number' ? await plaza.install(body.id) : null
          writeJson(response, 200, result ?? { installed: false, skillKey: null, keptLocal: false })
          return
        }
        writeJson(response, 400, { error: 'unknown action' })
      } catch (error) {
        ctx.logger.warn('dataops-managed: skill plaza request failed')
        ctx.logger.warn(error)
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: skill plaza routes')

  /**
   * Review context, notifications, AI scan/decide, the permission centre and review settings.
   *
   * These are thin same-origin bridges: DataOps owns identity, authorization, the state machine
   * and the audit trail; this route only attaches the workspace JWT and forwards answers so the
   * browser can show a precise waiting/refused state instead of flattening both to "empty".
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REVIEW_CONTEXT_PATH,
    handler: async (request, response) => {
      if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET', 'content-length': '0' }); response.end(); return }
      const api = reviewApiRef
      if (api === undefined) { writeJson(response, 503, { error: 'review api is not active' }); return }
      try {
        const result = await api.request('/api/ai/review/context')
        // The permission centre refreshes this route after a role edit. Reusing that answer
        // keeps the model's tool list in step with the role without a second scope read.
        aiTools.observeContext(result)
        writeJson(response, result.status, result.body)
      } catch (error) {
        ctx.logger.warn('dataops-managed: review context failed')
        writeJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: review context route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REVIEW_NOTIFICATIONS_PATH,
    handler: async (request, response) => {
      const api = reviewApiRef
      if (api === undefined) { writeJson(response, 503, { error: 'review api is not active' }); return }
      try {
        if (request.method === 'GET') {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const params = new URLSearchParams()
          if (url.searchParams.get('unreadOnly') === 'true') params.set('unreadOnly', 'true')
          if (url.searchParams.get('limit') !== null) params.set('limit', url.searchParams.get('limit') as string)
          const result = await api.request('/api/ai/review-notifications' + (params.size === 0 ? '' : '?' + params.toString()))
          writeJson(response, result.status, result.body)
          return
        }
        if (request.method !== 'POST') { response.writeHead(405, { allow: 'GET, POST', 'content-length': '0' }); response.end(); return }
        const body = await readJson(request)
        const result = await api.request('/api/ai/review-notifications/read', { method: 'POST', body: JSON.stringify(body ?? {}) })
        writeJson(response, result.status, result.body)
      } catch (error) {
        ctx.logger.warn('dataops-managed: review notifications failed')
        writeJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: review notifications route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REVIEW_ACTION_PATH,
    handler: async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST', 'content-length': '0' }); response.end(); return }
      const api = reviewApiRef
      if (api === undefined) { writeJson(response, 503, { error: 'review api is not active' }); return }
      try {
        const body = await readJson(request)
        const action = typeof body?.action === 'string' ? body.action : ''
        const skills = Array.isArray(body?.skills) ? body.skills : []
        const workflows = Array.isArray(body?.workflows) ? body.workflows : []
        if (action === 'scan') {
          const result = await api.request('/api/ai/review/scan', { method: 'POST', body: JSON.stringify({ skills, workflows }) })
          writeJson(response, result.status, result.body)
          return
        }
        if (action === 'decide') {
          const result = await api.request('/api/ai/review/decide', {
            method: 'POST',
            body: JSON.stringify({
              skills,
              workflows,
              decision: body?.decision,
              note: body?.note,
              authorization: body?.authorization,
            }),
          })
          writeJson(response, result.status, result.body)
          return
        }
        writeJson(response, 400, { error: 'unknown review action' })
      } catch (error) {
        ctx.logger.warn('dataops-managed: review action failed')
        writeJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: review action route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RBAC_PATH,
    handler: async (request, response) => {
      const api = reviewApiRef
      if (api === undefined) { writeJson(response, 503, { error: 'review api is not active' }); return }
      try {
        if (request.method === 'GET') {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const section = url.searchParams.get('section') ?? 'matrix'
          if (section === 'visible-roles') {
            const result = await api.request('/api/system/permission-center/roles/visible')
            writeJson(response, result.status, result.body)
            return
          }
          const suffix = section === 'members'
            ? '?q=' + encodeURIComponent(url.searchParams.get('q') ?? '') + '&departmentCode=' + encodeURIComponent(url.searchParams.get('departmentCode') ?? '')
            : section === 'resources'
              ? '?kind=' + encodeURIComponent(url.searchParams.get('kind') ?? '')
              : ''
          const target = section === 'members'
            ? '/api/system/permission-center/members' + suffix
            : section === 'departments'
              ? '/api/system/permission-center/departments'
              : section === 'resources'
                ? '/api/system/permission-center/resources' + suffix
                : '/api/system/permission-center/matrix' + (url.searchParams.get('scope') === 'dsh' ? '?scope=dsh' : '')
          const result = await api.request(target)
          writeJson(response, result.status, result.body)
          return
        }
        if (request.method !== 'PUT') { response.writeHead(405, { allow: 'GET, PUT', 'content-length': '0' }); response.end(); return }
        const body = await readJson(request)
        const section = typeof body?.section === 'string' ? body.section : ''
        const value = typeof body?.value === 'object' && body.value !== null ? body.value as Record<string, unknown> : {}
        if (section === 'roles') {
          const result = await api.request('/api/system/permission-center/matrix', { method: 'PUT', body: JSON.stringify(value) })
          writeJson(response, result.status, result.body)
          return
        }
        if (section === 'members' && typeof value.userId === 'string') {
          const result = await api.request('/api/system/permission-center/members/' + encodeURIComponent(value.userId) + '/roles', { method: 'PUT', body: JSON.stringify({ roleCodes: value.roleCodes }) })
          writeJson(response, result.status, result.body)
          return
        }
        if (section === 'member-grant' && typeof value.userId === 'string' && typeof value.roleCode === 'string') {
          const result = await api.request('/api/system/permission-center/members/' + encodeURIComponent(value.userId) + '/role-grants', {
            method: 'PUT',
            body: JSON.stringify({
              roleCode: value.roleCode,
              departmentCode: typeof value.departmentCode === 'string' ? value.departmentCode : null,
            }),
          })
          writeJson(response, result.status, result.body)
          return
        }
        if (section === 'member-revoke' && typeof value.userId === 'string' && typeof value.roleCode === 'string') {
          const result = await api.request('/api/system/permission-center/members/' + encodeURIComponent(value.userId) + '/role-grants/' + encodeURIComponent(value.roleCode), { method: 'DELETE' })
          writeJson(response, result.status, result.body)
          return
        }
        if (section === 'departments' && typeof value.code === 'string') {
          const result = await api.request('/api/system/permission-center/departments/' + encodeURIComponent(value.code) + '/admin', { method: 'PUT', body: JSON.stringify({ userIds: value.userIds }) })
          writeJson(response, result.status, result.body)
          return
        }
        if (section === 'resources' && typeof value.kind === 'string' && value.id !== undefined) {
          const result = await api.request('/api/system/permission-center/resources/' + encodeURIComponent(value.kind) + '/' + encodeURIComponent(String(value.id)) + '/scope', {
            method: 'PUT',
            body: JSON.stringify({ departmentCode: value.departmentCode, visibility: value.visibility, ownerId: value.ownerId }),
          })
          writeJson(response, result.status, result.body)
          return
        }
        writeJson(response, 400, { error: 'unknown rbac section' })
      } catch (error) {
        ctx.logger.warn('dataops-managed: permission centre failed')
        writeJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: permission centre route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DEPARTMENTS_PATH,
    handler: async (request, response) => {
      const api = reviewApiRef
      if (api === undefined) { writeJson(response, 503, { error: 'review api is not active' }); return }
      try {
        const body = await readJson(request)
        if (request.method === 'POST') {
          const result = await api.request('/api/system/departments', { method: 'POST', body: JSON.stringify(body ?? {}) })
          writeJson(response, result.status, result.body)
          return
        }
        if (request.method !== 'PATCH' && request.method !== 'DELETE') {
          response.writeHead(405, { allow: 'POST, PATCH, DELETE', 'content-length': '0' })
          response.end()
          return
        }
        const code = typeof body?.code === 'string' ? body.code : ''
        if (code === '') { writeJson(response, 400, { error: 'department code is required' }); return }
        // The backend uses updatedAt as its optimistic-lock token. Read the current row here so
        // the browser does not have to carry a field the permission-centre list does not return.
        const current = await api.request('/api/system/departments/' + encodeURIComponent(code))
        const record = typeof current.body === 'object' && current.body !== null ? current.body as Record<string, unknown> : {}
        const department = typeof record.department === 'object' && record.department !== null ? record.department as Record<string, unknown> : {}
        const updatedAt = typeof body?.updatedAt === 'string' ? body.updatedAt : department.updatedAt
        if (typeof updatedAt !== 'string') { writeJson(response, current.status === 200 ? 409 : current.status, { error: 'department not found' }); return }
        if (request.method === 'PATCH') {
          const result = await api.request('/api/system/departments/' + encodeURIComponent(code), {
            method: 'PATCH',
            body: JSON.stringify({
              updatedAt,
              name: body?.name,
              parentCode: body?.parentCode,
              description: body?.description,
              owner: body?.owner,
              enabled: body?.enabled,
            }),
          })
          writeJson(response, result.status, result.body)
          return
        }
        const result = await api.request('/api/system/departments/' + encodeURIComponent(code), {
          method: 'DELETE',
          body: JSON.stringify({ updatedAt }),
        })
        writeJson(response, result.status, result.body)
      } catch (error) {
        ctx.logger.warn('dataops-managed: department bridge failed')
        writeJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: department CRUD bridge')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REVIEW_SETTINGS_PATH,
    handler: async (request, response) => {
      const api = reviewApiRef
      if (api === undefined) { writeJson(response, 503, { error: 'review api is not active' }); return }
      try {
        if (request.method === 'GET') {
          const result = await api.request('/api/integrations/dataops/review-settings')
          writeJson(response, result.status, result.body)
          return
        }
        if (request.method !== 'PUT' && request.method !== 'POST') { response.writeHead(405, { allow: 'GET, POST, PUT', 'content-length': '0' }); response.end(); return }
        const body = await readJson(request)
        const result = await api.request('/api/integrations/dataops/review-settings', { method: 'POST', body: JSON.stringify(body ?? {}) })
        writeJson(response, result.status, result.body)
      } catch (error) {
        ctx.logger.warn('dataops-managed: review settings failed')
        writeJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: review settings route')

  /**
   * The workspace limits an administrator sets in DataOps.
   *
   * Read through the plugin because it holds the DataOps JWT; the page cannot reach those settings
   * itself. Same-origin only, like its neighbours.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: WORKSPACE_LIMITS_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const limits = currentWorkspaceLimits()
      if (limits === undefined) {
        writeJson(response, 503, { error: 'workspace limits are not active' })
        return
      }
      try {
        if (request.method === 'GET') {
          const status = await limits.status()
          if (status === undefined) {
            writeJson(response, 503, { error: 'workspace limits are not active' })
            return
          }
          writeJson(response, 200, status)
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'GET, POST', 'content-length': '0' })
          response.end()
          return
        }
        const body = await readJson(request)
        const fileReadMaxBytes = body?.fileReadMaxBytes
        const uploadMaxBytes = body?.uploadMaxBytes
        if (typeof fileReadMaxBytes !== 'number' || typeof uploadMaxBytes !== 'number') {
          writeJson(response, 400, { error: 'both byte ceilings are required' })
          return
        }
        const status = await limits.save({ fileReadMaxBytes, uploadMaxBytes })
        if (status === undefined) {
          writeJson(response, 503, { error: 'workspace limits are not active' })
          return
        }
        writeJson(response, 200, status)
      } catch (error) {
        // A rejection DataOps already explained keeps its status and message: the panel shows the
        // reason and the user can correct the value. Anything else is a fault here, not input.
        if (error instanceof WorkspaceLimitsRejection) {
          writeJson(response, error.status, { error: error.message })
          return
        }
        ctx.logger.warn('dataops-managed: workspace limits request failed')
        ctx.logger.warn(error)
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: workspace limits route')

  /**
   * The tool-call timeout, stored in this plugin's own Config.
   *
   * The settings service keeps the value in this workspace's document and updates the volatile
   * reference in place, so a change takes effect on the next connection without a restart. The
   * profile therefore does not have to anticipate how long a deployment's queries take.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TOOL_TIMEOUT_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      const read = () => volatileValue(config.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS)
      if (request.method === 'GET') {
        writeJson(response, 200, { toolCallTimeoutMs: read() })
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST', 'content-length': '0' })
        response.end()
        return
      }
      try {
        const body = await readJson(request)
        const milliseconds = body?.toolCallTimeoutMs
        if (typeof milliseconds !== 'number' || !Number.isSafeInteger(milliseconds)) {
          writeJson(response, 400, { error: 'toolCallTimeoutMs must be a whole number of milliseconds' })
          return
        }
        const seconds = milliseconds / 1000
        if (seconds < TOOL_TIMEOUT_MIN_SECONDS || seconds > TOOL_TIMEOUT_MAX_SECONDS) {
          writeJson(response, 400, {
            error: 'the timeout must be between ' + String(TOOL_TIMEOUT_MIN_SECONDS)
              + ' and ' + String(TOOL_TIMEOUT_MAX_SECONDS) + ' seconds',
          })
          return
        }
        await ctx.settings.update(MANAGED_PLUGIN_ID, { toolCallTimeoutMs: milliseconds })
        writeJson(response, 200, { toolCallTimeoutMs: milliseconds })
      } catch (error) {
        ctx.logger.warn('dataops-managed: tool timeout request failed')
        ctx.logger.warn(error)
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: tool timeout route')

  /**
   * Workspace image upgrade: DataOps owns the image comparison and restart; this
   * plugin adds the DSH-side running-session snapshot and post-restart recovery.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: WORKSPACE_UPGRADE_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      try {
        if (request.method === 'GET') {
          const preview = await workspaceUpgrade.preview()
          writeJson(response, 200, {
            imageStatus: preview.imageStatus,
            configuredImage: preview.configuredImage,
            activeSessions: preview.activeSessions,
          })
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'GET, POST', 'content-length': '0' })
          response.end()
          return
        }
        const state = await workspaceUpgrade.upgrade()
        writeJson(response, 202, {
          accepted: true,
          upgradeId: state.upgradeId,
          sessions: state.sessions.length,
        })
      } catch (error) {
        const status = error instanceof WorkspaceUpgradeError ? error.status : 502
        writeJson(response, status, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: workspace upgrade route')

  // Recovery is deliberately fire-and-forget: route registration and JWT intake must
  // not wait for DSH session persistence, and the retry loop reads the persistent file.
  void recoverWorkspaceUpgradeAfterBoot(workspaceUpgrade)

  /**
   * What the last DataOps answer said about this workspace's credential.
   *
   * The settings surfaces need this because a 401 is handled deep inside a call that degrades to
   * "no data", so the panel renders as if the workspace simply has nothing to show. Reading this
   * route is how the interface learns the reason is an ended session rather than an empty one.
   * The recorded state is an observation, never an authority: DataOps still decides.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: AUTH_STATE_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      // GET 读观察结果；POST 供**同一个进程里其它插件**上报它自己看到的 401。
      // 驾驶舱（artifact-app）用自己的 client 调 DataOps，401 原先只在它内部变成
      // 「渲染失败」文案，不触发登录弹窗；这条上报路径把两边的观察合并成同一个信号。
      if (request.method === 'POST') {
        const body = await readJson(request).catch(() => null) as { state?: unknown } | null
        if (body?.state === 'expired') noteExpired()
        else if (body?.state === 'valid') noteAccepted()
        else {
          response.writeHead(400, { 'content-length': '0' })
          response.end()
          return
        }
        response.writeHead(204, { 'cache-control': 'no-store' })
        response.end()
        return
      }
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET, POST', 'content-length': '0' })
        response.end()
        return
      }
      await adoptRequestJwt(ctx, accessRef, request)
      writeJson(response, 200, { state: currentAuthState() })
    },
  }), 'dataops-managed: auth state route')

  /**
   * 本机一键配对的配对码来源。
   *
   * DSH 页面里的客户端脚本先探测 `127.0.0.1:8932/status`；未配对时调用本路由拿
   * 一次性配对码，再直接 POST 给本机 Companion。配对码不经过用户、不写日志。
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/integrations/dataops/browser-bridge/auto-pair',
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
        response.writeHead(405, { allow: 'POST', 'content-length': '0' })
        response.end()
        return
      }
      try {
        const bridgeState = await readBrowserBridgeState()
        if (!bridgeState.enabled) {
          writeJson(response, 409, { error: '浏览器桥接连接器未启用' })
          return
        }
        const token = await ctx.credentials.resolve(accessRef)
        if (token === undefined || token.value === '') {
          writeJson(response, 401, { error: '工作区尚未登录 DataOps' })
          return
        }
        const upstream = await fetch(new URL('/api/ai/browser-bridge/pair/start', baseUrl), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token.value}`,
            'content-type': 'application/json',
          },
          body: '{}',
          signal: AbortSignal.timeout(15_000),
        })
        if (!upstream.ok) {
          writeJson(response, upstream.status === 401 ? 401 : 502, {
            error: upstream.status === 401 ? 'DataOps 登录已过期' : '配对码生成失败',
          })
          return
        }
        const payload = await upstream.json() as { code?: unknown; expiresAt?: unknown }
        if (typeof payload.code !== 'string' || typeof payload.expiresAt !== 'string') {
          writeJson(response, 502, { error: '配对码响应格式不正确' })
          return
        }
        writeJson(response, 200, {
          code: payload.code,
          expiresAt: payload.expiresAt,
          serverUrl: portalOrigin(),
        })
      } catch (error) {
        ctx.logger.warn('dataops-managed: browser bridge auto-pair failed')
        ctx.logger.warn(error)
        writeJson(response, 502, { error: '自动配对失败' })
      }
    },
  }), 'dataops-managed: browser bridge auto pair')

  /**
   * The skill center's connector tab. The route is a same-origin presentation bridge: reads
   * return only capabilities the current scope can use, and writes persist the connector's own
   * enable state. It never substitutes for a DataOps authorization decision.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONNECTORS_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      try {
        if (request.method === 'GET') {
          if (aiTools.currentScope() === undefined) await aiTools.refresh()
          const state = await readConnectorState()
          const bridgeState = await readBrowserBridgeState()
          writeJson(response, 200, {
            connectors: [
              buildConnectorView(aiTools.currentScope(), state),
              buildBrowserBridgeConnectorView(bridgeState, browserBridge.status()),
            ],
          })
          return
        }
        if (request.method === 'POST') {
          const body = await readJson(request)
          if (body === null) {
            writeJson(response, 400, { error: 'connector state requires a JSON body' })
            return
          }
          if (body.connectorId === BROWSER_BRIDGE_CONNECTOR_ID) {
            if (typeof body.enabled !== 'boolean') {
              writeJson(response, 400, { error: 'connector state requires enabled:boolean' })
              return
            }
            const bridgeState = await readBrowserBridgeState()
            bridgeState.enabled = body.enabled
            await writeBrowserBridgeState(bridgeState)
            // The switch is the one runtime control: enable asks the gateway for a session now
            // and disable closes the session this workspace holds, both without a DSH restart.
            // The attempt runs off the response path so an offline companion cannot stall the
            // connector panel, which is exactly where the reason is shown.
            void browserBridge.setEnabled(body.enabled)
            const state = await readConnectorState()
            writeJson(response, 200, {
              connectors: [
                buildConnectorView(aiTools.currentScope(), state),
                buildBrowserBridgeConnectorView(bridgeState, browserBridge.status()),
              ],
            })
            return
          }
          if (body.connectorId !== DATAOPS_CONNECTOR_ID) {
            writeJson(response, 404, { error: 'unknown connector' })
            return
          }
          const state = await readConnectorState()
          const capabilityId = typeof body.capabilityId === 'string' ? body.capabilityId : undefined
          if (capabilityId !== undefined) {
            if (!hasCapability(capabilityId)) {
              writeJson(response, 400, { error: 'unknown capability' })
              return
            }
            if (!buildConnectorView(aiTools.currentScope(), state).capabilities.some(row => row.id === capabilityId)) {
              writeJson(response, 403, { error: 'capability is not available to this account' })
              return
            }
            if (typeof body.enabled !== 'boolean') {
              writeJson(response, 400, { error: 'capability state requires enabled:boolean' })
              return
            }
            state.capabilities[capabilityId] = body.enabled
          } else {
            if (typeof body.enabled !== 'boolean') {
              writeJson(response, 400, { error: 'connector state requires enabled:boolean' })
              return
            }
            state.enabled = body.enabled
          }
          await writeConnectorState(state)
          // Capability switches own whole tool groups: reconcile now so a disabled capability
          // takes its tools out of the model's surface without waiting for the next role sync.
          await aiTools.refreshCapabilities()
          const bridgeState = await readBrowserBridgeState()
          writeJson(response, 200, {
            connectors: [
              buildConnectorView(aiTools.currentScope(), state),
              buildBrowserBridgeConnectorView(bridgeState, browserBridge.status()),
            ],
          })
          return
        }
        response.writeHead(405, { allow: 'GET, POST', 'content-length': '0' })
        response.end()
      } catch (error) {
        ctx.logger.warn('dataops-managed: connector catalogue route failed')
        ctx.logger.warn(error)
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dataops-managed: skill-center connector catalogue')

  /**
   * Installer download for the browser-bridge connector.
   *
   * The file is local state, not a model tool and not an arbitrary proxy: an
   * operator places a signed installer at DSH_BROWSER_BRIDGE_INSTALLER_PATH
   * (default under DSH_HOME) and this route streams that exact file.
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BROWSER_BRIDGE_INSTALLER_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET', 'content-length': '0' })
        response.end()
        return
      }
      // A release artifact URL keeps the installer out of both the image and the
      // workspace volume. Offline deployments can fall back to a file placed in
      // the runtime-connectors mount instead.
      const artifactUrl = process.env.DSH_BROWSER_BRIDGE_INSTALLER_URL?.trim() ?? ''
      if (artifactUrl !== '') {
        response.writeHead(302, {
          location: artifactUrl,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        response.end()
        return
      }
      const configured = process.env.DSH_BROWSER_BRIDGE_INSTALLER_PATH?.trim() ?? ''
      const installerPath = configured !== ''
        ? configured
        : join(
            process.env.DSH_HOME?.trim() || '/workspace/.dataops/dsh',
            'runtime-connectors',
            'browser-bridge',
            'DSH-Browser-Bridge-Setup-Windows-x64-v0.1.0.exe',
          )
      try {
        const info = await stat(installerPath)
        if (!info.isFile()) throw new Error('installer is not a file')
        const bytes = await readFile(installerPath)
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="' + basename(installerPath).replace(/["\\]/gu, '') + '"',
          'content-length': String(bytes.byteLength),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        response.end(bytes)
      } catch {
        writeJson(response, 404, { error: 'bridge installer is not available in this workspace' })
      }
    },
  }), 'dataops-managed: browser bridge installer')

  await connectExisting()
}

/** Read and parse a JSON request body, tolerating an absent one. */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** Answer one settings request as JSON. */
function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(payload)
}
