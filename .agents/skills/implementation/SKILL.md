---
name: implementation
description: Use after an accepted Plus architecture plan. Implement the complete user path, update composition and diff records, and leave no unowned feature state behind.
---

# Implementation for Plus

Implement the agreed user path in the owning modules. Keep changes focused, typed, and explicit at package boundaries.

## Required practice

- Reuse documented Harness plugin extension points.
- Update configuration, docs, and user-visible failure handling with the implementation.
- Update the matching diff record in the same change. A new plugin or preset also updates the composition registry.
- Keep secrets out of source, fixtures, screenshots, and logs.
- Do not label an incomplete feature as released or installable.

Record the implemented scope and any deliberate exclusions in the PR under `## Implementation`. Hand completed work to code review.
