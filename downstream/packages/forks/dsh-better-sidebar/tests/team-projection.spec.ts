/**
 * Unit tests for the `agentTeam` projection adapter: reading the Lead
 * Session's board off the client snapshot, and overlaying runtime activity
 * onto the durable roster.
 *
 * Two host generations are covered on purpose:
 *
 * - DSH 0.2.2-alpha.x published `{ members: {id,name,role,phase,error?},
 *   tasks, failure? }`; a projection that is absent meant "this session leads
 *   no team" (or the deployment never mounted the layer).
 * - DSH 0.2.2-rc.2 REMOVED `members` and added `enabled`; the roster is the
 *   root's `subagentCatalog` projection. Mapping the removed field crashed the
 *   Tasks page with `team.members is undefined`, so the rc.2 cases pin the
 *   derived roster and the disabled-projection gate.
 */
import { describe, expect, it } from 'vitest'
import { teamMembersOf, teamProjectionOf } from '../src/client/team-projection.ts'
import type {
  SidebarChildLiveView,
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarSubagentCatalogEntry,
  SidebarTeamMemberProjection,
  SidebarTeamProjection,
} from '../src/context-types.ts'

/** One durable roster row. */
function member(over: Partial<SidebarTeamMemberProjection> = {}): SidebarTeamMemberProjection {
  return { id: 'w', name: 'writer', role: 'teammate', phase: 'active', ...over }
}

/** One Lead Session projection (the ≤0.2.2-alpha.x shape). */
function team(over: Partial<SidebarTeamProjection> = {}): SidebarTeamProjection {
  return { members: [member()], tasks: [], ...over }
}

/** The DSH 0.2.2-rc.2 projection: no `members`, plus the saved mode. */
function rc2Team(over: Partial<SidebarTeamProjection> = {}): SidebarTeamProjection {
  return { enabled: true, tasks: [], ...over }
}

/** One catalog row (the rc.2 roster source). */
function catalogEntry(over: Partial<SidebarSubagentCatalogEntry> & { id: string }): SidebarSubagentCatalogEntry {
  return { createdAt: 1, mode: 'continuable', ...over }
}

/** The snapshot's projection map with one session's team installed. */
function projections(
  rootId: string,
  teamValue: SidebarTeamProjection,
): SidebarSessionList['projectionsBySession'] {
  return { [rootId]: { values: { agentTeam: teamValue }, state: 'ready', error: null } }
}

/** A summary row. */
function summary(id: string, over: Partial<SidebarSessionSummary> = {}): SidebarSessionSummary {
  return { id, displayTitle: id, ...over }
}

describe('teamProjectionOf', () => {
  it('reads the root session own projection', () => {
    const value = team()
    expect(teamProjectionOf(projections('root', value), 'root')).toBe(value)
  })

  it('answers undefined without a root, without a snapshot, or without a team', () => {
    expect(teamProjectionOf(projections('root', team()), undefined)).toBeUndefined()
    expect(teamProjectionOf(undefined, 'root')).toBeUndefined()
    // A session the projection store knows, but which leads no team (the
    // deployment without the experimental layer, or a plain subagent tree).
    const other: SidebarSessionList['projectionsBySession'] = {
      root: { values: {}, state: 'ready', error: null },
    }
    expect(teamProjectionOf(other, 'root')).toBeUndefined()
    expect(teamProjectionOf(projections('root', team()), 'someone-else')).toBeUndefined()
  })
})

describe('teamMembersOf', () => {
  const noLive: Record<string, SidebarChildLiveView | undefined> = {}

  it('answers an empty roster without a team', () => {
    expect(teamMembersOf(undefined, noLive, {})).toEqual([])
  })

  it('carries the durable phase and the member identity through', () => {
    const rows = teamMembersOf(
      team({ members: [member({ id: 'lead', name: 'lead', role: 'lead' }), member({ id: 'w' })] }),
      noLive,
      {},
    )
    expect(rows).toEqual([
      { id: 'lead', name: 'lead', role: 'lead', phase: 'active', status: 'idle', diagnostics: [] },
      { id: 'w', name: 'writer', role: 'teammate', phase: 'active', status: 'idle', diagnostics: [] },
    ])
  })

  it('reads an active member activity from the live channel', () => {
    const live: Record<string, SidebarChildLiveView | undefined> = { w: { running: true } }
    expect(teamMembersOf(team(), live, {})[0]?.status).toBe('running')
  })

  it('falls back to the session list running flag (the Lead is no live child)', () => {
    const byId = { lead: summary('lead', { running: true }) }
    const rows = teamMembersOf(
      team({ members: [member({ id: 'lead', name: 'lead', role: 'lead' })] }),
      noLive,
      byId,
    )
    expect(rows[0]?.status).toBe('running')
  })

  it('never claims a running turn while the durable phase disagrees', () => {
    const live: Record<string, SidebarChildLiveView | undefined> = { w: { running: true } }
    const provisioning = teamMembersOf(team({ members: [member({ phase: 'provisioning' })] }), live, {})
    expect(provisioning[0]?.status).toBe('provisioning')
    const failed = teamMembersOf(team({ members: [member({ phase: 'failed' })] }), live, {})
    expect(failed[0]?.status).toBe('failed')
  })

  it('ignores the live channel residency when the summary says the agent is not running (issue #800)', () => {
    // The live flag is the catalog's SESSION RESIDENCY: a retained session
    // whose agent died in a crash-restart reads `running` there while the
    // authoritative summary stays false. The summary wins.
    const live: Record<string, SidebarChildLiveView | undefined> = { w: { running: true } }
    const byId = { w: summary('w', { running: false }) }
    expect(teamMembersOf(team(), live, byId)[0]?.status).toBe('idle')
  })

  it('takes the Summary running bit even when the live channel says otherwise', () => {
    const live: Record<string, SidebarChildLiveView | undefined> = { w: { running: false } }
    const byId = { w: summary('w', { running: true }) }
    expect(teamMembersOf(team(), live, byId)[0]?.status).toBe('running')
  })

  it('exposes the durable member error as the diagnostics list', () => {
    const rows = teamMembersOf(
      team({ members: [member({ phase: 'failed', error: 'spawn rejected' })] }),
      noLive,
      {},
    )
    expect(rows[0]?.diagnostics).toEqual(['spawn rejected'])
  })

  it('treats a member the live channel has not mentioned as idle', () => {
    const live: Record<string, SidebarChildLiveView | undefined> = { other: { running: true } }
    expect(teamMembersOf(team(), live, {})[0]?.status).toBe('idle')
  })
})

