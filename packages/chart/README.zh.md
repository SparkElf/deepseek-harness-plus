# chart/ — 交互式可视化能力系列

[English](README.md) | 中文

为模型已经准备好的结果提供交互式数据可视化。首个产品包把查询执行留在 renderer 之外，并允许 Harness 在程序生成更容易得到准确交互 option 时继续使用普通 Code Mode。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`tool-chart/`](tool-chart/README.zh.md) | 注册 `render_chart` 以及可回放的 ECharts Web 视图。 | `ctx.tools` + keyed `tool.call.toolview` |

子包 README 负责工具、回放、Code Mode 与 renderer 约定。
