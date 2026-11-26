/**
 * External cockpit registry pane in the right-sidebar "驾驶舱" tab.
 *
 * M1 discovery and stable links are proxied by this plugin's host; M2 adds a
 * site-scoped credential picker, a one-shot Host login, and a screenshot viewer.
 * The browser never receives a secret or storage state, and external pages never
 * enter the cockpit iframe.
 *
 * @module client/ExternalCockpitPanel
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react'

/** Sanitized registry row returned by the host proxy. */
export interface ExternalCockpitItem {
  id: string
  name: string
  description: string | null
  url: string | null
  icon: string | null
  tags: string[]
  ownerId: string | null
  visibility: 'PRIVATE' | 'DEPARTMENT' | 'ALL'
  credentialType: 'http' | 'custom' | 'none'
  credentialHint: string | null
  enabled: boolean
  health: string | null
  updatedAt: string | null
}

interface ExternalCockpitPage {
  items?: ExternalCockpitItem[]
  total?: number
}

/** Metadata-only credential choice returned by the Host credential seam. */
export interface ExternalCredentialOption {
  id: string
  name: string
  type: string
  authKind: string
  username: string | null
  origin: string
  tags: string[]
  secretConfigured: boolean
}

interface ExternalCredentialsPayload {
  cockpitId?: string
  credentialType?: string
  siteOrigin?: string | null
  credentialServiceAvailable?: boolean
  credentials?: ExternalCredentialOption[]
  recipeAvailable?: boolean
  recipeError?: string | null
  headedEnabled?: boolean
}

interface ExternalLoginPayload {
  ok?: boolean
  sessionId?: string
  cockpitId?: string
  cockpitName?: string
  credentialName?: string | null
  mode?: 'headless' | 'headed'
  screenshotUrl?: string
  expiresAt?: string
  stableUrl?: string | null
  code?: string
  message?: string
  error?: string
  hint?: string
  headedAvailable?: boolean
}

interface ExternalSessionView {
  cockpitId: string
  cockpitName: string
  sessionId: string
  screenshotUrl: string
  expiresAt: string
  stableUrl: string | null
  credentialName: string | null
  mode: 'headless' | 'headed'
}

/** Browser-session id that binds Host sessions to this tab, not to a DSH principal. */
const panelClientId = (): string => {
  const key = 'dsh-external-cockpit-client'
  try {
    const existing = window.sessionStorage.getItem(key)
    if (existing !== null && /^[A-Za-z0-9_-]{8,64}$/u.test(existing)) return existing
    const created = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/gu, '')
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
    window.sessionStorage.setItem(key, created)
    return created
  } catch {
    // Private-mode storage can refuse writes; a per-render id still isolates one attempt.
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}

/** Read the server's own error message, falling back to the HTTP status. */
const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = await response.json() as { error?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim() !== '') return payload.error
  } catch {
    // Non-JSON upstream failure: the status below is the only useful detail.
  }
  return 'HTTP ' + String(response.status)
}

/** Copy with the legacy selection fallback when the async clipboard API is unavailable. */
const copyText = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // Fall through to the selection-based copy used by non-secure origins.
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
  area.remove()
  if (!copied) throw new Error('当前浏览器不允许写入剪贴板')
}

const visibilityLabel = (visibility: ExternalCockpitItem['visibility']): string =>
  visibility === 'ALL' ? '全员可见' : visibility === 'DEPARTMENT' ? '部门可见' : '私有'

const credentialLabel = (item: ExternalCockpitItem): string => {
  if (item.credentialType === 'none') return '无需登录'
  return '账号提示：' + (item.credentialHint ?? '未填写')
}

