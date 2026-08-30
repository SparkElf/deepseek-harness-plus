import { useMemo, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { DataOpsClientInjected, DataOpsInjectedProps } from './contract.ts'
import { createDataOpsStore, isLoginExpired } from './store.ts'
import styles from './DataOpsSection.module.css'

/** Full props for the DataOps Settings contribution. */
export type DataOpsSectionProps =
  & PropsRuntime<'settings.section'>
  & PropsStore<ReturnType<typeof createDataOpsStore>>
  & DataOpsInjectedProps

/**
 * Render the DataOps connection state and authorization controls.
 * @param props - Root-scoped Settings owner, store, and injected callbacks.
 * @returns The localized Settings section, or nothing before injection.
 */
export function DataOpsSection(props: DataOpsSectionProps) {
  const { t, reload, openAuthorization, disconnect } = props
  if (t === undefined || reload === undefined || openAuthorization === undefined || disconnect === undefined) return null
  return (
    <Loaded
      {...props}
      t={t}
      reload={reload}
      openAuthorization={openAuthorization}
      disconnect={disconnect}
    />
  )
}

function Loaded(props: DataOpsSectionProps & Omit<DataOpsClientInjected, 'start'>) {
  const { t, reload, openAuthorization, disconnect } = props
  const { status, loading, failure, disconnecting } = props.useStore(value => value)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)

  const state = useMemo(() => {
    if (loading) return { dot: 'ongoing' as const, label: t('loading') }
    if (failure !== undefined && status === undefined) {
      return { dot: 'warning' as const, label: t('connectionFailed') }
    }
    if (status?.authorizationAccepted === true) return { dot: 'done' as const, label: t('connected') }
    if (isLoginExpired(status)) return { dot: 'warning' as const, label: t('loginExpired') }
    if (status?.credentialWritable === false) {
      return { dot: 'warning' as const, label: t('managedByAdministrator') }
    }
    return { dot: 'warning' as const, label: t('notConnected') }
  }, [failure, loading, status, t])

  const connectedAccount = status?.authorizationAccepted === true ? status.account : null
  const accountIdentity = connectedAccount?.email || connectedAccount?.username
  const showActions = !confirmingDisconnect && (status !== undefined || failure !== undefined)
  const confirmDisconnect = (): void => {
    void disconnect().then((completed) => {
      if (completed) setConfirmingDisconnect(false)
    })
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <div className={styles.body}>
        <div className={styles.statusRow}>
          <StateDot state={state.dot} />
          <span
            className={styles.statusLabel}
            role={failure !== undefined && status === undefined ? 'alert' : undefined}
          >
            {state.label}
          </span>
        </div>

        {connectedAccount !== null && (
          <div className={styles.accountRow}>
            <span className={styles.avatar} aria-hidden="true">
              {(connectedAccount.displayName || connectedAccount.username).slice(0, 1).toUpperCase()}
            </span>
            <span className={styles.accountCopy}>
              <strong>{connectedAccount.displayName || connectedAccount.username}</strong>
              <span>{accountIdentity}</span>
            </span>
          </div>
        )}

        {isLoginExpired(status) && <p className={styles.hint}>{t('loginExpiredHint')}</p>}
        {failure !== undefined && status !== undefined && (
          <p className={styles.error} role="alert">{t(failure)}</p>
        )}

        {showActions && (
          <div className={styles.actions}>
            {status !== undefined && status.credentialWritable && (
              <Button variant="primary" onClick={openAuthorization}>
                {status.authorizationAccepted ? t('reauthorize') : status.credentialConfigured ? t('signInAgain') : t('connect')}
              </Button>
            )}
            {status?.credentialConfigured === true && status.credentialWritable && (
              <Button variant="outline" onClick={() => { setConfirmingDisconnect(true) }}>
                {t('disconnect')}
              </Button>
            )}
            {status === undefined && failure !== undefined && (
              <Button variant="ghost" onClick={reload}>{t('retry')}</Button>
            )}
          </div>
        )}

        {confirmingDisconnect && (
          <div className={styles.confirmBox}>
            <h3 className={styles.confirmTitle}>{t('confirmDisconnect')}</h3>
            <p className={styles.confirmCopy}>{t('confirmDisconnectDetail')}</p>
            <div className={styles.confirmActions}>
              <Button variant="ghost" disabled={disconnecting} onClick={() => { setConfirmingDisconnect(false) }}>
                {t('keepConnected')}
              </Button>
              <Button variant="outline" disabled={disconnecting} onClick={confirmDisconnect}>
                {t('confirm')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
