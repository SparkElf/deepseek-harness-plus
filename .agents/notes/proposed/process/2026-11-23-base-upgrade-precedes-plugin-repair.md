# Agent Note: A base upgrade lands before plugin repair, and Plus releases from the repaired set

Status: proposed

English | [中文](2026-11-23-base-upgrade-precedes-plugin-repair.zh.md)

## Problem

The 3080 deployment currently runs official `0.2.2-rc.2` behind Plus `0.2.9-alpha.92`. Moving it to
official `0.2.3-alpha.2` through the existing promotion path would change three independent things
at once: the base runtime, the plugin set, and the Plus patch payload. When the result fails, no
observation says which of the three caused it. The 2026-10-29 attempt on `0.2.2-alpha.2` failed
exactly this way: the new base rejected the profile's approval policy, two bundles no longer
resolved, and 276 scope links still pointed at the previous release. Each defect was real, but
none could be attributed until the tree was already switched and rolled back.

The 2026-11-09 source-mirror failure records the same conflation from the build side: the apply step, the redirect set, and the profile composition were each wrong for a different reason, and the report could only separate them after four independent measurements ([note](2026-11-09-the-source-mirror-must-run-dsh-plus-apply.md)).

The promotion path also publishes before it knows what the new base can already do. A patch or a
plugin that exists because `0.2.2-rc.2` lacked a capability is rebuilt, republished, and mounted on
`0.2.3-alpha.2` even when the new base provides the same behavior. The release then carries code
whose only justification is a base that is no longer running, and the next upgrade inherits it.

## Proposal

Every base bump follows six phases, in this order. A phase does not start until the previous
phase's acceptance evidence exists.

### Phase 0 — Freeze and record the baseline

Record `dsh-plus-status --json`, the served release path, `runtime.json`, `accepted-profile.json`,
the profile's `package.json` and `pnpm-workspace.yaml`, and the current `@sparkelf/dsh-plus`
version. Keep the served release untouched as the rollback anchor. Every later phase builds into a
new directory or an isolated `DSH_HOME`.

### Phase 1 — Bare base, then remove what cannot mount

Install official `@deepseek-ai/dsh-base@0.2.3-alpha.2` and `@deepseek-ai/dsh-web-app@0.2.3-alpha.2`
in an isolated profile with no Plus layer. Boot it on a spare port and prove a real turn, not only
HTTP 200. Then mount the edition's bundles one at a time and record, per bundle, whether it
resolves, imports, mounts, and survives one smoke interaction.

A bundle that fails is removed from the candidate set for this release. The failure record names
the bundle, its version, its declared peer ranges, the exact error, and the phase it failed in.
Removal is a release decision, not a silent skip: the omission is recorded in the edition manifest
and in the phase report.

### Phase 2 — Repair incompatible plugins one at a time

Each removed bundle gets one repair at a time: widen or correct the peer range, adapt a renamed or
removed API, update a client slot or settings schema, or rebuild a native dependency. The repaired
package is tested by packing it and installing the tarball into the bare profile, so the test does
not depend on a registry publish. A repair that cannot be expressed inside the plugin's own
boundary is reclassified through the plugin-ownership workflow instead of patched into an official
package.

The phase ends with a compatibility matrix that names every bundle, its previous and new version,
its verdict, and the evidence for that verdict.

### Phase 3 — Retire before optimizing

Read the `dsh-v0.2.2-rc.2..dsh-v0.2.3-alpha.2` release notes and source diff. For every Plus patch
entry and every self-developed plugin, ask whether the new base now provides the behavior. A patch
whose `retireWhen` condition is met is retired, not rebased. A plugin that duplicates a new base
capability is removed from the editions and its source is deleted or archived. A plugin that can
consume a new extension point instead of carrying its own workaround is simplified to that
extension point.

The output is a per-entry disposition: `retire`, `simplify`, `keep`, or `new`, with the upstream
identifier or release note that justifies it.

### Phase 4 — Publish the repaired set, then assemble the editions

