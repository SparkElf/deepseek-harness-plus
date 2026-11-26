/**
 * Model-facing management tools for the knowledge base and the workflow plaza.
 *
 * The UI already exposes these operations. This module gives the model the same
 * operations without re-implementing authorization: which tools exist is decided
 * once from the caller's review context by `toolDisclosure.ts`, so a tool body does
 * not re-read the permission tree on every call. The context is still read where it
 * decides WHICH rows a visible tool may return (department scope, own audit trail)
 * and for the actor recorded in an audit line. Writes additionally require an
 * explicit human authorization flag, because a model deciding on its own must never
 * be indistinguishable from an operator approving a review.
 *
 * DataOps remains the final authority: every host call below reaches a backend
 * route that enforces the JWT's current roles and grants, so a stale disclosure can
 * cause a refusal but never an unauthorized operation.
 *
 * Secrets are write-only through the UI; these tools deliberately reject secret-shaped
 * fields and redact them on reads.
 *
 * @module @sparkelf/dsh-knowledge-base/managementTools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** A structured refusal the model can act on. */
export class ManagementToolError extends Error {
  override readonly name = 'ManagementToolError'

  constructor(
    readonly code: 'forbidden' | 'invalid' | 'not-found' | 'backend',
    message: string,
  ) {
    super(message)
  }
}

/** The backend's review context, narrowed to the fields these tools use. */
export interface ManagementContext {
  readonly userId: string
  readonly username?: string
  readonly displayName?: string
  readonly primaryRole?: string
  readonly roleCodes: readonly string[]
  /** Backend DSH permission keys resolved for the caller's roles. */
  readonly permissions: readonly string[]
  readonly departmentCode?: string | null
  readonly departmentPathCodes?: readonly string[]
  readonly dataScope: {
    readonly all: boolean
    readonly self: boolean
    readonly departmentCodes: readonly string[]
  }
  readonly review: {
    readonly canReview: boolean
    readonly canReviewGlobal: boolean
    readonly canManagePermissions: boolean
    readonly departments: readonly string[]
  }
}

/** One grant row as the host reports it. */
export interface ManagementGrant {
  readonly id?: string
  readonly relPath: string
  readonly kind?: string
  readonly principalType?: string
  readonly principalId?: string
  readonly action?: string
  readonly grantedBy?: string
  readonly grantedAt?: string
}

/** One audit entry. */
export interface ManagementAudit {
  readonly at: string
  readonly actor: string
  readonly actorLabel?: string
  readonly action: string
  readonly relPath?: string
  readonly outcome?: string
}

/** One KB pending submission. */
export interface ManagementPending {
  readonly name: string
  readonly userId: string
  readonly relPath: string
  readonly at: string
  readonly bytes: number
}

/** One workflow row shared by the public and review lists. */
export interface ManagementWorkflow {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly instruction?: string
  readonly cronHint?: string | null
  readonly category?: string | null
  readonly reviewStatus?: string
  readonly visibility?: string
  readonly departmentCode?: string | null
  readonly ownerId?: string
  readonly ownerName?: string
  readonly sourceSessionId?: string | null
  readonly builtIn?: boolean
}

/** One visible bucket. */
export interface ManagementBucket {
  readonly name: string
  readonly visibility: string
  readonly departmentCode?: string | null
  readonly writable?: boolean
}

/** The host operations tools compose. */
export interface ManagementToolHost {
  context(): Promise<ManagementContext>
  kbConfigGet(): Promise<Record<string, unknown>>
  kbConfigUpdate(patch: Record<string, unknown>): Promise<Record<string, unknown>>
  kbGrantList(): Promise<readonly ManagementGrant[]>
  kbGrantSet(input: {
    relPath: string
    principalType: string
    principalId: string
    action: string
  }): Promise<ManagementGrant>
  kbAuditList(filter: {
    action?: string
    actor?: string
    path?: string
    from?: string
    to?: string
    limit?: number
  }): Promise<readonly ManagementAudit[]>
  kbReviewList(): Promise<readonly ManagementPending[]>
  kbReviewDecide(input: { name: string; decision: 'approve' | 'reject'; note?: string }): Promise<unknown>
  kbSync(): Promise<unknown>
  kbIndexRebuild(): Promise<unknown>
  kbBucketList(): Promise<readonly ManagementBucket[]>
  workflowList(query: { scope?: string; status?: string }): Promise<readonly ManagementWorkflow[]>
  workflowUpdate(input: Record<string, unknown>): Promise<unknown>
  workflowUnpublish(id: string): Promise<unknown>
  workflowReviewList(query: { status?: string; scope?: string; departmentCode?: string }): Promise<readonly ManagementWorkflow[]>
  workflowReviewScan(ids: readonly string[]): Promise<unknown>
  workflowReviewDecide(input: {
    ids: readonly string[]
    decision: 'approve' | 'reject'
    note?: string
  }): Promise<unknown>
}

