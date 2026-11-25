# Amber 命中框不显示：0.5px 幽灵框的原因与修复

## 症状

viewer `kb-citation-2269`（client `d73628e1…`，KB `e78f`）上打开旧会话「董事会与经营班子会表决门槛差异」，点击「经营班子会」chip（`kb://doc/49/chunk/1fe09e0dbfb4184d`，docx 第 7 块）：

- 蓝色 chunk union 正常：`.kb-citation-box = 1`，落在第 8 页 `第十五条/第十六条`，视口内。
- 黄色 `.kb-citation-hit` 在 DOM 里有 4–6 个，但**几何是坏的**：内联样式 `left: -948px; top: -94.28px; width: 0.5px; height: 0.5px`。加上 2px 边框后实际绘制为 **4×4px** 的小点，位于整个浏览器视口左上角 `x=0, y=298`（侧栏上），不在文档页内。
- 因此用户看到的只有蓝框，amber 始终“0”。

这不是“没有可匹配词”：同一页文本层里 `董事/经营/班子/表决/通过` 都存在，正确版本可画出 15 个 amber 框。图例节点 `.kb-citation-legend` 始终为 0（按设计已移除）。

## 根因

### 1. 文本层“有文字但尚未排版”时直接取 rect

2269 的 `renderQueryHits` 逐 span 匹配（`span.textContent.includes(term)`），随后 `renderHitBoxes` 无条件使用 `match.element.getBoundingClientRect()`。

PDF.js 的 text layer 会先创建 span 文本、后完成 typeset。在两者之间：

- `getBoundingClientRect()` 返回全 0：`left=0, top=0, width=0, height=0`；
- 于是 `left - parentRect.left = 0 - 948 = -948px`，`top = 0 - 94.28 = -94.28px`；
- `width/height` 被 `Math.max(0.5, 0)` 兜底成 0.5px；
- 2px 边框把盒子撑成 4×4px，固定在视口左上角。

2269 没有任何“rect 是否可绘制”的校验，也没有在文本层排版完成后重绘；`drawn=6 > 0` 反而让重试逻辑认为已经成功。

### 2. 逐 span 匹配会漏掉跨行/逐字切分的词

PDF.js 会把中文按行尾或单字切开；`表决` 两个字可能落在两个 span 里。2269 的单 span `includes` 匹配不到，或者只命中其中一个字，画出 19px 的小框而不是整词。

### 3. 冷启动 Office→PDF 超过旧超时

2269 的 `waitForPdfPreview()` 超时是 **8s**。本机冷转换实测 `文档渲染中` 持续约 9s（ready at 9001ms），第一次点击在 8s 放弃，蓝框也不出现；第二次点击（转换已缓存）才出蓝框。当前源码已改为 20s。

## 修复（本包）

文件：`src/client/pdf-highlight.ts`

1. **可绘制性校验**：新增 `hitBoxPlacement()`，`renderHitBoxes` 只接受 `width > 0 && height > 0` 且落在页面矩形内（±8px）的 span；0×0 的未排版 span 不再生成幽灵框。
2. **按页保留旧框**：`renderQueryHits` 在本页已有框、而本轮只匹配到不可绘制 span 时返回 0 并保留旧框，避免排版过程中 amber 闪烁消失。
3. **重试只看引用页**：`paintAmberHits` 只画 chunk 自己的页；删除了“去其他页找词”的回退。其他页的命中对读者不可见，却会让调用方误判成功。`scheduleAmberRetry` 改为检查目标页是否已有 `.kb-citation-hit`，而不是全文档任意一个。
4. **span 增长重绘**：`scheduleAmberRefresh` 保留，在 700/1800/4000ms 检测文本层 span 数增长后按目标页重画。
5. **页级文本匹配**：`pageTextIndex` + `spansInRange` 把整页 span 文本拼成一个字符串再匹配，跨行/逐字切分的 `表决` 也能命中，并给命中的每个 span 画框。

## 验证

### 单测

```bash
cd /root/projects/dsh-plugins-plus
node_modules/.bin/vitest run packages/kb-citation/tests
# Test Files 4 passed, Tests 102 passed
```

新增两条回归：

- 文本层未排版（span rect 0×0）时 `renderQueryHits` 返回 0 且不生成 `.kb-citation-hit`；
- 已经有正确框时，刷新遇到 0×0 span 不清掉旧框。

### 真机（admin，hotswap client bundle，不安装/不重启）

会话：`董事会与经营班子会表决门槛差异`（6 个 `button[data-kb-citation-token]`）。
点击：`经营班子会` chip → `doc49/chunk/1fe09e0dbfb4184d`（`0911低空公司经营班子会议事规则（试行）.docx` 第 7 块）。

安装版 2269（复现）：

| 点击后 | blue | amber DOM | amber 可见 | legend | 说明 |
| --- | --- | --- | --- | --- | --- |
| 0s | 0 | 0 | 否 | 0 | 冷转换，文档渲染中 |
| 1s | 0 | 0 | 否 | 0 | 同上 |
| 2s | 0 | 0 | 否 | 0 | 页面 shell 出现 |
| 3s | 1 | 6 | **否** | 0 | 6 个框均 `left:-948px/top:-94.28px/0.5px`，实际 4×4 在视口 (0,298) |
| 5s | 2 | 6 | 否 | 0 | 同上；旧版把 chunk 画成 p7/p8 两个 union |
| 10s | 2 | 6 | 否 | 0 | 同上 |
| 15s | 2 | 6 | 否 | 0 | 同上 |

修复版（hotswap `lib/client.js`，client sha256 `5968b2c3…`）：

| 点击后 | blue | amber | amber 页 | 可见 | legend |
| --- | --- | --- | --- | --- | --- |
| 0s | 0 | 0 | — | 否 | 0 |
| 1s | 0 | 0 | — | 否 | 0 |
| 2s | 0 | 0 | — | 否 | 0 |
| 3s | 1 | 0 | — | 否 | 0 |
| 5s | 1 | 0 | — | 否 | 0 |
| 10s | 1 | **15** | **8** | **是** | 0 |
| 15s | 1 | 15 | 8 | 是 | 0 |

另一轮修复版冷点击 `firstHitAt = 5067ms`，同样 15 个 amber、全部在第 8 页、blue=1、legend=0。amber 的出现时间取决于宿主 PDF 文本层排版（约 5–6s），12s 内稳定为 15；蓝框不受影响。

截图：

- 复现（只有蓝框）：`/root/projects/kb-citation-evidence/amber-2269-warm/shot-15000ms.png`
- 修复后（蓝框 + amber）：`/root/projects/kb-citation-evidence/amber-exact-fixed3/exact-viewer.png`
- 修复后整页：`/root/projects/kb-citation-evidence/amber-final-fixed/shot-15000ms.png`

### 验收判据

- 蓝色 union：1 个（第 8 页）。
- 黄色 amber：15 个，全部第 8 页，宽 19–400px、高 19px，视口内可见。
- `.kb-citation-legend`：0。
- 命中词：`董事` 2 处、`经营` 6 处、`班子` 9 处、`表决` 1 处、`通过` 2 处；`门槛` 在该页 0 处（正确，不伪造）。

## 已知边界

- amber 依赖目标页真实文本层；纯图片/扫描页没有可匹配文字，只有蓝框不算 bug。
- Office→PDF 冷转换可超过 8s；本包已把等待上限改为 20s，但首屏仍受宿主转换耗时影响。
- 本次只改 `dsh-plugins-plus/packages/kb-citation`，未安装到 admin、未重启；部署方安装本 tarball 后需复验一次。