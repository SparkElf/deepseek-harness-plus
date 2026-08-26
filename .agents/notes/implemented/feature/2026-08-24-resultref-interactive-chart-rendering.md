# Agent Note: ResultRef-backed interactive chart rendering

Status: implemented

English | [中文](2026-08-24-resultref-interactive-chart-rendering.zh.md)

## Problem

Harness already has a programmable tool-composition layer: models can call typed tools directly and Code Mode can write short programs over canonical tool results. DataOps also materializes complete SQL results behind an opaque `resultRef`, so a chart feature does not need a second fixed orchestration pipeline that regenerates SQL, samples rows, chooses a chart, and calls another chart LLM.

The product instead needs an accurate interactive rendering surface that preserves Harness program synthesis, keeps database-scale shaping in the query that created the result, and remains replayable after the source result expires.

## Decision

Interactive charting is split across the two lifecycles that already exist in the Web product:

- `@deepseek-ai/dsh-tool-chart` is the agent-plane package. It registers the model-facing `render_chart` tool in shipped agent presets.
- `@deepseek-ai/dsh-client-ui-chart` is the browser-plane package. It registers the keyed `render_chart` tool view and owns ECharts initialization, resize/theme handling, failure presentation, and disposal.

The packages do not depend on each other at runtime. Their shared data is the same durable chart projection: direct calls store it in `tool/result.meta`, while nested Code Mode dispatch stores it in a `dsh/chart` result content block. The conversation model replays both locations and the browser consumes either through one validator.

The shipped `standard`, `code`, and `cordis` presets mount `dsh-tool-chart`; the Web browser roster mounts `dsh-client-ui-chart`. The `minimal` preset remains intentionally minimal and does not gain charting.

## Model workflow

One chart is associated with exactly one chart-ready DataOps `resultRef`:

```text
DataOps execute_sql
  -> one chart-ready resultRef
  -> optional Code Mode reads that result and synthesizes an ECharts option
  -> direct or nested render_chart(sourceResultRef, option)
  -> option persisted in direct metadata or nested dispatch content
  -> browser renders/replays the option with ECharts
```

The source result is expected to already contain the business rows and fields at a useful display granularity. If correct visualization still requires database-scale joins or substantial business aggregation, the agent should issue a better DataOps query and produce a new result rather than rebuilding a query engine inside visualization code.

This is agent guidance, not runtime policing. Code Mode remains free to use ordinary `map`, `filter`, `sort`, `reduce`, reshaping, numeric/date conversion, dynamic series discovery, percentages, cumulative/reference values, annotations, and other visualization-oriented computation when that makes the chart more accurate.

## Tool contract

`render_chart` accepts a single source reference, an ECharts option, and an optional title:

```ts
import type { JsonValue } from '@deepseek-ai/dsh-tools'

interface RenderChartArgs {
  sourceResultRef: string
  option: JsonValue
  title?: string
}
```

The parameter schema requires `option` to be a JSON object. The tool returns only a compact canonical success value containing the normalized source reference and optional title. The complete option is kept out of Native prose and written by `output.presentationMeta()` as versioned durable metadata:

```ts
import type { JsonValue } from '@deepseek-ai/dsh-tools'

interface ChartPresentationMeta {
  version: 1
  sourceResultRef: string
  option: JsonValue
  title?: string
}
```

`sourceResultRef` is provenance after recording; the browser does not read DataOps from that reference.

Because canonical tool values and durable metadata are lossless JSON, function-valued ECharts callbacks are outside version one. Normal declarative ECharts configuration remains available, including tooltip, legend interaction, axis pointers, zoom, brush where supported, `visualMap`, marks, stacking, datasets, and encode mappings.

## Code Mode presentation boundary

Code Mode exposes only `run_code` as a top-level tool, so `render_chart` executes through nested SDK dispatch. Nested dispatch skips the tool's own `presentationMeta`; `finalizeContent` therefore appends the same validated projection as a `dsh/chart` block to the nested result. The browser recognizes direct metadata and nested content through one validator.

