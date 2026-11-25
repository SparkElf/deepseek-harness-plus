# 提案与预览

## 提案格式

```json
{
  "id": "OPT-001",
  "object": "column",
  "resourceId": 12,
  "field": "description",
  "current": null,
  "proposed": "合同签约日期，按自然日",
  "evidence": ["样本值 2026-01-03", "查询高频过滤"],
  "confidence": "HIGH",
  "impact": "LOW"
}
```

## 展示

- 按对象分组：资源 / 列 / 指标 / 血缘。
- 每组最多 10 条；高影响单独列出。
- 低置信度用 warning；不要混在确定项里。
- 用户确认前不 apply。

## 高影响

- 删除/停用资源
- 批量改可见性
- 改指标 sqlFragment
- 删血缘
- 改主键/类型

以上逐项确认，不能批量一键通过。
