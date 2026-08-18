# Agent Note: External Plugin Maintenance Scheme

Status: proposed

English | [中文](2026-08-19-external-plugin-maintenance.zh.md)

## Problem

This project tracks and optimizes not only DeepSeek Harness (dsh) but also external dsh plugins we are interested in, and will soon author independent plugins of our own. Upstream removed the repository-plugin mechanism and kept exactly one standalone distribution path for external plugins: installable profile composition bundles whose packages declare `dsh.bundle.patch` patch layers. Without a maintenance scheme, tracking stays ad hoc (no pins, no drift visibility, no patch lifecycle) and our own plugins would have no home that keeps them installable on upstream dsh.

## Proposal

1. **Repository split.** `deepseek-harness-plus` keeps tracking dsh and the Plus product, and owns the curation of third-party plugins. A separate `dsh-plugins-plus` repository holds the source of our own plugins so they stay installable on upstream dsh and never depend on the product fork. The new repository is created on demand when the first in-house plugin is born, not before; an empty repository is overhead, and its CI (typecheck/lint/unit plus a composition e2e against dsh master) and CD (npm publish plus tag) reuse the patterns already proven in this repository.
2. **Curation manifest** at `.agents/plugins/curated.yaml`: one entry per tracked third-party plugin with `name`, `source` (npm spec or git url), `pinned` (exact version or SHA that Plus integrates and tests), `interest`, `owner`, `localPatches` (patch file, upstream PR link, retire condition), and `plusBundle` (whether the Plus profile bundle mounts it by default; default false, inclusion is a reviewed manifest PR). Third-party plugin source is never forked into a repository; pins plus patches are the tracking.
3. **Parallel patch policy.** When we optimize a third-party plugin, we file the upstream PR and carry the Plus patch at the same time, so Plus users benefit immediately; the manifest entry records the upstream PR link and the retire condition, and the patch is removed once upstream ships it. This replaces an upstream-first-only policy by explicit decision.
4. **Drift tracking** via `scripts/check-curated-plugins.mjs`: compares each pin against `npm view` latest or `git ls-remote` HEAD, prints a drift report, `--fail-on-drift` for later CI use, `--offline` for keyless runs; parsing and pin comparison are unit-tested without network. CI cron drift gates and per-plugin CI matrices are deliberately deferred until the first plugin is curated; with an empty or tiny list, manual runs are the right cost.
5. **Plus bundle integration.** Curated plugins ship by mounting their patch layer in the Plus profile bundle; the default set stays closed and every plugin configuration is fully specified in the patch layer, following upstream's remove-repository-plugin decision.

## Alternatives considered

**Vendor every plugin like Cordis.** Rejected: the package manager already handles fetching, versions, and lockfiles; vendoring remains a last resort under the existing vendor policy for critical patches whose upstream is unresponsive.

**Revive a repository-plugin-style mechanism.** Rejected upstream; the composition-bundle path is the only standalone distribution path and gives plugins full configuration authority.

**Create dsh-plugins-plus now.** Rejected: the repository earns its existence with the first plugin; the split itself is approved, only the timing is on demand.

**Upstream-first-only patching.** Rejected by decision: parallel upstream PR plus Plus patch delivers user value immediately; the retire condition prevents fork rot.

## Consequences

- Drift is visible from the checker; every bump is an explicit, reviewed manifest change.
- Local patches carry upstream links and retire conditions, so they decay instead of accumulating.
- The Plus default bundle remains a closed set; curation changes are manifest PRs, never silent.

## Acceptance criteria

- The manifest parses with the dependency-free checker and the spec passes keyless.
- Adding the first curated or in-house plugin lands the dsh-plugins-plus repository (when in-house), per-plugin CI, and the composition e2e together, per this note.
- Every local patch entry carries an upstream PR link and a retire condition; a patch without both is rejected in review.

## Risks

- Parallel patches can diverge from upstream review feedback; the retire condition and upstream link are the mitigation, and review of manifest PRs re-checks them.
- Drift checks stay manual until the first curation; a stale pin could linger, bounded by manual runs before any bump.

## Verification

- `scripts/check-curated-plugins.spec.ts` covers manifest parsing and pin comparison keyless.
- The checker runs `--offline` without network and reports pins.
- Composition e2e, per-plugin CI, and the dsh-plugins-plus repository land together with the first curated or in-house plugin.
