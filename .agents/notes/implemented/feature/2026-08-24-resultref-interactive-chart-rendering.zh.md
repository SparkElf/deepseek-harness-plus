# Agent Note: 基于 resultRef 的交互式图表渲染

Status: implemented

[English](2026-08-24-resultref-interactive-chart-rendering.md) | 中文

## 问题

Harness 已经具备可编程的工具组合层：模型可以直接调用有类型的工具，Code Mode 也能针对 canonical 工具结果临时编写短程序。DataOps 还会把完整 SQL 结果物化到不透明的 `resultRef` 后，因此图表功能不需要再建立一套固定编排 pipeline，重复生成 SQL、抽样、选图并调用另一层图表 LLM。

产品需要的是准确的交互式渲染面，同时保留 Harness 程序生成能力，把数据库规模的数据整形留给产生结果的查询，并在源结果过期后仍然可以回放。

## 决定

交互式图表由两个一方可选插件组成，分别遵循 agent plane 与 browser plane 已有的生命周期。`@deepseek-ai/dsh-tool-chart` 注册面向模型的 `render_chart` 工具；`@deepseek-ai/dsh-client-ui-chart` 注册 keyed `render_chart` Web 视图，并负责 ECharts 初始化、尺寸／主题变化、失败展示和释放。

两个包都不会挂载到 shipped standard agent preset 或默认 Web browser roster。需要交互式图表的 deployment 要在目标 agent preset 中显式组合 tool package，并在 Web client roster 中显式组合 browser renderer。这样图表能力始终可移除，也不会让 ECharts 依赖无条件进入每一个默认 Web composition。

两个包在 runtime 不互相依赖。它们唯一的共享接口是 Host 工具产生、conversation model 回放的普通 durable `tool/result.meta`；即使没有 browser plugin，工具仍保留紧凑的 generic Native presentation。

## Model workflow

一张图严格关联一个 chart-ready DataOps `resultRef`：

```text
DataOps execute_sql
  -> 一个 chart-ready resultRef
  -> 可选 Code Mode 读取该结果并生成 ECharts option
  -> 顶层 render_chart(sourceResultRef, option)
  -> option 持久化到 tool/result.meta
  -> Browser 用 ECharts 渲染／回放
```

源结果已经在合适的展示粒度上包含图表需要的业务行与字段。如果正确可视化仍然需要数据库规模的 join 或大量业务聚合，Agent 应重新发起更合适的 DataOps 查询并产生新的结果，而不是在可视化代码里重新实现查询引擎。

这是一条 Agent 使用原则，不是 runtime 禁令。Code Mode 仍然可以正常使用 `map`、`filter`、`sort`、`reduce`、reshape、数字／日期转换、动态 series、百分比、累计／参考值、标注以及其他能够提高图表准确性的可视化导向计算。

## 工具约定

`render_chart` 接受一个源结果引用、一个 JSON ECharts option 和可选标题：

```ts
interface RenderChartArgs {
  sourceResultRef: string
  option: JsonValue
  title?: string
}
```

参数 schema 要求 `option` 根节点是 JSON object。工具只返回一个紧凑 canonical 成功值，包含归一化后的源引用和可选标题。完整 option 不进入 Native prose，而由 `output.presentationMeta()` 写成 versioned durable metadata：

```ts
interface ChartPresentationMeta {
  version: 1
  sourceResultRef: string
  option: JsonValue
  title?: string
}
```

成功记录后，`sourceResultRef` 只是 provenance；浏览器不会再通过这个引用读取 DataOps。option 自身包含在源结果过期后重建完成图表所需的 dataset 或 series data。

canonical 工具值和 durable metadata 都是 lossless JSON，因此 function-valued ECharts callback 不属于首版。普通声明式 ECharts 配置仍然可用，包括 tooltip、legend interaction、axis pointer、zoom、适用场景下的 brush、`visualMap`、mark、stack、dataset 与 encode mapping。

## Code Mode 展示

当前 Code Mode 的 nested dispatch 没有独立结果卡片，也会跳过 nested tool 自己的 `presentationMeta`。因此首版可见路径是：

```text
run_code -> JSON ECharts option -> 顶层 render_chart
```

