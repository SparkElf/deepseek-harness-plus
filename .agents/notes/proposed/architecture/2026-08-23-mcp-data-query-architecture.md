# Agent Note: MCP Data Query Integration and A/B Query Designs

Status: proposed

English | [中文](2026-08-23-mcp-data-query-architecture.zh.md)

## Problem

DataOps currently exposes AI data capabilities through contracts coupled to DataOps services, while DeepSeek Harness already bridges external MCP tools into its normal tool runtime. The migration must preserve DataOps ownership of catalog visibility, permissions, SQL and API execution, result storage, and audit while defining two query designs precisely enough for another agent to implement across the DataOps and deepseek-harness-plus repositories.

The designs solve different problems. Design A gives the model physical query knowledge and lets it write SQL. Design B gives the model a logical query interface and lets DataOps select physical sources and compile SQL. A resource description is not a semantic compiler, and a logical semantic model is insufficient context for a model that must write physical SQL.

The existing DataOps MCP server is a reusable adapter foundation, but its current tools forward large JSON payloads directly and bind identity through fixed process environment variables. The migration therefore also needs bounded results, reusable result references, a single-principal DSH runtime contract, credential-backed HTTP MCP authentication, and explicit ownership of batch model work.

## Proposal

Keep DataOps as the owner of the MCP query contracts and reuse `@deepseek-ai/dsh-mcp-client` in DSH. Standalone DSH uses authenticated Streamable HTTP MCP. A DataOps-managed per-user container uses the local MCP adapter and a DataOps-owned Unix broker so the workspace principal stays outside the DSH main process. Add an optional DataOps Auth/Integration Plugin for standalone browser authorization and credential lifecycle, but do not add a DataOps query-tool implementation to DSH, execute SQL in DSH, or use Bash as the formal query interface. DataOps owns user authentication, authorization, runtime distribution, resource discovery, API connectors, query execution, result materialization, and audit.

This integration follows the [plugin ownership and distribution decision](../../implemented/architecture/2026-08-20-plugin-ownership-and-distribution.md): DataOps-specific identity, configuration, UI, tools, and deployment stay in optional plugins or profile overlays. A missing DSH extension point requires a separate report and explicit user approval before any core source change; this RFC does not grant that approval.

Expose two selectable query facets. Design A is the migration MVP for broad ad hoc coverage. Design B is a later governed capability for business models whose metric and physical-routing correctness justifies a compiler. Both reuse the same result, export, and chart contracts.

### Ownership

| Responsibility | Owner | Contract |
| --- | --- | --- |
| User authentication and DSH instance distribution | DataOps | DataOps provisions one container with an independent `DSH_HOME` per user and binds that runtime permanently to the same principal |
| Optional DataOps integration in DSH | External DataOps Auth/Integration Plugin | Starts Authorization Code + PKCE, acquires/stores credential references, and composes the generic MCP client; omission leaves generic MCP transport unauthenticated |
| Generic MCP authentication | DSH credential service and MCP client | Resolves a credential reference, attaches current transport credentials, and reconnects after credential changes |
| MCP tools | DSH MCP client and DataOps MCP server | DSH discovers and calls tools; DataOps authenticates each HTTP request and serves the tools |
| Resource catalog | DataOps | Search, complete listing, detail, visibility, descriptions, usage manuals, columns, and lineage |
| Design A query | Model plus DataOps query executor | Model selects physical resources and writes SQL; DataOps performs generic checks and executes |
| Design B query | DataOps semantic query service | Model submits logical members; DataOps selects sources and compiles SQL |
| Result snapshots | DataOps | Immutable authorized result references, bounded pages, export, expiry, and audit |
| Interactive chart | `@sparkelf/dsh-chart` | DSH registers the top-level `render_chart` tool and owns durable chart presentation |
| Batch AI analysis | `@sparkelf/dsh-query-result-analysis` | DSH registers the top-level `analyze_query_result` tool and owns model calls, retry, checkpoints, and reduction |

### Authentication and deployment

DataOps is the multi-user control plane. `AiWorkspaceService` provisions or reuses exactly one DSH container for each DataOps user, and each container has an independent `DSH_HOME` for credentials, session history, and plugin state. The container owner is immutable: every conversation and DataOps connection in that runtime belongs to the same principal. Container placement supports isolation but does not replace authentication.

