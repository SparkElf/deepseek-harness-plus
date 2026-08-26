# chart/ — 交互式可视化能力系列

[English](README.md) | 中文

为模型已经准备好的结果提供交互式数据可视化。查询执行留在该能力之外，而当程序生成更容易得到准确交互 option 时，Harness 可以继续使用普通 Code Mode。面向模型的工具属于 agent plane，ECharts renderer 属于浏览器 UI 包。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`tool-chart/`](tool-chart/README.md) | Agent plane 的 `render_chart` 工具；记录完整、可回放的 JSON option metadata。 | `ctx.tools` |
| [`../client/ui-chart/`](../client/ui-chart/README.md) | Browser plane 的 keyed ECharts 展示，用于持久 `render_chart` 结果。 | keyed `tool.call.toolview` |

子包 README 负责工具、回放、Code Mode 与 renderer 约定。