实现没有为了省掉这一步而修改 `agent-loop`，也没有建立 chart-only 的 nested presentation protocol。Code Mode 通过现有 typed MCP/tool return 检查结果并返回最终 JSON option；随后由顶层可见工具调用把图表记录进 session。

## 浏览器展示与回放

`dsh-client-ui-chart` 以 `render_chart` 为 key 注册 `tool.call.toolview`。完成后的结果会收窄 version-1 metadata，从保存的 option 初始化 ECharts，监听容器尺寸，在初始化或重新初始化时跟随 Harness body 的 dark-theme attribute，并随 React 工具行卸载释放 ECharts instance。

pending、failed 与无效 replay metadata 都有紧凑的本地化状态，同时保留普通 tool inspection。成功状态下，图表本身是主要展示，而不是 raw JSON card。

DataOps resultRef 的生命周期可能短于 Harness session。因此回放永远不会重新读取 resultRef：最终 ECharts option 已经包含完成图表所需的数据，并随 session 的 tool result metadata 一起持久化。resume 与 fork 都从这个 durable option 重建相同图表。

## Composition 与验证

面向模型的包位于 `packages/chart/tool-chart`，浏览器 renderer 位于 `packages/client/ui-chart`。两个包都登记进各自 TypeScript aggregate 与 repository package map，因此显式 Cordis composition 能解析它们，但不会因此把任何一个包变成 shipped default。

`dsh-tool-chart` 除聚焦工具测试外，还有真实 Cordis Loader composition test。browser package 覆盖 keyed slot 注册、replay metadata、ECharts lifecycle 与 disposal；需要完整交互展示的 deployment 通过显式 Web composition 装载 renderer。

## 考虑过的替代方案

**WrenAI 式固定 chart pipeline。** 不采用，因为 Harness 已经有通用程序生成和 typed tool composition；再增加“抽样数据并调用另一层 chart LLM”的服务会重复编排，也降低 Agent 自适应能力。

**自研窄 Chart DSL 映射 Recharts。** 不采用，因为大量有用交互与分析能力必须等待 DSH DSL 逐项扩展。首版直接接受 durable JSON ECharts option。

**禁止可视化代码读取 rows 或使用 reduce。** 不采用，因为类型归一化、reshape、参考值、百分比、标注和动态 series 都可能需要真实计算。数据库规模整形属于 SQL，但面向可视化的计算仍然是 Harness 能力。

**一张图允许多个 resultRef。** 不采用，因为跨 result join 会把数据整合责任推给可视化程序，也会让 provenance 更难理解。DataOps 应先产生一个 join 或聚合后的 chart-ready result。

**回放时重新读取 resultRef。** 不采用，因为源结果寿命和后续权限可能与 durable session history 不同，记录下来的图必须自包含。

**把图表能力挂到 shipped defaults。** 不采用，因为图表是可选产品能力，而且 browser renderer 依赖体积不小的 ECharts。显式组合可以保持默认工具 catalog 与 Web bundle 不变。

**首版就增加 ChartArtifact store 或 prepared-chart handle。** 不采用，因为 JSON option 本身已经是完整 durable replay payload；只有真实图表尺寸证明现有工具参数和 metadata 路径不够时，独立存储才有依据。

## 后果

Harness 可以直接生成丰富的交互式 ECharts option，而不需要新建 chart-specific orchestration engine；DataOps 继续负责数据库规模的查询整形，单一 resultRef 也让 provenance 容易理解。

完整回放数据会随 chart option 一起传递，因此很大的交互数据集可能让 Code Mode 到工具的 JSON 往返和 durable metadata 变贵。当前实现先测量真实使用，再决定是否增加 opaque prepared-chart handle 或独立存储。

JSON 结构合法但 ECharts 语义无效的 option 仍可能在浏览器渲染时报错，function-valued formatter 或 event callback 首版也无法持久回放。UI 展示失败状态和 inspection，不增加推测性的 repair pipeline。

需要完整交互体验的 deployment 必须同时显式组合面向模型的 tool 与 browser renderer。未来如果支持非 DataOps prepared dataset（例如文档表格可视化），应明确设计对应 contract，而不是把所有来源伪装成 DataOps resultRef。
