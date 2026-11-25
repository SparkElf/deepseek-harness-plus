# 文件导入（合并自 dataops-collect）

# 数据采集（AI 建资源）

用户把一份表格交给 AI，AI 解析、出计划、用户确认后建表写数，最后得到一个能问数的资源。第一版只做一次性导入；一个会话一份文件、一个目标资源。

## 一、什么时候用

用户表达下面任一意图时使用本技能：

- 把这份表格建成能问数的资源
- 这个 Excel 帮我导进来
- 上传个表能问数吗
- 把这份数据加到已有的那个资源里
- 追加到 XX 资源
- 新建一个数据资源
- 表格导入 / 导入成表 / 建成资源
- 把 CSV 变成能查的表 / 能问数的表
- 这份数据帮我入库 / 建表
- 把这个 sheet 建成资源
- 这个表以后能用来问数吗
- 把这份销售表导入
- 把这份名单建成资源
- 加到门店销售明细里
- 追加一份月度数据
- 建个新资源，用这个文件
- 导入到数据中台
- 这个文件能建成资源吗
- 把附件建成资源
- 用这个表格建一张表

不适用：纯问数、取数、查数据（用 `dataops-query`）；只讨论表结构但不导入。

## 二、四个硬规则

1. **一次会话一份文件、一个目标资源。** 多文件批量不做。
2. **有引用 = 追加；无引用 = 先问，不默认新建。** 用户话里已经说清“新建”或“追加”的，跳过这一问；没说清又没引用，必须先出「新建资源 / 选择已有资源」二选一，不能直接出新建计划。
3. **计划确认是唯一硬闸。** 用户明确回复「确认」「开始吧」「可以」等之前，绝不调用 `dataops_collect_execute`，绝不建表、绝不写数。预览和计划工具本身不建表，可以放心调用。
4. **执行走原生工具流。** 不要自己造执行卡、进度卡；工具参数、结果、耗时、失败原因都在原生工具卡里。你只在旁边说人话。

## 三、主流程

### 1. 找到文件

从当前消息的附件 / 系统上下文里取得表格在工作区的路径（通常是 `/workspace/...` 或 `temp/conversations/.../attachments/...`）。没有路径时，不要猜目录、不要扫全工作区；直接说“请把表格拖进输入框，或点输入框的 + 上传”，并给一个内联上传提示。

### 2. 预览，不要建表

调用：

`dataops_collect_preview({ file_path })`

返回 `sessionId`、`preview`、`dataSources`。用大白话复述：

> 看了下，明细 sheet 共 12,000 行、18 列；表头在第 2 行。我先按明细建资源。

文件读不出来也在这里说清楚：

> 这个 xlsx 读不出来，可能加密了。你换个文件，或者告诉我表头在第几行。

### 3. 先定去向

- 当前会话里有 `resource-ref` 引用块 → 追加到该资源；
- 用户说“新建 / 建个新资源 / 不要加到已有的” → 新建；
- 用户说“追加 / 加到 / 并到 / 合到” → 追加；没有具体资源时先让用户选；
- 都没有 → 出「新建资源 / 选择已有资源」GenUI，等用户选。

选择已有资源时：
1. 调用 `dataops_collect_resources({ query, limit: 8 })`；
2. 用 `choices` 或 `list` + 按钮列出最多 8 个候选（资源名 + 表名 + 行数）；
3. 用户选中后，把该资源作为本次目标，进入计划。

### 3.5 判定业务域

每次新建/导入资源前，由会话模型根据**表名、表注释、字段名/注释、术语、少量样例值**判断业务域，不依赖代码里的固定表名规则。判断结果是资源目录的一部分，必须写入导入参数：

- `business_domain`：业务域名称，例如「金融域」「软件研发域」；不确定时不要猜，留空或传「未分类」。
- `domain_inference_source`：`MODEL`（模型根据元数据判断）、`USER`（用户明确指定）、`RULE`（已有治理规则）、`UNKNOWN`。
- `domain_inference_confidence`：`HIGH` / `MEDIUM` / `LOW`。`LOW` 或无法判断时统一落 `/业务域/未分类`，不要为了好看硬塞一个域。

