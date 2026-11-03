/**
 * Connector catalogue for the skill center's fourth tab.
 *
 * A connector is a client-side description of one external system the profile
 * can talk to: whether it is enabled, and which capabilities that account may
 * use. The backend owns the authoritative list; this module only parses it and
 * keeps a demo catalogue for profiles whose bridge has not shipped the route
 * yet. Capability rows the account may not use are absent from the answer, so
 * the UI never renders a disabled placeholder for a permission it lacks.
 *
 * @module @sparkelf/dsh-client-ui-skill-center/client/connectors
 */

/** Same-origin route the host/DataOps bridge may serve the catalogue from. */
export const CONNECTORS_ROUTE = '/api/dsh-skill-center/connectors'

/** One capability a connector exposes to this account. */
export interface ConnectorCapability {
  /** Stable id the backend uses, e.g. `approval.read`. */
  id: string
  /** Name shown on the capability row. */
  name: string
  /** One line explaining what the capability does. */
  description?: string
  /** Whether the capability is currently on for this connector. */
  enabled: boolean
  /**
   * Whether this account may use the capability at all. A row with `false`
   * is not rendered: hiding it is the product rule, not a disabled placeholder.
   */
  permitted: boolean
  /** Why the capability cannot be used right now (missing credential, no route). */
  unavailableReason?: string
}

/** One connector as the catalogue serves it. */
export interface Connector {
  id: string
  name: string
  /** Vendor or system the connector talks to. */
  vendor?: string
  description?: string
  enabled: boolean
  /** Whether the last connection attempt succeeded; absent means unknown. */
  connected?: boolean
  /** Failure detail when the connector is enabled but not connected. */
  error?: string
  capabilities: readonly ConnectorCapability[]
}

/** The catalogue plus whether it came from the demo fallback. */
export interface ConnectorCatalogue {
  connectors: readonly Connector[]
  demo: boolean
}

/** The bridge does not serve the connector route (404/405/501/503). */
export class ConnectorUnavailableError extends Error {}

/** The bridge answered but the request failed for another reason. */
export class ConnectorRequestError extends Error {}

/** Write operations the tab performs. */
export interface ConnectorSource {
  /** Read the whole catalogue. */
  list(): Promise<readonly Connector[]>
  /** Enable or disable one connector, returning the refreshed catalogue. */
  setEnabled(connectorId: string, enabled: boolean): Promise<readonly Connector[]>
  /** Toggle one capability, returning the refreshed catalogue. */
  setCapability(connectorId: string, capabilityId: string, enabled: boolean): Promise<readonly Connector[]>
}

/** Same-origin HTTP source for a backend that supplies the catalogue. */
export class HttpConnectorSource implements ConnectorSource {
  /**
   * @param route - same-origin connector route; overridable for tests.
   */
  constructor(private readonly route: string = CONNECTORS_ROUTE) {}

  /** Read the catalogue. */
  async list(): Promise<readonly Connector[]> {
    return this.read(await this.request(this.route))
  }

  /** Enable or disable one connector. */
  async setEnabled(connectorId: string, enabled: boolean): Promise<readonly Connector[]> {
    return this.read(await this.request(this.route, { connectorId, enabled }))
  }

  /** Toggle one capability. */
  async setCapability(connectorId: string, capabilityId: string, enabled: boolean): Promise<readonly Connector[]> {
    return this.read(await this.request(this.route, { connectorId, capabilityId, enabled }))
  }

  private async request(route: string, body?: Record<string, unknown>): Promise<unknown> {
    const init: RequestInit = body === undefined
      ? { headers: { accept: 'application/json' } }
      : {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    const response = await fetch(route, init)
    if (response.status === 404 || response.status === 405 || response.status === 501 || response.status === 503) {
      throw new ConnectorUnavailableError('connector catalogue is not served')
    }
    if (!response.ok) {
      let detail = ''
      try {
        const payload = await response.json() as { error?: unknown }
        detail = typeof payload.error === 'string' ? payload.error : ''
      } catch {
        // The status is the only fact a non-JSON failure carries.
      }
      throw new ConnectorRequestError(detail === '' ? 'HTTP ' + String(response.status) : detail)
    }
    try {
      return await response.json() as unknown
    } catch {
      // A shell that answers unknown routes with its HTML fallback has no
      // connector route either, so the tab takes the demo catalogue.
      throw new ConnectorUnavailableError('connector catalogue is not JSON')
    }
  }

  private read(value: unknown): readonly Connector[] {
    return parseConnectorList(value)
  }
}

/** Narrow one wire value to a connector capability. */
function parseCapability(value: unknown): ConnectorCapability | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id === '') return null
  return {
    id: row.id,
    name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
    ...(typeof row.description === 'string' ? { description: row.description } : {}),
    enabled: row.enabled === true,
    permitted: row.permitted !== false,
    ...(typeof row.unavailableReason === 'string' ? { unavailableReason: row.unavailableReason } : {}),
  }
}

