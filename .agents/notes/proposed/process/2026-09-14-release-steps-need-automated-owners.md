# Agent Note: A publication and its mirror are two steps, and the second one is automatable

Status: proposed

English | [中文](2026-09-14-release-steps-need-automated-owners.zh.md)

## Problem

A release was published to npm and reported as complete by every gate the repository runs. Consumers could not install it. Two separate omissions produced the same symptom on the same release.

The first: the mainland mirror serves a synchronized copy that appears only after it has fetched a package, and nothing requested that fetch. The package document answered `404` for a brand-new package, and its tarball answered `404` for a package name consumers had never resolved before. Neither is visible from the registry the publisher wrote to, where both answer `200` immediately.

The second: an npm-target patch declared by the distribution was never applied to a registry installation. `dsh-plus start` created the profile and started the server, and the patch step lived only in `dsh-plus apply`, which needs an official source checkout that a registry installation does not have. A defect fixed by a published patch therefore stayed broken for every consumer of the command line.

Both were recorded as prose in this repository's Agent Notes before they recurred. The lesson is not that the facts were unknown; it is that a fact a human has to remember at the end of a multi-step release is a fact the release will eventually lose.

## Proposal

Give each step an owner that runs whether or not anyone remembers it.

### A release script synchronizes the mirror and proves the result

`scripts/release/sync-plus-mirror.ts` requests a fetch for every Plus member at the release version and polls until the mirror serves each one, failing the release when the budget expires. It runs as the final step of `Release publish (Plus)`, so a publication that consumers cannot install fails the workflow that published it.

Member names come from `releaseFamily('plus').members()` — the same discovery the pack and publish used. A separate list would drift from what actually went out, and the drift would be invisible until a consumer hit the missing package.

The mirror request is idempotent and a re-run is safe: a queued fetch and an already-served package both satisfy it.

### A standalone installation applies the npm patches its distribution declares

`applyProfileNpmPatches` runs from `dsh-plus start`, before the server launches. It reads `dshPlus.patchPackages` from the distribution manifest, applies every `npm`-target variant to the installed copy the launcher loads, and skips a patch whose reverse already applies.

It runs on every start rather than once because a reinstall restores the published bytes, and an `npm`-target patch changes no version, so nothing else would notice.

Source-target variants are skipped rather than treated as work: they need the official checkout that a registry installation does not have, and that half of the patch set keeps its owner in `dsh-plus apply`.

### The wiring has its own test

A unit test over `applyProfileNpmPatches` passes while the function is never called; replacing the call site with a no-op left every existing test green. `tests/standalone-cli-patches.spec.ts` therefore drives the built command and asserts the patch step ran. It fails with "the command did not reach the patch step" when the call is removed.

## Acceptance criteria

- The publish workflow fails when the mirror does not serve a released package within its budget.
- `npm install` of the released standalone package through the mirror produces a working command.
- A registry installation applies every npm-target patch its distribution declares before the server starts.
- A standalone start leaves an npm-target patch it cannot apply reported as a failure rather than starting unpatched.
- Removing the patch call from `start` fails `tests/standalone-cli-patches.spec.ts`.

## Alternatives considered

- **Documenting the mirror step more prominently.** Rejected: the fact was already recorded in this repository, and the release that failed after that recording is the evidence that documentation is not an owner. A step that must run exactly once at the end of a rare, multi-stage procedure is the shape automation exists for.

- **Requiring the operator to run the sync script before announcing.** The release is not installable until the mirror serves it, so the step belongs inside the publish workflow rather than in a runbook beside it. Ordering it after the publish step is what makes a partial failure visible as a failed workflow instead of a successful one with a silent gap.

- **Applying patches during profile creation instead of on every start.** A profile is created once; a reinstall is not. Patching only at creation loses the patch to the first dependency install, which is the state the defect was found in.

- **Treating source-target patches as this function's work.** Rejected: they need an official checkout. `dsh-plus apply` owns them, and the standalone command must not fail every start on work it cannot do.

- **Relying on the Windows coverage job for platform-specific assertions.** It runs in the upstream repository, not this one, so a Windows-only defect is caught by users rather than by CI. Injectable platform parameters keep the assertion runnable where the suite actually runs.

## Risks

- **The mirror is a third party.** Its availability now gates the publish workflow. A mirror outage fails a release that npm accepted; re-running the workflow's final step is the recovery.
- **Patch application is shell work at start.** `git apply` must be present, which the release prerequisites already require for a Desktop installation.
- **A stale patch blocks starts rather than degrading.** A distribution whose patch no longer matches its target fails to start until the patch is retired or the target pinned.

## Consequences

- **A release now fails when consumers cannot install it.** The workflow takes longer by one mirror round-trip; a brand-new package can need a minute before its packument appears.
- **Applying patches at start adds a `git apply` per declared patch on every launch.** It is bounded by the number of patches the distribution declares and each is a `--reverse --check` on an already-patched tree.
- **A patch that no longer applies fails the start.** That is deliberate: silently starting unpatched would return the defect to consumers while reporting success.
- **The mirror is hard-coded as the default.** A deployment installing from a different mirror passes `--mirror`.
