# Agent Note: A patched workspace reaches a registry installation only through an override

Status: proposed

English | [中文](2026-09-17-a-patched-workspace-needs-an-override.zh.md)

## Problem

The distribution declared sixteen patches, and a consumer who installed it from the registry received thirteen of them. Three source patches — the WSL native-open path, the legacy interrupted-turn restart, and the composer popover boundaries — reached only a source checkout.

Nothing failed. `verify-plus-governance` passed, the closure gate passed, and the published profile carried the patch packages. The capabilities were simply absent for every consumer who installed from npm while present for the deployment that built from source, which made a "the same distribution" claim false in a way no gate reported.

## Why it stayed invisible

**The mechanism takes two lists, and only one was checked.** A source patch reaches a registry installation when its target workspace is repackaged under our scope, and the consumer's tree prefers that package only when the distribution's `overrides` names it:

```
patches/npm/<name>/                  the patch itself
  ↓ target.paths[].packages/host/open-in-app
PATCHED_WORKSPACES                   repackage this workspace as @sparkelf/dsh-*
  ↓
profile.overrides                    '@deepseek-ai/dsh-host-open-in-app': 'npm:@sparkelf/...'
  ↓
the consumer's install               resolves our package instead of the official one
```

`PATCHED_WORKSPACES` was already checked against the patch files, with a comment explaining exactly this failure mode. That check passed. The second link — the override — had no check at all, so a workspace could be repackaged and never referenced.

**Three of the four were new.** `wsl-native-open`, `session-format-legacy-restart`, and the popover patch's move into `ui-permission-presets` were added in recent sessions. Each arrived with its patch package and its curation entry, which is what the existing gates look at, and none reached the two lists that decide whether a consumer installs it.

**One entry was stale in the other direction.** `packages/client/ui-conversation` was in `PATCHED_WORKSPACES` and no longer named by any patch, so it published a package the patch set does not describe. The existing check caught this one; the missing half caught nothing.

## Proposal

**Check both links, and make the check read the patch files rather than a list.**

`PATCHED_WORKSPACES` gains four entries and loses one. The spec that already compares it against the patch headers also verifies, for every workspace in it, that the distribution's `overrides` names that workspace's own package name. The workspace's `package.json` is the authority for the name, because a path join does not produce it: `apps/web` publishes as `@deepseek-ai/dsh-web-frontend` and `packages/bundle/web-app` as `@deepseek-ai/dsh-web-app`.

`republish-patched-official.mjs` gains `--skip-publish`. A publication that stops on the first version the registry already carries leaves the later tarballs unpacked, and the already-published set is the normal case when a release adds a workspace: every existing member is present and only the additions are new.

## Findings this change rests on

1. **Repackaging without an override ships nothing.** `package-patched-official.mjs` writes `@sparkelf/dsh-*`; the consumer's tree keeps importing `@deepseek-ai/dsh-*` unless `dshPlus.profile.overrides` substitutes it.
2. **Three workspaces were repackaged and unreferenced.** Measured against the published registry: `@sparkelf/dsh-host-open-in-app`, `@sparkelf/dsh-native-command`, `@sparkelf/dsh-session-format-v0-to-v1`, and `@sparkelf/dsh-client-ui-permission-presets` had no version published at all, so no install could reach them.
3. **The patch headers name every patched workspace.** `workspacesThePatchesModify` already derives the expected set from `diff --git` headers, which is why the list check needed only its missing counterpart rather than a new source of truth.
4. **A packaged name is the workspace's own manifest name.** `apps/web` is `@deepseek-ai/dsh-web-frontend`; deriving it from the path would name a package that does not exist.
5. **The override's key is the official name and its value the substitution.** The check compares the workspace's manifest name against the keys.
6. **The published set is not the full set until the additions publish.** After adding four entries, `republish` packs 23 packages where it packed 20; the twenty existing versions answer `E403` on the first member and stop the run, so the four additions need their own publication pass.

## Acceptance criteria

- Every workspace in `PATCHED_WORKSPACES` has an `overrides` entry naming its package. The spec fails with the missing workspaces listed when one is removed, measured by removing `packages/host/open-in-app`.
- `PATCHED_WORKSPACES` equals the workspaces the declared patches modify, in both directions.
- `republish-patched-official.mjs --skip-publish` packages and verifies without publishing, and its output directory holds every tarball.
- A consumer installing the distribution resolves our package for each patched workspace.

## Alternatives considered

**Add the four entries to `PATCHED_WORKSPACES` only.** Rejected: repackaging alone changes nothing for a consumer, so the patch would stay unreachable. The override is the link that has to hold.

**Derive the overrides automatically from `PATCHED_WORKSPACES`.** Rejected for now: the distribution manifest is reviewed data, and generating part of it would move a reviewed decision into a build step. The check makes the list self-correcting without generating it.

**Publish a new distribution version for the additions only.** Rejected: `profile.overrides` is the distribution's own field, so the entries and the packages they name ship together in the next Plus release.

## Risks

**A new source patch still needs two hand edits.** The check reports a missing override but not a missing `PATCHED_WORKSPACES` entry that no patch introduces yet; the patch author adds both, and the gate fails loudly when only one lands.

**The override pins a version.** `0.1.6-alpha.2` appears in every entry, so a republish under a new version needs them all updated. `verify-plus-governance` compares the profile dependency set, which is a related but different field.

**Consumers on an older Plus release keep the gap.** The fix reaches them when they upgrade; nothing retroactively adds the patches to a release already published.
