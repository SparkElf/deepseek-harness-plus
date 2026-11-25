/**
 * Always-mounted host→client bridge for the resource tab.
 *
 * The Host tool cannot call the browser's tab API. It broadcasts one SSE event; this
 * component translates that event into `betterSidebar.openTab` plus `updateTab` so a
 * second import focuses the existing tab and refreshes its target resource.
 *
 * @module client/OpenResourceBridge
 */

import { useEffect } from 'react'

/** The part of Better Sidebar's service this bridge uses. */
export interface ResourceTabService {
  openTab(seed: {
    type: string
    id?: string
    title?: string
    meta?: unknown
  }, scope?: { sessionId?: string }): void
  updateTab?(tabId: string, patch: {
    title?: string
    path?: string
    meta?: unknown
  }, sessionId?: string): void
}

/** One event as published by the Host's OpenResourceHub. */
interface OpenResourceEvent {
  type: 'open_resource'
  requestId: string
  resourceId: number
  resourceName: string | null
  mode: 'focus' | 'grant' | 'detail' | 'audit'
  nonce: string
}

/** Tab id shared with the client registration. */
export const RESOURCE_TAB_TYPE = 'dataops-resources'
const EVENTS_PATH = 'integrations/dataops/open-resource/events'

const isOpenResourceEvent = (value: unknown): value is OpenResourceEvent => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.type === 'open_resource'
    && typeof record.resourceId === 'number'
    && Number.isSafeInteger(record.resourceId)
    && (record.mode === 'focus' || record.mode === 'grant' || record.mode === 'detail' || record.mode === 'audit')
}

/** Invisible bridge component; renders nothing. */
export function OpenResourceBridge({ service, scope }: {
  service: ResourceTabService
  scope?: { sessionId?: string }
}) {
  useEffect(() => {
    if (typeof EventSource !== 'function') return undefined
    const source = new EventSource(EVENTS_PATH)
    const onEvent = (event: MessageEvent): void => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (!isOpenResourceEvent(parsed)) return
      const meta = {
        resourceId: parsed.resourceId,
        resourceName: parsed.resourceName,
        mode: parsed.mode,
        nonce: parsed.nonce,
      }
      service.openTab({
        type: RESOURCE_TAB_TYPE,
        id: RESOURCE_TAB_TYPE,
        title: '数据资源',
        meta,
      }, scope)
      service.updateTab?.(RESOURCE_TAB_TYPE, { title: '数据资源', meta }, scope?.sessionId)
    }
    source.addEventListener('dataops-open-resource', onEvent as EventListener)
    return () => {
      source.removeEventListener('dataops-open-resource', onEvent as EventListener)
      source.close()
    }
  }, [service, scope])
  return null
}