---
description: "The npm-installable DeepSeek Harness Plus profile composition and explicit official-source materializer."
kind: "package-bundle"
---

# @sparkelf/dsh-plus

English | [中文](README.zh.md)

## Summary

This distribution composes official `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` with selected Office, MinerU, mobile, market, GenUI, and Supervisor packages, four in-repository Plus capability packages, and twelve independent patch packages. It owns only ordered composition, minimum compatibility metadata, dependency closure, explicit materialization, and the credential-free deployment lock; capability behavior and patch payloads stay in their owning packages.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install and materialize Plus without Desktop or the tray:

```bash
dsh plugin --profile plus add @sparkelf/dsh-plus
dsh plugin --profile plus exec dsh-plus apply --dsh-root /path/to/official-dsh
dsh --profile plus
```

The explicit rc23 apply step requires official revision `5dda764ed3aa172535a7967b06ff95d9cbfe536a`, applies every pending source payload, configures exact npm patches, removes retired Plus-owned entries, and writes `.dsh-plus/patchset.lock.json` with mode `0600`. Patched official source workspaces always replace clean CLI packages in the profile scope. The profile resolves SQL Workbench 0.5.0, Workbench Vault 0.1.1, SSH Manager 0.7.0, API Client 0.5.0, Supervisor 0.1.4, GenUI 0.9.8, dshmarket 1.45.1, OfficeCLI 0.1.1, MinerU 0.1.1, and Mobile Bridge 0.2.11 from npm. Version conflicts, source mismatches, missing bundles, and runtime closure drift stop promotion.

Official DSH supplies Sidebar navigation, file and text preview, Session search, generic file upload, durable attachment cards, read-only model paths, onboarding, Workspace selection, Session export, and Turn folding. Plus configures the official SQLite Session query provider to open on first search with a durable derived index at `$DSH_HOME/storages/session-query.sqlite`; canonical compressed JSONL remains the history source. Plus adds an OfficeCLI tool for original DOCX/XLSX/PPTX production and a MinerU PDF tool that consumes the official uploaded-file path without a prompt hook. It replaces mixed English `Session` wording in the Simplified-Chinese export UI, places the desktop Session-log action immediately before Trajectory search while retaining its Header position on phones, and keeps composer permission and model popovers inside the center column with 12px horizontal clearance. `@changfenhuang/dsh-genui@0.9.8` now contains the previously patched streaming EChart behavior. The registry-pinned Supervisor manages the materialized runtime and restores Sessions interrupted by its own restart. DataOps and MinerU mount only when their endpoint environment variables exist. Agent Teams remains excluded because official shipped profiles disable those private experimental packages.

Plus explicitly selects `browserAuthentication: disabled`: its Web URL is clean and opens without a process-token exchange or browser cookie, while Connection still applies the official Host/Origin trust fence. Every process that can reach an accepted authority can therefore use the complete Host API, including Shell, files, and Sessions. The official `web` profile keeps the upstream `required` default; only the Plus composition opts out.

-----

<a id="model-experience"></a>
## Model Experience

### Profile composition

#### What the model sees

Nothing directly. `@sparkelf/dsh-plus` registers no tool, prompt section, model-facing Session event, or provider content; each selected capability owns its own model-visible behavior.

#### Token effect

Zero by itself. Token use comes only from the capability and official packages selected by the profile.

#### KV Cache effect

Independent by itself. The profile changes a request prefix only when one of its selected packages contributes or removes model-visible content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Exact source target**: source payloads apply only to the recorded official revision; another source tree fails loudly, and the distribution provides no accepted-fork or fuzzy-apply fallback.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers, click to expand</summary>

This Dev Note is working context for maintainers; shipped behavior, limits, and rationale live in the sections above, the package code, and the linked Agent Note.

- The [distribution Agent Note](../../../.agents/notes/implemented/architecture/2026-08-29-ranged-plus-patchset-distribution.md) owns package forms, inventory, materialization, and deletion rules; `src/apply.ts` and `cordis.patch.yml` own the executable profile behavior.
- No runtime invariant companion is published because profile and patchset validity is checked before materialization and the bundle owns no independent runtime observation.

</details>
