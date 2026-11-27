/**
 * Read the current DataOps principal for IM disclosure and local management gates.
 *
 * DataOps remains the only authority for DataOps API calls. This module answers a narrower
 * question for this plugin: may this workspace's model be offered the IM tools, and may this
 * browser call the local IM management routes? The answer is the `/api/ai/review/context`
 * document for the stored DataOps JWT, refreshed when that credential changes.
 *
 * @module auth
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'

/** The subset of `/api/ai/review/context` this plugin reads. */
export interface DataOpsScope {
  readonly userId?: string
  readonly username?: string
  /** Role display codes such as 超级管理员/管理员. */
  readonly roleCodes?: readonly string[]
  readonly primaryRole?: string
  /** Stable role keys such as SUPER_ADMIN/ADMIN. */
  readonly systemKeys?: readonly string[]
  /** Effective permission keys; a present empty array is a denial. */
  readonly permissions?: readonly string[]
  /** Older spelling of {@link permissions}. */
  readonly permissionKeys?: readonly string[]
}

/** The permission and role spellings that count as IM administration. */
export interface AdminPolicy {
  readonly permissions: readonly string[]
  readonly roles: readonly string[]
}

/** Default disclosure policy: the DataOps IM permission, or a portal administrator role. */
export const DEFAULT_ADMIN_POLICY: AdminPolicy = {
  permissions: ['system:im:manage'],
  roles: ['SUPER_ADMIN', 'ADMIN', '超级管理员', '管理员'],
}

/** Fields that mark an opaque Session `actor` as a DataOps scope. */
const ACTOR_KEYS = ['roleCodes', 'systemKeys', 'permissions', 'permissionKeys', 'primaryRole', 'userId'] as const

/**
 * Whether an opaque Session actor is a DataOps scope.
 *
 * `Session.actor` is untyped by design. A value without any identifying field is not ours and a
 * disclosure rule must hide rather than fall back to the workspace principal.
 */
export function isScopeActor(actor: unknown): actor is DataOpsScope {
  return actor !== null && typeof actor === 'object' && ACTOR_KEYS.some(key => key in actor)
}

/**
 * Whether one scope holds IM administration.
 *
 * `system:im:manage` grants directly. A portal administrator role is an independent grant, so an
 * empty permission list does not veto it; a caller with neither the permission nor an
 * administrator role is denied.
 */
export function isAdminScope(scope: DataOpsScope | undefined, policy: AdminPolicy = DEFAULT_ADMIN_POLICY): boolean {
  if (scope === undefined) return false
  const permissions = scope.permissions ?? scope.permissionKeys
  if (permissions !== undefined) {
    const held = new Set(permissions)
    if (policy.permissions.some(permission => held.has(permission))) return true
  }
  const roles = [
    ...(scope.systemKeys ?? []),
    ...(scope.roleCodes ?? []),
    ...(scope.primaryRole === undefined ? [] : [scope.primaryRole]),
  ]
  return roles.some(role => policy.roles.includes(role))
}

/** One parsed `/api/ai/review/context` body, or undefined when it is not a usable scope. */
export function normalizeScope(body: unknown): DataOpsScope | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const strings = (value: unknown): string[] | undefined => Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined
  const roleCodes = strings(record['roleCodes'])
  if (roleCodes === undefined) return undefined
  const permissions = strings(record['permissions']) ?? strings(record['permissionKeys'])
  return {
    roleCodes,
    ...(typeof record['userId'] === 'string' ? { userId: record['userId'] } : {}),
    ...(typeof record['username'] === 'string' ? { username: record['username'] } : {}),
    ...(typeof record['primaryRole'] === 'string' ? { primaryRole: record['primaryRole'] } : {}),
    ...(strings(record['systemKeys']) === undefined ? {} : { systemKeys: strings(record['systemKeys']) }),
    ...(permissions === undefined ? {} : { permissions }),
  }
}

/** Configuration needed to read the DataOps scope. */
export interface ResolverOptions {
  readonly baseUrl: string
  readonly credentialRef: string
  readonly policy: AdminPolicy
  readonly logger: { warn(message: string): void }
}

/**
 * Cache the workspace principal's scope for disclosure decisions.
 *
 * The read happens when the credential changes and when the plugin starts. A management request
 * may also carry a fresher JWT through the DataOps gateway; that token replaces the in-memory
 * one before the gate decides, so a role change does not need a restart.
 */
export class ScopeResolver {
  private scope: DataOpsScope | undefined
  private token: string | undefined
  private inflight: Promise<void> | undefined
  private revision = 0
  private disposed = false

  constructor(private readonly ctx: Context, private readonly options: ResolverOptions) {}

  /** The last scope successfully read, for diagnostics. */
  current(): DataOpsScope | undefined {
    return this.scope
  }

  /** Whether the last scope holds IM administration. */
  isAdmin(): boolean {
    return isAdminScope(this.scope, this.options.policy)
  }

  /** Replace the in-memory token and re-read when it differs. */
  async adopt(token: string): Promise<void> {
    if (token === '') return
    if (this.token === token) return
    this.token = token
    await this.refresh(true)
  }

  /** Start from the stored credential when one exists. */
  async start(): Promise<void> {
    try {
      const stored = await this.ctx.credentials.resolve(credentialRef(this.options.credentialRef))
      if (stored?.value !== undefined) this.token = stored.value
    } catch {
      // A missing or unreadable credential means no usable scope; the next adoption retries.
    }
    await this.refresh(true)
  }

  /** Re-read the scope, coalescing concurrent callers unless `force` names a new token. */
  async refresh(force = false): Promise<void> {
    if (this.disposed) return
    if (this.inflight !== undefined && !force) return this.inflight
    const revision = ++this.revision
    const run = this.read()
      .then(scope => {
        if (this.disposed || revision !== this.revision) return
        this.scope = scope
      })
      .catch((error: unknown) => {
        // Transient failure keeps the last good answer; a never-read workspace stays closed.
        this.options.logger.warn(`dataops-im: scope refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (this.inflight === run) this.inflight = undefined
      })
    this.inflight = run
    return run
  }

  private async read(): Promise<DataOpsScope | undefined> {
    if (this.token === undefined || this.token === '') return undefined
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/api/ai/review/context`
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) {
      // 401/403 mean the credential is not usable; any other refusal is also a denial for this
      // disclosure decision. DataOps remains authoritative at every actual API call.
      return undefined
    }
    return normalizeScope(await response.json().catch(() => undefined))
  }

  /** Stop accepting late reads. */
  dispose(): void {
    this.disposed = true
    this.revision += 1
  }
}

/** Extract one Bearer token from a request header without logging it. */
export function bearerToken(headers: { get(name: string): string | null }): string | undefined {
  const authorization = headers.get('authorization')?.trim() ?? ''
  if (!authorization.startsWith('Bearer ')) return undefined
  const token = authorization.slice('Bearer '.length).trim()
  return token === '' ? undefined : token
}