---
kind: implemented
area: support
title: A generated peer override names only versions the registry published
created: 2026-10-06
---

# A generated peer override names only versions the registry published

## Problem

`resolvePeerOverrides` pins a package the runtime family publishes to the runtime version, because
the official packages are released together. One is not. `@deepseek-ai/dsh-invariants` stayed at
`0.2.0-rc.2` while the family moved to `0.2.1-alpha.1`, so the generated override named a version no
registry serves.

The manifest still generated and the install still succeeded, because npm invokes an override only
when something requests that package. `@sparkelf/dsh-plugin-supervisor` declares it as a peer, so a
profile that did not install peers never asked for it and never reached the bad override. Enabling
peer installation in the workspace profile made the request real, and the image build then failed
with `ERR_PNPM_NO_MATCHING_VERSION`.

## Decision

The override pass asks the registry which versions exist and falls back to the newest one the
plugin's own range admits. A package that did publish the runtime version still takes it, so the
release-together assumption holds wherever it is true and stops being a hard requirement.

The pass exports `isPublishedVersion` so a spec asserts the property for every override it
produces, rather than pinning today's known exception. That assertion catches this at generation
time instead of at image build time.