const CSS = `
.dsh-xc {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: 8px;
  padding: 10px;
  overflow-y: auto;
  background: var(--dsw-alias-bg-base, #151517);
  color: var(--dsw-alias-label-primary, #f9fafb);
}
.dsh-xc__bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-xc__title { font-size: 12px; font-weight: 600; }
.dsh-xc__badge {
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #7aaaff) 16%, transparent);
  color: var(--dsw-alias-state-business-primary, #7aaaff);
  font-size: 9px;
  font-weight: 600;
}
.dsh-xc__hint { font-size: 10px; color: var(--dsw-alias-label-caption, #81858c); }
.dsh-xc__search { display: flex; align-items: center; gap: 6px; }
.dsh-xc__input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1, #232324);
  color: var(--dsw-alias-label-primary, #f9fafb);
  font-size: 11px;
}
.dsh-xc__input:focus-visible, .dsh-xc__btn:focus-visible, .dsh-xc__retry:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #7aaaff));
  outline-offset: 1px;
}
.dsh-xc__btn {
  appearance: none;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.16));
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #f9fafb);
  font-size: 10px;
  font-weight: 500;
  cursor: pointer;
  flex: none;
}
.dsh-xc__btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
.dsh-xc__btn:disabled { opacity: .45; cursor: not-allowed; }
.dsh-xc__btn.is-primary {
  border-color: var(--dsw-alias-state-business-primary, #7aaaff);
  background: var(--dsw-alias-state-business-primary, #7aaaff);
  color: var(--dsw-alias-label-primary-foreground, #0f1115);
}
.dsh-xc__note {
  padding: 7px 9px;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(255,255,255,.12));
  border-radius: 7px;
  color: var(--dsw-alias-label-caption, #81858c);
  font-size: 10px;
  line-height: 15px;
}
.dsh-xc__list { display: flex; flex-direction: column; gap: 7px; }
.dsh-xc__card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06));
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2, #2c2c2e);
}
.dsh-xc__card-top { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.dsh-xc__card-title { margin: 0; font-size: 12px; font-weight: 600; line-height: 17px; }
.dsh-xc__card-desc { margin: 0; font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-secondary, #cfd3d6); }
.dsh-xc__pill {
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3, #353638);
  color: var(--dsw-alias-label-caption, #81858c);
  font-size: 9px;
}
.dsh-xc__pill.is-disabled { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsh-xc__tags { display: flex; flex-wrap: wrap; gap: 4px; }
.dsh-xc__tag {
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #7aaaff) 10%, transparent);
  color: var(--dsw-alias-state-business-primary, #7aaaff);
  font-size: 9px;
}
.dsh-xc__meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 9px; color: var(--dsw-alias-label-caption, #81858c); }
.dsh-xc__actions { display: flex; gap: 6px; margin-top: 2px; }
.dsh-xc__state { padding: 22px 10px; text-align: center; font-size: 10px; line-height: 16px; color: var(--dsw-alias-label-caption, #81858c); }
.dsh-xc__error {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 35%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f25a5a) 9%, transparent);
  color: var(--dsw-alias-state-error-primary, #f25a5a);
  font-size: 10px;
  line-height: 15px;
}
.dsh-xc__retry {
  align-self: flex-start;
  height: 24px;
  padding: 0 9px;
  border: 1px solid currentColor;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 10px;
  cursor: pointer;
}
.dsh-xc__fallback { font-size: 10px; }
.dsh-xc__fallback a { color: var(--dsw-alias-state-business-primary, #7aaaff); }
.dsh-xc__toast {
  position: sticky;
  bottom: 0;
  padding: 6px 9px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-3, #353638);
  font-size: 10px;
  text-align: center;
}
.dsh-xc__login {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 4px;
  padding: 9px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #232324);
}
.dsh-xc__login-title { font-size: 11px; font-weight: 600; }
.dsh-xc__creds { display: flex; flex-direction: column; gap: 5px; }
.dsh-xc__cred {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 7px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06));
  border-radius: 6px;
  cursor: pointer;
}
.dsh-xc__cred.is-selected {
  border-color: var(--dsw-alias-state-business-primary, #7aaaff);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #7aaaff) 9%, transparent);
}
.dsh-xc__cred input { margin: 1px 0 0; }
.dsh-xc__cred-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-xc__cred-name { font-size: 10px; line-height: 14px; }
.dsh-xc__cred-meta { font-size: 9px; line-height: 13px; color: var(--dsw-alias-label-caption, #81858c); }
.dsh-xc__headed {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  line-height: 14px;
  color: var(--dsw-alias-label-secondary, #cfd3d6);
}
.dsh-xc__session {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12));
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2, #2c2c2e);
}
.dsh-xc__shot {
  display: block;
  width: 100%;
  max-height: 300px;
  object-fit: contain;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06));
  border-radius: 6px;
  background: #000;
}
.dsh-xc__error-hint { font-size: 9px; line-height: 14px; opacity: .9; }
.dsh-xc__linkbtn {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.16));
  border-radius: 7px;
  color: var(--dsw-alias-label-primary, #f9fafb);
  font-size: 10px;
  text-decoration: none;
}
.dsh-xc__linkbtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
`

