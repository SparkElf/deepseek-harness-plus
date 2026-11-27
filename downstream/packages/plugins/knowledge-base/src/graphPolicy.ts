/**
 * Visibility and management policy for memory graphs.
 *
 * This module is the pure decision layer only: callers resolve the viewer's
 * department subtree (`visibleDepartmentCodes`) and manageable subtree from
 * DataOps, then ask one graph at a time. It never reads configuration, never
 * touches the file system, and never invents a broader scope than it was handed.
 *
 * The rules come from the memory-graph design:
 *
 * - `private` belongs to its owner; administrators and super administrators do
 *   not see it by default (breaking the glass is a separate, audited action);
 * - `global` is readable by any authenticated viewer;
 * - `department` requires the graph's department code in the viewer's visible
 *   subtree. Department administrators understand their subtree through
 *   `manageableDepartmentCodes`; a plain member has neither the role nor the
 *   list.
 *
 * @module @sparkelf/dsh-knowledge-base/graph-policy
 */

/** The authenticated caller asking about a graph. */
export interface GraphViewer {
  userId: string
  isAdmin: boolean
  isSuperAdmin: boolean
  departmentCode?: string
  /** Visible department subtree (including the caller's own); members see only their own. */
  visibleDepartmentCodes: string[]
  /** Department subtree the caller may manage; empty for ordinary members. */
  manageableDepartmentCodes?: string[]
}

/** The scope a graph lives in, as resolved from its manifest. */
export interface GraphScopeDescriptor {
  visibility: 'private' | 'department' | 'global'
  ownerId?: string
  departmentCode?: string
}

/** Whether the viewer is authenticated at all. An empty id is not a user. */
const isAuthenticated = (viewer: GraphViewer): boolean => viewer.userId.trim() !== ''

const ownsPrivate = (viewer: GraphViewer, scope: GraphScopeDescriptor): boolean =>
  scope.ownerId !== undefined && scope.ownerId !== '' && scope.ownerId === viewer.userId

const contains = (codes: readonly string[] | undefined, code: string | undefined): boolean =>
  code !== undefined && code !== '' && codes !== undefined && codes.includes(code)

/**
 * Whether the viewer may read the graph.
 *
 * Private graphs are owner-only before any role check runs, so neither an
 * administrator nor a super administrator can discover someone else's private
 * graph through this function. Department access is exact membership: the caller
 * is responsible for expanding `visibleDepartmentCodes` to the subtree, which
 * keeps hierarchy logic in the one place that already knows it.
 */
export function canViewGraph(viewer: GraphViewer, scope: GraphScopeDescriptor): boolean {
  if (scope.visibility === 'private') return ownsPrivate(viewer, scope)
  if (!isAuthenticated(viewer)) return false
  if (scope.visibility === 'global') return true
  if (scope.visibility !== 'department') return false
  if (scope.departmentCode === undefined || scope.departmentCode === '') return false
  if (contains(viewer.visibleDepartmentCodes, scope.departmentCode)) return true
  // An administrator's management range is also a reading range: the design gives
  // administrators every non-private graph in the departments they manage, even
  // when the caller only expanded `visibleDepartmentCodes` for membership.
  if (viewer.isAdmin && contains(viewer.manageableDepartmentCodes, scope.departmentCode)) return true
  return viewer.isSuperAdmin
}

/**
 * Whether the viewer may manage the graph (edit metadata, publish, change
 * authority).
 *
 * Management always implies visibility. Private graphs stay owner-only. Global
 * graphs need an administrator role. Department graphs need the department in
 * `manageableDepartmentCodes`; a super administrator covers every department,
 * and the two lists in {@link GraphViewer} are trusted as already-resolved
 * authorization input rather than re-derived here.
 */
export function canManageGraph(viewer: GraphViewer, scope: GraphScopeDescriptor): boolean {
  if (!canViewGraph(viewer, scope)) return false
  if (scope.visibility === 'private') return ownsPrivate(viewer, scope)
  if (scope.visibility === 'global') return viewer.isAdmin || viewer.isSuperAdmin
  if (scope.visibility !== 'department') return false
  return viewer.isSuperAdmin || contains(viewer.manageableDepartmentCodes, scope.departmentCode)
}

/**
 * Filter graphs down to the ones the viewer may read, preserving input order.
 *
 * Order is preserved on purpose: the caller already sorted for display, and this
 * function must not introduce a second ordering rule. A denial is a removal, not
 * an error; callers never receive a name they may not see.
 */
export function filterVisibleGraphs<T extends { scope: GraphScopeDescriptor }>(viewer: GraphViewer, graphs: T[]): T[] {
  return graphs.filter(graph => canViewGraph(viewer, graph.scope))
}
