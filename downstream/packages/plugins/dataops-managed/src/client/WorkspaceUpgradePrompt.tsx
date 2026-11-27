/**
 * Workspace image upgrade banner and confirmation dialog.
 *
 * The banner is deliberately quiet: it tells the user a newer workspace image exists and
 * leaves the current session usable. Only the explicit upgrade action opens the dialog
 * that can interrupt running sessions.
 *
 * @module WorkspaceUpgradePrompt
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import {
  fetchWorkspaceUpgrade,
  requestWorkspaceUpgrade,
  type WorkspaceUpgradeStatus,
} from './workspace-upgrade-client.ts'
import styles from './WorkspaceUpgradePrompt.module.css'

/** The copy resolver bound by the client plugin. */
export interface WorkspaceUpgradePromptProps {
  /** Resolve one managed DataOps message key. */
  readonly t: (key: keyof typeof en) => string
}

/** How often to re-read the image status while the page is open. */
const POLL_MS = 30_000

/** Wait before a reload so the restarted workspace has a chance to come back. */
const RELOAD_DELAY_MS = 12_000

/**
 * Render the banner and its upgrade dialog.
 * @param props.t - localized copy resolver.
 * @returns the banner while an image update is available, otherwise null.
 */
export function WorkspaceUpgradePrompt(props: WorkspaceUpgradePromptProps) {
  const { t } = props
  const [status, setStatus] = useState<WorkspaceUpgradeStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchWorkspaceUpgrade()
      if (next !== null) setStatus(next)
    } catch {
      // A transient read failure must not turn into a false upgrade banner.
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      if (cancelled) return
      await refresh()
    }
    void tick()
    const timer = setInterval(() => { void tick() }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refresh])

  const available = status?.imageStatus === 'UPDATE_AVAILABLE'
  const sessionCount = status?.activeSessions.length ?? 0
  const warning = useMemo(
    () => t('upgradeSessionsWarning').replace('{count}', String(sessionCount)),
    [sessionCount, t],
  )

  const openDialog = useCallback((): void => {
    setError('')
    setDialogOpen(true)
  }, [])

  const closeDialog = useCallback((): void => {
    if (busy) return
    setDialogOpen(false)
  }, [busy])

  const upgrade = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await requestWorkspaceUpgrade()
      setDialogOpen(false)
      setNotice(t('upgradeStarted'))
      setDismissed(true)
      window.setTimeout(() => { window.location.reload() }, RELOAD_DELAY_MS)
    } catch (cause) {
      // A connection drop is the normal shape of this request when the Host is
      // restarted before it can answer; the hand-off file is already on disk, so
      // report the upgrade as started rather than claiming it failed.
      if (cause instanceof TypeError) {
        setDialogOpen(false)
        setNotice(t('upgradeStarted'))
        setDismissed(true)
        window.setTimeout(() => { window.location.reload() }, RELOAD_DELAY_MS)
        return
      }
      setError(cause instanceof Error ? cause.message : t('upgradeFailed'))
    } finally {
      setBusy(false)
    }
  }, [t])

  if (notice !== '') {
    return (
      <div className={styles.banner} role="status" aria-live="polite">
        <span className={styles.title}>{notice}</span>
      </div>
    )
  }
  if (!available || dismissed) return null

  return (
    <>
      <div className={styles.banner} role="status" aria-live="polite">
        <div className={styles.copy}>
          <strong className={styles.title}>{t('upgradeAvailableTitle')}</strong>
          <span className={styles.body}>{t('upgradeAvailableBody')}</span>
        </div>
        <div className={styles.actions}>
          <Button variant="primary" size="sm" onClick={openDialog}>{t('upgradeAction')}</Button>
          <Button variant="ghost" size="sm" onClick={() => { setDismissed(true) }}>{t('upgradeLater')}</Button>
        </div>
      </div>

      <Modal
        open={dialogOpen}
        onClose={closeDialog}
        title={t('upgradeDialogTitle')}
        description={t('upgradeDialogBody')}
        closeLabel={t('upgradeCancel')}
        footer={(
          <>
            <Button variant="ghost" onClick={closeDialog} disabled={busy}>{t('upgradeCancel')}</Button>
            <Button variant="primary" onClick={() => { void upgrade() }} disabled={busy}>
              {busy ? t('upgradeBusy') : sessionCount === 0 ? t('upgradeAction') : t('upgradeConfirm')}
            </Button>
          </>
        )}
      >
        <div className={styles.dialogBody}>
          <p className={styles.dialogText}>{sessionCount === 0 ? t('upgradeNoSessions') : warning}</p>
          {sessionCount > 0 ? (
            <ul className={styles.sessionList}>
              {status?.activeSessions.map(session => (
                <li key={session.sessionId} className={styles.sessionRow}>
                  <span className={styles.sessionTitle}>{session.title ?? session.sessionId}</span>
                  {session.cwd ? <span className={styles.sessionPath}>{session.cwd}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {error !== '' ? <p className={styles.error} role="alert">{error}</p> : null}
        </div>
      </Modal>
    </>
  )
}
