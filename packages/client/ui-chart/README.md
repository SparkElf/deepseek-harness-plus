# @deepseek-ai/dsh-client-ui-chart

English | [中文](README.zh.md)

Browser-only presentation plugin for `render_chart` results. The Host tool lives in [`@deepseek-ai/dsh-tool-chart`](../../chart/tool-chart/README.md); this package owns only the Web keyed tool view and ECharts lifecycle, matching the browser boot plane.

## API and extension point

The `./client` entry registers a localized component under the existing keyed `tool.call.toolview` slot with key `render_chart`. It validates version-one chart data from direct `tool/result.meta` or nested `dsh/chart` result content and initializes ECharts from the stored JSON option.

The renderer observes its container size, follows the Harness light or dark appearance when ECharts is initialized, and disposes the chart instance on unmount. Completed chart data is read entirely from durable direct metadata or nested result content, so replay does not require the original DataOps resultRef to remain live.

The package exports a no-op Host entry and `./invariant` because browser-only packages still participate in normal Loader/package ownership checks.

## Model Experience

### Interactive chart presentation

#### What the model sees

The model is affected only through `@deepseek-ai/dsh-tool-chart`; this browser-only package adds no model-visible text or data. It presents successful direct and nested `render_chart` results as an interactive chart instead of generic raw tool JSON.

#### Token effect

Zero direct token effect. The browser renderer does not change model requests or tool results.

#### KV Cache effect

The package does not alter model-request prefixes or append model context, so it does not invalidate an otherwise reusable provider cache prefix.

## Known Limitations and Deferred Work

- Version one renders JSON-serializable ECharts options; function-valued formatters and event callbacks are not replayable.
- Invalid ECharts options fail at render time and expose a concise failed state plus normal tool inspection; there is no speculative option-repair pipeline.
- Extremely large options may be expensive to retain and render. A prepared-chart handle or separate artifact store is deferred until real measurements justify it.
- The package does not query DataOps, read resultRefs, execute SQL, or own chart data acquisition.
