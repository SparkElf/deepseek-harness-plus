# Agent Note: the compatibility floor must admit the pinned runtime

Status: implemented

## Problem

A Plus distribution reaches its runtime through two values that a release moves together:
`dshPlus.profile.overrides` pins each official package to a republished build, and
`dshPlus.compatibility.dsh` states the oldest runtime the distribution accepts.
`generate-manifest.ts` writes the floor into the standalone manifests as the
`@deepseek-ai/dsh` dependency, and npm resolves that floor to pick the launcher.

Nothing compared the two. Moving the overrides to 0.2.1-alpha.1 while the floor stayed at
`>=0.2.0-rc.2` produced an image that installed a 0.2.0-rc.2 launcher beside 0.2.1-alpha.1
plugins. The plugin compatibility gate rejected each one in turn, the profile never started,
and the image reported `DSH_START_FAILED`.

The floor cannot simply be the pin. It is a minimum-only range that later patches raise, and
semver admits a prerelease only when the comparator names the same major.minor.patch: a
floor of `>=0.2.0-rc.2` excludes every 0.2.1 prerelease no matter how much newer it is.
A release that publishes a prerelease of a new patch version therefore has to move the floor,
and the failure when it does not is remote from the operator's edit.

## Decision

`verify-plus-governance` requires every version pinned in `dshPlus.profile.overrides` to
satisfy `dshPlus.compatibility.dsh`.

The gate asserts the relationship rather than a value, so it survives any future release: it
reads the pinned versions from the overrides and asks semver whether the floor admits them. A
floor below the pin fails the gate with both versions named; a floor at or above it passes.

## Alternatives considered

Deriving the floor from `sourceBase.revision` would remove the second value to maintain, but
the repository does not map a git revision to a published version: the official tag is on the
upstream remote, and the release already carries the version it means in the overrides. A
derived floor would also stop a patch release from raising the floor independently of the base,
which is how a reviewed compatibility decision is currently expressed.

Restating the floor as an exact version in `generate-manifest.ts` would pin the launcher
dependency, but the floor is published, is what consumers read for compatibility, and is
already the single input the manifest generator consumes.
