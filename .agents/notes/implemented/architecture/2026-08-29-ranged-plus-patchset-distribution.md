# Agent Note: Capability-equivalent Plus npm distribution

Status: implemented

English | [中文](2026-08-29-ranged-plus-patchset-distribution.zh.md)

## Problem

DeepSeek Harness Plus combines official DSH, selected external plugins, product defaults, and temporary repairs. A fork commit set or a settings-only package cannot reproduce that product and can retain implementations after official DSH has taken ownership. Official DSH must remain the only source base, and every accepted difference needs one current owner and retirement condition.

## Decision

Plus uses four delivery forms. A complete capability is an npm-installable Cordis plugin containing all required Host and Client roles. An optional out-of-process application consumes those capabilities without entering the DSH process. @sparkelf/dsh-plus owns dependency closure, ordered profile composition, defaults, exact source compatibility, and references to independent patch packages. A proven official or external gap is one data-only patch package with one exact payload variant and no JavaScript entry, lifecycle hook, Cordis plugin, fuzzy fallback, or compatibility adapter.

The rc.24 distribution targets official DSH 0.1.5-alpha.2 at revision b2e3b2a0125854567a4a5fcba75782e42fe84901. dsh-plus apply requires that exact checkout, verifies all source patches in an isolated Git index, installs profile dependencies, applies pending payloads, builds the official source, links official workspace packages into the profile, and writes the credential-free .dsh-plus/patchset.lock.json.

Profile installation does not auto-install official peer packages because the selected source checkout supplies them. Ordinary Plus capability packages, including SQL Workbench 0.5.0, resolve from npm; the profile has no ordinary GitHub tarball closure or source-owned package override. The production upgrade policy fingerprints every runtime file changed between the accepted profile and the candidate.

## Official ownership and patch retirement

Official DSH owns Sidebar navigation, file and text preview, Session search, responsive columns, Settings chrome, and the Composer structure. Plus carries no Better Sidebar, old Sidebar Office viewer, video-preview bundle, duplicate Session-search implementation, or broad mobile-layout patch. The focused composer-boundary patch changes only the center-column marker and Permission/Model portal placement, and retires when its upstream contribution ships.

The package manifest is the current plugin and patch inventory. Every review deletes a package, patch hunk, profile row, test, or document that duplicates official behavior or lacks an accepted Plus workflow. A patch may add, modify, or remove target package source; its unit is one behavior and retirement lifecycle, not the direction or size of its diff.

## Alternatives considered

**Keep selected fork commits as the product.** Rejected because the fork becomes an implicit second source base and retired behavior cannot be identified from the deployment closure.

**Keep broad patches and repair conflicts mechanically.** Rejected because a clean apply says nothing about duplicated ownership. The DSH 0.1.5 migration removes the old Sidebar, Session-search, and mobile-layout implementations instead of rebasing them.

**Put every patch inside the distribution package.** Rejected because unrelated repairs would share one release and retirement lifecycle.

**Make Desktop the materialization owner.** Rejected because the npm/profile path is the product contract; Desktop is an optional installer and precompiles only dependencies that otherwise require a user build environment.

## Consequences

Plus upgrades require an exact official revision and a fresh profile proof. External packages without npm publication remain fixed reviewed release assets. Official upgrades can change hundreds of package fingerprints, so promotion policy is generated from actual baseline and candidate profiles rather than copied forward. Deleting redundant plugins reduces the dependency graph and leaves official UI extension points available to new focused plugins.

## Verification

Candidate verification starts from the exact official checkout, installs the rc.24 profile without historical cache ownership, runs explicit apply, completes the official Host/Client/Web build, and verifies the generated production profile policy. Every profile change requires repacking the distribution and rerunning apply in a clean checkout; a failed install retry reruns idempotent pnpm install instead of skipping because requirements are unchanged. Source synchronization uses complete file reads or Git index checks; truncated output must never overwrite a source file. The clean build aggregate explicitly references every Plus package with a clientBundle configuration. The existing Plus Playwright suite owns real browser acceptance for official Sidebar and Session search, Backup, Subagent Settings, OfficeCLI, MinerU, DataOps, market and Supervisor integrations, Session export placement, and composer Permission/Model boundaries. The Plus release family remains an explicit release-pack owner after official baseline merges; Plus Web setup invokes it through the pnpm lifecycle so pack scripts receive npm_execpath, and ordinary profile dependencies are distinguished from Cordis bundles. Known optional host resources, such as Linux filemanager icons, are recorded as scoped diagnostic allowances only when the official Host catalog declares the resource absent. Platform CI owns Windows, Linux and macOS package behavior; Desktop packages only native dependencies that require compilation.
