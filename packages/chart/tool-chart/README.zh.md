# @deepseek-ai/dsh-tool-chart

[English](README.md) | 中文

Agent plane的产品插件，负责暴露`render_chart`。它有意是展示工具而不是查询引擎：Harness从一个chart-ready结果准备完整、可JSON序列化的ECharts option，直接或通过Code Mode调度图表工具。浏览器渲染由独立的[`@deepseek-ai/dsh-client-ui-chart`](../../client/ui-chart/README.md)负责，与shipped agent preset和Web boot的真实生命周期保持一致。

## API

插件注册：

```text
render_chart({
  sourceResultRef: string,
  option: JsonValue,
  title?: string,
})
```

`sourceResultRef`标识用于准备图表的唯一查询结果，并作为provenance保留。`option`是完整ECharts option，包含源结果过期以后仍能重建图表所需的全部dataset/series数据。canonical工具返回保持很小。直接调用通过`output.presentationMeta()`把完整option持久化到`tool/result.meta`；Code Mode nested调用把同一projection追加为dispatch结果content中的`dsh/chart` block。

包还导出 `./invariant`。图表工具除普通 `tool/result` metadata 外没有自己独立的状态／事件关系，因此包级 invariant installer 有意为空。

## Model Experience

### `render_chart` schema and result

#### What the model sees

当选中preset包含本包时，模型会看到生成的[`render_chart` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-chart)。该工具用于把一个已准备结果展示成交互式图表。优先让DataOps结果直接处在图表需要的业务和展示粒度。Code Mode可在nested SDK dispatch前进行普通映射、过滤、排序、归并、reshape、类型转换、派生可视化统计和标注；数据库规模join和业务聚合仍属于查询工作。canonical结果保持紧凑。直接调用把完整option保存在presentation metadata中，nested调用把同一个validated projection追加为`dsh/chart`结果content。回放不重新读取`sourceResultRef`：任一durable位置中的完整最终JSON option都能在源结果过期后重绘图表，源引用只作为provenance保留。

#### Token effect

条件性影响。preset向每个适用model request贡献`render_chart` schema及其参数说明。每次成功调用只把紧凑canonical result追加到model-visible tool output；完整ECharts option保留为durable presentation data。

#### KV Cache effect

选中的preset和package版本不变时，tool schema保持稳定并保留可复用request prefix。每次图表调用在该prefix后追加新的紧凑结果，不替换较早的request token。

## Known Limitations and Deferred Work

- ECharts option 必须是 lossless JSON。JavaScript formatter／event callback function 不属于首版持久化约定。
- 首版把完整 option 作为工具参数传递。非常大的交互数据集可能让 Code Mode 到工具的 JSON 往返变贵；只有真实测量证明需要时，再增加 prepared-chart handle 或独立 artifact store。
- 一张图只关联一个源结果。跨结果 join 应在查询阶段完成并生成新的 chart-ready result。
- 插件不执行 SQL、不读取 DataOps credential、不分页读取 resultRef、不渲染浏览器 UI，也不自动修复无效 ECharts option。
