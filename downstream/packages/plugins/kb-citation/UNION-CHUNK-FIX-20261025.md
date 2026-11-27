# KB 引用蓝框 union + 结构化分块修复报告

日期：2026-10-25
范围：`packages/knowledge-base`、`packages/kb-citation`
状态：源码已改、测试通过、已出包；**未安装到生产、未重启 DSH**。

## 1. 结论

两个问题是两条独立链路，但都会在“经营班子会议事规则”这一份 docx 上叠加放大：

1. **蓝框先多后合**：`kb_chunk_boxes` 本来就是一行一个提取块；`/api/chunk` 与 `/api/resolve`
   之前把这张表的原始多条直接放在 `boxes` 返回，只有 `unionBoxes` 是并集。真机在跑的
   `kb-citation 0.1.0` 里 `renderBoxHighlights` 还是“逐个 box 画一个 div”，所以点击后先出现
   N 个小蓝框；后续某次重绘/升级才合并成 union。源码 0.1.1 只在 `renderBoxHighlights`
   内部做了 union，API 仍返回原始多条，fast-path 的浮动层也仍是逐框绘制，所以“读的时候就是
   union”并没有真正成立。
2. **分块跨章**：旧 `chunkText` 只按 430 字软目标切，`第X章`/`第X条` 没有硬边界；短块合并还会
   把“章标题块”反向并进上一块。这份 docx 的 `(十五)(十六)(十七)` 正好把字数顶到目标，
   下一块就从 `第三章` 开头继续装 `第七条`，形成用户看到的“列表 15-17 + 第三章 + 第七条”
   同一块。

修复后：**API 读出来就是每页 1 个 union；所有绘制入口首帧就是每页 1 个框**；分块以章/条/
表格为硬边界，430 字只作软约束。

## 2. 诊断证据

### 2.1 蓝框链路

| 层 | 修复前 | 说明 |
| --- | --- | --- |
| 存储 `kb_chunk_boxes` | 一行一个提取块（MinerU block / 段落 / 表格行） | 这是 provenance，不是绘制粒度；`attachProvenance` 按 block 逐条插入 |
| 存储 `kb_chunk_unions` | 每 chunk、每 page 一行（主键 `chunk_id,page`） | 表已存在，`rebuildUnionsForChunk` 会写，但读接口没用它当主字段 |
| `/api/chunk`、`/api/resolve` | `boxes` = `kb_chunk_boxes` 原始多条；另带 `unionBoxes` | 客户端只解析了 `body.boxes`，完全忽略 `unionBoxes` |
| `kb_search` 命中 | 同样返回原始多条 | 模型/查看器拿到的是块级框 |
| `kb-citation 0.1.0`（真机包） | `renderBoxHighlights` 对 `boxes` 逐个建 div | **直接复现“很多小蓝框”**；`0.1.0/package/lib/client.js` 中该函数没有 union |
| `kb-citation 0.1.1`（修复前源码） | `renderBoxHighlights` 单次调用内 union | 只解决“一次调用内多条”，API 仍下发多条；`renderFloatingPageBoxes` 仍逐框建元素 |

真机证据：`packages/kb-citation/sparkelf-dsh-kb-citation-0.1.0.tgz` 解包后的
`lib/client.js` 中，`renderBoxHighlights(pageElement, boxes)` 的函数体是
`for (const [x1,y1,x2,y2] of boxes) { ... appendChild(box) }`，没有任何 min/max 合并。
这与用户“先很多小框、再合并”的观感完全一致：旧包逐框画，后续重绘/新包才画 union。

### 2.2 分块链路

旧 `chunkText`（`knowledge-base/src/ftsIndex.ts`，修复前）：

- `heading` / `clause` 只决定 block 类型，**不触发 flush**；打包循环只在 `chars >= 430` 或
  `chars + size > max` 时切。
- 打包后还有一次“短块合并”：短块会 `chunks[index-1].content += '\n' + chunk.content`，
  也就是把“章标题/条标题”所在的小块**反向并进上一块**。
- 结果：`(十五)(十六)(十七)` 把上一块顶到 430 字后，`第三章 经营班子会议的召集及通知` 成为
  下一块的开头，继续装 `第七条`；docs 的 `第七条` 一段又很长，于是同块里同时出现三者。

修复前真实文档（`rag-eval/extracted/0911低空公司经营班子会议事规则（试行）.txt`）实测：
**9 个 chunk**，其中 `ord=3`（438 字）已含 `第三章`，`ord=4`（493 字）同时含 `第三章` 和
`第七条`，且开头是 `(十五)` 之后的列表续行。

