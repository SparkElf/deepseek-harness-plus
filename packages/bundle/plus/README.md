---
description: "The npm-installable DeepSeek Harness Plus profile composition and explicit official-source materializer."
kind: "package-bundle"
---

# @sparkelf/dsh-plus

English | [中文](README.zh.md)

## Summary

This distribution composes official `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` with the selected external sidebar, mobile bridge, plugin market, GenUI and Univer Office packages, five complete Plus capability packages, and sixteen independent patch packages. It owns only ordered composition, minimum compatibility metadata, dependency closure, explicit materialization, and the credential-free deployment lock; capability behavior and patch payloads stay in their owning packages.

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

The explicit apply step requires official revision `0a53fb55bea101816fa226bb964ae2bed71c343b`, materializes every selected runtime package as a profile-direct dependency, applies all pending source payloads together, configures exact npm patches, removes retired Plus-owned entries, and writes `.dsh-plus/patchset.lock.json` with mode `0600`. It installs stable `dsh-better-sidebar@0.17.1`, Office preview `0.1.2`, video preview `0.1.4`, and `dsh-univer-office@0.2.12` at the profile root, applies their exact alpha.2 Settings patches, explicitly allows only the sidebar's `node-pty` native build, and builds the profile's `@deepseek-ai` scope from the exact official dsh CLI dependency tree plus official source workspaces needed by out-of-tree plugin peers. SparkElf-owned external Mobile Bridge `0.2.10` and independently maintained dshmarket `1.38.1` each carry alpha.2 Settings compatibility in their own release, so Plus applies no Mobile Bridge patch. Version conflicts and source mismatches fail before profile installation or source mutation. The package has no install lifecycle script.

Official DSH supplies onboarding, Workspace selection, Session export, Turn folding, and the base image path. Plus builds that source with the official client profile, keeps the attachment chooser directly after the composer command button, adds Better Sidebar previews for Office documents and video, replaces mixed English `Session` wording in the Simplified-Chinese Session export UI, and places the desktop Session-log action immediately before Trajectory search while retaining its Header position on phones. External `dsh-univer-office` owns Agent-authored spreadsheets, documents, presentations, databases, and boards together with its Gateway, Viewer, tools, bundled skills, live worktree window, and review cards; one exact patch directly updates its removed alpha.1 Settings call, evidenced blank optional Tool inputs, and close-safe Viewer collaboration send for alpha.2. The external `@changfenhuang/dsh-genui` bundle owns generated UI, including inline interactive charts emitted by the model as `dsh-ui`. Two exact `0.9.6` patches keep top-level streaming complete, register the bundled `genui` skill, publish the compact chart signature, and reject invalid chart fields; each retires after its upstream behavior ships and the real DataOps chart path passes without it. DataOps and Document Attachments mount only when their endpoint environment variables exist. Agent Teams is excluded because the official packages are private experimental workspaces and shipped profiles disable them.

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

- The [distribution Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-ranged-plus-patchset-distribution.md) owns package forms, inventory, materialization, and deletion rules; `src/apply.ts` and `cordis.patch.yml` own the executable profile behavior.

</details>
