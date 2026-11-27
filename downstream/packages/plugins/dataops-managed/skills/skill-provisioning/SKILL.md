---
name: skill-provisioning
description: 给指定用户或部门批量分配技能时使用。先 preview 列出部门+子部门、受影响用户数、覆盖/冲突明细，得到用户明确确认后才 bind/apply；绑定只改配置，现有用户需 apply 才生效。仅超管、管理员与非超管的部门管理员可用。
metadata:
  permissions:
    - skill:manage
---

# 技能分配（部门默认技能 / 指定用户安装）

用户说「把这个技能发给某个人 / 发给某部门」「给部门配默认技能」「批量装一下」时用本技能。
分配的是**别人**的工作区，不是你自己的；写操作一律先预览、再让用户明确确认。

## 一、工具与适用场景

| 工具 | 作用 | 是否写 |
|---|---|---|
| `department_skill_preview` | 预览部门+子部门、受影响用户数、用户列表、覆盖/冲突 | 只读 |
| `department_skill_bind` | 把技能设为部门默认（可禁用） | 写配置，不铺开 |
| `department_skill_unbind` | 移除部门默认绑定 | 写配置，不铺开 |
| `department_skill_apply` | 把当前绑定**执行一次**到部门/用户 | 写，逐用户生效 |
| `skill_install_for_user` | 给**指定用户**直接安装（可 overwrite） | 写，只影响这些用户 |

选择规则：

- 用户点名了具体人员 → `skill_install_for_user(skill_id, user_ids, overwrite?)`；
- 用户说的是「部门/团队默认要有什么」→ 先 `department_skill_bind`，确认后再 `department_skill_apply`；
- 只是调整部门默认、暂不影响任何人 → 只 bind/unbind，**不要**顺手 apply；
- 目标范围不清楚 → 先 `department_skill_preview`，或让用户给出部门 code / 用户 id。

## 二、强制顺序（不得跳步）

```text
preview（或用户给出明确人员名单 + skill_get 确认技能）
  → 把范围/人数/覆盖明细列给用户
  → 用户明确确认（“确认/执行/可以”）
  → bind / unbind / apply / install_for_user
  → 汇报逐用户结果
```

硬性要求：

1. **禁止未预览直接批量写**：任何部门级写操作（bind/unbind/apply）之前，必须先调用
   `department_skill_preview`，并把「部门 + 子部门、受影响用户数、覆盖/跳过明细」列给用户。
   只有一种例外：用户直接给出 userIds 且明确说「就这些人」，此时可用 `skill_get` 核对技能后
   直接 `skill_install_for_user`，但仍要让用户确认名单。
2. **必须得到用户明确确认**：预览之后问一句「确认按这个范围执行吗？」，得到肯定答复才写。
   用户沉默、改口、或只说「先看看」都不算确认。
3. `department_skill_apply` 还要求 `confirm=true`——这是工具层的第二道确认，不能替代
   对话里的用户确认。
4. 一次只做一个范围。用户改范围就重新 preview，不要复用旧的预览结果。

## 三、部门默认技能：bind 与 apply 是两件事

- `department_skill_bind` / `department_skill_unbind` **只改配置**，不会自动影响现有用户；
- 现有用户要等 `department_skill_apply` 把部门/用户标记为待同步后，才会在工作区下次启动时
  按绑定对齐（工作区正在运行时可立即 reconcile）；
- 因此用户问「绑定后为什么没生效」时，先回答「还差一次 apply」，并先 preview 再执行；
- `include_descendants` 默认 true：父部门绑定会覆盖到子部门。执行前必须在预览里说明
  「包含哪些子部门、共多少人」。

## 四、指定用户安装：只影响名单内的人

`skill_install_for_user` 的行为：

1. 只对 `user_ids` 里的用户生效，**不影响同部门其他人**；
2. 安装在该用户**下次打开工作区**时生效（运行中的工作区可能立即生效）；
3. `overwrite=false`（默认）时，用户已装过同 key 技能则保持原样（状态 `unchanged`）；
   `overwrite=true` 才会覆盖（状态 `overwritten`），覆盖前要让用户知道会替换旧版本；
4. 返回 `results[]`，逐用户状态为 `installed | overwritten | unchanged | forbidden | failed`；
   有 `forbidden/failed` 时如实汇报原因，不要只说「成功」。

## 五、权限范围（服务端每次都会校验）

| 身份 | 可操作范围 |
|---|---|
| 超级管理员 | 所有部门、所有用户 |
| 管理员（非超管） | 所有**非超管**用户；可管理部门绑定 |
| 部门管理员 / 持 `skill:manage` 者 | **本部门 + 所有子部门**，目标不能是超管 |

- 工具可见性只代表「你能发起」，最终范围由 DataOps 在每次调用时判定；被拒绝时把 403 原因
  如实转述给用户，不要换身份重试、不要绕过工具直接调 HTTP。
- 目标用户不存在/停用会单条失败，其余用户继续；汇报时要区分「整体失败」与「单条失败」。
- 普通用户看不到这些工具；如果当前账号没有 `skill:manage`，说明没有分配权限，直接告知用户。

## 六、结果汇报

写操作完成后，按这个结构回复：

1. **做了什么**：技能名/ID、bind 还是 apply、目标部门（含子部门）或用户数；
2. **生效时间**：绑定只是配置；apply/install 在用户下次打开工作区时生效（运行中可能立即）；
3. **逐用户结果**：`installed/overwritten/unchanged/forbidden/failed` 各多少，失败原因；
4. **未做的部分**：例如只 bind 未 apply、跳过的人、被拒绝的范围。

## 七、红线

- 不在未预览、未确认时批量写；
- 不把 `overwrite=true` 当默认值；覆盖别人已装的技能必须先说明；
- 不代替用户决定范围（「整个公司都装上」这类模糊指令必须先问清部门/名单）；
- 不在回复里伪造逐用户结果；接口失败就报失败和错误信息；
- 不导出、不记录任何用户凭据；工具只接受用户 id / 部门 code / 技能 id。