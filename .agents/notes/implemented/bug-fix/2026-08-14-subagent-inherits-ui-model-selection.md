# Agent Note: Subagent Inherits UI Model Selection

Status: implemented

English | [中文](2026-08-14-subagent-inherits-ui-model-selection.zh.md)

## Problem

A parent session can select a model in the Web UI, while a newly delegated child starts with the deployment default. The child may therefore route to a provider without credentials or to a model that does not match the parent task.

## Decision

`resolveChildAgentOptions()` resolves provider, model, reasoning effort, and `maxTokens` from the parent's latest `request/header` configuration before falling back to the parent's `AgentOptions`; an explicit child request still wins. Web model selection uses those resolved options only for a blank session whose durable origin is `subagent`. A logged child request and an in-process selection retain their existing higher precedence, while an ordinary blank session continues to observe the live global default.

## Alternatives considered

**Copy only the parent AgentOptions.** Agent options do not reflect a model switch made later in the Web session, which leaves the observed fallback defect in place.

**Seed every newly created session with the global default.** Ordinary blank sessions intentionally follow a saved default after creation; changing that rule would make unrelated sessions stale.

**Expose the child model directory to the Web UI.** A child has no independent model-selection surface. The correct route is determined during delegated creation, not by adding a UI operation the child cannot use.

## Consequences

A child begins under the same selected provider, model, reasoning effort, and output limit as its parent unless its delegation request explicitly overrides them. The Web gateway preserves dynamic defaults for ordinary blank sessions. Focused in-process delegation and API Proxy selection tests protect both sides of the precedence rule.
