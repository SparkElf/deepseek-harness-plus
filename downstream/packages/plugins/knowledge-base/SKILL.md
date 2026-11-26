---
name: knowledge-base
description: "知识库统一入口：检索、浏览、新建、上传、改名、移动、删除全局 / 部门 / 个人文档；需要整理归档、生成文档摘要、定向向量化或读写知识图谱时，按需加载 references 中的对应流程。Use whenever the user asks about a document in the knowledge base, wants to add or organize files, or asks to summarize, vectorize, or graph the team's documentation."
---

# 知识库 — 增删改查

知识库是一个**共享文档存储**，不是聊天附件、不是临时工作区。用户看到的是他自己的一份视图：`/workspace/kb`（宿主侧 `viewRoot`）。这份视图里的三个顶层文件夹决定了文档的可见范围：

| 文件夹 | 谁能看到 | 用来放 |
| --- | --- | --- |
| `global` | 所有人 | 公司制度、通用规范、全员参考 |
| `department` | 本部门的人 | 部门流程、值班表、本部门台账 |
| `personal` | 只有自己 | 草稿、个人笔记、未定稿调研 |

**新建文档前先想清楚它属于哪一层。** 放错层的后果是可见范围错了，而移动文档需要写权限——用户可能没有那个权限去纠正。

## 何时用

- 用户问知识库里的某份文档、制度、条款、数据，或要求给出处（先检索，引用只用 `citation` token）；
- 用户要新建、上传、改名、移动、删除文档，或问某个文件/目录在哪一层；
- 用户要整理归档、生成文档摘要、定向向量化，或读写知识图谱（按下面的参考进入专项流程）；
- 用户问权限边界、为什么看不到某个文件，或要求把文档放到另一个可见范围。

## 按需加载

主文件负责日常检索、增删改查与权限。专项流程只在需要时读取对应参考，不要一次全读：

- **整理 / 归档 / 层索引**：[references/organize.md](references/organize.md)
- **显式生成文档摘要**：[references/summarize.md](references/summarize.md)
- **定向建立/补齐向量索引**：[references/vectorize.md](references/vectorize.md)
- **知识图谱主题卡与关系文档**：[references/graph.md](references/graph.md)

## 一、查（Agentic RAG：先检索，再验证，最后引用）

知识库检索不是“背答案”，也不是一上来 `cat` 大文件。按下面的顺序工作：

1. **先判断问题形态，再选入口**：
   - **精确事实/单点条款**：直接从 `kb_search(query, topK=10)` 开始。FTS5 + BM25 是主召回与排序路径，支持中文/英文，先按调用者身份和可见范围过滤。不要先查“知识库状态/索引状态”，没有 `kb_status` 工具；状态只由 UI 使用。
   - **广泛/比较/区别/全面/是否类问题**（“有什么区别”“全面梳理”“是否允许”“分别有哪些”）：先用 `kb_outline(docId | citationToken)` 拿目录（章/节/条）和已有摘要；如果 `summaryStatus` 是 `missing`，按需读取 [references/summarize.md](references/summarize.md) 生成摘要，再 `kb_search` / `kb_chunk_get` 读相关章节原文。用户点名了文档或给了 `kb://` token 时直接 `kb_outline`；不知道 docId 时先 `kb_search` 找到文档，再 `kb_outline` 展开，避免只看命中 chunk 就下结论。
   - **摘要只是导航，不是引用**：`kb_outline` 的 `summary`、`kb_search` 的 `sectionSummary` / `docSummary` / `relatedSections` 可能是旧 extractive 或显式生成的 llm 摘要，但**都不是引用来源**；引用必须使用原文 chunk 的 `citation` token。
