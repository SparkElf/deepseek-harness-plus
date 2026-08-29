---
description: "The durable render_chart tool and interactive ECharts presentation for one chart-ready result reference."
kind: "package-reference"
---

# @sparkelf/dsh-plugin-chart

English | [中文](README.zh.md)

## Summary

This complete Host and Client plugin owns the `render_chart` tool and its interactive ECharts renderer. One call accepts one opaque DataOps result reference plus a complete JSON-serializable ECharts option; the Host records presentation metadata and a `dsh/chart` content block, and the Client rebuilds the chart from Session history without refetching DataOps.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package once in an Agent-capable profile. Pending, failed, unavailable, and complete calls have visible states; completed charts follow the current theme, resize with their container, and expose the official tool-result inspect action.

-----

<a id="model-experience"></a>
## Model Experience

### `render_chart` tool

#### What the model sees

The model sees one concurrency-safe `render_chart` tool. It must supply exactly one chart-ready `sourceResultRef`, the complete replay option, and an optional title; the compact result confirms provenance and render success.

#### Token effect

The stable tool schema adds prefix tokens while enabled. Each call adds its JSON arguments and compact result to Session history; no second prose copy of the option is injected.

#### KV Cache effect

The tool schema is prefix-stable until the mounted tool set changes. A chart call extends later request history with its recorded call and result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **JSON-only replay**: options may contain only JSON-serializable ECharts data; functions, DOM nodes, external data loaders, and executable formatter callbacks are outside the durable format.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers, click to expand</summary>

This Dev Note is working context for maintainers; shipped behavior, limits, and rationale live in the sections above, the package code, and the linked Agent Note.

- `src/index.ts` owns tool admission and durable metadata; `src/client` owns chart rendering. The [distribution Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-ranged-plus-patchset-distribution.md) records package ownership.

</details>
