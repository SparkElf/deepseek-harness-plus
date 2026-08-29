---
description: "DataOps target identity, browser PKCE authorization, credential lifecycle, authenticated MCP composition, and Settings UI."
kind: "package-reference"
---

# @sparkelf/dsh-plugin-dataops

English | [中文](README.zh.md)

## Summary

This complete Host and Client plugin owns one DataOps target identity, browser Authorization Code with PKCE, access and refresh credential lifecycle, authenticated MCP child composition, and a localized Settings section. Privileged local routes apply official Connection rejection before request inspection; the callback also requires one-use PKCE state.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Set `DSH_DATAOPS_BASE_URL` to the DataOps Web origin that serves both `/auth/dsh/authorize` and proxied `/api`; `DSH_DATAOPS_CALLBACK_ORIGIN` optionally names a non-loopback DSH browser origin. The package stores access, refresh, and stable target values under `dataops_access_token`, `dataops_refresh_token`, and `dataops_target_ref`. Disconnect revokes account tokens but retains target identity.

-----

<a id="model-experience"></a>
## Model Experience

### Authorized DataOps MCP tools

#### What the model sees

After authorization, the model sees the DataOps server current tool schemas under the `dataops` namespace and the upstream MCP tool results. OAuth state, account data, target metadata, and token values never enter model context.

#### Token effect

Connected tool schemas add their current prefix cost, and calls add upstream arguments and results. OAuth and credential operations add zero model tokens.

#### KV Cache effect

Connecting, disconnecting, or MCP discovery changes can alter the tool-schema prefix. Stable connected operation adds no OAuth or token metadata to that prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **External authenticated account required**: the DataOps deployment must implement the DSH authorization and MCP endpoints and present an authenticated user session; this package provides no fallback token grant or login credential.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers, click to expand</summary>

This Dev Note is working context for maintainers; shipped behavior, limits, and rationale live in the sections above, the package code, and the linked Agent Note.

- `src/index.ts` owns authorization, credentials, and MCP child lifecycle; `src/client` owns Settings. The [distribution Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-ranged-plus-patchset-distribution.md) records the package boundary.

</details>
