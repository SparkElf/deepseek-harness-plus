---
name: dsh-maintain-diffs
description: Use whenever a Plus change diverges from upstream Harness, alters a core plugin, introduces a community plugin, changes preset composition, or updates installer and deployment assets.
---

# Maintain Plus Diff Records

Plus carries two maintained divergence records: `diffs/core/registry.yaml` for Harness and core-plugin changes, and `diffs/community/registry.yaml` for community plugins, presets, installer, deployment, and governance assets.

## Procedure

1. Classify the change as `core` or `community`. Use both records only when the pull request truly changes both layers.
2. Create or update one record with a stable ID, status, feature summary, source repositories, upstream baseline, affected files, plugin roles, compatibility statement, owner, and verification commands.
3. For a plugin or preset, update `presets/compositions/registry.yaml` with its tool names, routes, settings namespaces, UI slots, persistence owner, permissions, and dependencies.
4. Run `pnpm run verify:plus-governance`. Resolve all duplicate active claims before review.
5. Retire a record when its change lands upstream or is removed locally; keep its history in Git rather than leaving an unbounded patch description.

Line numbers are intentionally excluded because they drift. Repository, feature, file, and verification references are the durable maintenance facts.
