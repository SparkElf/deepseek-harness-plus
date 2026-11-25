/**
 * Sandboxed cockpit viewer.
 *
 * The iframe is served by the plugin's render route and runs with
 * `sandbox="allow-scripts allow-same-origin"` (opaque origin). The workspace token reaches it only
 * through postMessage, and only after this parent verified the message source.
 *
 * @module client/CockpitViewer
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'

/** Addresses resolved from the host config route. */
interface ViewerConfig {
  renderBaseUrl: string
  gatewayBaseUrl: string
  dataopsWebBaseUrl: string
}

/** Message the runtime posts to its parent. */
interface RuntimeMessage {
  source?: string
  type?: string
  resourceRef?: string
}

/**
 * Render routes are served by this DSH host, so the iframe must stay on the same origin.
 * A stale absolute base (`http://localhost:<port>/dsh-artifact-app/render` behind a proxy)
 * would point the frame at a port the browser cannot reach; keep only the pathname.
 */
const renderBase = (value: string): string => {
  try {
    const base = new URL(value, window.location.origin)
    return base.pathname.replace(/\/+$/u, '')
  } catch {
    return value.replace(/\/+$/u, '')
  }
}

const frameStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  // 宿主侧栏的 tab 容器不一定是可伸展的 flex 父级，只写 height:100% 会被压到 ~140px
  // （实测 clientHeight=142，画布被裁成一条）。给一个下限，让驾驶舱在任何容器里都能看。
  minHeight: '520px',
  border: '0',
  display: 'block',
  background: '#060a14',
}

/** How long a 401 waits for the parent to push a refreshed token before surfacing. */
const TOKEN_REFRESH_WAIT_MS = 5000

/**
 * Render one cockpit in a sandboxed iframe and keep its bootstrap config fed.
 * @param props.artifactId - cockpit (or preview draft) id.
 * @param props.refreshKey - changing it reloads the iframe, used by "updated" events.
 * @param props.reloadToken - bump from outside to force a reload.
 */
