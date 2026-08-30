---
description: "The official MCP client behavior with per-request credential-backed Bearer authentication for Streamable HTTP."
kind: "package-reference"
---

# @sparkelf/dsh-plugin-mcp-credentials

English | [中文](README.zh.md)

## Summary

This Host plugin preserves official MCP connection, reconnect, tool publication, image-result, and lifecycle behavior while adding one Streamable HTTP option: `bearerTokenRef`. The transport resolves that DSH credential immediately before every network request and sends the current value as the Bearer token.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use the same stdio or `streamable-http` configuration as the official MCP client. For credential-backed HTTP, set `bearerTokenRef` and compose Credentials; literal `headers.Authorization` and `bearerTokenRef` are mutually exclusive. DataOps mounts this plugin internally so token rotation reaches the next MCP request without a profile remount.

-----

<a id="model-experience"></a>
## Model Experience

### Credential-backed MCP transport

#### What the model sees

The model sees only current namespaced MCP tool schemas authenticated through `bearerTokenRef` and their results. Credential references and values never appear in tool arguments, results, prompts, Session events, manifests, or deployment locks.

#### Token effect

Authentication adds zero tokens. MCP tool schemas and calls retain the token effects owned by the upstream MCP client.

#### KV Cache effect

Credential rotation does not alter model-visible schemas. Tool discovery or connection loss may add or remove schemas and therefore change the tool prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Bearer authentication only**: other HTTP authorization schemes require a proven provider extension point; profile files must not carry literal secret headers.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers, click to expand</summary>

This Dev Note is working context for maintainers; shipped behavior, limits, and rationale live in the sections above, the package code, and the linked Agent Note.

- `src/index.ts` owns credential resolution and MCP transport composition. The [distribution Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-ranged-plus-patchset-distribution.md) records why this is a complete internal DataOps dependency.

</details>
