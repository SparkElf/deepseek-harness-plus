# Agent Note: Capability-equivalent Plus npm distribution

Status: implemented

English | [中文](2026-08-29-ranged-plus-patchset-distribution.zh.md)

## Problem

DeepSeek Harness Plus combines official DSH, selected external plugins, product defaults, and temporary repairs. A fork commit set or a settings-only package cannot reproduce that product and can retain implementations after official DSH has taken ownership. Official DSH must remain the only source base, and every accepted difference needs one current owner and retirement condition.

## Decision

Plus uses four delivery forms. A complete capability is an npm-installable Cordis plugin containing all required Host and Client roles. An optional out-of-process application consumes those capabilities without entering the DSH process. @sparkelf/dsh-plus owns dependency closure, ordered profile composition, defaults, exact source compatibility, and references to independent patch packages. A proven official or external gap is one data-only patch package with one exact payload variant and no JavaScript entry, lifecycle hook, Cordis plugin, fuzzy fallback, or compatibility adapter.

The rc.25 distribution targets official DSH 0.1.5-rc.2 at revision fb2c4b9e698e30edb738bca4cf0618587db7d203. dsh-plus apply requires that exact checkout, verifies all source patches in an isolated Git index, installs profile dependencies, applies pending payloads, builds the official source, links official workspace packages into the profile, and writes the credential-free .dsh-plus/patchset.lock.json.

Profile installation does not auto-install official peer packages because the selected source checkout supplies them. Ordinary Plus capability packages, including SQL Workbench 0.5.0, resolve from npm; the profile has no ordinary GitHub tarball closure or source-owned package override. The production upgrade policy fingerprints every runtime file changed between the accepted profile and the candidate.

## Official ownership and patch retirement

Official DSH owns Sidebar navigation, file and text preview, Session search, responsive columns, Settings chrome, and the Composer structure. Plus carries no duplicate Session-search implementation or broad mobile-layout patch; it does carry Better Sidebar with its Office and video preview bundles, because document preview inside the sidebar is an accepted Plus workflow. The focused composer-boundary patch changes only the center-column marker and Permission/Model portal placement, and retires when its upstream contribution ships.

Upstreaming a retired patch targets the fork at `SparkElf/deepseek-harness`, whose branches can be pushed. The official repository `deepseek-ai/deepseek-harness` reports `has_pull_requests: false`, so it accepts no pull request at all: listing its pull requests answers `404`, the same answer as an attempt to open one. An upstream contribution therefore lands as a pushed fork branch plus a patch file in the Plus repository, never as a pull request against the official repository.

The package manifest is the current plugin and patch inventory. Every review deletes a package, patch hunk, profile row, test, or document that duplicates official behavior or lacks an accepted Plus workflow. A patch may add, modify, or remove target package source; its unit is one behavior and retirement lifecycle, not the direction or size of its diff.

## Alternatives considered

**Keep selected fork commits as the product.** Rejected because the fork becomes an implicit second source base and retired behavior cannot be identified from the deployment closure.

**Keep broad patches and repair conflicts mechanically.** Rejected because a clean apply says nothing about duplicated ownership. The DSH 0.1.5 migration removes the old Sidebar, Session-search, and mobile-layout implementations instead of rebasing them.

**Put every patch inside the distribution package.** Rejected because unrelated repairs would share one release and retirement lifecycle.

**Make Desktop the materialization owner.** Rejected because the npm/profile path is the product contract; Desktop is an optional installer and precompiles only dependencies that otherwise require a user build environment.

## Consequences

An official baseline merge brings the upstream `.github/` tree and the gates that read it, so each workflow is classified before it is resolved. Repository-owned CI policy — runner selection, the required-check aggregate, review approval, and issue management, together with the `scripts/ci-workflow.spec.ts` gate that asserts them — keeps the repository copy; a silent restore of the upstream copy adds upstream-only jobs (weighted approval, the pull-request benchmark lane) and drops repository-only ones, which changes the pull-request verdict. CI that reads a baseline source path follows the baseline instead, because the merge renames that path: the release and sandbox workflows track the native package layout the baseline moved from `native/landlock-run` to `native/system`, and the baseline workflow names that own those paths replace the repository ones. An official baseline merge also takes the upstream release-family source, so every official family keeps its own package-name ownership predicate: the official family owns `@deepseek-ai` names and skips co-located Plus packages, while the Plus family owns `@sparkelf` names under its own path patterns. A family that drops that predicate rejects the other authority's manifests and fails the pack and verify jobs. An official baseline merge also redefines the shipped default model: rc.1 replaces the base bundle default `deepseek-v4-flash` with the new multimodal `deepseek-flash` (DeepSeek-V41-Flash) while keeping every V4 catalogue entry, so a baseline merge changes which model an unconfigured deployment reaches. Plus upgrades require an exact official revision and a fresh profile proof. External packages without npm publication remain fixed reviewed release assets. Official upgrades can change hundreds of package fingerprints, so promotion policy is generated from actual baseline and candidate profiles rather than copied forward. Deleting redundant plugins reduces the dependency graph and leaves official UI extension points available to new focused plugins.

## Verification

Candidate verification starts from the exact official checkout, installs the rc.25 profile without historical cache ownership, runs explicit apply, completes the official Host/Client/Web build, and verifies the generated production profile policy. Every profile change requires repacking the distribution and rerunning apply in a clean checkout; a failed install retry reruns idempotent pnpm install instead of skipping because requirements are unchanged. Source synchronization uses complete file reads or Git index checks; truncated output must never overwrite a source file. The clean build aggregate explicitly references every Plus package with a clientBundle configuration. The existing Plus Playwright suite owns real browser acceptance for official Sidebar and Session search, Backup, Subagent Settings, OfficeCLI, MinerU, DataOps, market and Supervisor integrations, Session export placement, and composer Permission/Model boundaries. The Plus release family remains an explicit release-pack owner after official baseline merges; Plus Web setup invokes it through the pnpm lifecycle so pack scripts receive npm_execpath, and ordinary profile dependencies are distinguished from Cordis bundles. Known optional host resources, such as Linux filemanager icons, are recorded as scoped diagnostic allowances only when the official Host catalog declares the resource absent. Platform CI owns Windows, Linux and macOS package behavior; Desktop packages only native dependencies that require compilation.
