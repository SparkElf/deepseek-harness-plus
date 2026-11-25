import { useEffect, useSyncExternalStore, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReviewNotification } from './review-types.ts'
import { sortNotifications, unreadCount } from './review-types.ts'
import {
  loadNotifications,
  markRead,
  notificationSnapshot,
  subscribeNotifications,
} from './review-notification-store.ts'
import { reviewDemoMode } from './review-client.ts'
import styles from './NotificationBell.module.css'

/** Colour tone and glyph for one notification type, matching the automation-task rows. */
function notificationTone(type: string): 'success' | 'danger' | 'warn' | 'info' {
  if (type === 'approved' || type === 'published' || type === 'success') return 'success'
  if (type === 'rejected') return 'danger'
  if (type === 'unpublished') return 'warn'
  return 'info'
}

function NotificationIcon({ tone }: { tone: 'success' | 'danger' | 'warn' | 'info' }): ReactNode {
  if (tone === 'success') {
    return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" /><path d="m5.3 8.1 1.8 1.8 3.6-3.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
  }
  if (tone === 'danger') {
    return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.3 14 13H2L8 2.3Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M8 6v3.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="8" cy="11.2" r=".7" fill="currentColor" /></svg>
  }
  if (tone === 'warn') {
    return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" /><path d="M8 4.8v3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><circle cx="8" cy="11.1" r=".7" fill="currentColor" /></svg>
  }
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 2.5h5l3 3v8H4v-11Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M9 2.5v3h3M6 8h4M6 10.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
}

/** Props accepted by a bell. */
export interface NotificationBellProps {
  /** Accessible label; the two plaza headings differ so screen readers can tell them apart. */
  label: string
  /** Called after a row is read, so the plaza can jump to the matching tab or card. */
  onOpen?: (item: ReviewNotification) => void
}

/**
 * A bell with an unread badge and the shared inbox.
 *
 * The bell is a button rather than a menu so keyboard focus and Escape follow the dialog
 * conventions the rest of the page already uses. Rows mark themselves read when opened;
 * "全部已读" is the one bulk action.
 */
export function NotificationBell({ label, onOpen }: NotificationBellProps): ReactNode {
  const state = useSyncExternalStore(subscribeNotifications, notificationSnapshot, notificationSnapshot)
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)
  const items = sortNotifications(state.items)
  const unread = unreadCount(items)
  const pages = Math.max(1, Math.ceil(items.length / 20))
  const visible = items.slice(page * 20, page * 20 + 20)

  useEffect(() => {
    // Marking rows read changes no ordering; only a shrinking inbox can invalidate the page.
    if (page >= pages) setPage(pages - 1)
  }, [page, pages])

  // Load once on mount so the badge states the real unread count before the reader clicks.
  useEffect(() => { void loadNotifications() }, [])

  const openOne = (item: ReviewNotification): void => {
    void markRead([item.id])
    setOpen(false)
    onOpen?.(item)
  }

  return (
    <>
      <button
        type="button"
        className={styles.bell}
        aria-label={unread === 0 ? label : label + '，' + String(unread) + ' 条未读'}
        title={label}
        data-notification-bell=""
        data-unread={unread}
        onClick={() => {
          setOpen(true)
          setPage(0)
          void loadNotifications()
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2.2a4.1 4.1 0 0 0-4.1 4.1v2.3L2.7 10.8a.6.6 0 0 0 .5.9h9.6a.6.6 0 0 0 .5-.9L12.1 8.6V6.3A4.1 4.1 0 0 0 8 2.2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M6.4 13.2a1.7 1.7 0 0 0 3.2 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        {unread === 0 ? null : <span className={styles.badge}>{unread > 99 ? '99+' : unread}</span>}
      </button>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={label}
        closeLabel="关闭"
        className={styles.dialog as string}
        footer={(
          <div className={styles.actions}>
            <button type="button" className={styles.linkButton} onClick={() => { void markRead('all') }}>
              全部已读
            </button>
            <button type="button" className={styles.button} onClick={() => { setOpen(false) }}>关闭</button>
          </div>
        )}
      >
        {reviewDemoMode() ? <p className={styles.demo}>演示数据 · 后端契约到达后自动切换</p> : null}
        {state.status === 'unavailable' ? (
          <p className={styles.empty}>通知服务待后端联调（task-35）；上线后这里会显示审核、上架与 AI 报告事件。</p>
        ) : null}
        {state.status !== 'unavailable' && items.length === 0 ? <p className={styles.empty}>暂无通知。</p> : null}
        {items.length === 0 ? null : (
          <ul className={styles.list}>
            {visible.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  className={styles.row}
                  onClick={() => { openOne(item) }}
                >
                  <span className={styles.rowIcon} data-tone={notificationTone(item.type)} aria-hidden="true"><NotificationIcon tone={notificationTone(item.type)} /></span>
                  <span className={styles.rowBody}>
                    <span className={styles.rowTitle}>{item.title}</span>
                    {item.body === undefined ? null : <span className={styles.rowText}>{item.body}</span>}
                  </span>
                  <span className={styles.rowMeta}>
                    <span className={styles.rowTime}>{item.createdAt.slice(0, 16).replace('T', ' ')}</span>
                    {item.read ? null : <span className={styles.dot} aria-hidden="true" />}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {items.length === 0 ? null : (
          <div className={styles.pager}>
            <button type="button" disabled={page === 0} onClick={() => { setPage(current => Math.max(0, current - 1)) }}>上一页</button>
            <span>第 {page + 1} / {pages} 页 · 共 {items.length} 条</span>
            <button type="button" disabled={page >= pages - 1} onClick={() => { setPage(current => Math.min(pages - 1, current + 1)) }}>下一页</button>
          </div>
        )}
      </Modal>
    </>
  )
}

/** The automation page's seat: the same inbox under the workflow plaza's heading. */
export function WorkflowPlazaBell(): ReactNode {
  return <NotificationBell label="自动化任务通知" />
}
