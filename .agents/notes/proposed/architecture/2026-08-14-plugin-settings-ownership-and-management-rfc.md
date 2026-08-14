# Agent Note: Plugin settings ownership and management RFC

Status: proposed

English | [中文](2026-08-14-plugin-settings-ownership-and-management-rfc.zh.md)

## Problem

Harness configuration is owned by plugins, but users meet it through several different surfaces: model settings, general settings, preset settings, provider-specific sections, and the local YAML document. The UI can show a field from one layer while the runtime reads a value inherited from another layer. A checkbox can therefore describe an absent override instead of the effective model capability.

The web search tool is a concrete example. The shipped composition selects a DeepSeek search provider and its default credential, even when the active agent uses a different provider and model. The user then receives a DeepSeek API-key error for a search operation that should follow the active model route.

The configuration-document action is another example. A browser-hosted Harness can have a local settings document but no desktop opener. The UI currently needs a Host capability fact to avoid presenting an action that can only fail.

## Proposal

### One owner per configuration fact

The plugin that consumes a configuration fact owns its schema, settings namespace, defaults, validation, and effect timing. A settings UI renders the registered descriptor; it does not recreate provider defaults or infer runtime capabilities from labels.

| Fact | Owner | Settings representation |
| --- | --- | --- |
| Provider endpoint, protocol, credential reference | provider plugin | Provider profile in the provider namespace. |
| Model id, context window, output limit, input/output modalities | provider plugin | Model entry inside the provider profile. |
| Default provider and model for new agents | <code>dsh-agent-default-model</code> | <code>agent-default-model</code> namespace. |
| Search request route | web search consumer/provider | Resolved from the current agent model selection; no fixed DeepSeek route in the shipped profile. |
| Whether a native editor can open a document | Host apiproxy | Capability field in <code>settings.describe</code>. |

A consumer may read another plugin's public service, but it must not duplicate that plugin's settings schema or store a second copy of the same fact.

### Effective values and overrides

The settings descriptor exposes resolved values plus the composition base and raw user layer. UI controls follow this precedence:

1. Render the effective value that the runtime reads.
2. Mark a field as inherited when the effective value comes from schema defaults or composition base.
3. Write an override only when the user changes that field.
4. Reset by removing the user-layer path, allowing the effective value to resolve again.

Provider defaults and model entries remain distinct. A model row is the source of truth for model capacities and modalities. A provider-level default may seed a new model, but it must not replace a known model capability when the UI describes that model.

The UI uses compact state indicators and controls. It does not add paragraphs explaining implementation details beside ordinary fields.

### Current-model search

The search tool follows the provider and model selected for the current agent. When a session agent has an explicit route, that route wins; otherwise the runtime default selection supplies the route. The search provider resolves the selected provider profile and its credential reference at operation start.

The first current-route implementation supports an OpenAI Responses profile. It posts the selected model to the configured Responses endpoint with the provider's credential and the built-in web search tool, rejects redirects, and maps URL citations into the web result contract. The existing DeepSeek Anthropic Messages provider remains available for deployments that explicitly select it.

A provider whose protocol has no supported web-search operation returns a stable unavailable error. The search path does not silently substitute a DeepSeek credential or model.

### Host-owned document opening

The settings API reports whether a Host can open a local text document with a native editor. The browser shows the action only when the document exists and the capability is true. The request carries no path; the Host resolves and opens the settings provider's own document.

A headless web process therefore exposes settings editing without a broken native-open button. The desktop manager inherits the platform opener and continues to open the same settings document.

## Ownership map

| Area | Owner | Responsibility in this RFC |
| --- | --- | --- |
| Settings registry | <code>packages/settings/settings</code> | Layer schemas, defaults, user values, revisions, and effect timing. |
| Settings wire and Host capability | <code>packages/host/apiproxy</code> | Redacted descriptors, pathless document open, and native-opener availability. |
| Settings presentation | <code>packages/client/ui-settings-general</code> and provider UI plugins | Render descriptors and effective values without duplicating runtime rules. |
| Model selection | <code>packages/core/agent-default-model</code> and agent-scoped selection | Supply the route used by agents and auxiliary consumers. |
| Search consumer | <code>packages/web/web-search-deepseek</code> | Adapt the current provider/model route or the explicitly selected DeepSeek route. |
| Explicitly untouched | <code>packages/core/agent-loop</code>, session persistence, and attachment storage | No loop protocol or durable session format change is required. |

## Alternatives considered

**A central settings schema owned by the Web UI.** This would make the browser the authority for provider behavior and would drift from headless and desktop composition. Plugin schemas remain authoritative.

**Show only raw YAML.** Raw YAML is useful for advanced users but does not show effective values, credential state, or capability timing. It remains an escape hatch rather than the primary management model.

**Keep search on DeepSeek and only rename the error.** This hides the dependency mismatch and still fails for users who configured another provider. Search must resolve the active route.

**Infer provider capability from the model id.** Model names are not a protocol contract. Capabilities come from the provider's resolved model entry or an explicit adapter declaration.

## Discussion questions

- Should the Settings shell expose every registered namespace automatically, or should each plugin opt into a product-facing section with a declared presentation order?
- Should inherited and overridden states use one shared compact indicator across all provider editors?
- Which provider protocols should implement the current-model search adapter after OpenAI Responses?
- Should a current model with no web-search protocol hide the search tool, or keep the tool and return an explicit unavailable result?
- Which restart-required settings need a single pending-restart indicator in the desktop tray?

## Acceptance criteria

- A settings UI can distinguish an effective model value from an absent user override.
- A search request uses the current agent provider, model, and credential reference, or returns a stable unsupported-route error.
- A headless Host does not advertise a native document action it cannot execute.
- Provider-specific schemas remain the authority for provider and model fields.
- A future Settings shell can add namespaces without moving ownership into the browser.

## Risks

Provider protocols do not share one web-search request format. The current-model adapter must therefore reject unsupported protocols instead of silently falling back to a different credential or model. Native opener capability depends on the real desktop bridge; environment heuristics must not claim support from a kernel label alone.

## Decision boundary

This RFC establishes ownership and data-flow rules. It does not add a universal settings dashboard, migrate every plugin into one screen, or claim that every provider supports web search. Each additional provider adapter and each new settings presentation remains a separately reviewable change.