/** Narrow one wire value to a connector. */
function parseConnector(value: unknown): Connector | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id === '' || typeof row.name !== 'string' || row.name === '') return null
  const capabilities = Array.isArray(row.capabilities)
    ? row.capabilities.flatMap(entry => parseCapability(entry) ?? [])
    : []
  return {
    id: row.id,
    name: row.name,
    ...(typeof row.vendor === 'string' ? { vendor: row.vendor } : {}),
    ...(typeof row.description === 'string' ? { description: row.description } : {}),
    enabled: row.enabled === true,
    ...(typeof row.connected === 'boolean' ? { connected: row.connected } : {}),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
    capabilities,
  }
}

/**
 * Parse a catalogue answer. Both a bare array and `{ connectors: [...] }` are
 * accepted, because a bridge may grow the wrapper for counts without breaking
 * the older shape.
 * @param value - decoded JSON body.
 * @returns the connectors the body carries; empty when it carries none.
 */
export function parseConnectorList(value: unknown): Connector[] {
  if (Array.isArray(value)) return value.flatMap(entry => parseConnector(entry) ?? [])
  if (typeof value !== 'object' || value === null) return []
  const rows = (value as { connectors?: unknown }).connectors
  return Array.isArray(rows) ? rows.flatMap(entry => parseConnector(entry) ?? []) : []
}

/** Capabilities this account may see; a `permitted: false` row never renders. */
export function visibleCapabilities(connector: Connector): readonly ConnectorCapability[] {
  return connector.capabilities.filter(capability => capability.permitted)
}

/** How a connector card labels its current state. */
export type ConnectorState = 'disabled' | 'connected' | 'error'

/**
 * Derive the card state from the catalogue row.
 * @param connector - one catalogue row.
 * @returns `disabled`, `connected`, or `error`.
 */
export function connectorState(connector: Connector): ConnectorState {
  if (!connector.enabled) return 'disabled'
  return connector.connected === false ? 'error' : 'connected'
}

/**
 * The demo catalogue used when no bridge serves the route.
 *
 * It describes the connector this profile ships and one generic third-party
 * connector, so the tab still demonstrates enable/disable, per-capability
 * switches, a hidden no-permission capability, and an unavailable reason.
 * @returns a fresh mutable copy on every call.
 */
export function demoConnectors(): Connector[] {
  return [
    {
      id: 'wanxiang-ai',
      name: '万相AI中台连接器',
      vendor: 'DataOps',
      description: '接收万相AI中台的审批任务，并把处理结果回写中台。',
      enabled: false,
      connected: false,
      capabilities: [
        { id: 'approval.read', name: '读取审批任务', description: '拉取当前账号可办理的审批任务', enabled: true, permitted: true },
        { id: 'approval.handle', name: '打开办理', description: '跳转到万相AI中台审批详情完成办理', enabled: true, permitted: true },
        { id: 'task.writeback', name: '回写任务状态', description: '把办理结果回写到万相AI中台', enabled: false, permitted: true },
        { id: 'approval.batch', name: '批量审批', description: '一次处理多条审批任务', enabled: false, permitted: true, unavailableReason: '当前连接未开通批量接口' },
        { id: 'credential.manage', name: '管理连接凭据', description: '配置或轮换连接凭据', enabled: false, permitted: false },
      ],
    },
    {
      id: 'work-order',
      name: '通用工单连接器',
      vendor: '第三方系统',
      description: '把外部工单系统的待办接入任务中心。',
      enabled: false,
      connected: false,
      capabilities: [
        { id: 'ticket.pull', name: '拉取工单', description: '按账号权限拉取待办工单', enabled: true, permitted: true },
        { id: 'ticket.comment', name: '回写处理意见', description: '把处理意见回写到工单系统', enabled: false, permitted: true },
        { id: 'ticket.admin', name: '工单配置管理', description: '维护工单字段与流转规则', enabled: false, permitted: false },
      ],
    },
  ]
}

/**
 * Read the catalogue, falling back to the demo rows when the bridge has no
 * route. Any other failure propagates: a broken bridge is not "no connectors".
 * @param source - the deployed source.
 * @param demo - demo factory (tests pass a fixed list).
 * @returns the catalogue and whether it is the demo fallback.
 */
export async function readConnectorCatalogue(
  source: ConnectorSource,
  demo: () => Connector[] = demoConnectors,
): Promise<ConnectorCatalogue> {
  try {
    return { connectors: await source.list(), demo: false }
  } catch (error) {
    if (error instanceof ConnectorUnavailableError) return { connectors: demo(), demo: true }
    throw error
  }
}
