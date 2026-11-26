/**
 * Five knowledge-base permissions and the roles that bundle them.
 *
 * A knowledge base needs one vocabulary everyone can agree on before it can have a
 * permission screen. DataOps already owns the enforcement — this module does NOT
 * re-decide who may read a path. What it adds is the product's own vocabulary on
 * top of that enforcement:
 *
 * - **Five actions**, not three. An editor who may add a document is not
 *   automatically allowed to delete one, so `create` and `delete` stay separate.
 *   `all` exists because "give this person everything on this folder" is the
 *   common case, and spelling it as four grants invites three of them being
 *   forgotten.
 * - **Two built-in roles** that are scoped here rather than in DataOps, because
 *   "super administrator" means super-administrator-of-the-knowledge-base, not of
 *   the platform. Treating it as a global DataOps role would hand out far more
 *   than the label promises.
 *
 * ## The one rule that keeps this honest
 *
 * {@link permissionToDataOpsActions} only ever expresses a requirement, and
 * {@link dataOpsActionsToPermissions} only ever NARROWS one. A permission the
 * product shows must be one DataOps can enforce; when the two disagree the
 * narrower answer wins, because showing a permission that will be refused is
 * worse than not showing it.
 *
 * @module @sparkelf/dsh-knowledge-base/permissions
 */

// One shared definition of "may this code be a directory name", so the role's path
// prefix and the view's folder layout cannot disagree about what a valid chain is.
import { usableDepartmentPath } from './views.ts'

/**
 * One action a caller can hold on a knowledge path.
 *
 * `all` is deliberately last and deliberately not a fifth privilege: it is the
 * union of the four before it. {@link expandActions} is the only correct way to
 * read it.
 */
export const KNOWLEDGE_ACTIONS = ['read', 'create', 'update', 'delete', 'all'] as const

/** One knowledge action. */
export type KnowledgeAction = typeof KNOWLEDGE_ACTIONS[number]

/** The four concrete actions `all` stands for, in the order a UI should show them. */
export const CONCRETE_ACTIONS = ['read', 'create', 'update', 'delete'] as const

/** One concrete action, never `all`. */
export type ConcreteKnowledgeAction = typeof CONCRETE_ACTIONS[number]

/** Display name per action, for the permission screen. */
export const ACTION_LABELS: Readonly<Record<KnowledgeAction, { zh: string; en: string }>> = {
  read: { zh: '查', en: 'Read' },
  create: { zh: '增', en: 'Create' },
  update: { zh: '改', en: 'Update' },
  delete: { zh: '删', en: 'Delete' },
  all: { zh: '全部', en: 'All' },
}

/**
 * Whether a value names a knowledge action.
 *
 * @param value - candidate, typically read from a request body.
 * @returns true when it is one of {@link KNOWLEDGE_ACTIONS}.
 */
export function isKnowledgeAction(value: unknown): value is KnowledgeAction {
  return typeof value === 'string' && (KNOWLEDGE_ACTIONS as readonly string[]).includes(value)
}

/**
 * Expand any action set into the concrete actions it grants.
 *
 * `all` becomes the four concrete actions; anything else passes through. The
 * result is de-duplicated and ordered by {@link CONCRETE_ACTIONS}, so two callers
 * holding the same privileges always produce the same list and a comparison does
 * not depend on input order.
 *
 * @param actions - whatever a grant or a request holds.
 * @returns the concrete actions, ordered and unique.
 */
export function expandActions(actions: readonly KnowledgeAction[]): ConcreteKnowledgeAction[] {
  const held = new Set<ConcreteKnowledgeAction>()
  for (const action of actions) {
    if (action === 'all') {
      for (const concrete of CONCRETE_ACTIONS) held.add(concrete)
      continue
    }
    held.add(action)
  }
  return CONCRETE_ACTIONS.filter(action => held.has(action))
}

/**
 * Collapse concrete actions back into the shortest describing set.
 *
 * The inverse of {@link expandActions}: four concrete actions answer `['all']`,
 * because that is what the grant table should store and what the UI should show.
 * A partial set stays explicit so nothing looks broader than it is.
 *
 * @param actions - any actions, including `all`.
 * @returns `['all']` when everything is held, else the concrete subset.
 */
export function collapseActions(actions: readonly KnowledgeAction[]): KnowledgeAction[] {
  const concrete = expandActions(actions)
  return concrete.length === CONCRETE_ACTIONS.length ? ['all'] : concrete
}

/**
 * Whether a held set covers every action another set requires.
 *
 * Used by the permission screen to answer "does this grant already give them
 * that", and by the role editor to refuse a downgrade that was meant to be a
 * no-op.
 *
 * @param held - actions the caller currently has.
 * @param required - actions the operation needs.
 * @returns true when every required action is held.
 */
export function coversActions(held: readonly KnowledgeAction[], required: readonly KnowledgeAction[]): boolean {
  const owned = new Set(expandActions(held))
  return expandActions(required).every(action => owned.has(action))
}

