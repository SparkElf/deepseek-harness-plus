/**
 * The DataOps browser bridge session: one MCP connection, many short-lived control tokens.
 *
 * A workspace reaches the user's local companion only through the DataOps gateway. The plugin
 * therefore asks DataOps for a session with the current user JWT, and the answer carries an
 * `mcpUrl` whose ticket is the connection capability plus a short-lived `bridgeToken` for the
 * control plane. The MCP client is created once from that URL; token expiry is refreshed in
 * memory, and only session closure (logout, device revoke, explicit close) releases the
 * connection.
 *
 * This module owns that lifecycle so `apply` only supplies callbacks. It never reads a bridge
 * address from the profile or the environment: the session API is the only production entry.
 *
 * @module browser-bridge-session
 */

import { noteAccepted, noteExpired } from './auth-state.ts'

/** Control-plane request timeout. A container network can be slow, but not unbounded. */
export const REQUEST_TIMEOUT_MS = 15_000
/**
 * Close is best-effort on the shutdown path, so it gets a shorter budget than a request whose
 * answer the user is waiting for. A session left open is cleaned up by the gateway; a plugin
 * disposal that hangs is visible immediately.
 */
export const CLOSE_TIMEOUT_MS = 3_000
/** Retry delay after the companion is offline or a control-plane call failed. */
export const RETRY_DELAY_MS = 60_000
/** How often an expiring `bridgeToken` is checked. */
export const REFRESH_INTERVAL_MS = 60_000
/** Refresh ahead of expiry: a token with less than this left is rotated. */
export const REFRESH_AHEAD_MS = 5 * 60_000
/** How often the gateway is asked whether the session is still active. */
export const STATUS_INTERVAL_MS = 30_000

/** Where the bridge currently stands, as the connector row reports it. */
export type BrowserBridgePhase =
  | 'disabled'
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'offline'
  | 'expired'
  | 'closed'
  | 'error'

/** The session the gateway handed out; `expiresAt` covers `bridgeToken`, not the MCP ticket. */
export interface BrowserBridgeSessionInfo {
  sessionId: string
  deviceId: string
  /** Ticket-bearing endpoint the MCP client connects to once. */
  mcpUrl: string
  /** Short-lived control-plane credential; rotated without touching the MCP connection. */
  bridgeToken: string
  /** Epoch milliseconds at which `bridgeToken` expires. */
  expiresAt: number
  /**
   * Which gateway process holds this session's MCP tunnel.
   *
   * A new value means DataOps restarted: the local MCP `session-id` from the previous process
   * is gone, so the plugin must rebuild its MCP client. Token refresh never changes it.
   * Omitted by older backends, in which case restart detection stays off.
   */
  gatewayInstanceId?: string
  /**
   * The device-side tunnel generation; Companion increments it on every reconnect.
   *
   * A change means the companion's local MCP may have restarted, so the client must be rebuilt
   * as well. Omitted by older backends.
   */
  tunnelGeneration?: number
}

/** One live MCP client this session owns. */
export interface BrowserBridgeMcpHandle {
  /** Whether the underlying plugin fiber is still loaded. */
  alive(): boolean
  /** Disconnect and unregister the `browser-bridge` tool namespace. */
  dispose(): Promise<void>
}

/** What the connector catalogue can show about the live bridge. */
export interface BrowserBridgeStatus {
  phase: BrowserBridgePhase
  /** The connector switch was on when this status was produced. */
  enabled: boolean
  /** MCP fiber alive and the gateway reports the session active. */
  connected: boolean
  sessionId?: string
  deviceId?: string
  /** ISO timestamp for the current `bridgeToken`; informational only. */
  expiresAt?: string
  /** Product-language hint for the connector row, without tokens or URLs. */
  detail?: string
}

/** The narrow logger this module needs; it never receives a URL or a token. */
export interface BrowserBridgeLogger {
  warn(message: string): void
}

/** Everything the session needs from the host, so the state machine is testable on its own. */
export interface BrowserBridgeSessionDeps {
  /** DataOps origin, already reduced to its origin by the caller. */
  baseUrl: string
  /** Read the current DataOps JWT; resolution is per call, never cached. */
  resolveToken(): Promise<string | undefined>
  /** Read the persisted connector switch. */
  isEnabled(): Promise<boolean>
  /** Create the one MCP client for this session; reject when the connection fails. */
  connectMcp(mcpUrl: string, bridgeToken: string): Promise<BrowserBridgeMcpHandle>
  logger: BrowserBridgeLogger
  /** Injectable clock, so expiry decisions are testable. */
  now?: () => number
  /** Injectable fetch, so control-plane traffic is testable. */
  fetch?: typeof fetch
}

