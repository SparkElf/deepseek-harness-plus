/**
 * What each role in the grant table actually amounts to.
 *
 * A role is not stored anywhere: it exists because grants name it. That is a good
 * property to inherit — a role cannot outlive its resources or appear with none —
 * but it means "list the roles" is a question about the grants, answered by
 * reading them. This module is that reading, kept out of the component so it can
 * be tested without a DOM.
 *
 * @module @sparkelf/dsh-knowledge-base/client/roleSummary
 */

import type { GrantView } from '../api.ts'

/** One role as the overview shows it. */
export interface RoleSummary {
  /** Role id, which is the `principalId` its grants carry. */
  id: string
  /** Display name, falling back to the id when no locale entry matches. */
  label: string
  /** Actions granted anywhere by this role, collapsed so a full house reads `all`. */
  actions: string[]
  /** Distinct paths it reaches. */
  paths: string[]
  /** Whether this is one of the two the product ships with. */
  builtIn: boolean
}

/** Display names for the built-in roles, kept beside the ids they name. */
const BUILT_IN_LABELS: Readonly<Record<string, { zh: string; en: string }>> = {
  'knowledge-super-admin': { zh: '超级管理员', en: 'Super administrator' },
  'knowledge-dept-admin': { zh: '部门管理员', en: 'Department administrator' },
}

/** Actions in product order, so two renderings of the same grants agree. */
const ACTION_ORDER = ['read', 'create', 'update', 'delete', 'all'] as const

/**
 * Collapse raw action strings into the shortest describing list.
 *
 * The client needs this independently of the server: the overview renders grants
 * the server already wrote, so it summarizes what is there rather than what a
 * request asked for.
 *
 * @param actions - raw action strings.
 * @returns `['all']` when all four concrete actions are held, else the subset.
 */
export function summarizeRoleActions(actions: readonly string[]): string[] {
  if (actions.includes('all')) return ['all']
  const held = new Set(actions)
  if (ACTION_ORDER.slice(0, 4).every(action => held.has(action))) return ['all']
  return ACTION_ORDER.filter(action => held.has(action))
}

/**
 * Read the roles out of a grant table.
 *
 * Only `role` grants contribute: a user grant is not a role, and inventing one
 * per user would flood the list with rows that mean nothing.
 *
 * @param grants - the grant table.
 * @param locale - `zh` or `en`, for the built-in role names.
 * @returns one entry per role named by a grant, built-ins first then alphabetical.
 */
export function buildRoleSummaries(grants: readonly GrantView[], locale: 'zh' | 'en' = 'zh'): RoleSummary[] {
  const byRole = new Map<string, { paths: Set<string>; actions: Set<string> }>()
  for (const grant of grants) {
    if (grant.principalType !== 'role') continue
    let entry = byRole.get(grant.principalId)
    if (entry === undefined) {
      entry = { paths: new Set(), actions: new Set() }
      byRole.set(grant.principalId, entry)
    }
    entry.paths.add(grant.relPath)
    entry.actions.add(grant.action)
  }
  const summaries = [...byRole.entries()].map(([id, entry]) => {
    const builtIn = BUILT_IN_LABELS[id]
    return {
      id,
      label: builtIn === undefined ? id : builtIn[locale],
      actions: summarizeRoleActions([...entry.actions]),
      paths: [...entry.paths].sort(),
      builtIn: builtIn !== undefined,
    }
  })
  // Built-ins first: they are the ones an administrator is expected to know about,
  // and burying them between custom roles makes the list harder to scan.
  return summaries.sort((a, b) => {
    if (a.builtIn !== b.builtIn) return a.builtIn ? -1 : 1
    return a.label.localeCompare(b.label)
  })
}
