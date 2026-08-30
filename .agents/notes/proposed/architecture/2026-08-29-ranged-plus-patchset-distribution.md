# Agent Note: Capability-equivalent Plus npm distribution

Status: proposed

English | [中文](2026-08-29-ranged-plus-patchset-distribution.zh.md)

## Problem

Accepted Plus production combines official DSH behavior, complete user capabilities, product defaults, external plugins, temporary source repairs, and optional Desktop deployment behavior in one tree. Installing a settings-only package or replaying selected fork commits cannot reproduce that product and can silently omit official capabilities such as Agent Teams UI and Turn folding. Official DSH must remain the only source base, and every accepted difference needs one current owner before candidate verification.

## Proposal

Use three delivery forms only. A complete user capability is one npm-installable Cordis plugin closure containing every required Host and Client role, provider, persistence rule, profile face, and locale. `@sparkelf/dsh-plus` owns only dependency closure, ordered profile composition, defaults, enablement, compatibility metadata, and references to independent patch packages. A proven gap in official DSH or an external package becomes one data-only npm patch package with one exact payload variant and retirement lifecycle; patch packages contain no JavaScript entry, lifecycle script, Cordis plugin, fallback, or compatibility adapter.

The primary materialization path is independent of Desktop and tray applications:

```bash
dsh plugin --profile plus add @sparkelf/dsh-plus
dsh plugin --profile plus exec dsh-plus apply --dsh-root <official-dsh-root>
dsh --profile plus
```

`dsh-plus apply` resolves installed patch-package manifests, requires official source revision `cd5ef8148158c3a752a658978873241fdf8e2bbc`, installs the profile-owned `dsh-better-sidebar@0.17.1` dependency with the explicit `node-pty` build permission, links the profile's official package scope to the exact source checkout, copies selected payloads into the profile, configures exact npm patches, applies exact source patches, and writes the credential-free `.dsh-plus/patchset.lock.json`. The `plus` release family discovers the complete `@sparkelf` closure, assigns one `plus-npm-v*` tag, canonicalizes packed manifest object keys, and publishes the exact tarballs produced twice and byte-compared by the credential-free pack job through the manual npm workflow. The manual publication audit then requires all 15 registry entries to be public and compares every extracted registry file with that release artifact. Desktop and tray applications may call the same public workflow but are not prerequisites, manifest owners, release owners, or acceptance paths.

## Final inventory

Complete capability packages are `@sparkelf/dsh-plugin-backup`, `@sparkelf/dsh-plugin-subagent-settings`, `@sparkelf/dsh-plugin-document-attachments`, `@sparkelf/dsh-plugin-dataops`, and its internally mounted `@sparkelf/dsh-plugin-mcp-credentials` dependency. Backup owns streamed export/import progress, validation before mutation, retry and reload UI, and Session/Workspace restoration. Document attachments own wire admission, parser/provider behavior, durable model text, browser transport, one mixed draft transaction, cards, and locale. Subagent Settings owns persisted execution settings and browser UI. DataOps and MCP credentials each keep complete runtime ownership in their package. DataOps follows the current service access-only delegated grant: it stores one access credential and stable target identity, and an expired or browser-session-revoked delegated grant raises a DataOps-owned DSH shell modal whose user action opens the real OAuth popup, while Settings keeps the same distinct recovery state. MCP authentication rejection remains a tool error inside the current agent turn rather than terminating the task; an operation with an unconfirmed result is not replayed automatically. Plus does not invent a refresh credential, refresh timer, or grant type that the DataOps authorization server does not expose.

Independent official-source patch packages are `@sparkelf/dsh-patch-workspace-storage-restore`, `@sparkelf/dsh-patch-subagent-settings-presets`, `@sparkelf/dsh-patch-document-attachments`, `@sparkelf/dsh-patch-responses-reasoning-status`, `@sparkelf/dsh-patch-mobile-web-layout`, and `@sparkelf/dsh-patch-web-base-path`. The Document patch contains only generic file-object, durable content, prepared prompt, model projection, mixed draft, Host limit, and nested presentation integration points. The Responses patch is the targeted pi-ai and Models editor compatibility repair for gateways that reject replayed reasoning `status`.

