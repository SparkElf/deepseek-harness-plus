# 知识库向量化 — 定向、可预估、不改变引用

本参考只做一件事：**对用户明确指定的一篇文档或一个目录下的文档，建立或补齐向量索引。**

它**不是**默认检索行为。`retrieval.vector.enabled` 关闭时 `kb_vectorize` 会明确报错，不会静默降级；设置页的“重建向量索引”是对全库的显式操作，需要管理员确认。

> **向量只影响召回，不改变引用。** 回答仍使用 `kb_search` / `kb_chunk_get` 返回的 `kb://doc/<docId>/chunk/<key>` token；摘要、outline、citation 都不因向量化而改变。

## 一、什么时候用 / 不用

**用：**
- 用户说「给这篇文档做向量化」「给这个目录建向量索引」「补齐向量」「kb-vectorize」。
- 用户点名的目录需要递归处理其下文档。

**不用：**
- 用户只是问一个具体条款/数字：直接 `kb_search` + `kb_chunk_get`。
- 用户没有明确指定文档或目录：不要自动对全库执行；先问清楚范围。
- 目标文档不可读：工具会跳过并报告，不要绕过权限。

## 二、执行流程

### 1. 先 dryRun 预估

```
kb_vectorize(docId=49, dryRun=true)
```

或目录：

```
kb_vectorize(path="department/data-platform", dryRun=true)
```

dryRun 只枚举目标文档和 chunks，不调用 embedding provider、不写 `kb_embeddings`。把 `wouldEmbed`、`skipped`、`denied` 报告给用户。

### 2. 执行向量化

确认范围后去掉 `dryRun`：

```
kb_vectorize(docId=49)
kb_vectorize(path="personal/归档/制度", rebuild=true)
```

- 默认只补缺失/过期向量（chunk 内容 hash 或 model 变化才重做）。
- `rebuild=true` 重做目标范围内所有当前 chunk；不要用它来代替 dryRun。
- 目录递归；无读权限的文档跳过并在 `denied` 中报告，其他文档继续。
- 单篇失败不会写半成品，`documents[].error` 给出原因；其他文档不受影响。

### 3. 报告

告诉用户：处理了多少文档、embedding 了多少 chunk、跳过多少、失败多少，以及是否还有 `denied`。不要把向量化说成“摘要/索引已重建”；FTS 索引和 citation 不受影响。
