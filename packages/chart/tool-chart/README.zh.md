# @deepseek-ai/dsh-tool-chart

[English](README.md) | 中文

Agent plane 的产品插件，负责暴露 `render_chart`。它有意是展示工具而不是查询引擎：Harness 从一个 chart-ready 结果准备完整、可 JSON 序列化的 ECharts option，必要时使用 Code Mode，然后调用可见的顶层工具。浏览器渲染由独立的 [`@deepseek-ai/dsh-client-ui-chart`](../../client/ui-chart/README.zh.md) 负责。

这个包是 opt-in，不会由 shipped default agent preset 自动挂载。需要 `render_chart` 的 deployment 在目标 agent preset 中显式加入它；如果 Web UI 还要显示交互式图表，则再独立组合 browser renderer。

## API

插件注册：

```ts
render_chart({
  sourceResultRef: string,
  option: JsonValue,
  title?: string,
})
```

`sourceResultRef` 标识用于准备图表的唯一查询结果，并作为 provenance 保留。`option` 是完整 ECharts option，包含源结果过期以后仍能重建图表所需的全部 dataset/series 数据。canonical 工具返回保持很小；完整 option 通过 `output.presentationMeta()` 持久化到 `tool/result.meta`。

包还导出 `./invariant`。图表工具除普通 `tool/result` metadata 外没有自己独立的状态／事件关系，因此包级 invariant installer 有意为空。

## Model Experience

当用户希望把一个已经准备好的结果渲染成交互式图表时使用此工具。优先让一个 DataOps SQL 结果直接处在图表需要的业务／展示粒度。简单场景可以直接调用 `render_chart`；如果动态 series、reshape、日期／数字转换、百分比、累计／参考统计、标注或其他可视化导向计算能让图表更准确，Code Mode 可以读取这个唯一结果并用程序生成 ECharts option。

不要为了架构形式而把 Code Mode 限制成被动字段映射器。普通 `map`、`filter`、`sort`、`reduce`、reshape 和派生可视化统计都是允许的。如果结果还需要数据库规模的 join 或大量业务聚合，应重新发起更合适的 DataOps 查询，而不是在图表代码里重新实现查询引擎。

当前 Code Mode 的 nested tool call 没有独立卡片，也不会保存工具自己的 presentation metadata。因此首版可见流程是 `run_code -> option JSON -> 顶层 render_chart`，而不是在 Code Mode 内部嵌套调用图表工具。

## 回放语义

DataOps resultRef 的生命周期可能短于 Harness session。因此历史回放不需要重新读取 `sourceResultRef`：完整最终 JSON option 本身就是持久展示 metadata，浏览器包可以直接据此重新绘制图表。成功工具结果写入后，源引用只继续作为 provenance 存在。

## Known Limitations and Deferred Work

- ECharts option 必须是 lossless JSON。JavaScript formatter／event callback function 不属于首版持久化约定。
- 首版把完整 option 作为工具参数传递。非常大的交互数据集可能让 Code Mode 到工具的 JSON 往返变贵；只有真实测量证明需要时，再增加 prepared-chart handle 或独立 artifact store。
- 一张图只关联一个源结果。跨结果 join 应在查询阶段完成并生成新的 chart-ready result。
- 插件不执行 SQL、不读取 DataOps credential、不分页读取 resultRef、不渲染浏览器 UI，也不自动修复无效 ECharts option。
