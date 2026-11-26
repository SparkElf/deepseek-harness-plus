# 技能分配与 AI 工作区

## 业务简介

技能中心里的一个技能条目（`skill_id`）可以走两条分配路径：

- **个人安装**：只装给点名的一组用户；写的是每个用户的安装记录，用户下次打开工作区生效（运行中的工作区可能立即生效）。
- **部门默认**：先把技能绑定为某部门的默认技能（只改配置），再“应用”一次，把该部门（含子部门）的现有用户标记为待同步；同步在用户下次启动工作区时执行。

两条路径刻意分开：`department_skill_bind`/`unbind` 不会改任何现有用户的已装技能；`department_skill_apply` 才会让变更触达现有用户。把“绑定成功”说成“所有人都装好了”是错误汇报。

AI 工作区是每个用户在 DSH 里的容器。超级管理员可以重启某个用户的工作区，也可以开一个 24 小时有效的临时 SSH 隧道做代维。隧道私钥不进入对话：工具只把它写进 0600 的一次性文件，并返回路径与 `ssh -i` 命令。

部门管理员也能做本部门的技能分配（`skill:manage`），但他们看不到本技能，走的是 `skill-provisioning`。本技能对管理员/超管展示，并额外覆盖工作区代维。

## 关键工具与接口

| 工具 | 用途 | 后端接口 | 读/写 |
| --- | --- | --- | --- |
| `skill_list` | 列技能中心：本地、待审、已通过、可安装 | `GET /api/ai/skill-plaza/skills`、`?scope=mine`、`/admin/skills` | 读 |
| `skill_get` | 按 id 读一个技能条目 | 复用 `skill_list` 的合并结果 | 读 |
| `skill_install_for_user` | 装给指定用户 | `POST /api/ai/skill-plaza/admin/install-for-users` `{skillId,userIds,overwrite?}` | 写 |
| `department_skill_preview` | 预览部门默认绑定的影响 | `GET /api/ai/skill-plaza/admin/department-skills/preview?departmentCode=…&skillId=…` | 读 |
| `department_skill_bind` | 绑定/停用部门默认技能（只改配置） | `POST /api/ai/skill-plaza/admin/department-skills/bind` `{departmentCode,skillId,enabled}` | 写 |
| `department_skill_unbind` | 移除部门默认技能（只改配置） | `POST /api/ai/skill-plaza/admin/department-skills/unbind` `{departmentCode,skillId}` | 写 |
| `department_skill_apply` | 把当前绑定应用到现有用户 | `POST /api/ai/skill-plaza/admin/department-skills/apply` `{departmentCode,includeDescendants}` 或 `{userIds}` | 写 |
| `admin_workspace_restart` | 重启某用户的工作区（超管） | `POST /api/ai/workspaces/{id}/restart`；旧接口 `POST /api/ai/workspace/restart?userId=…` | 写 |
| `admin_workspace_tunnel_open` | 开临时 SSH 隧道（超管） | `GET /api/ai/workspaces` 定位 → `POST /api/ai/workspaces/{id}/tunnel` | 写 |
| `admin_workspace_tunnel_revoke` | 关隧道并删本地私钥（超管） | `DELETE /api/ai/workspaces/{id}/tunnel` | 写 |
| `dataops_api_docs` | 查工作区接口字段与状态码 | `GET /api/openapi.json`（只读检索） | 读 |

技能中心的 `/api/ai/skill-plaza/*` 不在管理端 `/api/openapi.json` 里；技能分配参数以工具 schema 为准。工作区接口（`AiWorkspacesAdmin`）可用 `tag=AiWorkspacesAdmin` 查字段。

### `skill_list` / `skill_get`

- `skill_list` 合并三类行：调用者自己的 `mine`、公共可安装列表、管理员才有的 `admin` 列表；返回 `local`、`pending`、`approved`、`rejected` 四个分组和 `skills[]` 明细。
- `skill_get` 只从合并结果里找；找不到会报 `Skill not found or not visible`。不要拿一个 id 直接当存在。
- 分配前确认条目是 `approved` 且有可见性；`pending`/`rejected`/已下架的条目不要装。

### `skill_install_for_user`

- 参数：`skill_id` 正整数、`user_ids` 非空 UUID 数组、`overwrite` 可选（默认 false，已有同 key 安装则保留）。
- 只影响点名的用户，不会扩散到部门。
- 工具会弹一次用户审批；审计记录技能 id、用户数、是否覆盖、`skillKey`。
- 调用者需持有 `skill:manage`；DataOps 逐次校验目标用户范围（超管全部、管理员非超管、部门管理员本部门+子部门）。超出范围的目标会被拒绝，不能靠分批绕过。

### 部门默认技能

- `department_skill_preview` 返回部门+子部门树、受影响用户数、用户清单、现有安装/冲突明细；只读，必须先跑。
- `department_skill_bind` 的 `enabled=false` 表示停用绑定；`unbind` 直接移除。两者都只改配置，不碰现有用户。
- `department_skill_apply` 必须 `confirm=true`，且 `department_code` 与 `user_ids` 二选一；默认 `include_descendants=true`。它把受影响用户标记为待 reconcile，用户下次启动工作区时执行。

