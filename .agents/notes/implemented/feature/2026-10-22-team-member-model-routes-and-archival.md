# Agent Note: Durable teammate model routes and archival

Status: implemented

English | [中文](2026-10-22-team-member-model-routes-and-archival.zh.md)

## Problem

A Team member was created with only a continuable-subagent provider (`spawn` or `fork`) and inherited whatever LLM provider, model, and reasoning effort the Lead used at that moment. The roster could report a live member's creation options but an inactive member lost that information, and no operation could re-route an existing member. Deployments that wanted cheaper or faster teammates had to create new members, and a long-lived teammate could not recover from an upstream provider or model failure without being replaced.

The roster also had no retirement operation. Deleting a member record would break durable replay, invalidate its reserved name and member slot accounting, and discard the only durable link to the member's Session. The Team therefore needed a way to remove a finished member from active coordination while keeping every durable fact.

## Decision

`TeamMemberSnapshot` gains four optional fields in the existing version-2 payload: `modelProvider`, `model`, `reasoningEffort`, and `archived`. The existing `provider` field keeps its meaning as the continuable-subagent provider that created the child. Because every new field is optional, logs written before this decision replay unchanged, and a legacy member without route fields reports only its live Session route. `TeamMemberView` exposes the durable `modelProvider`, `model`, and `reasoningEffort` beside the unchanged `provider` and `diagnostics` fields; `archived` appears only on rows returned through an archive-inclusive read.

### Route resolution

At spawn, an explicit `modelProvider` or `model` wins per field and each missing value is inherited from the Lead's current route. The Lead's latest request header owns that route, matching the continuation provider's inheritance rule; creation options are the fallback before the Lead's first request. A request that names an explicit route or effort with no route available from either source fails with `TEAM_INVALID_MODEL_SELECTION` instead of creating a member that cannot run. The resolved route is written into the provisioning snapshot and passed to `ctx.subagents.startContinuable` as `request.agentOptions`, so the initial call and the durable record agree.

### Update timing

`updateTeammate()` is Lead-only and operates on a non-archived, active member. A partial request inherits unspecified fields from the member's stored route, falling back to the Lead's route for a member created before route persistence. Changing `modelProvider` or `model` without naming an effort restores the selected model's default effort; an effort-only request keeps the stored route.

The member snapshot is appended and flushed first. For a live member, the service then installs the Agent-scoped model-selection listeners from `@deepseek-ai/dsh-agent` and sets their `current` selection, so the next prompt assembly and request use the new route; a request already in flight is not interrupted. For an inactive member, the durable route is applied by the `agent/session-start` observer. That observer runs synchronously during publication, before the continuation manager submits the queued first prompt, so the durable Team route overrides the spawn-time route frozen in the child's continuation descriptor. Installed listeners are released when the member Agent or the Team runtime is disposed, so plugin replacement cannot accumulate stale selection state.

### Archival

`archiveTeammate()` is Lead-only, rejects a member that is still provisioning, and rejects an already archived member with `TEAM_MEMBER_ARCHIVED`. It appends a whole member snapshot with `archived: true`, keeps the phase unchanged, and then releases any live Activation through the continuation owner. The projection treats archival as terminal: no later member event may change an archived row. Roster reads omit archived rows unless the caller asks for them; `send_message`, `interrupt_agent`, and member updates reject an archived target with the same stable code. Mailbox dispatch never cold-resumes an archived target, so an item queued before archival stays queued rather than waking the retired member. The Session, conversation history, reserved name, and member slot all remain.

### Projection transitions

Member events now permit `provisioning -> active|failed`, `active -> active`, and `failed -> failed`. Name, subagent provider, and context remain immutable; a member may not return to provisioning, `active -> failed` remains invalid, a new member must begin provisioning, and a first record may not be archived. These rules keep whole-snapshot updates replayable without adding a second event type.

## Alternatives considered

**A separate `team/member/model` event.** Rejected because the roster already reads whole member snapshots under one projection and transition validator. A second event type would split authority for the same row, complicate recovery, and still need the same optional-field compatibility work.

**A version-3 payload with a migration.** Rejected because the added fields do not change the event structure or its interpretation. Optional fields keep released logs readable without a new generation, a fallback decoder, or a format-version bump.

**Mutate the continuation descriptor.** Rejected because the descriptor is the child Session's append-only creation record, not Lead-owned mutable state. Rewriting it would mix two logs' transaction ownership and change cold-resume behavior outside the Team service.

**Delete the member record instead of archiving.** Rejected because replay would forget the child, the reserved name and slot accounting would be reused, and the durable link to the member's history would disappear. Archival expresses retirement without destroying those facts.

**Install the selection only when the member is created.** Rejected because a live update would never reach the next request and a cold resume would keep using the frozen descriptor route. Installing from the durable snapshot at every Session start is what makes replay and cold start agree.

**Rely on `agent.options.model` as the roster source.** Rejected because Agent options are creation facts; a runtime model-selection override does not rewrite them, and an inactive member has no live Agent at all. The durable member snapshot is the only authority that survives both cases.

## Testing

`packages/experimental/agent-team/tests/team.spec.ts` covers inherited and explicit routes at spawn, live route updates visible to the next step of the same turn, inactive updates applied on cold resume, partial and invalid update resolution, Lead-only authority, the disposal error, archival list filtering and stable rejection codes, name and slot retention, history readability, provisioning-member rejection, archived-member session-start and mailbox recovery, and the no-cold-resume delivery guard. `tests/projection-events.spec.ts` pins legacy payload readability, route updates, archival terminality, and first-record rejection. `packages/experimental/tool-agent-team/tests/tool-team.spec.ts` covers the model-facing schemas for `spawn_teammate`, `update_teammate`, `list_agents` with `include_archived`, and `archive_teammate`. Both packages pass their focused suites, the two-package coverage run keeps the per-file 100% gate, and the affected packages typecheck.

## Related decisions

The child route arguments, adapter preflight, and fork cache restriction remain owned by [model-selected subagent routes](2026-08-18-model-selected-subagent-routes.md). The authorization policy for user-selected subagent routes remains owned by [user-authorized subagent model routes](2026-08-24-user-authorized-subagent-model-routes.md); Team members are created only by the Lead and therefore add no separate user-route authority. The durable notice emitted on a provider or model change remains owned by [model switch notice](2026-09-07-model-switch-notice.md). Team identity, mailbox, task, and shared-checkout decisions remain owned by [durable Agent Teams over continuable children](2026-08-05-agent-teams.md).

## Consequences

Every new teammate now carries an LLM route in its snapshot even when it inherits one, so the roster can answer for inactive members and a later update has a complete baseline. The cost is a few more bytes per member record and the requirement to keep the route fields in step with the model-selection extension point.

The durable route intentionally wins over the continuation descriptor only while the Team service can resolve the member from a live Lead. A host that resumes a teammate Session directly, without a live Lead, still runs on the descriptor's spawn-time route. Archiving keeps the member in the Lead log forever: it does not free a name, does not reduce `maxMembers` usage, and leaves pre-archive queued mail undelivered. Those are explicit retirement semantics rather than deletion guarantees.
