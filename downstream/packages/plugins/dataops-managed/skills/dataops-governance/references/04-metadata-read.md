# 全量平台元数据查询

# Data Warehouse Operations

## Overview

This is a knowledge base, not a flow skill. 本技能是知识库，不是流程。Use it to answer DataOps middle-platform and warehouse metadata questions by querying platform tables through `query_table`, instead of only calling `search_resources` and returning a small resource page.

`search_resources` is useful for semantic lookup and resolving a named resource. For catalog-wide questions, counts, field inventories, lineage statistics, dictionary lookups, or "agent platform has what resources", query the metadata tables directly.

## Permission Boundary

This skill does not grant write access.

- 管理员 / Administrators may create, update, delete, and query middle-platform tables only through approved admin APIs or governance tools.
- 运营人员 / Operators may query middle-platform tables; do not suggest direct INSERT/UPDATE/DELETE/DDL.
- 应用人员 / Application users can see only authorized rows and fields.
- Runtime enforces strong filtering: SQL is parsed/normalized and AST/WHERE conditions are completed automatically for visibility and authorization. Do not remove, bypass, weaken, or contradict injected filters.
- If a query returns no rows, treat it as "no authorized visible data" unless there is evidence of a system error.

`query_table` accepts only `SELECT` or `WITH`. Never use `DESCRIBE`, `DESC`, semicolons, write SQL, or `SELECT *` on wide tables unless the user explicitly asks for all columns.

## Core Tables

| Need | Query these tables | Notes |
| --- | --- | --- |
| Resource list/statistics | `resources` | Uses `id`, `urn`, `resource_type`, `chinese_name`, `source_system`, `source_table`, `database`, `catalog`, `access_level`, `is_enabled`, `ai_visible`, `columns`, `tags`, `row_count`, `data_size`. Runtime adds visibility filters. |
| Field inventory | `resources.columns` JSON plus `data_source_table_column_metadata` | `columns` contains synced field metadata; table-column metadata stores datasource/table/column comments. |
| Lineage | `resource_lineages` joined to `resources` | Use `source_resource_id`, `target_resource_id`, `relation_type`, `status`, `process_name`, `field_mappings`, `ai_visible`. Runtime filters visible lineage. |
| Dictionaries | `dictionaries`, `dictionary_entries` | Use dictionary `code`, Chinese/English names, `status`, entry key/value/order. |
| Glossary/terms | `glossary_terms`, `glossary_term_rule_constraints` | Use `path`, `skill_key`, `ai_visible`, `dictionary_codes`, semantic bindings. |
| Catalog tree | `catalog_nodes` | Use `path`, `type`, `owner`, `owner_dept`, `owner_system`, `access_level`. Runtime filters public catalog scope. |
| Data sources | `data_sources`, `data_source_accounts`, `data_source_account_assignments` | Use for datasource inventory and account assignment status; never expose secrets. Runtime filters enabled datasources. |
| Semantic layer | `semantic_models`, `semantic_model_resources`, `semantic_query_templates` | Use for semantic model coverage, bound resources, reusable query templates, and visible business questions. |
| Resource authorization | `resource_access_grants` | Use only to explain grant facts visible to the caller; do not hand-build an authorization bypass. |

## Query Patterns

Answer "中台有什么资源 / agent 中台有什么资源" with grouped metadata, not a capped resource search:

```sql
SELECT
  source_system,
  resource_type,
  COUNT(*) AS resource_count,
  SUM(COALESCE(row_count, 0)) AS total_rows
FROM resources
GROUP BY source_system, resource_type
ORDER BY resource_count DESC
```

Find resource fields by name:

```sql
SELECT
  id,
  chinese_name,
  source_system,
  source_table,
  columns
FROM resources
WHERE chinese_name ILIKE '%客户%' OR source_table ILIKE '%customer%'
ORDER BY updated_at DESC
LIMIT 20
```

Summarize lineage around a resource:

```sql
SELECT
  src.chinese_name AS source_resource,
  dst.chinese_name AS target_resource,
  l.relation_type,
  l.status,
  l.process_name,
  l.field_mappings
FROM resource_lineages l
JOIN resources src ON src.id = l.source_resource_id
JOIN resources dst ON dst.id = l.target_resource_id
WHERE src.chinese_name ILIKE '%客户%' OR dst.chinese_name ILIKE '%客户%'
ORDER BY l.updated_at DESC
LIMIT 50
```

Query dictionaries and entries:

```sql
SELECT
  d.code,
  d.chinese_name,
  d.english_name,
  e.entry_key,
  e.entry_value,
  e.display_order
FROM dictionaries d
LEFT JOIN dictionary_entries e ON e.dictionary_id = d.id
WHERE d.code ILIKE '%status%' OR d.chinese_name ILIKE '%状态%'
ORDER BY d.code, e.display_order
LIMIT 100
```

Check semantic model coverage:

```sql
SELECT
  m.name AS semantic_model,
  m.domain,
  COUNT(smr.resource_id) AS bound_resources
FROM semantic_models m
LEFT JOIN semantic_model_resources smr ON smr.semantic_model_id = m.id
GROUP BY m.id, m.name, m.domain
ORDER BY bound_resources DESC
```

## Answering Rules

- Ground every catalog, field, lineage, dictionary, and statistic answer in a `query_table` result.
- Prefer aggregate queries for "how many / what kinds / coverage / distribution" questions.
- Prefer explicit columns; large JSON fields such as `columns` and `field_mappings` should be returned only when needed.
- When the user names one business resource ambiguously, use `search_resources` or a narrow `resources` query to resolve candidates, then query platform tables for details.
- Do not expose credentials or encrypted secret fields from datasource/account tables.
- If the user requests changes to metadata, switch to the approved governance capability; this skill itself is reference-only and read-only.

## Common Mistakes

| Mistake | Correct behavior |
| --- | --- |
| Answering "中台有什么资源" by returning 50 `search_resources` hits | Query `resources` with grouping, counts, filters, and representative rows. |
| Treating fields as unavailable because `search_resources` summary is short | Query `resources.columns` or `data_source_table_column_metadata`. |
| Explaining lineage from prose only | Query `resource_lineages` and join `resources` for source/target names. |
| Manually adding weak visibility clauses | Let runtime AST/WHERE strong filtering apply; keep SQL simple and read-only. |
| Using this skill to write platform metadata | Do not write. Use admin APIs or metadata governance tools when authorized. |
