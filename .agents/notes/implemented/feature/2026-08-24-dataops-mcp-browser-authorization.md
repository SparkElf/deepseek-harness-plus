# Agent Note: DataOps MCP browser authorization integration

Status: implemented

English | [中文](2026-08-24-dataops-mcp-browser-authorization.zh.md)

## Problem

The generic MCP client can now resolve a bearer credential by reference, but it does not acquire DataOps credentials. The DataOps integration needs an optional user-facing authorization path without putting DataOps login, SQL, catalog, or permission logic into the generic MCP package.

The DataOps browser may hold several active account sessions at once. Authorization must therefore make the selected account explicit rather than silently inheriting one browser tab. At the same time, a DSH configuration that omits DataOps authorization must preserve the generic Streamable HTTP behavior and attempt the MCP connection without an `Authorization` header.

## Decision

Add `@deepseek-ai/dsh-mcp-dataops` as an optional dual-half plugin.

The Host half composes `@deepseek-ai/dsh-mcp-client`; it does not register DataOps query tools itself. Without `credentialRef`, it mounts the generic MCP client immediately with no bearer credential. With `credentialRef`, it requires the existing credential service, waits for a stored access credential, and then mounts the same generic MCP client with `bearerTokenRef`.

The browser half contributes a DataOps page to DSH Settings. **Connect DataOps** opens a DataOps Authorization Code + PKCE flow. DataOps owns the authorization page and presents every active DataOps account available in that browser; the user must choose one account before approval. DSH receives only the authorization code, exchanges it server-side, stores the resulting MCP access token through `ctx.credentials`, and never receives the selected account's password or DataOps refresh cookie.

The callback URI uses the actual DSH browser origin that initiated the flow and is accepted only when that origin's host matches the DSH request Host. Credential mutation and browser authorization remain loopback-only, matching the current DSH settings/credential control plane. DataOps may separately allow explicitly registered HTTPS callback URIs for a future authenticated remote host control plane.

The integration is not added to the shipped default profile. Existing direct `mcp-client` configurations therefore remain unchanged.

## Consequences

- Omitting the integration credential keeps the MCP transport anonymous; the remote MCP server still owns the decision to accept or reject anonymous access.
- Configuring the integration keeps DataOps-specific OAuth, account selection, and credential acquisition outside `dsh-mcp-client`.
- DataOps account/session cookies never cross into DSH. The model sees only the MCP tools published by the generic client.
- The current authorization response contains an access token only and is bounded by the selected DataOps session lifetime. Delegated refresh remains deferred until DataOps owns an accepted refresh contract.
- The package has both Host and browser faces, so it follows the repository's dual-half package build and client-module conventions.

## Verification

Focused Host tests cover anonymous MCP composition, Authorization Code + PKCE exchange, credential storage, selected-account status, and disconnect. A Loader + Include composition test boots the optional plugin from a real test `cordis.yml` and verifies that anonymous mode sends no `Authorization` header. Client registration tests cover the Settings contribution and disposal.

## Relationship to the data-query design

This note implements the DSH integration-plugin portion of [MCP Data Query Integration and A/B Query Designs](../../proposed/architecture/2026-08-23-mcp-data-query-architecture.md). DataOps owns the matching authorization endpoints, explicit multi-account chooser, MCP token audience/scope, and MCP-side authorization.
