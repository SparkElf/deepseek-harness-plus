# Planned Presets

[中文](PRESETS.zh.md)

> Status: no community preset is implemented or installable yet.

A preset is a versioned, ready-to-run collection of Harness plugins and the configuration those plugins need to work together. You select one, install it, and start using it; you do not assemble plugin rows and settings by hand. Think of it as opening a VS Code development environment where the extensions and workspace settings are already in place.

This page is a release contract for the preset catalog. It does not advertise a capability before that capability installs a runnable plugin collection and its configuration, defines permissions, and has verification evidence.

## Code delivery

**Status: not implemented.**

A repository-aware plugin collection for exploration, implementation, review, verification, and release preparation.

## Community operations

**Status: not implemented.**

A plugin collection for issue triage, discussion facilitation, release-note preparation, and contributor coordination. It must require an explicit approved action before posting, closing, labeling, or merging on behalf of a maintainer.

## Multi-user runtime

**Status: not implemented.**

A deployment plugin collection with a shared Web UI and authenticated gateway, plus an isolated Harness runtime for each user or workspace. The gateway owns authentication and routing; the runtime owns sessions, tools, workspaces, and provider credentials.

## Intelligent data Q&A

**Status: not implemented.**

A governed analysis plugin collection over approved business data. It requires a named data-source owner, read-only or explicitly approved write access, semantic metric definitions, query review before execution, and an auditable result record.

## Release rule

A preset release contributes the plugin collection, its assembled configuration, permission model, required credentials, installation command, and verification instructions in the same pull request.
