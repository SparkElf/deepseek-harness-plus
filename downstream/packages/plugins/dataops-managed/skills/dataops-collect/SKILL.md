---
name: dataops-collect
description: 把表格 / Excel / CSV 建成可问数的数据资源，或把新表格追加到已有资源时使用。计划由当前会话模型生成，DataOps 只做确定性校验与执行；校验并确认计划前绝不建表。
---

# 数据采集（AI 建资源）

用户把一份表格交给 AI：预览 → 当前会话模型自己生成计划 JSON → `dataops_collect_validate_plan` 校验 → 用户确认 → execute 建表写数。一个会话一份文件、一个目标资源。

## 一、什么时候用

用户说「把这份表格建成能问数的资源」「这个 Excel 帮我导进来」「追加到 XX 资源」「新建一个数据资源」「CSV 入库 / 建表」「把附件建成资源」「加到门店销售明细里」等时使用。

不适用：纯问数、取数、查数据（用 `dataops-query`）；只讨论表结构但不导入。

## 二、硬规则

1. **一次会话一份文件、一个目标资源。** 多文件批量不做。
2. **有引用 = 追加；无引用 = 先问，不默认新建。** 用户已说清“新建”或“追加”的跳过这一问；没说清又没引用，先问「新建资源，还是追加到已有资源？」。
3. **计划由你（当前会话模型）生成。** 读取 preview 后自己写 createTable 或 mappings JSON；不经过任何额外模型调用，也没有计划生成工具或模型参数。
4. **必须先校验。** 生成 JSON 后调用 `dataops_collect_validate_plan`，只使用它返回的 `plan` 汇报和执行；校验失败就修正 JSON 后重试，不要绕过。
5. **确认是唯一硬闸。** 用户明确回复「确认」「开始吧」「可以」之前，绝不调用 `dataops_collect_execute`；预览和校验不建表，可以放心调用。
6. **汇报不是交互。** 计划、候选项、结果用表格 + 文字；不要生成按钮/表单，也不要在对话里做权限表单。
7. **执行走原生工具流。** 不要造执行卡、进度卡；参数、结果、耗时、失败原因都在原生工具卡里。

## 三、按需读取参考文件

主文件只保留流程。按当前步骤读取，不要一次性全部读取：

- 新建表的 createTable/mappings schema、命名与类型规则 → [`references/plan-schema.md`](references/plan-schema.md)
- 追加到已有资源、MCP 读取目标列、字段映射与必填列 → [`references/append.md`](references/append.md)
- execute 参数、失败分类、结果汇报 → [`references/execution.md`](references/execution.md)

## 四、工具

| 工具 | 用途 | 会写数据吗 |
| --- | --- | --- |
| `dataops_collect_preview` | 上传并解析表格，返回 `sessionId` / `preview` / `dataSources` | 否 |
| `dataops_collect_validate_plan` | 校验你生成的 createTable 或 mappings，返回规范化 plan / createSql / 映射摘要 | 否 |
| `dataops_collect_execute` | 执行已确认的导入：建表或追加、写行、登记资源 | **是** |
| `dataops_collect_resources` | 搜索已有资源；只给资源名，不含列目录 | 否 |
| `mcp__dataops__search_resources` / `mcp__dataops__describe_resource` | 追加时检索目标资源、读取真实列与 schema/table | 否 |
| `dataops_open_resource_tab` | 打开 / 聚焦 DataOps 资源页签 | 否 |

## 五、主流程

### 1. 找到文件

从当前消息的附件 / 系统上下文取得工作区路径（通常是 `/workspace/...` 或 `temp/conversations/.../attachments/...`）。没有路径时不要猜目录、不要扫全工作区；直接说“请把表格拖进输入框，或点输入框的 + 上传”。

### 2. 预览，不要建表

调用 `dataops_collect_preview({ file_path })`，返回 `sessionId`、`preview`、`dataSources`。用大白话复述行数、列数、表头位置；文件读不出来就说清楚原因并让用户换文件。

### 3. 先定去向