2. **比较、门槛、比例、金额、日期类问题必须先发 2 个 query 变体，再合并结果**（不要只发一条长句）：
   - 变体 A（精确术语）：把问题里的制度术语直接拼起来，例如“普通决议 特别决议 三分之二 过半数”“董事会 表决 通过 比例”。
   - 变体 B（实体+动作）：例如“董事会 会议 召开 通知 工作日”“三重一大 重大项目 金额 门槛”。
   - 数字/单位同时试常见写法：`5万元` / `50000元`、`3000元` / `3千`。
   - 两个 query 的 hits 按 `citation` 去重合并（不要按 `path + line`）；优先保留同时命中两边的 chunk，再按分数取 topK。
   - **多词 query 返回 0 时不要放弃**：`kb_search` 会自动 relaxation（按 token 逐词搜、去重合并），结果里的 `relaxed: true` / `queries` 会告诉你实际查了哪些词。
   - 如果 relaxation 后仍不足，最多再发 **2 轮**拆词/同义词（如 `普通决议`、`特别决议`、`三分之二`、`过半数`）；**禁止用 `ls` 逐目录翻找答案**，目录列表只用于确认路径/找 `.md` 副本，不是检索手段。
   - 2 轮仍无证据就明确说“资料未提供/知识库没有找到”，不能无限换词，也不能凭记忆补答案。
3. **这些查询优先（或并行）用 `rg` 在 `/workspace/kb` 视图内精确搜索**：查询含 regex 元字符、引号字面量、反引号标识符、错误码、路径、`file:line`，或只有 1–2 个汉字。挂载隔离已保证 agent 只能看到自己的 view，普通 `rg` 就是权限内的，不需要额外封装安全工具。
4. **`kb_search` 0 结果、top score 偏低，或 snippet 不足以回答** → 用 `rg` 做精确/验证兜底。
5. **`rg` 命中很多（>30 行）** → 回到 `kb_search` 收敛排序，或加 `--glob` / 更精确 pattern，不要直接读几十个文件。
6. **引用只用 `citation` token**：`summary` / `sectionSummary` / `docSummary` / `relatedSections` 都不是引用来源，只能用来决定“读哪一章”；每条 hit 都带 `citation: kb://doc/<docId>/chunk/<key>`（`?terms=` 只是查看器高亮提示）。回答里**原样写 `kb://doc/<docId>/chunk/<key>` 这段**（写成行内代码，省略 `?terms=`/`&highlight=` 后缀），**不要**自己写 `:193`、`第N块`、`path:line`，也不要写 `.docx.md`/`.xlsx.md`/`.pdf.md` 这类派生路径。查看器会把 token 渲染成 `文件名:第N块`，点击会打开原文件并定位到该 chunk 的 bbox；正文只需要写条文号（如“第十五条”），位置交给 token。
7. **看到 `kb://doc/<docId>/chunk/<key>` token，必须先调 `kb_chunk_get`**：可以传 `docId` + `chunkId`，也可以直接传 `citation: "kb://..."`；`chunkId` 支持数字 id 或 16 位 chunk_key。返回原文 `path`、`quote`、`heading/paragraphText`、`sheet/cell`、`page/boxes`、`chunkOrdinal`、`snippet`。**禁止**用 bash/sqlite3 查 `.dataops`、`kb-index.sqlite` 或任何内部索引来解析 token；工具不可用就明确说“当前无法解析该引用”，不要逆向内部存储。
8. **需要核对原文时**用通用 `read` 工具读 `/workspace/kb/<view相对路径>`（例：hit `global/制度.md` → `read /workspace/kb/global/制度.md`），但**引用仍然用 hit 的 `citation` token**；不要从 `read` 输出抄行号再拼 `path:line`。二进制文件用 `ls -l` / `stat` 看大小，不要用 `read`。
9. **引用必须选“包含该 claim”的 chunk**：引用前逐个核对 citation chunk 是否同时包含 claim 的实体、条款号/数字/单位；不得用同文档但不含该 claim 的相邻 chunk 凑引用。多个候选时选重叠最高且能覆盖 claim 的 chunk；没有任何 chunk 覆盖时，明确说“资料未提供”，不要编引用。PDF/扫描件的低 confidence 框带 `approximate:true`，回答里说明“近似定位”。
10. **整题最多 3 轮检索**（含 relaxation）：仍无证据就明确说“知识库里没有找到”，不要凭记忆补答案。

### 主检索：kb_search

```
kb_search(query="差旅住宿标准", topK=10)
kb_search(query="reimbursement policy", topK=10)
```

返回 `citation/path/chunkOrdinal/snippet/score`（PDF/扫描件另有 `page/boxes`）；先看 snippet 是否直接回答，再决定是否 `rg` 精确验证或用通用 `read` 读 `/workspace/kb/<path>` 全文。回答里引用时只用 `citation` token。

