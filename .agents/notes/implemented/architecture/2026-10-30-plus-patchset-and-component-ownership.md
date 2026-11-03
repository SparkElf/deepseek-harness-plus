# Agent Note: Plus is the only patch layer, and the installer chooses an edition

Status: implemented

English | [中文](2026-10-30-plus-patchset-and-component-ownership.zh.md)

## Problem

The Plus distribution delivered every accepted difference as a separately published `@sparkelf/dsh-patch-*` package and listed those packages in `dshPlus.patchPackages`. That made the distribution a manifest of patches rather than the patch itself: the list drifted from the payloads on disk, a base-line bump moved dozens of independent versions, and a consumer that could not resolve the list fell back to patching installed `lib/` from deployment scripts. A deployment script then owned behavior that Plus claimed to ship.

The same blur appeared inside capabilities. A specific product rule was written into an official package patch (`activePanelId === "knowledge-base"`), while a generic capability was kept in one plugin's private code. Neither side could be retired or reused independently.

## Decision

`@sparkelf/dsh-plus` is the official DSH patch set and the product's only patch layer. Its payloads live inside the distribution package, its manifest carries one `dshPlus.patchSet` with ordered `entries[]`, and one Plus version names the whole delta. An entry carries `id`, `target` (`dsh-source` or `npm`), `file`, and `retireWhen`; retirement stays per entry while release and compatibility move with Plus.

The registry installation is the same patch materialized, not a second product: `dsh-plus apply` applies the embedded set to an exact official checkout, and the release pipeline republishes the patched official workspaces as `@sparkelf/*` packages selected by profile `overrides`. The republished packages are build output of the patch, not a component layer.

Component ownership has three layers:

- **DSH Plus** owns enhancements to base capabilities: extension points (slots, panel metadata, service APIs), configuration schemas, generic layout behavior, and generic fixes to official packages. It is the only layer that carries patches against official DSH.
- **Third-party plugins or forks** are used as published upstream, or as our fork when the plugin needs a change. A fork is a separate plugin package inside that publisher's boundary; it records `upstreamUrl` and `retireWhen` and never becomes a patch layer. A change that adds a base capability belongs to Plus instead, so the fork only carries the plugin's own behavior.
- **Self-developed plugins** own their specific features, UI, settings, routes, and the consumption of Plus capabilities. They do not patch official packages.

The deciding question is not who changed a file. It is whether the change adds a base capability or implements one plugin's use of it. A plugin-specific rule written into an official package is a boundary violation even when it works; a generic capability hidden in one plugin is the same violation in the other direction. A third-party change that cannot be expressed as a plugin is a fork; a change that belongs to the base is a Plus entry. There is no third channel.

`dsh-plus install --edition personal|team` is the installer surface. The two editions are different manifests and install different plugin sets: the personal edition carries the individual workflow, and the team edition carries the shared plugins and defaults a team deployment needs. An edition selects bundles and packages; it does not change the patch set, which every edition shares. The DataOps container installs the team edition.

The CLI writes the profile's `package.json` directly. There is no separately generated standalone distribution: a standalone package was a pre-materialized copy of the same list, so it could disagree with the CLI and had to be regenerated on every change. The profile manifest is the install artifact.

## Current applications

- **`allow` approval.** `dsh-user-approval` accepts the policy, `dsh-permission-presets` accepts it in the preset schema, and the base bundle can map full access to it. Choosing `danger-full-access: approval: allow` for a deployment is profile policy (DataOps), not a Plus default.
- **Image hoist replay.** `compaction-image-offload` replays projection-dependent positions leniently and `session-query` replays with the mounted projections; both are generic support for any plugin-owned projection. `@sparkelf/dsh-image-hoist` writes the `image/hoist` rows and stays a self-developed plugin.
- **Relay compatibility.** The `llm-pi-ai` route option and its Models checkbox are adapter capability. Enabling it for a particular gateway route is user or deployment configuration.
- **Workflow plaza.** `ui-schedule` declares the `schedule.manager.tabs` child slot and renders the tab when a plugin contributes; the plaza content and its workflows belong to `knowledge-base`, where they are implemented today.
- **Knowledge right bar.** `ui-sidebar-right` and `ui-layout` provide the generic "a panel may request the right bar and a reader layout" capability; `knowledge-base` declares that need and owns the reader linkage.

## Alternatives considered

**Keep one independently published patch package per accepted difference.** Rejected because the distribution becomes a versioned list of packages: the list drifted from the payloads (28 entries against one payload on disk), a base bump moved dozens of unrelated versions, and consumers that failed to resolve a name fell back to deployment-time `lib/` patches.

**Carry the differences as ordinary fork commits and build every official package from the fork.** Rejected because the fork becomes a second source base: official ownership of a behavior can no longer be told apart from ours, and a retired difference survives in the fork with no retirement record.

**Keep a separate patch layer for every third-party fork.** Rejected because it recreates the first problem at the plugin boundary: each fork grows its own patch list, base upgrades move unrelated versions, and a consumer has to resolve several patch channels. A fork is one plugin package; a base change is one Plus entry.

**Put the whole delta in one monolithic diff file.** Rejected because one hunk cannot be retired or reviewed on its own. A patch set with per-entry ids and `retireWhen` keeps one release lifecycle without losing per-behavior retirement.

**Let a plugin patch the official package itself when its feature needs a base hook.** Rejected because it gives the plugin ownership of a base package and makes two plugins that need the same hook duplicate or conflict. The hook belongs to Plus; the plugin consumes it.

## Consequences

- One patch layer exists. Every official delta is a Plus entry, and no deployment script or plugin owns a patch against official DSH.
- One Plus version, one compatibility range, and one lock describe the delta; a consumer resolves no patch packages.
- A base bump is a rebase of one patch set, not a coordinated release of dozens of patch packages.
- A third-party change is a fork (a plugin package) or a Plus base capability; there is no third patch channel to maintain.
- Retiring a behavior stays possible per entry through `retireWhen`, even though the release is shared.
- Every `dsh-source` entry must name a workspace that the profile republishes and overrides; an unrepublished target is a governance failure rather than a deployment script's problem.
- The installer CLI is the supported way to materialize an edition's plugin set; personal and team differ only in that manifest, not in the patch set.
- No standalone package is published. The profile manifest written by the CLI is the install artifact, and the container installs the team edition from it.
- Plugin reviews must now answer the capability question before implementation, so a specific rule cannot silently land in a base patch.
- This supersedes the independent-patch-package delivery in [Capability-equivalent Plus npm distribution](2026-08-29-ranged-plus-patchset-distribution.md); that note's four delivery forms and official-ownership rule remain, while its reference to independent patch packages is replaced here.