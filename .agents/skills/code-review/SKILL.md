---
name: code-review
description: Use after implementation and before verification for every Plus PR. Review user regressions, plugin conflicts, diff accuracy, and release claims before approving changes.
---

# Code Review for Plus

Review the change as an operator and a plugin ecosystem maintainer. Lead with concrete findings and do not approve evidence that only proves a file changed.

## Review checks

- Does the change deliver the stated user result without exposing credentials, private runtimes, or unapproved external actions?
- Does the composition registry prevent collisions in tools, routes, settings namespaces, persistence owners, and UI slots?
- Does the core or community diff record name every affected repository and file without pretending a planned feature is shipped?
- Are documentation, release claims, installer screens, and preset status consistent with the actual code?
- Is the implementation simpler than the alternatives considered?

Record findings, fixes, and the review result in the PR under `## Code review`. A human maintainer owns final approval.
