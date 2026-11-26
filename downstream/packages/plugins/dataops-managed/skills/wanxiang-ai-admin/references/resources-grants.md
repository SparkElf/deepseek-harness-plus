# 资源授权与审批

## 业务简介

数据资源（表、接口、文件等）对谁可见、能做什么，由“资源授权”决定。授权目标是四类主体之一：用户 `USER`、角色 `ROLE`、部门 `DEPARTMENT`、应用 `APPLICATION`；权限是 `READ` / `WRITE` / `MANAGE`；授权类型是 `REGULAR` 或 `TEMPORARY`。

资源授权和角色是两条线：给用户加“管理员”角色不会自动给他某张表的读权限；反过来，给部门授了某资源的读权限，也不会改变任何人的角色。

另一条线是“资源申请审批”：用户在门户发起资源申请，形成待办任务；管理员在任务里做通过/驳回。审批动作和授权动作是分开的，不要用授权工具去“批准”一张申请单。

## 关键工具与接口

| 工具 | 用途 | 后端接口 | 读/写 |
| --- | --- | --- | --- |
| `dataops_collect_resources` | 按名称/表名/URN 查资源与 `resource_id` | `GET /api/resources?query=…&limit=…` | 读 |
| `dataops_resource_pending_list` | 列待审批资源申请与当前用户任务 | `GET /api/tasks?status=pending&page=1&keyword=…` | 读 |
| `dataops_resource_grant_list` | 列某资源现有授权 | `GET /api/resources/{id}/access-grants` | 读 |
| `dataops_resource_grant_batch` | 批量新增/覆盖授权（保留既有） | 先 `GET` 现有授权，必要时 `GET /api/tasks/asset-access-applications`，再 `PUT /api/resources/{id}/access-grants` | 写 |
| `dataops_resource_grant_revoke` | 按目标批量撤销授权 | 先 `GET` 现有授权，再 `PUT` 剩余授权 | 写 |
| `dataops_resource_approval_decide` | 批量通过/驳回用户任务 | `GET /api/tasks/{id}`（缺 `expected_version` 时）→ `POST /api/tasks/{id}/user-tasks/{userTaskId}/complete` 或 `/reject` | 写 |
| `dataops_open_resource_tab` | 在右侧栏打开资源的分配/详情/审计 Tab | 仅前端导航，无 API 写入 | 导航 |
| `dataops_api_docs` | 查管理端相邻契约（资源/任务不在本文档） | `GET /api/openapi.json`（只读检索） | 读 |

资源授权与任务审批属于平台数据面，不在管理端 `/api/openapi.json` 里；不要在 `dataops_api_docs` 里反复空查。参数以工具 schema 为准，权限和确认要求以本页为准。

### `dataops_resource_grant_batch`

参数：

- `resource_id`：正整数；
- `application_id`：可选；缺省时优先用现有授权里的应用 id，再退回可选应用列表的第一个；
- `grants[]`：每项 `targetType`（USER/ROLE/DEPARTMENT/APPLICATION）、`targetId`、`permission`（默认 READ）、`grantType`（默认 REGULAR）、可选 `applicationId`。

行为：

- 工具先读现有授权，把“现有 + 本次”按 `targetType:targetId:applicationId` 合并，再用一次 `PUT` 替换整份授权列表。**未点名的既有授权会保留**，但同一目标同一应用的权限会被本次值覆盖。
- 授权写入由 DataOps 审计；工具返回合并后的完整 `grants`、`count` 和实际使用的 `applicationId`。
- 找不到可用应用时直接报 `no application is available for access grants`，不要自己编一个 `application_id`。

### `dataops_resource_grant_revoke`

参数：`resource_id`、`targets[]`（`targetType` + `targetId`）。

行为：

- 按 `targetType:targetId` 匹配后从整份授权里移除，再 `PUT` 剩余列表；一个目标都没匹配到时报 `no matching grant to revoke`。
- 匹配不带 `applicationId`：同一目标在多个应用下的授权会一并移除。撤销前必须在 `dataops_resource_grant_list` 里核对完整条目。

### `dataops_resource_approval_decide`

