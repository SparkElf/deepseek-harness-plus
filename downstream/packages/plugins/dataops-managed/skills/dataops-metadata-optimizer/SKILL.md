---
name: dataops-metadata-optimizer
description: 用户要求优化元数据、补标注、让 AI 自己发现数据规律、提升问数准确率或速度时使用；扫描资源/列/指标/血缘，提出有证据的标注改进，preview 后 apply，并对比前后效果。
---

# 元数据优化

## 适用范围

用户说“优化一下元数据”“让 AI 自己看看这个库”“把标注补全”“提升问数准确率/速度”时使用。

不适用：

- 只导入数据 → `dataops-governance` 的 import reference；
- 只改单个字段 → 直接走 `govern_metadata`；
- 只问数 → `dataops-query`。

## 核心原则

1. **少问多做**：先自己盘点、采样、发现规律，再给少量高价值提案；不要一开始就让用户逐条解释。
2. **每个提案必须有证据**：样本值、查询、血缘、命名、数据分布；低置信度必须标记。
3. **写入走正常治理通道**：`govern_metadata` / 指标写入；禁止 shell/SQL/Prisma 直写。
4. **Metric 是 SQL 片段**：只保留 name、displayName、description、sqlFragment、enabled、accessLevel、aiVisible；不做 aggregation/grain/dimension/aliases/MetricColumn。
5. **分批**：一次最多 10 个提案；高影响（删除、隐藏、批量可见性）单独确认。
6. **优化前后可量化**：覆盖率、检索命中、问数准确率、查询延迟；能测则测，不能测说明缺口。

## 流程

1. **盘点**：资源/列/指标/血缘覆盖，空描述、命名冲突、重复指标、未使用列。
2. **发现规律**：枚举、日期、金额、ID、地域、状态、join key、view/base 关系、查询高频列。
3. **生成提案**：对象、字段、当前值、建议值、证据、置信度、影响范围。
4. **preview**：按影响分组展示；用户确认后 apply；高影响逐项确认。
5. **apply**：走 `govern_metadata` / 指标写入；失败按错误合同停止，不绕过。
6. **度量**：对比优化前后的覆盖率、检索命中、问数准确率/延迟；记录本轮改动。

## 停止条件

- 找不到真实 resourceId/字段；
- 提案没有证据，或置信度低且用户未确认；
- 写入工具不存在（如指标工具）；
- 已冻结/只读；
- 用户未确认 preview。

遇到以上情况：停止写入，输出提案清单、缺口和已完成项。

## Reference 路由

| 需要做什么 | 读哪个 |
| --- | --- |
| 盘点与基线 | `references/01-inventory.md` |
| 发现规律 | `references/02-pattern-catalog.md` |
| 生成/展示提案 | `references/03-proposal-and-preview.md` |
| 应用与度量 | `references/04-apply-and-measure.md` |
