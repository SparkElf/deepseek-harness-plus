---
name: wanxiang-ai-admin
description: 万相 AI 中台管理：用户/角色/资源授权/技能与工作区管理
metadata:
  permissions:
    - system:admin:manage
---

# 万相 AI 中台管理

管理员和超级管理员在会话里直接管理万相 AI 中台：查人、建号、改角色、查/授/撤资源权限、处理资源申请审批、按用户或部门分配技能、排查与代维 AI 工作区。所有动作都走已注册的 `dataops_*` 工具，由 DataOps 后端做最终授权、参数校验和审计；本技能不直连数据库、不发任意 HTTP、不保存任何凭据。

**本技能只对管理员与超级管理员展示**（`system:admin:manage`）。部门管理员与普通用户看不到，他们需要本部门技能分配时用 `skill-provisioning`。

## 适用

- 按用户名、姓名、邮箱、手机或企微 userid 查人，确认 `user_id`；
- 给新同事建一个普通账号（无资源授权）；
- 给一个或多个用户加角色、减角色；
- 查看某个资源现有授权，批量授权给用户/角色/部门/应用，或撤销授权；
- 处理待办的资源申请审批任务（通过/驳回）；
- 把某个技能装给指定用户，或设为部门默认技能并应用到现有用户；
- 重启某个用户的 AI 工作区；超级管理员开/关临时 SSH 隧道；
- 查某个管理接口的字段、状态码与调用契约。

## 不适用

- 问数、取数、出报表 → `dataops-query`；
- 资源/列/指标/血缘等元数据治理 → `dataops-governance`；
- 技能上架审核（`review_scan` / `review_decide`）→ 属于审核流程，本技能不展开；确需审核时先向用户确认再调用；
- 部门管理员的本部门技能分配 → `skill-provisioning`（本技能对部门管理员不可见）；
- 重置密码、改密码、配置 MFA、删除用户 → 用户控制台，本技能没有对应工具；
- 删除资源、改系统配置、执行任意 SQL → 不在工具集内，不要用其他通道绕过。

## 安全规则（必须遵守）

1. **不猜参数。** `user_id`、部门 code、角色 code、`skill_id`、`resource_id` 必须来自工具返回、用户明确提供或 `dataops_api_docs` 的契约示例。缺了就停下来问，不要用姓名拼 id、不要试一个“看起来像”的 code。
2. **不写密钥。** 不索取密码、Token、私钥、Cookie。工作区隧道的私钥只写到 0600 一次性文件里，工具返回路径和 `ssh -i` 命令；不要把私钥内容贴进对话、文件或会话总结。
3. **写操作三步。** 先只读核对 → 用表格说明影响并让用户明确确认 → 再执行。有 `dry_run` 的先跑 `dry_run=true`；有 `confirm` 的必须传 `confirm=true`；工具会弹审批的，等审批通过再继续。
4. **没有 `dry_run`/`confirm` 的写工具**（资源授权/撤销、工作区重启/隧道）：先用只读工具列出当前状态，说明“将新增/移除哪些目标、影响谁”，得到用户明确确认后才调用；调用后回读核对。
5. **最小变更。** 只改用户点名的对象；不擅自批量扩大，不顺手改其他角色或授权。批量授权保留未点名的既有授权。
6. **失败如实报。** 401/403/409/422 的后端原文要保留，不改写成“成功”或“部分成功”；不确定是否写入时先回读再下结论。
7. **不抄文档。** 不把整份 OpenAPI 贴进回答；字段级细节按需用 `dataops_api_docs` 查，只引用与当前问题相关的那几条。

## 工具路由

