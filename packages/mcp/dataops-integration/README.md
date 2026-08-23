# `@deepseek-ai/dsh-mcp-dataops`

English | [中文](README.zh.md)

Optional DataOps integration over the generic MCP client. It owns DataOps-specific browser authorization and composition only; MCP transport/tool bridging remains in [`@deepseek-ai/dsh-mcp-client`](../mcp-client/README.md), and secret storage remains behind `ctx.credentials`.

## Configuration

```yaml
- name: '@deepseek-ai/dsh-mcp-dataops'
  config:
    baseUrl: https://dataops.example.com
    serverName: dataops
    credentialRef: DATAOPS_MCP_TOKEN
```

`baseUrl` is the DataOps origin. `serverName` becomes the generic MCP namespace (`mcp__dataops__...`). `credentialRef` is optional.

### Anonymous mode

Omit `credentialRef` to mount the DataOps MCP endpoint immediately through the generic MCP client without an `Authorization` header. DSH only attempts the anonymous connection; the remote MCP server decides whether to accept or reject it.

### Browser authorization mode

Set `credentialRef` to enable DataOps OAuth 2.0 Authorization Code + PKCE acquisition. The optional browser half adds a **DataOps** page to the existing DSH Settings UI. Choose **Connect DataOps** there.

DSH opens DataOps in a popup. DataOps lists the active accounts already signed in in that browser and requires an explicit account choice; it never selects an account automatically. After approval, the authorization code returns to the local DSH callback, DSH exchanges it server-to-server, writes only the resulting MCP access token through `ctx.credentials`, and mounts the generic MCP client with `bearerTokenRef`.

The Settings page shows the authorized account, supports switching accounts through the same DataOps chooser, and can remove a writable DSH-managed credential without logging the user out of DataOps. If the configured credential comes from a read-only provider layer, the page reports that it is externally managed rather than presenting a write action.

DataOps refresh/session cookies never leave the DataOps origin. The MCP access token never appears in the browser URL, browser JavaScript, tool arguments, model context, or plugin config. The callback page is only a transient popup bridge that notifies the DSH Settings page and closes itself.

When authorization mode is configured but the credential is not yet present, this package does not start the authenticated MCP child. Once the credential exists, `@deepseek-ai/dsh-mcp-client` resolves its current value at the request boundary.

## Model Experience

This package adds no prompt text and no model-visible authentication tool. Once the child MCP connection is active, the model sees exactly the server-qualified tools registered by `@deepseek-ai/dsh-mcp-client`. Authentication state, browser account choice, PKCE material, and credential references stay outside model context, so the plugin itself adds no token or KV-cache cost.

## Compatibility

This package is optional and is not part of the shipped default profile. Existing direct `@deepseek-ai/dsh-mcp-client` configurations continue to work unchanged. Omitting `credentialRef` preserves anonymous Streamable HTTP behavior; existing manually managed bearer references remain supported by the generic MCP client.

## Known Limitations and Deferred Work

The current DataOps authorization response contains an access token only. Its lifetime is bounded by the selected DataOps browser session; when that session expires or is revoked, choose **Connect DataOps** / **Switch account** in Settings again. Refresh-token acquisition is intentionally deferred until DataOps exposes an accepted delegated-refresh contract.

Browser authorization is a local privileged operation and is served only to loopback requests. Remote/LAN DSH browser authorization needs a separate authenticated host-control-plane design rather than weakening the existing local credential-mutation boundary.
