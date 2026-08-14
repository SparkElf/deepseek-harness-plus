---
name: verification
description: Use after review and before release or merge. Verify Plus against its acceptance criteria, package artifacts, documentation status, and user-visible workflows.
---

# Verification for Plus

Verify the work against the promises made to a user, not against the number of changed files.

## Required checks

- Re-run the exact commands selected by test governance after review fixes.
- Confirm every diff record, plugin composition, PR section, and release note matches the committed implementation.
- Inspect installer or UI output at its target viewport and capture console or request failures.
- Confirm planned presets remain labeled as unavailable until their runnable package and evidence exist.
- Before publishing, verify the built artifact, checksum or package metadata, and release notes from a clean checkout.

Record passing evidence and residual risk in the PR under `## Verification`.
