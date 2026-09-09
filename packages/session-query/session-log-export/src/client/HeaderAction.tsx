import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconDownloadOutline16, IconEllipsisOutline16, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { SessionLogDownloadDialog, type SessionLogDownloadDialogInjected, type SessionLogDownloadDialogProps } from './Dialog.tsx'
import css from './HeaderAction.module.css'

type SessionLogDownloadToolbarActionProps =
  PropsRuntime<'conversation.trajectory.toolbar.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionLogDownloadDialogInjected>

/**
 * Render the Session Header more-actions icon button, its download menu, and the shared result dialog.
 * @param props - Session runtime, download controller, and localized copy.
 * @returns the persistent Header action and Session-scoped dialog.
 */
export function SessionLogDownloadHeaderAction(props: SessionLogDownloadDialogProps): ReactNode {
  const { sessionId, useSessionLogDownload, request, t } = props
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])
  const busy = entry?.status === 'downloading'
  const [open, setOpen] = useState(false)

  return (
    <>
      <Menu
        open={open}
        align="end"
        dense
        onClose={() => { setOpen(false) }}
        items={[{ id: 'download', label: t('menu.download'), icon: <IconDownloadOutline16 />, disabled: busy }]}
        onSelect={() => {
          setOpen(false)
          void request(sessionId)
        }}
        anchor={(
          <button
            type="button"
            className={css.moreButton}
            aria-label={t('header.more')}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-busy={busy}
            onClick={() => { setOpen(value => !value) }}
          >
            <IconEllipsisOutline16 />
          </button>
        )}
      />
      <SessionLogDownloadDialog {...props} />
    </>
  )
}

/**
 * Render the desktop Session export action in the Trajectory toolbar.
 * @param props - Session runtime, shared download controller, and localized copy.
 * @returns the compact toolbar action.
 */
export function SessionLogDownloadToolbarAction(
  props: SessionLogDownloadToolbarActionProps,
): ReactNode {
  const { sessionId, useSessionLogDownload, request, t } = props
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])
  const busy = entry?.status === 'downloading'

  return (
    <button
      type="button"
      className={css.trajectoryButton}
      data-session-log-toolbar
      disabled={busy}
      aria-busy={busy}
      title={t('header.action')}
      onClick={() => { void request(sessionId) }}
    >
      <IconDownloadOutline16 size={11} />
      <span>{t('header.action')}</span>
    </button>
  )
}
