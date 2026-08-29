---
description: "为Streamable HTTP加入per-request credential-backed Bearer authentication的official MCP client behavior。"
kind: "package-reference"
---

# @sparkelf/dsh-plugin-mcp-credentials

[English](README.md) | 中文

## 概述

该Host plugin保留official MCP connection、reconnect、tool publication、image-result及lifecycle behavior，同时增加一个Streamable HTTP option：`bearerTokenRef`。Transport会在每次network request前立即resolve该DSH credential，并把current value作为Bearer token发送。

## 目录

- [使用此软件包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制和延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此软件包

使用与official MCP client相同的stdio或`streamable-http` configuration。对于credential-backed HTTP，设置`bearerTokenRef`并compose Credentials；literal `headers.Authorization`与`bearerTokenRef`互斥。DataOps会在内部mount该plugin，因此token rotation无需profile remount即可到达下一次MCP request。

-----

<a id="model-experience"></a>
## 模型体验

### Credential-backed MCP transport

#### 模型看到什么

模型只看到通过`bearerTokenRef`认证的当前namespaced MCP tool schemas及其results。Credential references及values不会出现在tool arguments、results、prompts、Session events、manifests或deployment locks中。

#### Token 影响

Authentication增加零token。MCP tool schemas及calls保留upstream MCP client持有的token effects。

#### KV Cache 影响

Credential rotation不改变model-visible schemas。Tool discovery或connection loss可能增加或移除schemas，从而改变tool prefix。

## 已知限制和延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅Bearer authentication**：其他HTTP authorization schemes需要proven provider extension point；profile files不得携带literal secret headers。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文，点击展开</summary>

该开发备注是maintainer working context；shipped behavior、limits及rationale以以上sections、package code及linked Agent Note为准。

- `src/index.ts`持有credential resolution及MCP transport composition。[Distribution Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-ranged-plus-patchset-distribution.zh.md)记录它作为complete internal DataOps dependency的原因。

</details>
