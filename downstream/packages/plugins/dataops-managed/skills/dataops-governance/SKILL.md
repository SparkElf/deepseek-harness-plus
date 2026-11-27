---
name: dataops-governance
description: 管理员/超管使用的正常数据治理技能：导入资源、写资源/列/指标/血缘、查全量平台元数据。普通用户问“我的资源/可申请资源”走 dataops-query 的 metadata-query，不用本技能。
---

# 数据治理

## 适用范围

管理员/超管需要：

- 导入表格/Excel/CSV，建成可问数资源；
- 接 OpenAPI/接口文档，导入接口资源；
- 改资源、列、指标、血缘、可见性；
- 查全量平台元数据（不限当前用户授权）。

普通用户不要用本技能；普通用户的受控元数据查询在 `dataops-query/references/metadata-query.md`。

## 硬规则

1. **写元数据只走 `govern_metadata`（apply-only）**：先 `search_resources` 查真实事实，由模型生成 preview，用户确认后调用 `govern_metadata`（`confirmed=true`）；禁止 shell/SQL/Prisma 直写。
2. **指标只写 SQL 片段**：`name`、`displayName`、`description`、`sqlFragment`、`enabled`、`accessLevel`、`aiVisible`；不写 aggregation/grain/dimension/aliases/MetricColumn。
3. **没有 `govern_metric` 就只提案**：不要用 SQL 直写 `metrics`；记录 `GAP-METRIC-WRITE`。
4. **导入与治理分开**：文件导入读 `01-file-import`；接口导入读 `02-api-import`。
5. **不做 Benchmark 特判**：产品技能只按正常用户流程执行。

## 流程

1. 判断意图：导入文件 / 导入接口 / 写元数据 / 读元数据。
2. 读对应 reference。
3. 写操作必须由模型生成 preview + 用户确认 + 调用 `govern_metadata` apply（`confirmed=true`）。
4. 完成后回读并汇报结果；失败按错误合同停止。

## Reference 路由

| 意图 | 读哪个 |
| --- | --- |
| 表格/Excel/CSV 导入 | `references/01-file-import.md` |
| OpenAPI/接口文档导入 | `references/02-api-import.md` |
| 写资源/列/指标/血缘/可见性 | `references/03-metadata-write.md` |
| 全量平台元数据查询 | `references/04-metadata-read.md` |