/**
 * DataOps actions this product understands, and what each one means here.
 *
 * Only the three that describe document editing are listed. The platform's other
 * actions (`comment`, `share`, `audit`, the `space_*` family) grant nothing this
 * plugin enforces, so mapping them would publish permissions with no effect.
 */
const DATA_OPS_ACTION_MAP: Readonly<Record<string, readonly ConcreteKnowledgeAction[]>> = {
  // `manage` is DataOps' own "everything" action; computeResult expands it across
  // the whole action list, which is why it maps to all four here rather than to a
  // single one.
  manage: ['read', 'create', 'update', 'delete'],
  read: ['read'],
  // DataOps calls both creating and editing `write`; the product separates them
  // because deleting is the one action people expect to be asked about.
  write: ['create', 'update'],
  delete: ['delete'],
}

/**
 * Translate a product permission into the DataOps actions that would satisfy it.
 *
 * A grant request is a REQUIREMENT, not a decision: these actions are what the
 * caller asks DataOps to record, and DataOps still decides whether it may.
 *
 * @param action - one knowledge action, `all` included.
 * @returns the DataOps actions to record, or an empty list for an unknown action.
 */
export function permissionToDataOpsActions(action: KnowledgeAction): string[] {
  switch (action) {
    case 'read': return ['read']
    case 'create': return ['write']
    case 'update': return ['write']
    case 'delete': return ['delete']
    // One `manage` rather than four separate grants: DataOps expands it itself, and
    // four grants would leave a partial state if one of them failed.
    case 'all': return ['manage']
    default: return []
  }
}

/**
 * Translate the DataOps actions a caller actually holds into product permissions.
 *
 * This NARROWS: only actions listed in {@link DATA_OPS_ACTION_MAP} contribute, so a
 * `comment` grant shows nothing rather than something the plugin cannot enforce.
 *
 * @param dataOpsActions - actions DataOps reported as allowed.
 * @returns the product permissions those actions justify.
 */
export function dataOpsActionsToPermissions(dataOpsActions: readonly string[]): KnowledgeAction[] {
  const concrete = new Set<ConcreteKnowledgeAction>()
  for (const action of dataOpsActions) {
    const mapped = DATA_OPS_ACTION_MAP[action]
    if (mapped === undefined) continue
    for (const permission of mapped) concrete.add(permission)
  }
  return collapseActions(CONCRETE_ACTIONS.filter(action => concrete.has(action)))
}

/**
 * Identifier of the built-in role that may do anything anywhere.
 *
 * The prefix keeps it from colliding with a DataOps role code: this is a role OF
 * THE KNOWLEDGE BASE, and a DataOps role that happens to be called `admin` must
 * not silently acquire its powers.
 */
export const SUPER_ADMIN_ROLE = 'knowledge-super-admin'

/** Identifier of the built-in role that administers one department's documents. */
export const DEPARTMENT_ADMIN_ROLE = 'knowledge-dept-admin'

/** One built-in role. */
export interface BuiltInRole {
  /** Stable id, stored as the grant's `principalId`. */
  id: string
  /** Display name. */
  name: { zh: string; en: string }
  /** What the role can do, for the role list. */
  description: { zh: string; en: string }
  /** Actions it confers on a path it covers. */
  actions: readonly KnowledgeAction[]
  /** Whether the role's coverage depends on the caller's own department. */
  departmentScoped: boolean
  /**
   * Whether it may be removed.
   *
   * Always false for the built-ins: a knowledge base with no super administrator
   * has nobody able to restore one, which is a state no screen should be able to
   * reach.
   */
  removable: false
}

/** The roles every knowledge base starts with. */
export const BUILT_IN_ROLES: readonly BuiltInRole[] = [
  {
    id: SUPER_ADMIN_ROLE,
    name: { zh: '超级管理员', en: 'Super administrator' },
    description: {
      zh: '拥有知识库全部权限，可管理任意层级的文档与授权。',
      en: 'Full knowledge-base access, including every path and every grant.',
    },
    actions: ['all'],
    departmentScoped: false,
    removable: false,
  },
  {
    id: DEPARTMENT_ADMIN_ROLE,
    name: { zh: '部门管理员', en: 'Department administrator' },
    description: {
      zh: '拥有本部门文档的全部权限，看不到其他部门。',
      en: 'Full access to the documents of the holder’s own department only.',
    },
    actions: ['all'],
    departmentScoped: true,
    removable: false,
  },
]

/**
 * Look a built-in role up by id.
 *
 * @param id - role id, typically a grant's `principalId`.
 * @returns the role, or undefined when the id names no built-in.
 */
export function builtInRoleOf(id: string): BuiltInRole | undefined {
  return BUILT_IN_ROLES.find(role => role.id === id)
}

/**
 * The path prefix a department-scoped role covers.
 *
 * With an organization path the prefix is the caller's OWN department folder inside
 * the nested layout, `department/<ancestor>/.../<own>/`. A department administrator
 * manages their own department's documents, not an ancestor's: a parent folder holds
 * sibling departments they have no business in.
 *
 * The nested prefix ends with the caller's own code and starts at the organization
 * root, because the path is root-first. That is why this returns a whole prefix
 * rather than a bare code: the caller's code alone appears at several depths.
 *
 * Without a usable path (an older backend) the legacy single-level
 * `department/<code>/` is returned, so an un-upgraded deployment keeps exactly the
 * permissions it had.
 *
 * @param departmentCode - the caller's own department code.
 * @param departmentPathCodes - the caller's organization path, root first.
 * @returns The prefix, or undefined when there is no department to scope to.
 */
