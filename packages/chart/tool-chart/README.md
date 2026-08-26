# @deepseek-ai/dsh-tool-chart

English | [中文](README.zh.md)

Agent-plane product plugin that exposes `render_chart`. It is deliberately a presentation tool rather than a query engine: Harness prepares a complete JSON-serializable ECharts option from one chart-ready result, directly or through Code Mode, then dispatches the chart tool. Browser rendering is owned separately by [`@deepseek-ai/dsh-client-ui-chart`](../../client/ui-chart/README.md), matching the shipped agent-preset and Web boot lifecycles.

## API

The plugin registers:

```text
render_chart({
  sourceResultRef: string,
  option: JsonValue,
  title?: string,
})
```

`sourceResultRef` identifies the single query result used to prepare the chart and is retained as provenance. `option` is the complete ECharts option, including all dataset/series data needed to reconstruct the chart after the source result expires. The canonical tool return stays small. Direct calls persist the complete option on `tool/result.meta` through `output.presentationMeta()`; nested Code Mode calls append the same projection as a `dsh/chart` block in the dispatch result content.

The package also exports `./invariant`. The tool owns no independent state/event relation beyond ordinary `tool/result` metadata, so its package invariant installer is intentionally empty.

## Model Experience

### `render_chart` schema and result

#### What the model sees

When the selected preset includes this package, the model sees the generated [`render_chart` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-chart). Use the tool for an interactive visualization of one already prepared result. Prefer a DataOps result whose rows are already at the business and display granularity the chart needs. Code Mode may use ordinary mapping, filtering, sorting, reduction, reshaping, type conversion, derived visual statistics, and annotation before nested SDK dispatch; database-scale joins and business aggregation remain query work. The canonical result is compact. Direct calls keep the complete option in presentation metadata, while nested calls append the same validated projection as `dsh/chart` result content. Replay never re-reads `sourceResultRef`: the complete final JSON option in either durable location redraws the chart after the source result expires, and the source reference remains provenance.

#### Token effect

Conditional. The preset contributes the `render_chart` schema and its parameter descriptions to each applicable model request. Each successful call appends only the compact canonical result to model-visible tool output; the complete ECharts option remains durable presentation data.

#### KV Cache effect

The tool schema is stable while the selected preset and package version stay unchanged, preserving the reusable request prefix. Each chart call appends a new compact result after that prefix and does not replace earlier request tokens.

## Known Limitations and Deferred Work

- ECharts options must be lossless JSON. JavaScript formatter/event callback functions are not part of the version-one durable contract.
- The version-one tool accepts the complete option as an argument. Very large interactive datasets may make the Code Mode-to-tool JSON round trip expensive; add a prepared-chart handle or separate artifact store only after real measurements justify one.
- One chart is associated with one source result. Cross-result joins belong in the query that creates a new chart-ready result.
- The plugin does not execute SQL, read DataOps credentials, page resultRefs, render browser UI, or automatically repair invalid ECharts options.
