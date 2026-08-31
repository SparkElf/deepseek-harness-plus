---
description: "durable document intake、MinerU parsing、bounded model projection以及composer、Chat、Trajectory cards。"
kind: "package-reference"
---

# @sparkelf/dsh-plugin-document-attachments

[English](README.md) | 中文

## 概述

该完整Host及Client plugin持有document wire admission、provider-neutral parser Service及MinerU HTTP provider、browser transport及localized validation、deterministic model delimiters，以及composer、Chat和Trajectory cards。配合independently retireable official-source patch，Plus接受PDF、DOCX、PPTX及XLSX files，persist original及parsed artifacts，记录document blocks、project bounded Markdown，并在Better Sidebar中打开每个durable card的parsed Markdown。

## 目录

- [使用此软件包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制和延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此软件包

把`DSH_MINERU_ENDPOINT`设为absolute synchronous MinerU `/file_parse` URL。Plus profile会mount 1 MiB direct-Markdown budget及带120-second timeout和64 MiB response limit的MinerU provider；缺少endpoint时两行保持disabled，且不会advertise incomplete capability。

Chat及Trajectory cards使用parsed-Markdown attachment id作hidden Better Sidebar tab的content address。Better Sidebar打开并显示该tab；Document plugin通过Session-authorized attachment read operation解析该地址并渲染Markdown，不暴露attachment store的physical path。

-----

<a id="model-experience"></a>
## 模型体验

### Durable document content

#### 模型看到什么

每个accepted document只贡献`parsed.modelText`，并用deterministic delimiters包裹original name及media type。Parser paths、raw Office archives、content-list JSON及extracted images不会进入model context。

#### Token 影响

Document向其user message加入bounded UTF-8 model-text length及fixed delimiter text。Aggregate rendered bytes会在admission前检查。

#### KV Cache 影响

一个durable parser result产生deterministic model text。Later turns可复用包含该document的unchanged user-message prefix。

## 已知限制和延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Temporary official integration patch**：selected official revision只暴露image attachment integration；`@sparkelf/dsh-patch-document-attachments`会提供generic storage、durable content、model projection、mixed draft intake、Host limits、file selection、authorized reads及presentation slots，直到official DSH发布equivalent points。
- **Semantic preview**：sidebar对所有supported Document formats显示parser-produced Markdown；它不会复现original PDF pagination或Office layout。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文，点击展开</summary>

该开发备注是maintainer working context；shipped behavior、limits及rationale以以上sections、package code及linked Agent Note为准。

- `src/index.ts`和`src/mineru.ts`持有admission及parsing；`src/client`持有intake、cards及sidebar preview。[Preview Agent Note](../../../.agents/notes/implemented/feature/2026-08-31-session-authorized-document-preview.zh.md)持有content-address decision，[Distribution Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-ranged-plus-patchset-distribution.zh.md)持有patch retirement rule。

</details>
