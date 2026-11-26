# 新建表计划（createTable）

新建资源时，你根据 `dataops_collect_preview` 返回的 `preview.columns` 自己生成 `createTable` JSON，再交给 `dataops_collect_validate_plan` 校验。DataOps 会按同样的规则规范化表名、列名、类型和注释，并返回可直接展示的 `plan.createTable` / `plan.createSql`。

## 一、输入从哪来

`preview` 的关键字段：

| 字段 | 含义 |
| --- | --- |
| `sessionId` | 本次导入会话 id，后续校验/执行都带上 |
| `columns[].key` | 源列 id，形如 `c1` / `c2`；`createTable.columns[].sourceKey` 必须用它 |
| `columns[].header` | 原始表头，用来写 `chineseName` / `comment` |
| `columns[].normalizedName` | 后端推断的英文名，可作 `name` 的参考 |
| `columns[].inferredType` | 后端推断类型，可作 `dataType` 的参考 |
| `columns[].sampleValues` | 样例值，用来判断金额、日期、编号等语义 |
| `rowCount` / `columnCount` | 行数、列数，用于汇报 |

`dataSources` 给出可写目标：`urn`、`name`、`dbType`、`databaseName`。用户选定后，把 `urn` 作为 `data_source_urn`。

## 二、JSON 结构

```json
{
  "tableName": "store_sales_detail",
  "tableChineseName": "门店销售明细",
  "tableComment": "门店销售明细，由表格导入生成",
  "columns": [
    {
      "sourceKey": "c1",
      "name": "store_name",
      "chineseName": "门店名称",
      "dataType": "TEXT",
      "nullable": true,
      "comment": "门店名称"
    },
    {
      "sourceKey": "c2",
      "name": "sales_amount",
      "chineseName": "销售额",
      "dataType": "DECIMAL",
      "nullable": true,
      "comment": "销售额（元）"
    }
  ]
}
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `tableName` | 是 | 英文小写 `snake_case`，字母开头；不要中文、空格、连字符 |
| `tableChineseName` | 建议 | 面向用户的中文表名 |
| `tableComment` | 建议 | 中文表说明；缺省时后端按中文表名生成 |
| `columns` | 是 | 每个源列恰好一条；`sourceKey` 必须来自 `preview.columns[].key` |
| `columns[].sourceKey` | 是 | 源列 key，例如 `c1` |
| `columns[].name` | 是 | 英文小写 `snake_case`，字母开头 |
| `columns[].chineseName` | 是 | 中文字段名，用于展示 |
| `columns[].dataType` | 是 | 只能是 `TEXT` / `BIGINT` / `DECIMAL` / `DOUBLE` / `DATETIME` / `DATE` / `BOOLEAN` |
| `columns[].nullable` | 否 | 默认 `true`；主键/必填业务字段可设 `false` |
| `columns[].comment` | 否 | 字段说明；缺省时用 `chineseName` |

**不要生成 `id` 字段。** DataOps 会强制追加 `BIGINT` 自增主键 `id`。`createSql` 只用于展示和人工复核，执行时只需要 `createTable`。

## 三、命名规则

1. 表和字段统一英文小写 `snake_case`：`store_sales_detail`、`sales_amount`。
2. 字母开头；数字开头会被后端加 `f_` 前缀。
3. 不用数据库保留字（`order`、`group`、`select`、`table` 等）；需要时改成 `order_no`、`group_name`。
4. 中文表头翻成稳定的业务英文名，不要拼音缩写堆叠；拿不准时用 `field_1` 这类可读兜底名也可以，但要同步写清 `chineseName`。
5. 不同源列不要生成同一个 `name`；后端会给重复列名加 `_2`，但计划里最好一次写对。

## 四、类型规则

| 源数据特征 | `dataType` | 说明 |
| --- | --- | --- |
| 整数、编号、计数 | `BIGINT` | 电话、身份证、订单号等“编号”即使全是数字也优先 `TEXT`，避免丢前导零 |
| 金额、单价、比例（需要精确小数） | `DECIMAL` | 后端按 `DECIMAL(18,4)` 建列 |
| 普通小数、度量值 | `DOUBLE` | 精度要求不高时使用 |
| 日期（只有年月日） | `DATE` | |
| 日期时间、时间戳 | `DATETIME` | |
| 布尔、是否 | `BOOLEAN` | |
| 文本、混合、无法判断 | `TEXT` | 默认类型 |

判断顺序：先看 `sampleValues`，再看 `inferredType`，最后才用列名猜。金额/数量类列不要用 `TEXT`；日期列不要用 `TEXT`。

## 五、校验调用

```text
dataops_collect_validate_plan({
  session_id,
  data_source_urn,
  create_plan_json: JSON.stringify(createTable)
})
```

不要同时传 `target_schema` / `target_table` / `mappings_json`。

成功返回形状：

```json
{
  "success": true,
  "session": { "sessionId": "...", "file": {}, "columns": [], "rowCount": 12000 },
  "plan": {
    "mode": "CREATE_TABLE",
    "targetSchema": "wanxiang_demo",
    "createTable": { "tableName": "...", "tableChineseName": "...", "tableComment": "...", "columns": [] },
    "createSql": "CREATE TABLE ..."
  }
}
```

后续汇报和执行只使用 `plan.createTable`；`plan.createSql` 可以用来给用户看建表语句，但不要塞进 execute。

## 六、校验失败怎么改

| 错误 | 处理 |
| --- | --- |
| `create_plan_json is required` | 补 `create_plan_json` |
| `columns[i] needs sourceKey/name/chineseName/dataType` | 按 `preview.columns[].key` 补齐四件套 |
| `... must be valid JSON` | 修 JSON 语法；字符串里不要带 Markdown 代码围栏 |
| `... must be a JSON object` | 传对象，不要传数组或纯字符串 |
| HTTP 404 `表格导入会话不存在或已过期` | 重新 `dataops_collect_preview` 上传同一文件 |

修正后重新调用 `dataops_collect_validate_plan`，直到成功；不要拿未校验的 JSON 去 execute。

## 七、追加时的 mappings 结构

追加到已有表不使用 `createTable`，而是传映射数组：

```json
[
  { "sourceKey": "c1", "targetColumn": "store_name" },
  { "sourceKey": "c2", "targetColumn": "sales_amount" }
]
```

- `sourceKey` 必须来自 `preview.columns[].key`；
- `targetColumn` 必须是目标表真实存在的列名；
- 一条源列、一条目标列都只能出现一次。

目标表字段清单、必填列和校验返回的 `missingRequiredTargetColumns` 处理见 [`append.md`](append.md)。