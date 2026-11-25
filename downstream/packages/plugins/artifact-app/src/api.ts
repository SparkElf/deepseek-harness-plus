/**
 * DataOps artifact API client.
 *
 * Every call carries the workspace credential; the browser never sees it. Errors
 * keep the server's own `message` so a tool result explains what DataOps said
 * instead of a generic "request failed".
 *
 * @module api
 */

/** Minimal credential surface this client needs. */
export interface TokenSource {
  resolve(): Promise<string | undefined>
}

/** One artifact row as the list endpoint returns it. */
export interface ArtifactAppRow {
  id: string
  name: string
  description?: string | null
  catalog?: string | null
  status: string
  currentVersion: number
  publishedVersion: number
  refreshIntervalSeconds?: number
  keepConnection?: boolean
  updatedAt: string
  canManage?: boolean
}

/** One template row from `/api/artifact-templates`. */
export interface ArtifactTemplateRow {
  id: string
  name: string
  description?: string | null
  catalog?: string | null
  appType?: string
  status?: string
  currentVersion?: number
  contract?: { slots?: string[]; question?: string } | null
  updatedAt?: string
}

/** Publish request body. */
export interface PublishInput {
  artifactId?: string
  name?: string
  description?: string
  catalog?: string
  html?: string
  templateId?: string
  templateVersion?: string
}

/** Preview request body. */
export interface PreviewInput extends PublishInput {
  html: string
  baseVersion?: number
}

/** Grants payload. */
export interface GrantInput {
  principalType: 'USER' | 'ROLE' | 'DEPARTMENT'
  principalId: string
  action: 'READ' | 'MANAGE'
}

/** Server error carrying the DataOps status. */
export class DataOpsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'DataOpsError'
  }
}