export function departmentScopeOf(
  departmentCode: string | undefined,
  departmentPathCodes?: readonly string[],
): string | undefined {
  const path = usableDepartmentPath(departmentPathCodes)
  if (path.length > 0) return 'department/' + path.join('/') + '/'
  if (departmentCode === undefined || departmentCode.trim() === '') return undefined
  return 'department/' + departmentCode.trim() + '/'
}

/**
 * Whether one built-in role covers one path for one caller.
 *
 * The prefix is compared as a PREFIX of the finished path, so a department
 * administrator's own folder covers everything inside it but never a peer's. The
 * nested prefix carries the caller's whole chain, so `department/A/B/` covers
 * `department/A/B/2026/计划.md` and never `department/A/C/...`: sharing the ancestor
 * `A` is not enough to reach a sibling.
 *
 * @param roleId - the built-in role's id.
 * @param relPath - path relative to the knowledge root.
 * @param departmentCode - the caller's department, when they have one.
 * @param departmentPathCodes - the caller's organization path, root first.
 * @returns true when the role confers its actions on that path for that caller.
 */
export function builtInRoleCoversPath(
  roleId: string,
  relPath: string,
  departmentCode: string | undefined,
  departmentPathCodes?: readonly string[],
): boolean {
  const role = builtInRoleOf(roleId)
  if (role === undefined) return false
  if (!role.departmentScoped) return true
  const scope = departmentScopeOf(departmentCode, departmentPathCodes)
  if (scope === undefined) return false
  // The bucket and the caller's own department folder are covered too: a department
  // administrator manages their department's container, not only the documents in it.
  if (relPath === 'department') return true
  return relPath.startsWith(scope) || relPath === scope.slice(0, -1)
}

/**
 * Every action a role confers on a path, for a given caller.
 *
 * @param roleId - role id.
 * @param relPath - path relative to the knowledge root.
 * @param departmentCode - the caller's department, when they have one.
 * @param departmentPathCodes - the caller's organization path, root first.
 * @returns the concrete actions, empty when the role does not cover the path.
 */
export function builtInRoleActionsOn(
  roleId: string,
  relPath: string,
  departmentCode: string | undefined,
  departmentPathCodes?: readonly string[],
): ConcreteKnowledgeAction[] {
  const role = builtInRoleOf(roleId)
  if (role === undefined) return []
  if (!builtInRoleCoversPath(roleId, relPath, departmentCode, departmentPathCodes)) return []
  return expandActions(role.actions)
}

/** The result of asking whether a role may do something to a path. */
export interface RoleDecision {
  /** Whether the role covers the path at all. */
  covered: boolean
  /** Actions granted on it. */
  actions: ConcreteKnowledgeAction[]
  /** One sentence explaining a refusal, for the UI to show verbatim. */
  reason?: string
}

/**
 * Explain whether a role grants an action on a path.
 *
 * The explanation is part of the answer rather than something a screen composes
 * afterwards: a refusal that says only "denied" cannot be acted on, and the two
 * reasons here are very different problems — the wrong department is a
 * permission request, an unknown role is a stale screen.
 *
 * @param roleId - role id.
 * @param relPath - path relative to the knowledge root.
 * @param action - the action being attempted.
 * @param departmentCode - the caller's department, when they have one.
 * @param departmentPathCodes - the caller's organization path, root first.
 * @returns the decision, with a reason whenever it is negative.
 */
export function decideRoleAction(
  roleId: string,
  relPath: string,
  action: KnowledgeAction,
  departmentCode: string | undefined,
  departmentPathCodes?: readonly string[],
): RoleDecision {
  const role = builtInRoleOf(roleId)
  if (role === undefined) {
    return { covered: false, actions: [], reason: 'unknown role: ' + roleId }
  }
  if (!builtInRoleCoversPath(roleId, relPath, departmentCode, departmentPathCodes)) {
    return {
      covered: false,
      actions: [],
      reason: role.departmentScoped
        ? 'this path is outside department ' + (departmentScopeOf(departmentCode, departmentPathCodes) ?? '(none)')
        : 'this path is outside the role',
    }
  }
  const actions = expandActions(role.actions)
  if (!coversActions(actions, [action])) {
    return { covered: true, actions, reason: 'the role does not grant ' + action }
  }
  return { covered: true, actions }
}

/**
 * Whether a role id names a built-in role rather than one an administrator made.
 *
 * The permission screen needs this to decide whether to offer a delete button,
 * and a grant does not record the difference: only the id does.
 *
 * @param roleId - role id from a grant.
 * @returns true when it is one of {@link BUILT_IN_ROLES}.
 */
export function isBuiltInRole(roleId: string): boolean {
  return builtInRoleOf(roleId) !== undefined
}
