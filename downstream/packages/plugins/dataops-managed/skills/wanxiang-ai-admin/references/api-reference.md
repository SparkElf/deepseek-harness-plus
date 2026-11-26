# 接口契约查询（`dataops_api_docs`）

## 业务简介

`dataops_api_docs` 是管理端 HTTP 接口的**只读检索器**。它读取部署内固定的 `/api/openapi.json`，返回命中的 operation 的精简投影：`method`、`path`、`operationId`、`summary`、`tags`、参数、请求体字段和 security。它不执行请求、不接受任意 URL、不返回完整文档。

完整文档有两百多个 operation、三十多个 tag。本技能**不复制**这份文档：先读分组 reference 和工具 schema，只有需要字段级契约时才来查这里。

## 谁可以查

| 层 | 规则 |
| --- | --- |
| 插件披露 | 只向管理员与超级管理员披露（`adminOnly`）；部门管理员和普通用户看不到这个工具 |
| 后端读取 | `/api/openapi.json` 要求 `developer:openapi:read`；管理员/超管默认持有，部门管理员没有 |
| 错误 | 401 会话过期、403 当前角色不可读、404 文档未配置（`DATAOPS_OPENAPI_UNAVAILABLE`）、503 工作区还没有 DataOps 会话 |

**披露不等于授权。** 工具可见时，后端仍可能在调用时返回 403；按原文汇报，不要换账号或改用别的通道抓文档。

## 查询参数

| 参数 | 匹配方式 | 示例 |
| --- | --- | --- |
| `tag` | 与 OpenAPI tag **精确**匹配（大小写不敏感） | `Users` |
| `path` | 路径子串（大小写不敏感） | `/api/system/users` |
| `operation_id` | operationId 子串 | `UsersController_create` |
| `method` | HTTP 方法精确匹配 | `POST` |
| `query` | 空格分隔的关键词，**全部命中**才返回；匹配 path、operationId、summary、description、tags | `permission center matrix` |

返回上限 50 条；`total` 是命中总数，`returned` 是本次返回数，`truncated=true` 说明被截断。参数最多投影 25 个、请求体属性最多 25 个；`$ref` 只解析有限层。

查不到时先换维度：`tag` 改成真实 tag、`path` 改成路径前缀、`operation_id` 去掉 Controller 前缀。空结果不等于接口不存在。

## 分组标签建议

第一列是**文档导航用的分组视图**（对应门户区域），**不是 OpenAPI tag 值**；`tag` 参数要用第三列的真实 tag。

| 分组视图 | 覆盖什么 | 真实 tag（`tag` 参数） | 路径前缀 | 本工具可查 |
| --- | --- | --- | --- | --- |
| `system/users` | 用户、用户组、岗位、部门 | `Users`、`Groups`、`Positions`、`Departments` | `/api/system/users`、`/api/system/groups`、`/api/system/positions`、`/api/system/departments` | 是 |
| `system/roles` | 角色、权限、权限中心、菜单、应用登记 | `Roles`、`Permissions`、`PermissionCenter`、`Menus`、`Applications` | `/api/system/roles`、`/api/system/permissions`、`/api/system/permission-center`、`/api/system/menus`、`/api/system/applications` | 是 |
| `resources` | 数据资源与访问授权、任务审批 | 管理端文档不含；平台数据面文档的 tag 是 `Resources`、`Tasks` | `/api/resources`、`/api/tasks` | 否（用 `dataops_resource_*` 工具） |
| `skills` | 技能中心、个人安装、部门默认技能 | 管理端文档不含（AI 模块） | `/api/ai/skill-plaza` | 否（用 `skill_*` / `department_skill_*` 工具） |
| `workspaces` | AI 工作区、重启、隧道 | `AiWorkspacesAdmin` | `/api/ai/workspaces` | 是 |
| `automation` | 工作流定义、部署、运行 | 管理端文档不含；由 MCP 工作流工具与门户承载 | — | 否（超管用 `mcp__dataops__workflow_*`） |
| `operations` | 监控、审计、在线会话、存储、密钥、系统参数、应用日志 | `AdminObservability`、`InfrastructureMonitor`、`Audit`、`SessionAdmin`、`StorageProviders`、`SecretSetting`、`SystemSetting`、`HealthSupervisor`、`system` | `/api/system/observability`、`/api/system/audits`、`/api/system/sessions`、`/api/system/storage/providers`、`/api/system/secrets`、`/api/system/settings`、`/api/system/application-logs` | 是 |

说明：

- `/api/openapi.json` 由管理端核心模块生成，**不包含**平台数据面（资源、任务）和 AI 模块（技能中心）的路由；这些动作的契约以已注册工具的 JSON Schema 为准。上表把它们标成“否”，避免用 `query` 反复空查。
- `resources`/`skills`/`automation` 的权限与确认要求仍看 `resources-grants.md`、`skills-workspaces.md`；不要因为文档查不到就认为没有权限约束。
- tag 会随版本变化；以本次检索结果为准。

## 常用检索配方

| 想知道 | 调用 |
| --- | --- |
| 建用户的请求体字段 | `path=/api/system/users` + `method=POST`，或 `operation_id=UsersController_create` |
| 改用户/角色字段（含 `updatedAt`） | `operation_id=UsersController_update` |
| 角色列表与角色 CRUD | `tag=Roles` 或 `path=/api/system/roles` |
| 权限中心矩阵/成员/资源范围 | `tag=PermissionCenter` 或 `query=permission-center matrix` |
| 部门树字段 | `tag=Departments` |
| 工作区列表/重启/隧道字段 | `tag=AiWorkspacesAdmin` |
| 审计查询与导出 | `tag=Audit` |
| 在线会话强退 | `tag=SessionAdmin` |
| OpenAPI 自身 | `operation_id=getAdminOpenApiDocument` |

只引用与当前问题相关的那几条 operation，不要把整页结果贴给用户。

## 与工具调用的关系

- `dataops_api_docs` 只回答“接口长什么样”，**不能**执行管理动作；
- 真正执行管理动作仍用 `dataops_user_lookup`、`dataops_user_create`、`dataops_role_assign`、`dataops_resource_*`、`skill_*`、`department_skill_*`、`admin_workspace_*`；
- 文档里存在的接口，如果没有对应工具，本技能就不提供执行通道；不要用 `api_prepare_request`、`browser`、SQL 或 curl 绕过；
- 工具返回 403，文档查得再清楚也不能改变授权结果。

## 常见错误

| 现象 | 原因与处理 |
| --- | --- |
| 返回 `total=0` | tag 拼错、路径片段不对、或该域不在管理端文档；换 `tag`/`path`，并对照上面的分组表 |
| `Unauthorized (401)` | DataOps 会话过期；请用户重新登录 |
| `Forbidden (403)` | 当前角色不可读 OpenAPI；不要换账号，按原文报告 |
| `DataOps API docs are unavailable: /api/openapi.json is not configured (DATAOPS_OPENAPI_UNAVAILABLE)` | 部署没启用文档；改用工具 schema 和本技能 reference，不要伪造契约 |
| `DataOps API docs are unavailable: this workspace has no DataOps session` | 工作区还没有 JWT；先完成登录/接入 |
| 结果被 `truncated` | 命中超过 50 条；加 `tag`/`path`/`method` 收窄 |
| 请求体只显示部分字段 | 投影上限（25 个属性）与 `$ref` 解析深度限制；用 `operation_id` 定位后按需查相邻 schema，不要假设“没显示=不存在” |
| 把 OpenAPI 整页贴进回答 | 违反本技能规则；只引用相关 operation 的少量字段 |
