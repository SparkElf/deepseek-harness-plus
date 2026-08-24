# Agent Note: ResultRef-backed interactive chart rendering

Status: proposed

English | [中文](2026-08-24-resultref-interactive-chart-rendering.zh.md)

## Problem

Harness already has the two capabilities that make a fixed chart-generation workflow unnecessary: models can call typed tools, and Code Mode can write short programs over tool results. DataOps query execution can also materialize complete SQL results behind an opaque `resultRef` while returning only bounded model-visible previews. A chart feature should use those capabilities instead of introducing a second orchestration framework that generates SQL, samples data, chooses a chart, and renders it through a fixed pipeline.

The difficult part is not selecting a chart library. The feature must preserve Harness program synthesis, keep database-scale shaping in the query that produced the result, render genuinely interactive charts, and survive session replay after the source `resultRef` expires. It must also fit the existing tool presentation model: nested Code Mode calls have no independent tool card and skip tool-owned `presentationMeta`, while the outer `run_code` result is the only visible card for that program.

## Proposal

Add an optional first-party chart plugin with one model-visible top-level tool, tentatively named `render_chart`. The intended workflow is `DataOps query -> one chart-ready resultRef -> optional Code Mode transformation -> top-level render_chart -> interactive browser chart`. The chart renderer uses ECharts and persists the final JSON-serializable ECharts option as replayable presentation metadata.

Harness retains freedom to write code that reads and reshapes the selected result. The feature does not attempt to statically forbid `map`, `filter`, `sort`, `reduce`, derived statistics, wide/long reshaping, annotations, date conversion, numeric conversion, series construction, or other visualization-oriented work. The product rule is narrower: the single source result should already contain the business data needed by the chart at an appropriate display granularity. If the source is obviously raw database-scale detail or requires joins and substantial aggregation to answer the user's question, the agent should issue a better DataOps query rather than rebuilding a data engine inside visualization code.

Simple cases do not require Code Mode. A model may construct a valid option directly from the result preview and call `render_chart`. Code Mode is valuable when the option is easier or more accurate to synthesize programmatically, including dynamic series discovery, type normalization, reshaping, derived visual statistics, annotations, conditional marks, or more involved ECharts configuration.

### Source result contract

One chart is associated with exactly one DataOps `resultRef`. The result is expected to be immutable for its lifetime and to contain all business rows and fields required by the visualization. Multi-source joins belong in the DataOps query that creates the result, producing one new resultRef before chart generation.

The `resultRef` is provenance, not the replay data source. During chart construction Harness may read pages from that result through the existing DataOps MCP result tool. The chart plugin does not add DataOps OAuth logic, SQL execution, joins, grouping, result pagination, or result lifecycle ownership. The integration plugin and generic MCP client remain responsible for reaching the DataOps tools.

Visualization code may perform lightweight transformations required for an accurate visual representation. Examples include converting textual numerics to numbers, parsing dates, renaming display fields, ordering categories, converting wide rows into series, calculating percentages or reference averages, generating cumulative or comparison overlays, and selecting valid rows. These operations are intentionally not encoded as a closed chart transformation DSL.

The agent should re-query DataOps when the result's business granularity is wrong, when a correct answer requires a different filter or grouping, or when the amount of detail is unsuitable for the intended chart. This is an agent-use rule rather than a runtime prohibition; the first implementation does not add an AST checker, aggregation detector, automatic sampler, or chart-specific query planner.

### Harness and Code Mode

Code Mode consumes typed tool returns directly, so a program can page through `read_query_result`, inspect columns and rows, and compute a JSON ECharts option without scraping Native prose. This preserves the general Code Mode programming model rather than introducing a chart-only execution engine.

A nested `render_chart` call is not the version-one presentation path. The current Code Mode contract gives nested tool calls no independent result card and skips their presentation metadata. When Code Mode is used, the program returns a JSON-serializable option and the model makes a subsequent top-level `render_chart` call. This keeps the chart on the ordinary visible tool path and requires no agent-loop or Code Mode lifecycle change.

Chart-ready result sets are expected to keep this option practical to pass as the top-level tool argument. If real workloads later show that large interactive datasets make the Code Mode-to-tool JSON round trip materially expensive, an opaque prepared-chart handle can be designed from measured need. Version one does not pre-emptively add a chart store, special Code Mode forwarding protocol, or second execution runtime.

### Tool input and canonical value

The initial tool contract is intentionally close to the renderer rather than a narrow bespoke visualization DSL. Its required fields are a source result reference and a JSON-serializable ECharts option; an optional human-facing title may be included if it improves generic tool presentation.

```ts
interface RenderChartInput {
  sourceResultRef: string
  option: JsonValue
  title?: string
}
```

The exact branded identifier and schema implementation will follow repository conventions during implementation. `option` contains no JavaScript functions because canonical tool values and durable metadata are JSON. This is a natural consequence of the existing Code Mode and persistence contracts, not a separate attempt to sandbox ECharts. Function callbacks such as formatter lambdas are therefore outside version one; declarative ECharts features remain available.

The canonical tool value remains compact and useful to the model, for example the source reference plus chart summary. The full replayable option belongs in `presentationMeta` rather than duplicated in model-facing Native text.

