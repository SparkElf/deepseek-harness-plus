# `@deepseek-ai/dsh-mcp-dataops`

[English](README.md) | 中文

基于通用 MCP client 的可选独立 DataOps 集成。这个包只负责一个持久 target identity、DataOps 浏览器授权、委托 token 刷新和组合；MCP transport 与工具桥接仍由 [`@deepseek-ai/dsh-mcp-client`](../mcp-client/README.md) 负责，credential value 仍只通过 `ctx.credentials` 持有。

## 配置

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

`baseUrl` 是 DataOps origin；`serverName` 成为通用 MCP 工具命名空间（`mcp__dataops__...`）。三个 credential reference 都是必填项。浏览器授权和断开要求 access、refresh reference 可写；如果 target reference 尚未配置，其 provider 必须可写，以便插件生成一次 target。`callbackOrigin` 只对loopback DSH可选，本机会从Settings请求得到浏览器origin。所有非loopback Web部署都必须显式声明HTTP或HTTPS origin；HTTP是可信内网合同，不是HTTPS fallback。

这个包只用于独立 DSH。DataOps 托管容器使用 DataOps-owned Unix broker，不挂载这个包，因此托管 Settings 不显示 DataOps Connect、Reauthorize 或 Disconnect 控件。

## 浏览器授权

插件在 DSH Settings 中增加 **DataOps** 页面。点击**连接 DataOps**后，以 `openid dataops.mcp` 发起 OAuth 2.0 Authorization Code + PKCE。授权页面、登录、MFA 和账号确认都由 DataOps 拥有。DSH只接收authorization code，在服务端换取token，通过DataOps `userinfo`校验access token，并把access/refresh credential与通用MCP child作为一次提交；任一写入或child挂载失败都会恢复旧grant。

插件只生成一次随机 target reference，并在当前 `DSH_HOME` 的整个生命周期中保留。首次成功批准会把未绑定 target 永久绑定到所选 OIDC `sub`；后续授权只显示该 owner。**重新授权**只更新同一 owner 的 grant，不能选择或安装其他 principal。

**断开连接**会卸载DataOps MCP child，在DataOps撤销refresh和access token，再删除两项本地credential。它不会清除target reference或释放DataOps owner绑定；再次连接仍回到同一个账号。

## 刷新生命周期

可写的已有grant会在MCP child挂载前刷新。只要所选DataOps `AuthSession`仍能签发正常access-token生命周期，插件就会更新access credential而不remount，因为通用MCP client会在每次HTTP请求前解析当前credential。有效的管理员只读access credential不发生写入，轮换由其provider拥有。

当DataOps返回更短的access lifetime时，插件在最后一个token到期时卸载MCP child，不再对固定session剩余时间反复刷新。刷新失败也会卸载child，并在Settings中保留可恢复的重新授权状态。

## Callback 拓扑

credential mutation和integration management route同时要求loopback ingress与same-origin DSH browser request，因为host web server没有已认证的远程credential-mutation control plane。本机Web只从实际loopback browser origin派生callback。

如果DSH Web通过可信ingress对外发布，并且ingress到DSH的最后一跳是loopback，则把`callbackOrigin`配置为显式HTTP或HTTPS origin，并在DataOps `AUTH_DSH_REDIRECT_ORIGINS`中登记同一个origin。DSH不根据`Host`或forwarded header推导可信公网callback，HTTPS也不会回落到HTTP。

## 安全

DataOps 浏览器 cookie、密码和 MFA 密钥不会离开 DataOps origin。委托 token 不进入浏览器授权 URL、浏览器 JavaScript、工具参数、模型上下文、session log 或 plugin config。target reference 是 opaque identity，不是 credential；它不包含 user ID，也不能授权 MCP 请求。

认证状态完全位于 agent loop 之外。这个包不包含 DataOps SQL、目录、权限、connector 或结果逻辑。

## 兼容性

这个包是可选插件，不进入发行版默认 profile。现有直接 `@deepseek-ai/dsh-mcp-client` 配置保持不变；通用匿名配置和人工管理 bearer credential 的方式仍由该 package 自己拥有。

## 模型体验

### 已授权的 DataOps MCP 工具

#### 模型看到的内容

授权挂载 MCP child 后，模型只看到 `@deepseek-ai/dsh-mcp-client` 发现并注册的 server-qualified 工具。授权状态、target identity、PKCE、OIDC identity 和 credential reference 对模型不可见。

#### Token 影响

这个包不增加 prompt 或认证工具 token。已发现 DataOps 工具的名称、描述和 schema 承担 `@deepseek-ai/dsh-mcp-client` 记录的 data-dependent token 成本。

#### KV Cache 影响

同一 owner 的 refresh 与重新授权不改变已挂载 child，并保留 request prefix。首次授权或 Disconnect 会增加或移除 DataOps 工具定义，可能从第一个变化的 definition token 起使复用失效。

## 已知限制与后续工作

- 委托 grant 不能超过所选 DataOps `AuthSession` 的生命周期。该 session 过期、被撤销或账号停用后，refresh 会停止，用户必须为同一 DataOps owner 重新授权。集成不增加第二套登录 session、retry queue、账号切换路径或 target unbind 操作。
