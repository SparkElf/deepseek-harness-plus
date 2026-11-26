/**
 * Two ways to read the same grant table: by person, and by resource.
 *
 * A grant says "this principal may do this to this path". That is the right shape
 * to STORE and the wrong shape to AUDIT: an administrator asked "what does 张三
 * have" and "who can see 制度.md" is asking two questions that one row-per-grant
 * layout cannot answer without being read line by line.
 *
 * Both views are derived on the client from the same payload. No second endpoint
 * exists because there is no second truth: deriving them here means the overview
 * cannot disagree with the table it summarizes.
 *
 * @module @sparkelf/dsh-knowledge-base/client/KnowledgePermissionOverview
 */

import { useMemo } from 'react'
import type { GrantView, KnowledgeGrantSubjectType } from '../api.ts'
import { buildRoleSummaries, type RoleSummary } from './roleSummary.ts'

/** One person's holdings, as the person view renders them. */
export interface PersonHoldings {
  /** Principal id the grants name. */
  principalId: string
  /** Display name when a directory entry resolved one, else the id. */
  label: string
  /** Distinct paths this person may touch. */
  paths: string[]
  /** Which actions the person holds, collapsed so a full house reads `all`. */
  actions: string[]
  /**
   * Roles the person reaches through a `role` grant they belong to.
   *
   * Empty when the directory does not know the membership: a role grant names the
   * ROLE, not the people in it, so this is only populated when a directory entry
   * declared the membership.
   */
  roles: string[]
}

/** One resource and everyone who may reach it. */
export interface ResourceHoldings {
  /** Path, relative to the mount point. */
  relPath: string
  /** Whether it is a file or a directory. */
  kind: 'file' | 'directory'
  /** Everyone holding any action on it, grouped by principal kind. */
  principals: Array<{ principalType: KnowledgeGrantSubjectType; principalId: string; label: string; actions: string[] }>
}

/** Actions in the order the product shows them. */
const ACTION_ORDER = ['read', 'create', 'update', 'delete', 'all'] as const

/**
 * Collapse a set of action strings into the shortest describing list.
 *
 * Mirrors the server's collapse rule without importing it: this file is bundled
 * for the browser and must not pull the server module in. Keeping the rule in
 * two places is a real cost, so it is stated once here and covered by the same
 * expectations as the server's own test.
 *
 * @param actions - raw action strings from grants.
 * @returns `['all']` when everything is held, else the concrete subset in order.
 */
export function summarizeActions(actions: readonly string[]): string[] {
  const concrete = new Set(actions.filter(action => action !== 'all'))
  if (actions.includes('all')) {
    return ['all']
  }
  if (['read', 'create', 'update', 'delete'].every(action => concrete.has(action))) {
    return ['all']
  }
  return ACTION_ORDER.filter(action => concrete.has(action))
}

/**
 * Group grants by the principal they name.
 *
 * A principal appearing in several grants is one row: "what does 张三 have" is a
 * question about a person, and splitting them across rows because they hold two
 * paths would answer it wrong.
 *
 * @param grants - the grant table.
 * @param labels - display names by `principalType:principalId`, optional.
 * @returns one entry per principal, ordered by label then id.
 */
