/**
 * The plugin's view of the host's `agentTeam` Session projection — the Lead
 * Session's team board, read straight off the client snapshot.
 *
 * 0.1.6 exposed the board through the experimental service's Remote vocabulary
 * (`agentTeams.remoteView`, reached over the wire) and the page had to poll it
 * every 5s. 0.1.7 deleted that trio and publishes the same state as a Session
 * projection instead: `SessionListState.projectionsBySession[leadId].values
 * .agentTeam`, loaded once per connection like every other projection. This
 * module is therefore a pure adapter — no request, no poller, no observer —
 * exactly like ./subagent-catalog.ts for the catalog.
 *
 * 0.2.2-rc.2 SPLIT THE CONTRACT — the module reads BOTH generations:
 *
 * - The durable roster (`members: { id, name, role, phase, error? }[]`) is
 *   GONE from `agentTeam`; the host now documents the roster as the existing
 *   `subagentCatalog` projection ("Current subagents are supplied separately
 *   by the existing `subagentCatalog` projection"). Mapping the removed field
 *   is what crashed the Tasks page with `team.members is undefined`; when the
 *   projection has no `members` the roster is DERIVED from the root Session
 *   plus its catalog instead ({@link teamMembersOf}).
 * - `enabled`, the saved Team-mode selection, is NEW. rc.2 publishes the
 *   projection for EVERY root (disabled, no tasks) so the team surface is
 *   absent unless the selection is on — {@link teamProjectionOf} applies that.
 *
 * Two facts the durable projection never carried are still DERIVED:
 *
 * - TURN ACTIVITY comes from the session's own status — `subagents.live`
 *   reports every tree child with an explicit `running` flag (see
 *   ./subagent-catalog.ts's `childLive`), with the session list's own coarse
 *   `running` as the fallback for the Lead.
 * - `diagnostics`, the 0.1.6 view's array of provisioning notes, collapses to
 *   the projection's single durable `error` string (only where a roster row
 *   still exists).
 */
import type {
  SidebarChildLiveView,
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarSubagentCatalogEntry,
  SidebarTeamMemberProjection,
  SidebarTeamProjection,
} from '../context-types.ts'

/**
 * One roster row as this page consumes it: the projection's durable half plus
 * the derived runtime status. A THIRD type next to the host service's
 * `SidebarTeamMemberView` on purpose — that one is the 0.1.6 `listMembers`
 * shape (status/description/provider/model) this plugin no longer reads, and
 * conflating the two is exactly how the field drift that broke the board went
 * unnoticed.
 */
export interface TeamMemberRow {
  /** The member's session id (the teammate's child session under the lead). */
  id: string
  name: string
  role: 'lead' | 'teammate'
  /** Durable lifecycle, as the projection publishes it. */
  phase: SidebarTeamMemberProjection['phase']
  /** Derived display status: durable phase wins, else the live activity flag. */
  status: 'running' | 'idle' | 'provisioning' | 'failed'
  /** The durable provisioning error as a one-item list (see the header). */
  diagnostics: string[]
}

/**
 * The team board led by `rootId`, or undefined when that session leads none.
 *
 * ABSENT MEANS NO TEAM, and there are four ways to get there: the deployment
 * never mounted the experimental layer (no projection key at all), the root is
 * a teammate rather than the Lead, the session simply has no team, or — on
 * DSH 0.2.2-rc.2, which publishes the projection for every root — the saved
 * Team-mode selection is off. All four collapse into "the page draws no Teams
 * block", the same silent degradation the 0.1.6 route expressed as
 * `{available:false}` (layer absent) and `{team:null}` (root leads none).
 *
 * The `enabled` gate only fires on a host that actually publishes the flag;
 * a host without it (≤0.2.2-alpha.x) keeps the old presence test.
 *
 * @param projections - `SessionListState.projectionsBySession`.
 * @param rootId - the tree's root session (the only session that can be Lead).
 */
export function teamProjectionOf(
  projections: SidebarSessionList['projectionsBySession'],
  rootId: string | undefined,
): SidebarTeamProjection | undefined {
  if (rootId === undefined) return undefined
  const team = projections?.[rootId]?.values.agentTeam
  if (team === undefined) return undefined
  if (team.enabled === false) return undefined
  return team
}

/**
 * The catalog-backed roster input of {@link teamMembersOf}: the tree's root
 * and that root's `subagentCatalog` entries.
 */
export interface TeamRosterSource {
  /** The tree's root session — the Lead row when the host publishes none. */
  rootId: string | undefined
  /** The root's direct-child catalog (`subagentCatalog[rootId]`). */
  catalog: readonly SidebarSubagentCatalogEntry[]
}

