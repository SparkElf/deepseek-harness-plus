# Agent Note: DataOps MCP delegated OIDC browser authorization

Status: implemented

English | [中文](2026-08-24-dataops-mcp-browser-authorization.zh.md)

## Problem

The generic MCP client resolves bearer credentials but does not own DataOps identity acquisition. Standalone DataOps integration needs browser authorization without moving login, MFA, query, catalog, or permission logic into DSH core.

A DSH runtime also retains session history, credentials, and plugin state in one `DSH_HOME`. Replacing only the DataOps MCP credential would mix principals inside that retained state, so a browser account chooser cannot become a runtime account-switch mechanism.

## Decision

Keep `@deepseek-ai/dsh-mcp-dataops` as an optional standalone dual-half plugin layered on `@deepseek-ai/dsh-mcp-client`. DataOps-managed containers use the DataOps-owned Unix broker and do not mount this plugin.

The Host half requires access, refresh, and target credential references. It generates the target reference once when absent and retains it when delegated tokens are disconnected. The target is an opaque random identifier scoped to one `DSH_HOME`; it is not a credential and contains no DataOps user identity.

DataOps atomically binds an unbound target to the OIDC `sub` selected during its first explicit authorization. Every later authorization request resolves the target owner before listing browser sessions, so only that owner can approve. Disconnect and token expiry do not remove the binding, and no DSH route or Settings action can unbind or replace it.

The browser half contributes a DataOps page to DSH Settings. **Connect DataOps** opens Authorization Code + PKCE with `openid dataops.mcp`. DataOps owns authorization, login, MFA, and account confirmation. DSH exchanges the code server-side, verifies the access token through `userinfo`, and commits delegated credentials with the generic MCP child as one operation. A failed credential write or child mount restores the prior grant; only the access credential reference reaches the child.

A writable stored grant refreshes before MCP mount and during the DataOps browser session's normal access-token lifetime. The generic MCP client resolves the access credential before every HTTP request, so refresh does not remount the child. A shorter final token or failed refresh unmounts the child; a valid administrator-managed read-only grant mounts without mutation and delegates rotation to its credential provider.

Credential mutation and integration routes require loopback ingress and a same-origin DSH browser request. Local Web derives its callback only from a loopback origin; externally published Web declares one explicit HTTP or HTTPS `callbackOrigin`, and DataOps registers it. Trusted-LAN HTTP is explicit and never an HTTPS fallback.

## Alternatives considered

- Release or rotate the target on Disconnect so another account can bind. Rejected because the retained `DSH_HOME` would then mix principals across session history, credentials, and plugin state.
- Mount standalone browser authorization in DataOps-managed containers. Rejected because the managed gateway and broker already own identity and must not add a second account channel.
- Move DataOps OAuth into DSH core or the generic MCP client. Rejected because provider login, MFA, scope, target binding, and revocation are integration-owned behavior.

## Consequences

- One standalone `DSH_HOME` acquires one DataOps principal for its lifetime.
- First authorization may choose among active DataOps sessions; later authorization presents only the bound owner.
- Reauthorization renews the same owner, while disconnect revokes and clears only delegated tokens.
- Plugin disposal aborts DataOps I/O, waits for active authorization operations, clears pending state and refresh timing, and removes the MCP child.
- Managed containers contain no standalone authorization controls or delegated DataOps tokens in the DSH process.
- DataOps cookies, passwords, MFA secrets, and delegated token values stay outside prompts, tools, browser URLs, browser JavaScript, and session logs.
- The package adds no DataOps query implementation and no account-switch, target-unbind, retry-queue, or compatibility path.

## Verification

The standalone user path covers first target creation, explicit first account binding, same-owner reauthorization, rollback-safe refresh-before-mount, remote revocation with retained target, different-owner rejection, explicit trusted-HTTP callback validation, same-origin management, final-token expiry, Settings recovery, and child disposal. The managed path proves that only the Unix-broker MCP adapter is composed and that the standalone Settings contribution is absent. DataOps browser coverage drives login/MFA and the native authorization page through visible UI.

## Relationship to the data-query design

This note implements the standalone DSH authorization portion of [MCP Data Query Integration and A/B Query Designs](../../proposed/architecture/2026-08-23-mcp-data-query-architecture.md). DataOps owns target binding, authorization UI, OIDC tokens, MCP audience and scope validation, and principal enforcement.
