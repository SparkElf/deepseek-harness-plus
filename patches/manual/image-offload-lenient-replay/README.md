# Manual patch: lenient `image/offload` replay for npm installs

This directory holds a patch that the release path does **not** apply. It exists because
one of the two fixes that make a session readable has no path into an npm installation.

## Why it is manual

`@sparkelf/dsh-patch-image-offload-hoist-replay` is a `dsh-source` patch: it edits
`packages/compaction/compaction-image-offload/src/` and only lands where the official
sources are checked out and rebuilt. An npm installation ships `lib/` and no `src/`,
so that patch cannot apply there.

This patch delivers the same behaviour against the published `lib/` files. It is kept
out of `patches/npm/` and out of `dshPlus.patchPackages` deliberately: a `patches/npm`
entry is applied by every profile install, and a profile built from official sources
already contains the fix in `lib/`, so applying it there would fail on an already-fixed
file and abort the build.

## Target

`@deepseek-ai/dsh-compaction-image-offload` from the registry, version `0.2.1-rc.2`.
The patch is exact-content, so it applies only to that published build.

## Apply

From the package directory inside the profile being previewed:

```sh
cd <profile>/node_modules/@deepseek-ai/dsh-compaction-image-offload
git apply /path/to/image-offload-lenient-replay.patch
```

Restart the service afterwards; the module is loaded at boot.

## What it changes

`offloadMessageImages` gains `positionsAreAuthoritative` (default `true`) and the
projection derives it from the fold window: a window containing an `image/hoist` row has
projection-dependent image positions, so a recorded selection that no longer resolves is
skipped instead of fatal. A window without one keeps the strict behaviour, so a genuine
writer bug still fails loudly.

## Retire when

The session-readability fix reaches npm installs by a supported path — either the
official package ships it, or `dsh-plus` learns to apply a `dsh-source` patch to the
published build. At that point this file and its directory are deleted.