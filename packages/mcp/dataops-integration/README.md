# `@deepseek-ai/dsh-mcp-dataops`

English | [中文](README.zh.md)

Optional DataOps integration over the generic MCP client. It owns DataOps-specific browser authorization, OIDC identity, delegated token refresh, and principal-aware composition only; MCP transport/tool bridging remains in [`@deepseek-ai/dsh-mcp-client`](../mcp-client/README.md), and secret storage remains behind `ctx.credentials`.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-mcp-dataops'
  config:
    baseUrl: https://dataops.example.com
    serverName: dataops
    credentialRef: DATAOPS_MCP_TOKEN
    refreshCredentialRef: DATAOPS_MCP_REFRESH_TOKEN
    # For an externally published DSH Web origin:
    # callbackOrigin: https://dsh.example.com
```

`baseUrl` is the DataOps origin. `serverName` becomes the generic MCP namespace (`mcp__dataops__...`). `credentialRef` and `refreshCredentialRef` are optional as a pair. `callbackOrigin` is optional; local DSH derives the browser origin from the loopback Settings request, while an externally published Web deployment can declare its canonical HTTPS callback origin explicitly.

### Anonymous mode

Omit both credential refs to mount the DataOps MCP endpoint immediately through the generic MCP client without an `Authorization` header. DSH only attempts the anonymous connection; the remote MCP server decides whether to accept or reject it. The protected DataOps production MCP may therefore answer `401 Unauthorized`, which is a valid server-policy result.

### Browser authorization mode

Configure both credential refs to enable OAuth 2.0 Authorization Code + PKCE with OIDC identity. The optional browser half adds a **DataOps** page to the existing DSH Settings UI. Choose **Connect DataOps** there.

DSH opens DataOps in a popup with `openid dataops.mcp` and `prompt=select_account`. DataOps reads its own browser sessions, displays the account that will authorize DSH, and requires an explicit account choice. Login, account switching, and MFA stay entirely on DataOps. DSH receives the authorization code only, exchanges it server-side, validates the resulting access token through DataOps `userinfo`, stores the delegated access and refresh tokens through their credential references, and mounts the generic MCP client with the access-token `bearerTokenRef`. The returned ID token is part of the OIDC token response but is not used as the MCP bearer token.

The Settings page shows the authorized account, supports switching accounts through the same DataOps chooser, and can remove writable DSH-managed delegated credentials without logging the user out of DataOps. Both credential references must resolve to writable providers before Settings offers a new authorization or disconnect operation.

### Refresh and account switching

The integration refreshes the delegated access token through the stored refresh credential before mounting a previously authorized MCP connection and while the delegated grant can still issue the normal access-token lifetime. The generic MCP client resolves the current access credential before each HTTP request, so a refresh for the same OIDC `sub` does not require a new MCP connection.

DataOps HTTP MCP sessions are bound to the DataOps user principal. If a new authorization resolves to a different OIDC `sub`, this plugin disposes the existing DataOps MCP child **before** replacing the active principal and mounts a fresh child afterward. Reauthorizing the same `sub` keeps the existing child.

### Callback topology

Credential mutation and the integration management routes remain loopback-ingress operations because the current DSH host web server does not provide a remote control-plane authentication layer. Local Web use derives the callback from the actual loopback DSH browser origin.

For a DSH Web deployment published through a trusted ingress whose hop into DSH is loopback, set `callbackOrigin` to the canonical HTTPS origin and register that same origin in DataOps `AUTH_DSH_REDIRECT_ORIGINS`. DSH never derives an externally trusted callback from `Host` or forwarded headers. Direct unauthenticated LAN control access is not enabled by this plugin.

## Security

DataOps browser cookies, passwords, and MFA secrets never leave the DataOps origin. Delegated access, refresh, and ID tokens never appear in the browser authorization URL, browser JavaScript, tool arguments, model context, or plugin config. The callback page is only a transient popup bridge that notifies the DSH Settings page and closes itself.

Authentication state is outside the agent loop. This package does not implement DataOps SQL or catalog tools; it only composes the existing generic MCP client.

## Model Experience

This package adds no prompt text and no model-visible authentication tool. Once the child MCP connection is active, the model sees exactly the server-qualified tools registered by `@deepseek-ai/dsh-mcp-client`. Authentication state, browser account choice, PKCE material, OIDC identity, and credential references stay outside model context, so the plugin itself adds no token or KV-cache cost.

## Compatibility

This package is optional and is not part of the shipped default profile. Existing direct `@deepseek-ai/dsh-mcp-client` configurations continue to work unchanged. Omitting both credential refs preserves anonymous Streamable HTTP behavior; existing manually managed bearer references remain supported by the generic MCP client.

## Known Limitations and Deferred Work

The delegated refresh token is bounded by the DataOps `AuthSession` selected during authorization. If that DataOps session expires, is revoked, or the account is disabled, refresh stops, the DataOps MCP child is unmounted, and the user must authorize DataOps again. The integration does not invent a second long-lived DataOps login session or speculative retry/queue layer.

Authorization-code single use and delegated-token revocation are owned by the current DataOps authorization implementation; any future multi-replica persistence change belongs to DataOps rather than this DSH plugin.
