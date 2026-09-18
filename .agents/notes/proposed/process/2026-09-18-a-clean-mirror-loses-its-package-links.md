# Agent Note: Rebuild the package links after any operation that cleans the mirror

Status: proposed

English | [中文](2026-09-18-a-clean-mirror-loses-its-package-links.zh.md)

## Problem

Moving the served mirror from dsh 0.1.6-alpha.1 to 0.1.6-alpha.2 produced a service that answered on 3080 while two of its plugins were absent. The startup log reported:

```
dsh: warning: 3 entries did not activate
agent-team (@deepseek-ai/dsh-experimental-agent-team): failed to import
tool-agent-team (@deepseek-ai/dsh-experimental-tool-agent-team): failed to import
```

Both packages resolved from the profile; importing them from the mirror root failed with `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'`. The mirror's `packages/experimental/agent-team/node_modules` did not exist, so the dependency its manifest declares had no link to resolve through.

## Why it happened

**The repository ignores `node_modules/` at the root only.** `.gitignore` line 6 is `node_modules/`, which matches the mirror's top-level directory and nothing under `packages/`. Every workspace's own link directory is therefore untracked and unignored, which is exactly the state `git clean -fd` removes.

**A rebase step ran that clean.** Carrying the three incompatible patches onto alpha.2 required resetting the working tree between attempts, and `git clean -qfd` was the reset. It deleted `packages/*/node_modules` throughout the mirror, including the two Agent Teams packages whose dependency chains are shallow enough to fail loudly.

**Nothing connected the symptom to the cause.** The failure reads as a plugin incompatibility with the new upstream release - the packages exist, the profile declares them, and `pnpm install` had already run. The reinstall that fixes it takes seven seconds.

## Proposal

**Treat the mirror's package links as build output that a clean removes, and re-run the install after any reset.**

1. Never run `git clean -fd` in a mirror. Reset tracked files with `git checkout -- .` and leave untracked directories alone.
2. After any operation that could have removed them, assert that every workspace with dependencies has a `node_modules` directory, and reinstall when one does not.
3. Read startup warnings as a gate result rather than log noise: "N entries did not activate" names packages the deployment claims to mount, and each name is a regression until proven otherwise.

## Findings this change rests on

1. **The ignore rule covers the root only.** `git check-ignore packages/experimental/agent-team/node_modules` exits non-zero, so `git clean -qfd` removes it.
2. **The dependency is upstream's, not the patch set's.** `git show HEAD:packages/experimental/agent-team/package.json` lists `"@deepseek-ai/schemastery": "workspace:^"` at alpha.2, and no patch modifies that manifest.
3. **The profile side was intact throughout.** `profile/node_modules/@deepseek-ai/schemastery` pointed at `vendor/schemastery` and resolved; only the package-local link was missing.
4. **`pnpm install --no-frozen-lockfile` restores them in about seven seconds** and creates all three missing directories.
5. **The plugin mounts correctly once restored.** `--dump-config` lists `agent-team`, `tool-agent-team`, and `ui-agent-team`, with the four `tool-subagent*` entries disabled, which is the Agent Teams profile layer's intended composition.
6. **A commanded restart recovers sessions.** `supervisor reload` reported `sessionsCaptured count=1` then `sessionsRecovered recovered=1, failed=0`.

## Acceptance criteria

- No step in a mirror promotion runs `git clean`.
- A promotion verifies that every workspace declaring dependencies has a link directory before it starts the service.
- Startup "did not activate" entries are compared against the profile's declared bundles, and any name outside the known list fails the promotion.
- Restarts go through the supervisor's own commands, which capture and recover sessions, rather than through `systemctl`.

## Alternatives considered

**Add `node_modules/` without the leading anchor to `.gitignore`.** Rejected as the fix but worth noting: a bare `node_modules/` would make every workspace's link directory ignored, so a clean could not remove them. The mirror is a checkout of upstream, though, and editing its ignore rules would diverge a file the next `git checkout` restores.

**Keep a note to run `pnpm install` after rebases.** Rejected: the check is what makes it a gate rather than a habit, and the habit is what failed here.

**Read the plugins as incompatible with alpha.2.** Rejected by measurement: they import cleanly once the links exist, and `--dump-config` shows the composition the profile layer intends.

## Risks

**The check is per-mirror and slow.** Walking every workspace manifest costs seconds, and it must run against the mirror being promoted rather than a shared list.

**A missing link can also come from a genuinely absent optional dependency.** The check reports the workspace, not the cause, so an operator still has to read the manifest before reinstalling.