### `admin_workspace_*`

- 三个工具都只对超级管理员披露，执行时工具内还会再判一次 `isSuperAdmin`。
- `admin_workspace_restart` 按 `user_id` 找 workspace：先 `GET /api/ai/workspaces`，找不到再退回旧的重启接口。重启会中断该工作区里正在进行的会话/任务。
- `admin_workspace_tunnel_open` 返回 `keyPath`、`sshCommand`、`targetHost`、`port`、`expiresAt`。私钥只写进 `<workspace>/.dataops/admin-tunnels/<workspaceId>/id_ed25519`（目录 0700、文件 0600）。**不要把私钥读出来贴到回复里。**
- `admin_workspace_tunnel_revoke` 调服务端关闭隧道，并删除本地私钥文件与目录；代维结束必须调用，不等自然过期。

## 所需权限

| 动作 | 插件披露 | 后端授权 |
| --- | --- | --- |
| 技能列表/详情 | `skill:read`（兼容 `skill:capability:read`） | 同一能力；返回范围按角色收口 |
| 装给指定用户 | `skill:manage`（兼容 `skill:capability:manage`） | `skill:capability:manage`；只能操作调用者范围内的用户 |
| 部门预览/绑定/解绑/应用 | `skill:manage` | `skill:capability:manage`；部门管理员限本人部门及子部门 |
| 工作区重启/隧道 | `superAdminOnly` | `ai:agent:manage`；本技能只向超管提供工具 |

注意：部门管理员虽然有 `skill:manage`，但本技能对他们不可见。给部门管理员解释时，指到 `skill-provisioning`，不要让他“换个入口”继续。

## 审批与确认

### 装给指定用户

1. `skill_list` 找到技能，`skill_get` 确认状态与可见性。
2. `dataops_user_lookup` 逐个确认目标用户，收集 `user_id`；不要从姓名猜。
3. 表格列出：技能名/id、目标用户（登录名+显示名+部门）、是否覆盖已有安装、生效时机（下次打开工作区）。
4. 用户明确确认后调用 `skill_install_for_user`；等工具审批通过。
5. 按返回的 `skillKey`/结果汇报，并说明“目标用户下次打开工作区时生效”。工具没有“查某用户装了什么”的接口，不要伪造回读结果。

### 部门默认技能

1. `department_skill_preview` 拿部门树、用户数、用户清单、冲突/覆盖明细。
2. 表格展示后再问用户：只绑定，还是绑定并立即应用到现有用户。
3. 绑定/解绑：`department_skill_bind` / `department_skill_unbind`，等工具审批通过。
4. 需要触达现有用户时，再 `department_skill_apply(confirm=true)`；等工具审批通过。
5. 汇报时区分三件事：绑定配置已改、应用已提交、用户实际同步要等下次启动工作区。

### 工作区重启 / 隧道

1. 说明影响：重启会中断该用户当前工作区里的运行；隧道是 24 小时有效的临时运维通道。
2. 用户明确确认后才调用；工作区工具没有 `confirm` 参数，确认只能在对话里完成。
3. 隧道用完立即 `admin_workspace_tunnel_revoke`；汇报时只给 `keyPath` 和 `ssh -i` 命令，不给私钥正文。

## 常见错误

| 现象 | 原因与处理 |
| --- | --- |
| `skill_id must be a positive integer` | id 缺失/非法；先 `skill_list` |
| `user_ids must be a non-empty array of DataOps user ids` | 目标为空或含空串；先 lookup 拿 UUID |
| `department_code is required` | 部门 code 为空；从部门树/用户资料取，不要拿部门名当 code |
| `accepts either department_code or user_ids, not both` | apply 同时给了两种范围；二选一 |
| `requires confirm=true` | apply 没确认；先预览并让用户明确确认 |
| `Skill not found or not visible` | 条目不存在或不在调用者可见范围；不要换 id 乱试 |
| `skipped` | `overwrite=false` 且目标已有同 key 安装；先说明冲突，让用户决定是否覆盖 |
| `forbidden` | 目标用户超出调用者范围（超管目标、别的部门）；不要分批绕 |
| `systemOwned` | 全局内置技能优先，未覆盖；如实说明 |
| `failed` | 目标不存在、已停用或安装报错；按 `reason` 逐条汇报 |
| `Forbidden (403)` | 缺 `skill:capability:manage` 或目标超出部门/用户范围；保留原文 |
| `目标用户没有可代维的工作区` | `GET /api/ai/workspaces` 里找不到该 user 的工作区；确认 user_id 后报告 |
| `开通隧道的响应里没有 privateKey` | 后端没返回私钥；不要重试到成功为止，报告后端异常 |
| 隧道私钥出现在对话/日志 | 严重错误：停止操作，说明私钥只应留在 0600 文件，并 revoke 后重新开通 |
| `Not Found (404)` | 工作区或路由不存在（旧接口缺失）；按工具返回的路径提示报告 |
