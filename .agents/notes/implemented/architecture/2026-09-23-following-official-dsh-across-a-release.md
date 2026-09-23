# Agent Note: following official DSH across a 1461-commit upgrade

Status: implemented

English | [中文](2026-09-23-following-official-dsh-across-a-release.zh.md)

## Problem

Plus distributes fifteen patches against official DSH source. Official published `0.1.7-alpha.2`, 1461 commits past the base those patches were written for. Every patch is a diff whose context lines must match, so a base that moved that far invalidates them together — and the failure is not uniform: measured against the new base, none applied cleanly, eight applied with conflicts under `--3way`, and seven did not apply at all.

A conflict is the dangerous case. `git apply --3way` reports success while leaving both sides' claims in the file, and a mechanical resolution that keeps the patch's side silently deletes whatever official added nearby. Two such deletions were found in this upgrade: official's `OperatorPeer` import in the connection RPC host, and a feedback action in the Session export menu.

## Decision

**Rebase each patch by intent, never by diff; retire the ones whose intent official has adopted.**

Three outcomes are possible for every patch, and the decision is made by reading official's current code before touching the patch:

| Outcome | Condition | Evidence required |
|---|---|---|
| Rewrite | The defect still exists on the new base | the patch's own assertions re-established, with official's neighbours preserved |
| Retire | Official now does what the patch did | the upstream commit that replaced it, and that it is not in the old base |
| Adapt | The mechanism moved | the new location plus the mapping from old to new |

Each rewrite passes three self-checks before it counts: the new patch applies to a clean base, its paths stay inside the package's declared `target.paths`, and every removed line is a line the patch itself intended to remove rather than something official added.

## Findings this change rests on

1. **The base pins live in more places than the distribution.** `compatibility.dsh`, `sourceBase.revision`, each patch package's `dsh` range and `target.baseRevision`, `.agents/plugins/curated.yaml`'s `pinned` fields, and the `--runtime-version` argument in the standalone verification scripts all name the official release. A gate catches a patch that stops applying, but nothing catches a pin left behind, so the upgrade touches them together.
2. **Retiring a patch is a three-part change, not a deletion.** The package directory goes, its `localPatches` entry goes from `curated.yaml`, and its name leaves `profile.bundles` and `profile.dependencies` in the distribution. `verify-plus-governance` reports each omission separately: `curation must own upstream retirement for every source patch package exactly once` for the first, and `dshPlus.profile.dependencies must own the exact reviewed production bundle set` for the second.
3. **Official pre-declares its own retirement conditions.** Both retirements were conditions the patch READMEs already stated: *"Retire it when official DSH ships equivalent end-to-end base-path behavior"* and *"Retire this package when official DSH exposes an equivalent profile-selected browser-authentication policy"*. Reading that line first turns a judgement call into a check.
4. **A gate can validate a patch against the base it names, or discover that a related package does not exist.** The `patchPackages` check materialises each declared base revision and applies the patch to it, which is why a wrong `baseRevision` fails as loudly as a wrong diff.
5. **Republishing is a separate consumer of the same source.** The distribution replaces twenty-seven official packages with builds of its own, and those builds carry the patches. A corrected patch reaches a registry installation only after that package is rebuilt from the patched tree and republished, so an upgrade is not complete when the patches apply — it is complete when the republished packages carry them.
6. **A patch that only a previewer needed retires with the previewer.** Official `0.1.7-alpha.2` renders Office and spreadsheet documents in its own right Sidebar document tab, mounted by `web-app` by default. `@sparkelf/dsh-plugin-better-sidebar-office` previewed those formats for `dsh-better-sidebar`, so the official capability replaced it.
7. **`office-to-pdf` takes absolute font directories, so the government fonts need no patch.** The provider exposes `fontDirectories: string[]` and `fontFallbacks: string[][]`, and reports the families it could not find. Chinese government documents name 方正小标宋 / 仿宋GB2312 / 楷体GB2312 / 黑体, none of which ship with the conversion kit, so the deployment names the directory holding them. A configuration official already owns survives the next upgrade; a patch would not.
8. **A rewrite is not always a rebase; sometimes it is a deletion.** Following alpha.2 to rc.1, 156 commits on, two patches failed and both failed the same way: official had implemented the behavior, so the patch's own implementation no longer composed with it. `wsl-native-open` had installed a PowerShell opener with its own path literal builder; official replaced that with `explorer.exe` and an `explorerTarget()` that encodes a Windows path for Explorer's command-line parsing. Splicing the two together does not compile — each side references helpers the other removed. The patch kept only the capability official still lacks (naming Explorer on the mounted volume when PATH carries no Windows entry) and dropped the rest.

9. **The base pins are a set, and a release that moves the base moves all of them.** Across both upgrades the same seven places named the official version: `compatibility.dsh`, `sourceBase.revision`, each patch package's `dsh` range and `target.baseRevision`, `curated.yaml`'s `pinned` fields, the standalone scripts' `--runtime-version`, and the release-age exemptions. A gate catches a patch that stops applying; nothing catches a pin left behind, so the version bump is only correct when all seven move.

## Alternatives considered

**Apply the patches with `--3way` and keep whatever merges.** Rejected: measured on this upgrade, the silent merges deleted official's `OperatorPeer` and a feedback action. Both compiled; neither was reported.

**Port Plus onto the new official base by re-applying each patch mechanically and fixing only the failures.** Rejected because a patch that applies cleanly is not a patch that is still needed. Four of the fifteen needed only the `dsh` range changed, and one of those — `web-base-path` — had to be retired because official implemented the same behavior differently.

**Keep `web-base-path` and official's document-relative routing.** Rejected: the two are opposite architectures. The patch configures a base path for a prefix-preserving proxy; official strips the prefix at the proxy and resolves from the document directory. Official's note rejects a configured base URL explicitly, and official ships a gate (`verify-client-route-resolution.ts`) that refuses the absolute routes the patch reintroduces.

**Leave the retired patches in the tree with a README note.** Rejected: `verify-plus-governance` walks every directory under `patches/npm` and applies each to its declared base, so a retired patch that stays fails the build.

## Consequences

- Fifteen patches became thirteen rewrites and two retirements; two capabilities moved from patches to official behavior, so they no longer need maintaining.
- The government fonts reach the official conversion by configuration, which is one less patch to carry across future releases.
- A future upgrade repeats this procedure. The expensive part is not the rebase but the reading: each patch's intent must be re-established against official's current code before the diff is touched.
- The republished packages are the remaining half of an upgrade. Until they are rebuilt from the patched tree, a registry installation keeps resolving the previous release's code.
