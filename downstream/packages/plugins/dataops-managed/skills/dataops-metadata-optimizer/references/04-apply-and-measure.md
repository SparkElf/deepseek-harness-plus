# 应用与度量

## 应用

- 资源/列/血缘：`metadata-governance` + `govern_metadata`，模型生成 preview → 用户确认 → govern_metadata apply。
- 指标：当前无 `govern_metric`；只能走 Metrics API 或记录 `GAP-METRIC-WRITE`，禁止 SQL 直写。
- 指标只写 SQL 片段：`name`、`displayName`、`description`、`sqlFragment`、`enabled`、`accessLevel`、`aiVisible`。
- 失败按错误合同停止，不重试写操作。

## 度量

优化前后对比：

- 列描述/中文名覆盖率
- 指标覆盖率/重复率
- 检索命中（表/列/指标）
- 问数准确率（有 benchmark 时）
- 查询延迟

## 输出

```text
本轮优化：N 条提案，M 条已应用
覆盖率：x% → y%
问数准确率：a% → b%（如有）
未解决：GAP-...
```
