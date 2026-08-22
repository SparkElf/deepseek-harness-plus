# Agent Note: Goal command input projection

Status: implemented

English | [中文](2026-08-01-goal-command-input-projection.zh.md)

## Problem

Human commands execute outside the model turn and persist as `command/run` plus `command/done`. The Web transcript rendered only their result row. On a fresh session, `/goal` therefore cleared the composer and completed successfully while the page stayed on the empty hero; its result became visible only after later conversation content activated Chat. Appending an ordinary `user/message` from the handler would change model-visible history and command semantics.

## Decision

The command registry and durable command lifecycle remain unchanged. `command/run` records the parser-owned name, optional verbatim arguments, source, and invocation id; `command/done` records settlement. Neither event carries browser presentation intent.

The `ui-goal` client plugin registers a Goal-owned Conversation Definition beside the generic command Definition. Both match the same `/goal` `command/run`: the generic Definition retains the durable result row, while the Goal Definition builds a separate `command-input` Chat Node at an earlier fractional anchor. The Goal plugin also registers the keyed React renderer for that Node. Its local component copies only the user bubble's right-aligned geometry and semantic tokens, uses 14px/22px monospace text, and mounts no timestamp, copy, or branch actions.

`Session.composerPhase` treats a false Host blank bit as active, so durable `command/run` activates the generic command result, enters the Session in lists, and prevents New Session reuse. The Goal-owned `command-input` additionally presents the initiating text as human transcript content ([visible command history decision](../bug-fix/2026-08-22-visible-command-history-ends-new-session-reuse.md)).

The Goal Definition derives `/<name><args.trimEnd()>` from the structured run: separator and internal multiline input survive, while the claimed bare form whose arguments contain one space displays `/goal`. A history window containing only `command/done` has no matching Goal Context, so it keeps the generic result row without inventing an input bubble; loading the older run restores both Nodes.

The model boundary is unchanged. The Goal projection creates no `user/message`, `turn/start`, `step/start`, or `request/header`. Accepted goal mutations reach the model only through the goal domain's existing `<goal_state>` snapshot or clear tombstone, independently of the command-input Node.

## Verification

Goal client tests pin the dual Definition output, ordering, other-command exclusion, bare and multiline text, done-only cuts, renderer semantics, disposal, and fresh-session phase selection. The keyless assembled Web scenario submits `/goal clear` in a fresh session with no model adapter, verifies its input and no-goal result, starts a clean welcome Session before any reload, and sees the prior command absent with an empty composer.

## Alternatives considered

**Append `user/message` in the `/goal` handler.** Rejected because the command would become model input and could trigger or alter a later request.

**Add presentation intent to the command registry and durable event.** Rejected because one Goal view would widen the generic command interface and make Session, Chat, and every command fixture carry browser presentation state. The existing `command/run` name and arguments already let the composed Goal client reconstruct its own view.

**Teach the generic command renderer about `/goal`.** Rejected because command-specific view construction belongs to the Goal client plugin. Composing that plugin out must remove the bubble without changing command execution or the generic result row.

**Render every command input as a user bubble.** Rejected because a generic result row is sufficient to expose control-command history. Presenting every invocation as human transcript content would broaden interaction semantics without a feature-owned Conversation Definition.

## Consequences

One durable `/goal` run feeds two independently owned view Contexts without changing the command capability. Composing `ui-goal` out leaves ordinary command execution and its result row intact. Live tabs and cold reloads agree because both views derive from the same run. A page cut that retains only `command/done` temporarily shows only the result row; loading the older run restores the input Node. The full-log `command/run` keeps the Session active, visible, and ineligible for blank reuse even though no model turn starts.