Bump every package whose payload changed, build the whole repository, and run the governance
gates. Update `dshPlus.sourceBase`, `compatibility.dsh`, `runtime.version`, and the republished
official packages to `0.2.3-alpha.2`. Assemble `dshPlus.editions.personal` and
`dshPlus.editions.team` from the verified package versions; `intranet-team` follows the same rule
because the workspace container installs it.

Publish the changed `@sparkelf/*` packages and the new `@sparkelf/dsh-plus` through
`release:ship --family plus`. The edition manifests, the patch set, and the published package
versions are one artifact and are released together.

### Phase 5 — Install Plus on a bare base

From a clean `0.2.3-alpha.2` profile, run `dsh-plus install --edition personal` and boot the
result on a spare port. Verify the client bundle count, the mounted tools, one real turn, Session
recovery, and the sidebar. Repeat for `team`. A registry install of the published distribution is
the acceptance test; a source mirror is not a substitute because it does not exercise the
published dependency graph.

Only after both editions pass does the running deployment move. The production switch keeps the
existing supervisor, profile-guard, and closure-gate procedure.

### Phase 6 — Update the workspace container

Update the DataOps workspace image's base and Plus pins to the verified versions, rebuild the
image, and run the same bare-install acceptance inside the container. The host deployment and the
container are separate consumers of the same published artifact and are verified separately.

## Alternatives considered

**Promote Plus directly onto the new official tag, as the current promotion skill describes.**
Rejected because it changes the base, the plugins, and the patch payload in one build. The
2026-10-29 failure showed that the resulting errors cannot be attributed, and the rollback has to
undo all three changes at once.

**Keep the old base and repair plugins against it.** Rejected because it postpones the base move
without reducing its cost; the plugins would need the same repairs later, against a base that is
already older than the published official line.

**Publish each repaired plugin as soon as it is fixed.** Rejected because the editions and the
Plus manifest would then be assembled from a mixture of published and unpublished versions, and a
failed phase would leave the registry ahead of the release. Repairs are packed and installed
locally until the set is coherent, then published once.

**Use a source mirror as the acceptance environment.** Rejected because a source mirror links the
patched workspaces directly and does not prove that the published dependency ranges resolve. The
acceptance test has to install from the registry, which is what a consumer does.

## Acceptance criteria

- The bare `0.2.3-alpha.2` profile boots on a spare port, answers HTTP, serves its client modules,
  and completes one real turn with a tool call.
- Every bundle in the personal and team editions has a compatibility verdict with the exact
  failure or pass evidence.
- Every repaired plugin installs from its packed tarball into the bare profile.
- Every Plus patch entry has a `retire`, `simplify`, `keep`, or `new` disposition tied to an
  upstream identifier.
- `dshPlus.sourceBase.revision` is `4b399c39a6d1479cd84ca591b4d7c88e24d38a96` and
  `dshPlus.compatibility.dsh` names `0.2.3-alpha.2`.
- A clean profile installs the published personal and team editions from the registry and boots
  with the same bundle count and a working turn.
- The workspace container runs the same published versions and passes the same smoke test.
- The served 3080 deployment reports `0.2.3-alpha.2` from `dsh-session`, `dsh-tools`, and
  `dsh-host-webserver`, not only from the distribution wrapper.

## Risks

**Bare-base testing can pass while the Plus profile still fails**, because Plus patches change
official packages. Phase 5 exists for that gap; phase 1 is not evidence for the composed profile.

**Removing a bundle for one edition can leave the other edition unmountable**, because the team
edition shares dependencies with the personal one. Each edition gets its own mount test, and a
removal is recorded per edition rather than globally.

**A plugin repair can hide a base regression.** Widening a peer range makes the resolver accept a
version; it does not prove the API still behaves. Every repair needs one behavioral smoke test, not
only a successful install.

**The published artifact can differ from the tested tarball.** The acceptance install reads the
registry, so propagation is part of the test; a local tarball pass is a pre-condition, not the
result.