# KB 显式摘要技能 — 实现与验证报告

日期：2026-10-25
范围：`dsh-plugins-plus/packages/knowledge-base`（未改 DSH core，未安装生产，未重启服务）

## 1. 目标

上传/抽取/重建索引**默认不生成摘要**；只有显式调用 `kb-summarize` 技能时，由 agent 阅读原文生成
doc/section summary 与 keyFacts，再通过模型工具 `kb_outline_save` 落库。插件内部不调用 LLM。

## 2. 实现

### 2.1 新模型工具 `kb_outline_save`

文件：`src/knowledgeTools.ts`、`src/ftsIndex.ts`、`src/outlineGuard.ts`

输入：

```json
{
  "docId": 49,
  "summary": "文档摘要",
  "summaryVersion": "可选",
  "sections": [{
    "sectionId": "s49-1",
    "headingPath": "第二章 表决",
    "summary": "章节摘要",
    "keyFacts": [{"fact": "第五条", "value": "原文句子", "chunkId": 1234}],
    "sourceChunkIds": [1234, 1235]
  }]
}
```

校验（写入前全部完成）：

- `docId` 必须有对应文档；宿主先检查读权限，再检查写权限（403 由权限层返回）。
- `sectionId` 必须属于该文档；`headingPath` 如填写必须与目录一致；`sourceChunkIds` 必须是该章节
  `sourceChunkIds` 的子集，且 chunk 属于该文档；`keyFacts[].chunkId` 同样校验。
- 数字、百分比、金额、比例、条款号、责任主体必须能在对应 source chunks 中找到：
  - 归一化覆盖全角/半角、中文数字、`5万元`/`50000元`、`百分之三十`/`30%`、`第三条`/`第3条`、
    `三分之二`/`2/3`、`3:2` 等。
  - 主体覆盖董事会/监事会/委员会/部门/公司/集团/总经理等常见责任主体，未在原文出现即拒绝。
- 失败返回 `ok:false` + `rejected[]`（`field`/`reason`/`missing`），**不写 DB 半成品**。
- 写入内容：`kb_docs.summary`、`toc_json`、`summary_version`、`summary_kind='llm'`，
  `kb_sections` 全量行，`kb_summary_chunks` + `kb_summary_fts`，
  以及 `<indexDir>/md/<docId>.INDEX.md`。
- 先写 INDEX.md 再提交 DB；DB 事务失败时恢复旧 INDEX.md，文件写失败则 DB 不变。
- 返回 `written`：`docSummary`、`sections`、`sectionSummaries`、`keyFacts`、`summaryChunks`、`indexPath`。

### 2.2 上传/抽取默认无摘要

文件：`src/index.ts`（Config）、`src/ftsIndex.ts`（sync/ensure）

- 新增配置：`outline.autoGenerate`，默认 `false`。
- `syncIndex` 默认只建 TOC / `kb_sections` 结构，`summary` 为空，`summary_kind='none'`，
  `summary_version='structure-v1:...'`，不写 `kb_summary_chunks`。
- `kb_outline` / `ensureDocumentOutline` 不再自动补抽取式摘要：
  - 返回 `summaryKind`（`none`/`extractive`/`llm`）、`summaryStatus`（`missing`/`ready`）、`indexPath`；
  - `missing` 时返回 `hint: "调用 kb-summarize 技能生成摘要"`；
  - `kb_search` 命中不再携带空 `sectionSummary`/`docSummary`。
- 兼容：
  - 0.1.9 抽取式摘要通过 `summary_kind` 迁移保留为 `extractive`；默认流程不删除、不重算。
  - `outline.autoGenerate=true` 可恢复旧抽取式行为。
  - 显式 `kb_outline_save` 后整篇覆盖为 `llm`；源文件 hash 变化后旧 llm 摘要清空为 `missing`。

### 2.3 第二个 bundled skill `kb-summarize`

文件：`skills/kb-summarize/SKILL.md`、`skills/kb-summarize/i18n/zh.json`、`src/index.ts`

- 触发词：生成摘要、总结文档、提炼要点、更新文档摘要、文档索引等。
- 流程：`kb_outline(docId)` 拿 TOC → 逐章 `kb_chunk_get`/`read` 原文 →
  agent 生成 doc summary + section summaries + keyFacts → `kb_outline_save` → 再 `kb_outline` 验证。
- 明确：摘要不得作为 citation；引用仍用原文 `kb://doc/<docId>/chunk/<key>` token；
  不编造数字/主体；无把握的章节留空或不提交；被拒后按 `rejected[]` 修正，不绕过校验。
- Skill provider `dsh-knowledge-base` 的 `list()` 现在返回两个 candidate：
  `knowledge-base` 与 `kb-summarize`；`get()` 按 candidate 读取对应 `SKILL.md`。

## 3. 测试与验证

命令与结果（2026-10-25）：

```text
cd dsh-plugins-plus/packages/knowledge-base
npx tsc -p tsconfig.build.json --noEmit        # PASS
npm run build                                  # PASS
npx vitest run                                 # 48 files / 962 tests PASS
```

新增/更新的测试：

- `tests/kb-summary-save.spec.ts`（11 个）
  - 默认上传只建 TOC/section，summary 为空、无 summary FTS row、`kb_outline` 为 `missing`；
  - `kb_outline_save` 后 DB/`kb_sections`/`kb_summary_chunks`/`summary FTS`/INDEX.md 全部更新；
  - 数字不匹配拒绝且 DB/INDEX 不变；
  - 外部 `sectionId` / `chunkId` 拒绝；
  - 旧 extractive 保留，显式保存后变为 `llm`；
  - 源文件变化后清空 llm 摘要；
  - 旧 schema 数据库自动补 `summary_kind='extractive'`；
  - skill provider 返回两个 candidate 并各自可读；
  - `outline.autoGenerate` 默认 false / 显式 true。
- `tests/kb-file-tools.spec.ts`
  - 新工具注册；
  - 无写权限 403 且不调用 saver；
  - `ok:false + rejected[]` 原样返回；
  - 成功统计返回；缺少 host seam 时报 `not-configured`；
  - `kb_outline` 的 `summaryKind/summaryStatus/hint` 透传。
- 全量测试 962 个通过（含原有 0.1.9 extractive 测试、FTS、权限、抽取、UI 测试）。

## 4. 出包

```text
packages/knowledge-base/sparkelf-dsh-knowledge-base-0.1.10.tgz
version: 0.1.10
size:    3.1 MB
sha256:  6db66134beb8f9537d432bca3233380a26f1670f45ff9ef7ba2817b60647952e
```

Tarball 已确认包含：

- `package/lib/index.js`（含 `kb_outline_save`、`summary_kind`、`outline.autoGenerate`、`kb-summarize`）
- `package/skills/kb-summarize/SKILL.md`
- `package/skills/kb-summarize/i18n/zh.json`
- `package/lib/types/outlineGuard.d.ts`

**未安装到生产 profile，未重启 DSH / supervisor。**

## 5. 已知边界

- 主体校验使用有限责任主体词表 + 章节来源核对，不替代通用 NER；未列入词表且原文无对应词的
  自造主体可能漏过。数字/比例/条款号与常见主体为强校验。
- INDEX.md 与 SQLite 的跨介质写入采用“先文件、后事务、失败恢复旧文件”的顺序，进程崩溃落在
  两步之间仍可能留下 DB/文件短暂不一致；正常异常路径已回滚。
- `summaryStatus` 只反映文档级摘要是否非空；章节级摘要完整度由 `written.sectionSummaries` 与
  `kb_outline` 的 sections 反映。