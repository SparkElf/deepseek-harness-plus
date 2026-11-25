/** Browser half: mobile stylesheet lifecycle plus the first-class Settings section. */

import type {} from './contract.ts'
import { MobileBridgeSection } from './MobileBridgeSection.tsx'
import { RevokedDeviceModal } from './RevokedDeviceModal.tsx'
import type { MobileBridgeSectionInjected, MobileBridgeStatus, MobileBridgeValues } from './MobileBridgeSection.tsx'
import type { MobileBridgeClientContext } from './context.ts'
import { installMobileDomDiagnostics } from './dom-diagnostics.ts'
import { en, zh } from './locales.ts'

const LOCALE_NS = 'settingsMobileBridge' as const
const SETTINGS_NS = 'mobile-bridge'
const DEFAULT_SERVER_URL = 'https://www.tokensfree.eu.cc'

/** 浏览器保存前把历史 `/bridge` 输入收敛为Host使用的中继基址。 */
function normalizeServerUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, '')
  return trimmed.endsWith('/bridge') ? trimmed.slice(0, -'/bridge'.length) : trimmed
}

interface SettingsDescription {
  namespaces: Array<{
    ns: string
    value: Omit<MobileBridgeValues, 'userKey' | 'userKeySet'>
    secrets: Array<{ path: string[]; set: boolean }>
  }>
}

type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string } }

interface RpcResponse<T> {
  result: RpcResult<T>
}

/** Execute one typed Host RPC over the public browser carrier. */
async function rpc<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
  })
  if (!response.ok) throw new Error(`RPC ${method} failed with HTTP ${response.status}`)
  const body = await response.json() as RpcResponse<T>
  if (!body.result.ok) {
    const failed = body.result as { error?: { message?: string } }
    throw new Error(failed.error?.message ?? `RPC ${method} failed`)
  }
  return body.result.value
}

/** Services required by the browser plugin fiber. */
export const inject = ['slots', 'locale']

/** Register all browser contributions owned by Mobile Bridge. */
export function apply(ctx: MobileBridgeClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-mobile-bridge: dictionaries')

  ctx.effect(() => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/mobile/bridge/style.css'
    link.dataset.plugin = '@sparkelf/dsh-mobile-bridge'
    document.head.appendChild(link)
    return () => { link.remove() }
  }, 'dsh-mobile-bridge: narrow-screen stylesheet')

  const operations: MobileBridgeSectionInjected = {
    // Values come from the settings service when it is composed, and from the bridge's own config
    // endpoint when it is not.
    //
    // A runtime without config-editor/profileContext disables the settings service, so every
    // namespace fails to register; reading only through it left this page showing
    // "读取移动连接配置失败" and no QR code while the tunnel was actually connected. The config
    // endpoint reports what the bridge is really running with, so the page renders either way.
    loadValues: async () => {
      try {
        const value = await rpc<SettingsDescription>('settings/describe', {})
        const row = value.namespaces.find(candidate => candidate.ns === SETTINGS_NS)
        if (row === undefined) throw new Error('mobile-bridge settings namespace is unavailable')
        const userKeySet = row.secrets.some(secret => secret.set && secret.path.length === 1 && secret.path[0] === 'userKey')
        return {
          serverUrl: normalizeServerUrl(row.value.serverUrl),
          localPort: row.value.localPort,
          userKey: '',
          userKeySet,
          ownerEmail: row.value.ownerEmail,
          emailTwoFactor: row.value.emailTwoFactor,
          sessionDays: row.value.sessionDays,
          autoConnect: row.value.autoConnect,
          autoReconnect: row.value.autoReconnect,
          domDiagnostics: row.value.domDiagnostics,
        }
      } catch (settingsError) {
        const response = await fetch('/mobile/bridge/config')
        if (!response.ok) throw settingsError
        const row = await response.json() as {
          serverUrl: string; localPort: number; ownerEmail: string; emailTwoFactor: boolean
          sessionDays: number; autoConnect: boolean; autoReconnect: boolean
          domDiagnostics: boolean; userKeySet: boolean
        }
        return {
          serverUrl: normalizeServerUrl(row.serverUrl),
          localPort: row.localPort,
          userKey: '',
          userKeySet: row.userKeySet,
          ownerEmail: row.ownerEmail,
          emailTwoFactor: row.emailTwoFactor,
          sessionDays: row.sessionDays,
          autoConnect: row.autoConnect,
          autoReconnect: row.autoReconnect,
          domDiagnostics: row.domDiagnostics,
        }
      }
    },
    saveValues: async values => {
      const { userKey, userKeySet, ...publicValues } = values
      const persisted = { ...publicValues, serverUrl: normalizeServerUrl(values.serverUrl) }
      try {
        await rpc('settings/update', {
          ns: SETTINGS_NS,
          patch: { ...persisted, ...userKey === '' ? {} : { userKey } },
        })
      } catch {
        // Without the settings service the same edits still have to reach the running bridge.
        const response = await fetch('/mobile/bridge/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...persisted, ...userKey === '' ? {} : { userKey } }),
        })
        if (!response.ok) throw new Error('mobile-bridge config save failed with HTTP ' + String(response.status))
      }
      return { ...persisted, userKey: '', userKeySet: userKeySet || userKey !== '' }
    },
    loadStatus: async () => {
      const response = await fetch('/mobile/bridge/status')
      if (!response.ok) throw new Error(`Mobile Bridge status failed with HTTP ${response.status}`)
      return await response.json() as MobileBridgeStatus
    },
    subscribeStatus: listener => {
      const source = new EventSource('/mobile/bridge/events')
      source.onmessage = event => {
        try {
          listener(JSON.parse(event.data) as MobileBridgeStatus)
        } catch (error) {
          console.error('[dsh-mobile-bridge] live status event failed', error)
        }
      }
      return () => { source.close() }
    },
    disconnectDevice: async deviceId => {
      const response = await fetch('/mobile/bridge/devices/' + encodeURIComponent(deviceId), { method: 'DELETE' })
      if (!response.ok) throw new Error(`Mobile Bridge device disconnect failed with HTTP ${response.status}: ${await response.text()}`)
      return await response.json() as MobileBridgeStatus
    },
    connectNow: async () => {
      const response = await fetch('/mobile/bridge/connect', { method: 'POST' })
      if (!response.ok) throw new Error(`Mobile Bridge connect failed with HTTP ${response.status}: ${await response.text()}`)
      return await response.json() as MobileBridgeStatus
    },
    disconnectNow: async () => {
      const response = await fetch('/mobile/bridge/disconnect', { method: 'POST' })
      if (!response.ok) throw new Error(`Mobile Bridge disconnect failed with HTTP ${response.status}: ${await response.text()}`)
      return await response.json() as MobileBridgeStatus
    },
  }

  ctx.effect(() => {
    let disposed = false
    let release = (): void => {}
    void installMobileDomDiagnostics(operations.subscribeStatus).then(next => {
      if (disposed) next()
      else release = next
    }).catch(error => { console.info('[dsh-mobile-bridge] mobile DOM diagnostics unavailable', error) })
    return () => {
      disposed = true
      release()
    }
  }, 'dsh-mobile-bridge: paired phone DOM diagnostics')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'mobile-bridge-revoked',
    order: 100,
    locale: LOCALE_NS,
  }, RevokedDeviceModal))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mobile-bridge',
    order: 40,
    label: () => ctx.locale.bind(LOCALE_NS)('nav'),
    locale: LOCALE_NS,
    inject: () => operations,
  }, MobileBridgeSection))
}
