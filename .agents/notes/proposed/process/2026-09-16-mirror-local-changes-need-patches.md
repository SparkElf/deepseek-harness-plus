# Agent Note: A mirror rebuild must carry every local change as a patch

Status: proposed

English | [中文](2026-09-16-mirror-local-changes-need-patches.zh.md)

## Problem

Promoting the 3080 deployment from DSH 0.1.5-rc.2 to 0.1.6-alpha.1 broke "open in file manager" and blanked its icon. Four files carried WSL behaviour that the deployment depended on, and the promotion discarded all four:

```
packages/host/open-in-app/src/icons.ts          WSL icon extraction
packages/host/open-in-app/src/resolver.ts       WSL application resolution
packages/util/native-command/src/index.ts       WSL command dispatch
packages/util/native-command/src/path-opener.ts WSL path translation
```

The promotion rebuilt the runtime mirror with `dsh-plus apply`, which resets the checkout and reapplies the declared patch set. Those four files were **uncommitted working-tree changes**, covered by no patch package, so the reset removed them. The user-visible result was a red "打开失败" toast and a blank icon.

## Why it reached production

Three separate gaps, each sufficient on its own:

**The mirror carried local work no patch described.** A stash titled "mirror local customizations" held nine files. I converted one (`session-format-v0-to-v1/relationships.ts`) into a patch and checked the other eight against the repository, found them present, and concluded they were safe. **That check answered the wrong question.** They were present in the *repository*, but the mirror rebuilds from *patch packages*; a file in the repository with no patch still vanishes. The correct test is whether each local change has a patch that reproduces it, not whether the repository contains something similar.

**The closure gate cannot see a removal.** `verify-plus-profile-upgrade` compares package **fingerprints**. After the reset, `@deepseek-ai/dsh-open-in-app` still exists at the same version with a different fingerprint — and 284 packages already had fingerprint changes for legitimate reasons, so the one that mattered was indistinguishable. Nothing declared "this fingerprint must contain a WSL marker."

**The stale incremental cache hid the missing restore.** After applying the WSL patch back, I rebuilt with `npx tsdown --env.DSH_BUILD_FACE host`. The package's `tsconfig.tsbuildinfo` was from 14:19 while the restored source was from 16:49, so TypeScript considered the output current and the bundled `lib/index.js` kept the pre-patch code. The source contained `wslpath`; the artifact did not. I verified the source and not the artifact.

## Proposal

1. **Before a promotion, enumerate every uncommitted change in the served mirror and require a patch for each.** A change with no patch is a change the promotion will delete. Record the enumeration as the promotion's input, not as a later review.
7. **Verify at the artifact layer, not the source layer.** Grep the built `lib/index.js` for a marker the change writes, and exercise the endpoint or command it serves. A source grep is not evidence about a running deployment.
2. **Delete `tsconfig.tsbuildinfo` before a restore rebuild, or use the deployment's own build command.** An incremental cache dated before the change silently reuses the previous output; the build succeeds and reports nothing.
3. **Give each patch a capability probe.** A patch that restores behaviour should declare a marker string, and the closure gate should require that marker in the candidate fingerprint. An undeclared fingerprint change is then a violation rather than one row among hundreds.
4. **Promote on a staging port first.** The 3081 instance exists for exactly this. Verifying WSL behaviour on 3080 directly means a broken promotion is the user's first signal.

## Acceptance criteria

- The promotion script enumerates uncommitted mirror changes and fails when any has no patch.
- Each behavioural patch declares a probe; the closure gate verifies the marker in the built artifact.
- A restore rebuild runs the deployment's build command after clearing incremental state.
- WSL-dependent behaviour is exercised on the staging port before 3080 is moved.

## Alternatives considered

- **Trust the repository as the record of the mirror's changes.** Rejected: it was true that the files existed in the repository, and the promotion still lost them. Only a patch reproduces a change in a rebuilt mirror.
- **Copy the mirror instead of rebuilding it.** Rejected earlier for size, and it would not have helped: the mirror's revision must move to the new base, so every file changes anyway.

## Risks

- Requiring a probe per patch adds maintenance; a marker that names an internal symbol rather than a stable string will break on minification. Probes should name a path, constant, or literal the code writes.
- Clearing incremental state lengthens every rebuild. Correctness of the served artifact outweighs build time on a promotion path.
