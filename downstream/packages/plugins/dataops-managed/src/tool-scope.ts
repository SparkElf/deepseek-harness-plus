/**
 * Which DataOps tools this workspace's model may see.
 *
 * This module is disclosure, not authorization. DataOps remains the only authority for every
 * API call: its AuthGuard and PermissionGuard resolve the caller's current roles and grants,
 * and every managed tool call still crosses that boundary. What happens here is narrower — a
 * DSH workspace belongs to one DataOps principal, so the tool schemas offered to the model can
 * follow that principal's current scope instead of advertising operations the role cannot use.
 *
 * The scope is the answer `/api/ai/review/context` gives for the stored JWT. It is read when the
 * credential changes, on the first connect, and when the review-context route observes a new
 * role set — never inside a tool `execute`. A tool that is already registered and whose role
 * loses the capability is disposed by the manager.
 *
 * @module tool-scope
 */

/** The subset of `/api/ai/review/context` that tool disclosure needs. */
export interface DataOpsScope {
  /** Stable DataOps user id. */
  userId?: string
  /** Login name, used only for diagnostics. */
  username?: string
  /** Role display codes such as 超级管理员/管理员/部门管理员/应用人员. */
  roleCodes?: string[]
  /** The primary role code; DataOps normalizes it to one of the four portal roles. */
  primaryRole?: string
  /** Stable role keys such as SUPER_ADMIN, when the context carries them. */
  systemKeys?: string[]
  /** The caller's department, when one is assigned. */
  departmentCode?: string | null
  /**
   * Effective permission keys from every role the caller holds.
   *
   * `permissions` is the current backend field; `permissionKeys` is accepted while a deployment
   * still serves the older shape. A present but empty array is a denial, not a reason to fall
   * back to role names.
   */
  permissions?: string[]
  /** Older spelling of {@link permissions}. */
  permissionKeys?: string[]
  /** Data scope DataOps resolved for the caller. */
  dataScope?: { all?: boolean; self?: boolean; departmentCodes?: string[] }
  /** Review capability as the current context reports it (older nested shape). */
  review?: { canReview?: boolean; canReviewGlobal?: boolean; canManagePermissions?: boolean }
  /** Review capability as the current context reports it (top-level shape). */
  canReview?: boolean
  /** Whether the caller may review global (department-less) resources. */
  canReviewGlobal?: boolean
}

/** The permission each managed tool needs before it is offered to the model. */
export interface ToolAccessPolicy {
  /** One `skill:*` capability; checked against the context's effective permission list. */
  readonly permission?: string
  /** Review capability from the context, independent of a permission key. */
  readonly reviewer?: boolean
  /** Only the DataOps 超级管理员 role sees this tool. */
  readonly superAdminOnly?: boolean
  /** Super administrators and administrators see this tool; everyone else does not. */
  readonly adminOnly?: boolean
  /**
   * Connector capability that must be switched on for this tool to exist at all.
   *
   * The connector's row in the skill center owns this bit; the manager reconciles the whole group
   * when it changes, so a disabled capability removes its tools instead of leaving callable stubs
   * that fail at invocation time.
   */
  readonly capability?: ToolCapabilityId
  /** Fallback when the connector state has no explicit boolean for that capability. */
  readonly defaultEnabled?: boolean
}

/** Connector capability ids that gate a group of tools. */
export type ToolCapabilityId = 'resource.manage' | 'admin.manage'

/**
 * Tool-to-capability disclosure map.
 *
 * `review_notifications_list/read` intentionally carry no policy: every authenticated principal
 * owns their own notification inbox. `dataops_api_docs` is gated by the role itself because the
 * backend grants the OpenAPI reader to 超级管理员 by default; an administrator who happens to hold
 * `developer:openapi:read` is still outside that role and does not receive the tool.
 */
