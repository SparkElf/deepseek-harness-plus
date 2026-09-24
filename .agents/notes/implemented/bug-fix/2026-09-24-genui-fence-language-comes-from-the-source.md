# Agent Note: the host drops the fence language label, so the renderer reads the source

Status: implemented

English | [中文](2026-09-24-genui-fence-language-comes-from-the-source.zh.md)

## Problem

Every `dsh-ui` fence in the 3080 deployment rendered as a raw JSON code block after the runtime moved to official DSH 0.1.7-rc.1. The plugin was mounted and its client half booted (`[genui] client active; fence-channel=dom`), so the failure looked like a GenUI defect; it was a host markup change that the pinned renderer could not see.

Official 0.1.7-rc.1 renders every markdown fence through the new `CodeToolbar`. That component prints the language only when it can highlight it:

```tsx ignore-check
<span>{supportsHighlighting(lang) ? lang : labels.codeLabel}</span>
```

`dsh-ui` is not a highlighting grammar, so the banner printed the localized `codeBlock.title` — 「代码块」 / "Code block" — where 0.1.6-alpha.2 printed `{lang ?? ''}`. The label was the only channel the DOM renderer had: `@changfenhuang/dsh-genui@0.11.0` discovers fences by finding a leaf element whose trimmed text is exactly `dsh-ui`, so the renamed label made every fence invisible to it. The stock block stayed visible and the JSON body stayed readable, which is why the defect presented as "GenUI stopped working" rather than as a markup mismatch.

## Decision

Upgrade the curated renderer to `@changfenhuang/dsh-genui@0.11.1` and keep the pin in the distribution, where every consumer of it moves together.

0.11.1 restores the fence language from the host's public chat snapshot instead of from banner text. It binds the conversation target through the `uiConversation` service, walks the assistant step's blocks, and reads the code block's own `lang` at the fence's ordinal:

```ts
const node = snapshot?.nodes.get(nodeKey)
if (node?.kind !== 'assistant-step') return undefined
return sourceFencesOfAssistant(node.data.blocks)[ordinal]?.lang
```

The snapshot is the authoritative source for what the model wrote, so the label stops being the interface between the host and the renderer. The DOM channel keeps working as the fallback for hosts without `registerFenceRenderer`, which is the channel this deployment uses: the plugin reports `fence-channel=dom` because official DSH does not expose the fence registry yet.

Three facts fix the change in the repository rather than only in the running profile:

| Place | Fact |
|---|---|
| `dshPlus.profile.dependencies` in `packages/bundle/plus/package.json` | the reviewed renderer version every consumer receives |
| `expectedProfileDependencies` in `scripts/verify-plus-governance.ts` | the gate's copy of that same reviewed set |
| both generated standalone manifests | the version an npm install resolves, plus the peer overrides it needs |

## Findings this change rests on

1. **The failing label is host markup, not plugin state.** The banner in the deployed DOM reads 「代码块」, and `supportsHighlighting` resolves through one alias map that has no `dsh-ui` entry. The old host's banner printed the info string literally, so the same plugin worked against 0.1.6-alpha.2 — the regression arrived with the runtime, not with the renderer.

2. **The renderer reports which channel it bound.** `[genui] client active; fence-channel=registry` versus `dom` separates "the host gave us a fence registry" from "we are scanning markup". This deployment logs `dom`, so the fix had to restore markup-independent discovery rather than adopt a registry API the host does not ship.

3. **The upgraded renderer claims the fence and hides the stock block.** Measured in a headless browser against this deployment: `.md-code-block` computes to `display: none`, a `genui-dom-fence` container is 781×207 and visible, and the `data-genui` React root holds the callout's title and body. Before the upgrade the same element was the raw JSON fence.

4. **The old pin declared peers the runtime cannot satisfy.** 0.11.0 declared `^0.1.2-rc.1 || ^0.1.5-alpha.1`, which does not admit 0.1.7-rc.1, so the generated manifests carried 17 per-package `peerOverrides` whose only reason was that range. 0.11.1 declares `^0.1.7-alpha.1` among its ranges, satisfies the runtime directly, and those 17 entries disappear on regeneration. The remaining 23 overrides belong to other plugins (`dsh-sql-workbench`, `dsh-better-sidebar`, the supervisor, the SSH manager, MinerU, the office viewer fonts, computer-use), so the generation is a real derivation rather than a hand-edited list.

5. **A profile writer lock survived its owner.** The profile held a `package.json.lock` naming a PID that no longer existed, and `withFileLock` never removes an existing lock — orphan recovery is an operator action. Any later profile write would have waited out its 120s deadline and failed. The lock was removed after confirming the PID was dead, and the profile was backed up first.

6. **The upgrade reached the running server without a restart.** `client-hmr` stat-polls each graph row's client bundle and republishes on a metadata change, so the freshly installed bundle was served on the next request. The continued health checks confirm the transport: HTTP 200, `CLIENT-VERIFY: OK` across 75 client modules, and a WebSocket 101 handshake.

## Alternatives considered

**Patch the host to print the info string again.** Rejected: it restores a cosmetic label to serve one plugin's discovery heuristic, and it re-introduces the label as the interface between host and renderer, which is what broke.

**Pin 0.11.0 and add a patch that teaches it the new label.** Rejected: the upstream project fixed this defect in 0.11.1 with a source-backed mechanism, so a local patch would add a second, narrower implementation of the same discovery and then have to retire when the pin moves.

**Upgrade only the running profile and leave the repository pins.** Rejected: the distribution owns the reviewed version, so the next rebuild from source would reinstall 0.11.0 and silently restore the defect. The gate's `expectedProfileDependencies` would also stop matching the distribution.

**Move the pin in `.agents/plugins/curated.yaml` too.** Rejected: that field is not maintained in lockstep with the profile — MinerU and officecli already differ between the two, and GenUI's own entry still reads 0.9.8 — so touching only this entry would make the manifest look authoritative about one package while staying stale about the rest. Reconciling that field is a separate change.

## Consequences

- `dsh-ui` fences render again on the 3080 deployment, verified end to end in a real browser rather than by inspecting markup alone.
- The renderer's fence discovery no longer depends on host banner text, so a future host release that renames or hides the label degrades to the snapshot path instead of to a raw code block.
- The generated standalone manifests lose 17 peer overrides, and regenerating them is what proves it: `verify:standalone-manifest` and `verify:standalone-variants` both pass.
- `@sparkelf/dsh-mobile-bridge@0.2.12` still declares `0.1.5-rc.2` peers and keeps warning at startup. It is unrelated to fence rendering and stays out of this change.
- The profile's installed tree now has 0.11.1 while a machine that never reinstalls keeps 0.11.0 until its next profile install.