### Interactive rendering

The browser plugin registers a keyed tool view for `render_chart` and renders the persisted option with ECharts. The renderer owns responsive sizing, resize observation, light/dark adaptation where the option does not explicitly override presentation, and disposal when the row unmounts.

The option may use normal JSON-configurable ECharts interaction features including tooltip, legend selection, axis pointer, inside/slider data zoom, brush where supported by the chosen series, `visualMap`, `markLine`, `markPoint`, stacking, area styling, datasets, and encode mappings. The plugin should not artificially reduce ECharts to bar/line/pie/scatter when the underlying JSON option can express a useful chart accurately.

The UI presents the chart as the primary tool result rather than hiding it behind generic engineering details. Raw option/provenance inspection may remain secondary or collapsed. The chart must remain usable at narrow widths and in both supported appearance modes.

### Replay and source expiry

A successfully rendered chart must not depend on a live DataOps resultRef when the session is replayed. DataOps result references have their own expiry, while Harness sessions are durable. The tool therefore persists the final JSON option, including the dataset or series data required for the finished chart, in its replayable presentation metadata. `sourceResultRef` is retained only as provenance.

This follows the same product-level retention model as other information that was legitimately read into a Harness conversation: authorization is checked when DataOps allows the result to be read; once the derived chart data is accepted into the durable Harness session, that recorded result remains reconstructable from the session. Version one does not attempt retroactive deletion of already-recorded conversation content after DataOps permission changes.

### Package and composition

The implementation should be an optional plugin package under the existing package naming and ownership rules. It registers the tool and browser tool view through existing extension points and does not change `agent-loop`. Product-visible composition must include the normal package README, Agent Note lifecycle update when implemented, and a real Loader composition test.

The chart plugin remains independent from DataOps authentication. It understands `sourceResultRef` only as provenance and renders the supplied ECharts option. DataOps-specific acquisition remains available through the already composed MCP tools, which lets the same chart renderer evolve toward other prepared datasets later without moving query business logic into DSH.

## Alternatives considered

**Fixed WrenAI-style chart-generation pipeline.** Rejected because Harness already has a programmable tool-composition layer. A separate service that receives question, SQL, samples data, invokes another chart LLM, and returns a Vega specification duplicates orchestration and weakens the agent's ability to adapt its visualization program to the actual result.

**Narrow custom chart DSL mapped to Recharts.** Rejected as the primary contract because it would make common interactive and analytical ECharts features unavailable until the DSH DSL grows each one explicitly. A narrow DSL can be reconsidered if unconstrained JSON options prove too difficult for models in practice, but the initial design prioritizes accurate charts and Harness program synthesis.

**Forbid visualization code from reading rows or performing reductions.** Rejected because type conversion, reshaping, reference lines, percentages, cumulative values, and annotations can require real computation. The useful distinction is between database-scale business shaping, which belongs in DataOps SQL, and visualization-oriented computation, which Harness may perform.

**Allow multiple resultRefs in one chart.** Rejected because it makes visualization code responsible for cross-result joins and makes provenance harder to understand. DataOps already owns query execution and can produce one joined or aggregated result for the chart.

**Replay by reading the resultRef again.** Rejected because DataOps result lifetime is shorter than durable Harness history and later authorization or availability may differ. The visible chart must replay from session-owned presentation metadata.

**Create a chart artifact store in version one.** Rejected because the final JSON option is already the complete replay payload and existing tool metadata is the natural persistence location. A separate store is justified only if measured chart payloads exceed practical session metadata limits.

## Acceptance criteria

- A first-party optional plugin exposes a top-level `render_chart` tool and a browser tool view without changing `agent-loop`.
- The normal workflow can use exactly one DataOps `resultRef`, optionally process its rows through Code Mode, and then render a JSON-serializable ECharts option.
- Code Mode remains unrestricted for reasonable visualization computation; repository documentation tells the agent to re-query rather than perform database-scale shaping when the result granularity is wrong.
- The browser output is interactive and supports ordinary declarative ECharts interactions such as tooltip, legend selection, and zoom when present in the option.
- The final option and required data are persisted through tool presentation metadata so replay, resume, and fork do not require the source resultRef to remain live.
- Nested Code Mode chart calls are not relied on for version-one UI; the visible render occurs through a top-level tool call.
- The implementation has focused schema/tool tests, browser renderer tests, replay coverage, narrow-width and appearance-mode coverage, and a real Loader composition test.
- Product-facing documentation explains the model workflow and the distinction between chart-ready query results and visualization-oriented code.

## Risks

A full JSON ECharts option gives the model more surface area than a custom DSL, so invalid or visually poor options remain possible. The implementation should rely on normal tool input validation and ECharts errors rather than creating a speculative repair pipeline; observed recurring mistakes can justify narrower helpers later.

Large chart-ready datasets can still produce large tool arguments and durable metadata, especially when Code Mode returns the complete option before the top-level call. Version one accepts that cost in exchange for a small architecture and measures real workloads before adding prepared-chart handles or external chart storage.

Persisting derived chart data in the Harness session means later DataOps permission revocation does not erase an already recorded chart. This matches ordinary durable conversation semantics but must remain explicit in product documentation and any future data-retention policy work.
