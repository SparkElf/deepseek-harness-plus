# Agent Note: 基于 resultRef 的交互式图表渲染

Status: proposed

[English](2026-08-24-resultref-interactive-chart-rendering.md) | 中文

## 问题

Harness 已经具备两项能力，因此没有必要再引入固定的图表生成工作流：模型能够调用有类型的工具，Code Mode 也能够针对工具结果临时编写短程序。DataOps 查询执行还可以把完整 SQL 结果物化到不透明的 `resultRef` 后，只向模型返回受限的预览。图表能力应该直接利用这些能力，而不是再造一套“生成 SQL、抽样、选图、调用图表模型、渲染”的固定编排框架。

真正困难的不是选择图表库。这个功能需要保留 Harness 的程序生成能力，把数据库规模的数据整形留给产生结果的查询，输出真正可交互的图表，并且在源 `resultRef` 过期之后仍然支持会话回放。同时它还必须符合现有工具展示模型：Code Mode 内的嵌套工具调用没有独立工具卡片，也不会保存工具自己的 `presentationMeta`，程序只有外层 `run_code` 结果卡片可见。

## 提案

增加一个可选的一方图表插件，暴露一个顶层模型工具，暂定名为 `render_chart`。目标流程是 `DataOps 查询 -> 一个 chart-ready resultRef -> 可选 Code Mode 转换 -> 顶层 render_chart -> 浏览器交互式图表`。图表渲染器使用 ECharts，并把最终可 JSON 序列化的 ECharts option 保存为可回放的展示元数据。

Harness 保留编写代码读取和整理所选结果的自由。功能不会试图静态禁止 `map`、`filter`、`sort`、`reduce`、派生统计量、宽长表转换、标注、日期转换、数字转换、series 构造或其他面向可视化的处理。产品规则更窄：单个源结果应该已经在合适的展示粒度上包含图表所需的业务数据。如果源结果明显仍是数据库规模的明细，或者要回答用户问题还需要 join 和大量聚合，Agent 应重新生成更合适的 DataOps 查询，而不是在可视化代码里重新实现数据引擎。

简单场景不要求 Code Mode。模型可以直接根据结果预览构造有效 option，并调用 `render_chart`。当通过程序生成 option 更容易得到正确结果时，Code Mode 才体现价值，例如动态发现 series、类型归一化、数据 reshape、派生可视化统计、标注、条件标记或更复杂的 ECharts 配置。

### 源结果约定

一张图只关联一个 DataOps `resultRef`。这个结果在其生命周期内应保持不可变，并且包含可视化所需的全部业务行和字段。多来源 join 应在产生结果的 DataOps 查询中完成，先得到一个新的单一 resultRef，再进入图表生成。

`resultRef` 是来源凭据而不是会话回放的数据源。构图过程中 Harness 可以通过已有 DataOps MCP 结果工具分页读取该结果。图表插件不增加 DataOps OAuth、SQL 执行、join、grouping、结果分页或结果生命周期逻辑；DataOps 集成插件和通用 MCP 客户端仍负责访问 DataOps 工具。

可视化代码可以执行为了准确表达而需要的轻量转换，例如把文本数字转为数值、解析日期、重命名展示字段、排序类别、把宽表转换成 series、计算百分比或参考均值、生成累计或对比叠加、筛掉无效行。这些能力不会被编码成一套封闭的图表 transformation DSL。

如果结果的业务粒度不对、正确回答需要不同筛选或分组、或者明细量明显不适合目标图表，Agent 应重新查询 DataOps。这是一条 Agent 使用原则，而不是运行时禁令；首版不增加 AST 检查器、聚合检测器、自动抽样器或图表专用查询规划器。

### Harness 与 Code Mode

Code Mode 直接消费有类型的工具返回值，因此程序可以分页调用 `read_query_result`、检查字段与数据行，并计算出 JSON ECharts option，而不需要解析 Native 文本。这保留了通用 Code Mode 编程模型，不引入图表专用执行引擎。

