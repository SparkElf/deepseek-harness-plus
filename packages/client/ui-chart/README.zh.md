# @deepseek-ai/dsh-client-ui-chart

[English](README.md) | 中文

仅浏览器使用的 `render_chart` 结果展示插件。Host 工具位于 [`@deepseek-ai/dsh-tool-chart`](../../chart/tool-chart/README.zh.md)；本包只负责 Web keyed tool view 与 ECharts 生命周期，与 browser boot plane 保持一致。

## API 与扩展点

`./client` 入口在现有 keyed `tool.call.toolview` slot 下以 `render_chart` 作为 key 注册本地化组件。它读取 version 1 的持久 `tool/result.meta`，并从其中保存的 JSON option 初始化 ECharts。

renderer 监听容器尺寸，在初始化 ECharts 时跟随 Harness 亮／暗外观，并在组件卸载时释放 chart instance。完成后的图表数据完全来自 durable presentation metadata，因此历史回放不要求原 DataOps resultRef 仍然存活。

包仍然导出 no-op Host entry 与 `./invariant`，因为 browser-only package 也参与普通 Loader／package ownership 检查。

## Model Experience

本包自身不面向模型。它与 `dsh-tool-chart` 组合后，让模型顶层调用 `render_chart` 时直接显示成交互式图表，而不是通用 raw tool JSON。Harness 可以直接准备 option，也可以通过 Code Mode 生成；浏览器包不会限制这些可视化导向计算是如何产生的。

## Known Limitations and Deferred Work

- 首版渲染可 JSON 序列化的 ECharts option；function-valued formatter 与事件回调无法持久回放。
- 无效 ECharts option 在渲染时失败，UI 提供简洁失败状态与普通 tool inspection；不增加推测性的 option repair pipeline。
- 极大的 option 可能在持久化和渲染上变贵。prepared-chart handle 或独立 artifact store 等真实测量证明需要时再引入。
- 本包不查询 DataOps、不读取 resultRef、不执行 SQL，也不拥有图表数据获取。
