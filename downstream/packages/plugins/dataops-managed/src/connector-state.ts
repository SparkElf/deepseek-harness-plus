/**
 * The DataOps connector's workspace-visible state and skill-center catalogue.
 *
 * The skill center is skill-first, with connectors as its fourth tab. DataOps contributes one
 * connector whose capability rows are derived from the same scope that drives tool disclosure;
 * a capability the account cannot use is omitted rather than rendered as a disabled placeholder.
 *
 * This module owns only state and presentation. It never authorizes a tool call or a DataOps
 * request: the backend remains the final boundary.
 *
 * @module connector-state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BrowserBridgeStatus } from './browser-bridge-session.ts'
import {
  isAdmin,
  type DataOpsScope,
} from './tool-scope.ts'

/** Same-origin route the skill center's connector tab reads and writes. */
export const CONNECTORS_PATH = '/api/dsh-skill-center/connectors'

/** Connector id shown in the skill center. */
export const DATAOPS_CONNECTOR_ID = 'dataops-managed'

/** Connector id for the local browser bridge companion. */
export const BROWSER_BRIDGE_CONNECTOR_ID = 'browser-bridge'

/** Same-origin route that serves the bridge installer file. */
export const BROWSER_BRIDGE_INSTALLER_PATH = '/api/dsh-skill-center/browser-bridge/installer'

/** Persisted enable state for the browser bridge connector. */
export interface BrowserBridgeConnectorState {
  enabled: boolean
}

/** State file for the browser bridge connector, beside the DataOps connector state. */
export const BROWSER_BRIDGE_STATE_PATH = join(
  process.env.DSH_HOME?.trim() || '/workspace/.dataops/dsh',
  'dataops-managed',
  'browser-bridge-state.json',
)

/** Persisted enable state; a missing file means the connector is off. */
export interface DataOpsConnectorState {
  enabled: boolean
  capabilities: Record<string, boolean>
}

/** One capability row the skill center renders. */
export interface ConnectorCapabilityView {
  id: string
  name: string
  description: string
  enabled: boolean
  permitted: boolean
  unavailableReason?: string
}

/** One connector row the skill center renders. */
export interface ConnectorInstallerView {
  /** File name the browser saves the installer as. */
  fileName: string
  /** Same-origin URL that streams the installer. */
  downloadUrl: string
  /** Product-language explanation shown in the confirmation dialog. */
  description: string
}

export interface ConnectorView {
  id: string
  name: string
  vendor: string
  description: string
  enabled: boolean
  connected: boolean
  capabilities: ConnectorCapabilityView[]
  /** Present when this connector has a downloadable local companion. */
  installer?: ConnectorInstallerView
}

/** Resolve the persisted state file without depending on a global DSH path. */
export const CONNECTOR_STATE_PATH = join(
  process.env.DSH_HOME?.trim() || '/workspace/.dataops/dsh',
  'dataops-managed',
  'connector-state.json',
)

/**
 * Capability definitions before permission filtering.
 *
 * The set follows `dataops/docs/dataops-connector-development-spec.md` §2.3's credential list.
 * `approval.push` was renamed to `resource.manage` when the capability grew from approval push
 * into resource approval and authorization. Skill plaza and review queue are governed by
 * `skill:*` permissions and stay out of the connector's capability switches.
 */
const CAPABILITIES = [
  {
    id: 'data.query',
    name: '数据查询',
    description: '通过 DataOps 数据查询能力回答业务问题',
    defaultEnabled: true,
    visible: () => true,
    allowed: () => true,
  },
  {
    id: 'resource.manage',
    name: '资源管理',
    description: '在对话中批量审批资源申请，给用户或角色授予资源访问权限',
    defaultEnabled: true,
    visible: (scope: DataOpsScope) => isAdmin(scope),
    allowed: (scope: DataOpsScope) => isAdmin(scope),
  },
  {
    id: 'admin.manage',
    name: '万相中台管理',
    description: '登录万相中台后台执行管理动作',
    defaultEnabled: true,
    visible: (scope: DataOpsScope) => isAdmin(scope),
    allowed: (scope: DataOpsScope) => isAdmin(scope),
  },
] as const

/**
 * Persisted ids that moved to a new capability id.
 *
 * `approval.push` shipped before the capability grew from approval push into resource
 * approval and authorization. Its stored toggle carries over to `resource.manage`; when both
 * keys are present the current id wins.
 */
const CAPABILITY_ALIASES: Readonly<Record<string, string>> = {
  'approval.push': 'resource.manage',
}

/** The ids the catalogue accepts; any other persisted key is a legacy value. */
const CAPABILITY_IDS: readonly string[] = CAPABILITIES.map(capability => capability.id)

/**
 * Keep only boolean values for known capability ids.
 *
 * A state file written before the catalogue changed may still hold retired ids. Those keys are
 * ignored rather than treated as a corrupt file; a missing new key takes the capability's
 * `defaultEnabled`.
 * @param value - the `capabilities` member of a parsed state file.
 * @returns the readable toggles, keyed by current capability id.
 */
function migrateCapabilities(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const stored = value as Record<string, unknown>
  const capabilities: Record<string, boolean> = {}
  for (const id of CAPABILITY_IDS) {
    if (typeof stored[id] === 'boolean') capabilities[id] = stored[id]
  }
  for (const [legacyId, id] of Object.entries(CAPABILITY_ALIASES)) {
    if (capabilities[id] === undefined && typeof stored[legacyId] === 'boolean') {
      capabilities[id] = stored[legacyId]
    }
  }
  return capabilities
}

