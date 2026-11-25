# 元数据写入

## 通道

- 资源/列/血缘：`metadata-governance` + `govern_metadata`。
- 指标：当前无 `govern_metric`；只能提案或走 Metrics API；禁止 SQL 直写 `metrics`。

## 资源

- `chineseName`、`alias`、`remark`、`usageManual`、`catalog`、`tags`、`accessLevel`、`aiVisible`。
- `alias` 是检索别名，不是 SQL 名。

## 列

- `chineseName`、`description`、`dataType`、`nullable`、`isPrimaryKey`、`glossaryTermIds`、`isCommonlyUsed`、`accessLevel`、`aiVisible`。
- 只 patch 既有字段；找不到字段先报告缺失，不新造。

## 指标

- 只写 SQL 片段：`name`、`displayName`、`description`、`sqlFragment`、`enabled`、`accessLevel`、`aiVisible`、`source`。
- `sqlFragment` 是完整表达式，如 `SUM(amount)` 或 `SUM(a)/NULLIF(SUM(b),0)`。
- 不写 `aggregation/baseGrain/grainKeyColumnIds/dimensionColumnIds/aliases/MetricColumn`。
- 指标名与同视图列名不能冲突。

## 血缘

- `sourceResourceId` / `targetResourceId` 必须是真实 resourceId，不能相同。
- 字段映射用真实字段名；推断血缘标 confidence。

## 写入顺序

`search_resources` 查真值 → 模型生成 preview → 用户确认 → `govern_metadata` apply（`confirmed=true`）→ 回读汇报。