/** Client for the DataOps artifact endpoints. */
export class ArtifactApi {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenSource,
    private readonly timeoutMs: number,
  ) {}

  /** Read the workspace token or explain why the call cannot run. */
  async token(): Promise<string> {
    const token = await this.tokens.resolve()
    if (token === undefined || token === '') {
      throw new Error('未找到 DataOps 登录凭证（' + this.baseUrl + '）：请先在本工作区完成 DataOps 登录')
    }
    return token
  }

  private async request<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    if (auth) headers.set('authorization', 'Bearer ' + await this.token())
    const response = await fetch(this.baseUrl.replace(/\/+$/u, '') + path, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await response.text()
    let payload: unknown = null
    if (text.trim() !== '') {
      try { payload = JSON.parse(text) as unknown } catch { payload = null }
    }
    if (response.status === 401) {
      // 会话已结束。上报给同进程的 dataops-managed，让工作区弹出「重新登录」而不是
      // 让驾驶舱独自显示一句「渲染失败」。fire-and-forget：上报失败不能盖住原始错误。
      void fetch('/integrations/dataops/auth-state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'expired' }),
      }).catch(() => undefined)
    }
    if (!response.ok) {
      const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      const message = typeof record.message === 'string'
        ? record.message
        : typeof record.error === 'string'
          ? record.error
          : text.trim() !== '' ? text.trim().slice(0, 300) : 'HTTP ' + response.status
      throw new DataOpsError(message, response.status)
    }
    return payload as T
  }

  /** Read the current DataOps principal and roles. */
  me(): Promise<{ user?: { roles?: Array<{ code?: string; name?: string }> } }> {
    return this.request('/api/auth/me')
  }

  /** List published templates or components (`appType=COCKPIT|COMPONENT`). */
  listTemplates(appType: 'COCKPIT' | 'COMPONENT' = 'COCKPIT'): Promise<ArtifactTemplateRow[]> {
    return this.request('/api/artifact-templates?appType=' + appType)
  }

  /**
   * Search the component reference library.
   * @param query - keyword matched against name/description/tags and the HTML body.
   * @param tags - capability tags, e.g. `geo3d,3d-map`.
   * @param limit - max hits (1..20).
   */
  searchComponents(query: { q?: string; tags?: string[]; limit?: number } = {}): Promise<Array<ArtifactTemplateRow & { snippet?: string; tags?: string[]; capabilities?: string[]; requires?: string[] }>> {
    const params = new URLSearchParams()
    if (query.q !== undefined && query.q.trim() !== '') params.set('q', query.q.trim())
    if (query.tags !== undefined && query.tags.length > 0) params.set('tags', query.tags.join(','))
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    const suffix = params.toString()
    return this.request('/api/artifact-templates/components/search' + (suffix === '' ? '' : '?' + suffix))
  }

  /** Read one template's metadata and contract. */
  getTemplate(id: string): Promise<ArtifactTemplateRow> {
    return this.request('/api/artifact-templates/' + encodeURIComponent(id))
  }

  /** Read one template's HTML. */
  getTemplateHtml(id: string): Promise<{ id: string; version: number; html: string }> {
    return this.request('/api/artifact-templates/' + encodeURIComponent(id) + '/html')
  }

  /** List visible cockpit apps. */
  listApps(query: { q?: string; catalog?: string; status?: string; page?: number; pageSize?: number } = {}): Promise<{ items: ArtifactAppRow[]; total: number; page: number; pageSize: number }> {
    const params = new URLSearchParams()
    if (query.q) params.set('q', query.q)
    if (query.catalog) params.set('catalog', query.catalog)
    if (query.status) params.set('status', query.status)
    if (query.page !== undefined) params.set('page', String(query.page))
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize))
    const suffix = params.toString()
    return this.request('/api/artifact-apps' + (suffix ? '?' + suffix : ''))
  }

  /** Catalog counts for the tab's folder filter. */
  catalogs(): Promise<Array<{ catalog: string | null; count: number }>> {
    return this.request('/api/artifact-apps/catalogs')
  }

  /** Read one app's metadata. */
  getApp(id: string): Promise<ArtifactAppRow> {
    return this.request('/api/artifact-apps/' + encodeURIComponent(id))
  }

  /** Read one app's HTML (current for managers, published for viewers). */
  getAppHtml(id: string, version?: number): Promise<{ id: string; version: number; html: string }> {
    const suffix = version === undefined ? '' : '?version=' + String(version)
    return this.request('/api/artifact-apps/' + encodeURIComponent(id) + '/html' + suffix)
  }

  /** Patch metadata only. */
  patchApp(id: string, patch: { name?: string; description?: string; catalog?: string; refreshIntervalSeconds?: number; keepConnection?: boolean }): Promise<unknown> {
    return this.request('/api/artifact-apps/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) })
  }

  /** Soft-delete one app. */
  deleteApp(id: string): Promise<{ success: boolean }> {
    return this.request('/api/artifact-apps/' + encodeURIComponent(id), { method: 'DELETE' })
  }

  /** Read one app's grants. */
  getGrants(id: string): Promise<{ ownerId: string; grants: GrantInput[] }> {
    return this.request('/api/artifact-apps/' + encodeURIComponent(id) + '/grants')
  }

  /** Replace one app's grants. */
  putGrants(id: string, grants: GrantInput[]): Promise<{ ownerId: string; grants: GrantInput[] }> {
    return this.request('/api/artifact-apps/' + encodeURIComponent(id) + '/grants', { method: 'PUT', body: JSON.stringify({ grants }) })
  }

  /** Create or update a draft without publishing. */
  preview(input: PreviewInput): Promise<{ id: string; version: number; created: boolean }> {
    return this.request('/api/artifact-apps/preview', { method: 'POST', body: JSON.stringify(input) })
  }

  /** Publish a new app or a new version of an existing one. */
  publish(input: PublishInput): Promise<{ id: string; version: number; publishedVersion: number; created: boolean }> {
    return this.request('/api/artifact-apps/publish', { method: 'POST', body: JSON.stringify(input) })
  }

  /** Public runtime script served by DataOps. */
  async runtimeScript(): Promise<string> {
    const response = await fetch(this.baseUrl.replace(/\/+$/u, '') + '/api/artifact-apps/runtime.js', { signal: AbortSignal.timeout(this.timeoutMs) })
    if (!response.ok) throw new Error('运行时下载失败（HTTP ' + String(response.status) + '）')
    return await response.text()
  }

  /** Public ECharts bundle served by DataOps. */
  async echartsScript(): Promise<string> {
    const response = await fetch(this.baseUrl.replace(/\/+$/u, '') + '/api/artifact-apps/echarts.js', { signal: AbortSignal.timeout(this.timeoutMs) })
    if (!response.ok) throw new Error('ECharts 下载失败（HTTP ' + String(response.status) + '）')
    return await response.text()
  }

  /** Proxy one gateway call with the caller's own Authorization header. */
  /**
   * 批量解析素材逻辑名 → 可用 URL。
   *
   * 渲染时把 HTML 里的 `asset://<逻辑名>` 换成这里的地址；解析不到的名字保持原样，
   * 由页面自己降级（不阻断渲染）。
   * @param names - 逻辑名列表。
   * @param scope - shared 或 template（默认 template，ownerId 为模板 id）。
   * @param ownerId - 模板 id。
   */
  /**
   * 发布模板包：把打包好的 zip 交给后端解压、校验、落素材并建模板版本。
   * @param zipBase64 - zip 的 base64。
   * @returns 模板 id 与版本。
   */
  async publishTemplatePackage(zipBase64: string): Promise<{ templateId: string; version: number; assets: number }> {
    return this.request<{ templateId: string; version: number; assets: number }>('/api/artifact-templates/package', {
      method: 'POST',
      body: JSON.stringify({ zipBase64 }),
    })
  }

  async resolveAssets(names: string[], scope: 'shared' | 'template', ownerId?: string): Promise<Record<string, string>> {
    if (names.length === 0) return {}
    const payload = await this.request<{ urls?: Record<string, string> }>('/api/artifact-assets/resolve', {
      method: 'POST',
      body: JSON.stringify({ names, scope, ...(ownerId === undefined ? {} : { ownerId }) }),
    })
    return payload.urls ?? {}
  }

  async gateway(path: string, init: RequestInit, authorization: string | undefined): Promise<{ status: number; body: string; contentType: string }> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    if (authorization !== undefined) headers.set('authorization', authorization)
    const response = await fetch(this.baseUrl.replace(/\/+$/u, '') + path, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    return {
      status: response.status,
      body: await response.text(),
      contentType: response.headers.get('content-type') ?? 'application/json; charset=utf-8',
    }
  }
}