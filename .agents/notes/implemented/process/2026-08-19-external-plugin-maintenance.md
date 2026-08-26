# Agent Note: External Plugin Maintenance Scheme

Status: implemented

English | [中文](2026-08-19-external-plugin-maintenance.zh.md)

## Problem

DeepSeek Harness Plus ships selected external plugins while those plugins remain independently owned and released. Without one curation process, the product can silently drift between its manifest, lockfile, default profile, local patches, and upstream releases, while an automatic upgrade can put unreviewed third-party code into a Plus release.

## Decision

`deepseek-harness-plus` owns third-party plugin curation and product composition. The separate [dsh-plugins-plus repository](https://github.com/SparkElf/dsh-plugins-plus) owns SparkElf plugin source that must also install on upstream dsh without depending on the Plus fork.

A third-party plugin stays in its upstream repository. `.agents/plugins/curated.yaml` records its source, exact tested version or commit, owner, interest, local patch lifecycle, and whether Plus mounts it by default. The package manager lockfile fetches that release; Plus does not copy or republish the plugin source.

### Default composition

A curated entry with `plusBundle: true` is an installation-owned Web dependency. `pnpm run verify:plus-governance` requires the curated npm pin to equal the exact dependency in `packages/bundle/web-app/package.json`. `packages/boot/app-boot/src/profile.ts` mounts the closed default set and normalizes only exact previously shipped tuples; any other Bundle list remains user-owned.

`dsh-better-sidebar`, `@sparkelf/dsh-mobile-bridge`, and `dshmarket` are default Web bundles. `dshmarket@1.29.2` includes [the host-ownership fix](https://github.com/dsh-market/dsh-market/pull/316) and [multi-category compatibility](https://github.com/dsh-market/dsh-market/pull/323): Discover recognizes active profile Bundles without adding installation-provided Bundles to update or uninstall targets, host-provided markets hide self-management controls, and category strings or arrays remain searchable and filterable. `dsh-better-sidebar@0.16.1` includes [the mobile unavailable-state and overflow fix](https://github.com/omdsh-dev/DSH-better-sidebar/pull/254). These released implementations need no Plus patch.

### Parallel patch lifecycle

Every Plus-authored change to external plugin source, whether a fix, enhancement, or new feature, must be submitted upstream as a pull request with code and tests. An Issue may track the work but does not replace the pull request; if no pull request can be opened, the work remains blocked. Any temporary `pnpm patchedDependencies` patch records that implementation PR and its retirement condition, and `scripts/check-curated-plugins.mjs` rejects Issue or arbitrary URLs. Plus does not maintain a long-lived source fork.

### Upstream drift and release flow

`scripts/check-curated-plugins.mjs` compares npm pins with published latest versions and git pins with remote HEAD. `--offline` validates and reports the local manifest without network access; `--fail-on-drift` returns 2 for version drift, and an incomplete upstream lookup returns 1.

`.github/workflows/curated-plugin-drift.yml` runs the network check daily and maintains one GitHub Issue containing the current report. A matching check closes that Issue. The workflow never changes a pin, lockfile, patch, profile, or release artifact.

Plus release jobs consume only reviewed exact dependencies from the lockfile. Before changing a pin or retiring a patch, the adoption review compares the local intent and touched files with the released upstream implementation, then inspects intervening dependency, public API, profile persistence, Host and Client lifecycle, and UI changes. It reports each overlap as absorbed, divergent, or adjacent risk; unresolved divergence or unknown behavior blocks the update. Patch deletion or a successful install alone is not compatibility evidence. An accepted release reaches Plus only after a normal pull request updates the curation record, dependency pin, lockfile, patch lifecycle, user documentation, and relevant verification.

## Verification

`scripts/check-curated-plugins.spec.ts` covers manifest parsing, implementation-PR URL validation, drift status, lookup-failure precedence, default-Bundle pin matching, and local patch registration without network access. `scripts/dshmarket-inbox-compat.spec.ts` imports the pinned upstream source and verifies catalog-only Bundle projection plus multi-category normalization, filtering, and localized-label search. `packages/boot/app-boot/tests/profile.spec.ts` covers new profile initialization, migration of known installation-owned Web tuples, and preservation of custom tuples. Candidate Web verification exercises the marketplace and sidebar through the assembled profile before promotion.

## Alternatives considered

**Vendor or fork every curated plugin.** Rejected because npm and git already own retrieval and version identity, while a fork would make Plus responsible for an unrelated source tree and release line. A short patch with an upstream retirement condition covers the actual divergence.

**Automatically update pins after the scheduled check.** Rejected because external plugins execute Host and browser code and may mutate profiles. Detection is automated; adoption remains a reviewed product release decision.

**Require users to install every curated plugin themselves.** Rejected for capabilities selected as part of the Plus product. The closed default set gives new and installation-owned profiles the same tested composition while preserving custom profiles.

## Consequences

Plus carries an explicit compatibility obligation for every default curated plugin and must review upstream drift reports. Users receive the tested market and sidebar without manual assembly, custom profile composition remains untouched, and local third-party changes retain a visible path back upstream.
