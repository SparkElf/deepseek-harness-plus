---
description: "具有完整Host、startup及Client ownership的settings-backed continuous和one-shot subagent modes。"
kind: "package-reference"
---

# @sparkelf/dsh-plugin-subagent-settings

[English](README.md) | 中文

## 概述

该完整Host及Client plugin持有Plus中的两个settings-backed delegation modes。Host root注册model-facing delegation，`/startup`持有`subagent`及`subagent-fork` Settings namespaces，Client在一个Subagents section中展示两种mode。Fresh settings会以zero nesting禁用两种mode；saved change无需rebuild Host即可影响later child starts。

## 目录

- [使用此软件包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制和延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此软件包

Plus profile会mount两个startup rows，并把built-in continuous及one-shot preset rows重定向到该package。Continuous mode创建fresh continuable child；one-shot mode为一个task fork completed parent context。每个namespace独立控制enablement、model override、output-token cap、persona、tool visibility及nesting depth。

-----

<a id="model-experience"></a>
## 模型体验

### Settings-backed delegation tools

#### 模型看到什么

disabled mode不贡献schema或prompt section。Continuous mode增加`subagent` tool及continuable guidance；one-shot mode增加`subagent_fork`。Saved settings影响later children，不会rewrite existing child。

#### Token 影响

启用mode会增加对应stable tool schema及guidance。Child model、persona及tool choices只影响child requests；tool calls及results遵循normal Session history costs。

#### KV Cache 影响

切换mode会改变later-request tool prefix。One-shot mode会复用inherited parent history，直到追加child-specific prompt及tools。

## 已知限制和延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Temporary preset redirection patch**：official preset documents及legacy model-selection card没有runtime replacement API，因此retireable data-only patch会redirect两个built-in rows并移除legacy Plus registration。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文，点击展开</summary>

该开发备注是maintainer working context；shipped behavior、limits及rationale以以上sections、package code及linked Agent Note为准。

- Host behavior位于`src`，Settings UI位于`src/client`。[Distribution Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-ranged-plus-patchset-distribution.zh.md)持有package及patch retirement boundaries。

</details>
