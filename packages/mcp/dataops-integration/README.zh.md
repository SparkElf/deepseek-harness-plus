# `@deepseek-ai/dsh-mcp-dataops`

[English](README.md) | 中文

基于通用 MCP client 的可选 DataOps 集成。这个包只负责 DataOps 特有的浏览器授权与组合；MCP transport / 工具桥接仍由 [`@deepseek-ai/dsh-mcp-client`](../mcp-client/README.zh.md) 负责，密钥持久化仍然通过 `ctx.credentials` 完成。

## 配置

```yaml
- name: '@deepseek-ai/dsh-mcp-dataops'
  config:
    baseUrl: https://dataops.example.com
    serverName: dataops
    credentialRef: DATAOPS_MCP_TOKEN
```

`baseUrl` 是 DataOps origin；`serverName` 成为通用 MCP 工具命名空间（`mcp__dataops__...`）；`credentialRef` 可省略。

### 匿名模式

不配置 `credentialRef` 时，插件立即通过通用 MCP client 连接 DataOps MCP endpoint，并且不发送 `Authorization` header。DSH 只负责发起匿名访问尝试；远端 DataOps MCP 是否接受匿名请求由 DataOps 自己的策略决定。

### 浏览器授权模式

配置 `credentialRef` 后，插件启用 DataOps OAuth 2.0 Authorization Code + PKCE 授权。访问本机 DSH 页面：

```text
/integrations/dataops
```

点击“连接 DataOps”。DSH 把浏览器跳转到 DataOps；DataOps 显示当前浏览器里仍然有效的登录账号，并要求用户**明确选择一个账号**后才签发 authorization code。code 回到本机 DSH callback 后，由 DSH 后端与 DataOps 做 server-to-server token exchange，只把最终 MCP access token 写入 `ctx.credentials`，随后再用 `bearerTokenRef` 挂载通用 MCP client。

DataOps 的 refresh/session cookie 永远不会离开 DataOps origin。MCP access token 不会进入浏览器 URL、HTML、工具参数、模型上下文或插件配置。

当授权模式已经配置、但 credential 尚不存在时，插件不会提前启动 authenticated MCP child，避免用户还在选择账号时就耗尽通用 MCP client 的有界 reconnect 次数。

## 模型体验

这个包不增加 system prompt，也不提供模型可见的认证工具。MCP child 建立连接后，模型只会看到 `@deepseek-ai/dsh-mcp-client` 注册的 server-qualified 工具。账号选择、PKCE、credential reference 和认证状态都不会进入模型上下文，因此这个插件本身不增加 token 或 KV-cache 消耗。

## 兼容性

这个包是可选插件，不加入现有默认 profile。原有直接配置 `@deepseek-ai/dsh-mcp-client` 的方式保持不变，包括免认证的 Streamable HTTP MCP，以及人工维护 `bearerTokenRef` 的方式。

## 已知限制与后续工作

当前 DataOps 授权只返回 access token。token 有效期受用户明确选择的 DataOps 浏览器登录 session 约束；该 session 过期或被撤销后，需要重新访问 `/integrations/dataops` 选择账号授权。只有在 DataOps 明确提供 delegated refresh 合同后，才会继续加入 refresh-token 获取与刷新流程。

浏览器授权属于本机高权限操作，因此当前只接受 loopback 请求。远程/LAN DSH 浏览器要做授权，需要另行设计带认证的 Host control plane，而不是放宽现有本地 credential 写入边界。
