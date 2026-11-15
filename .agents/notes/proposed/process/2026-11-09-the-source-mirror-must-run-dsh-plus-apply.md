# Agent Note: The source mirror must run dsh-plus apply

Status: proposed

English | [中文](2026-11-09-the-source-mirror-must-run-dsh-plus-apply.zh.md)

## Problem

DSH Plus `0.2.9-alpha.75` was published on 2026-11-09. It moves the base to `0.2.2-rc.1` and pins `dsh-better-sidebar 0.30.1-sparkelf.19`, `@sparkelf/dsh-dataops-managed 0.3.48`, and `@sparkelf/dsh-group-chat 0.5.11`. The 3080 deployment still serves `plus-021rc2d`, so the upgrade was attempted against this release.

The build failed before any switch. Four facts were measured:

- `dsh-plus-mirror` still applies source patches from `patches/npm/*`. The 0.2.9 refactor deleted that carrier set; only `better-locale-peer-range` remains, so the loop reports `patches applied: 0 of 0` while the distribution's 31 `dsh-source` entries live in `packages/bundle/plus/patches/*.patch`.
- The same script creates its release tree with `git archive <tag> | tar -x` followed by `git init && git add -A && git commit`. The tree content matches `dsh-v0.2.2-rc.1`, but HEAD is a new local commit (`c0b73522...`), not the official `66491b05...`. `dsh-plus apply --dsh-root` requires the exact official revision and refuses the tree.
- The profile written by `dsh-plus install --edition team` contains 34 redirects of the form `"@deepseek-ai/dsh-client-connection": npm:@sparkelf/dsh-client-connection@0.2.2-rc.1`. Those are the registry-side half of the new patch model. They are not the retired npm patch carriers, but they are also not published at `0.2.2-rc.1`; npm carries only `0.2.2-alpha.2`.
- The published `@sparkelf/dsh-plus@0.2.9-alpha.75` declares `workspace:` dependencies for `@sparkelf/dsh-plugin-backup` and `@sparkelf/dsh-plugin-mcp-credentials`; pnpm rejects those outside a workspace.

A manual source build applied 31 of 31 patches, and the profile installed after the 34 redirects were rewritten to the official `0.2.2-rc.1` packages. It then failed `verify-profile-bundles`: the manifest declares 20 bundles, the profile has 21, and `@deepseek-ai/dsh-base`, `dsh-web-app`, `dsh-experimental-agent-team-profile`, `dsh-experimental-auto-review`, `dshmarket`, and `@sparkelf/dsh-plus` are missing from the profile's list. The profile therefore cannot be declared a source-mirror artifact.

## Proposal

Make the source-mirror build follow the model the 0.2.9 distribution already implements:

1. `dsh-plus-mirror build` creates the tree as a real checkout of the official tag (`git clone --branch <tag>` or `git fetch` plus `git checkout` of the tag commit), so HEAD equals `dshPlus.sourceBase.revision`.
2. The profile is materialized with official package versions: a source mirror does not use the `deriveRedirects` targets, so the 34 `npm:@sparkelf/...@<runtime>` entries are removed from `pnpm-workspace.yaml` and the matching dependency aliases are rewritten to the official runtime version, or the distribution writes a source-mode profile directly.
3. `dsh-plus apply --dsh-root <tree>` runs after the profile exists and installs: it applies all 31 `patchSet.entries` with `target.kind: dsh-source`, writes the full profile composition (bundle list and runtime packages), and links the `@deepseek-ai` scope to the patched sources.
4. `dsh-plus-build` then compiles the patched tree; `dsh-plus-exemptions` writes `compatibility.json` for the runtime; `verify-profile-bundles` compares against the composition `apply` wrote, not against a registry edition.
5. `dsh-plus-switch` promotes the verified tree and rolls back on failure.

The publish-side fixes are separate but required for a releasable artifact: publish the 34 republished packages at the official revision, or stop deriving redirects for a source build; and republish `@sparkelf/dsh-plus` with concrete versions instead of `workspace:` ranges.