/**
 * The Lead's display name when the host does not publish a roster row.
 * Upstream's own synthesized projection row used exactly this literal, so the
 * derived roster matches what a pre-rc.2 projection showed.
 */
const DERIVED_LEAD_NAME = 'lead'

/**
 * Overlay runtime activity onto the durable roster, or — on DSH 0.2.2-rc.2,
 * where `agentTeam` stopped carrying a roster — rebuild that roster from the
 * root Session and its `subagentCatalog` children.
 *
 * The fallback is NOT a way to paper over a missing API: the host deliberately
 * moved the roster to `subagentCatalog` (see the module header), so the page
 * reads the SAME children the topology already renders, with the Lead row the
 * pre-rc.2 projection used to synthesize. A durable `members` array, when the
 * host still sends one, always wins.
 *
 * Status precedence is deliberately narrow: the durable phase wins for the two
 * states it owns (`failed` never becomes "running" because a retry is in
 * flight, `provisioning` is not yet a turn), and only an `active` member asks
 * the live channel whether it is running right now. A member the channel does
 * not mention yet (the first poll of a freshly rooted tree) reads as `idle`,
 * which is the safe direction: it never claims work that is not happening.
 *
 * @param team - the Lead's projection ({@link teamProjectionOf}).
 * @param live - the `subagents.live` map (`session id → live view`).
 * @param byId - the session list by id (the Lead's own running flag lives here).
 * @param roster - the fallback roster source; required only on a host whose
 *   projection has no `members` (rc.2 and later).
 */
export function teamMembersOf(
  team: SidebarTeamProjection | undefined,
  live: Readonly<Record<string, SidebarChildLiveView | undefined>>,
  byId: Readonly<Record<string, SidebarSessionSummary | undefined>>,
  roster?: TeamRosterSource,
): TeamMemberRow[] {
  if (team === undefined) return []
  const durable = team.members ?? []
  if (durable.length > 0) {
    return durable.map(member => ({
      id: member.id,
      name: member.name,
      role: member.role,
      phase: member.phase,
      status: memberStatus(member, live, byId),
      diagnostics: member.error === undefined ? [] : [member.error],
    }))
  }
  return derivedRoster(roster, live, byId)
}

/**
 * The rc.2 roster: the root as the Lead plus every continuable child as a
 * teammate. One-shot children are excluded — they are background jobs in the
 * tree, not team members a shared task can be handed to (they carry no agent
 * path label either), and `unknown` rows stay in rather than claiming a mode
 * the host did not state.
 */
function derivedRoster(
  roster: TeamRosterSource | undefined,
  live: Readonly<Record<string, SidebarChildLiveView | undefined>>,
  byId: Readonly<Record<string, SidebarSessionSummary | undefined>>,
): TeamMemberRow[] {
  const rootId = roster?.rootId
  if (rootId === undefined) return []
  const lead: SidebarTeamMemberProjection = {
    id: rootId,
    name: DERIVED_LEAD_NAME,
    role: 'lead',
    phase: 'active',
  }
  const rows: TeamMemberRow[] = [{
    id: lead.id,
    name: lead.name,
    role: lead.role,
    phase: lead.phase,
    status: memberStatus(lead, live, byId),
    diagnostics: [],
  }]
  for (const entry of roster?.catalog ?? []) {
    if (entry.mode === 'one-shot') continue
    const member: SidebarTeamMemberProjection = {
      id: entry.id,
      name: entry.label ?? byId[entry.id]?.displayTitle ?? entry.id,
      role: 'teammate',
      phase: 'active',
    }
    rows.push({
      id: member.id,
      name: member.name,
      role: member.role,
      phase: member.phase,
      status: memberStatus(member, live, byId),
      diagnostics: [],
    })
  }
  return rows
}

/** One member's runtime status (see {@link teamMembersOf} for the rule). */
function memberStatus(
  member: SidebarTeamMemberProjection,
  live: Readonly<Record<string, SidebarChildLiveView | undefined>>,
  byId: Readonly<Record<string, SidebarSessionSummary | undefined>>,
): TeamMemberRow['status'] {
  if (member.phase === 'failed') return 'failed'
  if (member.phase === 'provisioning') return 'provisioning'
  // The summary's `running` is the authoritative run bit; the live channel's
  // flag is the catalog's RESIDENCY, which reads `running` for a retained
  // session that no agent is driving (a crash-restart — issue #800). Same rule
  // as the task tree: authoritative wins, the live flag only stands in when the
  // host's summaries do not carry the field.
  const running = byId[member.id]?.running ?? live[member.id]?.running
  return running === true ? 'running' : 'idle'
}
