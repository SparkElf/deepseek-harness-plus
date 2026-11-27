# 追加到已有资源（字段映射）

追加 = 把当前表格写进一张已经存在的表。你负责生成 `[{sourceKey,targetColumn}]` 映射，DataOps 校验目标列是否存在、是否重复、必填列是否缺失。

## 一、先确定目标，再用 MCP 读目标列

1. 会话里有 `resource-ref` 块时，它就是目标提示：

```resource-ref
{"kind":"dataops-resource","resourceId":123,"name":"门店销售明细","table":"dwd_store_sales"}
```

块里没有 `resourceRef` / urn 时，用 `name` / `table` 去下面的 `search_resources` 检索。

2. 用 DataOps 问数 MCP 检索目标资源：

```text
mcp__dataops__search_resources({
  query: "<资源名或表名>",
  kinds: ["TABLE"],
  limit: 5
})
```

从返回的 `candidates[]` 里选：`resourceRef`（表资源 urn）、`displayName`、`kind`、`queryable`。候选多于一个时用编号文字清单让用户确认；不要凭资源名猜 `resourceRef`。

3. 用 `resourceRef` 读取目标列与执行信息：

```text
mcp__dataops__describe_resource({
  resourceRefs: [resourceRef],
  include: ["columns", "execution"]
})
```

返回 `resources[0]`：

- `columns[]`：每个字段的 `name` / `dataType` / `nullable` / `chineseName` / `sampleValues`。**这是唯一可用的目标列清单，`targetColumn` 只能从这里取。**
- `execution`：`dbType` / `database` / `schema` / `table`。用它确定 `target_schema` / `target_table`：优先 `execution.schema`；为空时 Doris / MySQL 可用 `execution.database`，PostgreSQL 仍需向用户确认 schema。

4. MCP 工具不可见、没有 candidate / `resourceRef`，或 describe 返回“不存在或当前用户不可见”时：

- 让用户粘贴目标表字段清单或 `CREATE TABLE` 语句；
- 或改成“新建资源”；
- **禁止**凭记忆、命名习惯或相似表猜 `targetColumn`。

> `dataops_collect_resources` 只能帮忙找资源名，不提供列信息；它不能替代 `describe_resource` 的列目录。

## 二、映射 JSON

```json
[
  { "sourceKey": "c1", "targetColumn": "store_name" },
  { "sourceKey": "c2", "targetColumn": "sales_amount" },
  { "sourceKey": "c3", "targetColumn": "sale_date" }
]
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `sourceKey` | 是 | `preview.columns[].key`，例如 `c1` |
| `targetColumn` | 是 | `describe_resource` 返回的 `columns[].name`，必须是目标表真实列名；大小写不敏感，DataOps 返回目标表里的规范拼写 |

规则：

1. 生成映射前先确认 `columns[]` 已拿到；没有列清单就不要生成 mappings。
2. 一条源列最多映射一次，一条目标列最多被映射一次；重复项会被后端丢掉。
3. 自增主键、数据库默认值列、无需导入的列可以不映射。
4. 语义优先：金额对金额、日期对日期、编号对编号；不要为了“多映射几列”硬凑。
5. 目标表非空且无默认值的列必须映射，否则校验会返回 `missingRequiredTargetColumns`，此时不能执行。
6. 源表有、目标表没有对应语义的列，可以留在 `unmappedSourceColumns` 里，并在汇报时说明。

## 三、校验调用

```text
dataops_collect_validate_plan({
  session_id,
  data_source_urn,
  target_schema,
  target_table,
  mappings_json: JSON.stringify(mappings)
})
```

不要同时传 `create_plan_json`。

成功返回形状：

```json
{
  "success": true,
  "session": { "sessionId": "...", "columns": [], "rowCount": 12000 },
  "plan": {
    "mode": "EXISTING_TABLE",
    "targetTable": { "schema": "wanxiang_demo", "table": "dwd_store_sales", "columns": [] },
    "mappings": [
      {
        "sourceKey": "c1",
        "sourceHeader": "门店名称",
        "targetColumn": "store_name",
        "targetDataType": "text",
        "nullable": true,
        "confidence": "MEDIUM"
      }
    ],
    "unmappedSourceColumns": [{ "key": "c9", "header": "备注" }],
    "missingRequiredTargetColumns": []
  }
}
```

- `plan.mappings` 是规范化后的映射；execute 时要传它（只保留 `sourceKey` / `targetColumn`）。
- `unmappedSourceColumns` 要在计划里告诉用户哪些列不会写入。
- `missingRequiredTargetColumns` 非空时禁止 execute；先补映射或让用户确认目标表是否允许为空。

## 四、汇报追加计划

用表格 + 文字，不要生成按钮/表单：

> 准备把这份表追加到 `wanxiang_demo.dwd_store_sales`：匹配 12 个字段，3 个源列不写入，目标表必填列已全部覆盖。

```dsh-ui
{"title":"追加计划","items":[{"type":"keyvalue","pairs":[{"key":"去向","value":"追加到已有资源"},{"key":"目标表","value":"<schema>.<table>"},{"key":"映射","value":"<N> 个字段"}]},{"type":"table","columns":["原表头","目标字段","目标类型"],"rows":[["<原表头1>","<目标字段1>","<类型1>"],["<原表头2>","<目标字段2>","<类型2>"]]}]}
```

确认无误请回复「确认」或「开始吧」；要改映射直接说，我会重新生成映射并重新校验。

## 五、校验失败怎么改

| 错误 / 返回 | 处理 |
| --- | --- |
| `mappings_json is required for EXISTING_TABLE` | 至少提供一条有效映射 |
| `target_schema is required when target_table is set` | 补目标 schema |
| `目标表不存在：<schema>.<table>` | 让用户确认 schema/表名，或重新选资源 |
| `没有可用字段映射` | 检查 `sourceKey` 是否来自 `preview.columns[].key`、`targetColumn` 是否真实存在 |
| `missingRequiredTargetColumns` 非空 | 补映射；补不上就说明原因，不要执行 |
| HTTP 404 `表格导入会话不存在或已过期` | 重新 `dataops_collect_preview` 上传同一文件 |