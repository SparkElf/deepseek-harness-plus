/**
 * Workspace-local SSE fan-out for cockpit navigation.
 *
 * A model tool cannot touch a browser tab. `cockpit_open` publishes one event on
 * this channel; the client half owns `betterSidebar.openTab`. The channel is
 * scoped to one managed workspace and carries navigation only — authorization
 * still happens on every DataOps request.
 *
 * @module open-hub
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

/** SSE route the client subscribes to. */
export const OPEN_EVENTS_PATH = '/dsh-artifact-app/open/events'
/** Same-origin route the client uses to read render and gateway addresses. */
export const CONFIG_PATH = '/dsh-artifact-app/config'
/** Same-origin route the client uses to read the workspace token for postMessage. */
export const TOKEN_PATH = '/dsh-artifact-app/token'
/** Same-origin app-list proxy used by the sidebar tab. */
export const APPS_PATH = '/dsh-artifact-app/apps'
/** Same-origin cockpit-template list proxy used by the sidebar tab. */
export const TEMPLATES_PATH = '/dsh-artifact-app/templates'
/** Same-origin preview creation used by the HTML file viewer. */
export const PREVIEW_PATH = '/dsh-artifact-app/preview'
/** Render route prefix; `:id` follows it. */
export const RENDER_PATH = '/dsh-artifact-app/render'
/** Gateway prefix the sandboxed cockpit HTML may call. */
export const GATEWAY_PATH = '/dsh-artifact-app/gateway'

/** Tab type registered by the client half. */
export const ARTIFACT_TAB_TYPE = 'dataops-artifact-apps'

/** One navigation request delivered to every connected client. */
export interface OpenCockpitEvent {
  type: 'open_cockpit'
  requestId: string
  cockpitId: string
  cockpitName: string | null
  mode: 'focus' | 'detail'
  nonce: string
}

/** One refresh request for an already-open viewer. */
export interface CockpitUpdatedEvent {
  type: 'cockpit_updated'
  cockpitId: string
  nonce: string
}

/** Minimal logger surface used by the hub. */
interface HubLogger {
  warn(message: string): void
}

/** Fan-out registry for the workspace's live SSE subscribers. */
export class OpenCockpitHub {
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
      this.logger.warn('artifact-app: SSE response failed: ' + String(error))
      remove()
    })
  }

  /** Send one navigation event to every connected client. */
  broadcastOpen(event: Omit<OpenCockpitEvent, 'type' | 'requestId'> & { requestId?: string }): OpenCockpitEvent {
    const payload: OpenCockpitEvent = {
      type: 'open_cockpit',
      requestId: event.requestId ?? randomUUID(),
      cockpitId: event.cockpitId,
      cockpitName: event.cockpitName,
      mode: event.mode,
      nonce: event.nonce,
    }
    this.write('dataops-open-cockpit', payload)
    return payload
  }

  /** Ask open viewers of one cockpit to reload it. */
  broadcastUpdated(event: Omit<CockpitUpdatedEvent, 'type'>): CockpitUpdatedEvent {
    const payload: CockpitUpdatedEvent = { type: 'cockpit_updated', cockpitId: event.cockpitId, nonce: event.nonce }
    this.write('dataops-cockpit-updated', payload)
    return payload
  }

  /** Number of live subscribers, used by a tool result to explain a missing browser. */
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

  private write(eventName: string, payload: unknown): void {
    const frame = 'event: ' + eventName + '\ndata: ' + JSON.stringify(payload) + '\n\n'
    for (const client of this.clients) {
      try {
        client.write(frame)
      } catch (error) {
        this.clients.delete(client)
        this.logger.warn('artifact-app: SSE write failed: ' + String(error))
      }
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat !== undefined) return
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        try { client.write(': keep-alive\n\n') } catch { this.clients.delete(client) }
      }
    }, 25_000)
    this.heartbeat.unref?.()
  }
}