/** Parsed answer to `POST /session`. */
export type SessionAnswer =
  | { kind: 'active'; session: BrowserBridgeSessionInfo }
  | { kind: 'offline' }
  | { kind: 'unauthorized' }
  | { kind: 'closed' }
  | { kind: 'error'; message: string }

/** Parsed answer to `POST /session/:id/refresh`. */
export type RefreshAnswer =
  | { kind: 'refreshed'; bridgeToken: string; expiresAt: number }
  | { kind: 'unauthorized' }
  | { kind: 'closed' }
  | { kind: 'error'; message: string }

/** Parsed answer to `GET /session/:id`. */
export type StatusAnswer =
  | { kind: 'active'; gatewayInstanceId?: string; tunnelGeneration?: number; deviceOnline?: boolean }
  | { kind: 'closed' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; message: string }

/**
 * Whether a control token is close enough to expiry to rotate.
 * @param expiresAt - Epoch milliseconds from the session answer.
 * @param now - Current epoch milliseconds.
 * @returns True when less than {@link REFRESH_AHEAD_MS} remains.
 */
export function expiresSoon(expiresAt: number, now: number): boolean {
  return expiresAt - now < REFRESH_AHEAD_MS
}

/**
 * Drop the query from an MCP URL before it can reach a log line.
 *
 * The `mcpUrl` carries the session ticket in its query string, so it is a credential and must
 * never be printed whole. The origin and path are enough to correlate a log entry.
 * @param url - Any URL, possibly already stripped of its query.
 * @returns Origin plus path, or a fixed marker when the value is not a URL.
 */
export function redactMcpUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return '(invalid url)'
  }
}

/**
 * Replace every URL in a diagnostic with its redacted form.
 *
 * MCP client failures often embed the endpoint they tried, and that endpoint carries a ticket.
 * Diagnostics pass through here so a log line cannot leak it.
 * @param text - Diagnostic text.
 * @returns The same text with each absolute URL reduced to origin plus path.
 */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gu, match => redactMcpUrl(match))
}

/**
 * Describe one thrown value without assuming it is an Error and without echoing a URL.
 * @param error - The value a failed call rejected with.
 * @returns A single-line diagnostic safe to log.
 */
export function describeError(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'unexpected failure'
  return redactUrls(message)
}

/** Narrow an unknown JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Read an expiry that may be an ISO timestamp, or already epoch milliseconds. */
function readExpiresAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value === '') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Only an HTTP(S) URL is a usable MCP endpoint. */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** The stable error code in a gateway refusal, when there is one. */
function errorCode(record: Record<string, unknown> | null): string | undefined {
  return typeof record?.code === 'string' && record.code !== '' ? record.code : undefined
}