External packages remain `dsh-better-sidebar`, `@sparkelf/dsh-mobile-bridge`, `dshmarket`, and `@changfenhuang/dsh-genui`; their independent patches are `@sparkelf/dsh-patch-better-sidebar-app-frame`, `@sparkelf/dsh-patch-genui-streaming-echart`, and `@sparkelf/dsh-patch-mobile-bridge-serialized-actions`. GenUI owns the model-taught `dsh-ui` surface and inline interactive chart rendering; Plus does not retain a local Chart package or `render_chart` tool. The exact-version GenUI patch retires when [upstream PR #87](https://github.com/omdsh-dev/dsh-genui/pull/87) ships in npm and the real inline-chart path passes. Curation owns every external/source patch retirement condition exactly once.

Official DSH is inherited without a Plus package or patch for Welcome onboarding, home-path display, code-dispatch spill, ask-user card collapse, Turn folding, Workspace picker, Session export UI, creator guidance, durable image intake/storage/model projection, and `read_image` dimensions. Evidence of official equivalence deletes the proposed Plus owner immediately. Agent Teams is not part of the tracked accepted composition: its official service, tools, Client UI, and Web profile packages are private experimental workspaces excluded from release families and disabled by shipped profiles.

## Package and copy ownership

Runtime and peer manifests use minimum-only ranges except that the profile-owned Better Sidebar dependency and its native build permission are exact security inputs to materialization; the deployment lock records the resolved DSH, distribution, plugin, patch-package, target, variant, payload, profile dependency, and build-permission facts. Credential values, settings, Session data, prompts, and model output never enter that lock. Product copy stays with the capability or targeted patch that implements the behavior; there is no generic Plus locale plugin.

The Backup-specific note `2026-08-30-plus-backup-plugin.md` remains active for archive, route, restore, and progress details. This note owns only the complete distribution forms, final inventory, materialization path, and deletion rule.

## Deletion rule

Review deletes any package, patch, field, UI state, test, or document that lacks a current accepted workflow, duplicates official behavior, or creates old/new runtime paths. The implementation retains no accepted-fork fallback, fuzzy patching, automatic promotion, dual daemon, runtime v5, empty package, inline patch compatibility, or speculative framework.

## Verification

Candidate verification starts from an official DSH installation, installs the npm/profile closure, runs explicit apply, and uses an isolated home and `3081/3083`. Real Playwright UI acceptance covers Backup export/import/progress/retry/restoration, Subagent Settings persistence and execution, Document intake/history/model use, DataOps/chart, external plugins, and official Turn folding. Browser diagnostics capture page errors, console errors, failed requests, CORS failures, and stalls. Production `3080` and `/root/.dsh` remain untouched until explicit user acceptance.

## Alternatives considered

**Keep payloads and capability code inside `@sparkelf/dsh-plus`.** Rejected because unrelated compatibility repairs would share one lifecycle and incomplete Host/Client roles would be easy to miss.

**Make Desktop the materializer or acceptance owner.** Rejected because npm/profile composition is the product contract; Desktop is only an optional installer convenience.

**Create one patch per source file or retain selective fork commits.** Rejected because package boundaries follow user capability or retirement lifecycle, while selected commits preserve the fork as an implicit second source base.

## Acceptance criteria

- Installing `@sparkelf/dsh-plus`, running explicit apply against the exact official source, and launching `dsh --profile plus` materializes the complete selected runtime closure and credential-free deployment lock without Desktop or tray ownership.
- Governance classifies every accepted capability, external package, and temporary repair exactly once; unsupported compatibility, Agent Teams, fuzzy patching, and accepted-fork fallback remain absent.
- Real Plus Web acceptance completes through UI operations against real Host, MinerU, model, and DataOps services; DataOps authorization uses an authenticated account in the external DataOps Web UI.
- Production `3080` and `/root/.dsh` remain unchanged until explicit user acceptance and promotion.

## Risks

A future DSH release may accept an exact patch while changing surrounding runtime semantics. Exact base revision checks, loud application failure, isolated materialization, real UI verification, and one curation retirement owner constrain that risk. The final inventory can still miss a hidden accepted delta; review therefore checks production source, notes, profiles, locales, external manifests, and UI paths before declaring zero unclassified differences.
