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
} as const

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
}

/** One group as the host serves it. */
export interface GroupPayload {
  key: string
  title: string
  hint: string
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
