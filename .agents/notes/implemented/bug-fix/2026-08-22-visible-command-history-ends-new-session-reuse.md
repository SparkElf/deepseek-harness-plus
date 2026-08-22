# Agent Note: Visible command history ends New Session reuse

Status: implemented

English | [中文](2026-08-22-visible-command-history-ends-new-session-reuse.zh.md)

## Problem

A fresh Web Session could execute a slash command and render durable command content while the Host still reported the Session as blank. The Goal command makes the contradiction visible: after `/goal clear` rendered its input bubble and result, clicking New Session asked the Workspace runtime for a reusable blank, received the same Session id, and left the old command on screen instead of showing the welcome view.

The Host defined `SessionSummary.blank` only by the absence of `turn/start`. That definition treated command lifecycle events as reusable even though `command/run` is durable user history and the Client projects its generic result into the active conversation. The Workspace runtime correctly trusted the Host summary; repairing the click handler or one UI plugin would leave reloads and other command sessions inconsistent.

## Decision

The Host list-metadata projection is the only owner of New Session reuse eligibility. A Session remains blank only while its log contains neither `turn/start` nor `command/run`. The same `startsSessionHistory` predicate drives attached summaries and incremental projection updates. The Client lowers its existing list mirror and resident Session when the authoritative live `session/event(command/run)` arrives, reusing the same monotonic engaged mutation as accepted prompts; it makes no independent reuse decision. Live navigation, cold-log verification, reloads, and Workspace reuse therefore agree without a second field.

Passive plugin state such as `plan/mode`, title, permission, sandbox, and approval events does not end blank reuse by itself. A rejected ordinary prompt still has no accepted turn or command and remains reusable. Any command lifecycle ends reuse at `command/run`, before its result settles.

The wire remains unchanged: `SessionSummary.blank` and `host/session-added.blank` carry the baseline, while the existing `session/event(command/run)` carries the live conversion evidence. The Workspace runtime still reuses a qualifying member blank and creates a Session when none exists.

This decision partially supersedes the turn-only blank statements in the [Web session-scope decision](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md), [Goal command-input projection](../feature/2026-08-01-goal-command-input-projection.md), [bounded cold verification](2026-08-13-bounded-cold-blank-verification.md), and [Workspace reuse membership fix](2026-08-05-workspace-blank-session-reuse-membership.md). Their composition, cold-read, and membership decisions remain active.

## Alternatives considered

**Patch New Session in the Client.** The current rendered Session can expose an active composer phase, but hidden blanks and reloads still depend on Host summaries. A Client exclusion set would duplicate durable state and lose authority after reload.

**Add a second `reusable` summary field.** Reuse and list visibility have the same user contract once a command creates durable history. A second bit would add schema, cache, frame, fixture, and migration work while permitting contradictory combinations.

**Always create on New Session.** This avoids reuse mistakes but accumulates hidden never-used blanks when the user clicks New Session from an already empty view. Reusing a genuinely empty Workspace member remains the bounded behavior.

## Consequences

A command-only Session activates its generic result and is visible in Session lists and cannot be selected as the target of a later New Session action. Agent preset switching also closes after a command because it consumes the same authoritative blank bit; command behavior and later model turns therefore keep one composition. The model boundary does not change: command execution still creates no user message or model turn unless its command handler already does so.

## Verification

The Host blank projection test distinguishes passive state, `command/run`, and `turn/start`; the plan-active semantic golden pins a generic command result replacing the welcome Hero. The keyless real-Host Goal browser journey executes `/goal clear`, clicks New Session before any reload, observes the welcome view with an empty composer and the old command absent. Acceptance uses that same path against the running Web GUI without route interception, direct API calls, or screenshot criteria.
