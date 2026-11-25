import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { en } from './locales.ts'
import styles from './DataOpsSection.module.css'

const STATUS_PATH = '/integrations/dataops/status'
const CONNECT_PATH = '/integrations/dataops/connect'
const DISCONNECT_PATH = '/integrations/dataops/disconnect'
const OAUTH_MESSAGE_TYPE = 'dsh:dataops-oauth'

interface Account {
  username: string
  displayName: string
  email: string
}

interface Status {
  credentialConfigured: boolean
  credentialWritable: boolean
  disconnectReleasesAccount: boolean
  authorizationAccepted: boolean
  account: Account | null
}

/** Values injected by the DSH Settings slot. */
export interface DataOpsSectionInjected {
  /** Translate one DataOps Settings message key. */
  t: (key: keyof typeof en) => string
}

/** Props accepted by the injected DataOps Settings section. */
export type DataOpsSectionProps = Partial<InjectFace<DataOpsSectionInjected>>

async function readStatus(): Promise<Status> {
  const response = await fetch(STATUS_PATH, { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return response.json() as Promise<Status>
}

/**
 * Render the DataOps connection state and authorization controls.
 * @param props - Settings slot injection values.
 * @returns The localized Settings section, or nothing before injection.
 */
export function DataOpsSection(props: DataOpsSectionProps) {
  const { t } = props
  if (t === undefined) return null
  return <Loaded t={t} />
}

// Settings只在打开页面和用户完成Connect、Reauthorize或Disconnect后刷新，不维持后台轮询。
function Loaded({ t }: { t: DataOpsSectionInjected['t'] }) {
  const [status, setStatus] = useState<Status | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const authorizationPopup = useRef<Window | null>(null)

  const load = (): void => {
    setLoading(true)
    setFailure(undefined)
    void readStatus()
      .then(setStatus)
      .catch((error: unknown) => {
        console.error('dataops-integration: status request failed', error)
        setFailure(t('connectionFailed'))
      })
      .finally(() => { setLoading(false) })
  }

  useEffect(() => {
    load()
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin || event.source !== authorizationPopup.current) return
      const data = event.data as { type?: unknown; result?: unknown } | null
      if (data?.type !== OAUTH_MESSAGE_TYPE) return
      authorizationPopup.current = null
      if (data.result === 'connected') {
        load()
        return
      }
      if (data.result === 'cancelled') return
      setFailure(t('connectFailed'))
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      authorizationPopup.current?.close()
      authorizationPopup.current = null
    }
  }, [])

  const state = useMemo(() => {
    if (loading) return { dot: 'ongoing' as const, label: t('loading') }
    if (failure !== undefined && status === undefined) {
      return { dot: 'warning' as const, label: t('connectionFailed') }
    }
    if (status?.authorizationAccepted === true) return { dot: 'done' as const, label: t('connected') }
    if (status?.credentialWritable === false) {
      return { dot: 'warning' as const, label: t('managedByAdministrator') }
    }
    return { dot: 'warning' as const, label: t('notConnected') }
  }, [failure, loading, status, t])

  const openAuthorization = (): void => {
    const activePopup = authorizationPopup.current
    if (activePopup !== null && !activePopup.closed) {
      activePopup.focus()
      return
    }
    setFailure(undefined)
    const connectUrl = new URL(CONNECT_PATH, window.location.origin)
    connectUrl.searchParams.set('origin', window.location.origin)
    const popup = window.open(connectUrl.toString(), 'dsh-dataops-authorization', 'popup,width=720,height=760')
    authorizationPopup.current = popup
    if (popup === null) setFailure(t('popupBlocked'))
  }

  const disconnect = (): void => {
    setDisconnecting(true)
    setFailure(undefined)
    void fetch(DISCONNECT_PATH, { method: 'POST' })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`DataOps disconnect failed with HTTP ${String(response.status)}`)
        }
        setConfirmingDisconnect(false)
        load()
      })
      .catch((error: unknown) => {
        console.error('dataops-integration: disconnect request failed', error)
        setFailure(t('disconnectFailed'))
      })
      .finally(() => { setDisconnecting(false) })
  }

  const connectedAccount = status?.authorizationAccepted === true ? status.account : null
  const accountIdentity = connectedAccount?.email || connectedAccount?.username
  const showActions = !confirmingDisconnect && (status !== undefined || failure !== undefined)

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

        {connectedAccount !== null && connectedAccount !== undefined && (
          <div className={styles.accountRow} aria-label={t('connectedAccount')}>
            <span className={styles.avatar} aria-hidden="true">
              {(connectedAccount.displayName || connectedAccount.username).slice(0, 1).toUpperCase()}
            </span>
            <span className={styles.accountCopy}>
              <strong>{connectedAccount.displayName || connectedAccount.username}</strong>
              <span>{accountIdentity}</span>
            </span>
          </div>
        )}

        {status?.credentialWritable === false && (
          <p className={styles.detail}>{t('managedByAdministrator')}</p>
        )}

        {failure !== undefined && status !== undefined && (
          <p className={styles.error} role="alert">{failure}</p>
        )}

        {showActions && (
          <div className={styles.actions}>
            {status !== undefined && status.credentialWritable && (
              <Button variant="primary" onClick={openAuthorization}>
                {status.authorizationAccepted ? t('reauthorize') : t('connect')}
              </Button>
            )}
            {status?.credentialConfigured === true && status.credentialWritable && (
              <Button variant="outline" onClick={() => { setConfirmingDisconnect(true) }}>
                {t('disconnect')}
              </Button>
            )}
            {status === undefined && failure !== undefined && (
              <Button variant="ghost" onClick={load}>{t('retry')}</Button>
            )}
          </div>
        )}

        {confirmingDisconnect && (
          <div className={styles.confirmBox}>
            <h3 className={styles.confirmTitle}>{t('confirmDisconnect')}</h3>
            <p className={styles.confirmCopy}>
              {t(status!.disconnectReleasesAccount ? 'confirmDisconnectSwitchableDetail' : 'confirmDisconnectDetail')}
            </p>
            <div className={styles.confirmActions}>
              <Button variant="ghost" disabled={disconnecting} onClick={() => { setConfirmingDisconnect(false) }}>
                {t('keepConnected')}
              </Button>
              <Button variant="outline" disabled={disconnecting} onClick={disconnect}>
                {t('confirm')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
