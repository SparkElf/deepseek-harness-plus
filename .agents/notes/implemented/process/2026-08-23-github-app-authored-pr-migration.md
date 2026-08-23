# Agent Note: GitHub App-authored pull request migration

Status: implemented

English | [中文](2026-08-23-github-app-authored-pr-migration.zh.md)

## Problem

An administrator who creates a pull request cannot approve that pull request. Author-owned PRs remain blocked by a ruleset that requires an approving Code Owner.

## Decision

Open author-blocked PRs are replaced by PRs created by an installed GitHub App. The replacement branch points to the original head commit and keeps the original base branch, title, body, and code content. The source PR is closed only after the replacement exists. The repository administrator approves the replacement with the normal user account. The process does not merge the target branch.

Merged and already closed PRs remain immutable historical records. The process does not recreate them or delete their source branches.

## Alternatives considered

**Use administrator bypass.** Bypass can merge without approval, but it does not produce an approving review or preserve the repository review contract.

**Add a second administrator.** A second administrator can approve an author-owned PR, but an installed App solves PR authorship without adding a human account solely for this purpose.

**Make the GitHub App a Code Owner.** App identities are not valid CODEOWNERS entries. The human administrator remains the Code Owner and reviewer.

## Consequences

Each migrated item has a closed source PR and an open replacement. The replacement keeps the original branch relationship and commit content. Replacement PRs still need required checks; approval alone does not make them mergeable. Installation Tokens are short-lived and must be generated locally from a private key outside the repository.

## Verification

Migration compares the source and replacement head SHA, base branch, title, and body. It verifies the App author, administrator approval, closed source PR, and absence of target-branch merges.