A DataOps-managed container does not repeat browser OAuth. The authenticated DataOps browser reaches DSH only through the Workspace Web Gateway at `http://<dshTargetRef>.dsh.<internal-domain>/`: one immutable managed target owns one browser origin, while a static wildcard DNS record routes every target host to the same gateway. The trusted-internal deployment contract defaults to HTTP/WS and a host-only HttpOnly SameSite=Strict cookie without `Secure`; it never falls back from an explicitly configured HTTPS parent to HTTP. A one-time launch code binds the target host, user, and active DataOps session before the gateway sets that cookie. The gateway then forwards native root-mounted DSH HTTP and WebSocket traffic through the existing workspace agent tunnel to loopback DSH; containers expose no browser-routable port and DSH core needs no base-path support. Inside the container, DSH calls the local MCP adapter, which delegates through a DataOps-owned Unix broker. Only the broker receives the workspace user ID, internal token, and backend location; the DSH main process, model context, URL, and tool arguments do not receive those credentials. Managed DSH does not mount the standalone authorization plugin, so Settings has no Connect, Reauthorize, or Disconnect actions.

The external DataOps Auth/Integration Plugin is optional for standalone DSH. If it is not configured, or a generic Streamable HTTP MCP client is configured without a credential reference, DSH sends no `Authorization` header and attempts an anonymous MCP connection; the remote MCP server owns whether anonymous access exists. The production DataOps data-query MCP endpoint requires authentication and rejects that anonymous attempt.

A direct standalone DSH visit starts DataOps Authorization Code with PKCE. DSH generates one random target reference in its credential store and retains it for the life of that `DSH_HOME`. DataOps owns the browser authorization page, normal login and MFA, and explicit account confirmation. The first approval atomically binds an unbound target reference to the selected OIDC `sub`; every later approval, refresh, reconnect, and MCP session must use that owner. Disconnect clears access and refresh credentials but retains the target reference and DataOps binding, so another account is rejected instead of rebinding the runtime.

A launch from DataOps may carry only a short-lived, single-use code bound to the user, OAuth client, target DSH instance, audience, state, and expiry; the plugin exchanges it server-side and removes it from the URL. Access and refresh credentials never appear in URL parameters, tool arguments, model context, browser local storage, or session logs. The plugin stores standalone provider credentials through the DSH credential service, and the generic MCP client resolves the current bearer token before each HTTP request without logging it.

Authenticated Streamable HTTP MCP requests carry `Authorization: Bearer <access-token>`. DataOps validates issuer, audience, expiry, authorized client, user, and MCP scope, then projects an `AuthorizationPrincipal` into the tool handler. The MCP audience and scope permit entry to the protected endpoint but grant no Resource access. Existing DataOps permissions and Resource authorization decide each tool operation, and result pages and exports reauthorize the current user. DSH does not copy or interpret the DataOps role and permission matrix.

DataOps binds each MCP session identifier to the immutable runtime principal. A refreshed credential for the same OIDC `sub` may continue; a different `sub` is rejected and cannot replace credentials or remount the MCP child inside that runtime. MCP session identifiers, DSH conversation identifiers, and result references are not credentials. A conversation identifier may later provide audit correlation without changing authorization.