### 导航：kb_outline

广泛、比较、区别类问题先展开文档结构，再读原文：

```
kb_outline(docId=49)
kb_outline(citation="kb://doc/49/chunk/e63b7f9eda2d86cb")
```

返回 `docId/path/summary/summaryKind/summaryStatus/toc/sections/indexPath`：

- `toc`：章/节/条目录，含 `sectionId`、`title`、`level`、`chunkIds`。
- `sections`：每节摘要 + `keyFacts`（门槛/比例/主体/例外）+ `sourceChunkIds`；**不返回整章全文**。
- `summaryKind`：`none`（尚未生成）/ `extractive`（0.1.9 旧抽取式）/ `llm`（按 [references/summarize.md](references/summarize.md) 生成）。
- `summaryStatus`：`missing` 时摘要为空，`hint` 指向摘要流程（见 [references/summarize.md](references/summarize.md)）；`ready` 才可用摘要导航。
- `indexPath`：`/nas/kb/index/md/<docId>.INDEX.md`，内容与返回值一致，可按需 `read`。
- **上传/抽取不会自动生成摘要**。索引只自动建立目录/章节结构；摘要由摘要流程显式读取原文后生成，并用 `kb_outline_save` 落库。旧 extractive 摘要会保留，显式保存后覆盖为 `llm`。
- 源文件 hash 变化会让旧 llm 摘要失效并在下次同步时清空，需要重新执行技能；chunk id 不变时已有 citation token 继续有效。
- 摘要只用于定位章节；回答里的每个数字、主体、例外仍须回到原文 chunk 核对，引用只用原文 token。

#### 显式生成/更新摘要

当用户明确要求摘要，或 `kb_outline` 返回 `summaryStatus: "missing"` 且问题需要整体理解时，按 [references/summarize.md](references/summarize.md) 执行。流程是：

1. `kb_outline(docId)` 拿 `toc` / `sections` / `chunkIds`；
2. 逐章 `kb_chunk_get(docId, chunkId)` 读原文；
3. 由你（当前 agent）生成 doc summary、section summaries、keyFacts；
4. `kb_outline_save(docId, summary, sections)` 落库；数字/比例/条款号/主体不匹配会被拒绝，不会写半成品；
5. 再 `kb_outline` 确认 `summaryKind: "llm"`、`summaryStatus: "ready"`。

不要为了生成摘要而在插件外直接改 `/nas/kb/index`、SQLite 或 INDEX.md。

### 引用写法

```text
✅ `kb://doc/49/chunk/e63b7f9eda2d86cb`
❌ `[董事会议事规则](kb/global/0911董事会议事规则（试行）.docx.md:193)`
❌ `董事会议事规则.docx:第9块`
❌ `董事会议事规则.docx:193`
```

token 是唯一稳定的引用标识；文件名、第N块、行号都由查看器从 token 解析，模型不要手写。

### 精确兜底：rg（在视图内）

```bash
rg -n "错误码|file:line|反引号标识符" /workspace/kb --glob "*.md" | head -30
rg -n "差旅" /workspace/kb --glob "**/*.md" | head -30
```

**限制**：图片里的文字搜不到；扫描件 PDF 没有 `.md` 副本时 rg 搜不到；`.doc/.xls/.ppt` 老格式可能丢表格结构。搜不到时先确认旁边有 `.md` 文本副本。

### 浏览与读取

```bash
ls /workspace/kb/global/
cat /workspace/kb/global/规范.md
```

根目录用 `ls /workspace/kb` 即返回 global/department/personal 三个桶；搜索框/HTTP search 由 KB 页面使用，AI 侧主检索仍是 `kb_search`。

### 搜索的局限

- FTS5 trigram 对 1–2 个汉字可能没有命中，此时按策略用 `rg`。
- 解析是异步的：上传后立刻搜可能还没有 `.md` 副本；看进度面板的“解析→分块→写索引→完成/失败”。
- 索引在 companion 的 `/nas/kb/index`，不在 agent view；**不要尝试直接读索引文件**，它是实现细节。唯一例外是 `kb_outline` 返回的 `indexPath`（`/nas/kb/index/md/<docId>.INDEX.md`），它是给 agent 读的导航副本；不要把它当原文引用。
- 刚上传/刚解析的文档只有目录结构，`summaryStatus` 为 `missing`；需要摘要时按 [references/summarize.md](references/summarize.md) 显式执行，不要期待 `kb_outline` 自动补摘要。

## 二、增（新建与上传）

### 新建一个文本文件

```bash
cat > /workspace/kb/personal/调研笔记.md <<'EOF'
# 标题