export const AI_TOOL_ACCESS = {
  skill_list: { permission: 'skill:read' },
  skill_get: { permission: 'skill:read' },
  skill_submit: { permission: 'skill:submit' },
  skill_install: { permission: 'skill:install' },
  skill_uninstall: { permission: 'skill:install' },
  skill_enable: { permission: 'skill:manage' },
  skill_disable: { permission: 'skill:manage' },
  skill_unshare: { permission: 'skill:manage' },
  skill_delete: { permission: 'skill:manage' },
  // 部门/管理员技能分配：工具只负责发起，DataOps 在每次调用时校验目标用户/部门是否在
  // 调用者的范围内（超管全部、管理员非超管、部门管理员本部门+子部门）。
  skill_install_for_user: { permission: 'skill:manage' },
  department_skill_bind: { permission: 'skill:manage' },
  department_skill_unbind: { permission: 'skill:manage' },
  department_skill_apply: { permission: 'skill:manage' },
  department_skill_preview: { permission: 'skill:manage' },
  review_scan: { permission: 'skill:read', reviewer: true },
  review_decide: { permission: 'skill:review:decide', reviewer: true },
  review_notifications_list: {},
  review_notifications_read: {},
  dataops_api_docs: { superAdminOnly: true },
  // 同义词组维护：全库生效，只对超管披露；真正的写权限由 DataOps AuthGuard 再判一次。
  synonym_group_list: { superAdminOnly: true },
  synonym_group_get: { superAdminOnly: true },
  synonym_group_create: { superAdminOnly: true },
  synonym_group_update: { superAdminOnly: true },
  synonym_group_delete: { superAdminOnly: true },
  // 后端 MCP 工作流工具：只向超管披露；模型侧名称是 mcp__<serverName>__<name>，
  // 由 declaredMcpToolName 映射回本表后参与会话级披露。
  workflow_query: { superAdminOnly: true },
  workflow_definition: { superAdminOnly: true },
  workflow_deployment: { superAdminOnly: true },
  workflow_run_control: { superAdminOnly: true },
  dataops_collect_preview: { permission: 'data:resource:manage' },
  dataops_collect_validate_plan: { permission: 'data:resource:manage' },
  dataops_collect_execute: { permission: 'data:resource:manage' },
  dataops_collect_resources: { permission: 'data:resource:read' },
  dataops_open_resource_tab: {},
  // 用户目录查询按后端 system:user:read 披露：管理员/部门管理员持有该权限，普通成员没有。
  // 真正的数据范围仍由 DataOps 的 AdminDataScopeService 在每次请求时收口。
  dataops_user_lookup: { permission: 'system:user:read' },
  // 建号与角色变更是中台管理动作，挂 admin.manage；adminOnly 把部门管理员排除在写操作之外。
  dataops_user_create: { capability: 'admin.manage', adminOnly: true, defaultEnabled: true },
  dataops_role_assign: { capability: 'admin.manage', adminOnly: true, defaultEnabled: true },
  dataops_resource_pending_list: { capability: 'resource.manage', adminOnly: true, defaultEnabled: true },
  dataops_resource_grant_list: { capability: 'resource.manage', adminOnly: true, defaultEnabled: true },
  dataops_resource_grant_batch: { capability: 'resource.manage', adminOnly: true, defaultEnabled: true },
  dataops_resource_approval_decide: { capability: 'resource.manage', adminOnly: true, defaultEnabled: true },
  dataops_resource_grant_revoke: { capability: 'resource.manage', adminOnly: true, defaultEnabled: true },
  // 超管代维：只在超管会话出现；真正的闸门在服务端与工具调用时的二次判定。
  admin_workspace_restart: { superAdminOnly: true },
  admin_workspace_tunnel_open: { superAdminOnly: true },
  admin_workspace_tunnel_revoke: { superAdminOnly: true },
} as const satisfies Record<string, ToolAccessPolicy>

/** Every managed tool name, in the order the manager considers them. */
export const AI_TOOL_NAMES = Object.keys(AI_TOOL_ACCESS) as AiToolName[]

/** One managed tool name. */
export type AiToolName = keyof typeof AI_TOOL_ACCESS

