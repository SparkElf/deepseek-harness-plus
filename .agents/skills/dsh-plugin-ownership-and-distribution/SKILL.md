---
name: dsh-plugin-ownership-and-distribution
description: Use before adding, moving, publishing, curating, default-mounting, or repairing a DSH capability — including a defect inside a capability another plugin owns — to decide plugin ownership, npm distribution, repository placement, and profile composition independently.
---

# DSH Plugin Ownership And Distribution

Use this workflow before implementation whenever a capability may become a package, move between repositories, publish to npm, contribute Host or Client behavior, or enter a shipped profile. The owning decision is [plugin ownership and distribution](../../notes/implemented/architecture/2026-08-20-plugin-ownership-and-distribution.md).

## Required Evidence

Read the capability's current Host and Client entries, package manifest, bundle patch, settings and persistence owners, public Harness APIs, release workflow, and every profile that mounts it. For a third-party candidate, also report its repository, license, maintained version, feature fit, and unresolved compatibility risks. Do not install, move, or publish before the owner accepts the classification.

**Read what the current owner also provides before deciding to replace it.** A registry exposes the id it matches; it does not announce the capabilities that ride on the same implementation. A file-viewer registration reads as an extension point while the builtin it displaces may be the only editor for that file type, so replacing it silently drops editing, saving, and its settings. Name the replacement's owned surface — rendering, mutation, persistence, settings, disposal — and reject an option that drops any of it.

**Name the delivery mechanism as one of four, never as "a patch".** Profile configuration; our own plugin mounted on a published extension point; an npm-target patch on an external package, delivered through the profile's `patchedDependencies`; and a republished first-party package delivered through `overrides`. The first two travel as code we own; the last two are two different mechanisms for two different package populations — an external npm package is patched in place, while an official `@deepseek-ai/*` workspace whose built `lib/` cannot express the change is repackaged under our scope. Deciding for one population does not decide for the other.

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