首版不会依赖 Code Mode 内部的嵌套 `render_chart` 来展示图表。现有 Code Mode 约定不给嵌套工具调用独立结果卡片，并跳过它们的展示元数据。如果使用 Code Mode，程序返回可 JSON 序列化的 option，模型随后再发起一次顶层 `render_chart` 调用。这样图表继续走普通可见工具路径，也不需要修改 agent-loop 或 Code Mode 生命周期。

chart-ready 结果集应使 option 足够小，可以实际作为顶层工具参数传递。如果真实工作负载后续证明大规模交互数据导致 Code Mode 到工具的 JSON 往返成本明显不可接受，可以基于测量结果再设计不透明的 prepared-chart handle。首版不预先增加 chart store、特殊 Code Mode 转发协议或第二套执行 runtime。

### 工具输入与 canonical value

初始工具约定有意贴近渲染器，而不是先定义一套很窄的自研可视化 DSL。必填字段是源结果引用和一个可 JSON 序列化的 ECharts option；如果有助于通用工具展示，可以附带可选的人类可读标题。

```ts
interface RenderChartInput {
  sourceResultRef: string
  option: JsonValue
  title?: string
}
```

实现时会按照仓库约定确定精确的 branded identifier 与 schema。`option` 不包含 JavaScript 函数，因为 canonical 工具值和持久化元数据都是 JSON。这是现有 Code Mode 与持久化约定的自然结果，而不是额外为 ECharts 建一层 sandbox。formatter lambda 等函数回调因此不属于首版；声明式 ECharts 能力仍然可用。

工具的 canonical 返回值保持紧凑并对模型有用，例如返回源引用和图表摘要。完整的可回放 option 放入 `presentationMeta`，不再重复进面向模型的 Native 文本。

### 交互式渲染

浏览器插件为 `render_chart` 注册 keyed tool view，并使用 ECharts 渲染保存后的 option。渲染器负责响应式尺寸、resize 监听、在 option 未明确覆盖展示样式时适配亮/暗模式，以及工具行卸载时释放 ECharts 实例。

option 可以使用普通 JSON 可配置的 ECharts 交互能力，包括 tooltip、legend 选择、axis pointer、inside/slider data zoom、适用 series 下的 brush、`visualMap`、`markLine`、`markPoint`、stack、area style、dataset 和 encode mapping。只要底层 JSON option 能准确表达有价值的图，就不应该人为把插件限制成 bar/line/pie/scatter 四种图。

UI 应把图表作为主要工具结果直接展示，而不是藏在通用工程详情里。原始 option 与 provenance 可以作为次级或折叠信息。图表必须在窄宽度和两种支持的外观模式下可用。

### 回放与源结果过期

成功生成的图表在会话回放时不能依赖 DataOps `resultRef` 仍然存活。DataOps 结果引用有自己的过期时间，而 Harness 会话是持久化的。因此工具把最终 JSON option 连同完成图表所需的 dataset 或 series data 一并保存到可回放的展示元数据；`sourceResultRef` 只作为 provenance 保留。

这与 Harness 会话中其他合法读取信息的产品级保留语义一致：DataOps 在允许读取结果时完成授权检查；派生图表数据合法进入持久会话之后，记录结果可以从 session 重建。首版不尝试在后续 DataOps 权限变化后追溯删除已经写入会话的内容。

### 包与组合方式

实现应遵循现有包命名和所有权规则，作为可选插件包存在。它通过已有扩展点注册工具和浏览器 tool view，不修改 `agent-loop`。面向产品的实现需要正常的 package README、实现后更新 Agent Note 生命周期，并增加真实 Loader composition test。

