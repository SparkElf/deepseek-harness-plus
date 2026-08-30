---
description: "The npm-installable DeepSeek Harness Plus profile composition and explicit official-source materializer."
kind: "package-bundle"
---

# @sparkelf/dsh-plus

English | [中文](README.zh.md)

## Summary

This distribution composes official `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` with the selected external sidebar, mobile bridge, plugin market, GenUI package, five complete Plus capability packages, and ten independent patch packages. It owns only ordered composition, minimum compatibility metadata, dependency closure, explicit materialization, and the credential-free deployment lock; capability behavior and patch payloads stay in their owning packages.

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

The explicit apply step requires official revision `cd5ef8148158c3a752a658978873241fdf8e2bbc`, materializes every selected runtime package as a profile-direct dependency, applies all pending source payloads together, configures exact npm patches, removes retired Plus-owned entries, and writes `.dsh-plus/patchset.lock.json` with mode `0600`. It installs `dsh-better-sidebar@0.17.1` at the profile root, explicitly allows only its `node-pty` native build, and links the profile's `@deepseek-ai` scope to the exact official dsh CLI dependency tree at `apps/cli/node_modules/@deepseek-ai`. Version conflicts and source mismatches fail before profile installation or source mutation. The package has no install lifecycle script.

Official DSH supplies onboarding, Workspace selection, Session export, Turn folding, and the base image path. The external `@changfenhuang/dsh-genui` bundle owns generated UI, including inline interactive charts emitted by the model as `dsh-ui`. The temporary GenUI streaming EChart patch targets only `0.9.6` and retires after [upstream PR #87](https://github.com/omdsh-dev/dsh-genui/pull/87) ships in npm and the real inline-chart path passes. DataOps and Document Attachments mount only when their endpoint environment variables exist. Agent Teams is excluded because the official packages are private experimental workspaces and shipped profiles disable them.

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
