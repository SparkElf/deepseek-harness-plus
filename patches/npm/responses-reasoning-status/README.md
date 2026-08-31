# @sparkelf/dsh-patch-responses-reasoning-status

English | [中文](README.zh.md)

This data-only package adds one explicit `llm-pi-ai` route option for OpenAI Responses gateways that accept replayed reasoning input items but reject their response-only `status` field. `responsesCompatibility.omitReasoningInputStatus: true` is accepted only with `api: openai-responses`; after pi-ai serializes the complete request, the adapter removes `status` only from top-level `type: reasoning` input items. Assistant messages, tool items, and every other field remain unchanged.

The official Models editor shows a localized **Gateway compatibility mode** checkbox only for pi-ai routes whose effective protocol is `openai-responses`. User-layer disablement deletes the leaf unless an inherited true requires an explicit false, and changing protocol removes or masks the incompatible setting without replacing sibling fields.

The target is exact official source revision `0a53fb55bea101816fa226bb964ae2bed71c343b`. This package has no JavaScript entry, lifecycle script, Cordis plugin, fallback, or alternate variant. Retire it when official DSH ships equivalent pi-ai Responses input adjustment and Models editor behavior.
