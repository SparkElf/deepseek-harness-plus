---
name: dsh-plugin-ownership-and-distribution
description: Use before adding, moving, publishing, curating, or default-mounting a DSH capability to decide plugin ownership, npm distribution, repository placement, and profile composition independently.
---

# DSH Plugin Ownership And Distribution

Use this workflow before implementation whenever a capability may become a package, move between repositories, publish to npm, contribute Host or Client behavior, or enter a shipped profile. The owning decision is [plugin ownership and distribution](../../notes/implemented/architecture/2026-08-20-plugin-ownership-and-distribution.md).

## Required Evidence

Read the capability's current Host and Client entries, package manifest, bundle patch, settings and persistence owners, public Harness APIs, release workflow, and every profile that mounts it. For a third-party candidate, also report its repository, license, maintained version, feature fit, and unresolved compatibility risks. Do not install, move, or publish before the owner accepts the classification.

## Decide Four Dimensions Separately

| Dimension | Question |
|---|---|
| Plugin boundary | Does one Cordis plugin lifecycle own the capability's registrations and disposal? |
| npm publication | Must a versioned artifact resolve outside the source workspace? |
| Repository ownership | Which project owns compatibility, security, release, and retirement? |
| Default composition | Which shipped profiles mount the package without a separate user choice? |

Never infer one answer from another. A first-party workspace package may publish to npm; an external npm plugin may be default-mounted by a distribution; neither fact changes its source owner.

## Ownership Closure

Identify one capability owner. That owner must carry every capability-specific Host entry, Client entry, settings UI, configuration schema, routes, migrations, install and uninstall behavior, and user documentation. Cross-repository adapters are allowed only for a real public protocol, error, trust, or lifecycle difference. A host-repository wrapper that merely registers UI for an external capability is forbidden.

An external plugin is admissible only when all of these are true:

1. It uses published Harness extension points and imports no private host source.
2. Its `dsh.bundle` mounts the Host half and its `dsh.client` loads the browser half when present.
3. Installation, disable, upgrade, and removal cover every owned registration and artifact.
4. Supported Harness versions are expressible through package metadata and documented public contracts.
5. A named maintainer owns releases, compatibility, security fixes, and retirement.

When a gate fails, fix the extension point or keep the capability first-party. Do not hide the failure behind a thin package or compatibility path. Registry scope is part of ownership: missing publish authority is a release blocker, never a reason to change scope, publish a fork under the owner's name, or widen sibling version ranges.

## Placement Decision

Prefer an external repository when the capability has an independent maintainer or release cadence, its own deployed service or protocol, its own credential or trust boundary, meaningful install choice, or consumers beyond one Harness distribution. Prefer the Harness monorepo when the capability defines a baseline extension point, follows private persisted formats, or must change in lockstep with internal packages.

Publish a package when profiles or consumers must resolve a versioned artifact outside the workspace. Publication does not require moving its source repository. Default-mount a package only as an explicit product decision; record the exact version or workspace dependency and keep the row patchable by higher profile layers.

## Report

Before code, report:

1. the capability owner and complete owned surface;
2. one answer for each of the four dimensions;
3. external-plugin gate evidence;
4. version and public-API compatibility;
5. install, disable, upgrade, and removal behavior;
6. default-profile impact;
7. alternatives rejected and the user's explicit decision.

After approval, keep Host and Client work in the owner package, update the owning Agent Note or add one, and verify the assembled profile rather than only the package in isolation.