/** Read the gateway process id; an older backend omits it and disables restart detection. */
function readGatewayInstanceId(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read the companion tunnel generation; an older backend omits it. */
function readTunnelGeneration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The pair that identifies the live gateway tunnel behind a session. */
export interface BrowserBridgeTunnelIdentity {
  gatewayInstanceId?: string
  tunnelGeneration?: number
}

/**
 * Whether the gateway or the companion that serves this session changed.
 *
 * Only components present on both sides are compared: an older backend that omits a field
 * cannot produce a false rebuild, and a value that appears for the first time is adopted
 * without a rebuild.
 * @param previous - Identity recorded from the session create answer.
 * @param next - Identity read from a status poll.
 * @returns True when any comparable component differs.
 */
export function tunnelIdentityChanged(
  previous: BrowserBridgeTunnelIdentity,
  next: BrowserBridgeTunnelIdentity,
): boolean {
  const instanceChanged = previous.gatewayInstanceId !== undefined
    && next.gatewayInstanceId !== undefined
    && previous.gatewayInstanceId !== next.gatewayInstanceId
  const generationChanged = previous.tunnelGeneration !== undefined
    && next.tunnelGeneration !== undefined
    && previous.tunnelGeneration !== next.tunnelGeneration
  return instanceChanged || generationChanged
}

/**
 * Carry forward identity components the new answer did not repeat.
 *
 * A field that appears later is recorded so the *next* change is observable, without treating
 * its first appearance as a change.
 * @param previous - Recorded identity, when there is one.
 * @param next - Identity read from the session or status answer.
 * @returns The identity to remember.
 */
export function mergeTunnelIdentity(
  previous: BrowserBridgeTunnelIdentity | undefined,
  next: BrowserBridgeTunnelIdentity,
): BrowserBridgeTunnelIdentity {
  return {
    gatewayInstanceId: next.gatewayInstanceId ?? previous?.gatewayInstanceId,
    tunnelGeneration: next.tunnelGeneration ?? previous?.tunnelGeneration,
  }
}

/** Read the JSON body of one control-plane answer, tolerating an empty or malformed one. */
async function readJsonBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Classify `POST /session`.
 * @param status - HTTP status.
 * @param body - Parsed JSON body, if any.
 * @returns The answer the session state machine acts on.
 */
export function parseSessionAnswer(status: number, body: unknown): SessionAnswer {
  const record = asRecord(body)
  if (status === 401) return { kind: 'unauthorized' }
  const code = errorCode(record)
  if (status === 409) {
    if (code === 'COMPANION_OFFLINE') return { kind: 'offline' }
    if (code === 'BRIDGE_SESSION_CLOSED') return { kind: 'closed' }
    return { kind: 'error', message: `session request refused (HTTP 409${code === undefined ? '' : ` ${code}`})` }
  }
  if (status !== 200) {
    return { kind: 'error', message: `session request failed (HTTP ${String(status)}${code === undefined ? '' : ` ${code}`})` }
  }
  const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : ''
  const mcpUrl = typeof record?.mcpUrl === 'string' ? record.mcpUrl : ''
  const bridgeToken = typeof record?.bridgeToken === 'string' ? record.bridgeToken : ''
  const expiresAt = readExpiresAt(record?.expiresAt)
  if (sessionId === '' || mcpUrl === '' || bridgeToken === '' || expiresAt === undefined) {
    return { kind: 'error', message: 'session response is missing sessionId, mcpUrl, bridgeToken, or expiresAt' }
  }
  if (!isHttpUrl(mcpUrl)) {
    return { kind: 'error', message: 'session response carried a non-HTTP mcpUrl' }
  }
  return {
    kind: 'active',
    session: {
      sessionId,
      deviceId: typeof record?.deviceId === 'string' ? record.deviceId : '',
      mcpUrl,
      bridgeToken,
      expiresAt,
      ...(readGatewayInstanceId(record?.gatewayInstanceId) === undefined
        ? {}
        : { gatewayInstanceId: readGatewayInstanceId(record?.gatewayInstanceId) }),
      ...(readTunnelGeneration(record?.tunnelGeneration) === undefined
        ? {}
        : { tunnelGeneration: readTunnelGeneration(record?.tunnelGeneration) }),
    },
  }
}

/**
 * Classify `POST /session/:id/refresh`.
 * @param status - HTTP status.
 * @param body - Parsed JSON body, if any.
 * @returns The answer the session state machine acts on.
 */
export function parseRefreshAnswer(status: number, body: unknown): RefreshAnswer {
  const record = asRecord(body)
  if (status === 401) return { kind: 'unauthorized' }
  const code = errorCode(record)
  if (status === 409 && code === 'BRIDGE_SESSION_CLOSED') return { kind: 'closed' }
  if (status !== 200) {
    return { kind: 'error', message: `bridge token refresh failed (HTTP ${String(status)}${code === undefined ? '' : ` ${code}`})` }
  }
  const bridgeToken = typeof record?.bridgeToken === 'string' ? record.bridgeToken : ''
  const expiresAt = readExpiresAt(record?.expiresAt)
  if (bridgeToken === '' || expiresAt === undefined) {
    return { kind: 'error', message: 'refresh response is missing bridgeToken or expiresAt' }
  }
  return { kind: 'refreshed', bridgeToken, expiresAt }
}

/**
 * Classify `GET /session/:id`.
 * @param status - HTTP status.
 * @param body - Parsed JSON body, if any.
 * @returns The answer the session state machine acts on.
 */
export function parseStatusAnswer(status: number, body: unknown): StatusAnswer {
  if (status === 401) return { kind: 'unauthorized' }
  if (status !== 200) {
    const code = errorCode(asRecord(body))
    return { kind: 'error', message: `session status request failed (HTTP ${String(status)}${code === undefined ? '' : ` ${code}`})` }
  }
  const record = asRecord(body)
  if (record?.status === 'closed') return { kind: 'closed' }
  if (record?.status === 'active') {
    return {
      kind: 'active',
      gatewayInstanceId: readGatewayInstanceId(record.gatewayInstanceId),
      tunnelGeneration: readTunnelGeneration(record.tunnelGeneration),
      ...(typeof record.deviceOnline === 'boolean' ? { deviceOnline: record.deviceOnline } : {}),
    }
  }
  return { kind: 'error', message: 'session status response carried no known status' }
}

/** Call `unref` when the runtime's timer has it, so a retry never holds the process open. */
function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  ;(timer as { unref?: () => void }).unref?.()
}