## 3. 修复内容

### 3.1 knowledge-base

- `src/ftsIndex.ts`
  - 重写 `chunkText`（约 L235）：
    - block 类型：`chapter`（`第X章/第X节`）、`heading`（Markdown / `一、`）、`article`
      （`第X条`）、`table`、`list`（`（一）`、`(1)` 等）、`paragraph`。
    - `chapter/heading/article/table` 是结构块：当前块已有正文时，遇到结构块**先 flush**；
      连续标题可以叠在同一块（文档标题 + 章标题、章标题 + 首条），但结构块**永远不会**
      被追加到上一块正文之后。
    - `list` 可并入当前条，但章标题会先 flush，所以列表**不可能跨章**。
    - 430 字是软目标，800 字是超长段落切分上限；表格行、条内列表不拆。
    - 短块合并只在同一 chapter scope 内；以结构块开头的块禁止反向合并。
    - overlap 只在同一 chapter 内、且目标块不是结构块开头时加，避免把上一块文字拼到
      `第三章` 前面。
  - 新增 `unionBoxesByPage`（L93）：按页聚合、输出 `[{page,bbox}]`，保留 `approximate`。
  - `searchIndex`、`readChunkProvenance`：`boxes` 改为每页 1 个 union；`unionBoxes` 与
    `boxes` 同值。`kb_chunks_boxes` 仍保留块级行，不再对外返回。
  - `CHUNKER_VERSION` 从 `structure-v2-keyed` 升到 `structure-v3-keyed`（L759），下次
    `syncIndex` 会重建所有文档。
  - 新增 `kb_chunk_key_aliases`（L733）+ `findChunkId` 别名链（L1429 附近）：
    - 重建时把旧 16 位 `chunk_key` 按文本重叠率映射到新块；重叠率 ≥20% 且共享 shingle
      ≥3 才写别名；过短块要求内容完全一致。
    - 大文档（old×new > 2000）跳过 O(n²)，但仍按“内容完全一致”做线性映射。
    - 旧数字 id 继续走 `kb_chunk_aliases`，并可继续沿 key 别名链最多 8 跳。
    - 文档从索引删除时同时清理数值别名和 key 别名。
- `tests/chunking.spec.ts`：新增“列表 15-17 + 第三章 + 第七条”fixture（5 项全过）。
- `tests/fts-index.spec.ts`：新增 union 契约测试、旧 key 重映射/失效测试。
- `README.md`：补“分块与 bbox 契约”。

### 3.2 kb-citation

- `src/shared/citation.ts`
  - 新增 `unionOfBoxes`、`oneUnionPerPage`：合并同页多框、合并重复 page group。
- `src/client/citation-view.ts`
  - 新增 `groupsFromChunkPayload`：优先读 `unionBoxes`，没有时回退 `boxes` 并在客户端
    union；`fetchChunkGroups` 与 `fetchResolveAt` 共用。
  - `resolveChunkGroups` 对 token 里已有的 `chunkGroups` 也做 `oneUnionPerPage`。
- `src/client/pdf-highlight.ts`
  - `renderBoxHighlights`：先 `unionOfBoxes` 再画，只画 1 个。
  - `renderFloatingPageBoxes`（fast path 首帧）：先把输入 union 成 1 个再建元素。
  - `renderTextMatchBoxes`：改为每页 1 个 union（原来是每个 match 一个框）。
  - `highlightPdfChunk`：先 `oneUnionPerPage(groups)`，重复 page group 也不会画两次。
  - `refineFastPath`：精确 union 已在视口内时立即销毁浮动层，避免同页短暂两个蓝框。
- `tests/sources.test.ts`、`tests/pdf-highlight.test.ts`：新增/更新 union 断言。
- `README.md`：写明“每页 1 个 union”。

## 4. 测试结果

```text
npx vitest run packages/knowledge-base/tests packages/kb-citation/tests
Test Files  50 passed (50)
Tests       1051 passed (1051)
```

类型检查（两个包各自 `tsc -p tsconfig.build.json --noEmit`）均通过。

新增/关键用例：

- `chunking.spec.ts > structural boundaries outrank the character target`
  - `splits list items 15-17 from 第三章 and 第七条 instead of merging all three`
  - `never appends an article heading to the previous body`
- `fts-index.spec.ts > citation box contract`
  - `keeps per-block provenance in storage but serves one union per page`
  - `remaps an old content-keyed citation after re-chunking and expires deleted text`
