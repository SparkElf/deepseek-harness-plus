---
description: "Package map for SparkElf Plus capability plugins developed against official DeepSeek Harness extension points."
kind: "package-group"
---

# plus/ — SparkElf Plus capability plugins

English | [中文](README.zh.md)

## Summary

The `plus/` group contains public `@sparkelf/dsh-plugin-*` capability packages that compose with the official DSH source base. A package here owns its complete Host and Client behavior, profile-facing entry, runtime locale, and npm dependency closure. Official or external gaps remain independently versioned patch packages; this group does not fork or duplicate official capability implementations.

## Packages

| Package | Role | ctx key |
|---|---|---|
| [`backup/`](backup/README.md) | Streamed export and restore of the file-backed DSH home plus the Settings Backup UI | registers WebServer routes and Settings UI; no new service |
| [`subagent-settings/`](subagent-settings/README.md) | Settings-backed continuous and one-shot delegation plus one Subagents Settings section | consumes official Subagent, Settings, Tool, and Client slot services |
| [`document-attachments/`](document-attachments/README.md) | Provider-neutral document parser and MinerU provider; generic attachment integration remains in progress | provides `documentParser`; consumes official attachment storage |
| [`dataops/`](dataops/README.md) | DataOps OAuth, credential lifecycle, MCP composition, and Settings UI | registers routes, MCP tools, and Client Settings section |
| [`mcp-credentials/`](mcp-credentials/README.md) | Official MCP client replacement with current credential-backed Bearer transport | registers namespaced MCP tools when mounted |

## Related documentation

- [Plus Backup as one full-stack plugin](../../.agents/notes/proposed/architecture/2026-08-30-plus-backup-plugin.md)
- [Workspace package](../workspace/workspace/README.md)
- [Host WebServer package](../host/webserver/README.md)

## Dev Note

None.
