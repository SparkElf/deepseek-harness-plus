/**
 * The custom `dataops-resources` sidebar tab.
 *
 * It renders the DataOps embed page in a same-origin iframe. The iframe is deliberately not
 * a generic URL tab: the generic tab sandbox is an opaque origin and cannot use the portal's
 * sessionStorage. The only parent-child messages are navigation and "add to conversation";
 * every authorization decision still happens in DataOps.
 *
 * @module client/DataOpsResourcesTab
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ResourceCatalogSidebar, type ResourceFilter } from './ResourceCatalogSidebar.tsx'

/** Minimal view of the tab record carried by Better Sidebar. */
export interface ResourceTabRecord {
  meta?: unknown
  title?: string
}

/** Props Better Sidebar passes to a tab component (the fields this tab needs). */
export interface DataOpsResourcesTabProps {
  ctx?: unknown
  scope?: { sessionId?: string }
  tab: ResourceTabRecord
  visible?: boolean
  insertResourceReference?: (
    resource: { id?: unknown; name?: unknown; table?: unknown },
    reference: Record<string, unknown>,
    sessionId?: string,
  ) => void
}

interface ResourceTabConfig {
  embedBaseUrl: string
  sameOrigin: boolean
  tabType?: string
  /** Same-origin deployments receive the workspace JWT so the embed page starts signed in. */
  token?: string
}

interface ResourceTabMeta {
  resourceId?: number
  resourceName?: string
  mode?: string
  nonce?: string
}

const readMeta = (value: unknown): ResourceTabMeta => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  return {
    resourceId: typeof record.resourceId === 'number' && Number.isSafeInteger(record.resourceId)
      ? record.resourceId
      : undefined,
    resourceName: typeof record.resourceName === 'string' ? record.resourceName : undefined,
    mode: typeof record.mode === 'string' ? record.mode : undefined,
    nonce: typeof record.nonce === 'string' ? record.nonce : undefined,
  }
}

/** Host color scheme. */
type HostTheme = 'dark' | 'light'

/**
 * 读 DSH 当前明暗。不同 DSH 版本/主题实现落点不同，按优先级兜底：
 * 1. `html.dark`（部分版本只切根节点 class）；
 * 2. `html[data-theme="dark"]`；
 * 3. `body[data-ds-dark-theme]`（0.2.4 的官方 boot-theme 落点）。
 * 不能只看 body 属性：版本只切 html class 时 body 会一直保留首屏值。
 */
const readHostTheme = (): HostTheme => {
  const root = document.documentElement
  if (root.classList.contains('dark')) return 'dark'
  if (root.dataset.theme === 'dark') return 'dark'
  return document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
}

/**
 * 门户 origin 归一化：同源代理部署（DSH 挂在门户路径前缀下，如 `/dsh/`）里，host config
 * 可能仍返回本机开发 origin（如 `http://127.0.0.1:3000`）。iframe 必须落在**当前门户
 * origin** 上，否则跨 origin 拿不到 sessionStorage token，页面会卡在「正在恢复会话」。
 *
 * 只在「DSH 页面不在根路径」且 base 是 loopback、与当前 origin 不同时改写；直连部署
 * （DSH 在 `/` 或独立 origin）保持原 base，不影响本地 3000/32000 的分origin模式。
 */
const normalizeEmbedBase = (configured: string, sameOrigin: boolean): { base: string; sameOrigin: boolean } => {
  try {
    const base = new URL(configured, window.location.origin)
    const page = window.location
    const isLoopback = base.hostname === '127.0.0.1' || base.hostname === 'localhost'
    const isPrivate = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/u.test(base.hostname)
    const underProxyPrefix = page.pathname !== '/' && !/^\/(?:index\.html)?$/u.test(page.pathname)
    // 同一个部署换网后，host config 可能仍返回旧私网 IP；只要在 /dsh 代理下，就改写到当前门户 origin。
    if (underProxyPrefix && base.origin !== page.origin && (isLoopback || isPrivate)) {
      return { base: page.origin, sameOrigin: true }
    }
    return { base: configured, sameOrigin }
  } catch {
    return { base: configured, sameOrigin }
  }
}

