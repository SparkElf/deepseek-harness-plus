# Agent Note: A republished version must carry that version's source

Status: proposed

English | [中文](2026-09-19-a-republished-version-must-carry-that-versions-source.zh.md)

## Problem

`@sparkelf/dsh-api-session-controller@0.1.6-alpha.2` and `@sparkelf/dsh-agent-presets@0.1.6-alpha.2` cannot load on DSH 0.1.6-alpha.2. Both carry a typert manifest whose codecs lack the `create()` factory the alpha.2 loader requires:

```
typert-loader: @deepseek-ai/dsh-api-session-controller invocation
  "@deepseek-ai/dsh-api-session-controller#fileReferences/list" parameter codec
  must use a strict codec
```

Measured against the two builds of the same version:

| | official `@deepseek-ai` | ours `@sparkelf` |
|---|---|---|
| `lib/typert.host.js` | 164788 bytes | 159731 bytes |
| `create:` occurrences | 34 | 0 |
| `repository.url` | `github.com/deepseek-ai/deepseek-harness` | `github.com/SparkElf/deepseek-harness-plus` |

A deployment that follows the distribution's own `overrides` therefore fails to boot: the override points `@deepseek-ai/*` at our republished copy, and the copy will not register.

## Why it happened

`scripts/release/republish-patched-official.mjs` takes `--version`, and the release ran it with `0.1.6-alpha.2` while the fork's own workspaces still declared `0.1.6-alpha.1`:

```
$ node -p "require('./packages/api/session-controller/package.json').version"
0.1.6-alpha.1
$ npm view @sparkelf/dsh-api-session-controller version
0.1.6-alpha.2
```

The flag rewrites the version field of every republished manifest. It does not, and cannot, update the source those packages were built from. A version number is a claim about contents, so the published artifact claims alpha.2 while carrying alpha.1's typert definitions — the one field the loader validates.

**Nothing in the release path compares them.** The publisher verifies that the packaged output matches the workspace it came from, which it does; the workspace's own version is never checked against the version being published.

## Proposal

**Refuse a republished version the source does not declare.**

In `package-patched-official.mjs`, when `--version` is given, compare it against the source checkout's own version and fail when they differ:

```
republish-patched-official: --version 0.1.6-alpha.2 but the source declares
0.1.6-alpha.1 at packages/api/session-controller; rebase the patches onto the
alpha.2 tree first, then republish
```

The comparison belongs in the packaging step rather than the publish step: packaging is where the source is read, and the guard then covers every caller including the aggregate `republish-patched-official` entry point.

## Findings this change rests on

1. **The two builds differ only where the source differs.** File sizes and `create:` counts above; the `repository.url` field identifies which build a consumer received.
2. **The loader validates the codec, not the version.** `requireStrictCodec` checks `mode === 'strict'` and `typeof create === 'function'`; a manifest from an older source fails on the second.
3. **The failure is a boot failure, not a degraded mode.** The whole profile fails to load: `failed to apply loader entry typert-loader`.
4. **Only deployments that honour the overrides are affected.** The Linux profile at `0.2.0-rc.5` had overrides that did not take effect and received the official packages, which is why the defect stayed hidden until a fresh install applied them.
5. **A fresh install is what surfaces it.** The Windows deployment reproduced it on the first start after `pnpm` resolved the overrides from scratch.

## Acceptance criteria

- Packaging fails when `--version` names a version the source checkout does not declare.
- The error names both versions and the workspace that disagrees.
- Publishing a version whose source matches still succeeds.

## Alternatives considered

**Rebase the patches onto the alpha.2 tree and republish.** That is the actual fix for the current release, and it is what the guard's message asks for; the guard exists so the next release cannot skip it.

**Compare the packed tarball against the official package at the same version.** Rejected as the primary check: a patch may legitimately change a file, so the comparison cannot decide what is stale. Version agreement is the invariant that actually holds.

**Publish under the source's own version.** Rejected: the distribution's overrides name an exact version, and republishing the same version under a different number would leave the override pointing at nothing.

## Risks

**The guard blocks a release that currently succeeds.** Republishing a corrected build of a version whose source has not moved is a real case; it now needs the source version bumped first, which is the point.

**The fork's source version must be kept in step with the upstream it tracks.** That is a manual step today, and the guard converts its omission from a silent bad publication into a failed release.