参数：`decisions[]`，每项 `task_id`、`user_task_id`、`decision`（`approve`/`reject`）、`comment`、可选 `expected_version`、可选 `idempotency_key`。

行为：

- 缺 `expected_version` 时，工具先读任务详情，从对应用户任务里取 `taskVersion`；取不到用 0。
- 通过调用 `complete`、驳回调用 `reject`；每次请求带 `idempotency-key`，超时重试时复用同一个 key。
- 单个决策失败不会中断其他决策；`results[]` 逐条给 `ok`/`error`。`409`/`422` 常见于版本已变或状态已流转。

## 所需权限

| 动作 | 插件披露 | 后端授权 |
| --- | --- | --- |
| 待办列表 | 连接器 `resource.manage` 开启 + 管理员/超管 | `workflow:task:read` |
| 查资源 id | `data:resource:read` | 同一能力；只能看到调用者可见的资源 |
| 查资源授权 | 同上 | 资源读权限（`data:resource:read`） |
| 批量授权/撤销 | 同上 | `data:resource:manage` |
| 审批通过/驳回 | 同上 | `workflow:task:execute`；只能处理调用者有权办理的任务 |
| 打开资源 Tab | 不要求连接器能力 | 无写入；页面内操作仍按门户权限 |

管理员与超级管理员是平台级旁路角色；部门管理员默认只有资源读与任务办理的部门范围，没有 `data:resource:manage`，会 403。插件侧还要求连接器里的「资源管理」开关已启用并获授权。

## 审批与确认

### 授权 / 撤销（没有 dry_run、没有 confirm 参数）

1. 只有资源名时，先用 `dataops_collect_resources` 查到 `resource_id`；`dataops_resource_grant_list` 读当前授权，确认 id 与现有条目。
2. 用表格列出“新增/变更/移除”的每个目标、权限、授权类型、应用 id；说明这次是整份授权列表替换，但未点名条目保留。
3. 用户明确确认后调用 `dataops_resource_grant_batch` 或 `dataops_resource_grant_revoke`。
4. 再 `dataops_resource_grant_list` 回读，按回读结果汇报；数量、目标、权限任一不符都要说明。

**不要**在没有当前授权列表的情况下直接授权；**不要**为了“省一步”把 `resource_id` 从名称猜出来。

### 审批（没有 confirm 参数）

1. `dataops_resource_pending_list` 找到任务，展示任务标题、申请人、资源、当前用户任务与任务版本。
2. 对每条决策说明 `task_id`、`user_task_id`、通过还是驳回、意见。
3. 用户明确确认后调用 `dataops_resource_approval_decide`，`comment` 用用户确认过的意见；重试时复用原 `idempotency_key`。
4. 再查一次待办列表，确认该任务已不在 pending；逐条汇报成功/失败。

## 常见错误

| 现象 | 原因与处理 |
| --- | --- |
| `resource_id must be a positive integer` | id 缺失或不是正整数；先查资源列表/门户，不要猜 |
| `grants must be a non-empty array` | 没有给任何授权目标；先和用户确认目标 |
| `each grant needs targetType and targetId` | 目标类型或 id 为空；类型只能是 USER/ROLE/DEPARTMENT/APPLICATION |
| `permission must be READ, WRITE or MANAGE` | 权限拼写错误；按这三个值之一 |
| `no application is available for access grants` | 没有可选应用，或现有授权里没有应用 id；让用户在门户确认应用，不要编造 |
| `no matching grant to revoke` | 目标在现有授权里不存在；先 list 核对 `targetType`/`targetId` 的准确写法 |
| 撤销后“多掉了一条” | 撤销按目标匹配、跨应用移除；撤销前核对完整授权列表 |
| `Conflict (409)` / `HTTP 409` | 任务版本或审批状态已变；重新读任务与版本，再让用户确认一次 |
| `Forbidden (403)` | 缺 `data:resource:manage` / `workflow:task:execute`，或任务不在办理范围；保留原文 |
| `Unauthorized (401)` | 会话过期；请用户重新登录 |
| 工具不在列表 | 连接器「资源管理」未启用或当前角色不是管理员/超管；报告缺能力，不要绕开 |