const buildEmbedUrl = (config: ResourceTabConfig, meta: ResourceTabMeta, theme: HostTheme): string => {
  const base = config.embedBaseUrl.replace(/\/+$/u, '')
  // The workspace JWT travels in the fragment: a URL hash is never sent to the server and does
  // not appear in access logs. The embed page consumes it before its first request, stores it
  // in sessionStorage and strips the hash (frontend DataOpsResourcesEmbedPage/DetailPage).
  const hash = config.token === undefined ? '' : '#accessToken=' + encodeURIComponent(config.token)
  // `/assets?assetTab=resources` is the portal's full resource page: its own catalog tree,
  // search/view switch, pagination and the product card (checkbox, icon, 已启用, tag chips,
  // icon group). It is embedded whole — no extra chrome is added around it.
  if (meta.resourceId !== undefined && (meta.mode === 'detail' || meta.mode === 'audit')) {
    const params = new URLSearchParams({ assetTab: 'resources', prototype: 'resource-detail', resourceId: String(meta.resourceId), embed: '1', theme })
    if (meta.mode === 'audit') params.set('tab', 'audit')
    return `${base}/assets?${params.toString()}${hash}`
  }
  return `${base}/assets?assetTab=resources&embed=1&theme=${theme}${hash}`
}

const frameStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  border: '0',
  display: 'block',
  background: 'var(--dsh-sidebar-bg, #f6f7f9)',
}

const stateStyle: CSSProperties = {
  padding: '24px 16px',
  fontSize: '12px',
  color: 'var(--dsh-text-secondary, #6b7280)',
  textAlign: 'center',
}

const noticeStyle: CSSProperties = {
  margin: '0 10px 8px',
  padding: '7px 10px',
  borderRadius: '7px',
  background: 'rgba(22, 163, 74, 0.10)',
  color: '#15803d',
  fontSize: '11px',
}

