# Agent Note: Live Web settings for shipped subagent entries

Status: implemented

English | [中文](2026-08-16-web-subagent-settings.zh.md)

## Problem

The Web deployment contains two concrete delegation entries, but their existing child-default fields were only configurable in composition text. A browser page that copied those values into unrelated product settings would look configurable while leaving child creation unchanged.

The Web overlay also disabled both entries. Disabled plugins cannot register their own settings namespaces, so the page could not identify a real entry or persist values that its executor reads.

## Decision

`dsh-tool-subagent` accepts an optional `settingsNamespace` and reads that Host-registered section for every new child start. Its `/startup` subpath independently owns the Host-lifetime registration of `enabled`, `agentOptions`, `persona`, `toolFilter`, and `maxDepth`. The configured provider validates capabilities when an Agent tool mounts and when the Host owner accepts a saved value.

The Web base composition registers Host-lifetime owners for `subagent` and `subagent-fork`; each Agent preset binds those names to its spawn/continuable and fork/one-shot tools. Settings registration therefore remains singular while tool lifetime follows the preset. The Host serves both registered namespaces, and `ui-settings-plugins` presents them as two tabs in one card under a dedicated Subagents navigation section. The section derives from the browser's shared Settings mirror and replaces only the selected namespace through its bound Settings scope. [Safe subagent defaults and unified settings](../bug-fix/2026-08-26-safe-subagent-defaults-and-unified-settings.md) own this presentation and the live enable switch.

Each mode tab shows its shipped entry by name and keeps the editor focused on that entry's enable state and child-default fields. Provider binding, tool name, background mode, and entry identity remain composition choices rather than browser-editable fields.

## Alternatives considered

**Create Web-only child profiles.** Profiles, summaries, selective parent context, and named reviewer roles have no current `dsh-tool-subagent` field or executor behavior. Presenting them would create options that cannot affect a child request.

**Expose one generic form for every provider.** External providers can omit persona, tool filtering, or depth enforcement. The first page targets the two shipped in-process entries, whose capabilities are known; a generic provider directory requires capability-driven UI treatment.

**Allow the browser to change entry identity.** Changing a provider, tool name, or continuation policy changes routing and model-visible behavior. Those choices remain composition configuration, while live settings enable the existing entry and alter its child defaults.

## Consequences

Saving a child default applies to later child runs and leaves an already-created child unchanged. A model override may be omitted to inherit the parent while still setting an output-token cap. A persona omits to preserve the deployment role, and tool visibility remains a trusted-process composition restriction rather than an authority system.

The Subagents section does not add task summaries, selective history inheritance, automatic model selection, budgets, or built-in child roles. A future provider entry needs capability-driven controls before it joins this section.
