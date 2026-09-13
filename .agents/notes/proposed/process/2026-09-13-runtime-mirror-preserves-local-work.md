# Agent Note: Rebuilding the runtime mirror preserves local commits

Status: proposed

English | [中文](2026-09-13-runtime-mirror-preserves-local-work.zh.md)

## Problem

The runtime mirror at `~/.dsh/releases/plus/<build>` is a git checkout that serves the running profile, and it carries work the repository does not: local deployment customizations and fixes that have not landed yet. Rebuilding it is part of refreshing a deployment, and every rebuild that began with a bare `git checkout` silently dropped that work.

The failure has three stages, and each one hides the loss from the next check:

1. `git stash push -- ':!profile' ':!node_modules'` sweeps the unlanded fixes into the stash together with the customizations.
2. `git checkout <official revision>` overwrites the working tree, so the fixes leave the working copy while remaining only in the stash.
3. `dsh-plus apply` rebuilds `lib/`, which overwrites the *built* output with the official sources even after the sources are restored.

A source check therefore reports success while the deployment is broken, because the running profile imports `lib/index.js`, not `src/*.ts`. Each affected package emits one bundled `lib/index.js` rather than a file per source, so looking for a `lib/icons.js` both misses the change and returns an empty result that reads as "absent" rather than "wrong path".

## Proposal

Treat the mirror's working tree as data to preserve, not a clean checkout to move:

1. Record the unlanded work before touching the revision, and restore it by path rather than by popping a stash that also holds other changes: `git diff > <patch>` for a file list, or `git stash push -- <explicit paths>`.
2. Prefer landing the fix upstream and re-pinning over editing the mirror; a change committed to the repository survives every rebuild.
3. Verify at the layer the deployment actually loads: grep the bundled `lib/index.js` for the change, and confirm the endpoint the feature serves returns the expected content. A source grep is not evidence about a running profile.
4. When a rebuild follows an `apply`, rebuild the affected packages before restarting, because `apply` restores the official sources into `lib/`.

## Acceptance criteria

- A rebuild that starts from a mirror with unlanded work ends with that work present in both `src/` and the package's bundled `lib/index.js`.
- The verification step names the built artifact and the served endpoint, not only the source file.
- No step discards work with a bare `git checkout` or an unqualified `git stash push` against the mirror.

## Alternatives considered

- **Keep a branch in the mirror and rebase it on each rebuild.** Rejected: the mirror's revision is fixed by the distribution's `sourceBase.revision` and `apply` refuses any other checkout, so a branch cannot carry the difference.
- **Copy the mirror before every rebuild and restore from the copy.** Rejected as the primary mechanism: the copy is several gigabytes, and the same result comes from recording the unlanded diff, which is a few kilobytes and names the files it covers.
- **Stop editing the mirror at all and always land fixes upstream first.** Adopted as the preference, but not as the only rule: a deployment under repair cannot always wait for a release, so the explicit-path stash keeps that case recoverable.

## Risks

- Requiring every fix to land before a rebuild blocks urgent local repairs; the explicit-path stash and restore covers that case without weakening the check.
- Grepping a bundle matches minified identifiers; grep for a stable string the code writes (a path, a marker constant) rather than an internal function name.
