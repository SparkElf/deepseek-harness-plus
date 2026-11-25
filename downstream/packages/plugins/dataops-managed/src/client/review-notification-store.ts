/**
 * One process-wide notification store shared by every bell.
 *
 * The skill plaza and the workflow plaza are separate React trees, but they show the same
 * inbox; keeping the read state in one store is what stops a badge in one place from staying
 * unread after the other opened the row.
 */

import { useEffect } from 'react'
import { fetchNotifications, markNotificationsRead, reviewDemoMode } from './review-client.ts'
import type { ReviewNotification } from './review-types.ts'
import { sortNotifications, unreadCount } from './review-types.ts'

interface NotificationState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  items: readonly ReviewNotification[]
  unread: number
}

const DEMO_ITEMS: readonly ReviewNotification[] = [
  {
    id: 'demo-1', type: 'review_pending', title: '技能「SQL 取数助手」等待审核',
    body: '来自研发部 · 提交于 10 分钟前', resourceKind: 'skill', resourceId: 101, read: false,
    createdAt: '2026-10-23T04:50:00.000Z',
  },
  {
    id: 'demo-2', type: 'ai_report', title: 'AI 风险报告已生成',
    body: '风险等级：中 · 2 条建议', resourceKind: 'skill', resourceId: 101, read: false,
    createdAt: '2026-10-23T04:49:00.000Z',
  },
  {
    id: 'demo-3', type: 'approved', title: '工作流「每日经营日报」已通过',
    body: '审核人：admin', resourceKind: 'workflow', resourceId: 'wf-1', read: true,
    createdAt: '2026-10-22T09:10:00.000Z',
  },
]

let state: NotificationState = { status: 'idle', items: [], unread: 0 }
const listeners = new Set<() => void>()

function publish(next: NotificationState): void {
  state = next
  for (const listener of listeners) listener()
}

/** Current snapshot for `useSyncExternalStore`. */
export function notificationSnapshot(): NotificationState {
  return state
}

/** Subscribe to store changes. */
export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Load the inbox once; a second caller joins the first request. */
let inflight: Promise<void> | undefined
export function loadNotifications(): Promise<void> {
  if (inflight !== undefined) return inflight
  publish({ ...state, status: 'loading' })
  inflight = (async () => {
    try {
      if (reviewDemoMode()) {
        publish({ status: 'ready', items: sortNotifications(DEMO_ITEMS), unread: unreadCount(DEMO_ITEMS) })
        return
      }
      const result = await fetchNotifications()
      if (result === null) {
        publish({ status: 'unavailable', items: [], unread: 0 })
        return
      }
      publish({ status: 'ready', items: sortNotifications(result.items), unread: unreadCount(result.items) })
    } catch {
      publish({ status: 'unavailable', items: [], unread: 0 })
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}

/** Mark one row or the whole inbox read, optimistically. */
export async function markRead(ids: 'all' | readonly string[]): Promise<void> {
  const items = ids === 'all' ? state.items.map(item => ({ ...item, read: true })) : state.items.map(item => (
    ids.includes(item.id) ? { ...item, read: true } : item
  ))
  publish({ ...state, items, unread: unreadCount(items) })
  try {
    const ok = await markNotificationsRead(ids)
    if (!ok) await loadNotifications()
  } catch {
    await loadNotifications()
  }
}

/** Load the inbox when a bell first mounts. */
export function useNotifications(): NotificationState {
  useEffect(() => { void loadNotifications() }, [])
  // The component calls `useSyncExternalStore` itself; this hook only owns the first load.
  return state
}