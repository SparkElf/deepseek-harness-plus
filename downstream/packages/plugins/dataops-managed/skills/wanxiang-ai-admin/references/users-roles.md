# 用户与角色

## 业务简介

万相 AI 中台的账号由 DataOps 统一管理：一个账号有唯一 `user_id`（UUID）、登录名、显示名、邮箱、手机、部门归属和一组角色。角色决定权限，资源授权单独计算，两者互不替代。

本组只覆盖三件事：查人、建号、加/减角色。删除账号、重置密码、改 MFA 不在工具集内，必须去用户控制台。

角色要点：

- 平台角色：`超级管理员`、`管理员`、`部门管理员`、`运营人员`、`应用人员`。
- 数据密级角色：`初级权限`、`中级权限`、`高级权限`，只影响可读数据密级上限。
- 准入角色：`AI 工作区成员`，让账号能打开 AI 工作区。
- `超级管理员` 永远不能通过本技能授予或撤销，只能走管理员控制台。

## 关键工具与接口

| 工具 | 用途 | 后端接口 | 读/写 |
| --- | --- | --- | --- |
| `dataops_user_lookup` | 按登录名/姓名/邮箱/手机/企微 userid 查人 | `GET /api/system/users?search=…&wecomUserId=…&departmentCode=…&page=1&pageSize=100` | 读 |
| `dataops_user_create` | 建一个普通账号 | `POST /api/system/users` | 写 |
| `dataops_role_assign` | 给一个或多个用户加/减角色 | 先 `GET /api/system/users/{id}`，再 `PATCH /api/system/users/{id}` `{updatedAt, roleCodes}` | 写 |
| `dataops_api_docs` | 查用户/角色 DTO 与其它管理接口契约 | `GET /api/openapi.json`（只读检索） | 读 |

字段级细节（建号 DTO、更新 DTO、角色结构）用 `dataops_api_docs` 按 `tag=Users` / `tag=Roles` 或 `path=/api/system/users`、`operation_id=UsersController_create|update` 查；本页不复制字段表。

### `dataops_user_lookup`

参数：`username`、`display_name`、`email`、`mobile`、`wecom_user_id` 至少给一个；可选 `department_code`、`enabled_only`、`limit`（默认 20，最大 50）。

行为与限制：

- 服务端先按 `search`（登录名/显示名/邮箱/手机之一）或 `wecomUserId` 拉一页（`pageSize=100`），工具再在本地按精确/包含规则过滤；`scanned` 是这一页的行数。
- 返回字段：`id`、`username`、`displayName`、`email`、`mobile`、`enabled`、`departments`、`roles`，永远不含密码或凭据。
- 结果可能被 `limit` 截断；`count` 是返回条数，不一定是全库匹配数。匹配很多时缩小条件，不要靠翻页猜。
- 部门管理员只能看到本人部门及子部门的用户；这是后端数据范围，不是工具过滤。

### `dataops_user_create`

参数：`username`、`display_name`、`email` 必填；`mobile`、`department_code`、`dry_run`、`confirm` 可选。

固定行为（不要自行改写）：

- 角色固定为 `应用人员` / `初级权限` / `AI 工作区成员`；
- 部门未指定时落在 `unassigned`（待分配部门）；
- 直接资源授权为 0；
- 初始密码由工具随机生成，**在工具结果中返回一次、不写入审计/日志**；交付后请要求用户首次登录修改。工具结果可能进入 DSH 会话历史，按敏感信息处理；
- `dry_run=true` 只返回 `wouldCreate` 预览，不写；
- 真正创建要求 `confirm=true`，并会弹出一次用户审批。

### `dataops_role_assign`

参数：`user_ids`（UUID 数组，单次最多 50）、`role_codes`（非空数组）、`action`（`add` 默认 / `remove`）、`dry_run`、`confirm`。

行为与限制：

