# 万相 AI 中台管理 · 总览

本目录是 `wanxiang-ai-admin` 技能的参考文档。它回答三件事：管理动作有哪些、每个动作需要什么权限、执行前必须确认什么。字段级契约不在这里抄写，按需用 `dataops_api_docs` 查（见 `api-reference.md`）。

## 业务简介

万相 AI 中台的管理面分五块：

| 域 | 管什么 | 典型动作 |
| --- | --- | --- |
| 用户与角色 | 账号、组织归属、角色集合 | 查人、建号、加/减角色 |
| 资源授权 | 数据资源对用户/角色/部门/应用的访问权 | 查授权、批量授权、撤销、审批资源申请 |
| 技能 | 技能中心条目的个人安装与部门默认绑定 | 装给指定用户、绑定部门默认、应用到现有用户 |
| AI 工作区 | 用户工作区容器与临时运维通道 | 重启工作区、开/关 SSH 隧道 |
| 接口契约 | 管理端 HTTP API 的只读检索 | 按 tag/path/operationId 查字段与状态码 |

权限分两层，不要混：

1. **插件披露层**：DSH 工作区按当前 DataOps 身份决定模型能看见哪些工具/技能。看不到就没有入口。
2. **后端授权层**：每次工具调用仍带当前 JWT 打到 DataOps，由 `AuthGuard`/`PermissionGuard` 和数据范围服务再判一次。披露通过不代表后端一定允许，后端 403 时按 403 汇报。

## 文档地图

| 文档 | 内容 |
| --- | --- |
| `users-roles.md` | `dataops_user_lookup`、`dataops_user_create`、`dataops_role_assign`；账号与角色的权限、确认、错误 |
| `resources-grants.md` | `dataops_resource_pending_list`、`dataops_resource_grant_list`、`dataops_resource_grant_batch`、`dataops_resource_grant_revoke`、`dataops_resource_approval_decide`、`dataops_open_resource_tab` |
| `skills-workspaces.md` | `skill_list`/`skill_get`、`skill_install_for_user`、`department_skill_*`、`admin_workspace_*` |
| `api-reference.md` | `dataops_api_docs` 的用法、限制、7 个分组视图与真实 tag 的对应 |

## 建议查询顺序

1. 从 `SKILL.md` 的工具路由确认意图对应的工具；
2. 读本组 reference 的“关键工具与接口”“所需权限”“审批与确认”；
3. 工具参数以工具 schema 为准；
4. 需要 DTO 字段、响应结构、状态码时，按 `api-reference.md` 的分组查 `dataops_api_docs`；
5. 写操作先只读核对，再让用户明确确认，执行后回读。

## 权限矩阵

表中“可/否”同时表示插件是否披露该能力、以及后端是否可能放行；两者都满足才写“可”。部门管理员的数据范围限本人部门及子部门。

| 能力 | 普通用户 | 部门管理员 | 管理员 | 超级管理员 |
| --- | --- | --- | --- | --- |
| 本技能 | 不可见 | 不可见 | 可见 | 可见 |
| 用户查询 | 否 | 本部门/子部门 | 全平台 | 全平台 |
| 建号 | 否 | 否 | 可 | 可 |
| 加/减角色 | 否 | 否 | 可 | 可（不能授/撤超级管理员） |
| 资源授权/撤销 | 否 | 否 | 可 | 可 |
| 资源申请审批 | 否 | 否 | 可 | 可 |
| 技能分配 | 否 | 本部门（用 `skill-provisioning`） | 可 | 可 |
| AI 工作区重启/隧道 | 否 | 否 | 否（工具只向超管披露） | 可 |
| API 文档检索 | 否 | 否 | 可 | 可 |

补充：

- 管理员与超级管理员在后端是平台级旁路角色（`system:admin:manage` 默认只授予这两个角色），所以管理端接口按角色放行；部门管理员仍按 permission key 收口。
- `dataops_user_lookup` 只要求 `system:user:read`，不要求连接器能力；`dataops_user_create`、`dataops_role_assign`、`dataops_resource_*` 还要求技能中心连接器里的 `admin.manage` / `resource.manage` 开关已启用并获授权。
- 工作区代维工具在插件里是 `superAdminOnly`；即使管理员在后台有 `ai:agent:manage`，本技能也不会给管理员这三个工具。

## 通用约定

- **对象先解析再写**：姓名、部门名、角色名都不是 id。先 lookup/list 拿到稳定标识，再传给写工具。
- **批量前先看范围**：部门技能分配先 `department_skill_preview`；资源授权先 `dataops_resource_grant_list`；角色变更先 `dataops_role_assign(dry_run=true)`。
- **结果以回读为准**：写操作返回成功只说明请求被接受；有只读工具的（用户、授权、技能列表）汇报前再读一次，没有只读工具的按返回结果和用户门户的实际状态核对。
- **不跨通道**：不要用 `browser` 点门户、用 SQL 直写或用 `api_prepare_request` 绕开缺失的工具；缺能力就报告缺能力。