/**
 * The declared managed tool behind a namespaced MCP tool name.
 *
 * The MCP bridge publishes a server's raw tool as `mcp__<serverName>__<rawName>`. A raw name that
 * appears in {@link AI_TOOL_ACCESS} must reach the same disclosure rule as the plugin's own
 * `dataops_*` tools; an MCP tool this table does not name is not the table's to judge and stays
 * outside the filter.
 * @param publicName - the ToolRuntime name the MCP bridge registered.
 * @param serverName - the MCP server namespace from this plugin's config.
 * @returns the declared tool name, or undefined when the table says nothing about the tool.
 */
export function declaredMcpToolName(publicName: string, serverName: string): AiToolName | undefined {
  const prefix = `mcp__${serverName}__`
  if (!publicName.startsWith(prefix)) return undefined
  const rawName = publicName.slice(prefix.length)
  return Object.hasOwn(AI_TOOL_ACCESS, rawName) ? rawName as AiToolName : undefined
}

/**
 * Backend permission aliases.
 *
 * The DataOps role matrix stores the capability family as `skill:capability:*`; this task's
 * disclosure contract names them `skill:*`. Accepting both keeps the plugin working against
 * either spelling without asking the backend to rename a published key.
 */
const PERMISSION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'skill:read': ['skill:read', 'skill:capability:read'],
  'skill:submit': ['skill:submit', 'skill:capability:submit'],
  'skill:install': ['skill:install', 'skill:capability:install'],
  'skill:manage': ['skill:manage', 'skill:capability:manage'],
  'skill:review:decide': ['skill:review:decide'],
}

const SUPER_ADMIN = '超级管理员'
const ADMIN = '管理员'
const DEPARTMENT_ADMIN = '部门管理员'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined

const roleSet = (scope: DataOpsScope): Set<string> => new Set(scope.roleCodes ?? [])

/** Whether the context carries the stable super-administrator role. */
export const isSuperAdmin = (scope: DataOpsScope): boolean =>
  roleSet(scope).has(SUPER_ADMIN)
  || scope.primaryRole === SUPER_ADMIN
  || (scope.systemKeys ?? []).includes('SUPER_ADMIN')

/** Whether the context carries an administrator or super-administrator role. */
export const isAdmin = (scope: DataOpsScope): boolean =>
  isSuperAdmin(scope)
  || roleSet(scope).has(ADMIN)
  || scope.primaryRole === ADMIN
  || (scope.systemKeys ?? []).includes('ADMIN')

/** Whether the context carries a department-administrator role. */
export const isDepartmentAdmin = (scope: DataOpsScope): boolean =>
  roleSet(scope).has(DEPARTMENT_ADMIN)
  || scope.primaryRole === DEPARTMENT_ADMIN
  || (scope.systemKeys ?? []).includes('DEPT_ADMIN')

/**
 * Whether the caller may run review operations.
 *
 * The current backend returns `canReview` at the top level; the nested `review` shape is
 * accepted for older contexts. Role membership is a fallback, not an override.
 */
export const canReview = (scope: DataOpsScope): boolean =>
  scope.canReview === true
  || scope.review?.canReview === true
  || isAdmin(scope)
  || isDepartmentAdmin(scope)

/** The effective permission list, or `undefined` for a context that predates permission keys. */
const permissionList = (scope: DataOpsScope): string[] | undefined =>
  scope.permissions ?? scope.permissionKeys

/**
 * Whether the caller holds one capability.
 *
 * A context that carries a permission list is authoritative. Before the list existed, the
 * four-role fallback kept the old behavior; it is only used when neither spelling is present.
 */
export const hasPermission = (scope: DataOpsScope, key: string): boolean => {
  const permissions = permissionList(scope)
  if (permissions !== undefined) {
    const set = new Set(permissions)
    return (PERMISSION_ALIASES[key] ?? [key]).some(alias => set.has(alias))
  }
  if (isAdmin(scope)) return true
  if (isDepartmentAdmin(scope)) return key !== 'skill:review:global'
  // A caller with no role at all has no fallback capability set. Guessing the ordinary role
  // here would turn an uninterpretable context into a granted one.
  if (roleSet(scope).size === 0) return false
  return key === 'skill:read' || key === 'skill:install' || key === 'skill:submit'
}

