# Agent Note: 泛用智能取数工具与中台协议

Status: proposed

[English](2026-08-19-generic-data-query-protocol.md) | 中文

## Problem

dataops 项目的智能取数 AI 通过若干强依赖 dataops 内部的工具服务真实工作：`search_resources`（资源 wiki/目录发现）、`query_table`（对 dataops 已接入引擎的只读 SQL，带平台可见性过滤）、`query_api`（对 dataops 已注册数据 API 的参数化调用），以及 `kb_search`/`kb_explore`/`kb_read` 语义检索三件套。任何其他中台（数据中台、BI 语义层、湖仓目录）想要同样的智能取数，都得 fork 这些工具。Harness 用户无法把 agent 指向任意中台，dataops 成为该能力的单一供应商锁定。

## Proposal

把能力拆成三层：Harness 侧泛用工具集、任意中台可实现的线上协议、以及一个在现有服务之上实现协议的 dataops 薄适配层。

1. **协议（`dq/v1`）。** JSON over HTTP，bearer-token 鉴权，权限在服务端强制；所有端点返回 `{columns, rows, truncated}` 行集或带稳定错误码的类型化错误。
   - `GET /dq/v1/capabilities`——支持的能力面（`sql`、`api`、`kb`、`glossary`）、SQL 方言、行数上限。
   - `POST /dq/v1/resources/search` `{query, kinds, limit}`——目录发现，返回 id/kind/name/description/列或契约/owner/tags。
   - `POST /dq/v1/query/sql` `{resourceId, sql, maxRows}`——只读执行；中台拒绝写 SQL 并强制可见性（dataops 的 `aiVisible`/`accessLevel` 过滤成为其服务端职责）。
   - `POST /dq/v1/query/api` `{apiId, params, maxRows}`——参数化数据 API 调用。
   - `POST /dq/v1/kb/search`、`POST /dq/v1/kb/read`——可选语义检索。
   - `GET /dq/v1/glossary`——可选业务术语解析。
2. **Harness 插件（dsh-plugins-plus 的 `@sparkelf/dsh-plugin-dataquery`）。** Cordis 插件暴露泛用工具 `dq_search_resources`、`dq_query_sql`、`dq_query_api`（能力面声明时加可选 `dq_kb_*`），零 dataops 导入；端点 base URL 与凭据引用来自插件配置（`baseUrl` + credential-reference），一套工具服务所有合规中台。结果按工具 UI 契约以行表呈现。
3. **dataops 适配层。** dataops 内的控制器层（或独立 sidecar），在 `ResourceWikiCoreService`、SQL 执行路径、API-SDK 注册表与知识库之上实现 `dq/v1`——迁移期不改动现有 AI 工具；dataops AI 日后可消费同一协议，删除其硬连线 facade。

## Alternatives considered

**用 MCP server 代替 HTTP 协议。** 暂拒：MCP 给中台侧增加传输/运行时依赖；行集协议是 MCP 日后可无损包装的子集。

**保留 dataops 专用工具、按平台 fork。** 拒：N 个平台 fork N 次；协议把成本降到每平台一个适配层。

**泛用工具放进 deepseek-harness-plus packages。** 拒：按维护方案它们是独立插件；dsh-plugins-plus 保持其在上游 dsh 上可安装。

## Consequences

- 中台实现一个小的 JSON 契约即获得 agent 驱动的智能取数。
- dataops 内部不再泄漏进 agent 工具；可见性与权限留在服务端。
- Harness 获得能力缝形态的插件（工具+配置），符合仓库约定。

## Acceptance criteria

- 协议文档固定端点路径、请求/响应 schema、错误码与鉴权；附中台可自测的合规清单。
- 插件工具不含任何 dataops 专有标识；配置仅 `baseUrl` 加凭据引用。
- dataops 适配层把现有每个工具面（search/sql/api/kb）映射到一个协议端点，不改变当前 AI 行为。

## Risks

- 行集形态可能覆盖不了图表/流式载荷；`capabilities` 加 `media` 扩展点是逃生门，推迟到真实需求出现。
- 各平台权限模型不同；协议强制服务端执行、只携带身份，拒绝标准化授权。

## Verification

- 设计注：不随注发布代码。实现以 dsh-plugins-plus 插件加 dataops 适配层 PR 落地，各带针对桩中台的免密钥单测，以及对 dataops 适配层的一次真实合规运行。