type Capability = 'global' | 'reviewer' | 'reader'

const forbidden = (message: string): never => { throw new ManagementToolError('forbidden', message) }

/** Role defaults used only when the permission matrix cannot be read (e.g. APP_USER). */
export const DEFAULT_DSH_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  SUPER_ADMIN: [
    'kb:file:read', 'kb:file:write', 'kb:file:delete', 'kb:file:extract', 'kb:audit:read',
    'kb:grant:manage', 'kb:review:decide', 'kb:config:manage', 'workflow:read', 'workflow:publish',
    'workflow:manage', 'workflow:review:decide', 'workflow:review:global',
  ],
  ADMIN: [
    'kb:file:read', 'kb:file:write', 'kb:file:delete', 'kb:file:extract', 'kb:audit:read',
    'kb:grant:manage', 'kb:review:decide', 'kb:config:manage', 'workflow:read', 'workflow:publish',
    'workflow:manage', 'workflow:review:decide', 'workflow:review:global',
  ],
  DEPT_ADMIN: [
    'kb:file:read', 'kb:file:write', 'kb:file:delete', 'kb:file:extract', 'kb:audit:read',
    'kb:grant:manage', 'kb:review:decide', 'workflow:read', 'workflow:publish',
    'workflow:manage', 'workflow:review:decide',
  ],
  APP_USER: [
    'kb:file:read', 'kb:file:write', 'kb:file:delete', 'kb:file:extract',
    'workflow:read', 'workflow:publish',
  ],
}

/** Union the default permission keys for a set of role system keys. */
export function defaultPermissionsForRoles(roleKeys: readonly string[]): string[] {
  return [...new Set(roleKeys.flatMap(key => DEFAULT_DSH_PERMISSIONS[key] ?? []))]
}

/** True when the caller holds one backend permission key. */
export function hasPermission(context: ManagementContext, permission: string): boolean {
  return context.permissions.includes(permission)
}

/** Global administrators: all resources and all review queues. */
export function isGlobalAdmin(context: ManagementContext): boolean {
  return context.review.canReviewGlobal === true
    || context.dataScope.all === true
    || context.roleCodes.some(code => code === 'SUPER_ADMIN' || code === 'ADMIN')
}

/** Department reviewers: their department and its descendants. */
export function isDepartmentReviewer(context: ManagementContext): boolean {
  return !isGlobalAdmin(context)
    && context.review.canReview === true
    && context.review.departments.length > 0
}

/** Require one capability; throws a structured 403 rather than returning false. */
export function requireCapability(context: ManagementContext, capability: Capability): void {
  if (capability === 'reader') return
  if (capability === 'reviewer') {
    if (context.review.canReview === true || isGlobalAdmin(context)) return
    forbidden('当前账号没有审核权限。')
  }
  if (!isGlobalAdmin(context)) forbidden('只有管理员/超级管理员可以执行此操作。')
}

/** True when a path belongs to one of the caller's departments. */
export function isPathInDepartmentScope(
  context: ManagementContext,
  relPath: string,
): boolean {
  if (isGlobalAdmin(context)) return true
  const normalized = relPath.replace(/^\/+/u, '')
  return context.review.departments.some(code => {
    const prefix = `department/${code}`
    return normalized === prefix || normalized.startsWith(prefix + '/')
  })
}

/** Require department scope for one path; global admins bypass. */
export function requirePathScope(context: ManagementContext, relPath: string): void {
  if (!isPathInDepartmentScope(context, relPath)) {
    forbidden(`路径不在当前部门管理范围内：${relPath}`)
  }
}

/** Publishing scope the workflow tool accepts. */
export type WorkflowPublishVisibility = 'global' | 'department' | 'private'

/**
 * Normalize and authorize a publish scope.
 *
 * Ordinary users and department admins may only publish inside their own department
 * (or privately); global visibility is reserved for platform admins. A department
 * administrator cannot name a child/other department here even though review visibility
 * can include descendants.
 */