/**
 * Whether one tool should be registered for this scope.
 *
 * Every check is disclosure metadata, not an execution gate: a visible tool still lets DataOps
 * answer with 403 when the underlying grant changed between a scope sync and the call.
 */
export function isToolCapabilityEnabled(
  name: AiToolName,
  state: { readonly enabled: boolean; readonly capabilities: Record<string, boolean> },
): boolean {
  const policy: ToolAccessPolicy = AI_TOOL_ACCESS[name]
  if (policy.capability === undefined) return true
  if (!state.enabled) return false
  return state.capabilities[policy.capability] ?? policy.defaultEnabled ?? false
}

/** Keys a group-chat Session may carry as its opaque `actor`. */
const ACTOR_KEYS = ['roleCodes', 'systemKeys', 'permissions', 'permissionKeys', 'primaryRole', 'userId'] as const

/**
 * Whether an opaque Session actor is a usable DataOps scope.
 *
 * `Session.actor` is untyped by design -- the base never interprets it -- so the connector has to
 * decide here. A value without any of the scope's identifying fields is not one of ours, and a
 * disclosure rule must then hide rather than fall through to the workspace's scope: the Session
 * belongs to someone else.
 * @param actor - the opaque value the Session carries.
 * @returns true when the actor can be read as a {@link DataOpsScope}.
 */
export function isScopeActor(actor: unknown): actor is DataOpsScope {
  return isRecord(actor) && ACTOR_KEYS.some(key => key in actor)
}

/**
 * Whether the model must not see one managed tool in this Session.
 *
 * A Session carrying a scope-like actor is a group-chat room acting for a member: the member's
 * own scope decides, never the workspace's. Otherwise the workspace scope applies, which is exactly
 * what the registration set was derived from, so an ordinary Session sees no change at all.
 * @param name - the registered tool name.
 * @param actor - `Session.actor`, or undefined outside a room.
 * @param workspaceScope - the scope the registration set was built from.
 * @returns true to hide the tool for this Session.
 */
/**
 * Whether a tool's access is declared at all.
 *
 * A tool without a policy was written for the workspace principal; a Session acting for a member
 * must not inherit it, so the disclosure rule treats "no declaration" as "not for visitors".
 * @param name - the registered tool name.
 * @returns true when the catalog states who may use the tool.
 */
export function declaresAccessPolicy(name: AiToolName): boolean {
  const policy: ToolAccessPolicy = AI_TOOL_ACCESS[name]
  return policy.superAdminOnly === true || policy.adminOnly === true
    || policy.reviewer === true || policy.permission !== undefined
}

export function sessionHidesTool(
  name: AiToolName,
  actor: unknown,
  workspaceScope: DataOpsScope | undefined,
): boolean {
  if (actor !== undefined) {
    // A Session acting for someone else is only shown tools whose access is declared: a tool with
    // no policy was written for the workspace principal, and a visitor must not inherit it.
    if (!declaresAccessPolicy(name)) return true
    return !isScopeActor(actor) || !isToolVisible(name, actor)
  }
  // No workspace scope yet means nothing was registered; if a name still reaches here it cannot be
  // shown, and saying so keeps the rule total.
  if (workspaceScope === undefined) return true
  return !isToolVisible(name, workspaceScope)
}

/**
 * Whether the model must not see one skill in this Session.
 *
 * A skill declares the permissions it needs in its frontmatter; the effective scope must hold all
 * of them. Skills without such a declaration are never claimed by the rule, so the plugin's own
 * connector gate stays the only thing that hides them.
 * @param permissions - `metadata.permissions` from the candidate, when the frontmatter carried it.
 * @param actor - `Session.actor`, or undefined outside a room.
 * @param workspaceScope - the scope the registration set was built from.
 * @returns true to hide the skill for this Session.
 */
