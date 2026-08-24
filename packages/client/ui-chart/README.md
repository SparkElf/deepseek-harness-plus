# @deepseek-ai/dsh-client-ui-chart

English | [中文](README.zh.md)

Browser-only presentation plugin for `render_chart` results. The Host tool lives in [`@deepseek-ai/dsh-tool-chart`](../../chart/tool-chart/README.md); this package owns only the Web keyed tool view and ECharts lifecycle, matching the browser boot plane.

The renderer is opt-in and is not mounted by the default Web browser roster. A deployment that enables `dsh-tool-chart` adds this browser plugin separately when it wants durable chart results to render as interactive ECharts views instead of the generic tool presentation.

## API and extension point

The `./client` entry registers a localized component under the existing keyed `tool.call.toolview` slot with key `render_chart`. It consumes durable `tool/result.meta` shaped as version 1 chart metadata and initializes ECharts from the stored JSON option.

The renderer observes its container size, follows the Harness light/dark appearance when ECharts is initialized, and disposes the chart instance on unmount. Completed chart data is read entirely from durable presentation metadata, so replay does not require the original DataOps resultRef to remain live.

The package exports a no-op Host entry and `./invariant` because browser-only packages still participate in normal Loader/package ownership checks.

## Model Experience

This package is not model-facing by itself. Together with `dsh-tool-chart`, it makes the model's top-level `render_chart` call appear as the interactive chart rather than generic raw tool JSON. Harness may prepare that option directly or through Code Mode; this browser package does not constrain how visualization-oriented calculations were produced.

## Known Limitations and Deferred Work

- Version one renders JSON-serializable ECharts options; function-valued formatters and event callbacks are not replayable.
- Invalid ECharts options fail at render time and expose a concise failed state plus normal tool inspection; there is no speculative option-repair pipeline.
- Extremely large options may be expensive to retain and render. A prepared-chart handle or separate artifact store is deferred until real measurements justify it.
- The package does not query DataOps, read resultRefs, execute SQL, or own chart data acquisition.
