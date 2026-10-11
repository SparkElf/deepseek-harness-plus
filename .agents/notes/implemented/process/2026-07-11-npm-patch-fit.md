# Agent Note: Patch fit is checked where pnpm applies it

Status: implemented

English | [中文](2026-07-11-npm-patch-fit.zh.md)

## Problem

`pnpm` refuses an inexact patch. GNU `patch` allows fuzz and `git apply --3way` reconciles by
context, so a retargeted patch whose hunk header still describes the previous version passes every
step that does not use pnpm — including the mirror build, which detects a broken patch by watching
`git apply` fail.

Measured on 2026-07-11, retargeting the better-sidebar catalog patch from 0.24.1 to 0.25.0: the
patch body moved 3078 lines but the hunk header did not. `patch` accepted it at fuzz 2, the mirror
build reported success, and the image build failed with `ERR_PNPM_PATCH_FAILED` thirty minutes into
a rebuild. Two earlier gates — the manifest checks and the source-patch application — both passed,
because neither applies a patch the way pnpm does.

## Decision

`scripts/standalone/verify-npm-patches.mjs` runs as the `npm-patches` gate beside the existing
standalone gates, and checks two properties:

1. **Fit.** Each patch is applied to the installed target with `patch --fuzz=0`, which is pnpm's
   strictness. This catches a patch that stopped fitting at all.
2. **Self-consistency.** Each hunk header is compared with the lines the hunk holds. pnpm enforces
   this wherever the patch is applied, and it is the property a retarget silently breaks: the
   previous header claimed 5 old and 23 new lines for a hunk holding 6 and 24.

The install is optional so the gate runs in CI, where no release tree exists. Only the header check
runs there; the fit check additionally covers this host, where the served profile is the install the
image will be built from.

## Alternatives considered

**Rely on the mirror build.** It already applies the source patches and typechecks the result, and
it is the step that failed to catch this. It cannot catch it: it applies with `git apply --3way`,
which reconciles exactly the drift pnpm rejects.

**Apply through pnpm itself.** The only way to test pnpm's own behaviour is to install, which is the
expense this gate exists to avoid — the failure it prevents cost thirty minutes, and the check takes
under a second.

**Check the published package.** The patches target packages other publishers own, and fetching each
one would put the network in the path of a gate that runs on every push.

## Consequences

A patch that cannot apply is reported at the gate instead of at image-build time. The gate cannot
prove a patch applies to a version that is not installed here, so a retarget is still verified
against the new target when that target first appears in a profile.
