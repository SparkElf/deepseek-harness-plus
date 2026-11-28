# Agent Note: Adopt right-bg-anim as a first-party plugin

Status: implemented

English | [中文](2026-11-28-adopt-right-bg-anim-as-first-party.zh.md)

## Problem

`dsh-right-bg-anim` is a decorative DSH client plugin that SparkElf owns, but it was published as an unscoped npm package (`dsh-right-bg-anim@1.1.0`, author `forestlightelf`) and mounted in the Plus profile as a third-party pin. The source also sat as a vendored copy in `SparkElf/dataops`, so ownership, repository metadata, and release ownership disagreed with the actual maintainer.

## Decision

Move the source to `downstream/packages/plugins/dsh-right-bg-anim` and publish it as `@sparkelf/dsh-right-bg-anim@1.1.0`: author `SparkElf`, repository `SparkElf/deepseek-harness-plus`, directory `downstream/packages/plugins/dsh-right-bg-anim`. The build generates both `lib/client.js` and `lib/index.js` from `src/`. Add the package to the release manifest (`packages.plugins`, `localPackages`, `profileDependencies`, `profile.bundles`). Keep the MIT attribution to `JohnnyTing/dsh-official-homepage-theme` for the derived fluid and grid motion.

## Alternatives considered

**Keep it as an unscoped third-party npm pin.** Rejected: the package is SparkElf-owned, and the pin made the profile depend on a personal npm identity and a source copy in the dataops repository.

**Put it under `downstream/packages/forks/`.** Rejected: it is not a fork of a package owned by someone else. Only the animation algorithm is derived, and that derivation is already recorded in LICENSE and README; the plugin source and release are ours.

## Consequences

The generated profile resolves the scoped workspace package on the next rebuild. The running profile keeps the old unscoped `dsh-right-bg-anim@1.1.0` until it is rebuilt, or until the scoped package is published and re-pinned. The old npm package remains published for compatibility but is no longer mounted by the release manifest.

## Verification

`node scripts/build.mjs` writes `lib/client.js` (66,213 chars, 10 modules) and copies `lib/index.js` from `src/index.js`; it rejects duplicate top-level declarations and default or export-list forms. The manifest now lists 27 first-party plugins and 30 local packages, with `@sparkelf/dsh-right-bg-anim` in `profileDependencies` and `profile.bundles`.