export function CockpitViewer({ artifactId, reloadToken }: { artifactId: string; reloadToken?: number }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  /** iframe 加载完成后重发一次引导配置：`hello` 可能在监听器挂上之前就发出去了。 */
  const resendRef = useRef<(() => void) | null>(null)
  /** `ready` 回执：收到前持续补发 config，覆盖「hello 早于监听器」的竞态。 */
  const ackRef = useRef(false)
  const refreshInFlightRef = useRef(false)
  const [config, setConfig] = useState<ViewerConfig | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [configResponse, tokenResponse] = await Promise.all([
          fetch('/dsh-artifact-app/config', { headers: { accept: 'application/json' } }),
          fetch('/dsh-artifact-app/token', { headers: { accept: 'application/json' } }),
        ])
        const configPayload = await configResponse.json() as ViewerConfig & { error?: string }
        const tokenPayload = await tokenResponse.json() as { token?: string; error?: string }
        if (!configResponse.ok) throw new Error(configPayload.error ?? '读取驾驶舱配置失败')
        if (!tokenResponse.ok || typeof tokenPayload.token !== 'string' || tokenPayload.token.trim() === '') throw new Error(tokenPayload.error ?? '读取 DataOps 登录凭证失败')
        if (alive) {
          setConfig(configPayload)
          setToken(tokenPayload.token)
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (config === null || token === null) return undefined
    /** 把引导配置推给 iframe；`hello`、`ready` 与 iframe 的 load 事件都会触发它。 */
    const sendConfig = (tokenOverride?: string): void => {
      const effectiveToken = tokenOverride ?? token
      if (effectiveToken === null || effectiveToken === '') return
      frameRef.current?.contentWindow?.postMessage({
        source: 'dataops-artifact-host',
        type: 'config',
        payload: {
          artifactId,
          token: effectiveToken,
          gatewayBaseUrl: config.gatewayBaseUrl,
          refreshIntervalSeconds: 300,
          keepConnection: false,
          locale: 'zh-CN',
          theme: 'dark',
        },
      }, '*')
    }
    /**
     * 401 后重新拉凭证并**直接补发** config。
     * 不能只靠 setToken：刷新拿到的 token 可能与 state 相同（凭据没变），
     * 那样 effect 不会重跑，运行时的 waitForNewConfig 会空等到超时。
     */
    const refreshAndResend = (): void => {
      if (refreshInFlightRef.current) return
      refreshInFlightRef.current = true
      void (async () => {
        try {
          const response = await fetch('/dsh-artifact-app/token', { headers: { accept: 'application/json' }, cache: 'no-store' })
          const payload = await response.json() as { token?: string; error?: string }
          if (!response.ok || typeof payload.token !== 'string' || payload.token.trim() === '') {
            throw new Error(payload.error ?? '读取 DataOps 登录凭证失败')
          }
          setToken(payload.token)
          console.info('[artifact-app] token refreshed; resending config')
          sendConfig(payload.token)
        } catch (cause) {
          console.error('[artifact-app] token refresh failed', cause)
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          refreshInFlightRef.current = false
        }
      })()
    }
    /**
     * 判断消息是否来自本 tab 的 iframe。
     *
     * Chrome 对 sandbox iframe 的 `event.source` 与 `iframe.contentWindow` 实测可能
     * 不是同一个代理对象（严格相等为 false），只靠身份比较会把 ready/token:expired 全丢掉。
     * 依次尝试：同窗口代理 → frameElement 归属 → 同源兜底。
     */
    const fromOwnedFrame = (event: MessageEvent): boolean => {
      const frame = frameRef.current
      if (frame === null || event.source === null) return false
      if (event.source === frame.contentWindow) return true
      try {
        if ((event.source as Window).frameElement === frame) return true
      } catch { /* 跨源时 frameElement 不可读 */ }
      return event.origin === window.location.origin
    }
    const onMessage = (event: MessageEvent): void => {
      if (!fromOwnedFrame(event)) return
      const data = event.data as RuntimeMessage | null
      if (data === null || typeof data !== 'object' || data.source !== 'dataops-artifact-app') return
      if (data.type === 'request-access') {
        const target = config.dataopsWebBaseUrl.replace(/\/+$/u, '')
        window.open(target, '_blank', 'noopener,noreferrer')
        return
      }
      if (data.type === 'ready') {
        ackRef.current = true
        sendConfig()
        return
      }
      if (data.type === 'hello') {
        sendConfig()
        return
      }
      if (data.type === 'token:expired') {
        // 父侧重新拉一次凭证并直接补发 config；运行时收到新 token 后会重试刚才失败的那次查询。
        console.info('[artifact-app] token:expired received; refreshing token')
        refreshAndResend()
        return
      }
    }
    resendRef.current = sendConfig
    window.addEventListener('message', onMessage)
    // 主动下发一次，并在收到 ready 回执前补发几次：iframe 的 hello 可能早于本监听器，
    // 只依赖 hello/ready 会让首条查询在 token 还没落地时发出。
    ackRef.current = false
    sendConfig()
    const retryTimers = [300, 900, 1800].map((delay) => window.setTimeout(() => {
      if (!ackRef.current) sendConfig()
    }, delay))
    return () => {
      retryTimers.forEach((timer) => window.clearTimeout(timer))
      resendRef.current = null
      window.removeEventListener('message', onMessage)
    }
  }, [artifactId, config, token])

  if (error !== null) {
    return <div role="alert" style={{ padding: 18, color: '#b91c1c', fontSize: 12 }}>{error}</div>
  }
  if (config === null) {
    return <div style={{ padding: 18, color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: 12 }}>正在准备驾驶舱…</div>
  }
  if (token === null) {
    return <div style={{ padding: 18, color: 'var(--dsw-alias-label-secondary, #6b7280)', fontSize: 12 }}>正在获取凭据…</div>
  }
  const src = renderBase(config.renderBaseUrl) + '/' + encodeURIComponent(artifactId) + (reloadToken === undefined ? '' : '?r=' + String(reloadToken))
  return (
    <iframe
      ref={frameRef}
      title="驾驶舱"
      src={src}
      sandbox="allow-scripts allow-same-origin"
      allow="fullscreen"
      onLoad={() => resendRef.current?.()}
      style={frameStyle}
      data-artifact-viewer={artifactId}
    />
  )
}