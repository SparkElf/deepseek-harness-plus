# Agent Note: User Correction Distillation

Status: implemented

English | [中文](2026-08-25-user-correction-distillation.zh.md)

## Problem

A request to preserve a lesson for future work can degrade into a conversational promise, a history of the current mistake, or another domain-specific instruction that duplicates existing guidance. None reliably transfers the correction to an adjacent task, and duplicated rules drift.

## Decision

The working-style entry routes requests to remember or distill a correction to the [user-correction distillation skill](../../../skills/dsh-distill-user-corrections/SKILL.md). The skill extracts one trigger, required action, and completion proof; checks an adjacent case; searches existing guidance before choosing a home; and adds a mechanical counterexample when possible. The resulting domain rule remains in its existing owning skill, Agent Note, or verifier rather than moving into this meta-workflow.

## Alternatives considered

**Rely on the conversation or model memory.** A promise has no durable repository trigger, evidence, or review surface.

**Add every lesson directly to working style.** A global list would accumulate case-specific rules, consume the root instruction budget, and bypass domain ownership.

**Create a new domain skill for every correction.** Separate skills with overlapping triggers create multiple authorities and make future invocation less predictable.

## Consequences

Future correction requests have one durable learning workflow, while domain facts keep one owner. Each distillation costs a search and adjacent-case check, and semantic quality cannot be fully automated; metadata, links, documentation gates, and focused counterexamples provide the mechanical evidence that is available.