/**
 * The long-lived browser bridge connection for one workspace.
 *
 * Lifecycle:
 * 1. `start` reads the persisted connector switch; off means no call at all.
 * 2. `POST /session` with the current JWT. 200 opens the one MCP client, 409
 *    `COMPANION_OFFLINE` retries in a minute, 401 records the expired credential and waits for
 *    the next login.
 * 3. Every minute the control token is rotated in memory when it is close to expiry. The MCP
 *    client is never recreated for a token refresh.
 * 4. Every thirty seconds the gateway is asked whether the session is still active. `closed`
 *    is the one server state that disposes the MCP client.
 * 5. `dispose` closes the session best-effort and clears every timer.
 */
export class BrowserBridgeSession {
  private enabled = false
  private phase: BrowserBridgePhase = 'idle'
  private session: BrowserBridgeSessionInfo | undefined
  private mcp: BrowserBridgeMcpHandle | undefined
  /** The saved `mcpUrl` may have been rotated away; the next attempt reopens the session. */
  private ticketStale = false
  /** The gateway/companion pair the current MCP client was initialized against. */
  private tunnelIdentity: BrowserBridgeTunnelIdentity | undefined
  private detail: string | undefined
  private refreshTimer: ReturnType<typeof setInterval> | undefined
  private statusTimer: ReturnType<typeof setInterval> | undefined
  private connectPollTimer: ReturnType<typeof setInterval> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private ensuring: Promise<void> | undefined
  private refreshing = false
  private checking = false
  private disposed = false
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(private readonly deps: BrowserBridgeSessionDeps) {
    this.fetchImpl = deps.fetch ?? fetch
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * Read the connector switch and connect when it is on.
   *
   * Called once from plugin activation. It is fire-and-forget from `apply`'s point of view: an
   * offline companion is a normal state, not an activation failure.
   * @returns Readiness after the first attempt settles.
   */
  async start(): Promise<void> {
    this.enabled = await this.deps.isEnabled()
    if (this.disposed) return
    if (!this.enabled) {
      this.phase = 'disabled'
      this.stopConnectPoll()
      return
    }
    this.startConnectPoll()
    // One connection, one MCP client: an already connected session is left exactly as it is.
    // A second `start` (activation retry, tests, future callers) must not rotate the control
    // token or ask the gateway for another session.
    if (this.mcp !== undefined && this.mcp.alive() && this.session !== undefined) return
    await this.ensure()
  }

  /**
   * Apply a connector toggle without a restart.
   *
   * Enabling opens a session now; disabling closes the one this workspace holds so the tool
   * namespace goes away with the switch. The caller does not await the network attempt.
   * @param enabled - New persisted connector state.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return
    this.enabled = enabled
    if (!enabled) {
      this.phase = 'disabled'
      this.detail = undefined
      this.stopConnectPoll()
      await this.closeSession()
      return
    }
    this.startConnectPoll()
    if (this.session === undefined) {
      this.phase = 'connecting'
    } else if (this.mcp !== undefined && this.mcp.alive()) {
      this.phase = 'connected'
    } else {
      this.phase = 'connecting'
    }
    await this.ensure()
  }

  /**
   * React to a newly stored DataOps JWT.
   *
   * A 401 pauses the session without disposing the MCP connection, because the ticket in
   * `mcpUrl` outlives the JWT. The next login is what lets the control plane resume; if no
   * session exists yet, it is also the moment to open one.
   * @returns Readiness after any resumed or new work settles.
   */
  async onCredentialRefresh(): Promise<void> {
    if (this.disposed) return
    this.enabled = await this.deps.isEnabled()
    if (this.disposed) return
    if (!this.enabled) {
      this.phase = 'disabled'
      this.stopConnectPoll()
      return
    }
    this.startConnectPoll()
    if (this.session === undefined) {
      this.clearRetry()
      await this.ensure()
      return
    }
    // The session and its MCP client survive an expired JWT. Resume the schedule a 401
    // stopped and heal a fiber that died while it was paused. An already connected session
    // only touches the control plane: the MCP client is never rebuilt for a new token.
    this.startSchedule()
    if (this.phase === 'expired') this.phase = this.mcp !== undefined && this.mcp.alive() ? 'connected' : 'idle'
    if (this.mcp === undefined || !this.mcp.alive()) {
      await this.ensure()
      return
    }
    // A token adopted after a long pause may itself be close to expiry; rotate it now rather
    // than waiting for the next minute tick. This is a control-plane call only.
    if (this.session !== undefined && expiresSoon(this.session.expiresAt, this.now())) void this.checkRefresh()
  }

  /**
   * The live status the connector catalogue renders.
   * @returns Phase, connection truth, and a token-free hint.
   */
  status(): BrowserBridgeStatus {
    const handleAlive = this.mcp !== undefined && this.mcp.alive()
    const sessionActive = this.session !== undefined
    // A fiber can die between polls; reporting `connected` from the last recorded phase would
    // claim a tool namespace that is no longer registered.
    const phase: BrowserBridgePhase = this.phase === 'connected' && !(handleAlive && sessionActive)
      ? 'error'
      : this.phase
    return {
      phase,
      enabled: this.enabled,
      connected: this.enabled && phase === 'connected' && handleAlive && sessionActive,
      ...(this.session === undefined ? {} : {
        sessionId: this.session.sessionId,
        deviceId: this.session.deviceId,
        expiresAt: new Date(this.session.expiresAt).toISOString(),
      }),
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    }
  }

  /**
   * Close the session best-effort, dispose the MCP client, and clear every timer.
   *
   * Called from the plugin's effect disposer. A failed close is ignored: the gateway prunes
   * stale sessions, and shutdown must not wait on a control-plane call.
   * @returns Readiness after cleanup settles.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.closeSession()
    this.phase = 'disabled'
  }

  /** Serialize connection attempts; a retry, a toggle, and a new JWT must not race. */
  private ensure(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (!this.enabled) {
      this.phase = 'disabled'
      return Promise.resolve()
    }
    if (this.ensuring !== undefined) return this.ensuring
    const task = this.ensureNow().finally(() => {
      if (this.ensuring === task) this.ensuring = undefined
    })
    this.ensuring = task
    return task
  }

  /** One connection attempt: reuse the session when one exists, otherwise open one. */
  private async ensureNow(): Promise<void> {
    if (this.mcp !== undefined && !this.mcp.alive()) {
      const dead = this.mcp
      this.mcp = undefined
      await dead.dispose().catch(() => undefined)
    }
    if (this.mcp !== undefined) return
    if (this.session !== undefined && !this.ticketStale) {
      await this.connectMcp()
      return
    }
    await this.openSession()
  }

  /** Ask the gateway for a session, then connect the MCP client it names. */
  private async openSession(): Promise<void> {
    const token = await this.token()
    if (this.disposed || !this.enabled) return
    if (token === undefined) {
      this.phase = 'idle'
      this.detail = '工作区尚未登录 DataOps'
      return
    }
    this.phase = 'connecting'
    this.detail = undefined
    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint('/api/ai/browser-bridge/session'), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        // `deviceId` is deliberately omitted: the gateway picks the user's most recently
        // online device, and naming one would pin a workspace to a machine it cannot see.
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      this.warn('dataops-managed: browser bridge session request failed', error)
      this.phase = 'error'
      this.detail = '无法连接 DataOps Browser Bridge'
      this.scheduleRetry()
      return
    }
    const answer = parseSessionAnswer(response.status, await readJsonBody(response))
    if (this.disposed || !this.enabled) {
      // A toggle turned the connector off while the request was in flight; the gateway may
      // have created a session we will never use, so close it rather than leak it.
      if (answer.kind === 'active') await this.closeRemote(answer.session.sessionId)
      return
    }
    switch (answer.kind) {
      case 'active':
        // A new answer can carry a rotated ticket for the same session, or another session
        // entirely. The `browser-bridge` tool namespace is unique per live MCP client, so the
        // old client must be gone before a new URL is adopted.
        if (this.mcp !== undefined) {
          const stale = this.mcp
          this.mcp = undefined
          await stale.dispose().catch(() => undefined)
        }
        this.session = answer.session
        // A freshly created session defines the identity of the tunnel this client is about
        // to initialize against; later polls compare against it. Components the answer omits
        // are carried over so an older backend cannot erase what is already known.
        this.tunnelIdentity = mergeTunnelIdentity(this.tunnelIdentity, {
          gatewayInstanceId: answer.session.gatewayInstanceId,
          tunnelGeneration: answer.session.tunnelGeneration,
        })
        this.ticketStale = false
        this.detail = undefined
        this.clearRetry()
        this.startSchedule()
        await this.connectMcp()
        return
      case 'offline':
        this.phase = 'offline'
        this.detail = '本机 Companion 未在线（未配对或未启动）'
        this.scheduleRetry()
        return
      case 'unauthorized':
        noteExpired()
        this.phase = 'expired'
        this.detail = 'DataOps 登录已过期'
        this.stopTimers()
        return
      case 'closed':
        await this.dropLocal('closed', '桥接会话已关闭')
        return
      case 'error':
        this.phase = 'error'
        this.detail = '建立浏览器桥接会话失败'
        this.warn(`dataops-managed: ${answer.message}`)
        this.scheduleRetry()
    }
  }

