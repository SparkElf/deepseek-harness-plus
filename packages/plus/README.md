---
description: "Package map for SparkElf Plus capability plugins developed against official DeepSeek Harness extension points."
kind: "package-group"
---

# plus/ — SparkElf Plus capability plugins

English | [中文](README.zh.md)

## Summary

The `plus/` group contains public `@sparkelf/dsh-plugin-*` capability packages whose source remains in this fork and composes with the official DSH source base. Externally owned capabilities stay registry dependencies: `@sparkelf/dsh-plugin-supervisor` is maintained in `SparkElf/dsh-plugins-plus`, while optional Desktop is maintained in `SparkElf/dsh-plus-desktop`. Official or external gaps remain independently versioned patch packages; this group does not fork or duplicate external capability source.

## Packages

| Package | Role | ctx key |
|---|---|---|
| [`backup/`](backup/README.md) | Streamed export and restore of the file-backed DSH home plus the Settings Backup UI | registers WebServer routes and Settings UI; no new service |
| [`subagent-settings/`](subagent-settings/README.md) | Settings-backed continuous and one-shot delegation plus one Subagents Settings section | consumes official Subagent, Settings, Tool, and Client slot services |
| [`dataops/`](dataops/README.md) | DataOps OAuth, credential lifecycle, MCP composition, and Settings UI | registers routes, MCP tools, and Client Settings section |
| [`mcp-credentials/`](mcp-credentials/README.md) | Official MCP client replacement with current credential-backed Bearer transport | registers namespaced MCP tools when mounted |

## Related documentation

- [Attachment subsystem](../../docs/subsystems/attachment.md)
- [Plus Backup as one full-stack plugin](../../.agents/notes/proposed/architecture/2026-08-30-plus-backup-plugin.md)
- [Plus Supervisor and Desktop packages](../../.agents/notes/proposed/architecture/2026-09-02-plus-supervisor-packages.md)
- [Workspace package](../workspace/workspace/README.md)
- [Host WebServer package](../host/webserver/README.md)

## Dev Note

None.
