---
description: "DataOps target identity、browser PKCE authorization、credential lifecycle、authenticated MCP composition及Settings UI。"
kind: "package-reference"
---

# @sparkelf/dsh-plugin-dataops

[English](README.md) | 中文

## 概述

该完整Host及Client plugin持有一个DataOps target identity、带PKCE的browser Authorization Code、access及refresh credential lifecycle、authenticated MCP child composition及localized Settings section。privileged local routes会在request inspection前应用official Connection rejection；callback还要求one-use PKCE state。

## 目录

- [使用此软件包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制和延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此软件包

把`DSH_DATAOPS_BASE_URL`设为同时提供`/auth/dsh/authorize`及proxied `/api`的DataOps Web origin；`DSH_DATAOPS_CALLBACK_ORIGIN`可选指定non-loopback DSH browser origin。Browser contribution仅在Host plugin inventory报告对应`plus-dataops` entry有效启用时注册；若环境条件禁用Host，已安装package保持inert，不请求不存在的route。该package把delegated access token及stable target identity存入`dataops_access_token`与`dataops_target_ref`；DataOps把token lifetime绑定到authenticated browser session。Current grant过期或其browser session被revoke时，DataOps Client contribution会弹出带**稍后**与**重新登录**的DSH shell modal；后者从用户手势打开real OAuth popup。Settings也会把rejected stored grant与never-connected state区分，并保留同一个恢复动作。Authentication-rejected MCP call仍是agent turn内的error result，不会终止task；Plus不会自动重放结果未知的tool operation。Disconnect会revoke account tokens但保留target identity。OAuth callback failure只在Settings暴露固定、可操作的failure stage；authorization code、state、token、upstream body及任意error text不会进入browser message。

-----

<a id="model-experience"></a>
## 模型体验

### Authorized DataOps MCP tools

#### 模型看到什么

authorization成功后，模型看到`dataops` namespace下DataOps server当前tool schemas及upstream MCP tool results。OAuth state、account data、target metadata及token values不会进入model context。

#### Token 影响

connected tool schemas增加当前prefix cost，call增加upstream arguments及results。OAuth及credential operations增加零model tokens。

#### KV Cache 影响

Connecting、disconnecting或MCP discovery change可能改变tool-schema prefix。稳定connected operation不会向该prefix加入OAuth或token metadata。

## 已知限制和延期工作

<a id="known-limitations-and-deferred-work"></a>

- **需要external authenticated account**：DataOps deployment必须实现DSH authorization及MCP endpoints并提供authenticated user session；该package不提供fallback token grant或login credential。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文，点击展开</summary>

该开发备注是maintainer working context；shipped behavior、limits及rationale以以上sections、package code及linked Agent Note为准。

- `src/index.ts`持有authorization、credentials、access expiry及MCP child lifecycle。`src/client/store.ts`与`src/client/controller.ts`持有shared browser status及OAuth lifecycle；`src/client/DataOpsExpiryModal.tsx`贡献shell prompt，`src/client/DataOpsSection.tsx`贡献Settings。[Distribution Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-ranged-plus-patchset-distribution.zh.md)记录package boundary。

</details>
