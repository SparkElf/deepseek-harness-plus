# Agent Note: Plus Governance and Diff Protocol

Status: implemented

English | [中文](2026-08-14-plus-governance-and-diff-protocol.zh.md)

## Problem

A community-maintained Harness distribution needs a contribution process that makes AI-authored work reviewable, separates upstream runtime changes from community-layer work, and prevents plugins from silently overwriting one another.

## Decision

Plus stores the six engineering skills under `.agents/skills/`, requires their evidence in the pull-request template, and checks those sections in the `Plus governance` workflow. `.github/CODEOWNERS` names the human committee owner; AI evidence never grants merge permission.

`diffs/core/registry.yaml` owns upstream Harness and core-plugin divergences. `diffs/community/registry.yaml` owns community plugins, presets, installer, deployment, and governance changes. Each record identifies its feature, repositories, baseline, files, compatibility statement, owner, and verification. `presets/compositions/registry.yaml` owns active tool, route, settings namespace, UI slot, and persistence-owner claims. `verify-plus-governance` rejects malformed records and duplicate active composition claims.

## Alternatives considered

**Keep patch descriptions in pull-request prose.** Pull-request text does not remain a structured source of truth through upstream merges, release branches, and later maintenance.

**Track every change in one registry.** A single list would hide whether an operator is evaluating a core runtime divergence or a community-layer package and deployment change.

**Allow plugin order to resolve conflicts implicitly.** Order-dependent overwrite makes composition failures difficult to detect and impossible to review from a stable declaration.

## Consequences

Contributors update the appropriate diff registry in the same pull request as a maintained divergence. New presets declare their composition before claiming availability. Reviewers receive a concrete inventory of plugin ownership and conflict risks, while human committee approval remains the final merge authority.