图表插件与 DataOps 认证保持独立。它只把 `sourceResultRef` 当 provenance，并渲染提供的 ECharts option。DataOps 专属数据获取继续通过已经组合进来的 MCP 工具完成，这样未来即使扩展其他 prepared dataset，也不需要把查询业务逻辑搬进 DSH 图表包。

## 考虑过的替代方案

**采用 WrenAI 式固定图表生成 pipeline。** 不采用，因为 Harness 已经有可编程的工具组合层。再增加一个“接收问题和 SQL、抽样、调用另一层图表 LLM、输出 Vega spec”的服务，会重复编排并削弱 Agent 根据实际结果临时编写可视化程序的能力。

**定义窄自研 Chart DSL，再映射到 Recharts。** 不作为主约定，因为常见的 ECharts 交互和分析能力都需要等 DSH DSL 逐项扩展后才能使用。如果实践证明完整 JSON option 对模型确实难以稳定生成，可以以后再增加更窄的 helper，但初始设计优先保证图表准确性和 Harness 程序生成能力。

**禁止可视化代码读取 rows 或使用 reduce。** 不采用，因为类型转换、reshape、参考线、百分比、累计值和标注都可能需要真实计算。更有用的区分是：数据库规模的业务整形属于 DataOps SQL，面向可视化的计算允许 Harness 执行。

**一张图允许多个 resultRef。** 不采用，因为这样会让可视化代码承担跨结果 join，也会让 provenance 更难理解。DataOps 已经负责查询执行，可以先产生单一 join/聚合结果。

**回放时重新读取 resultRef。** 不采用，因为 DataOps 结果生命周期短于 Harness 持久历史，后续授权和可用性也可能变化。可见图表必须从 session 自己的展示元数据回放。

**首版增加 ChartArtifact store。** 不采用，因为最终 JSON option 本身已经是完整回放载荷，已有工具展示元数据就是自然持久化位置。只有实测图表载荷超过 session metadata 的实际承受范围时，独立 store 才有依据。

## 验收标准

- 一个一方可选插件暴露顶层 `render_chart` 工具和浏览器 tool view，并且不修改 `agent-loop`。
- 正常流程只使用一个 DataOps `resultRef`，可以选择通过 Code Mode 处理其 rows，然后渲染可 JSON 序列化的 ECharts option。
- Code Mode 对合理的可视化计算保持自由；仓库文档要求在结果粒度错误时重新查询，而不是在可视化代码中执行数据库规模的数据整形。
- 浏览器输出具有交互性，并且在 option 配置后支持 tooltip、legend 选择、zoom 等普通声明式 ECharts 交互。
- 最终 option 与所需数据通过工具展示元数据持久化，因此 replay、resume、fork 不要求源 resultRef 继续存活。
- 首版 UI 不依赖 Code Mode 内部嵌套的 chart 调用；可见渲染通过顶层工具调用完成。
- 实现包含聚焦的 schema/tool 测试、浏览器 renderer 测试、回放覆盖、窄宽度与外观模式覆盖，以及真实 Loader composition test。
- 面向产品的文档解释模型工作流，并清楚区分 chart-ready 查询结果与可视化导向代码。

## 风险

完整 JSON ECharts option 比自研 DSL 暴露更大的配置面，因此模型仍可能生成无效或视觉效果不佳的 option。实现应依靠正常工具输入验证和 ECharts 错误，而不是提前建立推测性的修复 pipeline；只有反复出现且有证据的错误模式才值得后续增加 helper。

较大的 chart-ready 数据仍可能形成较大的工具参数和持久化元数据，尤其 Code Mode 需要先返回完整 option，再由模型发起顶层工具调用。首版接受这个成本以保持架构简单，并在增加 prepared-chart handle 或外部 chart storage 前先测量真实工作负载。

把派生图表数据保存进 Harness session，意味着后续 DataOps 权限撤销不会自动删除已经记录的图表。这与普通持久会话语义一致，但必须在产品文档和未来的数据保留策略设计中保持明确。
