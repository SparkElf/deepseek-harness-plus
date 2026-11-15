# Agent Note: A model must be able to pin or drop `reasoning.summary`

Status: proposed

English | [中文](2026-11-16-reasoning-summary-must-be-model-configurable.zh.md)

## Problem

DashScope's OpenAI-Responses-compatible endpoint serves `deepseek-v4.1-flash`
and `deepseek-v4.1-flash-1017`, but refuses every request that carries
`reasoning.summary`. It accepts the field's three documented spellings
(`auto`, `concise`, `detailed`) and then fails the reply with

```
<400> InternalError.Algo.InvalidParameter: 'thinking_display=summarized'
is not supported by this model
```

— DashScope translates `reasoning.summary` into its own `thinking_display`
field and reports the translated value as unsupported. Measured against the
live endpoint on 2026-11-15: `reasoning: {effort: "max"}` alone answers 200
with a complete `reasoning` item; adding any `summary` value fails the whole
reply. The same endpoint accepts `thinking_display=summarized` on
`/responses`, so the rejection is specific to the summary translation, not to
thinking display in general.

`pi-ai` writes the field unconditionally whenever a Responses model reasons
(`summary: options?.reasoningSummary || 'auto'` in its `openai-responses`
adapter). A route that declares `reasoningEfforts` for such a model therefore
cannot complete a single turn: the model is unusable rather than merely less
verbose. No existing `compat` switch reaches this field — all 24 fields of
`PiAiCompatProfile` were checked, and the adapter's `summary` default is not
one of them.

The three configuration-only escapes each cost something the deployment
cannot give up:

- Dropping `reasoningEfforts` disables thinking. The model is wanted for its
  reasoning.
- Switching to `deepseek-v4-pro` keeps reasoning but changes the model. The
  pin is deliberate.
- Patching the field out of the `pi-ai` adapter affects every Responses model
  on every route, including the ones whose gateways accept `reasoning.summary`.

## Proposal

Add `reasoningSummary` to a model entry, alongside `compat`:

```yaml
- id: deepseek-v4.1-flash-1017
  reasoningSummary: omit        # or auto | concise | detailed
```

`omit` removes the field from the request body; naming a spelling pins it.
Absent keeps `pi-ai`'s own default, so every existing route is unaffected.

The value reaches the wire through the payload hook `pi-ai` already offers and
this package already uses for `responsesCompatibility.omitReasoningInputStatus`.
`payloadOptions` composes both adjustments into one `onPayload` function
instead of letting either replace the other, because `onPayload` is a single
function field.

The switch is model-level, not route-level, because the refusal is a model
fact: other models on the same DashScope route (`deepseek-v4-pro`,
`qwen3.8-max`, `glm-5.3`) accept `reasoning.summary` and must keep sending it.

## Consequences

- A gateway that rejects `reasoning.summary` becomes usable with reasoning
  intact, at the cost of the summary text.
- `PiAiReasoningSummary` is a drift gate over `REASONING_SUMMARY_GATE`, so a
  new upstream spelling fails compilation until it is classified — the same
  pattern `MODALITIES` and `THINKING_LEVELS` already use.
- The field is carried on the materialized model rather than the route
  profile, so `resolveModel` spreads it into the descriptor and the adapter
  reads it per call.
- The switch ships inside `responses-reasoning-status.patch` rather than a
  patch of its own. The apply step requires every `dsh-source` entry to pass
  `git apply --check` against the base tree on its own, and a separate entry
  cannot: its final hunk rewrites the `profileOptions` return object that patch
  had already edited, so the check found context the base tree lacks and
  aborted the run before any patch landed. Both concerns are responses-gateway
  compatibility, so one patch is the right home.

## Relation to existing notes

[pi-ai upgrade compatibility](../../implemented/bug-fix/2026-09-05-pi-ai-upgrade-compatibility.md)
classifies which `compat` fields are deployment-owned versus catalog-owned.
This note adds a setting that is deliberately *not* a member of
`PiAiCompatProfile`: the refusal is a per-model gateway fact, and a route-level
compat field would land it on sibling models that accept the field. The two
notes answer different questions and neither supersedes the other.

## Alternatives considered

**Disable `reasoningEfforts` on the affected model.** Rejected: it makes the
model answer without thinking, and the model is pinned for its reasoning.
`pi-ai` only writes `reasoning.summary` inside the `model.reasoning` branch, so
this works mechanically but gives up the capability the deployment wants.

**Switch the route to a model that accepts the field.** Rejected:
`deepseek-v4-pro` and `qwen3.8-max` both answer `reasoning.summary` on the same
endpoint, but the model pin is deliberate and a model swap is not a
configuration fix for a gateway defect.

**Delete the `summary` default from the `pi-ai` adapter.** Rejected: it is one
line and the shortest patch, but `pi-ai` is shared by every Responses route, so
it would stop summaries for the gateways that do serve them. It also edits a
vendored dependency for a per-model fact.

**Add the switch to `responsesCompatibility` (route level).** Rejected: that
interface is provider-scoped, so the setting would apply to
`deepseek-v4-pro`, `qwen3.8-max`, and `glm-5.3` on the same route, which accept
`reasoning.summary` today.

## Acceptance criteria

- A model entry declaring `reasoningSummary: omit` sends a request body with no
  `reasoning.summary` key, and the reply still carries a `reasoning` item.
- A model entry declaring `reasoningSummary: concise` sends `summary: concise`.
- A model entry declaring no `reasoningSummary` sends `summary: auto`,
  unchanged from today.
- `responsesCompatibility.omitReasoningInputStatus` and `reasoningSummary`
  compose: a route setting the former and a model setting the latter produce
  one `onPayload` that applies both.
- All 30 `dsh-source` entries pass `git apply --check` on a clean base tree and apply in `patchSet` order.

## Risks

**The two payload adjustments could silently displace each other.**
`onPayload` is a single function field, so assigning both would drop one.
`payloadOptions` composes them into one function and applies each in sequence;
the acceptance criterion above pins that behavior.

**An unknown summary spelling would reach the wire.**
`REASONING_SUMMARY_GATE` rejects an unclassified spelling at compile time, and
the schema rejects one at configuration load, so a typo fails loud rather than
producing a 400 from the gateway mid-turn.