export function normalizePublishScope(
  context: ManagementContext,
  visibility: WorkflowPublishVisibility | undefined,
  departmentCode: string | undefined,
): { visibility: WorkflowPublishVisibility; departmentCode: string } {
  const scope = visibility ?? 'private'
  if (scope !== 'global' && scope !== 'department' && scope !== 'private') {
    throw new ManagementToolError('invalid', 'visibility must be global, department or private')
  }
  if (scope === 'global' && !isGlobalAdmin(context)) {
    throw new ManagementToolError('forbidden', '只有管理员/超级管理员可以发布全局工作流。')
  }
  if (scope !== 'department') return { visibility: scope, departmentCode: '' }
  const department = (departmentCode ?? context.departmentCode ?? '').trim()
  if (department === '') throw new ManagementToolError('invalid', 'department 可见必须指定 departmentCode')
  if (!isGlobalAdmin(context) && department !== context.departmentCode) {
    throw new ManagementToolError('forbidden', '普通用户/部门管理员只能发布到自己的部门。')
  }
  return { visibility: scope, departmentCode: department }
}

/** Writes require an explicit human confirmation. */
export function requireConfirmed(value: unknown): void {
  const authorization = value as { confirmed?: unknown } | undefined
  if (authorization?.confirmed !== true) {
    forbidden('写操作必须携带 authorization.confirmed=true（人工授权）')
  }
}

/** A secret-shaped field name the tools refuse to accept. */
const SECRET_KEY = /(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|private[-_]?key)/iu

/** Refuse an object carrying a secret-shaped field. */
export function assertNoSecretFields(value: unknown, path = 'body'): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => { assertNoSecretFields(item, `${path}[${String(index)}]`) })
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      throw new ManagementToolError('invalid', `不接收明文密钥字段：${path}.${key}`)
    }
    assertNoSecretFields(child, `${path}.${key}`)
  }
}

/** Redact secret-shaped values on reads. */
export function redactSecrets<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => redactSecrets(item)) as T
  const copy: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = SECRET_KEY.test(key) ? '***' : redactSecrets(child)
  }
  return copy as T
}

const jsonOutput = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: JSON.stringify(value, null, 2),
  }],
}

const run = async (operation: () => Promise<unknown>): Promise<Record<string, any>> => {
  try {
    return await operation() as Record<string, any>
  } catch (error) {
    if (error instanceof ManagementToolError) throw error
    if ((error as { code?: unknown }).code === 'unauthorized') {
      throw new ManagementToolError('forbidden', error instanceof Error ? error.message : 'access denied')
    }
    if ((error as { code?: unknown }).code === 'not-found') {
      throw new ManagementToolError('not-found', error instanceof Error ? error.message : 'not found')
    }
    throw new ManagementToolError('backend', error instanceof Error ? error.message : String(error))
  }
}

const AUTHORIZATION = {
  type: 'object',
  required: true,
  description: 'Human authorization for a write: {confirmed:true, reason?:string}.',
  additionalProperties: false,
  properties: {
    confirmed: { type: 'boolean', required: true, description: 'Must be true; the model cannot invent this.' },
    reason: { type: 'string', description: 'Why the operator authorized the write.' },
  },
} as const

