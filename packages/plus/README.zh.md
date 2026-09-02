---
description: "基于DeepSeek Harness官方扩展点开发的SparkElf Plus能力插件package map。"
kind: "package-group"
---

# plus/ — SparkElf Plus能力插件

[English](README.md) | 中文

## Summary

`plus/` group包含源码仍由本fork持有并与official DSH source base组合的public `@sparkelf/dsh-plugin-*` capability packages。外部持有的capability保持registry dependencies：`@sparkelf/dsh-plugin-supervisor`由`SparkElf/dsh-plugins-plus`维护，可选Desktop由`SparkElf/dsh-plus-desktop`维护。official或external gaps由独立versioned patch packages拥有；本group不fork或复制external capability source。

## Packages

| Package | 职责 | ctx key |
|---|---|---|
| [`backup/`](backup/README.zh.md) | 基于文件的DSH home流式export/restore及Settings Backup UI | 注册WebServer routes与Settings UI；不新增service |
| [`subagent-settings/`](subagent-settings/README.zh.md) | settings-backed continuous/one-shot delegation及一个“子代理”Settings section | 消费official Subagent、Settings、Tool与Client slot services |
| [`document-attachments/`](document-attachments/README.zh.md) | provider-neutral document parser与MinerU provider；generic attachment integration仍在进行 | 提供`documentParser`；消费official attachment storage |
| [`dataops/`](dataops/README.zh.md) | DataOps OAuth、credential lifecycle、MCP composition与Settings UI | 注册routes、MCP tools与Client Settings section |
| [`mcp-credentials/`](mcp-credentials/README.zh.md) | 带current credential-backed Bearer transport的official MCP client replacement | mount后注册namespaced MCP tools |

## Related documentation

- [Attachment subsystem](../../docs/subsystems/attachment.zh.md)
- [Plus Backup作为单个full-stack插件](../../.agents/notes/proposed/architecture/2026-08-30-plus-backup-plugin.zh.md)
- [Plus Supervisor与Desktop packages](../../.agents/notes/proposed/architecture/2026-09-02-plus-supervisor-packages.zh.md)
- [Workspace package](../workspace/workspace/README.zh.md)
- [Host WebServer package](../host/webserver/README.zh.md)

## Dev Note

无。