The implementation does not modify `agent-loop` or the session format. The `code` preset includes `render_chart` in the generated SDK, and the chart-owned content block remains durable log-only presentation data rather than model input.

## Browser presentation and replay

`dsh-client-ui-chart` registers `tool.call.toolview` with key `render_chart`. A completed result narrows version-one metadata from direct `tool/result.meta` or nested `dsh/chart` content, initializes ECharts from the stored option, observes container resizing, follows the Harness body dark-theme attribute when initializing or reinitializing, and disposes the ECharts instance with the React row.

Pending, failed, and malformed replay metadata have compact localized states and retain normal tool inspection. The completed chart is the primary tool presentation rather than a raw JSON card.

DataOps result references can expire sooner than Harness sessions. Replay therefore never re-reads the resultRef: the final ECharts option includes the data required by the finished visualization and is persisted in the session's tool result metadata. Resume and fork reconstruct the same chart from that durable option.

## Composition and documentation

A new `packages/chart/` capability group owns the model-facing chart tool. The browser renderer follows existing client package conventions under `packages/client/ui-chart/`. Both packages own README documentation, package invariants, TypeScript project references, and focused tests. Root package maps and bilingual pairing records include the new capability.

The Web bundle depends on and mounts `dsh-client-ui-chart`; the CLI package depends on `dsh-tool-chart` so shipped agent-preset compositions can resolve it. Shipped preset tests pin `render_chart` in the standard catalog, the code preset generated SDK, and the cordis preset's inherited standard toolset.

## Testing

Focused coverage includes:

- compact canonical Host success plus complete durable presentation metadata;
- rejection of a blank source provenance reference;
- real Cordis Loader composition for `dsh-tool-chart`;
- keyed browser slot registration and disposal;
- ECharts `setOption` and instance disposal from replay metadata;
- malformed/missing replay metadata failing without ECharts initialization;
- exact shipped preset availability for standard, code, and cordis compositions.

The Host and Client TypeScript aggregate projects reference their respective chart packages. The Web bundle roster carries the browser package so replay is independent of the current agent preset.

## Alternatives considered

**A WrenAI-style fixed chart pipeline.** Harness already has general program synthesis and typed tool composition. A second service that samples data and invokes another chart-generation LLM would duplicate orchestration and reduce adaptability.

**A narrow custom Chart DSL mapped to Recharts.** This would hide useful interactive and analytical capabilities until the DSH DSL grew every feature. Version one instead accepts durable JSON ECharts options.

**Forbid visualization code from reading rows or using reductions.** This would block useful type normalization, reshaping, reference values, percentages, annotations, and dynamic series. Database-scale shaping belongs in SQL, but visualization-oriented computation remains a Harness capability.

**Allow multiple resultRefs per chart.** Cross-result joins make the visualization program responsible for data integration and obscure provenance. DataOps should produce one joined/aggregated chart-ready result first.

**Replay by reading resultRef again.** Result lifetime and later authorization can differ from durable session history. The recorded chart must be self-contained.

**Add a ChartArtifact store or prepared-chart handle immediately.** The JSON option already supplies a durable replay payload. Separate storage is deferred until measured chart sizes show the existing tool argument/metadata path is insufficient.

## Consequences

- Very large interactive datasets can make the Code Mode-to-tool JSON round trip and durable option expensive. This implementation measures real use before adding opaque prepared-chart handles or separate storage.
- Invalid but JSON-shaped ECharts options can still fail at browser render time; the product exposes the failure and inspection rather than adding a speculative repair pipeline.
- Function-valued formatters/event callbacks are not durable in version one.
- One chart is tied to one source result. A future non-DataOps prepared dataset contract, including document-table visualization, should be designed explicitly rather than faking DataOps resultRefs.