/** Build all management tools. */
export const createManagementTools = (host: ManagementToolHost) => [
  defineTool({
    name: 'kb_config_get',
    description: 'Read the knowledge-base deployment configuration (storage/mount/review switches). Secrets are redacted. 仅超管/管理员。',
    parameters: {},
    output: jsonOutput,
    execute: async () => run(async () => {
      return { config: redactSecrets(await host.kbConfigGet()) }
    }),
  }),
  defineTool({
    name: 'kb_config_update',
    description: 'Update knowledge-base storage/review settings. Requires authorization.confirmed and global-admin scope; secret fields are refused.',
    parameters: {
      patch: { type: 'object', required: true, additionalProperties: true, description: 'Fields to update, e.g. {reviewRequired:true, storageMode:"local"}.' },
      authorization: AUTHORIZATION,
    },
    output: jsonOutput,
    execute: async (args: { patch: Record<string, unknown>; authorization?: unknown }) => run(async () => {
      requireConfirmed(args.authorization)
      assertNoSecretFields(args.patch)
      return { config: redactSecrets(await host.kbConfigUpdate(args.patch)) }
    }),
  }),
  defineTool({
    name: 'kb_grant_list',
    description: 'List knowledge-base grants. Global admins see all; department admins only their department paths; others 403.',
    parameters: {},
    output: jsonOutput,
    execute: async () => run(async () => {
      // The context decides WHICH grants this caller may see; existence of the
      // tool itself was decided at registration.
      const context = await host.context()
      const grants = await host.kbGrantList()
      const visible = isGlobalAdmin(context)
        ? grants
        : grants.filter(grant => isPathInDepartmentScope(context, grant.relPath))
      return { grants: visible }
    }),
  }),
  defineTool({
    name: 'kb_grant_set',
    description: 'Create or update one knowledge-base grant. Department admins are limited to department/<their code>/ paths. Requires authorization.confirmed.',
    parameters: {
      relPath: { type: 'string', required: true, description: 'View-relative path to grant.' },
      principalType: { type: 'string', required: true, description: 'user | department | role | group.' },
      principalId: { type: 'string', required: true, description: 'Principal id/code.' },
      action: { type: 'string', required: true, description: 'read | write | manage | share | delete.' },
      authorization: AUTHORIZATION,
    },
    output: jsonOutput,
    execute: async (args: {
      relPath: string
      principalType: string
      principalId: string
      action: string
      authorization?: unknown
    }) => run(async () => {
      const context = await host.context()
      requirePathScope(context, args.relPath)
      requireConfirmed(args.authorization)
      if (args.relPath.trim() === '' || args.principalId.trim() === '') {
        throw new ManagementToolError('invalid', 'relPath and principalId are required')
      }
      return { grant: await host.kbGrantSet(args) }
    }),
  }),
  defineTool({
    name: 'kb_audit_list',
    description: 'List knowledge-base audit entries. Global admins see all; department admins only their department paths; ordinary users only their own trail.',
    parameters: {
      action: { type: 'string', description: 'Filter by action, e.g. create/edit/delete/approve.' },
      actor: { type: 'string', description: 'Filter by actor id or label.' },
      path: { type: 'string', description: 'Filter by view-relative path substring.' },
      from: { type: 'string', description: 'ISO timestamp lower bound.' },
      to: { type: 'string', description: 'ISO timestamp upper bound.' },
      limit: { type: 'number', description: 'Maximum rows (default 100, max 500).' },
    },
    output: jsonOutput,
    execute: async (args: { action?: string; actor?: string; path?: string; from?: string; to?: string; limit?: number }) => run(async () => {
      // Scope the returned rows to what this caller may read; the tool's own
      // existence was decided from `kb:audit:read` at registration.
      const context = await host.context()
      const entries = await host.kbAuditList({
        ...args,
        limit: Math.max(1, Math.min(500, args.limit ?? 100)),
      })
      const scoped = isGlobalAdmin(context)
        ? entries
        : context.review.departments.length > 0
          ? entries.filter(entry => entry.relPath !== undefined && isPathInDepartmentScope(context, entry.relPath))
          : entries.filter(entry => entry.actor === context.userId)
      return { entries: scoped.slice(0, Math.max(1, Math.min(500, args.limit ?? 100))) }
    }),
  }),
  defineTool({
    name: 'kb_review_list',
    description: 'List knowledge-base submissions waiting for review. Department admins see only their department paths; ordinary users are refused.',
    parameters: {},
    output: jsonOutput,
    execute: async () => run(async () => {
      // Department scope filters the queue; the reviewer capability was proven at
      // registration.
      const context = await host.context()
      const pending = await host.kbReviewList()
      const visible = isGlobalAdmin(context)
        ? pending
        : pending.filter(item => isPathInDepartmentScope(context, item.relPath))
      return { pending: visible }
    }),
  }),
  defineTool({
    name: 'kb_review_decide',
    description: 'Approve or reject one knowledge-base pending submission. Requires reviewer scope + authorization.confirmed; department admins cannot decide outside their department.',
    parameters: {
      name: { type: 'string', required: true, description: 'Pending submission name from kb_review_list.' },
      decision: { type: 'string', required: true, description: 'approve | reject' },
      note: { type: 'string', description: 'Review note/rejection reason.' },
      authorization: AUTHORIZATION,
    },
    output: jsonOutput,
    execute: async (args: { name: string; decision: string; note?: string; authorization?: unknown }) => run(async () => {
      const context = await host.context()
      requireConfirmed(args.authorization)
      if (args.decision !== 'approve' && args.decision !== 'reject') {
        throw new ManagementToolError('invalid', 'decision must be approve or reject')
      }
      const pending = await host.kbReviewList()
      const target = pending.find(item => item.name === args.name)
      if (target === undefined) throw new ManagementToolError('not-found', `no pending submission ${args.name}`)
      requirePathScope(context, target.relPath)
      return host.kbReviewDecide({ name: args.name, decision: args.decision, note: args.note })
    }),
  }),
  defineTool({
    name: 'kb_sync',
    description: 'Refresh the caller-visible knowledge view from grants and return the sync result. Admin/reviewer only.',
    parameters: {},
    output: jsonOutput,
    execute: async () => run(async () => {
      return { sync: await host.kbSync() }
    }),
  }),
  defineTool({
    name: 'kb_index_rebuild',
    description: 'Rebuild/refresh the knowledge index for the current view and report visible file counts. Global admin only.',
    parameters: {},
    output: jsonOutput,
    execute: async () => run(async () => {
      return { index: await host.kbIndexRebuild() }
    }),
  }),
  defineTool({
    name: 'workflow_list',
    description: 'List workflow-plaza items: built-in + approved + the caller’s own pending. Scope is server-enforced.',
    parameters: {
      scope: { type: 'string', description: 'mine | department | all (default: server decides).' },
      status: { type: 'string', description: 'pending | approved | rejected.' },
    },
    output: jsonOutput,
    execute: async (args: { scope?: string; status?: string }) => run(async () => {
      return { workflows: await host.workflowList(args) }
    }),
  }),
  defineTool({
    name: 'workflow_update',
    description: 'Update a workflow in place (same id) when the caller owns it or an admin manages it. Requires authorization.confirmed; review-on resets the row to pending.',
    parameters: {
      id: { type: 'string', required: true, description: 'Workflow id.' },
      title: { type: 'string', description: 'New title.' },
      description: { type: 'string', description: 'New description.' },
      instruction: { type: 'string', description: 'New standing instruction.' },
      cronHint: { type: 'string', description: 'New cron hint.' },
      category: { type: 'string', description: 'New category.' },
      authorization: AUTHORIZATION,
    },
    output: jsonOutput,
    execute: async (args: Record<string, unknown>) => run(async () => {
      requireConfirmed(args.authorization)
      return { workflow: await host.workflowUpdate(args) }
    }),
  }),
  defineTool({
    name: 'workflow_unpublish',
    description: 'Unpublish a workflow (owner or admin). Requires authorization.confirmed.',
    parameters: {
      id: { type: 'string', required: true, description: 'Workflow id.' },
      authorization: AUTHORIZATION,
    },
    output: jsonOutput,
    execute: async (args: { id: string; authorization?: unknown }) => run(async () => {
      requireConfirmed(args.authorization)
      return { result: await host.workflowUnpublish(args.id) }
    }),
  }),
  defineTool({
    name: 'workflow_review_list',
    description: 'List workflow publications for review. Global admins see all; department admins only their department scope.',
    parameters: {
      status: { type: 'string', description: 'pending | approved | rejected.' },
      scope: { type: 'string', description: 'mine | department | all.' },
      departmentCode: { type: 'string', description: 'Optional department filter.' },
    },
    output: jsonOutput,
    execute: async (args: { status?: string; scope?: string; departmentCode?: string }) => run(async () => {
      return { workflows: await host.workflowReviewList(args) }
    }),
  }),
  defineTool({
    name: 'workflow_review_scan',
    description: 'Run the AI risk scan on workflow ids (prompt injection/credentials/destructive actions/data exfiltration/scope). Reviewer only; does not decide.',
    parameters: {
      ids: { type: 'array', required: true, description: 'Workflow ids to scan.' },
    },
    output: jsonOutput,
    execute: async (args: { ids: string[] }) => run(async () => {
      if (!Array.isArray(args.ids) || args.ids.length === 0) throw new ManagementToolError('invalid', 'ids is required')
      return { scan: await host.workflowReviewScan(args.ids) }
    }),
  }),
  defineTool({
    name: 'workflow_review_decide',
    description: 'Approve or reject workflow publications. Requires reviewer scope + authorization.confirmed; department admins cannot decide outside their department.',
    parameters: {
      ids: { type: 'array', required: true, description: 'Workflow ids to decide.' },
      decision: { type: 'string', required: true, description: 'approve | reject' },
      note: { type: 'string', description: 'Review note/rejection reason.' },
      authorization: AUTHORIZATION,
    },
    output: jsonOutput,
    execute: async (args: { ids: unknown[]; decision: string; note?: string; authorization?: unknown }) => run(async () => {
      requireConfirmed(args.authorization)
      if (args.decision !== 'approve' && args.decision !== 'reject') {
        throw new ManagementToolError('invalid', 'decision must be approve or reject')
      }
      const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === 'string' && id !== '') : []
      if (ids.length === 0) throw new ManagementToolError('invalid', 'ids is required')
      return { decision: await host.workflowReviewDecide({ ids, decision: args.decision, note: args.note }) }
    }),
  }),
]
