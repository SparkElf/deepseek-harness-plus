# 知识库文档摘要 — 显式生成、原文校验、落库

本参考只做一件事：**把一篇已入库文档的原文，变成可导航的文档摘要 + 章节摘要 + 关键事实，并写回知识库索引。**

它**不是**上传/抽取的一部分。上传、MinerU 解析、FTS 建索引都只建立目录（TOC）和章节结构，`summary` 保持为空。只有用户明确要求摘要，或你在回答广泛/比较类问题前判断需要摘要时，才执行本流程。

> **摘要不是引用来源。** 回答里引用事实时，仍必须使用 `kb_search` / `kb_chunk_get` 返回的原文 `kb://doc/<docId>/chunk/<key>` token。`INDEX.md`、`summary`、`sectionSummary`、`keyFacts` 都不能当 citation。

## 一、什么时候用 / 不用

**用：**
- 用户说「给这篇文档生成摘要」「总结一下制度」「提炼要点」「做一份文档索引」「更新摘要」。
- 用户点名一篇长文档，问题需要先看整体结构（“这份制度主要讲什么”“有哪些章节”“全面梳理”），而 `kb_outline` 返回 `summaryStatus: "missing"`。
- 管理员批量整理知识库后，希望为若干文档补摘要（逐篇执行，不要并发写同一篇）。

**不用：**
- 用户只是问一个具体条款/数字：直接 `kb_search` + `kb_chunk_get`，不要为了回答而生成整篇摘要。
- 文档没有 `.md` 文本副本 / 没有 chunk：先让用户完成解析，不要凭文件名编摘要。
- 用户没有该文档写权限：`kb_outline_save` 会 403；不要绕过权限写索引文件。

## 二、执行流程（必须按顺序）

### 1. 定位文档

用户给了 `kb://doc/<docId>/...` token 时，直接取 `docId`。否则先：

```
kb_search(query="文档标题或主题", topK=10)
```

从命中里确认 `docId` / `path`。不要用 `ls` 逐目录猜。

### 2. 拿目录与章节 id

```
kb_outline(docId=49)
```

返回：

- `summaryStatus`：`missing` 表示还没有摘要；`ready` 表示已有摘要（可能是旧 extractive，也可能是 llm）。
- `summaryKind`：`none` / `extractive` / `llm`。
- `toc`：章/节/条目录，含 `sectionId`、`title`、`level`、`chunkIds`。
- `sections`：每节的 `sectionId`、`sectionPath`、`chunkIds`、`sourceChunkIds`。
- `indexPath`：只读导航副本，不是原文。

如果 `summaryKind === "llm"` 且用户没有要求更新，直接使用现有摘要，不要重复生成。

### 3. 逐章读原文

按 `toc` 的层级，从一级章节开始。对每一章：

1. 取该章的 `sourceChunkIds`（包含子章节）。优先读与本章主题最相关的 chunk，不要假设只看第一个 chunk。
2. 用 `kb_chunk_get(docId=49, chunkId=<id>)` 读取原文。一次读一个 chunk；需要上下文时连续读相邻 ordinal 的 chunk。
3. 对长文档，至少覆盖：每个一级章节的开头 + 含门槛/比例/金额/期限/例外的条款 + 结论/附则。
4. 读的时候记录：这句话来自哪个 `chunkId`。后面 `keyFacts` 必须带这个 id。

也可以 `read /workspace/kb/<path>` 读整篇 `.md` 做交叉核对，但：
- 引用仍用 `kb_chunk_get` / `kb_search` 的 chunk token；
- 不要把 `read` 的行号写成 citation；
- 不要把 `.docx.md` / `.pdf.md` 派生路径当原文路径。

### 4. 生成摘要（由你，当前 agent 完成）

**文档摘要**（`summary`，建议 200–400 字，最多 4000 字符）：
- 说明文档是什么、适用范围、核心结构、最重要的 2–4 条规则/结论。
- 只写你真正读到的内容；不要补背景、不要推断未出现的制度。
- 可以有“本文共 N 章”这类结构描述，但 N 必须来自 `toc` 或原文可核对的事实；**如果不确定，删掉数字**。

