---
name: product-design
description: Use before changing a Plus user workflow, preset, installer, daemon, or release promise. Define the user problem, current availability, interaction, and acceptance evidence before implementation.
---

# Product Design for Plus

Start with the reader or operator, not the repository structure. State who is blocked, what they are trying to finish, what happens today, and what observable result removes the friction.

## Required output

- Name the primary user and their immediate task.
- Separate available behavior from work in development. Never present a planned preset, installer, or deployment mode as installable.
- Define the shortest successful path, failure feedback, recovery path, and credential or data-safety expectations.
- Write acceptance criteria as user-visible results, not source-file or mock assertions.

## Plus-specific decisions

A preset must identify its data owner, tool permissions, credential source, external side effects, approval action, and audit record. Intelligent data Q&A never receives unrestricted database credentials. Multi-user work names the authenticated gateway owner and the isolated runtime owner.

Record the resulting product decision in the PR under `## Product design`. Hand the work to architecture planning before code changes.