  /** Create the one MCP client for the current session; failure reopens for a fresh ticket. */
  private async connectMcp(): Promise<void> {
    const session = this.session
    if (session === undefined) return
    this.phase = 'connecting'
    let handle: BrowserBridgeMcpHandle
    try {
      handle = await this.deps.connectMcp(session.mcpUrl, session.bridgeToken)
    } catch (error) {
      this.warn('dataops-managed: browser bridge MCP could not connect', error)
      // The gateway rotates the ticket whenever it reuses an active session, so the URL this
      // attempt used may already be stale. Keep the session id for the close path, but let
      // the next attempt ask for a session again and receive a current ticket.
      this.ticketStale = true
      this.stopSchedule()
      this.phase = 'error'
      this.detail = '浏览器桥接 MCP 连接失败，正在重试'
      this.scheduleRetry()
      return
    }
    if (this.disposed || !this.enabled || this.session?.sessionId !== session.sessionId) {
      await handle.dispose().catch(() => undefined)
      return
    }
    this.mcp = handle
    this.phase = 'connected'
    this.detail = undefined
    this.clearRetry()
  }

  /** Rotate the control token in memory when it is close to expiry. Never touches the MCP. */
  private async checkRefresh(): Promise<void> {
    if (this.disposed || this.refreshing) return
    const session = this.session
    if (session === undefined || !expiresSoon(session.expiresAt, this.now())) return
    const token = await this.token()
    if (this.disposed || token === undefined || this.session?.sessionId !== session.sessionId) return
    this.refreshing = true
    try {
      const response = await this.fetchImpl(this.endpoint(`/api/ai/browser-bridge/session/${encodeURIComponent(session.sessionId)}/refresh`), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const answer = parseRefreshAnswer(response.status, await readJsonBody(response))
      if (this.disposed || this.session?.sessionId !== session.sessionId) return
      switch (answer.kind) {
        case 'refreshed':
          // Only the in-memory control token and its expiry move. The MCP connection is
          // established by the ticket in `mcpUrl` and must not be rebuilt here.
          this.session = { ...session, bridgeToken: answer.bridgeToken, expiresAt: answer.expiresAt }
          noteAccepted()
          return
        case 'unauthorized':
          // An ordinary JWT expiry does not touch the MCP fiber: the ticket still works and
          // the next login resumes the control plane.
          noteExpired()
          this.phase = 'expired'
          this.detail = 'DataOps 登录已过期'
          this.stopSchedule()
          return
        case 'closed':
          await this.dropLocal('closed', '桥接会话已关闭')
          return
        case 'error':
          this.warn(`dataops-managed: ${answer.message}`)
      }
    } catch (error) {
      this.warn('dataops-managed: browser bridge token refresh failed', error)
    } finally {
      this.refreshing = false
    }
  }

  /**
   * Rebuild the MCP client after the gateway restarted or the companion reconnected.
   *
   * Both events invalidate the local MCP `session-id` held by the client, and the client does
   * not re-initialize on its own. Disposing it and asking the gateway for a session again is
   * the recovery; the returned ticket is current even when the gateway reuses the row.
   * @param previous - Identity the current client was initialized against.
   * @param next - Identity read from the status poll.
   * @returns Readiness after the rebuild attempt settles.
   */
  private async reconnectForTunnelChange(
    previous: BrowserBridgeTunnelIdentity,
    next: BrowserBridgeTunnelIdentity,
  ): Promise<void> {
    const gatewayRestarted = previous.gatewayInstanceId !== undefined
      && next.gatewayInstanceId !== undefined
      && previous.gatewayInstanceId !== next.gatewayInstanceId
    this.phase = 'connecting'
    this.detail = gatewayRestarted ? 'Gateway 已重启，正在恢复浏览器通道' : 'Companion 已重连，正在恢复浏览器通道'
    // The poll schedule is restarted by the new session; stopping it first keeps a refresh
    // from racing the rebuild with the previous generation's session.
    this.stopSchedule()
    const handle = this.mcp
    this.mcp = undefined
    if (handle !== undefined) await handle.dispose().catch(() => undefined)
    this.ticketStale = true
    await this.ensure()
    // Normally the new session starts the clocks itself. This keeps the invariant local:
    // a rebuild that joined an in-flight attempt must still end up with a poll schedule.
    if (this.status().connected) this.startSchedule()
  }

  /** Ask the gateway whether the session is still active; `closed` releases the MCP client. */
  private async checkStatus(): Promise<void> {
    if (this.disposed || this.checking) return
    const session = this.session
    if (session === undefined) return
    const token = await this.token()
    if (this.disposed || token === undefined || this.session?.sessionId !== session.sessionId) return
    this.checking = true
    try {
      const response = await this.fetchImpl(this.endpoint(`/api/ai/browser-bridge/session/${encodeURIComponent(session.sessionId)}`), {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const answer = parseStatusAnswer(response.status, await readJsonBody(response))
      if (this.disposed || this.session?.sessionId !== session.sessionId) return
      switch (answer.kind) {
        case 'active': {
          noteAccepted()
          const previous = this.tunnelIdentity
          const next: BrowserBridgeTunnelIdentity = {
            gatewayInstanceId: answer.gatewayInstanceId,
            tunnelGeneration: answer.tunnelGeneration,
          }
          if (previous !== undefined && tunnelIdentityChanged(previous, next)) {
            // Record the new pair before any await so one gateway/companion generation change
            // rebuilds exactly once, even when the retry clock observes the same value.
            this.tunnelIdentity = mergeTunnelIdentity(previous, next)
            await this.reconnectForTunnelChange(previous, next)
            return
          }
          // A field appearing for the first time is adopted, not treated as a change: an older
          // backend omits it, and a rollout must not force a pointless rebuild.
          this.tunnelIdentity = mergeTunnelIdentity(previous, next)
          if (answer.deviceOnline === false) {
            // 当前会话绑定的设备离线（换机/重新配对）。丢掉本地 MCP，让连接探测
            // 在下一轮选一台在线设备重新建会话，而不是永远卡在旧设备上。
            await this.closeRemote(session.sessionId)
            await this.dropLocal('offline', 'Companion 离线，等待设备恢复')
            this.startConnectPoll()
            return
          }
          if (this.phase === 'expired') this.phase = this.mcp !== undefined && this.mcp.alive() ? 'connected' : 'idle'
          if (this.mcp === undefined || !this.mcp.alive()) void this.ensure()
          return
        }
        case 'closed':
          // The only server state that releases the MCP connection.
          await this.dropLocal('closed', '桥接会话已关闭')
          return
        case 'unauthorized':
          noteExpired()
          this.phase = 'expired'
          this.detail = 'DataOps 登录已过期'
          this.stopSchedule()
          return
        case 'error':
          this.warn(`dataops-managed: ${answer.message}`)
      }
    } catch (error) {
      this.warn('dataops-managed: browser bridge session status check failed', error)
    } finally {
      this.checking = false
    }
  }

  /** Start the refresh and status clocks; idempotent so a resumed session cannot double them. */
  /**
   * 连接探测时钟：未连接时每 30 秒问一次网关「有在线设备/有人请求连接吗」。
   *
   * 这条路径不依赖已有 session：设备撤销、重新配对、Gateway 重启后插件都能自己恢复，
   * 不需要重启 DSH；已有健康会话时什么都不做，避免无谓请求。
   */
  private startConnectPoll(): void {
    if (this.disposed || !this.enabled || this.connectPollTimer !== undefined) return
    this.connectPollTimer = setInterval(() => { void this.checkConnectionOffer() }, STATUS_INTERVAL_MS)
    unrefTimer(this.connectPollTimer)
  }

  private stopConnectPoll(): void {
    if (this.connectPollTimer !== undefined) clearInterval(this.connectPollTimer)
    this.connectPollTimer = undefined
  }

  /** 没有健康会话时读取网关连接摘要；有在线设备或 connectRequested 就重新建会话。 */
  private async checkConnectionOffer(): Promise<void> {
    if (this.disposed || !this.enabled) return
    // 已有单飞重试/建连在进行时不要再发探测：重试本身会处理离线恢复。
    if (this.retryTimer !== undefined || this.ensuring !== undefined) return
    if (this.session !== undefined && this.mcp !== undefined && this.mcp.alive()) return
    const token = await this.token()
    if (this.disposed || token === undefined || !this.enabled) return
    try {
      const response = await this.fetchImpl(this.endpoint('/api/ai/browser-bridge/status'), {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (this.disposed || !this.enabled) return
      if (response.status === 401) {
        noteExpired()
        this.phase = 'expired'
        this.detail = 'DataOps 登录已过期'
        return
      }
      if (!response.ok) return
      const body = await readJsonBody(response) as {
        devices?: Array<{ online?: unknown }>
        connectRequested?: unknown
        activeSession?: { deviceOnline?: unknown } | null
      }
      const online = body?.activeSession?.deviceOnline === true
        || (Array.isArray(body?.devices) && body.devices.some(device => device?.online === true))
      if (body?.connectRequested === true || online) {
        this.clearRetry()
        await this.ensure()
      }
    } catch (error) {
      // 连接探测失败不影响已建立的 MCP；下一次时钟会重试。
      this.warn('dataops-managed: browser bridge connection probe failed (ignored)', error)
    }
  }

  private startSchedule(): void {
    if (this.disposed || this.session === undefined) return
    this.stopSchedule()
    this.refreshTimer = setInterval(() => { void this.checkRefresh() }, REFRESH_INTERVAL_MS)
    this.statusTimer = setInterval(() => { void this.checkStatus() }, STATUS_INTERVAL_MS)
    unrefTimer(this.refreshTimer)
    unrefTimer(this.statusTimer)
  }

  /** Stop both clocks; a paused session resumes them after the next JWT. */
  private stopSchedule(): void {
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer)
    this.refreshTimer = undefined
    if (this.statusTimer !== undefined) clearInterval(this.statusTimer)
    this.statusTimer = undefined
  }

  /** Ask for one retry after {@link RETRY_DELAY_MS}; only while the connector is on. */
  private scheduleRetry(): void {
    if (this.disposed || !this.enabled) return
    // Single-flight: an offline answer, a failed connect, and a failed status poll can all
    // land in the same minute. One pending retry is enough; more would stack timers and
    // hammer the gateway.
    if (this.retryTimer !== undefined) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.ensure()
    }, RETRY_DELAY_MS)
    unrefTimer(this.retryTimer)
  }

  /** Cancel a pending retry, including on the success path. */
  private clearRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  /** Stop every clock this session owns. */
  private stopTimers(): void {
    this.stopSchedule()
    this.clearRetry()
  }

  /** Close the current session: best-effort remote close, then local disposal. */
  private async closeSession(): Promise<void> {
    const sessionId = this.session?.sessionId
    this.session = undefined
    this.ticketStale = false
    this.tunnelIdentity = undefined
    this.stopTimers()
    const handle = this.mcp
    this.mcp = undefined
    if (sessionId !== undefined) await this.closeRemote(sessionId)
    if (handle !== undefined) await handle.dispose().catch(() => undefined)
  }

  /** Release an MCP client and state the server already closed; no close call needed. */
  private async dropLocal(phase: BrowserBridgePhase, detail: string): Promise<void> {
    this.stopTimers()
    const handle = this.mcp
    this.mcp = undefined
    this.session = undefined
    this.ticketStale = false
    this.tunnelIdentity = undefined
    this.phase = phase
    this.detail = detail
    if (handle !== undefined) await handle.dispose().catch(() => undefined)
  }

  /** Best-effort `POST /session/:id/close`; every failure is ignored by design. */
  private async closeRemote(sessionId: string): Promise<void> {
    const token = await this.token()
    if (token === undefined) return
    try {
      await this.fetchImpl(this.endpoint(`/api/ai/browser-bridge/session/${encodeURIComponent(sessionId)}/close`), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
      })
    } catch (error) {
      this.warn('dataops-managed: browser bridge close request failed (ignored)', error)
    }
  }

  /** Resolve the current JWT, tolerating a host that is already tearing down. */
  private async token(): Promise<string | undefined> {
    try {
      const value = await this.deps.resolveToken()
      return value === undefined || value === '' ? undefined : value
    } catch {
      return undefined
    }
  }

  /** Absolute control-plane URL below the DataOps origin. */
  private endpoint(path: string): URL {
    return new URL(path, this.deps.baseUrl)
  }

  /** Log one sanitized diagnostic. */
  private warn(message: string, error?: unknown): void {
    this.deps.logger.warn(error === undefined ? message : `${message}: ${describeError(error)}`)
  }
}