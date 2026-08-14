# Community Preset Charter

[中文](PRESETS.zh.md)

DeepSeek Harness Plus publishes runnable presets for repeatable operating contexts. A preset is a versioned configuration and supporting documentation, not a prompt pasted into a session.

## Release requirements

Each preset release defines its target users, model and tool permissions, required credentials, persistence owner, installation command, and verification path. A preset that touches external systems also defines the approval point and visible audit record.

## Code delivery

The code delivery preset focuses on repository exploration, implementation, review, verification, and release preparation. It builds on Harness Code Mode and keeps source changes, tool use, and verification evidence in the session record.

## Community operations

The community operations preset supports issue triage, discussion facilitation, release-note preparation, and contributor coordination. It does not post, close, label, or merge on behalf of a maintainer without an explicit approved action.

## Multi-user runtime

The multi-user runtime preset defines a deployment with a shared Web UI and authenticated gateway, plus one isolated Harness runtime per user or workspace. The gateway owns user authentication and runtime routing; runtime containers own session data, tools, workspaces, and provider credentials.

## Intelligent data Q&A

The intelligent data Q&A preset serves analysts who need answers over approved business data. It requires a named data-source owner, read-only or explicitly approved write access, a semantic metric definition, query review before execution, and an auditable result record. It does not treat database credentials or unrestricted SQL as a model capability.

## Contribution path

Propose a preset through a Discussion before adding a new operating model. A pull request contributes the runnable configuration, its documentation, and verification evidence together.
