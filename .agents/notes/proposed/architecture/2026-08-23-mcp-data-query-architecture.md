# Agent Note: MCP Data Query Integration and A/B Query Designs

Status: proposed

English | [中文](2026-08-23-mcp-data-query-architecture.zh.md)

## Problem

DataOps currently exposes AI data capabilities through contracts coupled to DataOps services, while DeepSeek Harness already bridges external MCP tools into its normal tool runtime. The migration must preserve DataOps ownership of catalog visibility, permissions, SQL and API execution, result storage, and audit while defining two query designs precisely enough for another agent to implement across the DataOps and deepseek-harness-plus repositories.

The designs solve different problems. Design A gives the model physical query knowledge and lets it write SQL. Design B gives the model a logical query interface and lets DataOps select physical sources and compile SQL. A resource description is not a semantic compiler, and a logical semantic model is insufficient context for a model that must write physical SQL.

The existing DataOps MCP server is a reusable adapter foundation, but its current tools forward large JSON payloads directly and bind identity through fixed process environment variables. The migration therefore also needs bounded results, reusable result references, a single-principal DSH runtime contract, credential-backed HTTP MCP authentication, and explicit ownership of batch model work.

## Proposal

Use DataOps as the Streamable HTTP MCP server and reuse `@deepseek-ai/dsh-mcp-client` in DSH. Add a DataOps-owned external Auth/Integration Plugin for login, credential lifecycle, and MCP composition, but do not add a DataOps query-tool implementation to DSH, execute SQL in DSH, or use Bash as the formal query interface. DataOps owns user authentication, authorization, resource discovery, API connectors, query execution, result materialization, and audit.

Expose two selectable query facets. Design A is the migration MVP for broad ad hoc coverage. Design B is a later governed capability for business models whose metric and physical-routing correctness justifies a compiler. Both reuse the same result, export, and chart contracts.

### Ownership

| Responsibility | Owner | Contract |
| --- | --- | --- |
| User authentication and DSH instance distribution | DataOps | DataOps authenticates users, provisions isolated DSH runtimes, and binds one principal to each runtime |
| Optional DataOps integration in DSH | External DataOps Auth/Integration Plugin | Starts Authorization Code + PKCE, acquires/stores credential references, and composes the generic MCP client; omission leaves generic MCP transport unauthenticated |
| Generic MCP authentication | DSH credential service and MCP client | Resolves a credential reference, attaches current transport credentials, and reconnects after credential changes |
| MCP tools | DSH MCP client and DataOps MCP server | DSH discovers and calls tools; DataOps authenticates each HTTP request and serves the tools |
| Resource catalog | DataOps | Search, complete listing, detail, visibility, descriptions, usage manuals, columns, and lineage |
| Design A query | Model plus DataOps query executor | Model selects physical resources and writes SQL; DataOps performs generic checks and executes |
| Design B query | DataOps semantic query service | Model submits logical members; DataOps selects sources and compiles SQL |
| Result snapshots | DataOps | Immutable authorized result references, bounded pages, export, expiry, and audit |
| Batch AI analysis | DSH generic workflow/agent capability | DSH owns model calls, budgets, retry, checkpoints, and aggregation |

### Authentication and deployment

DataOps is the multi-user control plane; each authenticated DSH runtime is single-principal. DataOps may use Docker to provision and isolate runtimes, but container placement is not authentication. A DataOps browser may hold several active account sessions at once, so the authorization page lists the available accounts and requires an explicit user choice. The selected account is the principal that binds the isolated runtime. Reauthentication must resolve to that same principal; a different principal requires a different runtime.

The external DataOps Auth/Integration Plugin is optional. If it is not configured, or a generic Streamable HTTP MCP client is configured without a credential reference, DSH sends no `Authorization` header and simply attempts an anonymous MCP connection; the remote MCP server owns whether anonymous access exists. The production DataOps data-query MCP endpoint requires authentication and therefore rejects that anonymous attempt.

For authenticated DataOps integration, a direct DSH visit starts DataOps Authorization Code with PKCE. DataOps owns the browser authorization page and explicit account selection. If the chosen account is not currently authenticated, DataOps owns its normal login and any MFA challenge; MFA is a DataOps authentication step, not a substitute for OAuth authorization. A launch from DataOps may carry only a short-lived, single-use code bound to the user, OAuth client, target DSH instance, audience, state, and expiry; the plugin exchanges it server-side and removes it from the URL. Access and refresh credentials never appear in URL parameters, tool arguments, model context, browser local storage, or session logs.

The plugin stores provider credentials through the DSH credential service. The generic MCP client uses credential references instead of literal static headers: when a reference is configured it resolves the current bearer token at the transport boundary and never logs the token. This is a generic authenticated-MCP enhancement, not DataOps query logic.

