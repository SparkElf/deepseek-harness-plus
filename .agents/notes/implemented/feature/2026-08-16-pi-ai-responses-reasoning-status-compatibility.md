# Agent Note: OpenAI Responses Reasoning-Status Compatibility

Status: implemented

English | [中文](2026-08-16-pi-ai-responses-reasoning-status-compatibility.zh.md)

## Problem

OpenAI Responses output reasoning items may carry a response-side `status` field, and pi-ai preserves the complete item as a signature so later requests can replay provider-native reasoning. Some OpenAI-compatible gateways accept reasoning replay but reject that field when the item returns under `input`, failing every continuation with `input[n].status unknown_parameter`. A new session works until it contains affected history, while a long session can no longer advance.

The field cannot be removed globally. Assistant `message` items and tool-search items also carry `status`, and gateway probes accept message status. The observed failing item was specifically `type: reasoning`; recursive deletion would alter unrelated protocol metadata without evidence.

## Decision

`PiAiProviderProfile` adds `responsesCompatibility.omitReasoningInputStatus`, defaulting off. Enabling it requires an explicit `api: openai-responses` route because this adjustment belongs to that wire protocol and a catalog route without an API override can contain models with different protocols.

The adapter supplies pi-ai's supported `onPayload` callback only for an enabled route. pi-ai calls this after constructing the complete Responses request and before the OpenAI SDK sends it. The callback shallow-copies the request and its `input` array, removes an own `status` property only from top-level `type: reasoning` items, and leaves message, tool, content, ordering, ids, and all other request fields unchanged. If no matching item exists, it returns no replacement payload.

The Models settings editor shows one binary control inside Custom settings only when the pi-ai route's effective protocol is exactly `openai-responses`. It writes the nested field through the existing path-operation flow and removes the leaf when disabled, preserving every profile field the card does not own.

## Alternatives considered

- **Switch the route to Chat Completions.** Rejected because it changes the provider protocol, replay representation, and cache behavior instead of correcting the one incompatible Responses field.
- **Strip every `status` recursively.** Rejected because accepted assistant and tool metadata would change without a demonstrated gateway requirement.
- **Rewrite durable replay state.** Rejected because the stored state is a lossless record of the provider response; compatibility belongs to the outbound route and must remain reversible per provider.
- **Always omit reasoning status.** Rejected because the OpenAI Responses schema accepts it and existing compliant endpoints must retain byte-compatible default requests.

## Consequences

Existing routes are unchanged until the option is enabled. An enabled route can continue native Responses sessions through a narrower gateway while retaining reasoning ids, summaries, encrypted content, assistant message status, and tool history. Enabling the option changes historical request JSON, so the first compatible request may miss a cache prefix created from the unadjusted representation; subsequent cache reuse remains provider-owned.

The feature adds no prompt text, session event, or durable format. Configuration validation, the adapter request test, the real Loader composition, and the Models settings flow own regression evidence. A reconstruction of the reported long session produced 492 Responses input items; the adjustment removed status from 105 reasoning items, preserved 114 assistant message statuses, and the upstream completed the request.