- `add` 是并集、`remove` 是差集；工具读出每个用户当前角色，计算完整的新 `roleCodes` 再 PATCH。后端 PATCH 的 `roleCodes` 是**整体替换**，不是追加——所以不要让用户直接给你“只写一个角色”。
- 读取用户时同时拿 `updatedAt` 作为乐观锁；PATCH 带这个 token，过期会 409。
- 目标用户是 `超级管理员` 时跳过并报错；变更后角色为空也跳过并报错。
- 单个用户失败不影响其他用户；结果里 `results[]` 逐人给 `ok`/`changed`/`beforeRoles`/`afterRoles`/`error`。
- `changed=0` 时不弹审批、不写；直接按“无变化”汇报。

## 所需权限

| 动作 | 插件披露 | 后端授权 |
| --- | --- | --- |
| 查人 | `system:user:read` | 同一 key；部门管理员限本部门及子部门 |
| 建号 | 连接器 `admin.manage` 开启 + 管理员/超管 | `POST /api/system/users` 要求 `system:user:create` + `system:role:update`；管理员/超管是平台旁路角色，部门管理员没有这两项，403 |
| 加/减角色 | 连接器 `admin.manage` 开启 + 管理员/超管 | `PATCH /api/system/users/{id}` 要求 `system:user:update`；请求体带 `roleCodes` 时还要求 `system:role:update`；部门管理员 403 |

后端仍会按角色层级和数据范围再判一次。目标用户不在调用者范围内时，即使工具可见也会 403。

## 审批与确认

### 建号

1. `dataops_user_lookup` 确认登录名、邮箱、手机没有被占用；没有匹配再建。
2. `dataops_user_create(dry_run=true)`，把 `wouldCreate` 用表格给用户看：登录名、显示名、邮箱、手机、部门、默认角色、零资源授权、密码需在控制台设置。
3. 用户明确确认后，`dataops_user_create(confirm=true)`；等工具审批通过。
4. 回读 `dataops_user_lookup(username=…)` 确认账号存在、角色和部门正确，再汇报 `user.id` 与初始密码交付提示（只回显一次，要求首次登录修改）。

### 角色变更

1. `dataops_user_lookup` 拿到目标 `user_id` 和当前角色。
2. `dataops_role_assign(dry_run=true)`，表格列出每个用户的 `beforeRoles` → `afterRoles`、是否真的变化、失败原因。
3. 用户明确确认后，`dataops_role_assign(confirm=true)`；等工具审批通过。
4. 回读 `dataops_user_lookup`，按 `results[]` 和回读结果汇报；部分失败要逐人说明，不要合并成“成功”。

不要跳过 `dry_run`。不要用“我觉得可以”代替用户确认。

## 常见错误

| 现象 | 原因与处理 |
| --- | --- |
| `provide at least one of username, display_name, email, mobile or wecom_user_id` | lookup 没有任何查询条件；补一个，不要空查全库 |
| `confirm must be true for a real create/change` | 没走 dry_run，也没传 `confirm=true`；先预览再确认 |
| `user_ids must be a non-empty array` / `at most 50 users per call` | 用户 id 为空或超过 50；分批，不要猜 id |
| `role_codes must be a non-empty array` | 没给角色 code；先从现有用户角色或用户在门户确认，不要臆造 |
| `超级管理员 role cannot be assigned or removed` | 该角色只能在管理员控制台改；如实告诉用户 |
| `the change would leave the user without any role` | 减角色会把最后一个角色也减掉；让用户先指定替代角色 |
| `target is a 超级管理员` | 目标是超管，工具不改；转控制台 |
| `user record has no updatedAt optimistic token` | 用户记录缺少乐观锁字段；重新 lookup 后再试，仍缺就报告 |
| `DataOps created the account but returned no user record` | 后端已创建但响应缺用户；先按 username 回读确认，避免重复建号 |
| `Conflict (409)` | `updatedAt` 已被别人改过；重新 lookup 拿新 token，再走一遍预览与确认，不要盲重试 |
| `Forbidden (403)` | 角色/数据范围/能力不足；保留后端原文，不要换账号或绕通道 |
| `Unauthorized (401)` | DataOps 会话过期；请用户重新登录，不要重试同一调用 |

补充：登录名、邮箱重复时后端返回 4xx（常见 409/422），原文转述即可；不要自动改名重试。
