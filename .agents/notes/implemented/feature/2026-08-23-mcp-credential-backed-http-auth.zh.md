# Agent Note：MCP credential-backed Streamable HTTP 认证

Status: implemented

[English](2026-08-23-mcp-credential-backed-http-auth.md) | 中文

## 问题

MCP client 原先只接受字面量 HTTP headers。需要刷新用户 access token 的集成因此只能改写 Cordis 配置，或把 secret 直接放进 `headers.Authorization`；但 DSH 已经有 credential-reference 服务，可以在不把 secret 暴露给配置或模型上下文的情况下更新值。

DataOps MCP 集成需要 bearer 认证，同时 OAuth 获取和刷新仍应位于通用 MCP package 之外。

## 决策

`@deepseek-ai/dsh-mcp-client` 在 `streamable-http` 配置分支增加可选 `bearerTokenRef`。该值是 DSH `CredentialRef`，不是 token。

配置 `bearerTokenRef` 后，MCP client 要求存在 `ctx.credentials`，并向 MCP SDK 提供 bearer `authProvider`。其 `token()` 方法会在每次 HTTP 请求前通过 `ctx.credentials` 解析引用，由 MCP SDK 负责构造 `Authorization: Bearer <value>` 请求头。

这一实现直接复用现有 credential service 的 per-operation resolution 规则。Provider 管理的 token 刷新会在下一次 MCP 请求生效，不需要重启插件，也不需要新增 MCP connection lifecycle 状态。

静态 HTTP headers 继续受支持。`headers.Authorization` 与 `bearerTokenRef` 不能同时配置，因为这会让同一个请求头出现两个 owner。

通用 package 不实现 Authorization Code、PKCE、MFA、refresh-token exchange、revocation、浏览器跳转或 Provider 专用 scope policy。外部 integration plugin 负责这些操作，并通过 credential service 写入最终 access credential。

## 结果

- 使用 credential-reference 路径时，secret 不进入 `cordis.yml`、工具参数或模型可见的 MCP schema。
- Credential 轮换复用 `CredentialProvider.resolve()` 的既有语义，而不是再增加 MCP 专用 refresh cache 或 reconnect 状态机。
- MCP package 增加 `@deepseek-ai/dsh-credentials` peer dependency；只有配置 `bearerTokenRef` 时才要求该 service 存在。
- 现有 stdio 配置和使用字面量 headers 的 Streamable HTTP server 行为保持不变。

## 验证

聚焦测试覆盖配置解析、缺失 credential service、`Authorization` owner 冲突，以及重复调用 `authProvider.token()` 时读取当前 credential 值。Package typecheck、build、lint、documentation synchronization 和现有 MCP client tests 仍由仓库现有检查负责。

## 与取数设计的关系

本 Note 只实现 [MCP Data Query Integration and A/B Query Designs](../../proposed/architecture/2026-08-23-mcp-data-query-architecture.md) 中 DSH 负责的通用认证部分。DataOps 认证流程和 query tools 仍位于本 package 之外。
