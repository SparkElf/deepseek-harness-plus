# Agent Note: DataOps MCP delegated OIDC browser authorization

Status: implemented

English | [中文](2026-08-24-dataops-mcp-browser-authorization.zh.md)

## Problem

The generic MCP client can resolve a bearer credential by reference, but it must not acquire DataOps identities itself. DataOps integration needs an optional user-facing authorization path without moving DataOps login, MFA, SQL, catalog, or permission logic into the generic MCP package.

A DataOps browser may hold several active account sessions at once. Authorization must make the selected account explicit rather than silently inheriting a browser cookie. A DSH configuration that omits DataOps authorization must also preserve generic Streamable HTTP behavior and attempt the MCP connection without an `Authorization` header.

The DSH product is primarily Web-hosted, not a conventional desktop-only loopback app. At the same time, the current host web server has no authenticated remote credential-mutation control plane, so externally published callback topology cannot be inferred by weakening the existing loopback management boundary.

## Decision

Keep `@deepseek-ai/dsh-mcp-dataops` as an optional dual-half plugin layered on `@deepseek-ai/dsh-mcp-client`.

The Host half does not register DataOps query tools. Omitting both credential references mounts the generic MCP client immediately with no bearer credential. Authorization mode requires an access-token `credentialRef` and a `refreshCredentialRef` together. Both remain behind the existing credentials service; the generic MCP child receives only the access-token reference as `bearerTokenRef`.

The browser half contributes a DataOps page to DSH Settings. **Connect DataOps** opens an OAuth 2.0 Authorization Code + PKCE flow with `openid dataops.mcp` and `prompt=select_account`. DataOps owns the authorization page, existing login/MFA/session handling, and explicit account chooser. DSH receives the authorization code, exchanges it server-side, verifies the access-token identity through DataOps `userinfo`, stores the delegated access and refresh tokens, and never reads DataOps browser cookies or passwords. The ID token is not used as the MCP bearer token.

The Settings interaction follows DSH's existing feature-page design instead of exposing OAuth internals as a separate control surface: connection state and the currently authorized DataOps account are primary, while server URL and connection mode are collapsed under advanced details. The paired DataOps surface is a standalone Vue page using DataOps/Wanxiang design tokens. It never preselects an account, keeps authorization disabled until an explicit choice, and routes **Use another account** through the normal DataOps login/MFA experience. Returning to the popup refreshes available accounts automatically.

A stored authorization is refreshed before the MCP child is mounted. During the grant lifetime, the integration refreshes the access credential without remounting when OIDC `sub` is unchanged because the generic MCP client resolves the current credential at each HTTP request. DataOps HTTP MCP sessions are actually bound to `userId`, not browser `AuthSession.id`; therefore `sub` is the remount discriminator. When a newly authorized token resolves to a different `sub`, the integration disposes the current DataOps MCP child before storing the new principal's credentials and then mounts a fresh child.

DataOps bounds delegated token lifetime by the selected DataOps `AuthSession`. When refresh responses begin reporting a shorter access lifetime than the normal lifetime, the plugin stops scheduling further refreshes and lets that final access token expire with the grant rather than repeatedly halving an already fixed remaining session lifetime.

Credential mutation, status, connect, callback handling, and disconnect remain loopback-ingress operations. Local Web use derives the callback origin from the initiating DSH browser request and requires it to match the DSH Host. An externally published Web deployment can instead configure a canonical HTTPS `callbackOrigin`; DataOps must register the same origin. The external ingress must still reach the current unauthenticated DSH control plane through loopback. DSH does not trust `Host` or forwarded headers to invent a public callback origin.

The integration remains outside shipped default profiles, so direct `mcp-client` configurations and all other MCP servers are unchanged.

## Consequences

- Omitting both integration credential references keeps the MCP transport anonymous; the remote MCP server owns the decision to accept or reject it.
- DataOps-specific OAuth/OIDC, account selection, refresh, and principal switching remain outside `dsh-mcp-client` and outside the agent loop.
- DataOps browser cookies, passwords, and MFA secrets never cross into DSH. Delegated tokens stay in credential storage and server-side exchange paths rather than prompts, tools, browser URLs, or browser JavaScript.
- The user-facing flow talks about connecting DataOps and selecting an account rather than requiring users to understand OIDC, PKCE, token types, or MCP session identity.
- Same-`sub` access-token refresh or reauthorization keeps the existing DataOps MCP child. Different-`sub` authorization disposes and recreates that child so DataOps binds a new MCP session to the new user.
- Delegated refresh ends with the selected DataOps `AuthSession`; DSH does not invent a second long-lived DataOps login or speculative retry/queue layer.
- The package has Host and browser faces and follows the repository's dual-half build, Settings slot, lifecycle-effect, and disposal conventions.

## Verification

Focused Host tests cover anonymous MCP composition, OIDC Authorization Code + PKCE exchange, both delegated credentials, `userinfo` identity, startup refresh-before-mount, same-principal reuse, different-principal remount, canonical callback origin, and disconnect. A Loader + Include real-composition test boots the optional plugin from a test `cordis.yml` and verifies that anonymous mode sends no `Authorization` header. Client registration tests cover the Settings contribution and disposal. The paired DataOps system test drives the real native authorization UI, verifies no account is preselected, verifies the primary authorization action is disabled until selection, signs another account in through the normal DataOps auth experience, and confirms the chooser refreshes when focus returns.

## Relationship to the data-query design

This note implements the DSH integration-plugin portion of [MCP Data Query Integration and A/B Query Designs](../../proposed/architecture/2026-08-23-mcp-data-query-architecture.md). The paired DataOps delegated-authorization implementation is tracked in `SparkElf/dataops#3`; it owns the authorization page, explicit multi-account chooser, OIDC/token issuance, MCP audience/scope validation, and DataOps-side principal enforcement.
