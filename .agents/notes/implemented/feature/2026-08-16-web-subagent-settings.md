# Agent Note: Live Web settings for shipped subagent entries

Status: implemented

English | [中文](2026-08-16-web-subagent-settings.zh.md)

## Problem

The Web deployment contains two concrete delegation entries, but their existing child-default fields were only configurable in composition text. A browser page that copied those values into unrelated product settings would look configurable while leaving child creation unchanged.

The Web overlay also disabled both entries. Disabled plugins cannot register their own settings namespaces, so the page could not identify a real entry or persist values that its executor reads.

## Decision

`dsh-tool-subagent` accepts an optional `settingsNamespace`. When present, it registers the existing `agentOptions`, `persona`, `toolFilter`, and `maxDepth` fields with the settings service. Its request builder reads that resolved source for every new child start. The configured provider validates capabilities when it mounts and when a saved settings value changes.

The Web base composition assigns `subagent` to the existing spawn/continuable entry and `subagent-fork` to the existing fork/one-shot entry. Both entries remain mounted so their settings namespaces exist in the Host. The host explicitly exposes those names, and `ui-settings-plugins` renders their shared subagent card in the existing Plugins settings tab.

The card shows the two shipped entries by name and keeps the editor focused on their existing child-default fields. Provider binding, tool name, background mode, and entry identity remain composition choices rather than browser-editable fields.

## Alternatives considered

**Create Web-only child profiles.** Profiles, summaries, selective parent context, and named reviewer roles have no current `dsh-tool-subagent` field or executor behavior. Presenting them would create options that cannot affect a child request.

**Expose one generic form for every provider.** External providers can omit persona, tool filtering, or depth enforcement. The first page targets the two shipped in-process entries, whose capabilities are known; a generic provider directory requires capability-driven UI treatment.

**Allow the browser to change entry identity.** Changing a provider, tool name, or continuation policy changes routing and model-visible behavior. Those choices remain composition configuration, while live settings alter only the existing child defaults.

## Consequences

Saving a child default applies to later child runs and leaves an already-created child unchanged. A model override may be omitted to inherit the parent while still setting an output-token cap. A persona omits to preserve the deployment role, and tool visibility remains a trusted-process composition restriction rather than an authority system.

The plugin card does not add task summaries, selective history inheritance, automatic model selection, budgets, or built-in child roles. Future provider entries need capability gating before they appear in the same card.