Authenticated Streamable HTTP MCP requests carry `Authorization: Bearer <access-token>`. DataOps validates issuer, audience, expiry, authorized client, user, and tool scopes, then projects an `AuthorizationPrincipal` into the tool handler. Tool schemas contain only business arguments. DataOps binds each MCP session identifier to the authenticated principal and rejects later requests whose principal differs; a refreshed token may continue only when its principal is unchanged. MCP session identifiers and result references are not credentials.

The DSH conversation identifier is correlation metadata, not user authentication and not an access-token claim. The new reusable MCP service removes the current requirement for a process-global DataOps `conversationId`; permission and results bind to the authenticated principal. A later generic per-call MCP metadata facility may add DSH session correlation for audit without changing authorization.

The existing [DataOps MCP server](https://github.com/SparkElf/dataops/blob/main/infra/docker-workspace/runtime-daemon/src/dataops-mcp-server.mjs) is the implementation starting point. Its handler delegation is reused while the production service replaces the fixed-identity stdio transport with Streamable HTTP. If the MCP server and DataOps backend are separate services, workload identity authenticates the MCP service and the delegated user principal authorizes the operation.

## MCP contracts

MCP arguments and `structuredContent` use JSON. Model-facing text may be compact, but it must not duplicate the complete structured payload. Cross-boundary identifiers are opaque and principal-scoped. Access tokens travel only in the HTTP `Authorization` header; tool arguments never contain access tokens, refresh tokens, user IDs, tenant IDs, or verification fields. Models never receive database credentials, connection strings, or unscoped internal numeric IDs.

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

The DataOps compiler validates members, loads the active semantic snapshot, finds eligible physical sources, checks member coverage and source grain, expands metric definitions, resolves approved relationships, rejects unsafe fanout, renders target-dialect SQL, applies authorization predicates, and invokes the existing query executor. It returns a result reference and compact provenance containing `semanticSnapshotRef`, semantic version, compiler version, selected `resourceRef` values, dimensions, metrics, and a stable compiled-SQL hash. DataOps retains the authorized compiled SQL for audit; the model receives the hash and a redacted preview only when policy permits.

The compiler selects a summary source when it covers every requested dimension, metric, and filter. It selects a detail source when a required member is absent from the summary. It never joins summary and detail merely because they share an identifier. Physical source grain, metric additivity, relationship cardinality, freshness, and security scope are compiler facts.

`execute_sql` may remain as an advanced escape hatch but receives no automatic Design B routing. The two operation kinds remain observable.

### Shared result tools

`execute_sql`, `execute_semantic_query`, and `call_data_api` use one execution lifecycle. Work completed inside the interactive server budget returns `{status:"completed", resultRef, preview, provenance}`. Work that cannot complete before the MCP call timeout returns `{status:"accepted", executionRef}` before the transport deadline; it does not leave an untracked database query behind.

`get_query_execution` accepts an opaque `executionRef` and returns `queued`, `running`, `completed`, `failed`, or `cancelled`, plus `resultRef` only after completion. `cancel_query_execution` requests cancellation and DataOps propagates it to the owned SQL/API execution when cancellation is supported. MCP transport abort cancels work that has not been durably accepted; after an accepted response, explicit cancellation owns the lifecycle. DataOps persists execution state, expiry, failure details, and principal binding.

A completed immutable `resultRef` is reusable until its server-owned TTL expires; repeating the same reference and cursor reads the same snapshot without rerunning the query. `read_query_result` accepts `{resultRef, cursor?, columns?, limit?}` and returns a byte-bounded page of rows or JSON items, returned count, total count when known, `hasMore`, and an opaque `nextCursor`. The DataOps result service applies the byte bound before MCP/model projection; row count is only a secondary bound. Every read reauthorizes the current principal; knowing a result reference grants no access.

`export_query_result` converts a result reference into `{artifactRef, fileName, mediaType, sizeBytes, downloadUrl, expiresAt}`. DataOps owns the short-lived authorized download URL; the current DSH MCP bridge may present it as a text/resource link and does not claim to ingest CSV or XLSX as a chat attachment. `render_chart` consumes a result reference and validated chart specification and returns an image artifact or a later generic chart specification. Neither operation reruns the original query.

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

DataOps adds Authorization Code with PKCE, explicit selection among active browser accounts, single-use launch-code exchange, MCP-audience tokens and scopes, per-request HTTP MCP authentication, and Streamable HTTP handlers mapped onto its existing catalog, query, API, execution, and result services. It adds QueryGuide storage only for genuine cross-resource guidance and implements Design B only in a later compiler project. The DataOps backend and MCP server do not import DSH packages.

DSH core adds only the generic credential-backed MCP authentication capability. An optional DataOps-specific integration package may be distributed with DSH, but it is outside the core/default profile and owns only browser OAuth, credential acquisition, and composition of the generic MCP client. It contains no DataOps query identifiers, SQL execution, source routing, authorization policy, or connector logic. A later approved generic batch-result capability belongs in DSH.

The [previous HTTP `dq/v1` proposal](../../rejected/architecture/2026-08-19-generic-data-query-protocol.md) and hypothetical `dsh-plugin-dataquery` are superseded. MCP is the chosen transport.

## Alternatives considered

**HTTP plus a DSH data-query plugin.** Rejected because DSH already bridges MCP tools; another query plugin would duplicate transport, schema projection, cancellation, and result handling. This does not reject the separate DataOps Auth/Integration Plugin, which owns OAuth and credential lifecycle without implementing tools.

**Static tokens in MCP config, stdio environment, or launch URLs.** Rejected because tokens expire and those locations leak or cannot refresh safely. The accepted path is a credential reference for MCP HTTP requests and a one-time launch code for browser entry.

**Bash calling HTTP endpoints.** Rejected as the formal contract because stdout truncation, string parsing, credential exposure, shell permission, and weak audit identity remain.

**One overloaded discovery tool.** Rejected because fuzzy recall, exhaustive listing, selected detail, and cross-resource guidance have different completeness and payload semantics. They may share one backend service, not one model contract.

**Expose only a logical semantic model to Design A.** Rejected because a model writing physical SQL needs scenario-specific physical mappings and warnings; repeating logical dimensions and metrics does not solve summary/detail selection.

**Build Design B before migration.** Rejected for MVP scope. Design A, bounded results, and approved templates cover migration; Design B follows when observed metric or routing failures justify compiler investment.

**Use filesystem semantic storage.** Rejected because it would create a second authority beside existing database governance. Optional export is sufficient.

## Acceptance criteria

- The note keeps Design A model-generated physical SQL and Design B DataOps-compiled logical queries distinct.
- DataOps owns the HTTP MCP server and external Auth/Integration Plugin; DSH adds only generic credential-backed MCP authentication and no DataOps query-tool implementation.
- Catalog contracts distinguish fuzzy candidates, complete listing, and selected detail; a fuzzy miss is never an existence result.
- QueryGuide is sparse cross-resource knowledge layered over existing resource facts and does not duplicate complete schemas.
- Design A explicitly excludes automatic routing, SQL rewrite, and search-history proof.
- Design B defines logical input, compiler ownership, source selection, grain/metric rules, SQL rendering, and versioned provenance.
- Query execution defines completed and accepted outcomes, status, cancellation, transport-abort ownership, and the transition from `executionRef` to immutable `resultRef`.
- Shared results define reusable immutable references, bounded pages, explicit DataOps download artifacts, charts, and future batch-analysis ownership.
- Authentication defines one principal per DSH runtime, OAuth/PKCE and one-time launch entry, credential refresh, per-request bearer transport, server-derived principal context, and no identity fields in tool arguments.
- The old HTTP proposal is rejected and points to this MCP proposal.

## Risks

- Design A can choose a wrong physical source despite correct guidance; use Design B or an approved template when that error is unacceptable.
- QueryGuide can become stale if it repeats Resource facts; it must reference resources and state only cross-resource exceptions.
- Large inventories require pagination and artifact export before complete rows enter model context.
- Result references require principal binding, expiry, authorization on every read, and creation/access audit.
- A DSH runtime must never serve simultaneous DataOps principals. Docker isolation alone is not authentication; the Auth/Integration Plugin and DataOps token service establish the principal.
- Static MCP headers cannot refresh credentials. The generic credential-reference integration and reconnect behavior must ship before production HTTP MCP authentication.
- Accepted executions require durable DataOps state and explicit cancellation; otherwise an MCP timeout can leave an unowned database query.
- Design B is substantial compiler work and must not be advertised as available until its compiler and conformance coverage ship.

## Verification

This PR is design-only. Run the repository bilingual-pairing, Markdown-link, Agent Note format, and whitespace checks. Implementation PRs must cover direct MFA login, single-use launch-code exchange, token refresh and MCP reconnect, principal-mismatch rejection, per-request scope enforcement, the absence of secrets and identity fields from model-visible calls, completed/accepted/cancelled execution paths, result snapshot/page/expiry authorization, export-link fields, query templates, and a keyless model-visible snapshot. Design B must cover summary selection, detail fallback, additive and non-additive metrics, unsafe fanout rejection, dialect rendering, permission predicates, and stable versioned provenance before availability.
