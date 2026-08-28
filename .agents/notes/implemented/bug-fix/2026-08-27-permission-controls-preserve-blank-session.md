# Agent Note: Permission controls preserve the blank-session Hero

Status: implemented

English | [中文](2026-08-27-permission-controls-preserve-blank-session.zh.md)

## Problem

The composer changes a Session's permission preset through the logged `/permission <preset>` command. The Host classified every `command/run` as conversation history, so that control changed `SessionSummary.blank` to false. The client then replaced the new-session Hero with the conversation view and exposed the generic permission command card even though no prompt or user-visible command had begun a conversation.

The same controls had two presentation gaps. Built-in permission names and the Session-log Header action bypassed their locale dictionaries, and the attachment contribution rendered after permission modes rather than beside the leading command action.

## Decision

The Host `startsSessionHistory` fold and the client `SessionManager` live-frame mirror treat `command/run(name='permission')` as durable control state rather than conversation history. They continue to treat `turn/start` and every other `command/run` as activity. The `sessionListMetadata` projection uses state version 2 so an older cached non-blank result is never reused under the new fold. Permission events remain in the Session log, and New Session reuse keeps the selected preset because it reuses the same blank Session.

The conversation and permission-settings locales each own the display names for the three built-in permission presets and their Full-access confirmation strings. Host-configured names outside that built-in set retain the existing title-case transform. The Session-log export locale owns the Header button's visible and accessible label. The `conversation.input.left` list renders immediately after the leading command launcher and before permission and plan modes; the attachment plugin remains the owner of the paperclip action and its state.

## Alternatives considered

**Suppress the route change in `ConversationRoot`.** The authoritative summary would still make the Session list-visible and ineligible for reuse, and reconnect or cold loading would restore the incorrect state. Presentation cannot repair Host activity semantics.

**Write a global permission default from the blank composer.** The gesture addresses one existing Session and its durable projection. Changing a future-session default would move ownership and would not update the addressed Session through the same logged path.

**Hide the permission command card after activation.** That would conceal one symptom while leaving the Hero transition, Session-list visibility, and New Session reuse wrong.

## Consequences

A blank Session may contain permission lifecycle and projection events while remaining hidden and reusable. The first model turn or user-visible command still materializes it. The selected permission survives the Hero phase and remains auditable in the raw Session log.

Each surface reads Chinese and English permission or Session-log labels from its owning locale namespace. The composer groups the plus and paperclip as leading actions without changing slot authorization or attachment behavior.

## Verification

The Host blank-summary suite distinguishes permission from a user-visible command and a model turn. Conversation component coverage pins localized built-in labels, confirmation copy, and the plus-attachment-mode DOM order. Session-log Header coverage pins visible and accessible Chinese copy. The assembled Web replay and the isolated Supervisor candidate exercise the real plugin composition.

## Related

Cold Session verification keeps the conservative visibility direction described in [bounded cold blank verification](2026-08-13-bounded-cold-blank-verification.md); state-version invalidation lets eligible artifacts refold with this activity definition. Slot ownership remains governed by the [slot type-chain implementation](../architecture/2026-07-22-slot-type-chain-implementation.md).
