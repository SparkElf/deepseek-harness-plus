# Agent Note: User-authorized pull request batching

Status: implemented

English | [中文](2026-08-16-user-authorized-pr-batching.zh.md)

## Problem

Creating a pull request after every completed change fragments related work before the user chooses a review boundary. A candidate branch, successful verification, or a push records engineering progress but does not state that the user wants GitHub review to begin.

## Decision

The PR authoring workflow creates a new pull request only after the user explicitly asks to gather changes into a PR, names a PR unit, or requests release integration. Implementation, review, verification, a completed candidate, and a request to push keep work on its candidate or aggregate branch.

When the user requests a consolidated PR, the author inventories accepted changes and groups them by the requested review boundary. Existing selected PRs still receive completed work they own; this rule does not permit replacement PRs or stale remote heads.

## Alternatives considered

**Create one pull request for every completed change.** This turns implementation cadence into review topology and forces the user to consolidate GitHub state after the fact.

**Never create a pull request without a literal command.** Release integration and a user-named PR unit already express the same explicit intent, so requiring one exact phrase would add ceremony without clarifying ownership.

## Consequences

Candidate branches may contain several accepted changes before publication. The user controls when that work becomes a review unit, while existing PR synchronization and branch cleanup remain separate required processes.
