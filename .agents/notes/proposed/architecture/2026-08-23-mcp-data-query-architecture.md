# Agent Note: MCP Data Query Integration and A/B Query Designs

Status: proposed

English | [中文](2026-08-23-mcp-data-query-architecture.zh.md)

## Problem

DataOps currently exposes AI data capabilities through contracts coupled to DataOps services, while DeepSeek Harness already bridges external MCP tools into its normal tool runtime. The migration must preserve DataOps ownership of catalog visibility, permissions, SQL and API execution, result storage, and audit while defining two query designs precisely enough for another agent to implement across the DataOps and deepseek-harness-plus repositories.

The designs solve different problems. Design A gives the model physical query knowledge and lets it write SQL. Design B gives the model a logical query interface and lets DataOps select physical sources and compile SQL. A resource description is not a semantic compiler, and a logical semantic model is insufficient context for a model that must write physical SQL.

The existing DataOps MCP server is a reusable adapter foundation, but its current tools forward large JSON payloads directly and bind identity through fixed process environment variables. The migration therefore also needs bounded results, reusable result references, session-scoped identity, and explicit ownership of batch model work.

## Proposal

Use DataOps as the MCP server and reuse `@deepseek-ai/dsh-mcp-client` in DSH. Do not add a DataOps-specific DSH plugin, execute SQL in DSH, or use Bash as the formal query interface. DataOps owns authentication, authorization, resource discovery, API connectors, query execution, result materialization, and audit.

Expose two selectable query facets. Design A is the migration MVP for broad ad hoc coverage. Design B is a later governed capability for business models whose metric and physical-routing correctness justifies a compiler. Both reuse the same result, export, and chart contracts.

### Ownership

| Responsibility | Owner | Contract |
| --- | --- | --- |
| MCP bridge | DSH MCP client and DataOps MCP server | DSH discovers and calls tools; DataOps serves them |
| Resource catalog | DataOps | Search, complete listing, detail, visibility, descriptions, usage manuals, columns, and lineage |
| Design A query | Model plus DataOps query executor | Model selects physical resources and writes SQL; DataOps performs generic checks and executes |
| Design B query | DataOps semantic query service | Model submits logical members; DataOps selects sources and compiles SQL |
| Result snapshots | DataOps | Immutable authorized result references, bounded pages, export, expiry, and audit |
| Batch AI analysis | DSH generic workflow/agent capability | DSH owns model calls, budgets, retry, checkpoints, and aggregation |

The first deployment starts one DataOps MCP stdio process per authenticated DSH session or isolated workspace. The process receives its user, conversation, and backend credential through its private launch environment and is not shared by unrelated users. A later Streamable HTTP server may use request-scoped authentication. A shared static DataOps identity is not a valid multi-user deployment.

