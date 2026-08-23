import { useEffect, useMemo, useState } from 'react'
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
  baseUrl: string
  serverName: string
  mode: 'anonymous' | 'oidc'
  credentialConfigured: boolean | null
  credentialWritable: boolean | null
  authorizationAccepted: boolean | null
  account: Account | null
}

export interface DataOpsSectionInjected {
  t: (key: keyof typeof en) => string
}

export type DataOpsSectionProps = Partial<InjectFace<DataOpsSectionInjected>>

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

async function readStatus(): Promise<Status> {
  const response = await fetch(STATUS_PATH, { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return response.json() as Promise<Status>
}

export function DataOpsSection(props: DataOpsSectionProps) {
  const { t } = props
  if (t === undefined) return null
  return <Loaded t={t} />
}

function Loaded({ t }: { t: DataOpsSectionInjected['t'] }) {
  const [status, setStatus] = useState<Status | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const load = (): void => {
    setLoading(true)
    setFailure(undefined)
    void readStatus()
      .then(setStatus)
      .catch(() => { setFailure(t('statusFailed')) })
      .finally(() => { setLoading(false) })
  }

  useEffect(() => {
    load()
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) return
      const data = event.data as { type?: unknown; result?: unknown } | null
      if (data?.type !== OAUTH_MESSAGE_TYPE) return
      if (data.result === 'connected') {
        load()
        return
      }
      if (data.result === 'cancelled') return
      setFailure(t('connectFailed'))
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [])

  const state = useMemo(() => {
    if (loading) return { dot: 'ongoing' as const, label: t('loading') }
    if (failure !== undefined && status === undefined) {
      return { dot: 'warning' as const, label: t('statusUnavailable') }
    }
    if (status?.mode === 'anonymous') return { dot: 'warning' as const, label: t('anonymousMode') }
    if (status?.authorizationAccepted === true) return { dot: 'done' as const, label: t('connected') }
    if (status?.credentialConfigured === true) return { dot: 'warning' as const, label: t('authorizationExpired') }
    return { dot: 'warning' as const, label: t('notConnected') }
  }, [failure, loading, status, t])

  const openAuthorization = (): void => {
    setFailure(undefined)
    const connectUrl = new URL(CONNECT_PATH, window.location.origin)
    connectUrl.searchParams.set('origin', window.location.origin)
    const popup = window.open(connectUrl.toString(), 'dsh-dataops-authorization', 'popup,width=720,height=760')
    if (popup === null) setFailure(t('popupBlocked'))
  }

  const disconnect = (): void => {
    setDisconnecting(true)
    setFailure(undefined)
    void fetch(DISCONNECT_PATH, { method: 'POST' })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: unknown } | null
          throw new Error(typeof body?.error === 'string' ? body.error : t('disconnectFailed'))
        }
        setConfirmingDisconnect(false)
        load()
      })
      .catch((error: unknown) => { setFailure(messageOf(error) || t('disconnectFailed')) })
      .finally(() => { setDisconnecting(false) })
  }

  const connectedAccount = status?.mode === 'oidc' ? status.account : null
  const showActions = !confirmingDisconnect && (status?.mode === 'oidc' || failure !== undefined)

  return (
    <section className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.intro}>{t('intro')}</p>

      <div className={styles.card}>
        <div className={styles.statusRow}>
          <StateDot state={state.dot} />
          <div className={styles.statusCopy}>
            <span className={styles.statusLabel}>{state.label}</span>
            {!loading && status?.mode === 'oidc' && (
              <span className={styles.statusDetail}>
                {status.authorizationAccepted === true ? t('connectedDetail') : t('notConnectedDetail')}
              </span>
            )}
          </div>
        </div>

        {connectedAccount !== null && connectedAccount !== undefined && (
          <div className={styles.accountRow}>
            <span className={styles.avatar} aria-hidden="true">
              {(connectedAccount.displayName || connectedAccount.username).slice(0, 1).toUpperCase()}
            </span>
            <span className={styles.accountCopy}>
              <strong>{connectedAccount.displayName || connectedAccount.username}</strong>
              <span>{connectedAccount.email}</span>
              <span className={styles.accountUsername}>{connectedAccount.username}</span>
            </span>
          </div>
        )}

        {status?.mode === 'anonymous' && <p className={styles.detail}>{t('anonymousDetail')}</p>}

        {status?.mode === 'oidc' && status.credentialWritable === false && (
          <p className={styles.detail}>{t('externallyManaged')}</p>
        )}

        {failure !== undefined && <p className={styles.error} role="alert">{failure}</p>}

        {showActions && (
          <div className={styles.actions}>
            {status?.mode === 'oidc' && status.credentialWritable !== false && (
              <Button variant="primary" onClick={openAuthorization}>
                {status.authorizationAccepted === true ? t('switchAccount') : t('connect')}
              </Button>
            )}
            {status?.mode === 'oidc' && status.credentialConfigured === true && status.credentialWritable !== false && (
              <Button variant="outline" onClick={() => { setConfirmingDisconnect(true) }}>
                {t('disconnect')}
              </Button>
            )}
            {failure !== undefined && (
              <Button variant="ghost" onClick={load}>{t('retry')}</Button>
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
              <Button variant="outline" disabled={disconnecting} onClick={disconnect}>
                {t('confirm')}
              </Button>
            </div>
          </div>
        )}

        {loading && failure === undefined && status === undefined && <p className={styles.detail}>{t('loading')}</p>}

        {status !== undefined && (
          <details className={styles.advanced}>
            <summary>{t('advanced')}</summary>
            <div className={styles.advancedBody}>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>{t('server')}</span>
                <span className={styles.fieldValue} title={status.baseUrl}>{status.baseUrl}</span>
              </div>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>{t('mode')}</span>
                <span className={styles.fieldValue}>
                  {status.mode === 'anonymous' ? t('anonymousMode') : t('oidcMode')}
                </span>
              </div>
            </div>
          </details>
        )}

        <p className={styles.security}>{t('security')}</p>
      </div>
    </section>
  )
}