/**
 * DSH 0.2.2-rc.2 changed the wire contract this adapter reads: `agentTeam`
 * carries `enabled` instead of `members`, and the host publishes the projection
 * for EVERY root — a disabled session's projection is not a team surface. The
 * roster moved to `subagentCatalog`. These cases pin both halves of that
 * change; the first one is the exact crash regression (`team.members.map` on
 * an rc.2 projection threw `Cannot read properties of undefined`).
 */
describe('teamProjectionOf on the rc.2 projection', () => {
  it('reads an enabled projection even though it has no members', () => {
    const value = rc2Team()
    expect(teamProjectionOf(projections('root', value), 'root')).toBe(value)
  })

  it('treats a disabled projection as no team (rc.2 publishes one for every root)', () => {
    expect(teamProjectionOf(projections('root', rc2Team({ enabled: false })), 'root')).toBeUndefined()
  })

  it('keeps reading a host that predates the enabled flag', () => {
    const value = team()
    expect(teamProjectionOf(projections('root', value), 'root')).toBe(value)
  })
})

describe('teamMembersOf on the rc.2 projection (no members)', () => {
  const noLive: Record<string, SidebarChildLiveView | undefined> = {}

  it('derives the Lead and continuable children instead of mapping undefined', () => {
    const rows = teamMembersOf(rc2Team(), noLive, {}, {
      rootId: 'root',
      catalog: [
        catalogEntry({ id: 'w', label: 'writer' }),
        catalogEntry({ id: 'j', mode: 'one-shot' }),
      ],
    })
    expect(rows).toEqual([
      { id: 'root', name: 'lead', role: 'lead', phase: 'active', status: 'idle', diagnostics: [] },
      { id: 'w', name: 'writer', role: 'teammate', phase: 'active', status: 'idle', diagnostics: [] },
    ])
  })

  it('tolerates an explicitly undefined members field (the crash regression)', () => {
    const projection: SidebarTeamProjection = { members: undefined, enabled: true, tasks: [] }
    expect(() => teamMembersOf(projection, noLive, {}, { rootId: 'root', catalog: [] })).not.toThrow()
    expect(teamMembersOf(projection, noLive, {}, { rootId: 'root', catalog: [] })).toEqual([
      { id: 'root', name: 'lead', role: 'lead', phase: 'active', status: 'idle', diagnostics: [] },
    ])
  })

  it('answers an empty roster when neither a durable roster nor the fallback source exists', () => {
    expect(teamMembersOf(rc2Team(), noLive, {})).toEqual([])
    expect(teamMembersOf(rc2Team(), noLive, {}, { rootId: undefined, catalog: [catalogEntry({ id: 'w' })] }))
      .toEqual([])
  })

  it('names a child from its summary title when the catalog carries no label', () => {
    const rows = teamMembersOf(rc2Team(), noLive, { w: summary('w', { displayTitle: 'Researcher' }) }, {
      rootId: 'root',
      catalog: [catalogEntry({ id: 'w', mode: 'unknown' })],
    })
    expect(rows[1]).toMatchObject({ id: 'w', name: 'Researcher', role: 'teammate' })
  })

  it('overlays live activity on the derived roster', () => {
    const live: Record<string, SidebarChildLiveView | undefined> = { root: { running: true }, w: { running: true } }
    const rows = teamMembersOf(rc2Team(), live, {}, {
      rootId: 'root',
      catalog: [catalogEntry({ id: 'w', label: 'writer' })],
    })
    expect(rows.map(row => row.status)).toEqual(['running', 'running'])
  })

  it('keeps the durable roster authoritative when a host still publishes members', () => {
    const rows = teamMembersOf(
      team({ members: [member({ id: 'durable', name: 'old-roster' })] }),
      noLive,
      {},
      { rootId: 'root', catalog: [catalogEntry({ id: 'catalog-only', label: 'catalog' })] },
    )
    expect(rows.map(row => row.id)).toEqual(['durable'])
  })
})
