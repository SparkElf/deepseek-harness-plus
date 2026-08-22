# Agent Note: Fail-open pull-request CI impact selection

Status: implemented

English | [中文](2026-08-22-fail-open-pr-ci-impact.zh.md)

## Problem

The required pull-request workflow ran repository-wide coverage, built consumers, two additional Node versions, Python release checks, Wine, and native Windows for every source change. Most workspaces do not own independent test or build targets, so a package graph alone cannot reduce those root aggregates. A local Client presentation edit consequently paid for unrelated Host, Python, and platform contracts.

Changed paths are still incomplete evidence. Client plugins join the shipped Web application through dynamic composition, browser cases do not statically import every package they exercise, and manifests, compiler faces, generated contracts, Cordis configuration, loaders, artifacts, and release inputs can affect consumers outside their path subtree. A selector that guesses across those relationships can make a required skipped job hide a regression.

## Decision

The CI workflow resolves one impact plan before starting pull-request jobs. [scripts/resolve-ci-impact.mjs](../../../../scripts/resolve-ci-impact.mjs) compares the pull-request merge base and head with rename detection disabled, classifies Git status/path pairs, and emits the job modes consumed by GitHub Actions. The static lane runs for every pull request.

The selector has three modes. **docs** accepts documentation-only additions or modifications and skips coverage, browser, compatibility, Python, and Windows jobs. **client** accepts additions or modifications confined to src and tests in explicitly mapped Client packages, plus named Web browser cases and documentation; it runs Vitest changed-test discovery, limits coverage to changed TypeScript, builds official artifacts once, validates built packages, runs lint and duplication, and sends the mapping's browser files through the existing bounded runner with its serial owners intact. **full** retains the repository-wide coverage, consumer, Node compatibility, Python, Wine, and native Windows jobs.

Deletion or another structural Git status, an empty change set, a manifest or configuration file, an unmapped Client package, non-Client production code, CI or repository scripts, mixed runtime areas, or invalid input selects **full** or fails the planner. The required aggregate knows each selected job and accepts skipped only when the plan selected that skip; a selected skipped, cancelled, or failed job fails the aggregate. Changes to the planner, workflow, mappings, or aggregate therefore receive the full pull-request matrix.

The Client mapping names browser files under [apps/web/tests](../../../../apps/web/tests) for each eligible package. Adding a package to this mapping is a test-ownership decision: its list covers every stable browser workflow that consumes that package, and shared composition packages remain unmapped until that ownership is defensible. An explicitly changed browser case selects itself; shared Web support and application source select **full**.

A nightly run on the default branch forces **full**, independent of changed paths. This keeps the complete cross-platform and release-shaped signal without adding the full hosted matrix to every master push.

## Alternatives considered

**Introduce Nx affected execution.** Nx can discover pnpm projects and infer some TypeScript, Vite, and Vitest tasks, but the repository's tests and builds remain root aggregates, tsdown has no first-party Nx inference, and dynamic Cordis and Client relationships still require owned graph rules. Nx would add a second orchestration layer before it could provide this selector's narrow benefit.

**Use the existing change-scope report as the planner input.** The [explicit scope report](../process/2026-07-27-explicit-change-scope-report.md) owns local committed, staged, unstaged, and untracked evidence through a TypeScript command. CI needs only the committed merge-base range before dependency installation; installing workspace dependencies before selecting jobs would add latency to every lane. The CI planner therefore keeps a narrow zero-dependency committed-diff reader, while change-scope remains the richer local evidence owner.

**Use GitHub path filters alone.** Workflow paths can suppress jobs but cannot express Git status, a reviewed package-to-browser-case relation, changed-file coverage, or aggregate verification of intentional skips. Scattered filters would also create several policy owners.

**Keep the full matrix on every pull request.** This has the lowest selection risk but spends the longest lanes on unrelated platform and release contracts, delaying feedback for local Client changes and documentation.

**Infer all affected browser cases from imports.** Built Web cases exercise dynamic plugin composition and do not import every owning Client package. Static import reachability would report false negatives for the exact assembled behavior the browser lane protects.

## Consequences

Documentation pull requests finish after the static lane. Eligible Client changes retain 100% per-file coverage for changed TypeScript and selected real browser behavior while avoiding unrelated compatibility, Python, and Windows work. High-impact and unknown changes preserve the existing exhaustive pull-request evidence, and nightly full runs preserve broad drift detection.

The explicit mapping is correctness infrastructure and carries review cost. An incomplete mapping can defer an unselected browser regression to the nightly full run, so shared packages stay fail-open and mapping expansion requires evidence from the browser test owners. This approach deliberately buys less automatic scope than a general project graph in exchange for one small, inspectable policy owner and no new task framework.
