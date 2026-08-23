# Agent Note: MCP credential-backed Streamable HTTP authentication

Status: implemented

English | [中文](2026-08-23-mcp-credential-backed-http-auth.zh.md)

## Problem

The MCP client accepted literal HTTP headers only. An integration that refreshes a user access token therefore had to rewrite Cordis configuration or place the secret directly in `headers.Authorization`, even though DSH already owns a credential-reference service whose values can change without exposing them to configuration or model context.

The DataOps MCP integration needs bearer authentication while keeping OAuth acquisition and refresh outside the generic MCP package.

## Decision

`@deepseek-ai/dsh-mcp-client` adds optional `bearerTokenRef` to the `streamable-http` config branch. The value is a DSH `CredentialRef`, not a token.

When `bearerTokenRef` is configured, the MCP client requires `ctx.credentials` and supplies the MCP SDK transport with a custom `fetch`. That fetch resolves the reference through `ctx.credentials` immediately before every HTTP request, sets `Authorization: Bearer <value>` on the request, and delegates to the platform fetch implementation.

This uses the existing credential service's per-operation resolution rule and the current MCP SDK v1 Streamable HTTP fetch extension point. A provider-managed token refresh reaches the next MCP request without a plugin restart, an SDK upgrade, or a new MCP connection lifecycle state.

Static HTTP headers remain supported. `headers.Authorization` and `bearerTokenRef` cannot be configured together because they would assign the same request header to two owners.

The generic package does not implement Authorization Code, PKCE, MFA, refresh-token exchange, revocation, browser redirects, or provider-specific scope policy. An external integration plugin owns those operations and writes the resulting access credential through the credential service.

## Consequences

- Secrets stay out of `cordis.yml`, tool arguments, and model-visible MCP schemas when the credential-reference path is used.
- Credential rotation uses the existing `CredentialProvider.resolve()` semantics rather than an MCP-specific refresh cache or reconnect state machine.
- The MCP package gains a peer dependency on `@deepseek-ai/dsh-credentials`; the service remains optional unless `bearerTokenRef` is configured.
- Existing stdio configuration and Streamable HTTP servers using literal headers keep their current behavior.

## Verification

Focused tests cover config parsing, missing credential-service failure, conflicting `Authorization` ownership, and repeated transport fetch calls observing the current credential value while preserving other request headers. Package typecheck, build, lint, documentation synchronization, and the existing MCP client tests remain the owning repository checks.

## Relationship to the data-query design

This note implements only the generic DSH authentication portion of [MCP Data Query Integration and A/B Query Designs](../../proposed/architecture/2026-08-23-mcp-data-query-architecture.md). DataOps authentication flows and query tools remain outside this package.
