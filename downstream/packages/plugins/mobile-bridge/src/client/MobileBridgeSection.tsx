/** Mobile Bridge settings section: connection state, configuration, and pairing QR. */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import QRCode from 'qrcode/lib/browser.js'
import { Button, IconStopFillRegular, Input, Modal, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './contract.ts'
import css from './MobileBridgeSection.module.css'

/** Settings values owned by the Host plugin namespace. */
export interface MobileBridgeValues {
  serverUrl: string
  localPort: number
  userKey: string
  userKeySet: boolean
  ownerEmail: string
  emailTwoFactor: boolean
  sessionDays: number
  autoConnect: boolean
  autoReconnect: boolean
  domDiagnostics: boolean
}

/** One phone device projected by the Host. */
export interface MobileBridgeDevice {
  id: string
  bridgeId: string
  name: string
  ip: string
  pairedAt: number
  lastSeenAt: number
  online: boolean
}

/** Latest remote geometry capture projected in the paired device row. */
export interface MobileDomDiagnosticSummary {
  deviceId: string
  capturedAt: number
  viewport: { width: number; height: number; dpr: number }
  elementCount: number
}

/** Current Host connection, pairing ticket, devices, and opt-in diagnostics projection. */
export interface MobileBridgeStatus {
  connected: boolean
  qrUrl: string
  pairingCode: string
  pairingRefreshing: boolean
  devices: MobileBridgeDevice[]
  domDiagnosticsEnabled: boolean
  domDiagnostics: MobileDomDiagnosticSummary[]
}

/** Registration-side operations supplied by the Client plugin apply closure. */
export interface MobileBridgeSectionInjected {
  loadValues(): Promise<MobileBridgeValues>
  saveValues(values: MobileBridgeValues): Promise<MobileBridgeValues>
  loadStatus(): Promise<MobileBridgeStatus>
  subscribeStatus(listener: (status: MobileBridgeStatus) => void): () => void
  disconnectDevice(deviceId: string): Promise<MobileBridgeStatus>
  connectNow(): Promise<MobileBridgeStatus>
  disconnectNow(): Promise<MobileBridgeStatus>
}

/** Full settings component props derived from the public Slot shares. */
export type MobileBridgeSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settingsMobileBridge'>
  & InjectFace<MobileBridgeSectionInjected>

function SettingsLabel({ label, hint }: { label: string; hint: string }): ReactNode {
  return (
    <Tooltip label={hint} side="bottom" delayMs={300}>
      <span className={css.label} tabIndex={0}>{label}</span>
    </Tooltip>
  )
}

const DEFAULT_SERVER_URL = 'https://www.tokensfree.eu.cc'

const DEFAULTS: MobileBridgeValues = {
  serverUrl: DEFAULT_SERVER_URL,
  localPort: 3080,
  userKey: '',
  userKeySet: false,
  ownerEmail: '',
  emailTwoFactor: false,
  sessionDays: 7,
  autoConnect: true,
  autoReconnect: true,
  domDiagnostics: false,
}

/** Render and operate the Mobile Bridge settings page. */
export function MobileBridgeSection(props: MobileBridgeSectionProps): ReactNode {
  const { connectNow, disconnectDevice, disconnectNow, loadStatus, loadValues, saveValues, subscribeStatus, t } = props
  const [values, setValues] = useState(DEFAULTS)
  const draftValues = useRef(DEFAULTS)
  const persistedValues = useRef(DEFAULTS)
  const saveOperation = useRef<Promise<boolean> | null>(null)
  const [status, setStatus] = useState<MobileBridgeStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [qrSource, setQrSource] = useState<{ url: string; source: string } | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<MobileBridgeDevice | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [connectionAction, setConnectionAction] = useState<'connect' | 'disconnect' | null>(null)

  useEffect(() => {
    let live = true
    void Promise.all([loadValues(), loadStatus()]).then(([nextValues, nextStatus]) => {
      if (!live) return
      draftValues.current = nextValues
      persistedValues.current = nextValues
      setValues(nextValues)
      setStatus(nextStatus)
      setLoaded(true)
    }).catch((caught: unknown) => {
      console.error('[dsh-mobile-bridge] settings load failed', caught)
      if (live) setError(t('loadFailed'))
    })
    return () => { live = false }
  }, [loadStatus, loadValues, t])

  useEffect(() => {
    if (!loaded) return
    return subscribeStatus(nextStatus => {
      setStatus(nextStatus)
      setError(null)
    })
  }, [loaded, subscribeStatus])

  useEffect(() => {
    const qrUrl = status?.qrUrl ?? ''
    if (qrUrl === '') {
      setQrSource(null)
      return
    }
    let live = true
    setQrSource(null)
    void QRCode.toDataURL(qrUrl, {
      width: 360,
      margin: 4,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000ff', light: '#ffffffff' },
    }).then(source => {
      if (live) setQrSource({ url: qrUrl, source })
    }).catch((caught: unknown) => {
      console.error('[dsh-mobile-bridge] pairing QR generation failed', caught)
      if (live) setError(t('qrFailed'))
    })
    return () => { live = false }
  }, [status?.qrUrl, t])

  /** Persist the latest draft and absorb edits made while that save is in flight. */
  const commit = (): Promise<boolean> => {
    if (saveOperation.current !== null) return saveOperation.current
    if (draftValues.current === persistedValues.current) return Promise.resolve(true)

    setSaving(true)
    setMessage(t('saving'))
    setError(null)
    const operation = (async (): Promise<boolean> => {
      try {
        while (draftValues.current !== persistedValues.current) {
          const candidate = draftValues.current
          const persisted = await saveValues(candidate)
          persistedValues.current = persisted
          if (draftValues.current === candidate) {
            draftValues.current = persisted
            setValues(persisted)
          }
        }
        setMessage(t('saved'))
        return true
      } catch {
        draftValues.current = persistedValues.current
        setValues(persistedValues.current)
        setMessage(null)
        setError(t('saveFailed'))
        return false
      } finally {
        saveOperation.current = null
        setSaving(false)
      }
    })()
    saveOperation.current = operation
    return operation
  }

  const set = <K extends keyof MobileBridgeValues>(key: K, value: MobileBridgeValues[K]): void => {
    const nextValues = { ...draftValues.current, [key]: value }
    draftValues.current = nextValues
    setValues(nextValues)
    setMessage(null)
  }

  const setAndCommit = <K extends keyof MobileBridgeValues>(key: K, value: MobileBridgeValues[K]): void => {
    set(key, value)
    void commit()
  }

  const refreshStatus = async (): Promise<void> => {
    setRefreshing(true)
    setError(null)
    try {
      if (!await commit()) return
      setStatus(await loadStatus())
    } catch (caught) {
      console.error('[dsh-mobile-bridge] status refresh failed', caught)
      setError(t('statusFailed'))
    } finally {
      setRefreshing(false)
    }
  }

  /** 触发一次明确的桌面连接动作；连接结果随后由状态订阅持续投影。 */
  const toggleConnection = async (): Promise<void> => {
    const action = status?.connected === true ? 'disconnect' : 'connect'
    setConnectionAction(action)
    setMessage(null)
    setError(null)
    try {
      if (!await commit()) return
      setStatus(await (action === 'connect' ? connectNow() : disconnectNow()))
    } catch (caught) {
      console.error('[dsh-mobile-bridge] connection action failed', caught)
      setError(t('connectionActionFailed'))
    } finally {
      setConnectionAction(null)
    }
  }

  const confirmDisconnect = async (): Promise<void> => {
    if (disconnectTarget === null) return
    setDisconnecting(true)
    setMessage(null)
    setError(null)
    try {
      setStatus(await disconnectDevice(disconnectTarget.id))
      setDisconnectTarget(null)
      setMessage(t('deviceDisconnected'))
    } catch (caught) {
      console.error('[dsh-mobile-bridge] device disconnect failed', caught)
      setError(t('deviceDisconnectFailed'))
    } finally {
      setDisconnecting(false)
    }
  }

  const statusLabel = status === null ? t('loading') : status.connected ? t('connected') : t('disconnected')
  const statusState = refreshing || status === null || status.pairingRefreshing ? 'ongoing' : status.connected ? 'done' : 'warning'
  const currentQrSource = status !== null && qrSource?.url === status.qrUrl ? qrSource.source : null
  const pairingRefreshing = status !== null && (status.pairingRefreshing || (status.qrUrl !== '' && currentQrSource === null))
  const connectionBusy = connectionAction !== null || (status?.pairingRefreshing ?? false)
  const diagnosticsByDevice = new Map(status?.domDiagnostics.map(capture => [capture.deviceId, capture]) ?? [])
  const diagnosticText = (deviceId: string): string => {
    const capture = diagnosticsByDevice.get(deviceId)
    return capture === undefined
      ? t('diagnosticsWaiting')
      : `${t('diagnosticsCaptured')} ${capture.viewport.width} × ${capture.viewport.height} · ${capture.elementCount} · ${new Date(capture.capturedAt).toLocaleTimeString()}`
  }
  const connectionLabel = connectionAction === 'disconnect' ? t('disconnectingConnection') : connectionAction === 'connect' || status?.pairingRefreshing ? t('connecting') : status?.connected ? t('disconnectConnection') : t('connect')

  return (
    <section className={css.section}>
      <header className={css.header}>
        <Tooltip label={t('description')} side="bottom" delayMs={300}>
          <h2 className={css.title} tabIndex={0}>{t('title')}</h2>
        </Tooltip>
        <div className={css.toolbar}>
          <span className={css.status} role="status"><StateDot state={statusState} />{statusLabel}</span>
          <Button variant={status?.connected ? 'outline' : 'primary'} size="sm" disabled={!loaded || connectionBusy} onClick={() => { void toggleConnection() }}>{connectionLabel}</Button>
          <Button variant="outline" size="sm" disabled={refreshing || connectionAction !== null} onClick={() => { void refreshStatus() }}>{refreshing ? t('refreshing') : t('refresh')}</Button>
        </div>
      </header>

      <form className={css.form} aria-busy={saving} onSubmit={event => { event.preventDefault(); void commit() }}>
        <div className={css.fields}>
          <label className={`${css.field} ${css.fieldWide}`} htmlFor="dshmb-server-url">
            <SettingsLabel label={t('serverUrl')} hint={t('serverUrlHint')} />
            <Input id="dshmb-server-url" className={css.control} type="url" value={values.serverUrl} disabled={!loaded} onChange={event => set('serverUrl', event.currentTarget.value)} onBlur={() => { void commit() }} />
          </label>
          <label className={css.field} htmlFor="dshmb-local-port">
            <SettingsLabel label={t('localPort')} hint={t('localPortHint')} />
            <Input id="dshmb-local-port" className={css.control} type="number" min={1} step={1} value={values.localPort} disabled={!loaded} onChange={event => set('localPort', event.currentTarget.valueAsNumber)} onBlur={() => { void commit() }} />
          </label>
          <label className={css.field} htmlFor="dshmb-session-days">
            <SettingsLabel label={t('sessionDays')} hint={t('sessionDaysHint')} />
            <Input id="dshmb-session-days" className={css.control} type="number" min={1} max={365} step={1} value={values.sessionDays} disabled={!loaded} onChange={event => set('sessionDays', event.currentTarget.valueAsNumber)} onBlur={() => { void commit() }} />
          </label>
          <label className={css.field} htmlFor="dshmb-user-key">
            <SettingsLabel label={t('userKey')} hint={t('userKeyHint')} />
            <Input id="dshmb-user-key" className={css.control} type="password" value={values.userKey} placeholder={values.userKeySet ? t('userKeyConfigured') : undefined} disabled={!loaded} onChange={event => set('userKey', event.currentTarget.value)} onBlur={() => { void commit() }} />
          </label>
          <label className={`${css.field} ${css.fieldWide}`} htmlFor="dshmb-owner-email">
            <SettingsLabel label={t('ownerEmail')} hint={t('ownerEmailHint')} />
            <Input id="dshmb-owner-email" className={css.control} type="email" value={values.ownerEmail} disabled={!loaded} onChange={event => set('ownerEmail', event.currentTarget.value)} onBlur={() => { void commit() }} />
          </label>
        </div>
        <div className={css.toggles}>
          <label className={css.toggle} htmlFor="dshmb-email-two-factor">
            <input id="dshmb-email-two-factor" className={css.checkbox} type="checkbox" checked={values.emailTwoFactor} disabled={!loaded} onChange={event => setAndCommit('emailTwoFactor', event.currentTarget.checked)} />
            <span>{t('twoFactor')}</span>
          </label>
          <label className={css.toggle} htmlFor="dshmb-auto-connect">
            <input id="dshmb-auto-connect" className={css.checkbox} type="checkbox" checked={values.autoConnect} disabled={!loaded} onChange={event => setAndCommit('autoConnect', event.currentTarget.checked)} />
            <span>{t('autoConnect')}</span>
          </label>
          <label className={css.toggle} htmlFor="dshmb-auto-reconnect">
            <input id="dshmb-auto-reconnect" className={css.checkbox} type="checkbox" checked={values.autoReconnect} disabled={!loaded} onChange={event => setAndCommit('autoReconnect', event.currentTarget.checked)} />
            <span>{t('autoReconnect')}</span>
          </label>
          <label className={css.toggle} htmlFor="dshmb-dom-diagnostics">
            <input id="dshmb-dom-diagnostics" className={css.checkbox} type="checkbox" checked={values.domDiagnostics} disabled={!loaded} onChange={event => setAndCommit('domDiagnostics', event.currentTarget.checked)} />
            <span>{t('domDiagnostics')}</span>
          </label>
        </div>
        {message !== null ? <p className={css.message} role="status">{message}</p> : null}
      </form>

      <div className={css.pairing}>
        {pairingRefreshing
          ? (
              <>
                <SettingsLabel label={t('pair')} hint={t('pairHint')} />
                <div className={css.qrRefreshing} role="status">
                  <span className={css.qrSpinner} aria-hidden="true" />
                  <span>{t('pairingRefreshing')}</span>
                </div>
              </>
            )
          : currentQrSource === null
            ? (
                <>
                  <SettingsLabel label={t('pair')} hint={t('pairHint')} />
                  <span className={css.qrEmpty}>{t('qrUnavailable')}</span>
                </>
              )
            : (
                <div className={css.pairingDisplay}>
                  <div className={css.pairingQrBlock}>
                    <SettingsLabel label={t('pair')} hint={t('pairHint')} />
                    <img className={css.qr} src={currentQrSource} alt={t('qrAlt')} width={240} height={240} />
                  </div>
                  <div className={css.pairingCodeBlock}>
                    <span className={css.label}>{t('pairingCode')}</span>
                    <output className={css.pairingCode} aria-label={t('pairingCode')}>
                      {status?.pairingCode.toUpperCase().split('').map((character, index) => <span key={index}>{character}</span>)}
                    </output>
                  </div>
                </div>
              )}
      </div>

      <div className={css.devices}>
        <div className={css.devicesHeader}>
          <SettingsLabel label={t('devices')} hint={t('devicesHint')} />
          <span className={css.deviceCount}>{status?.devices.length ?? 0}</span>
        </div>
        {status !== null && status.devices.length > 0
          ? (
              <ul className={css.deviceList}>
                {status.devices.map(device => (
                  <li className={css.deviceRow} key={device.id}>
                    <span className={css.deviceState}><StateDot state={device.online ? 'done' : 'warning'} />{device.online ? t('online') : t('offline')}</span>
                    <strong className={css.deviceName}>{device.name}</strong>
                    <span className={css.deviceMeta}>IP {device.ip}</span>
                    <span className={css.deviceTimes}>
                      <span>{t('pairedAt')} {new Date(device.pairedAt).toLocaleString()}</span>
                      <span>{t('lastSeen')} {new Date(device.lastSeenAt).toLocaleString()}</span>
                      {status.domDiagnosticsEnabled ? <span>{diagnosticText(device.id)}</span> : null}
                    </span>
                    <Button variant="outline" size="sm" icon={<IconStopFillRegular size={14} />} className={css.disconnectButton} onClick={() => { setDisconnectTarget(device) }}>
                      {t('disconnect')}
                    </Button>
                  </li>
                ))}
              </ul>
            )
          : <p className={css.deviceEmpty}>{t('noDevices')}</p>}
      </div>

      {error !== null ? <p className={css.error} role="alert">{error}</p> : null}
      <Modal
        open={disconnectTarget !== null}
        onClose={() => { if (!disconnecting) setDisconnectTarget(null) }}
        title={t('disconnectTitle')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="outline" disabled={disconnecting} onClick={() => { setDisconnectTarget(null) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={disconnecting} onClick={() => { void confirmDisconnect() }}>{disconnecting ? t('disconnecting') : t('confirmDisconnect')}</Button>
          </>
        )}
      >
        <p className={css.disconnectDescription}>{t('disconnectDescription')}</p>
      </Modal>
    </section>
  )
}