**章节摘要**（`sections[].summary`，建议 80–200 字，最多 2000 字符）：
- 每个一级章节一条；需要时再给二级节。
- 用该章节的 `sourceChunkIds` 作为依据；`sourceChunkIds` 必须是 `kb_outline` 给出的该节 chunk 的子集。
- 没把握的章节**宁可不提交**，不要用“本章主要介绍了……”的空话凑数。

**关键事实**（`keyFacts`）：
- 只收门槛、比例、金额、期限、责任主体、例外/但书、审批权限。
- `value` 尽量逐字复制原文句子；`chunkId` 必须是包含这句话的 chunk。
- `fact` 是标签（如“第五条”“表决门槛”），不是新的事实。
- 每条最多 20 条/节；没有就传空数组，不要编。

### 5. 自查（提交前逐条过）

- 每个数字、百分比、金额、日期、条款号，都能在对应 `sourceChunkIds` 的原文里找到。
- 每个主体（董事会/委员会/部门/总经理/公司等）都在原文里出现过；没有把“某部门”写成“财务部”。
- 没有把“可以”写成“必须”，没有把“原则上”删掉。
- 没有把摘要里的推断写成原文结论。
- 不确定的字段直接删掉或留空；**不要为了凑满结构而编造**。

### 6. 调用 `kb_outline_save` 落库

```
kb_outline_save(
  docId=49,
  summary="……",
  sections=[
    {
      sectionId="s49-1",
      headingPath="第一章 总则",
      summary="……",
      keyFacts=[
        { fact: "第三条", value: "……", chunkId: 1234 }
      ],
      sourceChunkIds=[1234, 1235]
    }
  ],
  summaryVersion="optional-label"
)
```

规则：

- `sectionId` 必须来自 `kb_outline`，不能自造；`headingPath` 若填写必须与目录一致。
- `sourceChunkIds` / `keyFacts[].chunkId` 必须属于该文档，且属于该章节。
- 不提交的章节会保留目录结构，但旧摘要会被清空；这是为了让整篇文档的 `summaryKind` 一致为 `llm`。
- 工具会严格校验数字/比例/条款号/主体；返回 `ok:false` 时看 `rejected[]` 的 `field` / `missing`，只修改被拒字段后重试，不要换一种说法绕过校验。
- 失败不会写半成品：校验不通过时 DB 与 INDEX.md 都不会改变。

### 7. 验证

再次调用：

```
kb_outline(docId=49)
```

确认：

- `summaryStatus === "ready"`；
- `summaryKind === "llm"`；
- `summaryVersion` 已更新；
- `sections[].summary` 与 `keyFacts` 是你提交的内容；
- 需要时 `read <indexPath>` 看 INDEX.md 是否同步。

成功结果里的 `written` 会给出 `sections`、`sectionSummaries`、`keyFacts`、`summaryChunks`、`indexPath` 统计。

## 三、常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `rejected[].reason` 含“数字/比例/条款号在 source chunks 中找不到” | 摘要里的数字不在该节原文，或换了单位/写法 | 回到 `kb_chunk_get` 核对；删掉无法核对的数字，或改成原文写法 |
| `rejected[].reason` 含“主体在 source chunks 中找不到” | 编了部门/委员会/角色 | 删除该主体，或改成原文出现的主体 |
| `rejected[].field` 指向 `sectionId` | sectionId 不属于该文档 | 重新 `kb_outline`，只用返回的 id |
| `rejected[].field` 指向 `sourceChunkIds` | chunk 不属于该节 | 用该节 `sourceChunkIds` 的子集 |
| 403 / `forbidden` | 没有该文档读或写权限 | 明确告知用户；不要直接写 INDEX.md 或数据库 |
| `summaryStatus` 仍是 `missing` | 保存失败或没调用 `kb_outline_save` | 看工具返回的 `ok` / `rejected` |

## 四、边界

- **不自动执行**：上传、抽取、`kb_sync`、`kb_index_rebuild` 都不会生成摘要。
- **不在插件内部调 LLM**：摘要由当前 agent 阅读原文后生成；插件只做校验与落库。
- **不覆盖原文**：只写索引侧车（`kb_docs` / `kb_sections` / `kb_summary_chunks` / `kb_summary_fts` / `INDEX.md`），不改源文件。
- **不把摘要当引用**：回答中的每个事实仍要落到原文 chunk token。
- **不跨文档拼摘要**：一篇文档一次保存；不要把别的文档内容写进来。
