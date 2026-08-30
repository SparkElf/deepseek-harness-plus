import type { DataOpsKey } from './locales.ts'
import type { DataOpsActions, DataOpsStatus } from './store.ts'

const STATUS_PATH = '/integrations/dataops/status'
const CONNECT_PATH = '/integrations/dataops/connect'
const DISCONNECT_PATH = '/integrations/dataops/disconnect'
const OAUTH_EVENT_TYPE = 'dsh:dataops-oauth'

function browserHostUrl(path: string): string {
  return new URL(path.replace(/^[/]/u, ''), document.baseURI).toString()
}

async function readStatus(): Promise<DataOpsStatus> {
  const response = await fetch(browserHostUrl(STATUS_PATH), { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return response.json() as Promise<DataOpsStatus>
}

function oauthFailureKey(reason: unknown): DataOpsKey {
  switch (reason) {
    case 'pending-state': return 'authorizationExpired'
    case 'missing-code': return 'authorizationResponseInvalid'
    case 'token-request-rejected': return 'tokenRequestRejected'
    case 'token-account-rejected': return 'tokenAccountRejected'
    case 'token-service-failed': return 'tokenServiceFailed'
    case 'token-response-invalid': return 'tokenResponseInvalid'
    case 'account-verification': return 'accountVerificationFailed'
    case 'authorization-activation': return 'authorizationActivationFailed'
    default: return 'connectFailed'
  }
}

/** Own browser status refresh, OAuth popup handoff, and expiry notification timing. */
export class DataOpsController {
  private actions!: DataOpsActions
  private authorizationPopup: Window | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Attach the root-scoped store actions supplied by a slot registration.
   * @param actions - Bound writes for the shared DataOps Client store.
   */
  attach(actions: DataOpsActions): void {
    this.actions = actions
  }

  private writes(): DataOpsActions {
    return this.actions
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer === undefined) return
    clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
  }

  private scheduleExpiry(status: DataOpsStatus): void {
    this.clearExpiryTimer()
    if (!status.authorizationAccepted || status.expiresAt === null) return
    const delay = status.expiresAt - Date.now()
    if (delay <= 0) return
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined
      void this.load()
    }, delay)
  }

  /**
   * Refresh the authoritative Host projection and schedule its known expiry.
   * @returns A promise settled after the shared status reflects the response.
   */
  async load(): Promise<void> {
    const actions = this.writes()
    actions.beginLoad()
    try {
      const status = await readStatus()
      actions.setStatus(status)
      this.scheduleExpiry(status)
    } catch (error) {
      console.error('mcp-dataops: status request failed', error)
      actions.setFailure('connectionFailed')
    }
  }

  /**
   * Start the always-mounted browser lifecycle.
   * @returns A disposer for browser listeners, popup ownership, and expiry timing.
   */
  start(): () => void {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin || event.source !== this.authorizationPopup) return
      const data = event.data as { type?: unknown; result?: unknown; reason?: unknown } | null
      if (data?.type !== OAUTH_EVENT_TYPE) return
      this.authorizationPopup = null
      if (data.result === 'connected') {
        void this.load()
      } else if (data.result !== 'cancelled') {
        this.writes().setFailure(oauthFailureKey(data.reason))
      }
    }
    const onFocus = (): void => { void this.load() }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void this.load()
    }
    window.addEventListener('message', onMessage)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    void this.load()
    return () => {
      this.clearExpiryTimer()
      window.removeEventListener('message', onMessage)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      this.authorizationPopup?.close()
      this.authorizationPopup = null
    }
  }

  /** Open the real DataOps authorization handoff from a user gesture. */
  openAuthorization(): void {
    const actions = this.writes()
    actions.clearFailure()
    const connectUrl = new URL(browserHostUrl(CONNECT_PATH))
    connectUrl.searchParams.set('origin', window.location.origin)
    this.authorizationPopup = window.open(
      connectUrl.toString(),
      'dsh-dataops-authorization',
      'popup,width=720,height=760',
    )
    if (this.authorizationPopup === null) actions.setFailure('popupBlocked')
  }

  /**
   * Revoke the current grant and refresh shared state.
   * @returns Whether the disconnect completed and Settings may collapse confirmation.
   */
  async disconnect(): Promise<boolean> {
    const actions = this.writes()
    actions.setDisconnecting(true)
    actions.clearFailure()
    try {
      const response = await fetch(browserHostUrl(DISCONNECT_PATH), { method: 'POST' })
      if (!response.ok) throw new Error(`DataOps disconnect failed with HTTP ${String(response.status)}`)
      await this.load()
      return true
    } catch (error) {
      console.error('mcp-dataops: disconnect request failed', error)
      actions.setFailure('disconnectFailed')
      return false
    } finally {
      actions.setDisconnecting(false)
    }
  }
}
