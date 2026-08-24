# Agent Note: ResultRef-backed interactive chart rendering

Status: implemented

English | [中文](2026-08-24-resultref-interactive-chart-rendering.zh.md)

## Problem

Harness already has a programmable tool-composition layer: models can call typed tools directly and Code Mode can write short programs over canonical tool results. DataOps also materializes complete SQL results behind an opaque `resultRef`, so charting does not need a second fixed orchestration pipeline that regenerates SQL, samples rows, chooses a chart, and calls another chart LLM.

The product needs an accurate interactive rendering surface that preserves Harness program synthesis, keeps database-scale shaping in the query that created the result, and remains replayable after the source result expires.

## Decision

Interactive charting is an opt-in pair of first-party plugins with separate agent-plane and browser-plane lifecycles. `@deepseek-ai/dsh-tool-chart` registers the model-facing `render_chart` tool, while `@deepseek-ai/dsh-client-ui-chart` registers the keyed `render_chart` Web view and owns ECharts initialization, resize/theme handling, failure presentation, and disposal.

Neither package is mounted by the shipped standard agent presets or the default Web browser roster. A deployment that wants interactive charting explicitly composes the tool in the relevant agent preset and the browser renderer in the Web client roster. This keeps the capability removable and prevents an ECharts dependency from becoming part of every default Web composition.

The two packages have no runtime dependency on each other. Their shared interface is the ordinary durable `tool/result.meta` produced by the Host tool and replayed by the conversation model; without the browser plugin, the tool still has its compact generic Native presentation.

## Model workflow

One chart is associated with exactly one chart-ready DataOps `resultRef`:

```text
DataOps execute_sql
  -> one chart-ready resultRef
  -> optional Code Mode reads that result and synthesizes an ECharts option
  -> top-level render_chart(sourceResultRef, option)
  -> option persisted in tool/result.meta
  -> browser renders/replays the option with ECharts
```

The source result already contains the business rows and fields at a useful display granularity. If correct visualization still requires database-scale joins or substantial business aggregation, the agent issues a better DataOps query and produces a new result rather than rebuilding a query engine inside visualization code.

This is agent guidance, not runtime policing. Code Mode remains free to use `map`, `filter`, `sort`, `reduce`, reshaping, numeric/date conversion, dynamic series discovery, percentages, cumulative/reference values, annotations, and other visualization-oriented computation when that makes the chart more accurate.

## Tool contract

`render_chart` accepts one source result reference, one JSON ECharts option, and an optional title:

```ts
interface RenderChartArgs {
  sourceResultRef: string
  option: JsonValue
  title?: string
}
```

The parameter schema requires `option` to be a JSON object. The tool returns only a compact canonical success value containing the normalized source reference and optional title. The complete option stays out of Native prose and is written by `output.presentationMeta()` as versioned durable metadata:

```ts
interface ChartPresentationMeta {
  version: 1
  sourceResultRef: string
  option: JsonValue
  title?: string
}
```

`sourceResultRef` is provenance after recording; the browser does not read DataOps through that reference. The option contains the dataset or series data required to reconstruct the finished chart after the source result expires.

Canonical tool values and durable metadata are lossless JSON, so function-valued ECharts callbacks are outside version one. Declarative ECharts configuration remains available, including tooltip, legend interaction, axis pointers, zoom, brush where supported, `visualMap`, marks, stacking, datasets, and encode mappings.

## Code Mode presentation

Current Code Mode nested dispatch has no independent result card and skips nested tool-owned `presentationMeta`. The visible version-one path is therefore:

```text
run_code -> JSON ECharts option -> top-level render_chart
```

The implementation does not change `agent-loop` or create a chart-only nested presentation protocol merely to collapse these calls. Code Mode uses the existing typed MCP/tool returns to inspect a result and return the final JSON option; the subsequent visible tool call records the chart.

## Browser presentation and replay

`dsh-client-ui-chart` registers `tool.call.toolview` with key `render_chart`. A completed result narrows version-1 metadata, initializes ECharts from the stored option, observes container resizing, follows the Harness body dark-theme attribute when initializing or reinitializing, and disposes the ECharts instance with the React row.

Pending, failed, and malformed replay metadata have compact localized states and retain normal tool inspection. The completed chart is the primary presentation rather than a raw JSON card.

DataOps result references can expire sooner than Harness sessions. Replay therefore never re-reads the resultRef: the final ECharts option includes the data required by the finished visualization and is persisted in the session's tool result metadata. Resume and fork reconstruct the same chart from that durable option.

## Composition and verification

The model-facing package lives under `packages/chart/tool-chart`; the browser renderer lives under `packages/client/ui-chart`. Both packages are registered in their TypeScript aggregates and repository package maps so explicit Cordis composition can resolve them without making either one a shipped default.

`dsh-tool-chart` has a real Cordis Loader composition test in addition to focused tool tests. The browser package has focused slot-registration, replay-metadata, ECharts lifecycle, and disposal coverage; an explicit Web composition is the deployment path for the keyed renderer.

## Alternatives considered

**A WrenAI-style fixed chart pipeline.** Rejected because Harness already has general program synthesis and typed tool composition. A second service that samples data and invokes another chart-generation LLM would duplicate orchestration and reduce adaptability.

**A narrow custom Chart DSL mapped to Recharts.** Rejected because useful interactive and analytical capabilities would remain unavailable until the DSH DSL grew every feature. Version one accepts durable JSON ECharts options instead.

**Forbid visualization code from reading rows or using reductions.** Rejected because type normalization, reshaping, reference values, percentages, annotations, and dynamic series can require real computation. Database-scale shaping belongs in SQL, while visualization-oriented computation remains a Harness capability.

**Allow multiple resultRefs per chart.** Rejected because cross-result joins make the visualization program responsible for data integration and obscure provenance. DataOps produces one joined or aggregated chart-ready result first.

**Replay by reading resultRef again.** Rejected because result lifetime and later authorization can differ from durable session history. The recorded chart is self-contained.

**Mount charting in shipped defaults.** Rejected because charting is an optional product capability with a sizeable browser renderer dependency. Explicit composition keeps default tool catalogs and Web bundles unchanged.

**Add a ChartArtifact store or prepared-chart handle immediately.** Rejected because the JSON option already supplies a durable replay payload. Separate storage is deferred until measured chart sizes show the existing tool argument and metadata path is insufficient.

## Consequences

Harness can synthesize rich interactive ECharts options without introducing a chart-specific orchestration engine, while DataOps remains the owner of database-scale query shaping and a single result keeps provenance understandable.

The complete replay data travels in the chart option, so very large interactive datasets can make the Code Mode-to-tool JSON round trip and durable metadata expensive. The implementation measures real use before adding opaque prepared-chart handles or separate storage.

Invalid but JSON-shaped ECharts options can still fail at browser render time, and function-valued formatters or event callbacks are not durable in version one. The UI exposes failure and inspection rather than adding a speculative repair pipeline.

Deployments must compose both the model-facing tool and the browser renderer when they want the full interactive experience. A future non-DataOps prepared dataset contract, including document-table visualization, remains a separate design rather than pretending that every source is a DataOps resultRef.
