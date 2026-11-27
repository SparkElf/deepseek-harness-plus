/**
 * Model tools for the skill centre, the shared review queues, and the DataOps API reference.
 *
 * Registration is disclosure, not authorization. `AiToolManager` computes the workspace's
 * current DataOps scope once per credential/role sync and registers only the tools that scope
 * can use; these definitions assume they were registered for a principal that may call them.
 * Every `execute` therefore validates parameters, asks for user approval where a mutation needs
 * it, writes its audit line, and lets DataOps answer — no per-call role read, no local permission
 * tree, and no replacement for the backend's AuthGuard/PermissionGuard.
 *
 * The skill plaza is the catalogue. `scope=mine` exposes the caller's pending/rejected rows,
 * the public list exposes what the caller may install, and the admin list (administrators only)
 * exposes disabled entries. Installation, sharing and deletion are deliberately three different
 * actions: uninstall removes only the caller's installation, unshare unpublishes the shared entry
 * (with an unpublished notification), and delete permanently removes the entry after a second
 * confirmation, with its own deleted notification and audit trail.
 *
 * @module tools
 */

import { randomBytes } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ReviewApi } from './review-api.ts'
import { CollectApi } from './collect-api.ts'
import { ResourceManagementApi } from './resource-management-api.ts'
import type { OpenResourceHub } from './resource-tab.ts'
import { readLocalSkills } from './skill-plaza.ts'
import { ApiDocsUnavailableError, searchOpenApiDocument, type ApiDocsFilters } from './api-docs.ts'
import { OPEN_OBJECT_SCHEMA, renderJson, type Json } from './tool-output.ts'
import {
  canReview,
  isAdmin,
  isDepartmentAdmin,
  type AiToolName,
  type DataOpsScope,
} from './tool-scope.ts'

/** One managed tool together with the name the disclosure map uses. */
export interface AiManagedTool {
  name: AiToolName
  definition: ToolDefinition
}

/** Parse one plaza response body into rows without trusting its shape. */
function rowsOf(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
  if (typeof body === 'object' && body !== null && Array.isArray((body as { skills?: unknown }).skills)) {
    return ((body as { skills: unknown[] }).skills).filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
  }
  return []
}

const forbidden = (message: string): Error => new Error('Forbidden (403): ' + message)

/** Validate one plaza skill id before a provisioning call. */
const provisioningSkillId = (tool: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(tool + ': skill_id must be a positive integer')
  return value
}

/**
 * Normalize one explicit user list for a provisioning call.
 *
 * DataOps user ids are UUID strings, and the provisioning endpoints take a batch. An empty or
 * malformed list is a caller error: forwarding it would either match nobody or let the backend
 * answer a scope the caller never named, so it never reaches the API.
 */
const provisioningUserIds = (tool: string, values: readonly unknown[] | undefined): string[] => {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(tool + ': user_ids must be a non-empty array of DataOps user ids')
  }
  const ids = values.map(value => typeof value === 'string' ? value.trim() : '')
  if (ids.some(id => id === '')) throw new Error(tool + ': user_ids must contain non-empty DataOps user ids')
  return Array.from(new Set(ids))
}

/** Read one required department code from tool arguments. */
const provisioningDepartmentCode = (tool: string, value: string | undefined): string => {
  const code = typeof value === 'string' ? value.trim() : ''
  if (code === '') throw new Error(tool + ': department_code is required')
  return code
}

/**
 * Roles a tool-created account receives.
 *
 * This is the same minimal set the IM private-chat auto-provision path writes: an ordinary
 * member, the basic data-security tier, and the admission role that lets the account open its
 * AI workspace. None of them carries a business capability or a resource grant.
 */
const PROVISIONED_USER_ROLES = ['应用人员', '初级权限', 'AI 工作区成员'] as const

/** The one role this tool set never assigns or removes; super-admin changes stay in the console. */
const SUPER_ADMIN_ROLE = '超级管理员'

/** The department a provisioned account lands in until an administrator assigns one. */
const PROVISIONED_DEPARTMENT = 'unassigned'

/** Trim one optional string argument; a non-string becomes the empty string. */
const textArg = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

/** Digits only, used to compare phone numbers written with separators or a country code. */
const phoneDigits = (value: string): string => value.replace(/\D+/gu, '')

/** Case-insensitive exact match helper for usernames and emails. */
const sameText = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase()

/** The comparable form the backend's password policy uses for account tokens. */
const comparable = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/gu, '')

/**
 * Generate an initial password the backend's strong-password policy accepts.
 *
 * The value is returned once in the tool result for immediate hand-off, and is never written to
 * audit logs or plugin logs. The caller must treat the result as sensitive: DSH session history
 * may retain tool output, so the account should change this password after first sign-in.
 * @param context - account fields the policy rejects when the password embeds them.
 */
const generatedInitialPassword = (context: { username: string; displayName: string; email: string }): string => {
  const localPart = context.email.includes('@') ? context.email.split('@')[0] ?? '' : context.email
  const tokens = [context.username, context.displayName, localPart]
    .map(token => comparable(token))
    .filter(token => token.length >= 3)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = 'Aa1!' + randomBytes(32).toString('base64url')
    const comparableCandidate = comparable(candidate)
    if (tokens.every(token => !comparableCandidate.includes(token))) return candidate
  }
  // A 20-attempt collision is effectively impossible for random 32-byte material; keeping a
  // deterministic class-complete fallback means creation never fails for a password-policy reason.
  return 'Aa1!' + randomBytes(48).toString('hex') + 'Zz9!'
}

/** One user row projected to the fields the lookup contract promises, never password material. */
const projectUserRow = (row: Record<string, unknown>): Record<string, Json> => {
  const department = typeof row.department === 'object' && row.department !== null
    ? row.department as Record<string, unknown>
    : {}
  const departmentCode = textArg(department.code)
  const roles = Array.isArray(row.roles)
    ? row.roles.flatMap((role) => {
      if (typeof role !== 'object' || role === null) return []
      const entry = role as Record<string, unknown>
      const code = textArg(entry.code)
      if (code === '') return []
      return [{ code, name: textArg(entry.name) || code }]
    })
    : []
  return {
    id: textArg(row.id),
    username: textArg(row.username),
    displayName: textArg(row.displayName),
    email: textArg(row.email),
    mobile: textArg(row.phone) || null,
    enabled: row.enabled === true,
    departments: departmentCode === '' ? [] : [{ code: departmentCode, name: textArg(department.name) || departmentCode }],
    roles,
  }
}

/** Read one user row from a DataOps response body without trusting its shape. */
const userRowOf = (body: unknown): Record<string, unknown> | undefined => {
  if (typeof body !== 'object' || body === null) return undefined
  const user = (body as { user?: unknown }).user
  return typeof user === 'object' && user !== null && !Array.isArray(user)
    ? user as Record<string, unknown>
    : undefined
}

/**
 * Build every managed tool definition.
 *
 * The definitions are built once; `readScope` is a live getter so a tool that survives a role
 * change reports the scope the manager currently holds instead of the one it was registered
 * with. An undefined scope can only be observed by an in-flight call during disposal, where the
 * safe behavior is to show only the public catalogue.
 * @param ctx - Host context used for local skills, approval and audit.
 * @param reviewApi - Same-origin bridge holding the workspace JWT.
 * @param readScope - Live accessor for the manager's current scope.
 * @returns One definition per managed tool name.
 */
