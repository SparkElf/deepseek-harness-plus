# Agent Note: Safe subagent defaults and unified settings

Status: implemented

English | [中文](2026-08-26-safe-subagent-defaults-and-unified-settings.zh.md)

## Problem

The Web product mounted continuous and one-shot delegation from the same tool plugin but presented them as unrelated cards in generic Plugin settings. Both entries were model-visible by default, and their delegation-depth default of three let a child create further descendants without an explicit user choice. The generic placement obscured both the shared capability and the cost of enabling it.

## Decision

The Host-owned `subagent` and `subagent-fork` settings namespaces resolve `enabled: false` and `maxDepth: 0` by default. Agent-scoped `dsh-tool-subagent` instances listen for commits to their namespace and register or remove their model-facing tool immediately; a disabled entry contributes neither its schema nor its continuable prompt guidance. Direct tool composition remains enabled by default because loading that plugin instance is itself the composition choice.

The Web client owns one **Subagents** navigation section. One card exposes continuous and one-shot tabs, and each tab edits only its existing namespace. The enable switch and child defaults therefore share one product location without merging the spawn/continuable and fork/one-shot values. The generic Plugin configuration tab no longer claims either namespace.

This decision partially supersedes the three-level loader default in [persona, tool filtering, and delegation depth](../feature/2026-07-12-subagent-persona-tool-filter-and-depth.md) and the two-card presentation in [live Web subagent settings](../feature/2026-08-16-web-subagent-settings.md). Their provider-capability, namespace-lifetime, and child-request decisions remain current.

## Alternatives considered

**Merge both modes into one settings namespace.** The modes use different context initialization and continuation policies. Sharing model, persona, tool visibility, and depth values would make editing one mode silently change the other.

**Disable the Loader rows.** A disabled Agent-preset row cannot react to user settings, while the Host-lifetime owner must remain mounted so the page can read and write defaults. Keeping the rows mounted and controlling their tool registration makes the saved switch live.

**Keep the three-generation default.** Three was a small finite cap that still supported deep decomposition, but it granted grandchildren before the user selected that behavior. Zero nesting keeps direct delegation useful and makes every deeper generation an explicit choice.

**Keep disabled tools model-visible and reject calls.** That would spend tool-schema tokens and invite calls that policy always rejects. Registration follows the enabled setting instead.

## Consequences

A fresh deployment and an existing settings document with no explicit `enabled` field both resolve each shipped delegation mode as disabled. Enabling one mode does not enable the other, and resetting a mode returns it to disabled with no grandchildren. A settings commit affects current Agent tool registries and future child starts; it does not alter an already-created child.

The dedicated section adds one Settings navigation row and keeps unsaved drafts per mode while the user switches tabs. System coverage enters through the Web settings dialog, verifies both default switches and depth values, proves mode drafts remain independent, and confirms a saved switch after reopening the dialog.
