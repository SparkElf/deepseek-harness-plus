# GenUI docx 引用：bbox 不出现、滚到末页，以及 fileLink 原生样式

## 结论

- **A（bbox）已修复**：`kb://doc/51/chunk/e63b7f9eda2d86cb` 在真实 GenUI 卡片里点击后，原 `.docx` 文档页出现 **1 个 `.kb-citation-box`（第 14 页）**，首框在视口内（box top 275.6 / viewport 76–1100），`ibPYqW_scrollport` 停在 `13452 / 19521`，**不再滚到末页**。
- **B（样式）已修复**：GenUI 的 `V1MMBW_inlineFileLink` 现在复用官方 `MarkdownFileLink` 的 `fileLink` class 列表，图标使用官方 `PaperDocGlyph` 路径；蓝色链接、500 字重、静止态无下划线、hover 虚线 3px 下划线均与官方一致；只有 `:第N块/行` 后缀是 muted，且为独立 `inline-block`，不会被父级 hover 下划线覆盖。**没有任何自定义 W/X/PDF 色块 badge。**

## 复现环境

- 真实 admin：DataOps managed DSH，`/knowledge-base/api/chunk` 返回 doc 51 / chunk `e63b7f9eda2d86cb`，`paragraphs:1`、`boxes:0`、`unionBoxes:0`，源文件 `.docx`（19 页 PDF 预览）。
- GenUI 会话：`董事会与经营班子会表决门槛差异`，卡片里 `[打开原文](</workspace/kb/global/rag-eval-fixtures/0911南宁低空投资有限责任公司董事会议事规则（试行）.docx>) · kb://doc/51/chunk/e63b7f9eda2d86cb`。
- 调试方式：Playwright 在浏览器侧把 `@sparkelf/dsh-kb-citation/client.js` 替换成新构建产物；**没有安装/重启 admin**。

## A：根因

1. **`highlightDocxChunk` 无条件把搜索页限制在 `[1, 2]`**。docx chunk 没有页码，代码却默认目标页是前两页；该 chunk 实际在第 14/15 页，因此段落匹配必为 0。见修复前 `pdf-highlight.ts` 中 `const targetPages = input.pages === undefined || input.pages.length === 0 ? [1, 2] : input.pages`。
2. **quote 回退只做“单 span 内包含”匹配**。docx→PDF 的文本层每个 span 是一小段（`第七条`、`董事会`、`每`、`年度`…），`findPdfTextMatches` 用 `span.textContent.includes(quote)` 永远匹配不到跨 span 的整句。
3. **回退调用 `renderAllPdfPages()` 把 19 页全部滚一遍，最后停在末页**；匹配失败后也没有恢复滚动位置，于是用户看到 `14552 / 19460`。
4. **命中的 query 高亮抢走了视口**：绘制完 chunk box 后又优先 `scrollToFirstHit`，把视口带到 quote 命中处，而不是首框。
5. **未排版的页也会生成 0.5px 垃圾框**：页 15 的 span 已存在但 surface 尚未 layout 时，union 宽高为 0，旧逻辑会画出负偏移的 0.5px box。

## A：修复

文件：`src/client/pdf-highlight.ts`

- **跨 span 段落匹配**：保留并强化 `findChunkParagraphMatches`（按页拼接 span 后 `indexOf`），把整段拆成句号/问号/分号片段；整段跨页时句子片段仍能在单页命中。
- **不再默认 `[1,2]`**：有 `pages` 或 `paragraphs[].page` 才限制页；否则搜索全部已挂载页。
- **按 chunk ordinal 先搜一个窗口**：`pageSearchOrder` 用 `chunkOrdinal` 估一个起始页（本例 12 → 13），先扫 `11–15`；窗口内按阅读顺序扫完、不提前停，避免窗口前部误命中遮住真正的页。窗口没有结果再扫剩余页，保证正确性。
- **只加载需要的页**：`materializePdfPageText` 跳到待搜页中心，让 `IntersectionObserver` 的 `rootMargin: 100%` 顺带加载邻页；只有仍未加载的页才单独滚一次。19 页全扫从 ~8s 降到本例 ~3s 出框。
- **scroll 可恢复**：记录原始 `scrollTop`；命中后滚到**首框**并 `ensureBoxInViewport` 校验；完全未命中则恢复原位置。`highlightDocxQuote` 也改为跨 span 匹配 + 恢复滚动，不再调用 `renderAllPdfPages`。
- **首框优先**：先画 chunk box，再画 amber query hit；最后滚动的是 `.kb-citation-box`，query hit 只做辅助标记。
- **过滤退化框**：union 宽高非有限或 ≤ 0（页面尚未 layout）时不画框，避免负偏移 0.5px box。
- `applyCitationView` 把 `citation.chunkOrdinal` 传入 `highlightDocxChunk`，让窗口估计生效（`src/client/citation-view.ts:342`）。

关键位置：`pdf-highlight.ts:124`（materialize）、`:714`（paint）、`:769`（quote 回退）、`:816`（pageSearchOrder）、`:837`（chunk 主流程）、`:275`（ensureBoxInViewport）。

