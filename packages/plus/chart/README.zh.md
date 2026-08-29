---
description: "面向单个chart-ready result reference的durable render_chart tool及interactive ECharts presentation。"
kind: "package-reference"
---

# @sparkelf/dsh-plugin-chart

[English](README.md) | 中文

## 概述

该完整Host及Client plugin持有`render_chart` tool及其interactive ECharts renderer。一次call接受一个opaque DataOps result reference和完整JSON-serializable ECharts option；Host记录presentation metadata及`dsh/chart` content block，Client无需重新fetch DataOps即可从Session history重建chart。

## 目录

- [使用此软件包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制和延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此软件包

在Agent-capable profile中mount该package一次。Pending、failed、unavailable及complete call都有visible state；completed chart跟随current theme，随container resize，并提供official tool-result inspect action。

-----

<a id="model-experience"></a>
## 模型体验

### `render_chart` tool

#### 模型看到什么

模型看到一个concurrency-safe `render_chart` tool。它必须提供恰好一个chart-ready `sourceResultRef`、完整replay option及optional title；compact result确认provenance及render success。

#### Token 影响

stable tool schema在enabled期间增加prefix tokens。每次call把JSON arguments及compact result加入Session history；不会注入option的第二份prose copy。

#### KV Cache 影响

tool schema保持prefix-stable，直到mounted tool set改变。Chart call会用recorded call及result扩展later request history。

## 已知限制和延期工作

<a id="known-limitations-and-deferred-work"></a>

- **JSON-only replay**：option只能包含JSON-serializable ECharts data；functions、DOM nodes、external data loaders及executable formatter callbacks不属于durable format。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文，点击展开</summary>

该开发备注是maintainer working context；shipped behavior、limits及rationale以以上sections、package code及linked Agent Note为准。

- `src/index.ts`持有tool admission及durable metadata；`src/client`持有chart rendering。[Distribution Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-ranged-plus-patchset-distribution.zh.md)记录package ownership。

</details>
