---
description: "Settings-backed continuous and one-shot subagent modes with complete Host, startup, and Client ownership."
kind: "package-reference"
---

# @sparkelf/dsh-plugin-subagent-settings

English | [中文](README.zh.md)

## Summary

This complete Host and Client plugin owns the two settings-backed delegation modes in Plus. Its Host root registers model-facing delegation, `/startup` owns the `subagent` and `subagent-fork` Settings namespaces, and the Client presents both modes in one Subagents section. Fresh settings disable both modes with zero nesting; saved changes affect later child starts without rebuilding the Host.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Plus profile mounts two startup rows and redirects the built-in continuous and one-shot preset rows to this package. Continuous mode creates a fresh continuable child; one-shot mode forks completed parent context for one task. Each namespace independently controls enablement, model override, output-token cap, persona, tool visibility, and nesting depth.

-----

<a id="model-experience"></a>
## Model Experience

### Settings-backed delegation tools

#### What the model sees

A disabled mode contributes no schema or prompt section. Continuous mode adds the `subagent` tool and continuable guidance; one-shot mode adds `subagent_fork`. Saved settings affect later children and never rewrite an existing child.

#### Token effect

Enabling a mode adds its stable tool schema and guidance. Child model, persona, and tool choices affect only child requests; tool calls and results follow normal Session history costs.

#### KV Cache effect

Toggling a mode changes the later-request tool prefix. One-shot mode reuses inherited parent history until child-specific prompt and tools are appended.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Temporary preset redirection patch**: official preset documents and the legacy model-selection card expose no runtime replacement API, so a retireable data-only patch redirects two built-in rows and removes the legacy Plus registration.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers, click to expand</summary>

This Dev Note is working context for maintainers; shipped behavior, limits, and rationale live in the sections above, the package code, and the linked Agent Note.

- Host behavior lives under `src`, and the Settings UI lives under `src/client`. The [distribution Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-ranged-plus-patchset-distribution.md) owns package and patch retirement boundaries.

</details>
