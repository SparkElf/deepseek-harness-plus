# Agent Note：DataOps MCP 浏览器授权集成

Status: implemented

[English](2026-08-24-dataops-mcp-browser-authorization.md) | 中文

## 问题

通用 MCP client 已经可以通过凭据引用解析 Bearer 凭据，但它不负责获取 DataOps 凭据。DataOps 集成需要一个可选的、面向用户的授权入口，同时不能把 DataOps 登录、SQL、目录或权限逻辑塞进通用 MCP package。

同一个 DataOps 浏览器里可以同时存在多个有效账号会话。因此授权时必须明确选择账号，不能静默继承某个浏览器标签页的账号。同时，如果 DSH 没有配置 DataOps 授权，仍应保持通用 Streamable HTTP 行为，以不带 `Authorization` 头的方式尝试连接 MCP。

## 决策

新增可选的双端插件 `@deepseek-ai/dsh-mcp-dataops`。

Host 端只组合 `@deepseek-ai/dsh-mcp-client`，自身不注册任何 DataOps 取数工具。没有 `credentialRef` 时，立即以无 Bearer 凭据的方式挂载通用 MCP client；配置 `credentialRef` 时，依赖现有 credentials service，等待已保存的 access credential，然后以 `bearerTokenRef` 挂载同一个通用 MCP client。

浏览器端在 DSH Settings 中贡献一个 DataOps 页面。点击 **连接 DataOps** 后发起 DataOps Authorization Code + PKCE 流程。授权页面和账号选择由 DataOps 拥有：DataOps 展示该浏览器当前所有有效账号，用户必须明确选中一个账号后才能授权。DSH 只接收 authorization code，在服务端完成换 token，并通过 `ctx.credentials` 保存得到的 MCP access token；DSH 不会拿到所选账号的密码或 DataOps refresh cookie。

callback URI 使用实际发起流程的 DSH 浏览器 origin，并且只有当该 origin 的 host 与当前 DSH 请求 Host 一致时才接受。凭据修改和浏览器授权仍限制在 loopback，与当前 DSH settings/credentials 控制面的安全边界一致。未来如果 DSH 增加经过认证的远程 Host 控制面，DataOps 可以另行允许显式登记的 HTTPS callback URI。

该集成不会加入默认发行 profile，因此现有直接配置 `mcp-client` 的部署不受影响。

## 结果

- 不配置集成凭据时，MCP transport 保持匿名；是否允许匿名访问仍由远端 MCP server 决定。
- 配置集成后，DataOps 专属 OAuth、账号选择和凭据获取仍位于 `dsh-mcp-client` 之外。
- DataOps 账号/session cookie 不会进入 DSH；模型只能看到通用 MCP client 发布的 MCP 工具。
- 当前授权响应只包含 access token，其有效期受所选 DataOps session 生命周期约束。delegated refresh 等 DataOps 有明确且已接受的 refresh contract 后再实现。
- 该 package 同时包含 Host 与浏览器两端，因此遵循仓库已有 dual-half package 构建和 client-module 约定。

## 验证

聚焦 Host 测试覆盖匿名 MCP 组合、Authorization Code + PKCE 换取 token、凭据保存、已授权账号状态以及断开授权。一条 Loader + Include 真实组合测试通过测试用 `cordis.yml` 启动该可选插件，并验证匿名模式不会发送 `Authorization` 头。Client 注册测试覆盖 Settings 页面贡献及其随 fiber dispose 移除。

## 与取数设计的关系

本记录实现 [MCP Data Query Integration and A/B Query Designs](../../proposed/architecture/2026-08-23-mcp-data-query-architecture.zh.md) 中 DSH integration plugin 的部分。与之配套的授权端点、明确的多账号选择、MCP token audience/scope 以及 MCP 侧授权均由 DataOps 负责。