/**
 * Registry list, search and stable-link actions for external cockpits.
 * @param props.reloadToken - Bump from the tab header to reload the list.
 */
export function ExternalCockpitPanel({ reloadToken = 0 }: { reloadToken?: number }) {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<ExternalCockpitItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [fallback, setFallback] = useState<{ name: string; url: string } | null>(null)
  const [loginFor, setLoginFor] = useState<ExternalCockpitItem | null>(null)
  const [credentialPanel, setCredentialPanel] = useState<{
    loading: boolean
    error: string | null
    credentials: ExternalCredentialOption[]
    serviceAvailable: boolean
    recipeAvailable: boolean
    recipeError: string | null
    headedEnabled: boolean
    siteOrigin: string | null
  } | null>(null)
  const [selectedCredential, setSelectedCredential] = useState('')
  const [headed, setHeaded] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState<{ code: string; message: string; hint: string; headedAvailable: boolean } | null>(null)
  const [session, setSession] = useState<ExternalSessionView | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setFallback(null)
    try {
      const params = new URLSearchParams({ page: '1', pageSize: '50' })
      if (query.trim() !== '') params.set('search', query.trim())
      const response = await fetch('/dsh-artifact-app/external-cockpits?' + params.toString(), {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(await readErrorMessage(response))
      const payload = await response.json() as ExternalCockpitPage
      const rows = Array.isArray(payload.items) ? payload.items : []
      setItems(rows)
      setTotal(typeof payload.total === 'number' ? payload.total : rows.length)
    } catch (cause) {
      setItems([])
      setTotal(0)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => {
    void load()
  }, [load, reloadToken])

  useEffect(() => {
    if (notice === '') return undefined
    const timer = window.setTimeout(() => setNotice(''), 2600)
    return () => window.clearTimeout(timer)
  }, [notice])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setQuery(draft.trim())
  }

  const clearSearch = (): void => {
    setDraft('')
    setQuery('')
  }

  const requestLink = async (item: ExternalCockpitItem): Promise<string> => {
    const response = await fetch('/dsh-artifact-app/external-cockpits/' + encodeURIComponent(item.id) + '/link', {
      method: 'POST',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(await readErrorMessage(response))
    const payload = await response.json() as { url?: unknown }
    if (typeof payload.url !== 'string') throw new Error('DataOps 未返回稳定链接')
    let parsed: URL
    try {
      parsed = new URL(payload.url)
    } catch {
      throw new Error('稳定链接格式非法')
    }
    if (parsed.protocol !== 'https:') throw new Error('稳定链接必须是 HTTPS')
    return parsed.toString()
  }

  const open = async (item: ExternalCockpitItem): Promise<void> => {
    setBusyId(item.id)
    setNotice('')
    setFallback(null)
    try {
      const url = await requestLink(item)
      // `noopener` makes window.open return null even on success, so success cannot be
      // inferred from the return value. Always render the manual link as the fallback.
      window.open(url, '_blank', 'noopener,noreferrer')
      setFallback({ name: item.name, url })
      setNotice('已请求在新窗口打开；如未看到窗口，请使用下方链接')
    } catch (cause) {
      setNotice('打开失败：' + (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setBusyId(null)
    }
  }

  const copy = async (item: ExternalCockpitItem): Promise<void> => {
    setBusyId(item.id)
    setNotice('')
    try {
      const url = await requestLink(item)
      await copyText(url)
      setNotice('链接已复制')
    } catch (cause) {
      setNotice('复制失败：' + (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setBusyId(null)
    }
  }

  const startLogin = async (item: ExternalCockpitItem): Promise<void> => {
    setLoginFor(item)
    setLoginError(null)
    setSelectedCredential('')
    setHeaded(false)
    setCredentialPanel({
      loading: true,
      error: null,
      credentials: [],
      serviceAvailable: true,
      recipeAvailable: false,
      recipeError: null,
      headedEnabled: false,
      siteOrigin: null,
    })
    try {
      const response = await fetch(
        '/dsh-artifact-app/external-cockpits/' + encodeURIComponent(item.id) + '/credentials',
        {
          headers: { accept: 'application/json', 'x-dsh-cockpit-client': panelClientId() },
          cache: 'no-store',
        },
      )
      if (!response.ok) throw new Error(await readErrorMessage(response))
      const payload = await response.json() as ExternalCredentialsPayload
      const credentials = Array.isArray(payload.credentials) ? payload.credentials : []
      setCredentialPanel({
        loading: false,
        error: null,
        credentials,
        serviceAvailable: payload.credentialServiceAvailable !== false,
        recipeAvailable: payload.recipeAvailable === true,
        recipeError: typeof payload.recipeError === 'string' ? payload.recipeError : null,
        headedEnabled: payload.headedEnabled === true,
        siteOrigin: typeof payload.siteOrigin === 'string' ? payload.siteOrigin : null,
      })
      setSelectedCredential(credentials[0]?.id ?? '')
    } catch (cause) {
      setCredentialPanel({
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause),
        credentials: [],
        serviceAvailable: false,
        recipeAvailable: false,
        recipeError: null,
        headedEnabled: false,
        siteOrigin: null,
      })
    }
  }

  const cancelLogin = (): void => {
    if (loginBusy) return
    setLoginFor(null)
    setCredentialPanel(null)
    setLoginError(null)
  }

  const submitLogin = async (item: ExternalCockpitItem, headedOverride?: boolean): Promise<void> => {
    if (loginBusy) return
    const useHeaded = headedOverride ?? headed
    setLoginBusy(true)
    setLoginError(null)
    try {
      const body: Record<string, unknown> = {
        clientId: panelClientId(),
        mode: useHeaded ? 'headed' : 'headless',
      }
      if (item.credentialType !== 'none' && selectedCredential !== '') body.credentialId = selectedCredential
      const response = await fetch('/dsh-artifact-app/external-cockpits/' + encodeURIComponent(item.id) + '/login', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-dsh-cockpit-client': panelClientId(),
        },
        body: JSON.stringify(body),
        cache: 'no-store',
      })
      const payload = await response.json() as ExternalLoginPayload
      if (!response.ok || payload.ok !== true) {
        setLoginError({
          code: typeof payload.code === 'string' ? payload.code : 'LOGIN_FAILED',
          message: typeof payload.message === 'string'
            ? payload.message
            : typeof payload.error === 'string' ? payload.error : 'HTTP ' + String(response.status),
          hint: typeof payload.hint === 'string' ? payload.hint : '',
          headedAvailable: payload.headedAvailable === true,
        })
        return
      }
      if (typeof payload.sessionId !== 'string' || typeof payload.screenshotUrl !== 'string'
        || typeof payload.expiresAt !== 'string') {
        throw new Error('登录响应缺少会话信息')
      }
      setSession({
        cockpitId: item.id,
        cockpitName: item.name,
        sessionId: payload.sessionId,
        screenshotUrl: payload.screenshotUrl,
        expiresAt: payload.expiresAt,
        stableUrl: typeof payload.stableUrl === 'string' ? payload.stableUrl : null,
        credentialName: typeof payload.credentialName === 'string' ? payload.credentialName : null,
        mode: payload.mode === 'headed' ? 'headed' : 'headless',
      })
      setLoginFor(null)
      setCredentialPanel(null)
      setNotice('登录成功，已生成截图')
    } catch (cause) {
      setLoginError({
        code: 'LOGIN_FAILED',
        message: cause instanceof Error ? cause.message : String(cause),
        hint: '',
        headedAvailable: false,
      })
    } finally {
      setLoginBusy(false)
    }
  }

  const endSession = async (): Promise<void> => {
    if (session === null) return
    try {
      await fetch(
        '/dsh-artifact-app/external-cockpits/' + encodeURIComponent(session.cockpitId)
          + '/sessions/' + encodeURIComponent(session.sessionId),
        { method: 'DELETE', headers: { 'x-dsh-cockpit-client': panelClientId() }, cache: 'no-store' },
      )
    } catch {
      // Clearing local state is still correct when the Host already expired the session.
    }
    setSession(null)
    setNotice('已结束登录会话')
  }

  const remainingMinutes = (expiresAt: string): number =>
    Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 60_000))

  return (
    <div className="dsh-xc">
      <style>{CSS}</style>
      <div className="dsh-xc__bar">
        <span className="dsh-xc__title">外部驾驶舱</span>
        <span className="dsh-xc__badge">M2</span>
        <span className="dsh-xc__hint">注册表发现 · Host 登录 · 截图</span>
      </div>
      <form className="dsh-xc__search" onSubmit={submit}>
        <input
          className="dsh-xc__input"
          aria-label="搜索外部驾驶舱"
          placeholder="搜索名称、说明或标签"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="dsh-xc__btn is-primary" disabled={loading}>搜索</button>
        {query !== '' ? <button type="button" className="dsh-xc__btn" onClick={clearSearch}>清除</button> : null}
      </form>
      <div className="dsh-xc__note">
        M2：按站点 origin 列出匹配凭据，由 Host 在隔离的无头浏览器中执行登录 recipe 并返回截图。
        密码、Cookie、storageState 不会进入页面、模型或日志；外部站点仍不使用 iframe 嵌入。
      </div>

      {loading ? <div className="dsh-xc__state" role="status">正在加载外部驾驶舱…</div> : null}
      {error !== null ? (
        <div className="dsh-xc__error" role="alert">
          <span>{error}</span>
          <button type="button" className="dsh-xc__retry" onClick={() => void load()}>重试</button>
        </div>
      ) : null}
      {!loading && error === null && items.length === 0 ? (
        <div className="dsh-xc__state">
          暂无外部驾驶舱<br />
          请先在 DataOps 门户登记，或调整搜索条件。
        </div>
      ) : null}
      {!loading && error === null && items.length > 0 ? (
        <>
          <div className="dsh-xc__hint">共 {total} 个外部驾驶舱</div>
          <div className="dsh-xc__list">
            {items.map((item) => (
              <article key={item.id} className="dsh-xc__card" data-external-cockpit-id={item.id}>
                <div className="dsh-xc__card-top">
                  <h3 className="dsh-xc__card-title">{item.name}</h3>
                  <span className="dsh-xc__pill">{visibilityLabel(item.visibility)}</span>
                  {item.enabled ? null : <span className="dsh-xc__pill is-disabled">已停用</span>}
                </div>
                <p className="dsh-xc__card-desc">{item.description ?? '未填写说明'}</p>
                {item.tags.length > 0 ? (
                  <div className="dsh-xc__tags">
                    {item.tags.slice(0, 8).map((tag) => <span key={tag} className="dsh-xc__tag">{tag}</span>)}
                  </div>
                ) : null}
                <div className="dsh-xc__meta">
                  <span>负责人：{item.ownerId ?? '未指定'}</span>
                  <span>{credentialLabel(item)}</span>
                </div>
                <div className="dsh-xc__actions">
                  <button
                    type="button"
                    className="dsh-xc__btn is-primary"
                    data-action="open"
                    disabled={busyId === item.id}
                    onClick={() => void open(item)}
                  >{busyId === item.id ? '获取链接…' : '打开'}</button>
                  <button
                    type="button"
                    className="dsh-xc__btn"
                    data-action="copy"
                    disabled={busyId === item.id}
                    onClick={() => void copy(item)}
                  >复制链接</button>
                  <button
                    type="button"
                    className="dsh-xc__btn"
                    data-action="login"
                    disabled={busyId === item.id || !item.enabled}
                    onClick={() => { if (loginFor?.id === item.id) cancelLogin(); else void startLogin(item) }}
                  >{loginFor?.id === item.id ? '收起登录' : item.credentialType === 'none' ? '打开并截图' : '登录并截图'}</button>
                </div>

                {loginFor?.id === item.id && credentialPanel !== null ? (
                  <div className="dsh-xc__login" data-external-login-panel={item.id}>
                    <div className="dsh-xc__login-title">登录「{item.name}」并生成截图</div>
                    {credentialPanel.loading ? <div className="dsh-xc__hint" role="status">正在读取匹配凭据…</div> : null}
                    {credentialPanel.error !== null ? (
                      <div className="dsh-xc__error" role="alert">
                        <span>{credentialPanel.error}</span>
                        <button type="button" className="dsh-xc__retry" onClick={() => void startLogin(item)}>重试</button>
                      </div>
                    ) : null}
                    {!credentialPanel.loading && credentialPanel.error === null ? (
                      <>
                        {credentialPanel.siteOrigin !== null ? (
                          <div className="dsh-xc__hint">站点 origin：{credentialPanel.siteOrigin}</div>
                        ) : null}
                        {credentialPanel.credentials.length > 0 ? (
                          <div className="dsh-xc__creds" role="radiogroup" aria-label="选择登录凭据">
                            {credentialPanel.credentials.map((credential) => (
                              <label
                                key={credential.id}
                                className={'dsh-xc__cred' + (selectedCredential === credential.id ? ' is-selected' : '')}
                              >
                                <input
                                  type="radio"
                                  name={'external-credential-' + item.id}
                                  value={credential.id}
                                  checked={selectedCredential === credential.id}
                                  onChange={() => setSelectedCredential(credential.id)}
                                />
                                <span className="dsh-xc__cred-main">
                                  <span className="dsh-xc__cred-name">{credential.name}</span>
                                  <span className="dsh-xc__cred-meta">
                                    {credential.type} · {credential.authKind}
                                    {' · '}{credential.username ?? '无用户名'}
                                    {' · '}{credential.secretConfigured ? '密钥已配置' : '密钥未配置'}
                                  </span>
                                </span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <div className="dsh-xc__hint">
                            {item.credentialType === 'none'
                              ? '该驾驶舱无需凭据，登录时只执行 recipe 并截图。'
                              : credentialPanel.serviceAvailable
                                ? '没有与站点 origin 匹配的已启用凭据，请先在右侧栏「凭据」页创建。'
                                : '未安装 credential-manager，无法选择凭据。'}
                          </div>
                        )}
                        {!credentialPanel.recipeAvailable ? (
                          <div className="dsh-xc__error" role="alert">
                            <span>{credentialPanel.recipeError ?? '该驾驶舱尚未配置登录 recipe。'}</span>
                            <span className="dsh-xc__error-hint">由管理员在注册表或插件配置 externalLoginRecipes 中提供 recipe。</span>
                          </div>
                        ) : null}
                        {credentialPanel.headedEnabled ? (
                          <label className="dsh-xc__headed">
                            <input type="checkbox" checked={headed} onChange={(event) => setHeaded(event.target.checked)} />
                            有头模式（仅在 MFA/验证码需要人工接管时勾选）
                          </label>
                        ) : null}
                        {loginError !== null ? (
                          <div className="dsh-xc__error" role="alert">
                            <span>{loginError.message}（{loginError.code}）</span>
                            {loginError.hint !== '' ? <span className="dsh-xc__error-hint">{loginError.hint}</span> : null}
                            {loginError.headedAvailable && !headed ? (
                              <button
                                type="button"
                                className="dsh-xc__retry"
                                disabled={loginBusy}
                                onClick={() => { setHeaded(true); void submitLogin(item, true) }}
                              >改用有头模式重试</button>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="dsh-xc__actions">
                          <button
                            type="button"
                            className="dsh-xc__btn is-primary"
                            data-action="login-submit"
                            disabled={loginBusy || credentialPanel.loading || credentialPanel.error !== null
                              || !credentialPanel.recipeAvailable
                              || (item.credentialType !== 'none' && selectedCredential === '')}
                            onClick={() => void submitLogin(item)}
                          >{loginBusy ? '正在登录…' : headed ? '有头登录' : '无头登录'}</button>
                          <button type="button" className="dsh-xc__btn" disabled={loginBusy} onClick={cancelLogin}>取消</button>
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </>
      ) : null}

      {session !== null ? (
        <section className="dsh-xc__session" aria-label="外部驾驶舱登录会话">
          <div className="dsh-xc__bar">
            <span className="dsh-xc__title">已登录：{session.cockpitName}</span>
            <span className="dsh-xc__pill">{session.mode === 'headed' ? '有头' : '无头'}</span>
            <span className="dsh-xc__pill">{remainingMinutes(session.expiresAt)} 分钟后过期</span>
          </div>
          <img
            className="dsh-xc__shot"
            src={session.screenshotUrl}
            alt={'登录后的页面截图：' + session.cockpitName}
          />
          <div className="dsh-xc__meta">
            <span>凭据：{session.credentialName ?? '无需凭据'}</span>
            <span>截图与 storageState 仅保留在 Host 内存</span>
          </div>
          <div className="dsh-xc__actions">
            {session.stableUrl !== null ? (
              <a className="dsh-xc__linkbtn" href={session.stableUrl} target="_blank" rel="noreferrer noopener">打开原站</a>
            ) : null}
            <button type="button" className="dsh-xc__btn" onClick={() => void endSession()}>结束会话</button>
          </div>
        </section>
      ) : null}

      {fallback !== null ? (
        <div className="dsh-xc__fallback" role="status">
          <a href={fallback.url} target="_blank" rel="noreferrer noopener">手动打开「{fallback.name}」</a>
        </div>
      ) : null}
      {notice !== '' ? <div className="dsh-xc__toast" role="status">{notice}</div> : null}
    </div>
  )
}
