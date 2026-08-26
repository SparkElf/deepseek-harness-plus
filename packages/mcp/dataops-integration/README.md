# `@deepseek-ai/dsh-mcp-dataops`

English | [中文](README.zh.md)

Optional standalone DataOps integration over the generic MCP client. It owns one persistent target identity, DataOps browser authorization, delegated token refresh, and composition only; MCP transport and tool bridging remain in [`@deepseek-ai/dsh-mcp-client`](../mcp-client/README.md), and credential values remain behind `ctx.credentials`.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-mcp-dataops'
  config:
    baseUrl: https://dataops.example.com
    serverName: dataops
    credentialRef: DATAOPS_MCP_TOKEN
    refreshCredentialRef: DATAOPS_MCP_REFRESH_TOKEN
    targetCredentialRef: DATAOPS_DSH_TARGET
    # For an externally published DSH Web origin:
    # callbackOrigin: https://dsh.example.com
```

`baseUrl` is the DataOps origin. `serverName` becomes the generic MCP namespace (`mcp__dataops__...`). All three credential references are required. The access and refresh references must be writable for browser authorization and disconnect. If the target reference is not configured, its provider must be writable so the plugin can generate the target once. `callbackOrigin` is optional only for loopback DSH, which derives the browser origin from its Settings request. Every non-loopback Web deployment declares an explicit HTTP or HTTPS origin; HTTP is a trusted-LAN contract, not an HTTPS fallback.

This package is for standalone DSH only. A DataOps-managed container uses the DataOps-owned Unix broker and does not mount this package, so managed Settings has no DataOps Connect, Reauthorize, or Disconnect controls.

## Browser authorization

The package adds a **DataOps** page to DSH Settings. **Connect DataOps** opens OAuth 2.0 Authorization Code + PKCE with `openid dataops.mcp`. DataOps owns its authorization page, login, MFA, and account confirmation. DSH receives only the authorization code, exchanges it server-side, validates the access token through DataOps `userinfo`, and commits access/refresh credentials together with the generic MCP child. Any failed write or child mount restores the prior grant.

The plugin generates a random target reference once and retains it for the life of the current `DSH_HOME`. The first successful DataOps approval permanently binds an unbound target to the selected OIDC `sub`. Later authorization requests show only that owner. **Authorize again** renews the same owner's grant; it cannot select or install another principal.

**Disconnect** unmounts the DataOps MCP child, revokes the refresh and access tokens at DataOps, and removes both local credentials. It does not clear the target reference or release the DataOps owner binding. Reconnecting therefore returns to the same account.

## Refresh lifecycle

A writable stored grant is refreshed before the MCP child is mounted. While the selected DataOps `AuthSession` can still issue the normal access-token lifetime, the plugin refreshes the access credential without remounting because the generic MCP client resolves the current credential before each HTTP request. A valid administrator-managed read-only access credential mounts without mutation; its provider owns rotation.

When DataOps reports a shorter access lifetime, the plugin schedules MCP child removal at that final token's expiry instead of repeatedly refreshing a fixed remaining session lifetime. A failed refresh also unmounts the child and leaves an actionable reauthorization state in Settings.

## Callback topology

Credential mutation and integration management routes require loopback ingress and a same-origin DSH browser request because the host web server has no authenticated remote credential-mutation control plane. Local Web derives the callback only from an actual loopback browser origin.

For a DSH Web deployment published through a trusted ingress whose hop into DSH is loopback, set `callbackOrigin` to its explicit HTTP or HTTPS origin and register the same origin in DataOps `AUTH_DSH_REDIRECT_ORIGINS`. DSH does not derive a trusted public callback from `Host` or forwarded headers, and HTTPS never falls back to HTTP.

## Security

DataOps browser cookies, passwords, and MFA secrets never leave the DataOps origin. Delegated tokens never enter browser authorization URLs, browser JavaScript, tool arguments, model context, session logs, or plugin config. The target reference is an opaque identity, not a credential; it carries no user ID and cannot authorize MCP requests.

Authentication state remains outside the agent loop. This package contains no DataOps SQL, catalog, permission, connector, or result logic.

## Model Experience

This package adds no prompt text and no model-visible authentication tool. Once the MCP child is active, the model sees exactly the server-qualified tools registered by `@deepseek-ai/dsh-mcp-client`. Authorization state, target identity, PKCE material, OIDC identity, and credential references add no model tokens or KV-cache entries.

## Compatibility

This package is optional and remains outside shipped default profiles. Existing direct `@deepseek-ai/dsh-mcp-client` configurations, including generic anonymous or manually managed bearer configurations, remain owned by that package and are unchanged.

## Known Limitations and Deferred Work

The delegated grant cannot outlive the selected DataOps `AuthSession`. When that session expires, is revoked, or its account is disabled, refresh stops and the user must authorize the same DataOps owner again. The integration adds no second login session, retry queue, account-switch path, or target-unbind operation.
