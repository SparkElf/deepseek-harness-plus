# 执行与结果汇报

`dataops_collect_execute` 是整个采集流程里唯一会建表、写行、登记资源的工具。调用前必须同时满足两件事：

1. `dataops_collect_validate_plan` 已成功返回规范化 `plan`；
2. 用户已经针对这份校验后的计划明确回复「确认」「开始吧」「可以」等。

任何一件不满足都不要执行。

## 一、参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `session_id` | 是 | `dataops_collect_preview` 返回、校验时使用的同一个 session id |
| `data_source_urn` | 是 | 预览结果里用户选定的数据源 `urn` |
| `mode` | 是 | `CREATE_TABLE` / `EXISTING_TABLE` / `OVERWRITE_TABLE`，用校验后 `plan.mode` |
| `confirm_overwrite` | OVERWRITE 必填 | 用户已明确确认“清空目标表”时传 `true`；缺省会被拒绝 |
| `target_schema` | 追加必填 | 目标 schema；新建表可不传，由 DataOps 用数据源默认 schema |
| `target_table` | 追加必填 | 目标表名；新建表可不传，默认用 `plan.createTable.tableName` |
| `create_plan_json` | 新建必填 | `JSON.stringify(plan.createTable)`；只传 createTable，不要带 `createSql` / `targetSchema` / `notes` |
| `mappings_json` | 追加/覆盖必填 | `JSON.stringify(plan.mappings.map(({sourceKey,targetColumn}) => ({sourceKey,targetColumn})))`；新建表传 `"[]"` |
| `resource_name` | 建议 | 计划里展示、用户确认过的资源名 |
| `resource_description` | 否 | 资源描述 |
| `resource_tags` | 否 | 字符串数组 |
| `business_domain` | 否 | 当前会话模型推断的业务域，如“财务域”；不确定则不传，落“未分类” |
| `domain_inference_source` | 否 | `MODEL` / `USER` / `RULE` / `UNKNOWN`；默认 `MODEL`（传了业务域时） |
| `domain_inference_confidence` | 否 | `HIGH` / `MEDIUM` / `LOW`；`LOW` 会落“未分类” |
| `ai_visible` | 否 | 默认 `true` |
| `access_level` | 否 | `PUBLIC` / `PROTECTED` / `PRIVATE`，默认 `PRIVATE` |

## 业务域判断

业务域由**当前会话模型**根据表名、中文名、注释、字段名、术语/字典判断，不调用额外模型：

- 判断有把握：传 `business_domain` + `domain_inference_source: "MODEL"` + `domain_inference_confidence: "HIGH"`；
- 用户明确指定：`domain_inference_source: "USER"`；
- 不确定：不传 `business_domain`，或传 `domain_inference_confidence: "LOW"`，DataOps 落 `/业务域/未分类`；
- 不要在插件或后端写死关键词规则；规则会随业务变化。

## 覆盖导入

`OVERWRITE_TABLE` 会先 TRUNCATE 目标表再写入：

- 只有用户明确确认“清空/覆盖”后才可调用；
- 必须传 `confirm_overwrite: true`；
- 汇报时明确“将清空 N 行”，不要把覆盖说成追加；
- 全量驾驶舱快照可用；增量更新应使用后续 upsert/update/delete 工具。

## 二、两种调用形状

新建表：

```text
dataops_collect_execute({
  session_id,
  data_source_urn,
  mode: "CREATE_TABLE",
  create_plan_json: JSON.stringify(plan.createTable),
  mappings_json: "[]",
  resource_name: "门店销售明细",
  access_level: "PRIVATE",
  ai_visible: true
})
```

追加到已有表：

```text
dataops_collect_execute({
  session_id,
  data_source_urn,
  mode: "EXISTING_TABLE",
  target_schema: "wanxiang_demo",
  target_table: "dwd_store_sales",
  create_plan_json: undefined,
  mappings_json: JSON.stringify(plan.mappings.map(({ sourceKey, targetColumn }) => ({ sourceKey, targetColumn }))),
  resource_name: "门店销售明细（追加）",
  access_level: "PRIVATE",
  ai_visible: true
})
```

## 三、用户改计划时

- 改表名、字段名、类型、中文名：修改自己手里的 createTable JSON，**重新调用 `dataops_collect_validate_plan`**，用新的 `plan` 重新汇报、重新确认。
- 改映射：修改 mappings JSON，重新校验。
- 改资源名、描述、标签、可见范围：这些不参与计划校验，直接按用户最终确认的值传给 execute。
- 不要拿“改过的原始 JSON”直接 execute；execute 只接受校验后的计划。

## 四、执行期间怎么说

只说阶段小结，不要造进度卡：

> 表建好了。现在写数据，一万两千行，估计一两分钟。

> 写完了，正在登记资源。

## 五、失败分类与动作

| 现象 | 分类 | 对用户说 / 做什么 |
| --- | --- | --- |
| HTTP 404 `表格导入会话不存在或已过期` | 文件/会话 | 让用户重新上传同一文件，从 preview 重来 |
| `没有可导入的数据行` / `转换失败` | 字段/数据 | 说明哪些列转换失败，建议改类型或调整映射后重新校验 |
| `目标表不存在` | 目标 | 让用户确认 schema/表名，或重新选资源 |
| `表已存在` / 409 | 目标 | 让用户二选一：换一个表名新建，或改成追加到已有表 |
| HTTP 401 | 会话 | 说明 DataOps 登录过期，需要重新登录后再试 |
| HTTP 403 | 权限 | 说明当前账号缺少资源管理权限，不要重试绕过 |
| 网络错误 / 5xx | 系统 | 说明是系统或网络问题，可以重试一次；仍失败就停下并保留 session |

失败后不要悄悄换参数重试；先把原因和下一步动作告诉用户。

## 六、成功后汇报

1. 先调用：

`dataops_open_resource_tab({ resource_id, resource_name, mode: "focus" })`

2. 再用表格 + 文字汇报：

```dsh-ui
{"title":"导入完成","items":[{"type":"keyvalue","pairs":[{"key":"资源名","value":"<资源名>"},{"key":"目标表","value":"<schema>.<table>"},{"key":"写入行数","value":"<importedRows>"},{"key":"字段数","value":"<N>"},{"key":"可见范围","value":"仅自己可见"}]},{"type":"callout","content":"资源已可问数。接下来可以回「分配权限」「问数」「详情」「操作记录」。"}]}
```

3. 用户接着说哪个就做哪个：

| 用户说 | 动作 |
| --- | --- |
| 分配权限 | `dataops_open_resource_tab({ resource_id, mode: "grant" })` |
| 问数 | 不跳页，给 2-3 个可以问的问题示例 |
| 详情 | `dataops_open_resource_tab({ resource_id, mode: "detail" })` |
| 操作记录 | `dataops_open_resource_tab({ resource_id, mode: "audit" })` |

汇报用文字/表格，不要生成按钮或表单。