# Agent Note：DataOps MCP 委托 OIDC 浏览器授权

Status: implemented

[English](2026-08-24-dataops-mcp-browser-authorization.md) | 中文

## 问题

通用 MCP client 可以通过凭据引用解析 Bearer 凭据，但不应该自己获取 DataOps 身份。DataOps 集成需要一个可选的用户授权入口，同时不能把 DataOps 登录、MFA、SQL、目录或权限逻辑塞进通用 MCP package。

同一个 DataOps 浏览器里可以同时存在多个有效账号会话，因此授权必须明确选择账号，不能静默继承某个浏览器 cookie。如果 DSH 没有配置 DataOps 授权，也必须保持通用 Streamable HTTP 行为，以不带 `Authorization` 头的方式尝试连接 MCP。

DSH 产品主体是 Web host，并不是传统 desktop-only loopback 应用；但当前 host web server 同样没有经过认证的远程 credential-mutation control plane。因此对外发布的 callback 拓扑不能通过放宽现有 loopback management boundary 来猜测。

## 决策

继续把 `@deepseek-ai/dsh-mcp-dataops` 作为叠加在 `@deepseek-ai/dsh-mcp-client` 上的可选双端插件。

Host 端自身不注册 DataOps 取数工具。同时省略两个 credential reference 时，立即以无 Bearer 凭据的方式挂载通用 MCP client。授权模式要求 access-token `credentialRef` 与 `refreshCredentialRef` 成对配置，两者都继续由现有 credentials service 持有；通用 MCP child 只接收 access-token reference 作为 `bearerTokenRef`。

浏览器端在 DSH Settings 中贡献 DataOps 页面。点击**连接 DataOps**后，以 `openid dataops.mcp` 和 `prompt=select_account` 发起 OAuth 2.0 Authorization Code + PKCE。授权页面、现有登录/MFA/session 处理以及显式账号选择都由 DataOps 自己负责。DSH 只接收 authorization code，在服务端换取 token，通过 DataOps `userinfo` 确认 access-token identity，再保存委托 access token 与 refresh token；DSH 不读取 DataOps 浏览器 cookie 或密码。ID token 不作为 MCP bearer token 使用。

Settings 交互沿用 DSH 现有 feature page 设计，而不是把 OAuth 技术细节做成独立控制面：连接状态和当前授权的 DataOps 账号是主信息，服务地址与连接模式收进高级信息。配套 DataOps 授权面是使用 DataOps/万相 design token 的 standalone Vue 页面；任何账号都不会默认选中，用户明确选择前授权按钮保持禁用。点击**使用其他账号**会进入正常 DataOps 登录/MFA 体验，完成登录返回 popup 后账号列表自动刷新。

已有授权在挂载 MCP child 前先做 refresh。只要 OIDC `sub` 不变，授权有效期内更新 access credential 不需要 remount，因为通用 MCP client 会在每个 HTTP 请求边界解析当前 credential。DataOps HTTP MCP session 的真实绑定字段是 `userId`，而不是浏览器 `AuthSession.id`，因此 remount 的判定依据必须是 `sub`。如果新授权解析出不同 `sub`，集成先 dispose 当前 DataOps MCP child，再写入新 principal 的凭据，最后挂载新的 child。

DataOps 把委托 token 生命周期限制在用户授权时选择的 DataOps `AuthSession` 内。当 refresh response 开始返回比正常 access lifetime 更短的 `expires_in` 时，说明授权已经进入固定 session 剩余生命周期；插件停止继续调度 refresh，让最后一个 access token 与 grant 一起到期，避免对固定剩余时间反复折半刷新。

credential mutation、status、connect、callback handling 与 disconnect 仍只接受 loopback ingress。本机 Web 模式从发起授权的 DSH 浏览器请求得到 callback origin，并要求它与 DSH Host 匹配。对外发布的 Web 部署可以改为显式配置规范 HTTPS `callbackOrigin`，DataOps 必须登记同一个 origin；外部 ingress 到当前无远程认证的 DSH control plane 的最后一跳仍必须是 loopback。DSH 不会根据 `Host` 或 forwarded header 猜测公网 callback origin。

该集成继续不加入默认发行 profile，因此直接配置 `mcp-client` 的现有部署和其他 MCP server 都不受影响。

## 结果

- 同时省略两个集成 credential reference 时，MCP transport 保持匿名；是否允许匿名访问仍由远端 MCP server 决定。
- DataOps 专属 OAuth/OIDC、账号选择、refresh 与 principal switching 都位于 `dsh-mcp-client` 和 agent loop 之外。
- DataOps 浏览器 cookie、密码和 MFA 密钥不会进入 DSH；委托 token 只存在于 credential storage 与服务端 exchange 路径，不进入 prompt、tool、浏览器 URL 或浏览器 JavaScript。
- 用户界面只要求用户理解“连接 DataOps”和“选择账号”，不要求用户理解 OIDC、PKCE、token 类型或 MCP session identity。
- 同一 `sub` 的 access-token refresh 或重新授权沿用现有 DataOps MCP child；不同 `sub` 的授权会 dispose 并重建 child，让 DataOps 为新用户绑定新的 MCP session。
- 委托 refresh 最长不超过所选 DataOps `AuthSession`；DSH 不额外发明第二套长期 DataOps 登录，也不增加 speculative retry / queue 层。
- 该 package 同时包含 Host 与浏览器两端，并遵循仓库现有 dual-half build、Settings slot、lifecycle effect 与 disposal 约定。

## 验证

聚焦 Host 测试覆盖匿名 MCP 组合、OIDC Authorization Code + PKCE、两项委托凭据、`userinfo` identity、启动时 refresh-before-mount、同 principal 复用、不同 principal remount、canonical callback origin 和 disconnect。Loader + Include 真实组合测试通过测试用 `cordis.yml` 启动该可选插件，并验证匿名模式不会发送 `Authorization` 头。Client 注册测试覆盖 Settings 页面贡献及其随 fiber dispose 移除。配套 DataOps system test 会驱动真实原生授权 UI，验证账号默认均未选中、选择前主授权按钮禁用，并通过正常 DataOps 登录体验新增另一个账号，再确认授权 popup 恢复焦点后自动刷新账号列表。

## 与取数设计的关系

本记录实现 [MCP Data Query Integration and A/B Query Designs](../../proposed/architecture/2026-08-23-mcp-data-query-architecture.zh.md) 中 DSH integration plugin 的部分。配套 DataOps 委托授权实现在 `SparkElf/dataops#3`；授权页面、显式多账号选择、OIDC/token 签发、MCP audience/scope 校验以及 DataOps 侧 principal enforcement 都由 DataOps owner 负责。
