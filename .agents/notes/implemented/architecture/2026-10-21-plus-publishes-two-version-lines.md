# Agent Note: The Plus family publishes two version lines

Status: implemented

English | [中文](2026-10-21-plus-publishes-two-version-lines.zh.md)

## Problem

`PlusFamily` inherited `DshFamily`'s `verifyVersions`, which requires one version across every
member. That rule is right for the official packages, where one tag names one source revision.
It is wrong for this family, which publishes two kinds of artifact whose versions answer two
different questions.

A patch package's version names the runtime whose sources its patch applies to. Its
`dshPatch.variants[].dsh` range and `target.baseRevision` already carry that binding precisely;
the version is the human-readable form of the same fact, and it advances when the runtime moves.
A distribution package's version names this family's own release. Tying them together meant the
distribution could only be released by moving every patch package to a version that misdescribed
what it patches.

The cost was already being paid. `0.2.1-rc.2` shipped 28 patch packages against the rc.2 runtime
while `packages/bundle/plus` stayed at `0.2.1-alpha.31`, so `bump.ts` and `pack.ts` both aborted
and `0.2.1-alpha.31` was recorded by hand in a `chore(release)` commit rather than cut by the
release path. A consumer reading `dsh-plus@0.2.1-alpha.31` could not tell which runtime it
packaged, and the next release had no version left to take: the shared number was published and
the patch packages could not move.

## Decision

`PlusFamily` overrides `verifyVersions` and accepts independent versions, rejecting only a
version this repository cannot publish. The distribution tracks the runtime it packages:
`0.2.1-rc.2` names the rc.2 delivery, and a change beneath that same runtime advances the fourth
segment to `0.2.1-rc.2.1`. Patch package versions keep naming the runtime.

Two facts made this the only workable spelling. `0.2.1-rc.2` was already published for the 28
patch packages, so a distribution-only change had no unused version on that line. And semver
orders `0.2.1-rc.2.1` above `0.2.1-rc.2` and below `0.2.1-rc.3`, which a hyphenated spelling such
as `0.2.1-rc.2-0.2.1` does not: its prerelease identifiers compare as `["rc", "2-0", 2, 1]`, which
sorts *after* `0.2.1-rc.3` and satisfies neither `>=0.2.1-rc.2` nor `^0.2.1-rc.2` once the next
runtime ships.

## Alternatives considered

**One version across both lines.** This is what the inherited rule required. It forces every
patch package to be republished for a change it does not carry, and leaves no version for a
distribution-only release once the shared number is published — the state the family was already
in.

**A hyphenated fourth segment (`0.2.1-rc.2-0.2.1`).** It reads as "the Nth release under rc.2",
which is the intended meaning, but the ordering above makes it unusable: a later runtime's
`0.2.1-rc.3` sorts *below* it, so ranges resolve to a stale patched build in preference to the
new runtime.

**Recording the distribution manifests by hand.** This is how `0.2.1-alpha.31` was produced.
It leaves the release unreproducible and skips the gates that `bump.ts` and `pack.ts` run, which
is how the family arrived at four coexisting versions (rc.2, alpha.29, alpha.30, alpha.31).

## Consequences

A distribution release no longer touches the 28 patch packages, so its packed set is 36 tarballs
instead of 37 and an unchanged patch package is skipped by content rather than republished.

The binding between a patch and its runtime now rests entirely on `dshPatch`, which is where the
materializer reads it, so a patch whose version drifted from its target still applies correctly
and a patch whose target moved without the patch following fails loudly at install.

`verifyVersions` no longer catches a distribution member left behind on an older version. Nothing
replaced that check: `verify:plus-governance` covers profile composition, patch declarations,
source base, and curation, not version consistency across distribution members.

## Verification

`release:local --family plus` packed 36 tarballs and `verify-packed-install` reported
`0.2.1-rc.2.1` for both installers, then `verify-published` confirmed every member is served and
`latest` resolves it. `verify:plus-governance`, `verify:standalone-manifest`, and
`verify:standalone-variants` pass. The 28 unchanged patch packages publish as skips with
"already published with identical content".