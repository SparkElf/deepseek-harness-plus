---
name: architecture-planning
description: Use after product design and before code changes to Plus. Define ownership, plugin composition, diff records, module boundaries, and verification before implementation.
---

# Architecture Planning for Plus

Plan the complete path from user action to durable result. Prefer existing Harness plugins and Cordis extension points over loop patches or central registries.

## Required output

- List the owning packages, UI surfaces, configuration, persistence, and external systems.
- Name one owner for each state transition, credential, and privileged operation.
- For plugin work, declare tool names, routes, settings namespaces, UI slots, and capabilities in `presets/compositions/registry.yaml` before implementation.
- Add or update the correct `diffs/core/registry.yaml` or `diffs/community/registry.yaml` record with feature, repositories, baseline, files, compatibility, and verification.
- Define the smallest credible test and release evidence.

Do not add queues, locks, fallback paths, or compatibility shims without a real user-visible requirement. Record the plan in the PR under `## Architecture`.
