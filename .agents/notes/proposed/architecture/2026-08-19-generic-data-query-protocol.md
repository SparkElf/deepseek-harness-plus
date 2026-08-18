# Agent Note: Generic Intelligent Data-Query Tool and Middle-Platform Protocol

Status: proposed

English | [中文](2026-08-19-generic-data-query-protocol.zh.md)

## Problem

The dataops project's intelligent data-query AI serves real work through tools that are hard-wired to dataops internals: `search_resources` (resource wiki/catalog discovery), `query_table` (read-only SQL over dataops-connected engines with platform visibility filters), `query_api` (parameterized calls to dataops-registered data APIs), and the `kb_search`/`kb_explore`/`kb_read` semantic retrieval trio. Any other middle platform (data middle-office, BI semantic layer, lakehouse catalog) that wants the same intelligent querying needs a fork of those tools. Harness users therefore cannot point the agent at an arbitrary middle platform, and dataops remains a single-vendor lock-in for the capability.

## Target tools inventory

The dataops AI agent catalog (`ai-agent-tool-catalog.ts`) exposes exactly these data-query tools, each hard-wired to a dataops service; the protocol maps them one-to-one:

| Tool | dataops dependency | Protocol endpoint |
| --- | --- | --- |
| `search_resources` | ResourceWikiCoreService catalog with intent gate and short-list | `POST /dq/v1/resources/search` |
| `query_table` | read-only SELECT/WITH executor over connected engines (Doris), runtime-injected `aiVisible`/`enabled`/`isEnabled`/`accessLevel` visibility filters, platform system tables for catalog/glossary/lineage metadata | `POST /dq/v1/query/sql` (visibility enforced server-side; system tables exposed as `kind: system` resources) |
| `query_api` | platform-registered executable API connectors; external URLs forbidden | `POST /dq/v1/query/api` |
| `kb_search` | knowledge-base chunk index, BM25 + semantic hybrid recall with metadata hard filters | `POST /dq/v1/kb/search` |
| `kb_explore` | same index, metadata-only exploration | `POST /dq/v1/kb/search` with `metadataOnly: true` |
| `kb_read` | chunk/section/full-text reader with pagination | `POST /dq/v1/kb/read` |

The two governance tools (`govern_metadata`, `glossary_resource_binding`) are write-path, skill-gated, and preview/confirm flows; they are deliberately outside the read-only `dq/v1` protocol and deferred to an optional governance facet.

## Proposal

Split the capability into three layers: a harness-side generic tool set, a wire protocol any middle platform implements, and a thin dataops adapter that implements the protocol over the existing services.

1. **Protocol (`dq/v1`).** JSON over HTTP, bearer-token auth, server-side permission enforcement; every endpoint returns `{columns, rows, truncated}` row sets or typed errors with stable codes.
   - `GET /dq/v1/capabilities` — supported facets (`sql`, `api`, `kb`, `glossary`), SQL dialects, row limits.
   - `POST /dq/v1/resources/search` `{query, kinds, limit}` — catalog discovery returning id/kind/name/description/columns-or-contract/owner/tags.
   - `POST /dq/v1/query/sql` `{resourceId, sql, maxRows}` — read-only execution; the middle platform rejects writes and enforces visibility (the dataops `aiVisible`/`accessLevel` filters become its server-side concern).
   - `POST /dq/v1/query/api` `{apiId, params, maxRows}` — parameterized data-API invocation.
   - `POST /dq/v1/kb/search`, `POST /dq/v1/kb/read` — optional semantic retrieval.
   - `GET /dq/v1/glossary` — optional business-term resolution.
2. **Harness plugin (`@sparkelf/dsh-plugin-dataquery` in dsh-plugins-plus).** Cordis plugin exposing generic tools `dq_search_resources`, `dq_query_sql`, `dq_query_api` (plus optional `dq_kb_*` when the capability is advertised), with zero dataops imports; the endpoint base URL and credential reference come from plugin config (`baseUrl`, credential-reference for the token), so one tool set serves every conforming middle platform. Tools render results as `terminal`/`diff`-friendly row tables per the tool UI contract.
3. **Dataops adapter.** A controller layer inside dataops (or a standalone sidecar) implementing `dq/v1` over `ResourceWikiCoreService`, the SQL execution path, the API-SDK registry, and the knowledge base — no changes to the existing AI tools during migration; the dataops AI can later consume the same protocol, deleting its hard-wired facades.

## Alternatives considered

**MCP server instead of an HTTP protocol.** Rejected for now: MCP adds a transport/runtime dependency on the middle platform side; the row-set protocol is a subset MCP can wrap later without loss.

**Keep dataops-specific tools and add per-platform forks.** Rejected: N platforms would fork N times; the protocol costs one adapter per platform instead.

**Put the generic tools in deepseek-harness-plus packages.** Rejected: they are independent plugins per the maintenance scheme; dsh-plugins-plus keeps them installable on upstream dsh.

## Consequences

- Middle platforms implement one small JSON contract to gain agent-driven intelligent querying.
- Dataops internals stop leaking into agent tooling; visibility and permissions stay server-side where they belong.
- The harness gains a capability-seam-shaped plugin (tools + config), consistent with repo conventions.

## Acceptance criteria

- The protocol document fixes endpoint paths, request/response schemas, error codes, and auth; a conformance checklist a middle platform can self-test.
- The plugin's tools contain no dataops-specific identifiers; configuration is only `baseUrl` plus credential reference.
- The dataops adapter maps each existing tool facet (search/sql/api/kb) to one protocol endpoint without altering current AI behavior.

## Risks

- Row-set shapes may not cover chart/stream payloads; `capabilities` plus a `media` extension point is the escape hatch, deferred until a real need.
- Permission models differ across platforms; the protocol mandates server-side enforcement and carries identity only, refusing to standardize authorization.

## Verification

- Design-only note: no code ships with it. Implementation lands as dsh-plugins-plus plugin plus a dataops adapter PR, each with keyless unit tests against a stub middle platform and one live conformance run against the dataops adapter.
