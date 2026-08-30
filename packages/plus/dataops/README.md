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

Set `DSH_DATAOPS_BASE_URL` to the DataOps Web origin that serves both `/auth/dsh/authorize` and proxied `/api`; `DSH_DATAOPS_CALLBACK_ORIGIN` optionally names a non-loopback DSH browser origin. The package stores the delegated access token and stable target identity under `dataops_access_token` and `dataops_target_ref`; DataOps ties the token lifetime to its authenticated browser session. When the current grant expires or its browser session is revoked, the DataOps Client contribution raises a DSH shell modal with **Later** and **Sign in again**; the latter opens the real OAuth popup from the user gesture. Settings also distinguishes the rejected stored grant from a never-connected state and keeps the same recovery action available. An authentication-rejected MCP call remains an error result inside the agent turn; it does not terminate the task, and Plus does not automatically replay an unconfirmed tool operation. Disconnect revokes account tokens but retains target identity. OAuth callback failures expose only a fixed, actionable stage in Settings; authorization codes, state, tokens, upstream bodies, and arbitrary error text remain outside the browser message.

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

- `src/index.ts` owns authorization, credentials, access expiry, and MCP child lifecycle. `src/client/store.ts` and `src/client/controller.ts` own shared browser status and OAuth lifecycle; `src/client/DataOpsExpiryModal.tsx` contributes the shell prompt and `src/client/DataOpsSection.tsx` contributes Settings. The [distribution Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-ranged-plus-patchset-distribution.md) records the package boundary.

</details>