/**
 * Read the permissions a skill's frontmatter declares.
 *
 * The candidate carries provider frontmatter as opaque `metadata`; only `permissions` is a
 * disclosure fact here. A malformed value is ignored rather than hidden: the plugin only claims
 * candidates it can read.
 * @param metadata - `SkillCandidate.metadata`, when the provider supplied one.
 * @returns the declared permission keys, or an empty list.
 */
export function skillPermissions(metadata: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  const value = metadata?.['permissions']
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

export function sessionHidesSkill(
  permissions: readonly string[],
  actor: unknown,
  workspaceScope: DataOpsScope | undefined,
): boolean {
  const effective = actor !== undefined ? (isScopeActor(actor) ? actor : undefined) : workspaceScope
  if (effective === undefined) return true
  // A Session acting for someone else sees a skill only when the skill declares what it needs and
  // the actor holds all of it; an undeclared skill was written for the workspace principal.
  if (actor !== undefined && permissions.length === 0) return true
  const held = new Set(permissionList(effective) ?? [])
  return !permissions.every(permission => held.has(permission))
}

export function isToolVisible(name: AiToolName, scope: DataOpsScope): boolean {
  const policy: ToolAccessPolicy = AI_TOOL_ACCESS[name]
  if (policy.superAdminOnly === true && !isSuperAdmin(scope)) return false
  if (policy.adminOnly === true && !isAdmin(scope)) return false
  if (policy.reviewer === true && !canReview(scope)) return false
  if (policy.permission !== undefined && !hasPermission(scope, policy.permission)) return false
  return true
}

/**
 * Validate one `/api/ai/review/context` body.
 *
 * A body without `roleCodes` is not a usable scope: treating it as "no roles" would let the
 * role-name fallback hand an ordinary capability set to an answer this plugin cannot interpret.
 * @param body - Parsed JSON from the context endpoint.
 * @returns The normalized scope, or undefined when the answer is not a context document.
 */
export function normalizeScope(body: unknown): DataOpsScope | undefined {
  if (!isRecord(body)) return undefined
  const roleCodes = strings(body.roleCodes)
  if (roleCodes === undefined) return undefined

  const roles = Array.isArray(body.roles) ? body.roles : []
  const roleSystemKeys = roles.flatMap((entry) => {
    if (!isRecord(entry)) return []
    return typeof entry.systemKey === 'string' ? [entry.systemKey] : []
  })
  const explicitSystemKeys = strings(body.systemKeys) ?? []
  const systemKeys = Array.from(new Set([...explicitSystemKeys, ...roleSystemKeys]))

  const permissions = strings(body.permissions)
    ?? (Array.isArray(body.permissionKeys) ? strings(body.permissionKeys) : undefined)

  const review = isRecord(body.review)
    ? {
      ...(typeof body.review.canReview === 'boolean' ? { canReview: body.review.canReview } : {}),
      ...(typeof body.review.canReviewGlobal === 'boolean' ? { canReviewGlobal: body.review.canReviewGlobal } : {}),
      ...(typeof body.review.canManagePermissions === 'boolean' ? { canManagePermissions: body.review.canManagePermissions } : {}),
    }
    : undefined

  return {
    ...(typeof body.userId === 'string' ? { userId: body.userId } : {}),
    ...(typeof body.username === 'string' ? { username: body.username } : {}),
    roleCodes,
    ...(typeof body.primaryRole === 'string' ? { primaryRole: body.primaryRole } : {}),
    ...(systemKeys.length === 0 ? {} : { systemKeys }),
    ...(typeof body.departmentCode === 'string' || body.departmentCode === null ? { departmentCode: body.departmentCode } : {}),
    ...(permissions === undefined ? {} : { permissions }),
    ...(isRecord(body.dataScope) ? { dataScope: body.dataScope as DataOpsScope['dataScope'] } : {}),
    ...(review === undefined ? {} : { review }),
    ...(typeof body.canReview === 'boolean' ? { canReview: body.canReview } : {}),
    ...(typeof body.canReviewGlobal === 'boolean' ? { canReviewGlobal: body.canReviewGlobal } : {}),
  } as DataOpsScope
}