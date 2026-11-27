# GenUI docx 引用点击延迟修复：15s → ~2s

## 结论

- **真机（admin pid 21425，已安装 4845，target `http://127.0.0.1:32008`）冷点击首框 1.74–2.05s**，热点击 45–58ms；首框在第 14 页、视口内，`scrollTop=13274 / scrollHeight=19283 / clientHeight=1024`，**不再停在末页**。
- 只 materialize 目标页：`chunkOrdinal=12 → estimate=13 → primary=[14,13]`，先到 14；页面文本层就绪前用 PDF 文本 fast path 出框，DOM 文本层就绪后精修。
- 不再调用 `renderAllPdfPages`，不再扫 19 页；后续页只在窗口未命中时作为正确性回退。
- 同一 doc 的页面文本、已确认块页、chunk provenance 都做了缓存，重复点击直接命中。
- union 蓝框 / amber 命中框 / 官方 `fileLink` chip 样式未改。

## 复现（修复前基线）

修复前安装包（`kb-citation-4845.tgz`，client sha256 `655d93ba…`）在真实 admin 上的点击时间线（`.kb-citation-debug/latency.json`，headless Chrome，1700×1100）：

| 时间 | pages | spans | `.kb-citation-box` | 首框页 | scrollTop |
| --- | --- | --- | --- | --- | --- |
| 0–1s | 0 | 0 | 0 | — | — |
| 2s | 19 | 34 | 0 | — | 11977 |
| 3s | 19 | 400 | 0 | — | 10100 |
| 5s | 19 | 404 | 1 | 14 | 14272 |
| 6.2s | 19 | 488 | 1（首帧视口内） | 14 | 17506 |
| 10s | 19 | 1400 | 1 | 14 | 17506 |

修复前的问题不是“找不到段落”，而是**找到得太晚且路径错误**：

1. `pageSearchOrder` 用 `chunkOrdinal=12` 只估到 13，却扫 11–15 五页；`materializePdfPageText` 先跳到窗口中心（13），再逐页滚 11/12/14/15，每个未加载页 80ms，光 materialize 就 ≥1.2s。
2. `scanDocxPages` 每页只等 160ms；第 14 页的真实文本层在约 5s 才出现，扫描早已跳过它。随后 `rest` 全量扫描 + `highlightDocxQuote` 回退把 19 页又滚一遍，最终停在 17506（接近末页）。
3. 首框绘制发生在所有匹配页扫完之后，使用的是扫描时捕获的 `match.rect`；页面占位高度从 3:4 变为真实 A4 后，框位置过期，首帧在 y=3510（视口外），直到 6.2s 才被 `ensureBoxInViewport` 拉回。
4. 每次点击先 `await sleep(500)`，再等 PDF 预览；query 命中框在首框之前扫描全部 19 页文本层。
5. 无页面文本/块页缓存，重复点击重复付 chunk 请求 + 扫描成本。
6. 用户环境实测约 15s；上面的 5–6s 是本机 headless 软件光栅化的复现值，用户机器更慢。

## 修复后时间线（真机，dev bundle 热替换）

`tests/e2e/genui-timeline.mjs`，点击后 0/500/1000/2000/3000/5000/10000ms：

| 时间 | pages | spans | boxes | 首框页 | 可见 | scrollTop |
| --- | --- | --- | --- | --- | --- | --- |
| 0ms | 0 | 0 | 0 | — | 否 | — |
| 500ms | 0 | 0 | 0 | — | 否 | — |
| 1000ms | 0 | 0 | 0 | — | 否 | — |
| 2000ms | 19 | 308 | 1 | 14 | **是** | 13095 |
| 3000ms | 19 | 406 | 1 | 14 | 是 | 13274 |
| 5000ms | 19 | 406 | 1 | 14 | 是 | 13274 |
| 10000ms | 19 | 406 | 1 | 14 | 是 | 13274 |

首框实际出现在 **1889ms**（timeline 200ms 采样档位；E2E 精确值 1925.6/1984.6/2050.1ms）。首帧是 PDF 文本算出的 589px 高 union 框；3.45s DOM 文本层精修后为 624px 高，位置不变、视口内。

### 阶段耗时（一次代表性冷点击）

```
click 16281
resolved 16283          +2ms      chunk 元数据（缓存命中则 0）
resource-open 16292     +11ms     宿主打开 docx tab
document-tab 16420      +139ms    tab 标题出现，开始 apply
pdf-preview 17720       +1444ms   宿主 PDF 预览挂载（officeToPdf + PDF.js）
pages-shells 17722      +2ms      19 个 page shell
page-plan 17722                   primary=14,13 window=14,13,15
pdf-text-boxes 18181    +459ms    PDF getTextContent(14) 84 items
fast-painted 18184      +3ms      floating union box 589px
first-box-visible 18187 +3ms      视口内
fast-refined 19029      +842ms    DOM 文本层 10 个 match，精修 624px
```

