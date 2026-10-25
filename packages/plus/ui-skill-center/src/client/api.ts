/**
 * Skill center API client. Talks to the host route family over same-origin
 * fetch; the host owns the trust fence.
 *
 * @module @sparkelf/dsh-client-ui-skill-center/client/api
 */

/** Route paths, mirrored from the host (`src/index.ts` ROUTES). */
const API = {
  list: '/api/dsh-skill-center/list',
  setEnabled: '/api/dsh-skill-center/set-enabled',
  create: '/api/dsh-skill-center/create',
  remove: '/api/dsh-skill-center/delete',
  content: '/api/dsh-skill-center/content',
  translationProgress: '/api/dsh-skill-center/translation-progress',
  plaza: '/integrations/dataops/skill-plaza',
  reviewContext: '/integrations/dataops/review-context',
  rbac: '/integrations/dataops/rbac',
} as const

/** Chinese copy for one skill, when a translation file exists beside it. */
export interface SkillEntryTranslation {
  title: string
  description: string
  summary: string
}

/** One skill's instruction body, as the content route serves it. */
export interface SkillContent {
  name: string
  content: string
}

/** Translated share of the skill set, as the translation script recorded it. */
export interface TranslationProgress {
  total: number
  done: number
  current: string | null
  finishedAt: string | null
}

/** One skill entry as the host serves it. */
export interface SkillEntry {
  name: string
  description: string
  whenToUse?: string
  provider?: string
  level: string
  path?: string
  /** True when discovered through a symlink; deletion is refused. */
  linked?: boolean
  modelInvocable: boolean
  userInvocable: boolean
  workspaceRoot?: string
  workspaceName?: string
  isActiveWorkspace?: boolean
  /** Chinese copy rendered in place of the English values; the registry keeps its own. */
  i18n?: SkillEntryTranslation
}

/** One group as the host serves it. */
export interface GroupPayload {
  key: string
  title: string
  skills: SkillEntry[]
}

/** One selectable workspace. */
export interface WorkspaceItem {
  root: string
  name: string
  active: boolean
}

/** The list route's payload. */
export interface ListPayload {
  cwd: string
  projectRoots: string[]
  complete: boolean
  groups: GroupPayload[]
  workspaces?: WorkspaceItem[]
}

/** One plaza record returned by the sharing bridge. */
export interface PlazaSkill {
  id: number
  name: string
  reviewStatus?: 'pending' | 'approved' | 'rejected'
  visibility?: 'global' | 'department' | 'private'
  departmentCode?: string
  departmentName?: string
  sharedByMe?: boolean
  reviewNote?: string
  updatedAt?: string
}

/** The sharing bridge could not answer (503): show local/disabled, never fake a status. */
export class PlazaUnavailableError extends Error {}

/** One thrown API error carrying the host's message. */
export class ApiError extends Error {}

/** Skill center API client. */
export class SkillApi {
  /** Fetch the grouped skill list. */
  async list(cwd?: string): Promise<ListPayload> {
    const url = typeof cwd === 'string' && cwd.trim() !== ''
      ? `${API.list}?cwd=${encodeURIComponent(cwd)}`
      : API.list
    return this.request<ListPayload>(url)
  }

  /** Enable or disable a skill by rewriting its frontmatter flag. */
  async setEnabled(name: string, path: string, enabled: boolean): Promise<{ name: string; enabled: boolean }> {
    return this.request(API.setEnabled, { method: 'POST', body: { name, path, enabled } })
  }

  /** Create a skill file under the user or project root. */
  async create(payload: {
    root: 'user' | 'project'
    name: string
    description: string
    whenToUse?: string
    content?: string
  }): Promise<{ ok: true; name: string; path: string }> {
    return this.request(API.create, { method: 'POST', body: payload })
  }

  /** Delete a skill by moving it into the recoverable trash. */
  async remove(name: string, path: string): Promise<{ ok: true; moved: string }> {
    return this.request(API.remove, { method: 'POST', body: { name, path } })
  }

  /**
   * One skill's instruction body, without the YAML frontmatter the card already
   * shows as metadata.
   *
   * The path the list served travels back with the request: a row from another
   * workspace is read from the file that was listed rather than from whatever the
   * viewing workspace's registry resolves by name.
   */
  async content(name: string, path?: string, cwd?: string): Promise<SkillContent> {
    const params = new URLSearchParams({ name })
    if (path !== undefined && path !== '') params.set('path', path)
    if (cwd !== undefined && cwd !== '') params.set('cwd', cwd)
    return this.request<SkillContent>(API.content + '?' + params.toString())
  }

  /**
   * The translated share of the skill set, or undefined when the host has not
   * been told where the translations live (the route then answers `{}`).
   */
  async translationProgress(): Promise<TranslationProgress | undefined> {
    const body = await this.request<{ progress?: TranslationProgress }>(API.translationProgress)
    return body.progress
  }