## B：fileLink 原生样式

文件：`src/client/link-label.ts`

- 删除旧的 W/X/PDF badge 生成逻辑与内联色值/下划线；不再写 `style` 属性。
- `nativeFileLinkClasses` 从同一卡片里已渲染的官方 `MarkdownFileLink` 复制 `fileMention` / `fileLink` class；找不到时由 `kb-citation-file-link` 提供等价 CSS。
- `citationIcon` 直接使用 ui-primitives `LinkIconArtwork` 的官方 `PaperDocGlyph`（document）和 `PaperGlyph`（other）路径，`1.1em`、`margin-right:5px`、`vertical-align:-.25em`，与 `.linkIcon` 一致。
- CSS 镜像官方 `.markdown a, .fileLink`：`color: var(--dsw-alias-link)`、`font-weight:500`、静止态 `text-decoration:none`、hover/focus 为 `underline dotted` + `text-underline-offset:3px`；focus-visible 使用官方 focus ring token。
- `:第N块/行` 后缀单独 `span.kb-citation-suffix`：`var(--dsw-alias-label-tertiary)`、`font-weight:400`、`display:inline-block`（父级下划线不会盖住后缀）。

关键位置：`link-label.ts:316`（native class）、`:335`（CSS）、`:384`（官方 glyph）、`:405`（chip 渲染）。

## 验证

### 单元/组件测试

```bash
cd /root/projects/dsh-plugins-plus
node_modules/.bin/vitest run packages/kb-citation/tests
# 4 files, 84 tests passed
```

新增覆盖：

- `tests/pdf-highlight.test.ts`：无页码 hint 的 late page（第 14 页）仍出框；跨 span quote 出 1 个 union box；query hit 不再抢走首框滚动。
- `tests/sources.test.ts`：原生 `fileLink` class 复制、官方 paper glyph、无 badge、无内联 style、muted suffix。

### 真实 GenUI 卡片 E2E

```bash
cd /root/projects/dsh-plugins-plus
node packages/kb-citation/tests/e2e/genui-bbox.mjs
```

脚本用 Playwright 打开真实 admin 的 GenUI 会话（默认 `http://127.0.0.1:3098/`），只热替换 kb-citation 客户端 bundle，然后：

1. 断言 chip 有 `kb-citation-file-link` + 官方 `fileLink` class、paper icon、无 badge、无内联 style、静止态无下划线、suffix 颜色不同于主链接；
2. 点击 chip，等待 `.kb-citation-box`；
3. 断言首框有真实宽高、页码 > 1、与 `.scrollport` 视口相交、`scrollTop < scrollHeight - clientHeight - 100`。

最近一次结果：

```json
{
  "ok": true,
  "chip": {
    "className": "kb-citation-file-link kb-citation-inline o3BgMG_fileLink",
    "text": "0911南宁低空投资有限责任公司董事会议事规则（试行）.docx:第13块",
    "token": "kb://doc/51/chunk/e63b7f9eda2d86cb",
    "icon": true,
    "badge": false,
    "color": "rgb(122, 170, 255)",
    "fontWeight": "500",
    "textDecoration": "none",
    "suffixColor": "rgb(173, 178, 184)",
    "styleAttribute": null
  },
  "viewer": {
    "boxes": 1,
    "pages": [14],
    "box": { "top": 275.6, "bottom": 899.7, "left": 1041.2, "right": 1616.6, "width": 575.4, "height": 624.1 },
    "view": { "top": 76, "bottom": 1100, "left": 936, "right": 1700 },
    "scrollTop": 13452,
    "scrollHeight": 19521,
    "clientHeight": 1024
  }
}
```

### 截图

- 修复前：`tests/e2e/artifacts/before-viewer-no-box.png`（0 box，末页第四十二条）
- 修复后：`tests/e2e/artifacts/genui-viewer-box.png`（第 14 页 1 个蓝框，视口内）
- 修复前 chip：`tests/e2e/artifacts/before-chip.png`（无图标、自定义下划线）
- 修复后 chip：`tests/e2e/artifacts/genui-chip-native.png`、`after-chip-zoom.png`

## 产物

- `@sparkelf/dsh-kb-citation-0.1.0.tgz`（`pnpm pack` 生成，含新 `lib/client.js`）
- `GENUI-BBOX-FIX.md`（本文件）
- 测试脚本 `tests/e2e/genui-bbox.mjs` 与截图目录 `tests/e2e/artifacts/`

## 部署说明

本次**没有**把 tarball 安装到 admin、没有重启 admin。由父代理/部署方在合适窗口安装并重启后生效；当前验证是通过 Playwright 路由热替换客户端 bundle 完成的。

## 已知边界

- `chunkOrdinal` 只是起始页的启发式；窗口未命中会自动回扫剩余页，正确性不依赖估计准确。
- 页面 surface 尚未 layout 时该页的框会被跳过（而不是画 0.5px 垃圾框）；等页面可见后再次点击会补上。这与“至少 1 个框、首框在视口”的目标一致。
- `highlightDocxQuote` 的全文回退仍可能比窗口路径慢（没有 chunkOrdinal 时从中间页开始）。