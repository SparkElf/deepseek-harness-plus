# Agent Note: Mechanical quality gates over prose guidelines

Status: implemented

English | [中文](2026-06-11-quality-gates.zh.md)

The hook/CI symmetry in this record is superseded by [Fast local Git hooks](2026-07-22-fast-local-git-hooks.md); the per-pull-request exhaustive matrix is refined by [fail-open CI impact selection](../testing/2026-08-22-fail-open-pr-ci-impact.md), which retains full enforcement for unknown and high-impact changes plus the nightly default-branch run.

## Problem

This codebase is developed primarily by coding agents. Agents follow enforced gates far more reliably than prose conventions, and "a lot of work" is not a cost argument when agents do the labor. Early evidence: tests that didn't typecheck shipped (vitest doesn't typecheck) and were only caught by a review.

## Decision

Every mechanically checkable AGENTS.md promise gets a command that exits non-zero. CI invokes the complete relevant set selected by its fail-open impact plan, while Git hooks reserve their latency budget for cheap local defects:

- Max-strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, …); examples, tests, and scripts typecheck in CI via the root no-emit `tsconfig.json` while package/vendor code stays behind its own project-reference boundary.
- [Oxlint](2026-07-29-oxlint-linter.md) with type-aware TypeScript rules plus the @stylistic and SonarJS compatibility plugins, enforcing the house style and file-local duplicated-logic checks; vendored code excluded.
- jscpd detects cross-file clones in package production TypeScript and repository scripts; narrow source-range exceptions document deliberately parallel implementations.
- Per-file 100% coverage on `packages/*/*/src` (v8); unreachable defensive guards carry `/* v8 ignore */ ` with stated reasons instead of deletion.
- knip (dead code/deps), publint (package correctness), workspace constraints (workspace rules: private, cordis peer+dev, uniform version, ESM), and a NodeNext consumer typecheck for built package declarations.
- lefthook pre-commit applies project-free Oxlint validation and [safe fixes with a bounded retry](2026-08-09-oxlint-only-fix-workflow.md), rejects staged whitespace, and checks the vendor manifest; pre-push runs incremental typecheck. Every pull request runs static checks; full-impact and nightly runs add the Node 22.19/24/26 matrix plus built application entry contracts for Headless, TUI, ACP, JSON-RPC, workflow, and code-runtime paths.

## Consequences

- Conventions survive agent turnover; cheap commit/push defects fail locally, relevant violations fail in pull-request CI, and the nightly full matrix detects cross-scope drift.
- The gates themselves are code to maintain; config changes are reviewed like any change.
- 100%-coverage pressure can produce assertion-free tests — mutation testing is the planned counterweight (see [the mutation-testing proposal](../../proposed/testing/2026-06-11-mutation-testing.md)).

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
