# Agent Note：DataOps MCP 委托 OIDC 浏览器授权

Status: implemented

[English](2026-08-24-dataops-mcp-browser-authorization.md) | 中文

## 问题

通用 MCP client 负责解析 bearer credential，但不拥有 DataOps 身份获取。独立 DataOps 集成需要浏览器授权，同时不能把登录、MFA、查询、目录或权限逻辑移入 DSH core。

一个 DSH runtime 还会在同一 `DSH_HOME` 中保留 session history、credential 和 plugin state。只替换 DataOps MCP credential 会在持久状态中混合 principal，因此浏览器账号选择不能变成 runtime 账号切换机制。

## 决策

继续把 `@deepseek-ai/dsh-mcp-dataops` 作为叠加在 `@deepseek-ai/dsh-mcp-client` 上的可选独立双端插件。DataOps 托管容器使用 DataOps-owned Unix broker，不挂载该插件。

Host 端要求 access、refresh 和 target 三个 credential reference。target 缺失时只生成一次；断开委托 token 时继续保留。target 是绑定一个 `DSH_HOME` 的 opaque 随机标识，不是 credential，也不包含 DataOps user identity。

DataOps 在首次明确授权时把未绑定 target 原子绑定到所选 OIDC `sub`。后续每次授权都先解析 target owner，再列出浏览器 session，因此只能由该 owner 批准。Disconnect 和 token 过期都不删除绑定；DSH route 和 Settings action 都不能解绑或替换 owner。

浏览器端在 DSH Settings 中贡献 DataOps 页面。点击**连接 DataOps**后，以 `openid dataops.mcp` 发起 Authorization Code + PKCE。授权、登录、MFA 和账号确认都由 DataOps 拥有。DSH在服务端交换code，通过`userinfo`验证access token，并把委托credential与通用MCP child作为一次操作提交。credential写入或child挂载失败会恢复旧grant；只有access credential reference进入child。

可写的已有grant会在MCP挂载前以及DataOps浏览器session的正常access-token生命周期内刷新。通用MCP client在每次HTTP请求前解析access credential，因此刷新不remount child。更短的最终token或刷新失败会卸载child；有效的管理员只读grant不发生写入，轮换由其credential provider拥有。

credential mutation和integration route要求loopback ingress与same-origin DSH browser request。本机Web只从loopback origin派生callback；对外发布的Web显式声明HTTP或HTTPS `callbackOrigin`并由DataOps登记。可信内网HTTP是明确合同，绝不是HTTPS fallback。

## 考虑过的替代方案

- Disconnect 时释放或轮换 target，让其他账号重新绑定。不采用，因为保留的 `DSH_HOME` 会在 session history、credential 和 plugin state 中混合 principal。
- 在 DataOps 托管容器中挂载 standalone 浏览器授权。不采用，因为托管 gateway 与 broker 已经拥有 identity，不能增加第二条账号 channel。
- 把 DataOps OAuth 移入 DSH core 或通用 MCP client。不采用，因为 provider login、MFA、scope、target binding 与 revocation 属于 integration 行为。

## 结果

- 一个独立 `DSH_HOME` 在整个生命周期中只获取一个 DataOps principal。
- 首次授权可以从有效 DataOps session 中选择账号；后续授权只显示已绑定 owner。
- 重新授权只更新同一owner，断开会撤销并且只清除委托token。
- Plugin disposal会中止DataOps I/O，等待进行中的授权操作，清除pending state与refresh timing，并移除MCP child。
- 托管容器不包含独立授权控件，DSH 进程也不持有委托 DataOps token。
- DataOps cookie、密码、MFA 密钥和委托 token value 不进入 prompt、tool、浏览器 URL、浏览器 JavaScript或 session log。
- 该 package 不增加 DataOps 查询实现，也不增加账号切换、target unbind、retry queue 或兼容路径。

## 验证

独立用户路径覆盖首次target创建、首次明确账号绑定、同owner重新授权、可回滚的挂载前刷新、保留target的远程撤销、其他owner拒绝、显式trusted-HTTP callback校验、same-origin管理、最终token到期、Settings恢复和child disposal。托管路径证明只组合 Unix-broker MCP adapter，并且不存在独立 Settings contribution。DataOps 浏览器覆盖通过可见 UI 完成登录/MFA 和原生授权页面。

## 与取数设计的关系

本记录实现 [MCP Data Query Integration and A/B Query Designs](../../proposed/architecture/2026-08-23-mcp-data-query-architecture.md) 中独立 DSH 授权部分。DataOps 拥有 target binding、授权 UI、OIDC token、MCP audience/scope 校验和 principal enforcement。
