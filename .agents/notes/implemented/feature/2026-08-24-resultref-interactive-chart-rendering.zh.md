# Agent Note: 基于 resultRef 的交互式图表渲染

Status: implemented

[English](2026-08-24-resultref-interactive-chart-rendering.md) | 中文

## 问题

Harness 已经具备可编程的工具组合层：模型可以直接调用有类型的工具，Code Mode 也能针对 canonical 工具结果临时编写短程序。DataOps 还会把完整 SQL 结果物化到不透明的 `resultRef` 后，因此图表功能不需要再建立一套固定编排 pipeline，重复生成 SQL、抽样、选图并调用另一层图表 LLM。

产品真正需要的是准确的交互式渲染面，同时保留 Harness 程序生成能力，把数据库规模的数据整形留给产生结果的查询，并在源结果过期后仍然可以回放。

## 实现

交互式图表按照 Web 产品已经存在的两种生命周期拆成两个包：

- `@deepseek-ai/dsh-tool-chart` 属于 agent plane，在 shipped agent preset 中注册面向模型的 `render_chart` 工具。
- `@deepseek-ai/dsh-client-ui-chart` 属于 browser plane，注册 keyed `render_chart` 工具视图，并负责 ECharts 初始化、尺寸／主题变化、失败展示和释放。

两个包在 runtime 不互相依赖。它们的共享边界只是普通、持久化的 `tool/result.meta`：Host 工具产生，conversation model 回放，Browser 读取。

shipped `standard`、`code` 与 `cordis` preset 都挂载 `dsh-tool-chart`；Web browser roster 挂载 `dsh-client-ui-chart`。`minimal` preset 继续保持真正的 minimal，不增加图表能力。

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

源结果应该已经在合适的展示粒度上包含图表所需的业务行与字段。如果正确可视化仍然需要数据库规模的 join 或大量业务聚合，Agent 应重新发起更合适的 DataOps 查询，产生新的结果，而不是在可视化代码里重新实现查询引擎。

这是一条 Agent 使用原则，不是 runtime 禁令。Code Mode 仍然可以正常使用 `map`、`filter`、`sort`、`reduce`、reshape、数字／日期转换、动态 series、百分比、累计／参考值、标注以及其他能够提高图表准确性的可视化导向计算。

## 工具约定

`render_chart` 接受一个源结果引用、一个 ECharts option 和可选标题：

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

成功记录后，`sourceResultRef` 只是 provenance；浏览器不会通过这个引用重新读取 DataOps。

由于 canonical 工具值和 durable metadata 都是 lossless JSON，function-valued ECharts callback 不属于首版。普通声明式 ECharts 配置仍然可用，包括 tooltip、legend interaction、axis pointer、zoom、适用场景下的 brush、`visualMap`、mark、stack、dataset 与 encode mapping。

## Code Mode 展示边界

当前 Code Mode 的 nested dispatch 没有独立结果卡片，也会跳过 nested tool 自己的 `presentationMeta`。因此首版可见路径是：

```text
run_code -> JSON ECharts option -> 顶层 render_chart
```

实现没有为了省掉这一步就修改 `agent-loop`，也没有建立 chart-only 的 nested presentation protocol。`code` preset 仍然把 `render_chart` 放进生成 SDK，这样 Harness 在 Code Mode 中准备 option 时可以看到最终工具约定。

## 浏览器展示与回放

`dsh-client-ui-chart` 以 `render_chart` 为 key 注册 `tool.call.toolview`。完成后的结果会收窄 version-1 metadata，从保存的 option 初始化 ECharts，监听容器尺寸，在初始化／重初始化时跟随 Harness body 的 dark-theme attribute，并随 React 工具行卸载释放 ECharts instance。

pending、failed 与无效 replay metadata 都有紧凑的本地化状态，同时保留普通 tool inspection。成功状态下，图表本身是主要工具展示，而不是 raw JSON card。

DataOps resultRef 的生命周期可能短于 Harness session。因此回放永远不会重新读取 resultRef：最终 ECharts option 已经包含完成图表所需的数据，并随 session 的 tool result metadata 一起持久化。resume 与 fork 都从这个 durable option 重建相同图表。

## Composition 与文档

新的 `packages/chart/` capability group 负责面向模型的 chart tool。浏览器 renderer 按已有 client package 约定放在 `packages/client/ui-chart/`。两个包都拥有 README、package invariant、TypeScript project reference 和聚焦测试；根 package map 与双语 pairing 也登记了新能力。

Web bundle 依赖并挂载 `dsh-client-ui-chart`；CLI package 依赖 `dsh-tool-chart`，使 shipped agent-preset composition 能解析这个包。shipped preset test 分别固定了 standard 精确 catalog 中的 `render_chart`、code preset 生成 SDK 中的 `render_chart`，以及 cordis preset 继承 standard toolset 时仍然保留 `render_chart`。

## 测试

聚焦覆盖包括：

- 紧凑 Host canonical success 与完整 durable presentation metadata；
- 空 source provenance reference 被拒绝；
- `dsh-tool-chart` 的真实 Cordis Loader composition；
- keyed browser slot 注册与释放；
- 从 replay metadata 调用 ECharts `setOption` 并在卸载时 dispose；
- 缺失／无效 replay metadata 时不初始化 ECharts；
- standard、code、cordis 三个 shipped composition 的图表工具可用性。

Host 与 Client TypeScript aggregate 分别引用自己的 chart package。Web bundle roster 持有 browser package，因此历史回放不依赖当前 session 选择了哪个 agent preset。

## 不采用的替代方案

**WrenAI 式固定 chart pipeline。** Harness 已经有通用程序生成和 typed tool composition；再增加“抽样数据并调用另一层 chart LLM”的服务会重复编排，也降低 Agent 自适应能力。

**自研窄 Chart DSL 映射 Recharts。** 这会让大量有用交互与分析能力必须等待 DSH DSL 逐项扩展。首版直接接受 durable JSON ECharts option。

**禁止可视化代码读取 rows 或使用 reduce。** 这会阻止类型归一化、reshape、参考值、百分比、标注和动态 series 等有用计算。数据库规模整形属于 SQL，但面向可视化的计算仍然是 Harness 能力。

**一张图允许多个 resultRef。** 跨 result join 会把数据整合责任推给可视化程序，也让 provenance 更难理解。DataOps 应先产生一个 join／聚合后的 chart-ready result。

**回放时重新读取 resultRef。** 源结果寿命和后续权限可能与 durable session history 不同，记录下来的图必须自包含。

**首版就增加 ChartArtifact store 或 prepared-chart handle。** JSON option 本身已经是完整 durable replay payload；只有真实图表尺寸证明现有工具参数／metadata 路径不够时，独立存储才有依据。

## Known Limitations and Deferred Work

- 很大的交互数据集可能让 Code Mode 到工具的 JSON 往返和 durable option 变贵。当前实现先测量真实使用，再决定是否增加 opaque prepared-chart handle 或独立存储。
- JSON 结构合法但 ECharts 语义无效的 option 仍可能在浏览器渲染时报错；产品展示失败和 inspection，不增加推测性 repair pipeline。
- function-valued formatter／event callback 首版无法持久回放。
- 一张图关联一个源结果。未来如果支持非 DataOps prepared dataset（例如文档表格可视化），应明确设计对应 contract，而不是伪造 DataOps resultRef。