判定顺序：

1. 用户明确说了业务域 → `USER` + `HIGH`。
2. 表名/注释/字段/术语有明确业务语义 → `MODEL` + `HIGH` 或 `MEDIUM`。
3. 只能靠库名或样例值猜测 → `MODEL` + `LOW`，最终落未分类。
4. 完全无信号 → `UNKNOWN` + `LOW`，落未分类。

常见公开数据集的业务域示例（仅作判断参考，不是代码规则）：

- BIRD `codebase_community` → 软件研发域
- `financial` / `debit_card_specializing` → 金融域
- `student_club` → 教育域
- `thrombosis_prediction` / `toxicology` → 医疗域
- `european_football_2` / `formula_1` → 体育域
- `card_games` / `superhero` → 娱乐域

目录规则：资源挂在 `/业务域/<业务域>/<数据源>/<库>/<schema>`，无 schema 时省略该层；不为每张表单独建目录。系统表不属于业务域，统一在 `/系统域/<模块>`。

### 4. 生成计划，不要执行

调用：

`dataops_collect_plan({ session_id, data_source_urn, target_schema?, target_table? })`

- 不传 `target_table` = 新建表（CREATE_TABLE）；
- 传 `target_schema` + `target_table` = 追加到已有表（EXISTING_TABLE）。

返回后检查 `plan`：
- 新建表：`plan.mode === 'CREATE_TABLE'`，有 `plan.createTable`、`plan.createSql`；
- 追加：`plan.mode === 'EXISTING_TABLE'`，有 `plan.mappings`，并在计划里多一行映射摘要（匹配 N 个字段、新增 N 个、N 个类型不兼容）。

### 5. 出计划 GenUI（只读预览，语言确认）

计划是主确认点，但**只读**：卡上不放 `input` / `textarea` / 下拉 / `submit`，也不放「开始导入」「再调整」按钮。用户看完卡后，直接用自然语言回复「确认」「开始吧」才执行。

必须包含（全部纯展示）：

- 资源名（AI 起草）
- 去向（新建资源 / 追加到「已有资源名」）
- 目标表（库.表）
- 导入数据源
- 行数 / 字段数
- 业务域（含推断来源/置信度；未分类也要写明）
- **表头映射**：原表头 → 目标字段 → 类型；低置信度类型写「需确认」，并用 warning callout 再列一遍（GenUI 表格单元格不支持单独标黄）
- 默认权限

计划 GenUI 示例（把 `<...>` 换成真实值；注意没有任何输入控件）：

```dsh-ui
{"title":"导入计划","items":[{"type":"text","size":"body","content":"看了下，明细 sheet 共 <行数> 行、<列数> 列；我先按明细建资源。"},{"type":"card","title":"<资源名>","items":[{"type":"keyvalue","pairs":[{"key":"资源名","value":"<资源名>"},{"key":"去向","value":"新建资源"},{"key":"目标表","value":"<schema.table>"},{"key":"导入数据源","value":"<数据源名>"},{"key":"行数 / 字段数","value":"<行数> 行 / <字段数> 列"},{"key":"默认权限","value":"仅自己可见"}]},{"type":"table","columns":["原表头","目标字段","类型"],"rows":[["<原表头1>","<目标字段1>","<类型1>"],["<原表头2>","<目标字段2>","⚠️ 需确认"]]},{"type":"callout","tone":"warning","content":"以下类型需要确认：<列出低置信度字段>。"},{"type":"callout","tone":"info","content":"确认无误请直接回复「确认」或「开始吧」；要改表名、类型或资源名，直接说，我会重新出计划，不会执行。"}]}]}
```

规则：

- 用户提出修改（「表名换成 xxx」「金额按文本存」「资源名改成 xxx」）→ 只在对话里改参数，然后重新调用 `dataops_collect_plan` / 调整计划，**重新出只读计划卡，不要执行**；
- 用户确认后，计划折叠成一行“已按此计划执行”的回执，把屏幕让给工具流；
- 确认后如果要改参数，先停，再出新计划。

### 6. 执行

用户明确回复「确认」「开始吧」「可以」后，使用计划卡上展示的资源名/目标表/描述调用：