The existing [DataOps MCP server](https://github.com/SparkElf/dataops/blob/main/infra/docker-workspace/runtime-daemon/src/dataops-mcp-server.mjs) remains the embedded adapter starting point. Standalone production uses Streamable HTTP; the managed container uses the adapter and Unix broker. Both transports derive the same DataOps principal before invoking the same catalog, query, result, permission, and audit owners.

## MCP contracts

MCP arguments and `structuredContent` use JSON. Model-facing text may be compact, but it must not duplicate the complete structured payload. Cross-boundary identifiers are opaque and principal-scoped. Access tokens travel only in the HTTP `Authorization` header; tool arguments never contain access tokens, refresh tokens, user IDs, tenant IDs, or verification fields. Models never receive database credentials, connection strings, or unscoped internal numeric IDs.

### Design A MVP tool composition

The model-visible data workflow contains ten domain tools with two registration owners. The DataOps MCP server registers `search_resources`, `list_resources`, `describe_resource`, `search_query_guidance`, `execute_sql`, `call_data_api`, `read_query_result`, and `export_query_result`. The DSH profile registers `render_chart` and `analyze_query_result` as top-level plugin tools; neither is an MCP tool.

The two DSH tools consume DataOps results without taking ownership of DataOps transport or authorization. `analyze_query_result` invokes the visible `read_query_result` capability through the same Agent, so every page still uses the current MCP principal and DataOps authorization. `render_chart` receives one source reference plus a complete chart option prepared from that result; it does not dereference DataOps results itself.

`execute_query_template` is an optional Design A extension and is not part of the eight-tool MCP MVP. Design B semantic-model discovery and execution tools are also excluded from this MVP.

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

The Design A MVP implements only the synchronous completed path. `execute_sql` and `call_data_api` return `{status:"completed", resultRef, preview, provenance}` after execution and materialization finish inside the interactive budget. Durable `accepted + executionRef`, status, and cancellation remain deferred until observed workloads require a durable execution owner.

Every completed SQL or API result is materialized once as an immutable, principal-scoped staging snapshot with a server-owned expiry. The model receives only an opaque `resultRef`, bounded preview, metadata, and provenance; it never receives a staging table name or the complete result in one tool response.

`read_query_result` accepts `{resultRef, cursor?, columns?, limit?}` and returns a byte-bounded page of complete rows or JSON items, returned count, total count when known, `hasMore`, and an opaque projection-bound `nextCursor`. The DataOps result service applies the byte bound before MCP/model projection; row count is only a secondary bound. Reads use a stable hidden row ordinal, never rerun the source operation, and reauthorize the current principal for every page.

`export_query_result` consumes the same `resultRef` through the authorized paging path and creates CSV or JSONL incrementally without rerunning the source operation. It returns `{artifactRef, fileName, mediaType, sizeBytes, downloadUrl, expiresAt}`. `downloadUrl` is an absolute DataOps application route without a credential; when the user opens it, the page uses the current DataOps login and the binary endpoint reauthorizes result ownership, expiry, and source Resource access.

`analyze_query_result({resultRef, instruction, resumeAnalysisRef?, maxBatchRetries?})` is an AI semantic-analysis workflow over a result that DataOps has already filtered, joined, aggregated, and sorted to the required business grain. Each DataOps page becomes one DSH model batch with stable `<resultRef>#row-N` evidence labels. DSH checkpoints completed batches, retries only provider-policy-eligible failures within the requested cap, propagates cancellation, and reduces groups of batch summaries until it returns `analysisRef`, `summary`, row and batch counts, resume state, and provider/model facts.

Deterministic filtering, joins, aggregation, ranking, deduplication, and exact statistics belong in `execute_sql` or `call_data_api` before `resultRef` creation. `analyze_query_result` explains and synthesizes a multi-page result; its lossy model summaries are not an exact numerical result source.

### Interactive chart presentation

`@sparkelf/dsh-chart` registers the top-level `render_chart({sourceResultRef, option, title?})` tool in DSH rather than DataOps MCP. One chart has exactly one non-empty `sourceResultRef`. DataOps must first produce a result at a useful display grain; if database-scale filtering, joins, or aggregation remain, the Agent issues a better query instead of rebuilding a data engine in visualization code.

The Agent may call `render_chart` directly for a simple chart. For presentation-oriented mapping, filtering, sorting, reshape, type conversion, percentages, cumulative values, reference lines, or annotations, DSH Code Mode reads the required result pages and produces the JSON ECharts option before making the top-level tool call. Code Mode does not join multiple result references.

The `option` contains all data required for replay and must be JSON-serializable; JavaScript callback functions are excluded. DSH stores the complete option in durable tool-result `presentationMeta`, while `sourceResultRef` remains provenance only. Session replay renders from the recorded option and does not contact DataOps or depend on the result TTL.

The keyed Web Client view renders the interactive ECharts presentation and owns initialization, resize, theme recreation, and disposal. The normal conversation view shows the optional title, chart, and necessary loading or failure state; it does not expose option JSON, result references, plugin implementation terms, or raw ECharts exceptions. The plugin is opt-in and is included explicitly by the DataOps-managed DSH profile rather than the DSH default profile.

## Design A orchestration

1. For explicit tables, fields, databases, schemas, inventory, count, or existence questions, use catalog tools. Complete lists use `list_resources`, exact existence uses exact list filters, and selected detail uses `describe_resource`.
2. For ambiguous business questions involving several resources, metrics, summary/detail choices, or join risks, call `search_query_guidance`.
3. If the QueryGuide contains enough key mappings, generate SQL. If it only identifies resources, call `describe_resource` for full technical facts.
4. Generate SQL with declared resources and aliases, then call `execute_sql`.
5. Inspect bounded output with `read_query_result`, deliver full data with `export_query_result`, render a prepared result with `render_chart`, and use `analyze_query_result` only when a processed multi-page result needs AI semantic synthesis.

The skill recommends the order; the server does not track search history. There is no `searchRef`. Execution validates actual sources and SQL, not whether the model previously called discovery.

## Design B orchestration

1. Discover a logical model and inspect its dimensions, metrics, relationships, aliases, and examples.
2. Submit `execute_semantic_query` with logical members only.
3. DataOps validates and compiles against the active semantic snapshot and internal physical mapping.
4. DataOps executes compiled SQL and returns the shared result reference.
5. The shared result reference supports bounded pages and export; DSH plugin tools provide chart presentation and AI semantic analysis.

The model does not select summary or detail sources in Design B. Compact execution provenance explains the route; the compiler owns physical SQL.

## Storage

DataOps remains the database source of truth. Resource `remark`, `usageManual`, columns, and lineage store single-resource facts. Add QueryGuide only for cross-resource scenario knowledge that cannot belong cleanly to one resource. Keep SemanticQueryTemplate for approved fixed SQL scenarios.

Design B uses a separate structured SemanticModel snapshot containing logical members, metric expressions, approved relationships, physical implementations, source coverage, grain, additive behavior, freshness, and security policy. The model-facing projection need not expose physical mappings, but the compiler loads them.

Do not switch DataOps to a filesystem source of truth to copy Wren's MDL layout. Wren's files are a versioned compiler input; DataOps already owns database drafts, approvals, permissions, resources, lineage, and AI visibility. A later exporter may produce YAML or JSON for Git review or an external engine, but files and database cannot be competing authorities.

## Implementation split

DataOps `AiWorkspaceService` owns the one-user-one-container mapping, independent `DSH_HOME` allocation, immutable per-target browser origin, Workspace Web Gateway, and broker identity. DataOps also provides Authorization Code with PKCE for standalone integration, atomically records an unbound target's first owner, validates every later selection against that owner, exchanges single-use launch codes, issues MCP-audience tokens and scopes, authenticates each HTTP MCP request, and maps both transports onto its existing catalog, query, API, result, permission, and audit services. It adds QueryGuide storage only for genuine cross-resource guidance and implements Design B only in a later compiler project. The DataOps backend and MCP server do not import DSH packages.

DSH core adds only the generic credential-backed MCP authentication capability. An optional DataOps-specific integration package may be distributed with standalone DSH, but it is outside the core/default profile and owns only the persistent target reference, browser OAuth, credential acquisition, and composition of the generic MCP client. It cannot replace a bound principal inside a running identity workspace and is not mounted in a DataOps-managed container. It contains no DataOps query identifiers, SQL execution, source routing, authorization policy, or connector logic. DSH composes `@sparkelf/dsh-chart` and `@sparkelf/dsh-query-result-analysis` through public plugin/profile extension points; these plugins consume public result capabilities and never receive DataOps transport credentials.

The [previous HTTP `dq/v1` proposal](../../rejected/architecture/2026-08-19-generic-data-query-protocol.md) and hypothetical `dsh-plugin-dataquery` are superseded. MCP is the chosen transport.

## Alternatives considered

**HTTP plus a DSH data-query plugin.** Rejected because DSH already bridges MCP tools; another query plugin would duplicate transport, schema projection, cancellation, and result handling. This does not reject the separate DataOps Auth/Integration Plugin, which owns OAuth and credential lifecycle without implementing tools.

**Static tokens in MCP config, stdio environment, or launch URLs.** Rejected because tokens expire and those locations leak or cannot refresh safely. The accepted path is a credential reference for standalone MCP HTTP requests, broker-owned identity for managed containers, and a one-time launch code for browser entry.

**Switch a DataOps account inside one DSH runtime.** Rejected because replacing credentials and remounting only the MCP child leaves the prior account's session history and plugin state in the same `DSH_HOME`. A different principal uses its own per-user container; the current runtime principal is immutable.

**Bash calling HTTP endpoints.** Rejected as the formal contract because stdout truncation, string parsing, credential exposure, shell permission, and weak audit identity remain.

**One overloaded discovery tool.** Rejected because fuzzy recall, exhaustive listing, selected detail, and cross-resource guidance have different completeness and payload semantics. They may share one backend service, not one model contract.

**Render charts in DataOps MCP or replay from a live result reference.** Rejected because chart construction and browser presentation belong to DSH, while a live `resultRef` expires and would make session replay depend on DataOps availability and current authorization. The complete JSON option is the durable replay record.

**Join multiple result references in the chart plugin.** Rejected because it introduces a second data-computation and authorization owner. DataOps produces one chart-ready result; the chart plugin performs only display-oriented transformation.

**Expose only a logical semantic model to Design A.** Rejected because a model writing physical SQL needs scenario-specific physical mappings and warnings; repeating logical dimensions and metrics does not solve summary/detail selection.

**Build Design B before migration.** Rejected for MVP scope. Design A, bounded results, and approved templates cover migration; Design B follows when observed metric or routing failures justify compiler investment.

**Use filesystem semantic storage.** Rejected because it would create a second authority beside existing database governance. Optional export is sufficient.

## Acceptance criteria

- The note keeps Design A model-generated physical SQL and Design B DataOps-compiled logical queries distinct.
- DataOps owns the HTTP MCP server and its eight Design A tools; DSH composes the generic MCP client plus top-level `render_chart` and `analyze_query_result` plugin tools without implementing DataOps query semantics.
- Catalog contracts distinguish fuzzy candidates, complete listing, and selected detail; a fuzzy miss is never an existence result.
- QueryGuide is sparse cross-resource knowledge layered over existing resource facts and does not duplicate complete schemas.
- Design A explicitly excludes automatic routing, SQL rewrite, and search-history proof.
- Design B defines logical input, compiler ownership, source selection, grain/metric rules, SQL rendering, and versioned provenance.
- The Design A MVP exposes only completed immutable `resultRef` outcomes; durable accepted execution, status, and cancellation tools remain absent until observed workloads require them.
- Shared results define immutable snapshots, byte-bounded pages, current-principal reauthorization, DataOps export artifacts, and DSH-owned chart and AI-analysis consumers.
- Deterministic data processing completes before `resultRef` creation; `analyze_query_result` performs only bounded AI semantic synthesis and never defines exact numeric facts.
- Each `render_chart` call names one source result and persists the complete JSON ECharts option as DSH presentation metadata; replay never dereferences DataOps, and chart code does not join result references.
- DataOps provisions exactly one independent-`DSH_HOME` container and one immutable browser origin per user; managed containers use the trusted-internal HTTP target host, gateway, and broker identity, standalone integration uses OAuth/PKCE with a one-time target binding, and neither path can rebind a running runtime to another principal.
- MCP audience and scope grant endpoint entry only; DataOps permissions and Resource authorization remain authoritative for every tool call, result page, and export, and tool arguments contain no identity fields.
- The old HTTP proposal is rejected and points to this MCP proposal.

## Risks

- Design A can choose a wrong physical source despite correct guidance; use Design B or an approved template when that error is unacceptable.
- QueryGuide can become stale if it repeats Resource facts; it must reference resources and state only cross-resource exceptions.
- Large inventories require pagination and artifact export before complete rows enter model context.
- Result references require principal binding, expiry, authorization on every read, and creation/access audit.
- Persisting complete chart options duplicates display data into DSH sessions. A separate chart artifact or automatic sampler is not added until measured option sizes demonstrate that the session record is unsuitable.
- Reusing one `DSH_HOME` across DataOps users would mix credentials, session history, and plugin state even if MCP requests remain correctly authorized. `AiWorkspaceService` must preserve the one-user-one-container mapping and immutable owner binding.
- Static MCP headers cannot refresh credentials. The generic credential-reference integration and reconnect behavior must ship before production HTTP MCP authentication.
- Operations that exceed the interactive budget cannot return an accepted state until DataOps owns durable execution state and explicit cancellation; adding only response fields would leave database work without a lifecycle owner.
- Design B is substantial compiler work and must not be advertised as available until its compiler and conformance coverage ship.

## Verification

Verification for this decision covers one-user-one-container allocation with independent `DSH_HOME`, per-target browser origins with isolated storage, trusted-internal HTTP bootstrap and native root routing without DSH core changes, managed gateway/broker identity without DSH-process secrets, standalone MFA login and single-use launch-code exchange, same-principal token refresh, target-owner and principal-mismatch rejection, absence of managed account-switch actions, per-request scope and Resource authorization, the absence of secrets and identity fields from model-visible calls, completed result materialization, snapshot/page/expiry authorization, export without source-operation rerun, exact eight-plus-two tool composition, and a keyless model-visible snapshot. Chart coverage must prove top-level tool registration, one-source validation, durable replay from presentation metadata, keyed browser rendering, theme/resize lifecycle, and generic user-facing failure output. Batch-analysis coverage must prove bounded page reads, stable row evidence, provider-policy-aware retry, cancellation, completed-batch resume, and hierarchical reduction. Design B must cover summary selection, detail fallback, additive and non-additive metrics, unsafe fanout rejection, dialect rendering, permission predicates, and stable versioned provenance before availability.