## Deployment outcome

The upgrade was completed on 2026-11-09. A clone at `66491b05` with the 34 redirects rewritten installed the official rc.1 packages; `dsh-plus apply --dsh-root` applied 31 of 31 source patches and wrote the full 20-bundle composition; `dsh-plus-build` passed all 10 build gates. The built profile booted on a spare port with 86 client entries and a populated sidebar. `verify-profile-bundles` was replaced by a direct comparison because the installed helper still expects `dshPlusStandalone.bundles`.

`dsh-plus-switch` could not complete the promotion. Its reload client used the new profile's supervisor and received `ECONNREFUSED` on `/root/.dsh/supervisor/runtime.sock`; the switch rolled back. A `systemctl restart` after writing the manifest also failed: the old supervisor writes its in-memory manifest on stop, so the restarted supervisor read the old CLI while the profile link named the new tree, and the old CLI failed importing `Cron` from the new `@deepseek-ai/dsh-util-time`. The working order was: stop the unit, write `runtime.json` with the new `cwd` and `args[0]`, then start the unit. The deployment now serves `0.2.2-rc.1` with plus `0.2.9-alpha.76`; `verify-start` reports HTTP 200, 86 client modules, and WebSocket 101.

## Evidence

| Check | Result |
|---|---|
| source patches applied manually | 31 of 31 |
| profile install with official rc.1 | succeeded after redirect rewrite |
| `verify-profile-bundles` | manifest 20, profile 21; base bundles missing |
| `dsh-plus apply` on the built tree | refused: HEAD `c0b73522`, expected `66491b05` |
| `@sparkelf/*@0.2.2-rc.1` on npm | 0 of 34 present; latest `0.2.2-alpha.2` |
| 3080 during the attempt | `plus-021rc2d`, HTTP 200, 84 client bundles |

## Alternatives considered

**Publish the 34 republished packages and keep the registry path.** This is the documented route for standalone installs and would make the published artifact coherent. It is irreversible, publishes 34 packages for one host, and does not fix the source-mirror tool that 3080 actually uses.

**Use `0.2.8-alpha.50` with base `0.2.2-alpha.2`.** The republished packages exist for that runtime, but the same `git archive`/heredoc/bundle-composition defects are present in its `dsh-plus-mirror`; it also gives up the rc.1 base and the latest plugin pins.

**Keep the local workaround (patch source, rewrite redirects, edit bundle list).** It produced a profile but not a verified artifact; the bundle list still disagrees with the distribution, and every rebuild repeats hand edits that the tool should own.

## Acceptance criteria

- A fresh `dsh-plus-mirror build --tag dsh-v0.2.2-rc.1 --runtime 0.2.2-rc.1` succeeds without unpublished `@sparkelf` packages.
- The tree HEAD equals `dshPlus.sourceBase.revision` before `dsh-plus apply` runs.
- `dsh-plus apply` applies 31 of 31 source patches and writes a bundle list that `verify-profile-bundles` accepts.
- The built profile boots on a spare port with base `0.2.2-rc.1`, plus `0.2.9-alpha.75`, and the pinned plugin versions; the page serves its client bundles.
- `dsh-plus-switch` promotes the tree and `dsh-plus-status` reports the new release; a failed switch leaves `plus-021rc2d` serving.

## Risks

**The edition projection may intentionally omit plugins the old profile mounted.** The built profile lacks `@sparkelf/dsh-mobile-bridge` and `@sparkelf/dsh-quant`; adding them back to match the old 24-bundle composition may reintroduce plugins the release no longer supports.

**The `0.2.2-rc.1` base may reject old plugin peer ranges.** `dsh-plus-exemptions` is the only mechanism that admits them; an empty or stale exemption list silently skips plugins.

**A green `apply` and `build` still do not prove the page boots.** The client-boot check and a real turn remain the acceptance evidence, not the build exit code.