| 意图 | 工具 | 类型 | 确认要求 |
| --- | --- | --- | --- |
| 按用户名/姓名/邮箱/手机/企微查人 | `dataops_user_lookup` | 读 | 无 |
| 建普通账号 | `dataops_user_create` | 写 | `dry_run` → 用户确认 → `confirm=true` + 工具审批 |
| 加/减角色 | `dataops_role_assign` | 写 | `dry_run` → 用户确认 → `confirm=true` + 工具审批 |
| 看待审批资源申请 | `dataops_resource_pending_list` | 读 | 无 |
| 按名称查资源 id | `dataops_collect_resources` | 读 | 无 |
| 看某资源现有授权 | `dataops_resource_grant_list` | 读 | 无 |
| 批量授权 | `dataops_resource_grant_batch` | 写 | 先 list + 用户明确确认（无 dry_run/confirm） |
| 撤销授权 | `dataops_resource_grant_revoke` | 写 | 先 list + 用户明确确认（无 dry_run/confirm） |
| 审批通过/驳回 | `dataops_resource_approval_decide` | 写 | 用户明确确认（无 confirm 参数） |
| 打开资源 Tab（分配/详情/审计） | `dataops_open_resource_tab` | 导航 | 无 |
| 找技能 id / 看技能详情 | `skill_list` / `skill_get` | 读 | 无 |
| 给指定用户装技能 | `skill_install_for_user` | 写 | 工具审批 |
| 部门默认技能预览 | `department_skill_preview` | 读 | 无 |
| 绑定/解绑部门默认技能 | `department_skill_bind` / `department_skill_unbind` | 写 | 工具审批 |
| 应用到现有用户 | `department_skill_apply` | 写 | `confirm=true` + 工具审批 |
| 重启用户工作区（超管） | `admin_workspace_restart` | 写 | 用户明确确认 |
| 开/关临时 SSH 隧道（超管） | `admin_workspace_tunnel_open` / `admin_workspace_tunnel_revoke` | 写 | 用户明确确认；用完必须 revoke |
| 查接口契约 | `dataops_api_docs` | 只读 | 无 |

**工具不在列表里 = 当前角色或连接器能力没开。** `dataops_user_create`、`dataops_role_assign` 与 `dataops_resource_*` 还要求技能中心「连接器」里的「万相中台管理」/「资源管理」开关已启用。不要用其他工具模拟，也不要让用户“先随便试试”；直接说明缺哪个能力或权限。

## Reference 路由

| 场景 | 读哪个 |
| --- | --- |
| 用户、账号、角色 | `references/users-roles.md` |
| 资源授权、审批任务 | `references/resources-grants.md` |
| 技能分配、AI 工作区 | `references/skills-workspaces.md` |
| 字段/接口契约、tag 分组 | `references/api-reference.md` |
| 总览、权限矩阵、查询顺序 | `references/00-index.md` |

## 何时查 Reference，何时查 API 契约

按这个顺序，不要跳步：

1. **先读对应分组的 reference**：确认有哪些工具、需要什么权限、写操作怎么确认、常见错误怎么处理。
2. **工具 schema 优先**：参数名、必填项、取值范围已经在工具的 JSON Schema 里；直接按 schema 传参。
3. **只有需要后端字段/响应/状态码，或本技能没覆盖的管理接口时，才用 `dataops_api_docs`**：
   - 已知领域 → `tag`（如 `Users`、`Roles`、`AiWorkspacesAdmin`）；
   - 已知路径片段 → `path`（如 `/api/system/users`）；
   - 已知 operationId 片段 → `operation_id`；
   - 关键词 → `query`（空格分隔，全部命中才返回）。
4. **文档只读。** `dataops_api_docs` 检索 `/api/openapi.json`，不会执行请求；实际调用仍由 `dataops_*` 工具完成，权限仍由 DataOps 判。文档返回 403 不代表工具不能用，反过来工具 403 也不能靠文档绕过。

## 汇报

- 用表格 + 文字说清楚：对象、变更前后、影响范围、结果、下一步；
- 不生成按钮/表单；确认靠用户回一句话；
- 写操作完成后**回读一次**（`dataops_user_lookup` / `dataops_resource_grant_list` / `skill_list`），拿回读结果汇报，不拿请求参数当结果；工作区操作按工具返回与用户门户的实际状态核对；
- 后端返回的错误原样转述；需要用户去门户补操作的（如设置初始密码），明确写出来。