click→首框 **1903ms**（该次 E2E 报 1925.6ms）。剩余大头是宿主 PDF 预览挂载（~1.3–1.5s）与 PDF.js 页面渲染；插件在 page shell 出现后 459ms 拿到文本并立即出框。

## 修复内容

### 1. chunkOrdinal → 目标页窗口（不再扫 19 页）

`src/client/pdf-highlight.ts:549` `planChunkPageWindow`：

- `estimate = chunkOrdinal + 1`（12 → 13）。
- `primary = [estimate+1, estimate]`（14,13），14 先扫。
- `window = [14,13,15]`，只作为首轮窗口；`estimate+2` 是跨页续接保护。
- 已确认块页（缓存）时 `primary=[confirmed]`，直接命中。
- 窗口未命中才 `rest` 回退；回退仍按阅读顺序，保证错误 ordinal 不会漏块。

`src/client/pdf-highlight.ts:503` `materializeTargetPages`：

- 只对 primary 第一页滚一次，等它的 text layer（默认 2600ms；缓存命中 900ms）。
- 邻页只有在 primary 完全没有文本时才单独滚一次；不逐页 materialize 整个窗口。

### 2. PDF 文本 fast path（首框不等 canvas）

`src/client/pdf-highlight.ts:226` `pdfDocumentOf` + `:368` `fastPdfTextBoxes`：

- 从 `[data-pdf-page]` 的 React fiber 上读到 viewer 已经持有的 `PDFDocumentProxy`，调用只读的 `getPage(14).getTextContent()`；实测 84 items / ~459ms。
- 复用 `paragraphCandidates` 的整段 → 句子片段策略；同一页所有命中片段取 union，得到段落范围（不是一行小框）。
- **只读、强 guard**：没有 fiber、没有 `getPage`、worker 超时（900ms + 900ms）都返回 `undefined`，自动回退到原有 DOM text layer 路径；不写 fiber，不改 viewer 状态。

`src/client/pdf-highlight.ts:402` `renderFloatingPageBoxes`：

- 在 `document.body` 下建一个 `position:fixed` 的插件 overlay 层，框用页面当前 rect + PDF 归一化坐标定位。
- viewer 渲染页面时会替换 page surface 的 children，挂在页面内的框会被 React 删掉；固定层在 React 树外，能活到精修完成。
- 滚动/resize 时重定位，页面离开视口时隐藏；20s 安全兜底销毁。
- `keepFloatingVisible`（`:1405`）在占位页高度变化把框顶出视口时只重滚目标页，不做任何其他页扫描。

### 3. 精修与落地

`src/client/pdf-highlight.ts:1559` `highlightDocxChunk`：

- fast path 先出框、滚动到目标页、记录 confirmed page，然后后台 `refineFastPath` 等 DOM text layer；精修用 viewer 自己的 span 几何，画精确 union 框，并只在精确框连续 8×80ms 存活后才销毁 floating 兜底。
- `paintChunkBoxes` 改为把框挂在 page host（而不是 renderer 会替换的 surface children），并用绘制时的 span rect 重新求 union，避免占位高度变化后的过期坐标。
- 首框落地用同步 `scrollToFirstBox` + `ensureBoxInViewport`；`stabilizeFirstBox` 只在框被挤出视口时做有界修正（420ms），**不扫描其他页、不再滚动**。
- 续接框由 `scanRenderedPages`（`:1471`）只读已渲染页，绝不 scroll；实测时间线中不再出现 `page-scroll p13`。
- query amber 命中框只在首框页本地查找；本页没有才 `requestIdleCallback` 全量补扫，永远不抢首框滚动。
- `renderAllPdfPages` 仍保留导出，但 citation 路径已不再调用。

### 4. 缓存

- `src/client/pdf-highlight.ts:150` `clearCitationPageCache`：按 docKey 缓存每页归一化 span 文本，span 数量变化自动失效。
- `rememberChunkPage` / `cachedChunkPage`：块 → 已确认页；重复点击直接 `primary=[14]`。
- `src/client/citation-view.ts:104` `fetchChunkGroups`：成功结果缓存 5 分钟，并合并 in-flight 请求（chip 标签富化与点击共用）；失败不缓存，JWT 刚同步后的首次请求仍会重试。

### 5. 打开 tab 不再盲等 500ms