The existing [DataOps MCP server](https://github.com/SparkElf/dataops/blob/master/infra/docker-workspace/runtime-daemon/src/dataops-mcp-server.mjs) is the adapter starting point. Its handlers delegate to existing DataOps services instead of duplicating SQL, permission, connector, or audit logic.

## MCP contracts

MCP arguments and `structuredContent` use JSON. Model-facing text may be compact, but it must not duplicate the complete structured payload. Cross-boundary identifiers are opaque and principal-scoped. Models never receive database credentials, connection strings, or unscoped internal numeric IDs.

### Catalog tools

Candidate search, complete enumeration, and selected-object inspection have different completeness semantics and remain separate model-visible tools over one DataOps catalog service.

| Tool | Purpose | Completeness |
| --- | --- | --- |
| `search_resources` | Fuzzy discovery over names, aliases, descriptions, usage manuals, and indexed metadata | Candidate recall only; a miss is not proof of absence |
| `list_resources` | Exact filtered enumeration with stable order and pagination | Complete in the authenticated visibility scope after all pages |
| `describe_resource` | Full requested facts for selected resources | Complete for selected references and requested fields |

`search_resources` accepts `{query, kinds?, limit?}` and returns compact candidates with `resourceRef`, kind, display name, summary, queryability, and match reasons. It does not return every column or lineage edge.

`list_resources` accepts exact catalog filters such as kind, source system, database, schema, tags, queryable state, and exact or prefix physical name. It returns compact catalog rows, `returnedCount`, `hasMore`, and an opaque `nextCursor`. Optional `totalCount` supports exact count and existence answers without reading every row. Large complete inventories later use artifact export instead of entering model context.

`describe_resource` accepts selected references and an include set such as `description`, `usageManual`, `columns`, `lineage`, and `execution`. Existing DataOps Resource `remark`, `usageManual`, columns, and lineage remain the source of single-resource knowledge. Design A does not add a duplicate `grain` field: a usage manual may state what one row represents. Cross-resource rules belong in QueryGuide.

### Design A tools

Design A is knowledge-assisted Text-to-SQL. The model receives technical facts and cross-resource guidance, chooses physical sources, and writes SQL. DataOps performs generic execution checks and executes the SQL; it does not automatically route or rewrite it.

`search_query_guidance` searches cross-resource, scenario-indexed QueryGuide knowledge. It accepts `{query, domain?, limit?}` and returns compact candidates containing related resource references, source-selection advice, only the key physical mappings that are easy to misuse, cross-resource warnings, examples, and approved template references. It must not duplicate the full columns or lineage returned by `describe_resource`.

A Resource usage manual explains one resource. A QueryGuide explains how several resources are used together in a business scenario. A SemanticQueryTemplate provides approved parameterized SQL for one stable scenario. The minimum QueryGuide record has a stable reference, title, domain, aliases, example questions, related resources, concise source-selection guidance, key logical-to-physical exceptions, dangerous joins, and template references. It is model knowledge, not an executable rule DSL.

`execute_sql` accepts `{sources, sql, guideRef?}`. Each source has an opaque `resourceRef` and SQL alias. `guideRef` is optional provenance, not proof that a search occurred. The server checks authorization, read-only SQL, parseability, declared-source use, and ordinary field/resource validity. It does not infer missing sources, select summary tables, rewrite metrics, or guarantee that the model understood guidance.

If a QueryGuide states that trajectory-level aggregation should use a summary table and segment-level questions should use detail rows, the model applies that knowledge when writing SQL. If choosing the right source must be guaranteed regardless of model behavior, use Design B or an approved query template.

`call_data_api` accepts an opaque registered `operationRef` and typed business arguments. The connector owns URL, method, credentials, request construction, response extraction, and pagination. The model does not provide arbitrary URLs, identity evidence, or a free-form result path.

Optional `execute_query_template` validates parameters and executes one approved SemanticQueryTemplate. It is a Design A shortcut for stable scenarios, not a semantic compiler and not a prerequisite for ad hoc SQL.

### Design B tools

Design B is a governed semantic compiler. Model discovery uses `list_semantic_models` and `describe_semantic_model`, or an equivalent semantic-model catalog projection. Model-facing context contains logical business objects, dimensions, metrics, logical relationships, aliases, and examples. Physical mappings remain compiler-owned.

`execute_semantic_query` accepts a logical request such as `{modelRef:"semantic-model:trajectory",dimensions:["month"],metrics:["total_distance"],filters:[],orderBy:[{field:"month",direction:"asc"}],limit:1000}`.

The DataOps compiler validates members, loads the active semantic snapshot, finds eligible physical sources, checks member coverage and source grain, expands metric definitions, resolves approved relationships, rejects unsafe fanout, renders target-dialect SQL, applies authorization predicates, and invokes the existing query executor. It returns a result reference and compact provenance with model, selected source, dimensions, and metrics.

The compiler selects a summary source when it covers every requested dimension, metric, and filter. It selects a detail source when a required member is absent from the summary. It never joins summary and detail merely because they share an identifier. Physical source grain, metric additivity, relationship cardinality, freshness, and security scope are compiler facts.

`execute_sql` may remain as an advanced escape hatch but receives no automatic Design B routing. The two operation kinds remain observable.

### Shared result tools

`execute_sql`, `execute_semantic_query`, and `call_data_api` return a bounded preview and immutable `resultRef`. The reference is reusable until its server-owned TTL expires; repeating the same reference and cursor reads the same snapshot without rerunning the query.

`read_query_result` accepts `{resultRef, cursor?, columns?, limit?}` and returns a bounded page of rows or JSON items, returned count, total count when known, `hasMore`, and `nextCursor`. The DataOps result service applies a byte bound before MCP/model projection; row count is only a secondary bound.

`export_query_result` turns a result reference into a downloadable artifact. It is the full-data delivery path. `render_chart` consumes a result reference and validated chart specification and returns a chart artifact or a later generic chart specification. Neither operation reruns the original query.

A future generic DSH `analyze_query_result` capability may read pages, call models in bounded batches, checkpoint stable row references, retry failed batches, and return an output result reference. DSH owns this because it owns model invocation and context budgets. It is deferred until a real full-result AI-analysis workflow requires it.

## Design A orchestration

1. For explicit tables, fields, databases, schemas, inventory, count, or existence questions, use catalog tools. Complete lists use `list_resources`, exact existence uses exact list filters, and selected detail uses `describe_resource`.
2. For ambiguous business questions involving several resources, metrics, summary/detail choices, or join risks, call `search_query_guidance`.
3. If the QueryGuide contains enough key mappings, generate SQL. If it only identifies resources, call `describe_resource` for full technical facts.
4. Generate SQL with declared resources and aliases, then call `execute_sql`.
5. Inspect bounded output with `read_query_result`, deliver full data with `export_query_result`, render charts with `render_chart`, and use future generic batch analysis for row-wise AI work.

The skill recommends the order; the server does not track search history. There is no `searchRef`. Execution validates actual sources and SQL, not whether the model previously called discovery.

## Design B orchestration

1. Discover a logical model and inspect its dimensions, metrics, relationships, aliases, and examples.
2. Submit `execute_semantic_query` with logical members only.
3. DataOps validates and compiles against the active semantic snapshot and internal physical mapping.
4. DataOps executes compiled SQL and returns the shared result reference.
5. Shared result tools handle pages, export, charts, and future batch analysis.

The model does not select summary or detail sources in Design B. Compact execution provenance explains the route; the compiler owns physical SQL.

## Storage

DataOps remains the database source of truth. Resource `remark`, `usageManual`, columns, and lineage store single-resource facts. Add QueryGuide only for cross-resource scenario knowledge that cannot belong cleanly to one resource. Keep SemanticQueryTemplate for approved fixed SQL scenarios.

Design B uses a separate structured SemanticModel snapshot containing logical members, metric expressions, approved relationships, physical implementations, source coverage, grain, additive behavior, freshness, and security policy. The model-facing projection need not expose physical mappings, but the compiler loads them.

Do not switch DataOps to a filesystem source of truth to copy Wren's MDL layout. Wren's files are a versioned compiler input; DataOps already owns database drafts, approvals, permissions, resources, lineage, and AI visibility. A later exporter may produce YAML or JSON for Git review or an external engine, but files and database cannot be competing authorities.

## Implementation split

DataOps adds or revises MCP handlers, maps them to existing catalog/query/API/result services, adds QueryGuide storage only for genuine cross-resource guidance, and implements Design B only in a later compiler project. DataOps does not import DSH packages.

DSH reuses its existing MCP client composition. A later approved generic batch-result capability belongs in DSH, but DSH contains no DataOps identifiers, SQL execution, source routing, permissions, or connector logic.

The [previous HTTP `dq/v1` proposal](../../rejected/architecture/2026-08-19-generic-data-query-protocol.md) and hypothetical `dsh-plugin-dataquery` are superseded. MCP is the chosen transport.

## Alternatives considered

**HTTP plus a DSH data-query plugin.** Rejected because DSH already bridges MCP tools; another plugin would duplicate transport, schema projection, cancellation, and result handling.

**Bash calling HTTP endpoints.** Rejected as the formal contract because stdout truncation, string parsing, credential exposure, shell permission, and weak audit identity remain.

**One overloaded discovery tool.** Rejected because fuzzy recall, exhaustive listing, selected detail, and cross-resource guidance have different completeness and payload semantics. They may share one backend service, not one model contract.

**Expose only a logical semantic model to Design A.** Rejected because a model writing physical SQL needs scenario-specific physical mappings and warnings; repeating logical dimensions and metrics does not solve summary/detail selection.

**Build Design B before migration.** Rejected for MVP scope. Design A, bounded results, and approved templates cover migration; Design B follows when observed metric or routing failures justify compiler investment.

**Use filesystem semantic storage.** Rejected because it would create a second authority beside existing database governance. Optional export is sufficient.

## Acceptance criteria

- The note keeps Design A model-generated physical SQL and Design B DataOps-compiled logical queries distinct.
- DataOps owns the MCP server and DSH reuses its existing MCP client; no DataOps-specific DSH plugin is required.
- Catalog contracts distinguish fuzzy candidates, complete listing, and selected detail; a fuzzy miss is never an existence result.
- QueryGuide is sparse cross-resource knowledge layered over existing resource facts and does not duplicate complete schemas.
- Design A explicitly excludes automatic routing, SQL rewrite, and search-history proof.
- Design B defines logical input, compiler ownership, source selection, grain/metric rules, SQL rendering, and provenance.
- Shared results define reusable immutable references, bounded pages, export, charts, and future batch-analysis ownership.
- Authentication, session isolation, permissions, audit, result expiry, and the prohibition on shared static identity are explicit.
- The old HTTP proposal is rejected and points to this MCP proposal.

## Risks

- Design A can choose a wrong physical source despite correct guidance; use Design B or an approved template when that error is unacceptable.
- QueryGuide can become stale if it repeats Resource facts; it must reference resources and state only cross-resource exceptions.
- Large inventories require pagination and artifact export before complete rows enter model context.
- Result references require principal binding, expiry, authorization on every read, and creation/access audit.
- The existing stdio identity is unsafe for a shared multi-user process; deployment must isolate sessions or authenticate each HTTP request.
- Design B is substantial compiler work and must not be advertised as available until its compiler and conformance coverage ship.

## Verification

This PR is design-only. Run the repository bilingual-pairing, Markdown-link, Agent Note format, and whitespace checks. Implementation PRs must add a real MCP composition test, DataOps MCP contract tests, result snapshot/page/expiry coverage, query-template coverage, and a keyless model-visible snapshot. Design B must cover summary selection, detail fallback, additive and non-additive metrics, unsafe fanout rejection, dialect rendering, and permission predicates before availability.