export function groupHoldingsByPrincipal(
  grants: readonly GrantView[],
  labels: Readonly<Record<string, string>> = {},
): PersonHoldings[] {
  const byPrincipal = new Map<string, { type: KnowledgeGrantSubjectType; id: string; paths: Set<string>; actions: Set<string>; roles: Set<string> }>()
  for (const grant of grants) {
    const key = grant.principalType + ':' + grant.principalId
    let entry = byPrincipal.get(key)
    if (entry === undefined) {
      entry = { type: grant.principalType, id: grant.principalId, paths: new Set(), actions: new Set(), roles: new Set() }
      byPrincipal.set(key, entry)
    }
    entry.paths.add(grant.relPath)
    entry.actions.add(grant.action)
    // A role grant names the role; the people in it are a directory fact this view
    // can only report when the caller supplied one.
    if (grant.principalType === 'role') entry.roles.add(grant.principalId)
  }
  return [...byPrincipal.values()]
    .map((entry) => {
      const key = entry.type + ':' + entry.id
      return {
        principalId: entry.id,
        label: labels[key] ?? entry.id,
        paths: [...entry.paths].sort(),
        actions: summarizeActions([...entry.actions]),
        roles: [...entry.roles].sort(),
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Group grants by the resource they cover.
 *
 * @param grants - the grant table.
 * @param labels - display names by `principalType:principalId`, optional.
 * @returns one entry per path, ordered by path.
 */
export function groupHoldingsByResource(
  grants: readonly GrantView[],
  labels: Readonly<Record<string, string>> = {},
): ResourceHoldings[] {
  const byPath = new Map<string, { kind: 'file' | 'directory'; holders: Map<string, { type: KnowledgeGrantSubjectType; id: string; actions: Set<string> }> }>()
  for (const grant of grants) {
    let entry = byPath.get(grant.relPath)
    if (entry === undefined) {
      entry = { kind: grant.kind, holders: new Map() }
      byPath.set(grant.relPath, entry)
    }
    const key = grant.principalType + ':' + grant.principalId
    let holder = entry.holders.get(key)
    if (holder === undefined) {
      holder = { type: grant.principalType, id: grant.principalId, actions: new Set() }
      entry.holders.set(key, holder)
    }
    holder.actions.add(grant.action)
  }
  return [...byPath.entries()]
    .map(([relPath, entry]) => ({
      relPath,
      kind: entry.kind,
      principals: [...entry.holders.values()]
        .map(holder => ({
          principalType: holder.type,
          principalId: holder.id,
          label: labels[holder.type + ':' + holder.id] ?? holder.id,
          actions: summarizeActions([...holder.actions]),
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
}

/** Copy for the overview, supplied by the caller's locale record. */
export interface OverviewCopy {
  tabByPerson: string
  tabByResource: string
  empty: string
  pathsHeld: (count: number) => string
  rolesHeld: string
  actionsHeld: string
  builtInRoles: string
  noActions: string
}

/** Props the parent panel supplies. */
export interface KnowledgePermissionOverviewProps {
  /** The grant table already loaded by the permissions page. */
  grants: readonly GrantView[]
  /** Display names by `principalType:principalId`. */
  labels?: Readonly<Record<string, string>>
  /** Built-in role summaries, so the person view can explain what a role means. */
  roles?: readonly RoleSummary[]
  /** Locale copy. */
  copy: OverviewCopy
}

/**
 * Render both readings of the grant table under one tab strip.
 *
 * The two tabs share the loaded grants rather than fetching twice: they are two
 * renderings of one answer, and a refresh between them would let the screen show
 * a person and a resource that disagree.
 *
 * @param props - grants, labels, role summaries and copy.
 */
export function KnowledgePermissionOverview(props: KnowledgePermissionOverviewProps) {
  const { grants, labels = {}, copy } = props
  const people = useMemo(() => groupHoldingsByPrincipal(grants, labels), [grants, labels])
  const resources = useMemo(() => groupHoldingsByResource(grants, labels), [grants, labels])
  const roles = useMemo(
    () => props.roles ?? buildRoleSummaries(grants),
    [grants, props.roles],
  )

  if (grants.length === 0) {
    return (
      <div className="dsh-kb-overview-empty" data-kb-overview="empty">
        {copy.empty}
      </div>
    )
  }

  return (
    <div className="dsh-kb-overview" data-kb-overview="ready">
      {roles.length > 0 && (
        <section className="dsh-kb-overview-roles" data-kb-overview="roles">
          <h4 className="dsh-kb-overview-heading">{copy.builtInRoles}</h4>
          <ul className="dsh-kb-overview-role-list">
            {roles.map(role => (
              <li key={role.id} className="dsh-kb-overview-role" data-kb-role={role.id}>
                <span className="dsh-kb-overview-role-name">{role.label}</span>
                <span className="dsh-kb-overview-role-actions">
                  {role.actions.length === 0 ? copy.noActions : role.actions.join(' / ')}
                </span>
                {role.paths.length > 0 && (
                  <span className="dsh-kb-overview-role-paths">
                    {copy.pathsHeld(role.paths.length)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="dsh-kb-overview-people" data-kb-overview="people">
        <h4 className="dsh-kb-overview-heading">{copy.tabByPerson}</h4>
        <ul className="dsh-kb-overview-list">
          {people.map(person => (
            <li key={person.principalId} className="dsh-kb-overview-item" data-kb-person={person.principalId}>
              <div className="dsh-kb-overview-row">
                <span className="dsh-kb-overview-name">{person.label}</span>
                <span className="dsh-kb-overview-actions" title={copy.actionsHeld}>
                  {person.actions.length === 0 ? copy.noActions : person.actions.join(' / ')}
                </span>
                <span className="dsh-kb-overview-count">{copy.pathsHeld(person.paths.length)}</span>
              </div>
              {person.roles.length > 0 && (
                <div className="dsh-kb-overview-roles-inline" title={copy.rolesHeld}>
                  {person.roles.join(' · ')}
                </div>
              )}
              {person.paths.length > 0 && (
                <details className="dsh-kb-overview-paths">
                  <summary>{copy.pathsHeld(person.paths.length)}</summary>
                  <ul>
                    {person.paths.map(path => <li key={path}>{path}</li>)}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="dsh-kb-overview-resources" data-kb-overview="resources">
        <h4 className="dsh-kb-overview-heading">{copy.tabByResource}</h4>
        <ul className="dsh-kb-overview-list">
          {resources.map(resource => (
            <li key={resource.relPath} className="dsh-kb-overview-item" data-kb-resource={resource.relPath}>
              <div className="dsh-kb-overview-row">
                <span className="dsh-kb-overview-name">{resource.relPath}</span>
                <span className="dsh-kb-overview-kind">{resource.kind}</span>
                <span className="dsh-kb-overview-count">{copy.pathsHeld(resource.principals.length)}</span>
              </div>
              <ul className="dsh-kb-overview-holders">
                {resource.principals.map(holder => (
                  <li key={holder.principalType + ':' + holder.principalId}>
                    <span className="dsh-kb-overview-holder-name">{holder.label}</span>
                    <span className="dsh-kb-overview-holder-actions">
                      {holder.actions.length === 0 ? copy.noActions : holder.actions.join(' / ')}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