`dataops_collect_execute({ session_id, data_source_urn, mode, target_schema?, target_table?, create_plan_json, mappings_json, resource_name, resource_description, resource_tags?, ai_visible?, access_level?, business_domain?, domain_inference_source?, domain_inference_confidence? })`

- `mode` 用 `plan.mode`；
- 新建表：`create_plan_json` 传 `JSON.stringify(plan.createTable)`，`mappings_json` 传 `"[]"`；
- 追加：`mappings_json` 传 `JSON.stringify(plan.mappings)`；
- `resource_name` 用计划卡上展示、用户确认过的资源名；
- `access_level` 默认 `PRIVATE`；`ai_visible` 默认 `true`。
- `business_domain` / `domain_inference_source` / `domain_inference_confidence` 按 3.5 的判定结果传入；不传时后端落 `/业务域/未分类`。

执行期间只说阶段小结，例如：

> 表建好了。现在写数据，一万两千行，估计一两分钟。
>
> 写完了，正在生成字段说明。

失败只说三类，并给一个动作：
- 文件问题 → 重新上传 / 告诉我表头在第几行；
- 字段问题 → 调整映射 / 改类型；
- 系统问题 → 重试。

### 7. 结果 GenUI + 打开资源页签

执行成功后：

1. 调用 `dataops_open_resource_tab({ resource_id, resource_name, mode: 'focus' })`，让右侧栏自动打开 `dataops-resources` 页签并定位新资源；
2. 出结果 GenUI，必须包含资源名、目标表、行数、字段数、业务域（含推断来源/置信度；未分类要明确写“未分类”）、 “已可问数”、当前可见范围（默认“仅自己可见”），以及三个动作：**分配权限 / 去问数 / 查看详情**，外加一条 **查看操作记录** 文字链。

结果 GenUI 示例：

```dsh-ui
{"title":"导入完成","items":[{"type":"callout","tone":"success","title":"已可问数","content":"资源已建成，可以开始问数。"},{"type":"keyvalue","pairs":[{"key":"资源名","value":"<资源名>"},{"key":"目标表","value":"<schema.table>"},{"key":"行数","value":"<行数>"},{"key":"字段数","value":"<字段数>"},{"key":"可见范围","value":"仅自己可见"}]},{"type":"row","items":[{"type":"button","label":"分配权限","tone":"primary","action":"dataops_open_grant"},{"type":"button","label":"去问数","action":"dataops_ask"},{"type":"button","label":"查看详情","action":"dataops_open_detail"}]},{"type":"button","label":"查看操作记录 →","tone":"ghost","small":true,"action":"dataops_open_audit"}]}
```

三个动作的处理：

- 分配权限 → `dataops_open_resource_tab({ resource_id, mode: 'grant' })`，侧栏资源卡定位并自动打开授权弹窗；
- 去问数 → 不要跳页，直接在对话里给 2-3 个可以问的问题示例，并说明资源已可被检索；
- 查看详情 → `dataops_open_resource_tab({ resource_id, mode: 'detail' })`；
- 查看操作记录 → `dataops_open_resource_tab({ resource_id, mode: 'audit' })`。

## 四、引用资源（追加）

引用可能来自输入框的资源 chip，也可能来自右侧栏资源卡的「添加到对话」。如果引用以结构化块出现，形如：

```resource-ref
{"kind":"dataops-resource","resourceId":123,"name":"门店销售明细","table":"dwd_store_sales"}
```

就把它当作本次追加目标，不要再问“新建还是追加”。如果用户在上传文件之前先引用了资源，直接按追加处理。

如果「添加到对话」降级成发送一条消息，消息里必须带这个 `resource-ref` 块；没有结构化块时，按“用户口头提到资源名”处理，先用 `dataops_collect_resources` 找到资源再确认，不要凭名字猜 id。

## 五、边界

- 不做定时采集、增量水位、失败重试策略；
- 不做多文件批量、文件夹上传；
- 不做覆盖（只追加）；
- 不在对话里做权限表单（GenUI 没有人员选择器）；
- 不在 DSH 里做审计弹窗；操作记录在 DataOps 资源详情 / 系统审计。