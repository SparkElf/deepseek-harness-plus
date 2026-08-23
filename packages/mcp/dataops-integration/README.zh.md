# `@deepseek-ai/dsh-mcp-dataops`

[English](README.md) | 中文

基于通用 MCP client 的可选 DataOps 集成。这个包只负责 DataOps 特有的浏览器授权、OIDC 身份、委托 token 刷新和 principal-aware 组合；MCP transport / 工具桥接仍由 [`@deepseek-ai/dsh-mcp-client`](../mcp-client/README.zh.md) 负责，密钥持久化仍然通过 `ctx.credentials` 完成。

## 配置

```yaml
- name: '@deepseek-ai/dsh-mcp-dataops'
  config:
    baseUrl: https://dataops.example.com
    serverName: dataops
    credentialRef: DATAOPS_MCP_TOKEN
    refreshCredentialRef: DATAOPS_MCP_REFRESH_TOKEN
    # DSH Web 对外发布时：
    # callbackOrigin: https://dsh.example.com
```

`baseUrl` 是 DataOps origin；`serverName` 成为通用 MCP 工具命名空间（`mcp__dataops__...`）。`credentialRef` 与 `refreshCredentialRef` 必须成对配置，也可以同时省略。`callbackOrigin` 可选：本机 DSH 从 loopback Settings 请求得到实际浏览器 origin；对外发布的 Web 部署可以显式声明规范 HTTPS callback origin。

### 匿名模式

同时省略两个 credential reference 时，插件立即通过通用 MCP client 连接 DataOps MCP endpoint，并且不发送 `Authorization` header。DSH 只负责发起匿名访问尝试；远端 MCP Server 是否接受匿名请求由远端策略决定。因此受保护的 DataOps 生产 MCP 返回 `401 Unauthorized` 也是合法的 server policy 结果。

### 浏览器授权模式

同时配置两个 credential reference 后，插件启用 OAuth 2.0 Authorization Code + PKCE，并使用 OIDC identity。这个可选包的浏览器半边会在 DSH 现有 Settings 中增加一个 **DataOps** 页面。页面把连接状态和当前授权 DataOps 账号作为主要信息；服务地址与连接模式收进**高级连接信息**，不要求普通用户先理解 transport 术语。用户从这里点击**连接 DataOps**。

DSH 会以 popup 打开 DataOps，并请求 `openid dataops.mcp` 与 `prompt=select_account`。DataOps 使用自己的 Vue/万相设计系统呈现授权体验，只读取自己的浏览器登录会话，并要求用户显式选择账号。即使只有一个可用账号也不会默认勾选，用户选择前授权按钮保持禁用。点击**使用其他账号**会进入正常 DataOps 登录/MFA 体验；完成登录返回授权 popup 后，可用账号列表会自动刷新。DSH 只接收 authorization code，由后端与 DataOps 做 server-to-server exchange，再通过 DataOps `userinfo` 确认 access token 对应身份，把委托 access token 与 refresh token 分别写入 credential reference，并使用 access-token `bearerTokenRef` 挂载通用 MCP client。OIDC token response 中的 ID token 不会作为 MCP bearer token 使用。

Settings 页面会展示当前授权账号，可以通过同一个 DataOps 账号选择页切换账号，也可以删除由 DSH 可写 credential provider 管理的两项委托凭据，而不会退出 DataOps 网页登录。只有当两个 credential reference 都可写时，Settings 才允许发起新授权或断开。

### 刷新与账号切换

对于已经保存的授权，插件会先用 refresh credential 刷新 access token，再挂载 MCP；授权仍能签发正常 access-token 生命周期期间，也会继续刷新。通用 MCP client 在每次 HTTP 请求边界解析最新 access credential，因此同一 OIDC `sub` 的 token refresh 不需要重建 MCP connection。

DataOps HTTP MCP session 绑定的是 DataOps 用户 principal。若一次新授权解析出的 OIDC `sub` 与当前账号不同，本插件会在替换 principal **之前**先 dispose 现有 DataOps MCP child，再挂载新的 child。若重新授权得到的仍是同一个 `sub`，则沿用原 child。

### Callback 拓扑

credential mutation 与 integration management routes 仍只接受 loopback ingress，因为当前 DSH host web server 没有远程 control-plane 认证层。本机 Web 模式直接使用实际 loopback DSH 浏览器 origin 作为 callback。

如果 DSH Web 通过可信 ingress 对外发布，并且 ingress 到 DSH 的最后一跳是 loopback，则把 `callbackOrigin` 配置为规范 HTTPS origin，同时在 DataOps 的 `AUTH_DSH_REDIRECT_ORIGINS` 中注册同一个 origin。DSH 不会根据 `Host` 或 forwarded header 猜测一个外部可信 callback。这个插件不会开放未认证的 LAN control access。

## 安全

DataOps 浏览器 cookie、密码和 MFA 密钥永远不会离开 DataOps origin。委托 access token、refresh token 与 ID token 都不会进入浏览器授权 URL、浏览器 JavaScript、工具参数、模型上下文或插件配置。DataOps 授权 UI 的 URL 只携带短生命周期、已签名的 authorization request；callback 页面只是一个瞬时 popup bridge，用于通知 DSH Settings 页面后自动关闭。

认证状态完全位于 agent loop 之外。这个包不实现 DataOps SQL 或 catalog 工具，只负责组合现有通用 MCP client。

## 模型体验

这个包不增加 system prompt，也不提供模型可见的认证工具。MCP child 建立连接后，模型只会看到 `@deepseek-ai/dsh-mcp-client` 注册的 server-qualified 工具。账号选择、PKCE、OIDC identity、credential reference 和认证状态都不会进入模型上下文，因此这个插件本身不增加 token 或 KV-cache 消耗。

## 兼容性

这个包是可选插件，不加入现有默认 profile。原有直接配置 `@deepseek-ai/dsh-mcp-client` 的方式保持不变。同时省略两个 credential reference 时仍是匿名 Streamable HTTP；人工维护 bearer credential reference 的方式也继续由通用 MCP client 支持。

## 已知限制与后续工作

委托 refresh token 的最长生命周期受授权时所选 DataOps `AuthSession` 限制。该 DataOps session 过期、被撤销或账号被停用后，refresh 会停止，DataOps MCP child 会被卸载，用户需要重新授权 DataOps。集成不会额外发明第二套长期 DataOps 登录 session，也不会增加 speculative retry / queue 层。

authorization code 单次消费与委托 token revoke 由当前 DataOps 授权实现负责；未来若需要多副本持久化，也应由 DataOps owner 演进，而不是塞进这个 DSH 插件。