- `sources.test.ts > fetchChunkGroups`
  - `prefers the API unionBoxes so every page arrives as one rectangle`
  - 旧 payload 两条同页 box → `[[0.1,0.2,0.4,0.5]]`
- `pdf-highlight.test.ts`
  - `paints one union per page even when a legacy payload carries several boxes`

真实文档实测（临时索引，v3）：

- 修复前：9 个 chunk；`ord=4` 同时含 `第三章` 与 `第七条`，前接 `(十五)-(十七)`。
- 修复后：29 个 chunk；`ord=4` 以 `(十五)...(十七)` 结束，`ord=5` 以
  `第三章 经营班子会议的召集及通知` 开头并包含 `第七条`；SQL
  `content LIKE '%第三章%' AND content LIKE '%（十七）%'` 命中 0 条。

> 29 块是“每条一块”的结构化结果，不是目标字数失效：短条（第二条 85 字、第三条 56 字）
> 保持独立，正是用户要求的“条标题不能被并入上一块”。

## 5. 产物（未安装）

| 包 | 文件 | 大小 | sha256 |
| --- | --- | --- | --- |
| knowledge-base 0.1.8 | `packages/knowledge-base/sparkelf-dsh-knowledge-base-0.1.8.tgz` | 3,191,964 B | `edb9ae41236690de4ba96492c2759e1e0ced55e0d7c7865691f67d39fa814c79` |
| kb-citation 0.1.2 | `packages/kb-citation/sparkelf-dsh-kb-citation-0.1.2.tgz` | 148,491 B | `ee8f55ffc7f63622323ddc58d1428d27ace2ccf68d746ac2881fbcef868ca4cf` |

> 包由**当前工作区源码**构建。`knowledge-base` 工作区在本次任务前已存在其他未提交改动
> （workflows、进度面板等），会一并打进 0.1.8 tarball；若发布要求“只含本次 diff”，请在
> 干净基线上重新 `pnpm pack`。kb-citation 目录当前整体未被 git 跟踪，同样以工作区为准。

安装注意（由 lead 执行，本代理未安装/未重启）：

1. 两个包必须**一起**装：只装 KB 会让旧 viewer 继续逐框画（虽然 API 已 union，旧包仍按
   数组逐个画）；只装 viewer 则拿到的是旧 KB 的原始多条，但新 viewer 会兜底 union。
2. KB `CHUNKER_VERSION` 变化后第一次 `syncIndex` 会重建**所有**文档，建议在低峰执行并观察
   索引进度。
3. 旧 token 策略：
   - v2 的 16 位 `chunk_key` 在重建时写入 `kb_chunk_key_aliases`，按文本重叠率重映射；
   - 内容已改写/删除（重叠不足）的 token 解析为 404，前端显示“引用已失效”，不会落到相邻块；
   - 旧数字 id 继续走 `kb_chunk_aliases`，支持多跳；
   - 如果索引库被整体删除后重建（没有旧 chunk 行可对比），无法生成别名，旧 token 一律 404。
4. 回滚：重装旧版本即可；再次 sync 会按旧 `CHUNKER_VERSION` 重建，v2 的 chunk key 是内容
   寻址的，内容未变时原 token 可直接命中。

## 6. 真机验收建议

1. 打开同一会话，点击 `经营班子会议事规则` 的引用。
2. 控制台执行：
   ```js
   document.querySelectorAll('.kb-citation-box').length
   ```
   预期：等于该 chunk 覆盖的页数（通常 1；跨页则每页 1），且点击后首帧就不再出现多个小框。
3. 检查 `POST /knowledge-base/api/chunk` 响应：
   - `boxes.length === unionBoxes.length === 页数`；
   - 同页只有一条。
4. 点开 `第三章` 附近引用，确认蓝框从 `第三章` 开始，不覆盖前面的 `(十五)-(十七)`。

## 7. 已知边界

- 别名是“尽力重映射”，不是永久保存旧引用：文本改动超过阈值即失效，这是刻意的 fail-closed。
- `kb_chunk_key_aliases` 会随每次重建增长；查询按 `(doc_id, old_chunk_key)` 主键，最多 8 跳，
  不影响读路径延迟。
- `renderTextMatchBoxes` 是对外导出函数，语义从“每个 match 一个框”改为“每页一个 union”；
  仓库内无其它调用方，若外部插件依赖逐 match 矩形需自行聚合。
- docx 引用仍依赖 PDF 文本层匹配（不依赖存储 bbox）；分块变细后，单条正文更集中，文本匹配
  的命中率应提高，但不等同于 bbox 精确回填。