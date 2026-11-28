# Agent Note: Retire the image hoist plugin

Status: implemented

English | [中文](2026-11-28-retire-dsh-image-hoist.zh.md)

## Problem

`@sparkelf/dsh-image-hoist` writes `image/hoist` rows when the current LLM route appears in its `providers` list. Both shipped mounts set `providers: []`: the Plus bundle patch and the DataOps embedded overlay. No shipped profile has written a row, yet the package still carries a dependency, a profile copy in the runtime image, a third-party notice, and an entry the downstream migration inventory excludes.

The replay half is independent. `image-offload-hoist-replay.patch` makes `compaction-image-offload` and `session-query` tolerate positions recorded against hoisted carriers, and it remains required for sessions written by earlier deployments that did enable the plugin.

## Decision

Remove the plugin from the distribution: the insert block in `packages/bundle/plus/cordis.patch.yml`, the insert block in `images/workspace/context/dataops-dsh-embedded.patch.yml`, the `@sparkelf/dsh-image-hoist` dependency in `packages/bundle/plus/package.json`, the copy in `downstream/image/Dockerfile` and `downstream/tools/downstream.mjs`, and the `THIRD_PARTY_NOTICES.md` row.

This supersedes the `Image hoist replay` application in [the ownership note](../architecture/2026-10-30-plus-patchset-and-component-ownership.md), which kept the plugin as self-developed.

## Alternatives considered

**Move the writer into a dsh-source patch.** Rejected: the writer reads the current route and appends a plugin-owned `image/hoist` event from `agent/pre-step`. Moving that into official source would hardcode a Plus event type and route policy in packages that do not own them, and would apply the behavior to every deployment rather than the routes named in configuration.

**Keep the inert mount.** Rejected: it preserves a dependency, an image copy, and a notice for behavior no shipped profile enables. A deployment that needs the hoist can install the published package into its own profile.

## Consequences

No shipped profile changes behavior: both mounts were inert. Sessions that already contain `image/hoist` rows remain readable through the replay patch; without the projection they read with images in their durable tool-result positions, which is the un-hoisted request shape. The package remains on npm at 0.1.5 for explicit opt-in, and its source remains in the archived `dsh-plugins-plus` repository.

## Verification

Both patch files parse as YAML arrays with no `image-hoist` entry, `packages/bundle/plus/package.json` and the lockfile contain no reference, and `node --check downstream/tools/downstream.mjs` passes. `verify:plus-governance` does not complete in this checkout because its production install runs the better-sidebar `prepare` script without devDependencies (`tsdown: not found`), a pre-existing failure unrelated to this change.