  /** The caller's review role and department scope, from the DataOps bridge. */
  async reviewContext(): Promise<{
    canReview?: boolean
    canReviewGlobal?: boolean
    departmentCode?: string | null
    departmentPath?: { code: string; name: string }[]
    roleCodes?: string[]
    primaryRole?: string
  }> {
    const response = await fetch(API.reviewContext)
    const body = await this.readBody(response)
    if (response.status === 503) throw new PlazaUnavailableError('review context is not active')
    if (!response.ok) throw new ApiError(this.errorOf(body, response.status))
    const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    const review = typeof record.review === 'object' && record.review !== null
      ? record.review as Record<string, unknown>
      : {}
    return {
      canReview: review.canReview === true || record.canReview === true,
      canReviewGlobal: review.canReviewGlobal === true || record.canReviewGlobal === true,
      departmentCode: typeof record.departmentCode === 'string' ? record.departmentCode : null,
      departmentPath: Array.isArray(record.departmentPath)
        ? record.departmentPath.flatMap((row) => {
          if (typeof row !== 'object' || row === null) return []
          const node = row as { code?: unknown; name?: unknown }
          return typeof node.code === 'string' && typeof node.name === 'string' ? [{ code: node.code, name: node.name }] : []
        })
        : [],
      roleCodes: Array.isArray(record.roleCodes) ? record.roleCodes.filter((code): code is string => typeof code === 'string') : [],
      ...(typeof record.primaryRole === 'string' ? { primaryRole: record.primaryRole } : {}),
    }
  }

  /** The department tree, for administrators publishing to any department. */
  async departments(): Promise<{ code: string; name: string; parentCode?: string | null }[]> {
    const response = await fetch(API.rbac + '?section=departments')
    const body = await this.readBody(response)
    // A non-admin may not read the tree; their own department still comes from
    // review-context, so an empty list is a valid answer here.
    if (!response.ok) return []
    if (typeof body !== 'object' || body === null || !Array.isArray((body as { items?: unknown }).items)) return []
    return (body as { items: unknown[] }).items.flatMap((row) => {
      if (typeof row !== 'object' || row === null) return []
      const node = row as { code?: unknown; name?: unknown; parentCode?: unknown }
      return typeof node.code === 'string' && typeof node.name === 'string'
        ? [{ code: node.code, name: node.name, parentCode: typeof node.parentCode === 'string' ? node.parentCode : null }]
        : []
    })
  }

  /**
   * The plaza records this workspace holds (`mine=1`). A 503 means the
   * sharing service is not active yet; the panel then renders every local
   * skill as local with 上架 disabled.
   */
  async plazaMine(): Promise<PlazaSkill[]> {
    const response = await fetch(API.plaza + '?mine=1')
    const body = await this.readBody(response)
    if (response.status === 503) throw new PlazaUnavailableError('skill plaza is not active')
    if (!response.ok) throw new ApiError(this.errorOf(body, response.status))
    const skills = typeof body === 'object' && body !== null && Array.isArray((body as { skills?: unknown }).skills)
      ? (body as { skills: unknown[] }).skills
      : []
    return skills
      .filter((row): row is PlazaSkill => typeof row === 'object' && row !== null && typeof (row as { id?: unknown }).id === 'number' && typeof (row as { name?: unknown }).name === 'string')
      // A pre-review bridge answers the whole plaza; only this workspace's own
      // rows belong on a local card. The new `mine=1` response already is.
      .filter(row => row.sharedByMe === true || row.reviewStatus !== undefined)
  }

  /** Publish one local skill. The name is the DataOps identity; no path/level leaves the workspace. */
  async plazaSubmit(payload: {
    name: string
    description?: string
    instruction: string
    tags?: string[]
    visibility?: 'global' | 'department' | 'private'
    departmentCode?: string
  }): Promise<PlazaSkill> {
    const response = await fetch(API.plaza, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'submit', ...payload }),
    })
    let body = await this.readBody(response)
    if (response.status === 503) throw new PlazaUnavailableError('skill plaza is not active')
    if (!response.ok && response.status === 400 && this.errorOf(body, response.status).includes('unknown action')) {
      // Older dataops-managed builds exposed the same operation as `share`;
      // keep the card usable there while the backend contract rolls forward.
      const legacy = await fetch(API.plaza, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'share', ...payload }),
      })
      body = await this.readBody(legacy)
      if (legacy.status === 503) throw new PlazaUnavailableError('skill plaza is not active')
      if (!legacy.ok) throw new ApiError(this.errorOf(body, legacy.status))
    } else if (!response.ok) {
      throw new ApiError(this.errorOf(body, response.status))
    }
    const skill = typeof body === 'object' && body !== null ? (body as { skill?: unknown }).skill : undefined
    if (typeof skill !== 'object' || skill === null) throw new ApiError('the sharing service returned no skill')
    const row = skill as Partial<PlazaSkill>
    return {
      id: typeof row.id === 'number' ? row.id : 0,
      name: typeof row.name === 'string' ? row.name : payload.name,
      reviewStatus: row.reviewStatus ?? 'pending',
      ...(row.sharedByMe === undefined ? { sharedByMe: true } : { sharedByMe: row.sharedByMe }),
    }
  }

  /** Stop sharing one plaza entry owned by this workspace. */
  async plazaUnshare(id: number): Promise<void> {
    const response = await fetch(API.plaza, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'unshare', id }),
    })
    if (response.status === 503) throw new PlazaUnavailableError('skill plaza is not active')
    if (!response.ok) throw new ApiError(this.errorOf(await this.readBody(response), response.status))
  }

  private async readBody(response: Response): Promise<unknown> {
    try { return await response.json() } catch { return undefined }
  }

  private errorOf(body: unknown, status: number): string {
    const reported = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : ''
    return reported === '' ? 'HTTP ' + String(status) : reported
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const init: RequestInit = { method: options.method ?? 'GET' }
    if (options.body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(options.body)
    }
    const response = await fetch(path, init)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    if (!response.ok) {
      // The host reports its own failures; a response without one still has to
      // carry the status, which is data rather than copy.
      const reported = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : ''
      throw new ApiError(reported === '' ? 'HTTP ' + String(response.status) : reported)
    }
    return body as T
  }
}