export function buildAiManagementTools(
  ctx: Context,
  reviewApi: ReviewApi,
  readScope: () => DataOpsScope | undefined,
  collectHub: OpenResourceHub,
): AiManagedTool[] {
  const collectApi = new CollectApi(reviewApi)
  const resourceManagementApi = new ResourceManagementApi(reviewApi)
  const approve = async (tool: string, exec: ToolRunContext, reason: string): Promise<void> => {
    if (exec.agent === undefined) throw new Error(tool + ' requires an initiating agent')
    const approval = (ctx as unknown as { approval: { request(input: { agent: unknown; toolName: string; callId: string; signal: AbortSignal; reason: string }): Promise<string> } }).approval
    const outcome = await approval.request({ agent: exec.agent, toolName: tool, callId: exec.callId, signal: exec.signal, reason })
    if (outcome !== 'allowed-once') throw new Error(tool + ' approval was ' + outcome)
  }
  const audit = (tool: string, exec: ToolRunContext, detail: Record<string, unknown>): void => {
    try {
      const agent = exec.agent as { session?: { id?: string } } | undefined
      ctx.logger.info('[audit] ' + tool + ' ' + JSON.stringify({ sessionId: agent?.session?.id ?? null, callId: exec.callId, ...detail }))
    } catch { /* audit must not fail the tool */ }
  }
  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const result = await reviewApi.request(path, init)
    if (result.status === 401) throw new Error('Unauthorized (401): DataOps session expired')
    const detail = (result.body as { error?: unknown; message?: unknown } | null)
    const reason = typeof detail?.error === 'string' ? detail.error : typeof detail?.message === 'string' ? detail.message : ''
    if (result.status === 403) throw forbidden(reason || 'the current role may not perform this action')
    if (result.status === 409) throw new Error('Conflict (409): ' + (reason || 'the skill still has installations'))
    if (result.status < 200 || result.status >= 300) throw new Error('DataOps ' + path + ' failed: HTTP ' + result.status.toString() + (reason ? ': ' + reason : ''))
    return result.body
  }

  const listSkills = async (scope: DataOpsScope, includeLocal: boolean): Promise<Record<string, unknown>> => {
    const mine = rowsOf(await call('/api/ai/skill-plaza/skills?scope=mine'))
    const publicRows = rowsOf(await call('/api/ai/skill-plaza/skills'))
    const admin = isAdmin(scope) ? rowsOf(await call('/api/ai/skill-plaza/admin/skills')) : []
    const byId = new Map<number, Record<string, unknown>>()
    for (const row of [...mine, ...publicRows, ...admin]) if (typeof row.id === 'number') byId.set(row.id, { ...byId.get(row.id), ...row })
    const rows = [...byId.values()]
    const local = includeLocal ? (await readLocalSkills(ctx)).map(skill => ({ name: skill.name, description: skill.description ?? null, source: 'local' })) : []
    const catalog = {
      local,
      pending: rows.filter(row => row.reviewStatus === 'pending'),
      approved: rows.filter(row => row.reviewStatus === 'approved'),
      rejected: rows.filter(row => row.reviewStatus === 'rejected'),
    }
    return { catalog, canReview: canReview(scope), isAdmin: isAdmin(scope), isDepartmentAdmin: isDepartmentAdmin(scope), departmentCode: scope.departmentCode ?? null, skills: rows }
  }

  /**
   * Build the enable/disable pair.
   *
   * The two tools share one body so their approval reason, audit detail and endpoint stay in
   * step; only the verb and the boolean they send differ.
   */
  function defineSkillStatusTool(enabled: boolean): ToolDefinition {
    const name = enabled ? 'skill_enable' : 'skill_disable'
    return defineTool({
      name,
      description: (enabled ? 'Enable' : 'Disable') + ' one plaza skill for distribution. Administrator only. Requires user approval; audited.',
      parameters: { skill_id: { type: 'number', required: true, description: 'Plaza skill id.' } },
      output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
      execute: async (args: { skill_id: number }, exec) => {
        await approve(name, exec, (enabled ? 'Enable' : 'Disable') + ' skill ' + args.skill_id.toString())
        await call('/api/ai/skill-plaza/admin/skills/' + args.skill_id.toString() + '/status', { method: 'PATCH', body: JSON.stringify({ enabled }) })
        audit(name, exec, { skillId: args.skill_id, enabled })
        return { skillId: args.skill_id, enabled }
      },
    })
  }

  const parseJsonObject = (tool: string, label: string, value: string | undefined): Record<string, unknown> | undefined => {
    if (value === undefined || value.trim() === '') return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new Error(tool + ': ' + label + ' must be valid JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(tool + ': ' + label + ' must be a JSON object')
    }
    return parsed as Record<string, unknown>
  }

  const parseJsonArray = (tool: string, label: string, value: string | undefined): unknown[] => {
    if (value === undefined || value.trim() === '') return []
    let parsed: unknown
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new Error(tool + ': ' + label + ' must be valid JSON')
    }
    if (!Array.isArray(parsed)) throw new Error(tool + ': ' + label + ' must be a JSON array')
    return parsed
  }

  /**
   * Keep only the fields the DataOps execute/validate DTOs accept. The validated plan
   * carries `createSql`/`targetSchema`/`notes` beside `createTable`; if the model passes
   * the whole plan (or rebuilds it after a table-name edit), the backend's
   * `forbidNonWhitelisted` pipe rejects the call with a generic 400.
   */
  const normalizeCreatePlan = (
    tool: string,
    plan: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined => {
    if (plan === undefined) return undefined
    const tableName = typeof plan.tableName === 'string' ? plan.tableName.trim() : ''
    if (!tableName) throw new Error(tool + ': create_plan_json.tableName is required')
    const rawColumns = Array.isArray(plan.columns) ? plan.columns : []
    if (!rawColumns.length) throw new Error(tool + ': create_plan_json.columns is required')
    const columns = rawColumns.map((raw, index) => {
      const column = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {}
      const sourceKey = typeof column.sourceKey === 'string' ? column.sourceKey : ''
      const name = typeof column.name === 'string' ? column.name : ''
      const chineseName = typeof column.chineseName === 'string' ? column.chineseName : ''
      const dataType = typeof column.dataType === 'string' ? column.dataType : ''
      if (!sourceKey || !name || !chineseName || !dataType) {
        throw new Error(tool + ': create_plan_json.columns[' + index + '] needs sourceKey/name/chineseName/dataType')
      }
      return {
        sourceKey,
        name,
        chineseName,
        dataType,
        ...(typeof column.nullable === 'boolean' ? { nullable: column.nullable } : {}),
        ...(typeof column.comment === 'string' ? { comment: column.comment } : {}),
      }
    })
    return {
      tableName,
      ...(typeof plan.tableChineseName === 'string' && plan.tableChineseName.trim()
        ? { tableChineseName: plan.tableChineseName.trim() } : {}),
      ...(typeof plan.tableComment === 'string' && plan.tableComment.trim()
        ? { tableComment: plan.tableComment.trim() } : {}),
      columns,
    }
  }

  /**
   * Keep only `{sourceKey,targetColumn}` from a model-written mapping list.
   *
   * The validated plan carries sourceHeader/targetDataType/confidence beside the pair; the
   * backend DTO drops them, but rejecting a malformed entry here names the offending index
   * instead of letting the server answer a generic "no usable mapping".
   */
  const normalizeMappings = (
    tool: string,
    entries: readonly unknown[],
  ): Array<{ sourceKey: string; targetColumn: string }> => entries.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(tool + ': mappings_json[' + index + '] must be an object')
    }
    const mapping = entry as Record<string, unknown>
    const sourceKey = typeof mapping.sourceKey === 'string' ? mapping.sourceKey.trim() : ''
    const targetColumn = typeof mapping.targetColumn === 'string' ? mapping.targetColumn.trim() : ''
    if (!sourceKey || !targetColumn) {
      throw new Error(tool + ': mappings_json[' + index + '] needs sourceKey and targetColumn')
    }
    return { sourceKey, targetColumn }
  })

  return [
    {
      name: 'skill_list',
      definition: defineTool({
        name: 'skill_list',
        description: 'List skills in the DataOps skill centre: local workspace skills plus the caller\'s pending/rejected submissions and the approved plaza entries they may install. Scope follows the caller role (department admins see their department; ordinary users see their own and approved entries). Read-only.',
        parameters: {
          include_local: { type: 'boolean', description: 'Include local workspace skills (default true).' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { include_local?: boolean }) => {
          return await listSkills(readScope() ?? {}, args.include_local !== false) as Record<string, Json>
        },
      }),
    },
    {
      name: 'skill_get',
      definition: defineTool({
        name: 'skill_get',
        description: 'Read one skill-centre entry by id: description, instruction, review status, review note, risk report and visibility. Only entries visible to the caller can be read.',
        parameters: { skill_id: { type: 'number', required: true, description: 'Skill/plaza id from skill_list.' } },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skill_id: number }) => {
          const listing = await listSkills(readScope() ?? {}, false)
          const rows = listing.skills as Array<Record<string, unknown>>
          const found = rows.find(row => row.id === args.skill_id)
          if (found === undefined) throw new Error('Skill not found or not visible: ' + args.skill_id.toString())
          return found as Record<string, Json>
        },
      }),
    },
    {
      name: 'skill_submit',
      definition: defineTool({
        name: 'skill_submit',
        description: 'Submit the caller\'s own skill for plaza review. When the workspace review switch is off DataOps approves immediately; otherwise the entry becomes pending. Requires user approval; audited.',
        parameters: { skill_id: { type: 'number', required: true, description: 'Own skill/plaza id.' } },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skill_id: number }, exec) => {
          await approve('skill_submit', exec, 'Submit skill ' + args.skill_id.toString() + ' for review')
          const value = await call('/api/ai/skill-plaza/skills/' + args.skill_id.toString() + '/submit', { method: 'POST', body: '{}' })
          audit('skill_submit', exec, { skillId: args.skill_id })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'skill_install',
      definition: defineTool({
        name: 'skill_install',
        description: 'Install one approved, visible plaza skill into the caller\'s workspace. Requires user approval; audited. The secret-free result reports the local skill key.',
        parameters: { skill_id: { type: 'number', required: true, description: 'Plaza skill id.' } },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skill_id: number }, exec) => {
          await approve('skill_install', exec, 'Install skill ' + args.skill_id.toString())
          const value = await call('/api/ai/skill-plaza/install', { method: 'POST', body: JSON.stringify({ skillId: args.skill_id }) })
          audit('skill_install', exec, { skillId: args.skill_id })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'skill_uninstall',
      definition: defineTool({
        name: 'skill_uninstall',
        description: 'Uninstall one skill from the caller\'s own workspace only: deletes the current user\'s installation record. The plaza entry, its review status, visibility and enabled flag are unchanged and no “unpublished” notification is sent. Requires user approval; audited.',
        parameters: { skill_id: { type: 'number', required: true, description: 'Plaza skill id.' } },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skill_id: number }, exec) => {
          await approve('skill_uninstall', exec, 'Uninstall skill ' + args.skill_id.toString() + ' from the current workspace')
          const result = await call('/api/ai/skill-plaza/skills/' + args.skill_id.toString() + '/install', { method: 'DELETE' }) as { uninstalled?: unknown; removed?: unknown }
          audit('skill_uninstall', exec, { skillId: args.skill_id, scope: 'installation-only', removed: result.removed ?? null })
          return { uninstalled: result.uninstalled === true, removed: typeof result.removed === 'number' ? result.removed : 0 }
        },
      }),
    },
    {
      name: 'skill_enable',
      definition: defineSkillStatusTool(true),
    },
    {
      name: 'skill_disable',
      definition: defineSkillStatusTool(false),
    },
    {
      name: 'skill_unshare',
      definition: defineTool({
        name: 'skill_unshare',
        description: 'Stop sharing one plaza skill (soft unpublish): the entry and its installations remain, review status/visibility are kept, and DataOps sends an “unpublished” notification. Owners may unshare their own entries; 超级管理员/管理员 any entry; 部门管理员 their department. Requires user approval; audited.',
        parameters: { skill_id: { type: 'number', required: true, description: 'Plaza skill id.' } },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skill_id: number }, exec) => {
          await approve('skill_unshare', exec, 'Unshare skill ' + args.skill_id.toString())
          await call('/api/ai/skill-plaza/skills/' + args.skill_id.toString(), { method: 'DELETE' })
          audit('skill_unshare', exec, { skillId: args.skill_id, effect: 'soft-unpublish' })
          return { unshared: args.skill_id, effect: 'plaza-sharing-disabled' }
        },
      }),
    },
    {
      name: 'skill_delete',
      definition: defineTool({
        name: 'skill_delete',
        description: 'Permanently delete one plaza skill. This is not unshare: the record is removed, DataOps sends a “deleted” notification (not “unpublished”), and the audit entry records the permanent action. Requires confirm=true as a second confirmation; owners may delete their own entries, 超级管理员/管理员 any entry, 部门管理员 their department. If installations still exist the backend returns 409 and the error is passed through. Requires user approval; audited.',
        parameters: {
          skill_id: { type: 'number', required: true, description: 'Plaza skill id.' },
          confirm: { type: 'boolean', required: true, description: 'Must be true: explicitly confirms permanent deletion.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skill_id: number; confirm: boolean }, exec) => {
          if (args.confirm !== true) throw new Error('skill_delete requires confirm=true (permanent deletion)')
          await approve('skill_delete', exec, 'Permanently delete skill ' + args.skill_id.toString())
          await call('/api/ai/skill-plaza/skills/' + args.skill_id.toString() + '/permanent', { method: 'DELETE' })
          audit('skill_delete', exec, { skillId: args.skill_id, permanent: true })
          return { deleted: args.skill_id, permanent: true }
        },
      }),
    },
    {
      name: 'skill_install_for_user',
      definition: defineTool({
        name: 'skill_install_for_user',
        description: 'Install one plaza skill directly into the workspaces of the listed users, optionally overwriting an existing installation of the same skill key (overwrite=true). Administrator scope only; DataOps validates every target user and the caller\'s permitted range on the call. ONLY the listed users are affected — nobody else — and the installation takes effect the next time each target opens their workspace (a running workspace may pick it up immediately). Never use this for a whole department; use department_skill_preview + department_skill_bind + department_skill_apply. Requires user approval; audited.',
        parameters: {
          skill_id: { type: 'number', required: true, description: 'Plaza skill id.' },
          user_ids: { type: 'array', items: { type: 'string' }, required: true, description: 'DataOps user ids (UUID strings) that should receive the skill.' },
          overwrite: { type: 'boolean', description: 'Overwrite an existing installation of the same skill key. Defaults to false, which leaves an existing installation unchanged.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skill_id: number; user_ids: string[]; overwrite?: boolean }, exec) => {
          const skillId = provisioningSkillId('skill_install_for_user', args.skill_id)
          const userIds = provisioningUserIds('skill_install_for_user', args.user_ids)
          const overwrite = args.overwrite === true
          await approve(
            'skill_install_for_user',
            exec,
            'Install skill ' + skillId.toString() + ' for ' + userIds.length.toString() + ' user(s)' + (overwrite ? ' with overwrite' : ''),
          )
          const value = await call('/api/ai/skill-plaza/admin/install-for-users', {
            method: 'POST',
            body: JSON.stringify({ skillId, userIds, ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }) }),
          })
          audit('skill_install_for_user', exec, {
            skillId,
            userCount: userIds.length,
            overwrite,
            skillKey: typeof (value as { skillKey?: unknown }).skillKey === 'string' ? (value as { skillKey: string }).skillKey : null,
          })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'department_skill_bind',
      definition: defineTool({
        name: 'department_skill_bind',
        description: 'Bind one plaza skill as a DEPARTMENT DEFAULT. This changes configuration only: it does NOT touch any existing user\'s workspace — run department_skill_apply to reconcile the department\'s users. The binding applies to the department and, on apply, its sub-departments; DataOps enforces the caller\'s department range. Call department_skill_preview first and show the user the affected tree and user count. Requires user approval; audited.',
        parameters: {
          department_code: { type: 'string', required: true, description: 'Department code from the DataOps department tree.' },
          skill_id: { type: 'number', required: true, description: 'Plaza skill id.' },
          enabled: { type: 'boolean', description: 'Whether the binding is active. Defaults to true.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { department_code: string; skill_id: number; enabled?: boolean }, exec) => {
          const departmentCode = provisioningDepartmentCode('department_skill_bind', args.department_code)
          const skillId = provisioningSkillId('department_skill_bind', args.skill_id)
          const enabled = args.enabled !== false
          await approve(
            'department_skill_bind',
            exec,
            (enabled ? 'Bind' : 'Disable') + ' skill ' + skillId.toString() + ' as a default for department ' + departmentCode,
          )
          const value = await call('/api/ai/skill-plaza/admin/department-skills/bind', {
            method: 'POST',
            body: JSON.stringify({ departmentCode, skillId, enabled }),
          })
          audit('department_skill_bind', exec, { departmentCode, skillId, enabled, spread: false })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'department_skill_unbind',
      definition: defineTool({
        name: 'department_skill_unbind',
        description: 'Remove one plaza skill from a DEPARTMENT\'s default bindings. This changes configuration only: existing installations remain in the users\' workspaces until the next department_skill_apply reconciles them. DataOps enforces the caller\'s department range. Call department_skill_preview first. Requires user approval; audited.',
        parameters: {
          department_code: { type: 'string', required: true, description: 'Department code from the DataOps department tree.' },
          skill_id: { type: 'number', required: true, description: 'Plaza skill id.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { department_code: string; skill_id: number }, exec) => {
          const departmentCode = provisioningDepartmentCode('department_skill_unbind', args.department_code)
          const skillId = provisioningSkillId('department_skill_unbind', args.skill_id)
          await approve(
            'department_skill_unbind',
            exec,
            'Unbind skill ' + skillId.toString() + ' from department ' + departmentCode,
          )
          const value = await call('/api/ai/skill-plaza/admin/department-skills/unbind', {
            method: 'POST',
            body: JSON.stringify({ departmentCode, skillId }),
          })
          audit('department_skill_unbind', exec, { departmentCode, skillId, spread: false })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'department_skill_apply',
      definition: defineTool({
        name: 'department_skill_apply',
        description: 'Apply the department\'s CURRENT default-skill bindings to its users once: marks the affected users for reconciliation, which runs the next time each workspace starts (a running workspace may reconcile immediately). This is the step that makes earlier bind/unbind changes reach existing users. Target either a department (with optional sub-departments) or an explicit user list. Requires confirm=true plus user approval; audited. Preview the department tree and user count with department_skill_preview first, then show the user the exact scope and ask for explicit confirmation.',
        parameters: {
          department_code: { type: 'string', description: 'Department code to apply. Required unless user_ids is given.' },
          include_descendants: { type: 'boolean', description: 'Also apply to sub-departments. Defaults to true when department_code is set.' },
          user_ids: { type: 'array', items: { type: 'string' }, description: 'Explicit DataOps user ids; an alternative to department_code.' },
          confirm: { type: 'boolean', required: true, description: 'Must be true: explicitly confirms applying the current bindings to the affected users.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { department_code?: string; include_descendants?: boolean; user_ids?: string[]; confirm: boolean }, exec) => {
          if (args.confirm !== true) throw new Error('department_skill_apply requires confirm=true')
          const departmentCode = typeof args.department_code === 'string' ? args.department_code.trim() : ''
          const userIds = args.user_ids === undefined ? [] : provisioningUserIds('department_skill_apply', args.user_ids)
          if (departmentCode === '' && userIds.length === 0) {
            throw new Error('department_skill_apply requires department_code or a non-empty user_ids list')
          }
          if (departmentCode !== '' && userIds.length > 0) {
            throw new Error('department_skill_apply accepts either department_code or user_ids, not both')
          }
          const includeDescendants = args.include_descendants !== false
          await approve(
            'department_skill_apply',
            exec,
            departmentCode !== ''
              ? 'Apply department default skills to ' + departmentCode + (includeDescendants ? ' including sub-departments' : '')
              : 'Apply department default skills to ' + userIds.length.toString() + ' user(s)',
          )
          const value = await call('/api/ai/skill-plaza/admin/department-skills/apply', {
            method: 'POST',
            body: JSON.stringify({
              ...(departmentCode === '' ? {} : { departmentCode, includeDescendants }),
              ...(userIds.length === 0 ? {} : { userIds }),
            }),
          })
          audit('department_skill_apply', exec, {
            departmentCode: departmentCode === '' ? null : departmentCode,
            includeDescendants: departmentCode === '' ? null : includeDescendants,
            userCount: userIds.length,
            confirmed: true,
          })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'department_skill_preview',
      definition: defineTool({
        name: 'department_skill_preview',
        description: 'Read-only preview of a department-default skill binding: the department plus its sub-departments, the affected user count, the users, and current installation/conflict details. Call this BEFORE department_skill_bind, department_skill_unbind or department_skill_apply and show the department tree, user count and overwrite/skip details to the user. It writes nothing.',
        parameters: {
          department_code: { type: 'string', required: true, description: 'Department code from the DataOps department tree.' },
          skill_id: { type: 'number', required: true, description: 'Plaza skill id.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { department_code: string; skill_id: number }, exec) => {
          const departmentCode = provisioningDepartmentCode('department_skill_preview', args.department_code)
          const skillId = provisioningSkillId('department_skill_preview', args.skill_id)
          const query = new URLSearchParams({ departmentCode, skillId: skillId.toString() })
          const value = await call('/api/ai/skill-plaza/admin/department-skills/preview?' + query.toString())
          audit('department_skill_preview', exec, { departmentCode, skillId })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'review_scan',
      definition: defineTool({
        name: 'review_scan',
        description: 'Run the DataOps AI risk scan for skill and/or workflow ids. Reviewers only; the tool is disclosed to principals with review capability and skill read access, and DataOps still enforces the permission on every call. Read-only.',
        parameters: {
          skills: { type: 'array', items: { type: 'number' }, description: 'Skill ids to scan.' },
          workflows: { type: 'array', items: { type: 'string' }, description: 'Workflow ids to scan.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skills?: number[]; workflows?: string[] }) => {
          return await call('/api/ai/review/scan', { method: 'POST', body: JSON.stringify({ skills: args.skills ?? [], workflows: args.workflows ?? [] }) }) as Record<string, Json>
        },
      }),
    },
    {
      name: 'review_decide',
      definition: defineTool({
        name: 'review_decide',
        description: 'Approve or reject skills/workflows. Requires authorization.confirmed=true (the administrator explicitly confirmed), a reviewer role, resource scope and the review-decide capability; DataOps enforces all of them on the call. Requires a second user approval at tool level and writes an audit entry.',
        parameters: {
          skills: { type: 'array', items: { type: 'number' }, description: 'Skill ids.' },
          workflows: { type: 'array', items: { type: 'string' }, description: 'Workflow ids.' },
          decision: { type: 'string', required: true, description: 'approve or reject.' },
          note: { type: 'string', description: 'Review note (max 2000 chars).' },
          confirmed: { type: 'boolean', required: true, description: 'Must be true: the administrator confirmed this decision.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { skills?: number[]; workflows?: string[]; decision: string; note?: string; confirmed: boolean }, exec) => {
          if (args.confirmed !== true) throw new Error('authorization.confirmed=true is required for review_decide')
          if (args.decision !== 'approve' && args.decision !== 'reject') throw new Error('decision must be approve or reject')
          if ((args.skills ?? []).length === 0 && (args.workflows ?? []).length === 0) throw new Error('at least one skill or workflow id is required')
          await approve('review_decide', exec, 'Review ' + args.decision + ' for ' + (args.skills ?? []).length.toString() + ' skill(s) / ' + (args.workflows ?? []).length.toString() + ' workflow(s)')
          const value = await call('/api/ai/review/decide', { method: 'POST', body: JSON.stringify({ skills: args.skills ?? [], workflows: args.workflows ?? [], decision: args.decision, note: args.note ?? '', authorization: { confirmed: true } }) })
          audit('review_decide', exec, { decision: args.decision, skills: args.skills ?? [], workflows: args.workflows ?? [], confirmed: true })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'review_notifications_list',
      definition: defineTool({
        name: 'review_notifications_list',
        description: 'List the caller\'s review notifications and unread count. Read-only and always scoped to the current DataOps user.',
        parameters: {
          unread_only: { type: 'boolean', description: 'Only unread notifications.' },
          limit: { type: 'number', description: 'Maximum rows (default 20).' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { unread_only?: boolean; limit?: number }) => {
          const query = new URLSearchParams({ unreadOnly: args.unread_only === true ? 'true' : 'false', limit: String(args.limit ?? 20) })
          return await call('/api/ai/review-notifications?' + query.toString()) as Record<string, Json>
        },
      }),
    },
    {
      name: 'review_notifications_read',
      definition: defineTool({
        name: 'review_notifications_read',
        description: 'Mark the caller\'s review notifications as read, either selected ids or all. Scoped to the current DataOps user; no secret is involved.',
        parameters: {
          ids: { type: 'array', items: { type: 'string' }, description: 'Notification ids to mark read.' },
          all: { type: 'boolean', description: 'Mark every notification read.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { ids?: string[]; all?: boolean }, exec) => {
          const value = await call('/api/ai/review-notifications/read', { method: 'POST', body: JSON.stringify({ ids: args.ids ?? [], all: args.all === true }) })
          audit('review_notifications_read', exec, { count: args.ids?.length ?? 0, all: args.all === true })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_api_docs',
      definition: defineTool({
        name: 'dataops_api_docs',
        description: 'Search the DataOps HTTP API reference (OpenAPI 3) for endpoint contracts. Administrators and super administrators; read-only. Returns compact operations — method, path, operationId, summary, tags, parameters, request-body fields and security — filtered by keyword, tag, path, operationId or HTTP method. It only reads the fixed /api/openapi.json document and cannot execute arbitrary requests.',
        parameters: {
          query: { type: 'string', description: 'Case-insensitive keywords matched against path, operationId, summary, tags and description. All keywords must match.' },
          tag: { type: 'string', description: 'Exact OpenAPI tag (case-insensitive).' },
          path: { type: 'string', description: 'Case-insensitive substring of the operation path.' },
          operation_id: { type: 'string', description: 'Case-insensitive substring of the operationId.' },
          method: { type: 'string', description: 'HTTP method: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS or TRACE.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: ApiDocsFilters) => {
          const result = await reviewApi.request('/api/openapi.json')
          if (result.status === 401) throw new Error('Unauthorized (401): DataOps session expired; sign in again to read the API reference')
          if (result.status === 403) throw new Error('Forbidden (403): the DataOps OpenAPI document is not available to this role')
          if (result.status === 404) throw new Error('DataOps API docs are unavailable: /api/openapi.json is not configured (DATAOPS_OPENAPI_UNAVAILABLE)')
          if (result.status === 503) throw new Error('DataOps API docs are unavailable: this workspace has no DataOps session')
          if (result.status < 200 || result.status >= 300) throw new Error('DataOps API docs request failed: HTTP ' + result.status.toString())
          try {
            return searchOpenApiDocument(result.body, args) as unknown as Record<string, Json>
          } catch (error) {
            if (error instanceof ApiDocsUnavailableError) throw new Error(error.message)
            throw error
          }
        },
      }),
    },
    {
      name: 'dataops_collect_preview',
      definition: defineTool({
        name: 'dataops_collect_preview',
        description: 'Parse one spreadsheet attachment from the workspace and return DataOps\'s preview plus the importable database destinations. Read-only: it does not create a table and does not write rows. Use this first in the data-collection skill, then ask the user to choose the destination when more than one is returned.',
        parameters: {
          file_path: { type: 'string', required: true, description: 'Absolute or workspace-relative path to one .xlsx/.xls/.csv/.tsv file.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { file_path: string }, exec) => {
          const preview = await collectApi.preview(args.file_path)
          const dataSources = await collectApi.dataSources()
          audit('dataops_collect_preview', exec, {
            filePath: args.file_path,
            sessionId: preview.sessionId,
            dataSourceCount: dataSources.length,
          })
          return {
            sessionId: preview.sessionId,
            preview,
            dataSources,
          } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_collect_validate_plan',
      definition: defineTool({
        name: 'dataops_collect_validate_plan',
        description: 'Validate and normalize the spreadsheet import plan the current conversation model wrote: a create-table plan or an existing-table field mapping. Read-only and model-free: DataOps checks identifiers, data types, source keys and target columns, then returns the normalized plan, CREATE TABLE SQL or mapping summary. It does not call any AI model and does not create tables or write rows. Call this after generating the plan and before presenting it to the user; use the returned plan for confirmation and execution.',
        parameters: {
          session_id: { type: 'string', required: true, description: 'Session id returned by dataops_collect_preview.' },
          data_source_urn: { type: 'string', description: 'Destination URN from the preview result. Required when appending to an existing table; omit only when validating a generic create-table plan.' },
          target_schema: { type: 'string', description: 'Existing-table schema; required together with target_table.' },
          target_table: { type: 'string', description: 'Existing table name; omit to validate a new create-table plan.' },
          create_plan_json: { type: 'string', description: 'JSON object for CREATE_TABLE: {tableName,tableChineseName?,tableComment?,columns:[{sourceKey,name,chineseName,dataType,nullable?,comment?}]}.' },
          mappings_json: { type: 'string', description: 'JSON array for EXISTING_TABLE: [{sourceKey,targetColumn}].' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: {
          session_id: string
          data_source_urn?: string
          target_schema?: string
          target_table?: string
          create_plan_json?: string
          mappings_json?: string
        }, exec) => {
          const tool = 'dataops_collect_validate_plan'
          const createPlan = normalizeCreatePlan(
            tool,
            parseJsonObject(tool, 'create_plan_json', args.create_plan_json),
          )
          const mappings = normalizeMappings(tool, parseJsonArray(tool, 'mappings_json', args.mappings_json))
          if (args.target_table !== undefined && args.target_table.trim() === '') {
            throw new Error(tool + ': target_table must be a non-empty existing table name')
          }
          if (args.target_schema !== undefined && args.target_table === undefined) {
            throw new Error(tool + ': target_schema requires target_table')
          }
          if (args.target_table !== undefined) {
            if (!args.target_schema || args.target_schema.trim() === '') {
              throw new Error(tool + ': target_schema is required when target_table is set')
            }
            if (createPlan !== undefined) {
              throw new Error(tool + ': do not send create_plan_json when target_table is set')
            }
            if (mappings.length === 0) {
              throw new Error(tool + ': mappings_json is required for EXISTING_TABLE')
            }
          } else {
            if (createPlan === undefined) {
              throw new Error(tool + ': create_plan_json is required for CREATE_TABLE')
            }
            if (mappings.length > 0) {
              throw new Error(tool + ': do not send mappings_json for CREATE_TABLE')
            }
          }
          const result = await collectApi.validatePlan({
            sessionId: args.session_id,
            ...(args.data_source_urn === undefined || args.data_source_urn.trim() === ''
              ? {}
              : { dataSourceUrn: args.data_source_urn }),
            ...(args.target_schema && args.target_table
              ? { targetTable: { schema: args.target_schema, table: args.target_table } }
              : {}),
            ...(createPlan === undefined ? {} : { createPlan }),
            ...(mappings.length === 0 ? {} : { mappings }),
          })
          audit(tool, exec, {
            sessionId: args.session_id,
            dataSourceUrn: args.data_source_urn ?? null,
            targetTable: args.target_table ?? createPlan?.tableName ?? null,
            mode: args.target_table === undefined ? 'CREATE_TABLE' : 'EXISTING_TABLE',
          })
          return result as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_collect_execute',
      definition: defineTool({
        name: 'dataops_collect_execute',
        description: 'Execute one confirmed spreadsheet import: create a table (or write to an existing table), insert rows, and register the DataOps resource. This is the ONLY collection tool that mutates data. Call it only after dataops_collect_validate_plan has normalized the plan and the user explicitly confirmed that plan in natural language (e.g. 确认/开始吧); never call it while the plan is still being edited and never call it with an unvalidated plan.',
        parameters: {
          session_id: { type: 'string', required: true, description: 'Session id from dataops_collect_preview.' },
          data_source_urn: { type: 'string', required: true, description: 'Destination URN.' },
          mode: { type: 'string', required: true, description: 'CREATE_TABLE, EXISTING_TABLE or OVERWRITE_TABLE. OVERWRITE_TABLE truncates the target table first; require explicit user confirmation and confirm_overwrite=true.' },
          target_schema: { type: 'string', description: 'Target schema for EXISTING_TABLE.' },
          target_table: { type: 'string', description: 'Target table for EXISTING_TABLE.' },
          create_plan_json: { type: 'string', description: 'Only plan.createTable (tableName/tableChineseName/tableComment/columns) from the plan returned by dataops_collect_validate_plan. Do not send createSql/targetSchema/notes; if the user edits the table name, regenerate the plan and call dataops_collect_validate_plan again before executing.' },
          mappings_json: { type: 'string', description: 'JSON array of {sourceKey,targetColumn} for EXISTING_TABLE/OVERWRITE_TABLE.' },
          confirm_overwrite: { type: 'boolean', description: 'Required true for OVERWRITE_TABLE after the user explicitly confirms that the target table will be truncated.' },
          resource_name: { type: 'string', description: 'Resource display name drafted by the plan and confirmed by the user.' },
          resource_description: { type: 'string', description: 'Optional resource description.' },
          resource_tags: { type: 'array', items: { type: 'string' }, description: 'Optional resource tags.' },
          business_domain: { type: 'string', description: 'Business domain inferred by the conversation model from table name/comment/columns/terms, e.g. 财务域. Omit when unknown; DataOps will place it in 未分类.' },
          domain_inference_source: { type: 'string', description: 'MODEL, USER, RULE or UNKNOWN. Defaults to MODEL when business_domain is provided.' },
          domain_inference_confidence: { type: 'string', description: 'HIGH, MEDIUM or LOW. LOW is placed in 未分类.' },
          ai_visible: { type: 'boolean', description: 'Whether AI may retrieve this resource. Defaults to true.' },
          access_level: { type: 'string', description: 'PUBLIC, PROTECTED or PRIVATE. Defaults to PRIVATE.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: {
          session_id: string
          data_source_urn: string
          mode: string
          target_schema?: string
          target_table?: string
          create_plan_json?: string
          mappings_json?: string
          confirm_overwrite?: boolean
          resource_name?: string
          resource_description?: string
          resource_tags?: string[]
          business_domain?: string
          domain_inference_source?: string
          domain_inference_confidence?: string
          ai_visible?: boolean
          access_level?: string
        }, exec) => {
          if (args.mode !== 'CREATE_TABLE' && args.mode !== 'EXISTING_TABLE' && args.mode !== 'OVERWRITE_TABLE') {
            throw new Error('dataops_collect_execute: mode must be CREATE_TABLE, EXISTING_TABLE or OVERWRITE_TABLE')
          }
          if (args.mode === 'OVERWRITE_TABLE' && args.confirm_overwrite !== true) {
            throw new Error('dataops_collect_execute: OVERWRITE_TABLE requires confirm_overwrite=true after explicit user confirmation')
          }
          const createPlan = normalizeCreatePlan(
            'dataops_collect_execute',
            parseJsonObject('dataops_collect_execute', 'create_plan_json', args.create_plan_json),
          )
          const mappings = parseJsonArray('dataops_collect_execute', 'mappings_json', args.mappings_json)
          if (args.mode === 'CREATE_TABLE' && createPlan === undefined) {
            throw new Error('dataops_collect_execute: create_plan_json is required for CREATE_TABLE')
          }
          if (args.mode === 'EXISTING_TABLE' && (!args.target_schema || !args.target_table)) {
            throw new Error('dataops_collect_execute: target_schema and target_table are required for EXISTING_TABLE')
          }
          const payload: Record<string, unknown> = {
            sessionId: args.session_id,
            dataSourceUrn: args.data_source_urn,
            mode: args.mode,
            mappings,
            ...(createPlan === undefined ? {} : { createPlan }),
            ...(args.target_schema && args.target_table
              ? { targetTable: { schema: args.target_schema, table: args.target_table } }
              : {}),
            ...(args.mode === 'OVERWRITE_TABLE' ? { confirmOverwrite: true } : {}),
            ...(args.resource_name === undefined ? {} : { resourceName: args.resource_name }),
            ...(args.resource_description === undefined ? {} : { resourceDescription: args.resource_description }),
            ...(args.resource_tags === undefined ? {} : { resourceTags: args.resource_tags }),
            ...(args.business_domain === undefined ? {} : { businessDomain: args.business_domain }),
            ...(args.domain_inference_source === undefined ? {} : { domainInferenceSource: args.domain_inference_source }),
            ...(args.domain_inference_confidence === undefined ? {} : { domainInferenceConfidence: args.domain_inference_confidence }),
            ...(args.ai_visible === undefined ? {} : { aiVisible: args.ai_visible }),
            ...(args.access_level === undefined ? {} : { accessLevel: args.access_level }),
          }
          const result = await collectApi.execute(payload)
          const resource = result.resource
          audit('dataops_collect_execute', exec, {
            sessionId: args.session_id,
            mode: args.mode,
            resourceId: resource?.id ?? null,
            importedRows: result.importedRows ?? null,
            businessDomain: args.business_domain ?? null,
          })
          return result as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_collect_resources',
      definition: defineTool({
        name: 'dataops_collect_resources',
        description: 'Search the current DataOps resource catalog for an append target. Read-only and scoped by DataOps resource visibility. Use it when the user chooses "追加到已有资源" instead of a remote select control.',
        parameters: {
          query: { type: 'string', description: 'Resource name, table name or URN keyword.' },
          limit: { type: 'number', description: 'Maximum rows (default 20, max 50).' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { query?: string; limit?: number }) => {
          const resources = await collectApi.listResources(args.query ?? '', args.limit ?? 20)
          return { resources } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_open_resource_tab',
      definition: defineTool({
        name: 'dataops_open_resource_tab',
        description: 'Open or focus the DataOps resource tab in the right sidebar. This only navigates the browser: it does not grant access or mutate data. Use mode=focus after an import succeeds, grant for 分配权限, detail for 查看详情, and audit for 查看操作记录.',
        parameters: {
          resource_id: { type: 'number', required: true, description: 'DataOps resource id.' },
          resource_name: { type: 'string', description: 'Display name used as the tab subtitle.' },
          mode: { type: 'string', description: 'focus | grant | detail | audit. Defaults to focus.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { resource_id: number; resource_name?: string; mode?: string }, exec) => {
          if (!Number.isSafeInteger(args.resource_id) || args.resource_id <= 0) {
            throw new Error('dataops_open_resource_tab: resource_id must be a positive integer')
          }
          const requested = args.mode ?? 'focus'
          const mode = requested === 'grant' || requested === 'detail' || requested === 'audit' ? requested : 'focus'
          const payload = collectHub.broadcast({
            resourceId: args.resource_id,
            resourceName: args.resource_name ?? null,
            mode,
            nonce: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          })
          audit('dataops_open_resource_tab', exec, {
            resourceId: args.resource_id,
            mode,
            subscribers: collectHub.size(),
          })
          return {
            opened: collectHub.size() > 0,
            mode,
            resourceId: args.resource_id,
            requestId: payload.requestId,
            subscribers: collectHub.size(),
          }
        },
      }),
    },
    {
      name: 'dataops_user_lookup',
      definition: defineTool({
        name: 'dataops_user_lookup',
        description: 'Look up DataOps users by username, display name, email, mobile or WeCom userid. Administrator and department-administrator visibility apply; DataOps returns only the users inside the caller\'s existing data scope. Read-only and never returns password or credential material.',
        parameters: {
          username: { type: 'string', description: 'Exact login name (case-insensitive).' },
          display_name: { type: 'string', description: 'Display-name keyword (case-insensitive contains).' },
          email: { type: 'string', description: 'Exact email address (case-insensitive).' },
          mobile: { type: 'string', description: 'Exact mobile number; separators and a country prefix are tolerated.' },
          wecom_user_id: { type: 'string', description: 'Exact WeCom address-book userid.' },
          department_code: { type: 'string', description: 'Restrict to one department code.' },
          enabled_only: { type: 'boolean', description: 'Return enabled accounts only. Defaults to false.' },
          limit: { type: 'number', description: 'Maximum rows (default 20, max 50).' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: {
          username?: string
          display_name?: string
          email?: string
          mobile?: string
          wecom_user_id?: string
          department_code?: string
          enabled_only?: boolean
          limit?: number
        }) => {
          const username = textArg(args.username)
          const displayName = textArg(args.display_name)
          const email = textArg(args.email)
          const mobile = textArg(args.mobile)
          const wecomUserId = textArg(args.wecom_user_id)
          const departmentCode = textArg(args.department_code)
          const enabledOnly = args.enabled_only === true
          if (username === '' && displayName === '' && email === '' && mobile === '' && wecomUserId === '') {
            throw new Error('dataops_user_lookup: provide at least one of username, display_name, email, mobile or wecom_user_id')
          }
          const limit = Math.max(1, Math.min(50, Math.round(args.limit ?? 20)))
          const params = new URLSearchParams()
          const search = username || displayName || email || mobile
          if (search !== '') params.set('search', search)
          if (wecomUserId !== '') params.set('wecomUserId', wecomUserId)
          if (departmentCode !== '') params.set('departmentCode', departmentCode)
          params.set('page', '1')
          params.set('pageSize', '100')
          const body = await call('/api/system/users?' + params.toString())
          const rows = typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown }).items)
            ? ((body as { items: unknown[] }).items).filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
            : []
          const queryDigits = phoneDigits(mobile)
          const users = rows.filter((row) => {
            if (username !== '' && !sameText(textArg(row.username), username)) return false
            if (email !== '' && !sameText(textArg(row.email), email)) return false
            if (displayName !== '' && !textArg(row.displayName).toLowerCase().includes(displayName.toLowerCase())) return false
            if (mobile !== '') {
              const storedDigits = phoneDigits(textArg(row.phone))
              if (queryDigits === '' || storedDigits === '') return false
              if (storedDigits !== queryDigits && !(queryDigits.length >= 7 && storedDigits.endsWith(queryDigits))) return false
            }
            if (enabledOnly && row.enabled !== true) return false
            return true
          })
          return {
            users: users.slice(0, limit).map(projectUserRow),
            count: Math.min(users.length, limit),
            scanned: rows.length,
            filters: {
              username: username || null,
              displayName: displayName || null,
              email: email || null,
              mobile: mobile || null,
              wecomUserId: wecomUserId || null,
              departmentCode: departmentCode || null,
              enabledOnly: enabledOnly === true,
            },
          } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_user_create',
      definition: defineTool({
        name: 'dataops_user_create',
        description: 'Create an enabled ordinary DataOps account with the same minimal roles as IM auto-provisioning (应用人员/初级权限/AI 工作区成员), in 待分配部门 unless a department is named, and with ZERO data-resource grants. Requires confirm=true and a user approval for the real write; dry_run=true previews without writing. The initial password is random, never returned and never logged — an administrator must set the password in the user console before hand-off. Use dataops_user_lookup first.',
        parameters: {
          username: { type: 'string', required: true, description: 'Login name.' },
          display_name: { type: 'string', required: true, description: 'Display name.' },
          email: { type: 'string', required: true, description: 'Email address.' },
          mobile: { type: 'string', description: 'Optional mobile number.' },
          department_code: { type: 'string', description: 'Department code. Defaults to unassigned (待分配部门).' },
          dry_run: { type: 'boolean', description: 'Preview the account that would be created without writing. Defaults to false.' },
          confirm: { type: 'boolean', description: 'Must be true for a real create; the tool also asks the user for approval.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: {
          username: string
          display_name: string
          email: string
          mobile?: string
          department_code?: string
          dry_run?: boolean
          confirm?: boolean
        }, exec) => {
          const username = textArg(args.username)
          const displayName = textArg(args.display_name)
          const email = textArg(args.email)
          if (username === '' || displayName === '' || email === '') {
            throw new Error('dataops_user_create: username, display_name and email are required')
          }
          const mobile = textArg(args.mobile)
          const departmentCode = textArg(args.department_code) || PROVISIONED_DEPARTMENT
          const roles = [...PROVISIONED_USER_ROLES]
          const credential = {
            mode: 'one_time_reveal',
            message: '初始密码只在本工具结果返回一次，不写入审计/日志；交付后请要求用户首次登录修改。',
          }
          const preview = {
            username,
            displayName,
            email,
            mobile: mobile || null,
            departmentCode,
            enabled: true,
            roles,
            directResourceGrants: 0,
            credential,
          }
          if (args.dry_run === true) {
            return { dryRun: true, wouldCreate: preview } as unknown as Record<string, Json>
          }
          if (args.confirm !== true) {
            throw new Error('dataops_user_create: confirm must be true for a real create (use dry_run=true to preview)')
          }
          await approve(
            'dataops_user_create',
            exec,
            'Create DataOps user ' + username + ' with roles ' + roles.join(' / ') + ' and no resource grants.',
          )
          const initialPassword = generatedInitialPassword({ username, displayName, email })
          const body = await call('/api/system/users', {
            method: 'POST',
            body: JSON.stringify({
              username,
              displayName,
              email,
              ...(mobile === '' ? {} : { phone: mobile }),
              departmentCode,
              roleCodes: roles,
              password: initialPassword,
            }),
          })
          const row = userRowOf(body)
          if (row === undefined) throw new Error('dataops_user_create: DataOps created the account but returned no user record')
          const user = projectUserRow(row)
          const actorUserId = readScope()?.userId ?? null
          audit('dataops_user_create', exec, {
            actorUserId,
            userId: user.id,
            username,
            roles,
            departmentCode,
            directResourceGrants: 0,
          })
          return {
            created: true,
            user,
            defaultRoles: roles,
            directResourceGrants: 0,
            credential,
            initialPassword,
          } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_role_assign',
      definition: defineTool({
        name: 'dataops_role_assign',
        description: 'Add or remove roles on one or more DataOps users (role_codes replaces nothing: action=add merges, action=remove subtracts, and the backend keeps all other roles). Administrator only; DataOps enforces role hierarchy and data scope on every write. The 超级管理员 role can never be assigned or removed here. Requires confirm=true and a user approval for real writes; dry_run=true previews. Adds no resource grants.',
        parameters: {
          user_ids: {
            type: 'array',
            required: true,
            description: 'DataOps user ids (UUID strings).',
            items: { type: 'string' },
          },
          role_codes: {
            type: 'array',
            required: true,
            description: 'Role codes to add or remove, for example 应用人员 / 初级权限.',
            items: { type: 'string' },
          },
          action: { type: 'string', description: 'add (default) or remove.' },
          dry_run: { type: 'boolean', description: 'Preview each user\'s before/after roles without writing. Defaults to false.' },
          confirm: { type: 'boolean', description: 'Must be true for a real change; the tool also asks the user for approval.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: {
          user_ids: string[]
          role_codes: string[]
          action?: string
          dry_run?: boolean
          confirm?: boolean
        }, exec) => {
          if (!Array.isArray(args.user_ids) || args.user_ids.length === 0) {
            throw new Error('dataops_role_assign: user_ids must be a non-empty array')
          }
          const userIds = Array.from(new Set(args.user_ids.map(textArg).filter(id => id !== '')))
          if (userIds.length === 0) throw new Error('dataops_role_assign: user_ids must contain non-empty DataOps user ids')
          if (userIds.length > 50) throw new Error('dataops_role_assign: at most 50 users per call')
          const requestedRoles = Array.from(new Set((args.role_codes ?? []).map(textArg).filter(code => code !== '')))
          if (requestedRoles.length === 0) throw new Error('dataops_role_assign: role_codes must be a non-empty array')
          if (requestedRoles.includes(SUPER_ADMIN_ROLE)) {
            throw new Error('dataops_role_assign: 超级管理员 role cannot be assigned or removed through this tool; use the administrator console')
          }
          const action = args.action === undefined ? 'add' : textArg(args.action).toLowerCase()
          if (action !== 'add' && action !== 'remove') throw new Error('dataops_role_assign: action must be add or remove')

          const plans: Array<{
            userId: string
            username: string
            ok: boolean
            changed: boolean
            beforeRoles: string[]
            afterRoles: string[]
            updatedAt?: string
            error?: string
          }> = []
          for (const userId of userIds) {
            try {
              const body = await call('/api/system/users/' + encodeURIComponent(userId))
              const row = userRowOf(body)
              if (row === undefined) throw new Error('user record missing from the response')
              const beforeRoles = Array.isArray(row.roles)
                ? row.roles.flatMap((role) => {
                  if (typeof role !== 'object' || role === null) return []
                  const code = textArg((role as Record<string, unknown>).code)
                  return code === '' ? [] : [code]
                })
                : []
              if (beforeRoles.includes(SUPER_ADMIN_ROLE)) {
                plans.push({ userId, username: textArg(row.username), ok: false, changed: false, beforeRoles, afterRoles: beforeRoles, error: 'target is a 超级管理员; super-admin changes stay in the administrator console' })
                continue
              }
              const afterRoles = action === 'add'
                ? Array.from(new Set([...beforeRoles, ...requestedRoles]))
                : beforeRoles.filter(code => !requestedRoles.includes(code))
              if (afterRoles.length === 0) {
                plans.push({ userId, username: textArg(row.username), ok: false, changed: false, beforeRoles, afterRoles, error: 'the change would leave the user without any role' })
                continue
              }
              const changed = afterRoles.length !== beforeRoles.length || afterRoles.some(code => !beforeRoles.includes(code))
              plans.push({
                userId,
                username: textArg(row.username),
                ok: true,
                changed,
                beforeRoles,
                afterRoles,
                updatedAt: textArg(row.updatedAt),
              })
            } catch (error) {
              plans.push({
                userId,
                username: '',
                ok: false,
                changed: false,
                beforeRoles: [],
                afterRoles: [],
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }

          const changedPlans = plans.filter(plan => plan.ok && plan.changed)
          const rejectedPlans = plans.filter(plan => !plan.ok).length
          if (args.dry_run === true) {
            return {
              dryRun: true,
              action,
              roleCodes: requestedRoles,
              results: plans,
              changed: changedPlans.length,
              failed: rejectedPlans,
            } as unknown as Record<string, Json>
          }
          if (changedPlans.length === 0) {
            return { action, roleCodes: requestedRoles, results: plans, changed: 0, failed: rejectedPlans } as unknown as Record<string, Json>
          }
          if (args.confirm !== true) {
            throw new Error('dataops_role_assign: confirm must be true for a real change (use dry_run=true to preview)')
          }
          await approve(
            'dataops_role_assign',
            exec,
            (action === 'add' ? 'Add' : 'Remove') + ' role(s) ' + requestedRoles.join(' / ') + ' for ' + String(changedPlans.length) + ' DataOps user(s).',
          )
          let failed = rejectedPlans
          for (const plan of changedPlans) {
            if (plan.updatedAt === undefined || plan.updatedAt === '') {
              plan.ok = false
              plan.error = 'user record has no updatedAt optimistic token; re-run the lookup'
              failed += 1
              continue
            }
            try {
              await call('/api/system/users/' + encodeURIComponent(plan.userId), {
                method: 'PATCH',
                body: JSON.stringify({ updatedAt: plan.updatedAt, roleCodes: plan.afterRoles }),
              })
            } catch (error) {
              plan.ok = false
              plan.error = error instanceof Error ? error.message : String(error)
              failed += 1
            }
          }
          const actorUserId = readScope()?.userId ?? null
          audit('dataops_role_assign', exec, {
            actorUserId,
            action,
            roleCodes: requestedRoles,
            userIds: changedPlans.map(plan => plan.userId),
            changed: changedPlans.filter(plan => plan.ok).length,
            failed,
          })
          return {
            action,
            roleCodes: requestedRoles,
            results: plans,
            changed: changedPlans.filter(plan => plan.ok).length,
            failed,
          } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_resource_pending_list',
      definition: defineTool({
        name: 'dataops_resource_pending_list',
        description: 'List pending DataOps approval tasks and their active user tasks. Administrator only; the resource.manage connector capability must be on. Read-only.',
        parameters: {
          query: { type: 'string', description: 'Optional keyword over task title/code/requester.' },
          limit: { type: 'number', description: 'Maximum tasks (default 20, max 100).' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { query?: string; limit?: number }) => {
          const limit = Math.max(1, Math.min(100, Math.round(args.limit ?? 20)))
          const tasks = await resourceManagementApi.listPendingTasks(args.query ?? '', limit)
          return {
            tasks: tasks.map((task) => ({
              id: task.id,
              code: task.code,
              title: task.title,
              status: task.status,
              requester: task.requester,
              requesterUserId: task.requesterUserId,
              workflow: task.workflow,
              userTasks: task.userTasks,
              updatedAt: task.updatedAt,
            })),
            count: tasks.length,
          } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_resource_grant_list',
      definition: defineTool({
        name: 'dataops_resource_grant_list',
        description: 'List the current access grants of one DataOps resource. Administrator only; resource.manage capability must be on. Read-only.',
        parameters: {
          resource_id: { type: 'number', required: true, description: 'DataOps resource id.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { resource_id: number }) => {
          if (!Number.isSafeInteger(args.resource_id) || args.resource_id <= 0) throw new Error('resource_id must be a positive integer')
          const grants = await resourceManagementApi.listGrants(args.resource_id)
          return { resourceId: args.resource_id, grants } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_resource_grant_batch',
      definition: defineTool({
        name: 'dataops_resource_grant_batch',
        description: 'Batch grant READ/MANAGE access on one DataOps resource to users, roles or departments. Administrator only; resource.manage capability must be on. The existing grants are preserved; the operation is audited by DataOps.',
        parameters: {
          resource_id: { type: 'number', required: true, description: 'DataOps resource id.' },
          application_id: { type: 'number', description: 'Application id used for the grants. Defaults to an existing grant application or the first selectable application.' },
          grants: {
            type: 'array',
            required: true,
            description: 'Targets to grant.',
            items: {
              type: 'object',
              properties: {
                targetType: { type: 'string', description: 'USER, ROLE, DEPARTMENT or APPLICATION.' },
                targetId: { type: 'string', description: 'User id, role code, department code or application id.' },
                permission: { type: 'string', description: 'READ or MANAGE. Defaults to READ.' },
                grantType: { type: 'string', description: 'REGULAR or TEMPORARY. Defaults to REGULAR.' },
                applicationId: { type: 'number', description: 'Optional per-grant application id override.' },
              },
              additionalProperties: false,
            },
          },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: {
          resource_id: number
          application_id?: number
          grants: Array<{ targetType: string; targetId: string; permission?: string; grantType?: string; applicationId?: number }>
        }, exec) => {
          if (!Number.isSafeInteger(args.resource_id) || args.resource_id <= 0) throw new Error('resource_id must be a positive integer')
          if (!Array.isArray(args.grants) || args.grants.length === 0) throw new Error('grants must be a non-empty array')
          const existing = await resourceManagementApi.listGrants(args.resource_id)
          let appId = args.application_id
          if (appId === undefined) appId = existing.map((g) => Number(g.applicationId)).find((id) => Number.isSafeInteger(id) && id > 0)
          if (appId === undefined) {
            const apps = await resourceManagementApi.listApplications()
            appId = apps.map((app) => Number(app.id)).find((id) => Number.isSafeInteger(id) && id > 0)
          }
          if (appId === undefined) throw new Error('no application is available for access grants')
          const merged = new Map<string, Record<string, unknown>>()
          for (const grant of existing) {
            const targetType = String(grant.targetType ?? '')
            const targetId = String(grant.targetId ?? '')
            if (!targetType || !targetId) continue
            const applicationId = Number(grant.applicationId) || appId
            merged.set(targetType + ':' + targetId + ':' + applicationId, {
              targetType,
              targetId,
              permission: String(grant.permission ?? 'READ'),
              grantType: String(grant.grantType ?? 'REGULAR'),
              applicationId,
            })
          }
          for (const grant of args.grants) {
            const targetType = String(grant.targetType ?? '').trim().toUpperCase()
            const targetId = String(grant.targetId ?? '').trim()
            if (!['USER', 'ROLE', 'DEPARTMENT', 'APPLICATION'].includes(targetType) || !targetId) {
              throw new Error('each grant needs targetType and targetId')
            }
            const permission = String(grant.permission ?? 'READ').trim().toUpperCase()
            if (!['READ', 'WRITE', 'MANAGE'].includes(permission)) throw new Error('permission must be READ, WRITE or MANAGE')
            const applicationId = grant.applicationId ?? appId
            merged.set(targetType + ':' + targetId + ':' + applicationId, {
              targetType,
              targetId,
              permission,
              grantType: String(grant.grantType ?? 'REGULAR').trim().toUpperCase(),
              applicationId,
            })
          }
          const grants = [...merged.values()]
          await resourceManagementApi.replaceGrants(args.resource_id, grants as never)
          audit('dataops_resource_grant_batch', exec, { resourceId: args.resource_id, count: grants.length, applicationId: appId })
          return { resourceId: args.resource_id, applicationId: appId, grants, count: grants.length } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_resource_approval_decide',
      definition: defineTool({
        name: 'dataops_resource_approval_decide',
        description: 'Approve or reject pending DataOps user tasks in batch. Administrator only; resource.manage capability must be on. Each decision needs task_id and user_task_id; expected_version is read from the task when omitted.',
        parameters: {
          decisions: {
            type: 'array',
            required: true,
            description: 'Approval decisions.',
            items: {
              type: 'object',
              properties: {
                task_id: { type: 'number', description: 'DataOps task id.' },
                user_task_id: { type: 'string', description: 'BPMN user task UUID.' },
                decision: { type: 'string', description: 'approve or reject.' },
                comment: { type: 'string', description: 'Decision comment.' },
                expected_version: { type: 'number', description: 'Current taskVersion; read from task detail when omitted.' },
                idempotency_key: { type: 'string', description: 'Optional replay key; reuse the original key to retry a timed-out command.' },
              },
              additionalProperties: false,
            },
          },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: {
          decisions: Array<{ task_id: number; user_task_id: string; decision: string; comment?: string; expected_version?: number; idempotency_key?: string }>
        }, exec) => {
          if (!Array.isArray(args.decisions) || args.decisions.length === 0) throw new Error('decisions must be a non-empty array')
          const results: Array<Record<string, unknown>> = []
          for (const decision of args.decisions) {
            const taskId = Number(decision.task_id)
            const userTaskId = String(decision.user_task_id ?? '')
            const action = String(decision.decision ?? '').toLowerCase()
            if (!Number.isSafeInteger(taskId) || taskId <= 0 || !userTaskId || (action !== 'approve' && action !== 'reject')) {
              results.push({ taskId, userTaskId, ok: false, error: 'invalid decision' })
              continue
            }
            try {
              let expectedVersion = decision.expected_version
              if (expectedVersion === undefined) {
                const task = await resourceManagementApi.getTask(taskId)
                const userTasks = Array.isArray(task.userTasks) ? task.userTasks as Array<Record<string, unknown>> : []
                const target = userTasks.find((item) => item.id === userTaskId)
                expectedVersion = typeof target?.taskVersion === 'number' ? target.taskVersion : 0
              }
              await resourceManagementApi.decideTask({
                taskId,
                userTaskId,
                decision: action,
                comment: decision.comment,
                expectedVersion,
                idempotencyKey: decision.idempotency_key,
              })
              results.push({ taskId, userTaskId, decision: action, ok: true })
            } catch (error) {
              results.push({ taskId, userTaskId, decision: action, ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          }
          audit('dataops_resource_approval_decide', exec, { count: results.length, ok: results.filter((item) => item.ok === true).length })
          return { results } as unknown as Record<string, Json>
        },
      }),
    },
    {
      name: 'dataops_resource_grant_revoke',
      definition: defineTool({
        name: 'dataops_resource_grant_revoke',
        description: 'Batch revoke access grants from one DataOps resource by target type and target id. Administrator only; resource.manage capability must be on. DataOps audits the resulting grant replacement.',
        parameters: {
          resource_id: { type: 'number', required: true, description: 'DataOps resource id.' },
          targets: {
            type: 'array',
            required: true,
            description: 'Targets to revoke.',
            items: {
              type: 'object',
              properties: {
                targetType: { type: 'string', description: 'USER, ROLE, DEPARTMENT or APPLICATION.' },
                targetId: { type: 'string', description: 'Target id/code.' },
              },
              additionalProperties: false,
            },
          },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { resource_id: number; targets: Array<{ targetType: string; targetId: string }> }, exec) => {
          if (!Number.isSafeInteger(args.resource_id) || args.resource_id <= 0) throw new Error('resource_id must be a positive integer')
          if (!Array.isArray(args.targets) || args.targets.length === 0) throw new Error('targets must be a non-empty array')
          const existing = await resourceManagementApi.listGrants(args.resource_id)
          const keys = new Set(args.targets.map((target) => String(target.targetType).toUpperCase() + ':' + String(target.targetId)))
          let appId = existing.map((g) => Number(g.applicationId)).find((id) => Number.isSafeInteger(id) && id > 0)
          if (appId === undefined) {
            const apps = await resourceManagementApi.listApplications()
            appId = apps.map((app) => Number(app.id)).find((id) => Number.isSafeInteger(id) && id > 0)
          }
          if (appId === undefined) throw new Error('no application is available for access grants')
          const remaining = existing
            .filter((grant) => !keys.has(String(grant.targetType).toUpperCase() + ':' + String(grant.targetId)))
            .map((grant) => ({
              targetType: String(grant.targetType),
              targetId: String(grant.targetId),
              permission: String(grant.permission ?? 'READ'),
              grantType: String(grant.grantType ?? 'REGULAR'),
              applicationId: Number(grant.applicationId) || appId,
            }))
          const removed = existing.length - remaining.length
          if (removed === 0) throw new Error('no matching grant to revoke')
          await resourceManagementApi.replaceGrants(args.resource_id, remaining as never)
          audit('dataops_resource_grant_revoke', exec, { resourceId: args.resource_id, removed })
          return { resourceId: args.resource_id, removed, remaining, count: remaining.length } as unknown as Record<string, Json>
        },
      }),
    },

    {
      name: 'synonym_group_list',
      definition: defineTool({
        name: 'synonym_group_list',
        description: 'List DataOps synonym groups: the canonical wording, its aliases and the catalog node it belongs to. Read-only. Super administrators only.',
        parameters: {
          catalog_node_id: { type: 'number', description: 'Only groups attached to this catalog node id.' },
          keyword: { type: 'string', description: 'Substring of the canonical term, or an exact alias.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { catalog_node_id?: number; keyword?: string }) => {
          const query = new URLSearchParams()
          if (args.catalog_node_id !== undefined) query.set('catalogNodeId', String(args.catalog_node_id))
          if (args.keyword !== undefined && args.keyword.trim() !== '') query.set('keyword', args.keyword.trim())
          return await call('/api/ai/synonym-groups?' + query.toString()) as Record<string, Json>
        },
      }),
    },
    {
      name: 'synonym_group_get',
      definition: defineTool({
        name: 'synonym_group_get',
        description: 'Read one DataOps synonym group by id. Read-only. Super administrators only.',
        parameters: {
          group_id: { type: 'number', required: true, description: 'Synonym group id.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { group_id: number }) => {
          if (!Number.isSafeInteger(args.group_id) || args.group_id <= 0) throw new Error('group_id must be a positive integer')
          return await call('/api/ai/synonym-groups/' + args.group_id.toString()) as Record<string, Json>
        },
      }),
    },
    {
      name: 'synonym_group_create',
      definition: defineTool({
        name: 'synonym_group_create',
        description: 'Create one synonym group: a canonical wording plus up to 12 aliases. Aliases are unique across groups. Requires explicit user approval; DataOps rebuilds the search index after the write. Super administrators only.',
        parameters: {
          canonical: { type: 'string', required: true, description: 'The standard wording, e.g. 酒店.' },
          aliases: { type: 'array', items: { type: 'string' }, description: 'Alternative wordings, e.g. 旅馆, 宾馆, hotel.' },
          catalog_node_id: { type: 'number', description: 'Optional catalog node id the group belongs to.' },
          description: { type: 'string', description: 'Optional description.' },
          is_enabled: { type: 'boolean', description: 'Whether the group takes effect immediately (default true).' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { canonical: string; aliases?: string[]; catalog_node_id?: number; description?: string; is_enabled?: boolean }, exec) => {
          if (typeof args.canonical !== 'string' || args.canonical.trim() === '') throw new Error('canonical is required')
          await approve('synonym_group_create', exec, 'Create synonym group ' + args.canonical.trim())
          const body = {
            canonical: args.canonical.trim(),
            aliases: args.aliases ?? [],
            catalogNodeId: args.catalog_node_id ?? null,
            description: args.description ?? null,
            isEnabled: args.is_enabled ?? true,
          }
          const value = await call('/api/ai/synonym-groups', { method: 'POST', body: JSON.stringify(body) })
          audit('synonym_group_create', exec, { canonical: body.canonical, aliasCount: body.aliases.length })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'synonym_group_update',
      definition: defineTool({
        name: 'synonym_group_update',
        description: 'Update one synonym group: canonical wording, aliases, catalog node, description or enabled flag. Requires explicit user approval; DataOps rebuilds the documents that expanded the group. Super administrators only.',
        parameters: {
          group_id: { type: 'number', required: true, description: 'Synonym group id.' },
          canonical: { type: 'string', description: 'New standard wording.' },
          aliases: { type: 'array', items: { type: 'string' }, description: 'Full replacement alias list (max 12).' },
          catalog_node_id: { type: 'number', description: 'New catalog node id.' },
          description: { type: 'string', description: 'New description.' },
          is_enabled: { type: 'boolean', description: 'Enable or disable the group.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { group_id: number; canonical?: string; aliases?: string[]; catalog_node_id?: number; description?: string; is_enabled?: boolean }, exec) => {
          if (!Number.isSafeInteger(args.group_id) || args.group_id <= 0) throw new Error('group_id must be a positive integer')
          await approve('synonym_group_update', exec, 'Update synonym group ' + args.group_id.toString())
          const body: Record<string, unknown> = {}
          if (args.canonical !== undefined) body.canonical = args.canonical
          if (args.aliases !== undefined) body.aliases = args.aliases
          if (args.catalog_node_id !== undefined) body.catalogNodeId = args.catalog_node_id
          if (args.description !== undefined) body.description = args.description
          if (args.is_enabled !== undefined) body.isEnabled = args.is_enabled
          const value = await call('/api/ai/synonym-groups/' + args.group_id.toString(), { method: 'PATCH', body: JSON.stringify(body) })
          audit('synonym_group_update', exec, { groupId: args.group_id })
          return value as Record<string, Json>
        },
      }),
    },
    {
      name: 'synonym_group_delete',
      definition: defineTool({
        name: 'synonym_group_delete',
        description: 'Disable a synonym group (default) or permanently delete it with purge=true. Requires explicit user approval. Super administrators only.',
        parameters: {
          group_id: { type: 'number', required: true, description: 'Synonym group id.' },
          purge: { type: 'boolean', description: 'Delete permanently instead of disabling.' },
        },
        output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
        execute: async (args: { group_id: number; purge?: boolean }, exec) => {
          if (!Number.isSafeInteger(args.group_id) || args.group_id <= 0) throw new Error('group_id must be a positive integer')
          const purge = args.purge === true
          await approve('synonym_group_delete', exec, (purge ? 'Delete' : 'Disable') + ' synonym group ' + args.group_id.toString())
          const value = await call('/api/ai/synonym-groups/' + args.group_id.toString() + (purge ? '?purge=true' : ''), { method: 'DELETE' })
          audit('synonym_group_delete', exec, { groupId: args.group_id, purge })
          return value as Record<string, Json>
        },
      }),
    },
  ]

}