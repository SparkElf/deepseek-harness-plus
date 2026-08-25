# Agent Note: Plugin ownership and distribution are independent decisions

Status: implemented

English | [中文](2026-08-20-plugin-ownership-and-distribution.zh.md)

## Problem

Harness implements every product capability as a plugin, but that fact does not decide whether its package publishes to npm, which repository owns it, or whether a shipped profile mounts it by default. Treating those questions as one decision split external capabilities between their source package and Host-specific UI wrappers, while treating an unpublished first-party package as non-plugin code confused distribution with composition.

## Decision

Every capability review decides four dimensions independently: Cordis plugin lifecycle, npm publication, source-repository ownership, and default profile composition. The repository workflow is encoded in [`dsh-plugin-ownership-and-distribution`](../../../skills/dsh-plugin-ownership-and-distribution/SKILL.md), and the standing working-style rule requires that review before implementation.

A capability has one owner. That owner carries its capability-specific Host and Client entries, settings UI, configuration, routes, migrations, install and removal behavior, release compatibility, and user documentation. An external plugin uses published Harness extension points, declares its Host composition through `dsh.bundle`, declares its browser half through `dsh.client`, and removes all contributions with its plugin lifecycle. Harness does not add a first-party package whose only job is to register UI for an external capability.

An integration need does not authorize a Harness core change. When published extension points cannot satisfy the current integration, implementation stops before editing core source. The proposal reports the exact extension gap, core packages and public API to change, why the plugin or profile cannot own the behavior, generic consumers independent of the integration, native and default-profile impact, alternatives, and verification for both native and integrated modes. Core work begins only after the user explicitly approves that reported scope; approval for one gap does not authorize adjacent core changes. Integration identity, endpoints, credentials, product UI, and deployment configuration never enter the generic core contract.

Repository ownership follows change ownership rather than package visibility. A capability stays first-party when it defines a baseline Harness extension point, consumes private persisted formats, or changes in lockstep with internal packages. A capability belongs in an external repository when it has an independent maintainer or release cadence, its own deployed service or protocol, its own credential or trust boundary, meaningful install choice, or consumers beyond one Harness distribution. An npm artifact may remain sourced in the Harness monorepo, and an external artifact may be selected by a Plus default profile without changing either owner.

The Settings Backup client remains a first-party package because its archive behavior evolves with Harness settings and stored data; it publishes as `@sparkelf/dsh-client-ui-settings-backup` in the DSH package family, remains sourced in `deepseek-harness-plus`, and the Web bundle mounts it by default. The owner-selected npm scope does not transfer repository ownership. The Mobile Bridge belongs to `dsh-plugins-plus`: its Host tunnel, Client settings section, mobile presentation, relay protocol, configuration, and documentation ship from `@sparkelf/dsh-mobile-bridge`. The Plus Web profile pins and default-mounts that external package because the owner selected mobile access as part of this distribution; a higher profile patch can disable it, and upstream Harness does not acquire its source or release responsibility.

## Alternatives considered

**Require every plugin to live in an external npm repository.** Rejected because repository separation adds release coordination without improving replaceability for packages that already compose through Cordis and must evolve with private first-party formats.

**Keep external Host code outside Harness but add first-party UI adapters.** Rejected because uninstall and compatibility span two owners, and the adapter has no protocol or lifecycle responsibility beyond forwarding the external capability into a public Slot.

**Treat every package in a default profile as first-party.** Rejected because default composition is a distribution choice; it does not transfer source, security, release, or compatibility ownership.

**Store the rule only in agent memory or root instructions.** Rejected because memory is not versioned and a full decision procedure does not belong in the root standing-order budget. The Agent Note owns rationale, the Skill owns execution, and the working-style rule owns invocation.

## Consequences

- Plugin proposals report four explicit answers before implementation, so npm publication and default inclusion cannot silently decide ownership.
- External capabilities remain complete install and removal units; Host-specific wrapper packages are not an accepted integration path.
- An integration-triggered core proposal is a separately approved generic capability change, not an implementation detail of the plugin PR.
- First-party packages may publish under an owner-selected npm scope without moving repositories, preserving lockstep development where it is required. Release tooling records any non-default scope as an exact first-party package; missing credentials for that selected scope block publication rather than authorizing another scope or version contract.
- Plus may curate or default-mount an external package while the external project retains release and security responsibility.
- The [external plugin maintenance scheme](../../../notes/proposed/architecture/2026-08-19-external-plugin-maintenance.md) continues to own curation pins, drift, local patches, and the separate plugin repository; this decision owns the earlier placement classification.
