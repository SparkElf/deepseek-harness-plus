import type { ReactNode } from 'react'
import { IconDownloadOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionLogDownloadDialog, type SessionLogDownloadDialogProps } from './Dialog.tsx'
import type { SessionLogDownloadDialogInjected } from './Dialog.tsx'
import { NS } from './locales.ts'
import css from './HeaderAction.module.css'

type SessionLogDownloadToolbarActionProps =
  PropsRuntime<'conversation.trajectory.toolbar.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionLogDownloadDialogInjected>

/**
 * Render the Session Header export capsule and its shared result dialog.
 * @param props - Session runtime, download controller, and localized dialog copy.
 * @returns the persistent Header action and Session-scoped dialog.
 */
export function SessionLogDownloadHeaderAction(props: SessionLogDownloadDialogProps): ReactNode {
  const { sessionId, useSessionLogDownload, request, t } = props
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])
  const busy = entry?.status === 'downloading'

  return (
    <>
      <button
        type="button"
        className={css.sessionLogButton}
        data-session-log-header
        disabled={busy}
        aria-busy={busy}
        onClick={() => { void request(sessionId) }}
      >
        <span>{t('header.action')}</span>
        <IconDownloadOutline16 size={10} />
      </button>
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
