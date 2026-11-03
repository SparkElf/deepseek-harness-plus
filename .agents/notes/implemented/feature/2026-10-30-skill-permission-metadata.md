# Agent Note: Skill audience and permission metadata

Status: implemented

English | [中文](2026-10-30-skill-permission-metadata.zh.md)

## Problem

Skill catalogs were invocation-neutral but audience-blind. A provider could hide a skill from the model (`modelInvocable: false`) or from human commands, yet no field expressed "only administrators may see this" or "the viewer must hold `skill:manage`". Deployments that mount privileged skills — a connector that reads the DataOps admin API, for example — had to either publish those skills to every user or keep them out of the shared tree and lose discovery.

DataOps decided that a permission must not be re-checked inside every tool or skill call. Instead the plugin adjusts its behavior at initialization, login, role change, and capability changes: it registers or disposes tools and hides skills, while the backend API remains the final authorization boundary. The skill framework therefore needed a way for a consumer to declare one audience and for the registry to apply it at catalog and load time, without turning every `get()` into a permission query.

## Decision

`SkillSummary` gains two optional fields, inherited by `SkillCandidate` and `SkillDefinition`:

- `requiredPermissions?: readonly string[]` — every listed identifier must be granted.
- `visibility?: 'public' | 'admin' | 'super-admin'` — the minimum audience tier; omitted means `public`.

`SkillViewer` names the reader: `permissions?: readonly string[]` and `role?: 'user' | 'admin' | 'super-admin'`. Both fields are optional; an omitted viewer is an ordinary user holding no permissions. `SkillVisibility` and `SkillViewerRole` are the closed unions behind those values.

### Filtering boundaries

`isSkillVisible(skill, viewer)` requires the viewer's role rank to reach the declared visibility and every required permission to be granted. `filterVisibleSkills(skills, viewer)` applies it to a catalog while preserving order and element type, so consumers can project lists they build themselves.

The registry applies the same rule where a catalog is produced and where a body is loaded: `list()` and `snapshot()` drop invisible candidates before projecting summaries, and `get()` returns `undefined` for an invisible candidate or loaded definition, identical to an unknown name. A model therefore cannot load a skill by guessing a name it cannot see. Unannotated skills stay visible to every viewer, so existing providers and registrations keep their audience unchanged.

### Viewer resolution

`SkillViewOptions.viewer` lets one consumer name a reader for one lookup. `ctx.skills.useViewer(viewer)` registers a deployment-wide viewer for consumers that do not name one — the shape a workspace with exactly one DataOps user needs — and returns the Cordis disposer that clears it. Registering or clearing a viewer with a different identity invalidates completed catalogs and emits `skills/change`, so an already-published model catalog is replaced for the new audience; re-registering the same identity is a no-op. A viewer registration superseded by a newer one cannot clear the newer value when it is disposed.

`SkillLookupOptions.viewer` forwards the resolved viewer to providers, which may omit candidates they cannot serve at their source. Discovery caches include a stable viewer identity (role plus sorted, de-duplicated permissions), so two audiences never share one provider result while equal audiences share it. The registry still applies the declared metadata after provider discovery, so a provider cannot widen an audience by omission or by returning extra candidates. A lookup that names no viewer and runs with no registered viewer forwards the caller's options object unchanged.

### Source parsing

The local provider reads `required-permissions` (one identifier or a list) and `visibility` from frontmatter, de-duplicates the permissions, and projects both into the candidate and definition. An invalid value, a non-string list entry, or the camelCase `requiredPermissions` spelling drops that skill with a warning and leaves valid siblings listable. Registry validation rejects malformed metadata on provider candidates, runtime registrations, and loaded definitions before caching or returning them.

### What this is not

The metadata is disclosure, not authorization. A deployment registers the viewer from the principal it already resolved and re-registers it when roles change; no tool or skill call queries a permission tree. The backend API keeps authorizing each request. Consumers that must see annotated skills without a registered viewer — the skill center reading on behalf of a browser user, for example — pass `viewer` per lookup.

## Alternatives considered

**Re-check permissions inside every skill load.** Rejected by the deployment decision it serves: a per-call permission query puts an authorization round trip in the model's tool loop, repeats work the plugin already did at login, and still leaves the backend as the real boundary.

**A new principal service owned by the skill package.** Rejected because the harness has no session-level principal to read: a DataOps workspace is single-user, and its plugin already holds the JWT and role context. A deployment-wide viewer registration plus a per-lookup override covers both shapes without inventing a second identity authority.

**Filter in each consumer instead of the registry.** Rejected because the model catalog, the loader tool, and the skill center would each re-derive the rule and drift; `get()` would also stay unfiltered, letting a model load a hidden skill by name.

**A separate `audience` field beside `visibility`.** Rejected because both express the same ordering; one closed tier field keeps the frontmatter and the type one spelling, matching the invocation policy's single normalized form.

**Cache provider discovery without the viewer.** Rejected because a provider that filters at its source would leak one audience's result to another; the viewer identity in the cache key keeps equal audiences sharing one discovery.

## Testing

`packages/skill/skill/tests/skill.spec.ts` covers the visibility rule and role tiers, permission intersection, catalog filtering in `list()` and refusal in `get()`, a loaded definition that raises its own audience, registered viewers and their invalidation, superseded registration disposal, one provider discovery per distinct viewer with the viewer forwarded, and malformed metadata at registration, candidate, and definition boundaries.

`packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` covers frontmatter parsing for both keys, single and list permission forms, filtering against an admin viewer, and invalid values or the legacy camelCase key skipping only the offending file.

`packages/skill/tool-skill/tests/tool-skill.spec.ts` covers the model catalog and the `skill` tool before and after a viewer registration: the gated skill is absent from the catalog and rejected by the tool, then appears in the replacement catalog and loads after the viewer changes.

The three packages pass their focused suites and `tsc -b` for their project references. `docs/subsystems/skills.md` and its Chinese counterpart document the new types with `ts type-equiv` blocks registered in `scripts/type-equiv.manifest.json`.

## Related decisions

The invocation policy remains owned by [skill invocation policy](2026-07-28-skill-invocation-policy.md); audience metadata is a second, independent axis on the same summary. DataOps connector disclosure rules — effective capabilities, tool registration and disposal, and the backend as the final boundary — live in `dataops/docs/dataops-connector-development-spec.md` rather than in this repository.

## Consequences

A provider that starts declaring metadata loses the matching audience immediately: with no viewer registered, annotated skills are hidden. That is the intended fail-closed default, and it makes wiring the viewer part of shipping such a skill.

Two call sites remain outside this repository's skill packages: the skill center host routes must pass a viewer derived from the caller's role, and the DataOps connector must register `useViewer` after login and re-register it on a role change. Until then, annotated skills are hidden from both surfaces rather than shown to the wrong audience.