# @deepseek-ai/dsh-tool-chart

English | [中文](README.zh.md)

Optional product plugin that exposes `render_chart` on the Host and a keyed interactive ECharts tool view in the Web client. It is deliberately a renderer, not a query engine: Harness prepares a complete JSON-serializable ECharts option from one chart-ready result, optionally using Code Mode, then calls the visible top-level tool.

## API

The Host entry registers:

```ts
render_chart({
  sourceResultRef: string,
  option: JsonValue,
  title?: string,
})
```

`sourceResultRef` identifies the single query result used to prepare the chart and is retained as provenance. `option` is the complete ECharts option, including all dataset/series data needed to reconstruct the chart after the source result expires. The canonical tool return stays small; the complete option is persisted on `tool/result.meta` through `output.presentationMeta()`.

The browser `./client` entry registers the keyed `tool.call.toolview` implementation for `render_chart`. Completed rows initialize ECharts from persisted metadata, observe container resizing, follow the Harness light/dark theme, and dispose the ECharts instance when the row unmounts.

The package also exports `./invariant`. The tool owns no independent state/event relation beyond ordinary `tool/result` metadata, so its package invariant installer is intentionally empty.

## Model Experience

Use this tool when the user wants an interactive visualization of an already prepared result. Prefer one DataOps SQL result whose rows are already at the business/display granularity the chart needs. Simple cases may call `render_chart` directly. When dynamic series, reshaping, date/number conversion, percentages, cumulative/reference statistics, annotations, or other visualization-oriented work makes the chart more accurate, Code Mode may read the one result and synthesize the ECharts option programmatically.

Do not force Code Mode to be a passive field mapper. Normal `map`, `filter`, `sort`, `reduce`, reshaping, and derived visual statistics are valid. If the result still requires database-scale joins or substantial business aggregation, issue a better DataOps query instead of rebuilding the query engine inside chart code.

Current Code Mode nested tool calls have no independent card and skip tool-owned presentation metadata. The visible version-one flow is therefore `run_code -> option JSON -> top-level render_chart` rather than a nested chart call.

## Replay semantics

DataOps result references may expire sooner than Harness sessions. History therefore never needs to re-read `sourceResultRef`: the complete final JSON option is durable presentation metadata and is sufficient to redraw the chart. The source reference remains only provenance after the successful tool result has been recorded.

## Known Limitations and Deferred Work

- ECharts options must be lossless JSON. JavaScript formatter/event callback functions are not part of the version-one durable contract.
- The version-one tool accepts the complete option as an argument. Very large interactive datasets may make the Code Mode-to-tool JSON round trip expensive; add a prepared-chart handle or separate artifact store only after real measurements justify one.
- One chart is associated with one source result. Cross-result joins belong in the query that creates a new chart-ready result.
- The plugin does not execute SQL, read DataOps credentials, page resultRefs, or automatically repair invalid ECharts options.