正文。
EOF
```

**路径必须在三个桶之内**，写到 `/workspace/kb/` 根下会落在视图外层、不再受分桶与权限约束。

### 上传现成的文档

用户拖进知识库的 `docx`/`pdf`/`xlsx`/`pptx` 会自动解析出 `.md` 副本。你也可以自己复制文件进来：

```bash
cp /root/projects/报告.docx /workspace/kb/department/运维/
```

**用命令直接复制不会触发解析**，没有 `.md` 副本，grep 搜不到内容。需要检索的文档请走界面上传，或在复制后自行转出文本。

### 文件名的约定

- 中文、空格、括号都能用，但**不要**在文件名里放 `/`
- 以 `.` 开头的文件被视为隐藏文件，不会出现在列表里
- 不要手工编辑 `*.docx.md` 这类副产物：下次上传同名文件会重新生成

## 三、改（改名与内容修订）

```bash
# 改名
mv /workspace/kb/personal/草稿.md /workspace/kb/personal/定稿.md

# 改写内容（整篇替换）
cat > /workspace/kb/personal/定稿.md <<'EOF'
新内容
EOF
```

改名或移动时**保持在同一层内**：跨层（例如 `personal/` → `global/`）等于改变可见范围，需要用户明确同意，且调用者的写权限必须覆盖目标层。

大范围改写前先备份：

```bash
cp /workspace/kb/global/规范.md /workspace/kb/global/规范.md.bak
```

## 四、删（删除与恢复）

**删除是高风险操作，先确认再执行。**

```bash
rm /workspace/kb/personal/废弃草稿.md
```

删除前必须做到：

1. **确认路径**：把完整路径念一遍给用户听，不要凭记忆删
2. **确认归属层**：删 `global/` 里的东西影响所有人
3. **不要用通配符删**：`rm *.md` 在知识库里几乎一定是错的
4. **先想能不能改名保留**：不确定时改名成 `废弃-*.md` 比删除安全

**知识库的回收站目前尚未支持恢复**（功能在设计中）。删除即不可逆，所以：**只要用户没有明确说「删掉」，就不要删。**

## 五、权限

调用者的可见范围由 DataOps 的授权决定，不是你按目录推断出来的：

- 你看得到的文件，是调用者被授权读的文件
- 写、改、删各自需要对应的授权，读权限不等于写权限
- 没有权限时操作会失败——**这是正确行为，不要绕过它**

如果用户要求访问看不到的文档，正确回答是「你没有该文档的权限，需要管理员授权」，而不是去找别的路径读它。

## 六、常见错误

| 错误 | 为什么错 | 正确做法 |
| --- | --- | --- |
| 把文档写到 `/workspace/kb/` 根下 | 脱离三个桶，权限与可见性都不受控 | 先选层，再写进对应文件夹 |
| 用 `rm *.md` 清理 | 知识库不是临时目录 | 明确指定单个路径 |
| 假设 `department/` 里是自己部门的文件 | 目录名是桶名，具体部门在数据层区分 | 以实际列出的内容为准 |
| 上传后立刻检索正文 | 解析是异步完成的，且只对可解析格式生效 | 看进度面板确认“写 FTS5 索引”完成，或确认旁边有 `.md` 副本 |
| 读不到文件就去翻 `/nas/kb` 原始库或索引 | 那是 companion 权威存储/索引，绕过视图等于绕过权限 | 尊重当前视图的可见范围 |

## 七、给用户写操作前的自检

动手改任何东西之前，问自己三句：

1. **这个路径属于哪一层？** 全局、部门、还是个人？
2. **用户明确要求了吗？** 还是我在推测他想改？
3. **改坏了能恢复吗？** 不能的话先备份。

三条都清楚再动手。