/** Read state; a missing or corrupt file is a safe disabled state. */
export async function readConnectorState(path = CONNECTOR_STATE_PATH): Promise<DataOpsConnectorState> {
  try {
    const payload = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return { enabled: false, capabilities: {} }
    }
    const record = payload as Record<string, unknown>
    return {
      enabled: record.enabled === true,
      capabilities: migrateCapabilities(record.capabilities),
    }
  } catch {
    return { enabled: false, capabilities: {} }
  }
}

/** Persist state atomically. */
export async function writeConnectorState(
  state: DataOpsConnectorState,
  path = CONNECTOR_STATE_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.tmp-' + process.pid.toString()
  // Persist only current ids so a legacy key cannot come back through a state write.
  const payload: DataOpsConnectorState = {
    enabled: state.enabled,
    capabilities: migrateCapabilities(state.capabilities),
  }
  await writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8')
  await rename(temporary, path)
}

/** Read browser-bridge state; a missing or corrupt file means disabled. */
export async function readBrowserBridgeState(
  path = BROWSER_BRIDGE_STATE_PATH,
): Promise<BrowserBridgeConnectorState> {
  try {
    const payload = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return { enabled: false }
    }
    return { enabled: (payload as Record<string, unknown>).enabled === true }
  } catch {
    return { enabled: false }
  }
}

/** Persist browser-bridge state atomically. */
export async function writeBrowserBridgeState(
  state: BrowserBridgeConnectorState,
  path = BROWSER_BRIDGE_STATE_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.tmp-' + process.pid.toString()
  await writeFile(temporary, JSON.stringify({ enabled: state.enabled }, null, 2), 'utf8')
  await rename(temporary, path)
}

/** Product-language description shared by every bridge row; the hint below appends to it. */
const BROWSER_BRIDGE_DESCRIPTION =
  '把用户本地 Chrome/Edge 接入 AI 工作区，让 AI 通过 Playwright 操作本地浏览器；需要安装桥接程序。'

/**
 * Explain the live bridge state without exposing an endpoint or a credential.
 *
 * The connector row is where a person discovers *why* `browser_*` is missing, so an offline
 * companion, an expired login, and a failed connection each get a different next step.
 */
function browserBridgeDescription(runtime: BrowserBridgeStatus | undefined): string {
  switch (runtime?.phase) {
    case 'connected':
    case 'idle':
    case 'disabled':
    case undefined:
      return BROWSER_BRIDGE_DESCRIPTION
    case 'connecting':
      return BROWSER_BRIDGE_DESCRIPTION + ' 正在建立桥接连接…'
    case 'offline':
      return BROWSER_BRIDGE_DESCRIPTION + ' 当前没有在线的 Companion：请在本机输入 8 位配对码完成配对并启动 Companion，插件会每 60 秒自动重试。'
    case 'expired':
      return BROWSER_BRIDGE_DESCRIPTION + ' DataOps 登录已过期，重新登录后会自动恢复，无需重启工作区。'
    case 'closed':
      return BROWSER_BRIDGE_DESCRIPTION + ' 桥接会话已关闭；重新登录或重新启用连接器后会重新建立。'
    case 'error':
      return BROWSER_BRIDGE_DESCRIPTION + ' 桥接连接暂时失败，插件正在自动重试。'
  }
}

/**
 * Build the browser-bridge connector row.
 *
 * `connected` is evidence, not intent: it is true only while the MCP client is loaded *and*
 * the gateway reports the session active. `enabled` remains the persisted switch.
 * @param state - Persisted connector switch.
 * @param runtime - Live session status; omit when no session manager is active.
 * @returns The connector row the skill center renders.
 */
export function buildBrowserBridgeConnectorView(
  state: BrowserBridgeConnectorState,
  runtime?: BrowserBridgeStatus,
): ConnectorView {
  return {
    id: BROWSER_BRIDGE_CONNECTOR_ID,
    name: '浏览器桥接',
    vendor: 'DataOps',
    description: browserBridgeDescription(runtime),
    enabled: state.enabled,
    connected: runtime?.connected === true,
    capabilities: [],
    installer: {
      fileName: 'DSH-Browser-Bridge-Setup-Windows-x64-v0.1.0.exe',
      downloadUrl: BROWSER_BRIDGE_INSTALLER_PATH,
      description: '这是完整的离线 Windows 安装包，内含 Chromium、Node 和 Playwright，不会在安装时访问外网。安装后在本机启动受控浏览器窗口，AI 通过它执行网页操作；程序不会读取或上传用户日常浏览器的 Cookie。',
    },
  }
}

/** Build the connector row for one current scope. */
export function buildConnectorView(scope: DataOpsScope | undefined, state: DataOpsConnectorState): ConnectorView {
  const capabilities = scope === undefined
    ? []
    : CAPABILITIES.filter(capability => capability.visible(scope) && capability.allowed(scope)).map(capability => ({
        id: capability.id,
        name: capability.name,
        description: capability.description,
        enabled: state.capabilities[capability.id] ?? capability.defaultEnabled,
        permitted: true,
      }))
  return {
    id: DATAOPS_CONNECTOR_ID,
    name: '万相AI中台连接器',
    vendor: 'DataOps',
    description: '把万相AI中台的技能、审核和数据能力接入当前工作区。',
    enabled: state.enabled,
    connected: scope !== undefined,
    capabilities,
  }
}

/** Whether one capability id is in the fixed catalogue. */
export function hasCapability(id: string): boolean {
  return CAPABILITIES.some(capability => capability.id === id)
}