`src/client/citation-view.ts:379` `waitForDocumentTab`：监听 tab strip 的目标文件名 + active class，tab 一出现就 apply；热 tab 立即返回。`index.tsx` / `compose.ts` / `kb-sources.tsx` 都改为该等待，替换固定 500/400/700ms sleep。

## 验证

### 单元/组件测试

```bash
cd /root/projects/dsh-plugins-plus
node_modules/.bin/vitest run packages/kb-citation/tests
# Test Files 4 passed, Tests 85 passed
```

新增 `tests/pdf-highlight.test.ts` “citation click latency”：19 页容器、page 14 文本层延迟 120ms 到达、`chunkOrdinal=12`，断言首框页 14、耗时 <3000ms、且只滚过 page 14（不滚 page 1、不扫其他页）。

### 真实 admin E2E（热替换 client bundle，不安装/不重启）

```bash
cd /root/projects/dsh-plugins-plus/packages/kb-citation
node tests/e2e/genui-latency.mjs
```

断言：

- cold click→首框 <3000ms；
- cold 首框最终仍在 PDF scrollport 内；
- 首框页 > 1（实际 14）；
- `scrollTop < scrollHeight - clientHeight - 100`（不在末页）；
- 重复点击 <1500ms，且落回同一页。

最近三次：

```json
{ "cold": { "firstBoxMs": 1925.6, "page": 14 }, "warm": { "firstBoxMs": 45.1 } }
{ "cold": { "firstBoxMs": 1984.6, "page": 14 }, "warm": { "firstBoxMs": 50.9 } }
{ "cold": { "firstBoxMs": 2050.1, "page": 14 }, "warm": { "firstBoxMs": 52.0 } }
```

`tests/e2e/genui-bbox.mjs` 继续覆盖 bbox/样式：`boxes=1`、`pages=[14]`、box 575×624、首框在视口（top 276 / bottom 900 / 视口 76–1100）、`scrollTop=13214`、chip 仍是官方 `fileLink` class + paper glyph + muted `:第N块`。该脚本的 `firstBoxMs` 最近为 1742ms。

`tests/e2e/genui-timeline.mjs` 产出 `tests/e2e/artifacts/genui-timeline.json`，即上面的 0/500/1/2/3/5/10s 时间线。

### 环境

- 真机 admin：`dataops-ai-admin-dsh-runtime`，pid 21425，DataOps managed DSH；`/api/ai/workbench/dsh/ensure` 返回 target `http://127.0.0.1:32008`。
- 已安装 `@sparkelf/dsh-kb-citation` = `kb-citation-4845.tgz`（client `655d93ba…`）。
- E2E 通过 Playwright route 只替换 `/plugins/??` 里的 kb-citation 模块；**没有安装新 tarball、没有重启 admin**。
- headless Chrome 148 / 无 GPU；PDF.js canvas 走软件光栅化，页面渲染本身约 0.8–2.2s。真实 GPU 浏览器上这一段会更短；插件在 page shell 出现后约 0.46s 已拿到文本并出框。

## 产物

```bash
cd /root/projects/dsh-plugins-plus/packages/kb-citation
pnpm pack
```

- `sparkelf-dsh-kb-citation-0.1.0.tgz`
- tarball sha256：打包后在交付消息中给出（包内文档不写自身哈希）
- 包内 `lib/client.js` sha256：`45ce5be6c0e7083faaf09685e121def0b57f1f0867610a9e07bd8da0a6bc642c`（旧安装包为 `655d93ba…`）
- 交付副本：`extra-plugins-out/kb-citation/sparkelf-dsh-kb-citation-0.1.0-latency-20261025.tgz`，并同步到同目录 `sparkelf-dsh-kb-citation-0.1.0.tgz`
- 包内新增 `BBOX-LATENCY-FIX.md`。

## 已知边界

- PDF 文本 fast path 依赖 document-preview 的 `PdfPage` 组件把 `PDFDocumentProxy` 放在 fiber `memoizedProps.document`。这是只读、可失败的优化；React/viewer 结构变化时自动走 DOM 文本层路径（正确性不变，冷点击回落到约 3.4–4.0s）。
- 首帧是 PDF 文本算出的归一化 union（589px 高），DOM 文本层就绪后精修为 624px；两者都在 page 14、视口内。若 viewer 的页面占位比例与 PDF 页面比例差异较大，首帧可能有几像素偏差，精修后消除。
- `renderAllPdfPages` 仍作为公开 helper 存在，但 citation 路径不再使用；后续可单独删除。
- 本次没有把 tarball 安装到 admin、没有重启；真机安装后需由部署方复验一次冷点击。