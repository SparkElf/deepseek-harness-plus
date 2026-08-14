# Planned Presets

[中文](PRESETS.zh.md)

> Status: no community preset is implemented or installable yet.

This page is a release contract for the preset catalog. It does not advertise a capability before that capability has a runnable configuration, defined permissions, an installation path, and verification evidence.

## Code delivery

**Status: not implemented.**

A repository-aware workflow for exploration, implementation, review, verification, and release preparation.

## Community operations

**Status: not implemented.**

A workflow for issue triage, discussion facilitation, release-note preparation, and contributor coordination. It must require an explicit approved action before posting, closing, labeling, or merging on behalf of a maintainer.

## Multi-user runtime

**Status: not implemented.**

A deployment with a shared Web UI and authenticated gateway, plus an isolated Harness runtime for each user or workspace. The gateway owns authentication and routing; the runtime owns sessions, tools, workspaces, and provider credentials.

## Intelligent data Q&A

**Status: not implemented.**

A governed analysis workflow over approved business data. It requires a named data-source owner, read-only or explicitly approved write access, semantic metric definitions, query review before execution, and an auditable result record.

## Release rule

A preset release contributes its configuration, permission model, required credentials, installation command, and verification instructions in the same pull request.