- 有 `resource-ref` 引用块 → 追加到该资源；
- 用户说“新建 / 建个新资源 / 不要加到已有的” → 新建；
- 用户说“追加 / 加到 / 并到 / 合到” → 追加；没有具体资源时先用 `mcp__dataops__search_resources({ query, kinds: ["TABLE"], limit: 5 })` 列编号候选，让用户回序号或名字；
- 都没有 → 文字问「新建资源，还是追加到已有资源？」，不要出选项卡或选择卡。

`preview` 返回多个数据源时同样用编号文字清单让用户选。

### 4. 生成计划 JSON

- **新建表**：读 `references/plan-schema.md`，按 `preview.columns[].key` 逐列生成 `createTable`。
- **追加**：读 `references/append.md`。先用 `mcp__dataops__search_resources` 拿 `resourceRef`，再用 `mcp__dataops__describe_resource({ resourceRefs: [resourceRef], include: ["columns", "execution"] })` 读取真实目标列和 schema/table，然后生成 `[{sourceKey,targetColumn}]`；MCP 不可见或无 resourceRef 时才让用户给字段/DDL 或改新建，禁止猜列名。

### 5. 必须校验

调用 `dataops_collect_validate_plan({ session_id, data_source_urn, target_schema?, target_table?, create_plan_json?, mappings_json? })`：

- 只传一种形状：新建传 `create_plan_json`；追加传 `target_schema` + `target_table` + `mappings_json`；
- 返回 `{ success, session, plan }`，以返回的 `plan` 为准，不要继续用自己手里的原始 JSON；
- 新建 `plan` 含 `mode` / `targetSchema` / `createTable` / `createSql`；追加含 `mappings` / `unmappedSourceColumns` / `missingRequiredTargetColumns`；
- 校验失败按错误修正后重新校验；不要跳过校验直接 execute。

### 6. 汇报计划

用校验后的 `plan` 出表格 + 文字，说明去向、目标表、字段映射/类型，以及需要用户确认的项；不要生成按钮/表单。确认靠用户回一句话：

> 计划已校验：<行数> 行、<列数> 列，写到 `<schema>.<table>`，默认仅自己可见。确认无误请回复「确认」或「开始吧」；要改表名/类型/映射直接说，我会重新生成并重新校验，不会执行。

### 7. 执行

用户明确确认后，按 [`references/execution.md`](references/execution.md) 调用：

`dataops_collect_execute({ session_id, data_source_urn, mode, target_schema?, target_table?, create_plan_json, mappings_json, resource_name, resource_description, resource_tags?, ai_visible?, access_level? })`

- `mode` 用 `plan.mode`；
- 新建：`create_plan_json` 传 `JSON.stringify(plan.createTable)`，`mappings_json` 传 `"[]"`；
- 追加：`mappings_json` 传 `JSON.stringify(plan.mappings)`（只保留 `sourceKey` / `targetColumn`）；
- `access_level` 默认 `PRIVATE`，`ai_visible` 默认 `true`。
- 用户改表名/类型/映射 → 重新生成 JSON 并重新校验、重新确认，再执行。

### 8. 汇报结果 + 打开资源页签

成功后调用 `dataops_open_resource_tab({ resource_id, resource_name, mode: 'focus' })`，再用表格 + 文字汇报资源名、目标表、行数、字段数、「已可问数」、可见范围，并说明可回「分配权限」「问数」「详情」「操作记录」。细节见 [`references/execution.md`](references/execution.md)。

## 六、引用资源（追加）

输入框资源 chip 或右侧资源卡的「添加到对话」可能带结构化引用：

```resource-ref
{"kind":"dataops-resource","resourceId":123,"name":"门店销售明细","table":"dwd_store_sales"}
```

有它就直接按追加处理，不要再问“新建还是追加”；没有结构化块时，按“用户口头提到资源名”处理，先用 `mcp__dataops__search_resources` 找到 `resourceRef` 再确认，不要凭名字猜 id。映射规则见 [`references/append.md`](references/append.md)。

## 七、边界

- 不做定时采集、增量水位、失败重试策略；
- 不做多文件批量、文件夹上传；
- 不做覆盖（只追加）；
- 不在 DSH 里做审计弹窗；操作记录在 DataOps 资源详情 / 系统审计。