/** Render the embedded DataOps resource page and translate its parent messages. */
export function DataOpsResourcesTab({ tab, scope, insertResourceReference }: DataOpsResourcesTabProps) {
  const [config, setConfig] = useState<ResourceTabConfig | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [filter, setFilter] = useState<ResourceFilter>({ scope: 'all' })
  // Captured once per mount: the URL carries the initial palette, later switches arrive as
  // messages so a theme change never remounts (and reloads) the frame.
  const [theme] = useState<HostTheme>(readHostTheme)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const meta = readMeta(tab.meta)
  const src = useMemo(() => config === null ? '' : buildEmbedUrl(config, meta, theme), [config, meta.resourceId, meta.mode, meta.nonce, theme, reloadKey])

  useEffect(() => {
    let live = true
    const load = async (): Promise<void> => {
      try {
        const response = await fetch('integrations/dataops/resource-tab/config', { cache: 'no-store' })
        if (!response.ok) throw new Error('HTTP ' + response.status.toString())
        const body = await response.json() as ResourceTabConfig
        if (!live) return
        // 凭据来源顺序固定：host config token → （仅同源代理）DSH sessionStorage → 报错。
        // 回退只用同一份 DataOps JWT，不引入第二种凭据；独立 origin 模式 host 一定带 token，
        // 所以 sessionStorage 回退加了 sameOrigin 守卫，避免以后被误用。
        const sameOrigin = body.sameOrigin === true
        const hostToken = typeof body.token === 'string' && body.token !== '' ? body.token : undefined
        let sessionToken: string | undefined
        if (hostToken === undefined && sameOrigin) {
          try {
            const stored = window.sessionStorage.getItem('dataops_auth_token')
            if (stored !== null && stored !== '') sessionToken = stored
          } catch { /* private mode */ }
        }
        const token = hostToken ?? sessionToken
        if (token === undefined) {
          throw new Error('缺少 DataOps 登录凭证，请重新登录工作区')
        }
        const normalized = normalizeEmbedBase(body.embedBaseUrl, sameOrigin)
        const next: ResourceTabConfig = {
          embedBaseUrl: normalized.base,
          sameOrigin: normalized.sameOrigin,
          tabType: body.tabType,
          token,
        }
        // Same-origin embeds share this origin's sessionStorage, so seeding the portal's own
        // token key makes the iframe open already authenticated instead of showing its login page.
        if (next.sameOrigin && next.token !== undefined) {
          try { window.sessionStorage.setItem('dataops_auth_token', next.token) } catch { /* private mode */ }
        }
        setConfig(next)
      } catch (loadError) {
        if (!live) return
        setError('资源页配置加载失败：' + (loadError instanceof Error ? loadError.message : String(loadError)))
      }
    }
    void load()
    return () => { live = false }
  }, [])

  useEffect(() => {
    setLoading(true)
  }, [src, reloadKey])

  useEffect(() => {
    if (config === null) return undefined
    let expectedOrigin = ''
    try { expectedOrigin = new URL(config.embedBaseUrl).origin } catch { expectedOrigin = '' }
    const onMessage = (event: MessageEvent): void => {
      // Only the frame this tab owns may ask for an insertion; origin alone is not proof.
      if (event.source !== iframeRef.current?.contentWindow) return
      if (expectedOrigin && event.origin !== expectedOrigin) return
      const payload = event.data as {
        source?: string
        type?: string
        reference?: Record<string, unknown>
        resource?: Record<string, unknown>
      } | null
      const legacy = payload?.type === 'dataops:add-to-conversation'
      const embed = payload?.source === 'dataops-embed' && payload?.type === 'add-to-conversation'
      if (!legacy && !embed) return
      const resource = payload?.resource ?? {}
      const reference = payload?.reference ?? {
        kind: 'dataops-resource',
        resourceId: resource.id,
        name: resource.name,
        table: resource.table ?? resource.sourceTable ?? null,
      }
      if (insertResourceReference === undefined) {
        setNotice('当前会话不可用，无法插入资源引用')
        return
      }
      try {
        insertResourceReference(resource, reference, scope?.sessionId)
        setNotice('已添加到对话')
      } catch (insertError: unknown) {
        setNotice('插入引用失败：' + (insertError instanceof Error ? insertError.message : String(insertError)))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [config, insertResourceReference, scope?.sessionId])

  // The host build that ships this plugin may predate the optional `resource`
  // ReferenceIconKind patch. Add the database glyph only when the chip has no
  // host-rendered SVG; a patched host wins and this rule becomes a no-op.
  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.dataopsResourceChipIcon = 'true'
    style.textContent = `
      [data-composer-chip="dataops-resource"]:not(:has(svg)) > span:last-child::before {
        content: "";
        display: inline-block;
        width: 14px;
        height: 14px;
        margin-right: 5px;
        vertical-align: -2px;
        background: currentColor;
        -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z'/%3E%3Cpath d='m3.3 7 8.7 5 8.7-5'/%3E%3Cpath d='M12 22V12'/%3E%3C/svg%3E") center / contain no-repeat;
        mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z'/%3E%3Cpath d='m3.3 7 8.7 5 8.7-5'/%3E%3Cpath d='M12 22V12'/%3E%3C/svg%3E") center / contain no-repeat;
      }
    `
    document.head.appendChild(style)
    return () => style.remove()
  }, [])

  const postFilter = useCallback((): void => {
    const frame = iframeRef.current?.contentWindow
    if (!frame) return
    // The portal page understands the existing favorites/pinned/catalog/all shapes only. A
    // folder node is resolved to its recursive resource ids through the Host bridge and sent
    // with the ids shape, so no portal change is needed and the iframe never reloads.
    const payload = filter.scope === 'catalogNode'
      ? { scope: 'favorites', ids: filter.ids ?? [] }
      : filter
    frame.postMessage({ source: 'dsh-host', type: 'filter', ...payload }, '*')
  }, [filter])

  const postTheme = useCallback((value: HostTheme): void => {
    iframeRef.current?.contentWindow?.postMessage(
      { source: 'dsh-host', type: 'dataops-theme', theme: value },
      '*',
    )
  }, [])

  // DSH switches palette by changing document-level marks (`html.dark`, `data-theme`, or
  // `body[data-ds-dark-theme]` depending on version). The portal iframe is a separate document,
  // so mirror the resolved value into a message: the URL parameter covers the first load and
  // these observers cover every switch after it, without reloading the frame.
  // 必须同时观察 documentElement 的 class/theme 和 body 属性：只看 body 会在只切 html 的
  // 版本上永远不触发。
  useEffect(() => {
    let current = readHostTheme()
    const check = (): void => {
      const next = readHostTheme()
      if (next === current) return
      current = next
      postTheme(next)
    }
    const rootObserver = new MutationObserver(check)
    rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    const bodyObserver = new MutationObserver(check)
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => {
      rootObserver.disconnect()
      bodyObserver.disconnect()
    }
  }, [postTheme])

  useEffect(() => { postFilter() }, [postFilter])
  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(''), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])

  if (error) {
    return (
      <div style={stateStyle} role="alert">
        {error}
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>重试</button>
        </div>
      </div>
    )
  }

  if (config === null) {
    return <div style={stateStyle} role="status">正在准备数据资源页…</div>
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <ResourceCatalogSidebar onFilter={setFilter} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {notice ? <div style={noticeStyle} role="status">{notice}</div> : null}
        {loading ? <div style={stateStyle} role="status">正在加载数据资源页…</div> : null}
        <iframe
          ref={iframeRef}
          key={`${src}:${reloadKey}`}
          src={src}
          title={meta.resourceName ? `${meta.resourceName} · 数据资源` : '数据资源'}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
          referrerPolicy="no-referrer"
          style={{ ...frameStyle, display: loading ? 'none' : 'block' }}
          onLoad={() => { setLoading(false); postFilter(); postTheme(readHostTheme()) }}
          onError={() => {
            setLoading(false)
            setError('数据资源页加载失败')
          }}
        />
      </div>
    </div>
  )
}