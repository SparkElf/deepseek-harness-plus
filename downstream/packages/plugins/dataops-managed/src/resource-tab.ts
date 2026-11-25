/**
 * Host side of the "open a DataOps resource tab" bridge.
 *
 * A model tool cannot call a browser tab API. The tool publishes one event on this
 * workspace-local SSE channel; the client half owns `betterSidebar.openTab`. The channel
 * is scoped to one managed workspace (one DataOps user) and carries navigation only —
 * authorization still happens at every DataOps request.
 *
 * @module resource-tab
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

/** SSE route the client subscribes to. */
export const OPEN_RESOURCE_EVENTS_PATH = '/integrations/dataops/open-resource/events'
/** Same-origin route the client uses to learn where the DataOps frontend lives. */
export const RESOURCE_TAB_CONFIG_PATH = '/integrations/dataops/resource-tab/config'
/** Browser tab type registered by the client half. */
export const RESOURCE_TAB_TYPE = 'dataops-resources'

/** Modes the embed page knows how to apply after opening. */
export type OpenResourceMode = 'focus' | 'grant' | 'detail' | 'audit'

/** One navigation request delivered to every connected client. */
export interface OpenResourceEvent {
  type: 'open_resource'
  requestId: string
  resourceId: number
  resourceName: string | null
  mode: OpenResourceMode
  nonce: string
}

/** Minimal logger surface used by the hub. */
interface HubLogger {
  warn(message: string): void
}

/**
 * Fan-out registry for the workspace's live SSE subscribers.
 *
 * A workspace has one browser in the normal case, but a reconnect can briefly leave the
 * previous response open. Broadcasting to the current set makes the new connection and the
 * stale one harmless: the browser keeps one tab, and the client dedupes by resource tab id.
 */
export class OpenResourceHub {
  private readonly clients = new Set<ServerResponse>()
  private heartbeat: NodeJS.Timeout | undefined

  constructor(private readonly logger: HubLogger) {}

  /** Accept one SSE subscription and own its response until the client disconnects. */
  subscribe(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write(': connected\n\n')
    this.clients.add(response)
    this.ensureHeartbeat()
    const remove = () => {
      this.clients.delete(response)
      if (this.clients.size === 0 && this.heartbeat !== undefined) {
        clearInterval(this.heartbeat)
        this.heartbeat = undefined
      }
    }
    request.on('close', remove)
    request.on('aborted', remove)
    response.on('error', (error) => {
      this.logger.warn('dataops-managed: resource tab SSE response failed: ' + String(error))
      remove()
    })
  }

  /** Send one navigation event to every connected client. */
  broadcast(event: Omit<OpenResourceEvent, 'type' | 'requestId'> & { requestId?: string }): OpenResourceEvent {
    const payload: OpenResourceEvent = {
      type: 'open_resource',
      requestId: event.requestId ?? randomUUID(),
      resourceId: event.resourceId,
      resourceName: event.resourceName,
      mode: event.mode,
      nonce: event.nonce,
    }
    const frame = 'event: dataops-open-resource\ndata: ' + JSON.stringify(payload) + '\n\n'
    for (const client of this.clients) {
      try {
        client.write(frame)
      } catch (error) {
        this.clients.delete(client)
        this.logger.warn('dataops-managed: resource tab SSE write failed: ' + String(error))
      }
    }
    return payload
  }

  /** Number of live subscribers, used by the tool result to explain a missing browser. */
  size(): number {
    return this.clients.size
  }

  /** Close every subscriber; called by the plugin disposer. */
  dispose(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    for (const client of this.clients) {
      try { client.end() } catch { /* already gone */ }
    }
    this.clients.clear()
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat !== undefined) return
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        try { client.write(': keep-alive\n\n') } catch { this.clients.delete(client) }
      }
    }, 25_000)
    // Do not keep a server process alive only for the keep-alive tick.
    this.heartbeat.unref?.()
  }
}

/** Resolve the browser-facing DataOps origin for the iframe. */
export const resolveResourceTabConfig = (
  request: IncomingMessage,
  configuredWebBaseUrl: string | undefined,
): { embedBaseUrl: string; sameOrigin: boolean; tabType: string } => {
  const header = (name: string) => {
    const value = request.headers[name]
    return Array.isArray(value) ? value[0] : value
  }
  const forwardedProto = header('x-forwarded-proto')?.split(',')[0]?.trim()
  const forwardedHost = header('x-forwarded-host')?.split(',')[0]?.trim()
  const host = forwardedHost || header('host') || ''
  const requestOrigin = host ? `${forwardedProto || 'http'}://${host}` : ''
  const configured = configuredWebBaseUrl?.trim() || ''
  const embedBaseUrl = configured || requestOrigin || 'http://127.0.0.1:8080'
  let sameOrigin = false
  try {
    sameOrigin = new URL(embedBaseUrl).origin === requestOrigin
  } catch {
    sameOrigin = false
  }
  return { embedBaseUrl, sameOrigin, tabType: RESOURCE_TAB_TYPE }
}