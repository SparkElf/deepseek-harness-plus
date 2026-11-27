# @sparkelf/dsh-officecli

## 中文

将官方 OfficeCLI 二进制接入 DeepSeek Harness，并随包提供 9 个 OfficeCLI 官方工作流技能（万相定制版）。安装本包会安装固定版本的 `@officecli/officecli`，模型通过 `officecli` 工具提交结构化 argv，通过 `officecli-create` 从样式包模板创建 DOCX。

### 技能（默认全部注册，source = bundled）

| 技能 | 用途 |
|---|---|
| `word` | 任意 .docx 的创建、读取、修改、校验；中文公文/正式报告强制 GB/T 9704-2012 |
| `excel` | 任意 .xlsx 的创建、读取、修改、公式与图表；万相企业表格模板 |
| `pptx` | 任意 .pptx 的创建、读取、修改；万相企业演示模板 |
| `word-form` | 可填充 Word 表单（内容控件 / FormField / 邮件合并 / 文档保护） |
| `morph-ppt` | 跨页 Morph 平滑动画演示（pptx 场景层） |
| `pitch-deck` | 融资/路演 Pitch Deck（pptx 场景层） |
| `academic-paper` | 学术论文/期刊/学位章节（docx 场景层） |
| `data-dashboard` | 多元素 Excel 经营看板（xlsx 场景层） |
| `financial-model` | 三表/DCF/LBO/敏感性分析财务模型（xlsx 场景层） |

所有技能都带万相交付约束：

- **Word**：中文公文、通知、请示、批复、纪要、函、总结、方案、经营分析报告、数据分析报告必须先用 `officecli-create`（默认 `gbt9704-2012`）；标题方正小标宋简体二号黑色、一级标题黑体三号黑色、正文仿宋_GB2312 三号黑色；禁止 python-docx、docx-creator、office-docx、office 等通用技能。
- **Excel / PowerPoint**：中文微软雅黑、英文 Segoe UI，主色 `#2563EB`，白底，禁止默认 Calibri 与彩虹配色；Excel 表头蓝底白字、PPT 16:9 统一网格与页脚。
- `officecli load_skill <name>` 也会返回本包的定制文本，不会绕过约束加载上游原文。

原始技能来自 OfficeCLI（Apache-2.0），来源与改动见 `NOTICE` / `LICENSE-APACHE-2.0`。

### 工具

`officecli` 执行官方二进制；`officecli-create` 从样式包模板创建 DOCX，默认 `gbt9704-2012`（A4，上 37mm/下 35mm/左 28mm/右 26mm，三号仿宋正文、二号小标宋标题、黑色 Heading 1–6/Title、22 行 × 28 字、奇偶页码）。`--style-pack <name>` 切换（如 `red-header`），`--minimal` 保留官方原始基线。样式包默认目录 `/opt/officecli/style-packs`，可用 `OFFICECLI_STYLE_PACKS_DIR` 覆盖。

本包不渲染预览、不生成中间格式；文档完成后，回复中的原件路径由 Better Sidebar 打开（预览依赖 `@deepseek-ai/dsh-office-kit`，与本包的技能/工具注册无关）。

### PDF 导出（officecli-pdf）

包内 `plugins/officecli-pdf/` 是 OfficeCLI 的 exporter sidecar；DSH 侧 `src/office-kit-bridge.ts` 在 `127.0.0.1` 起回环桥，把 `officecli view <file> pdf --out <file>` 交给 `dsh-office-kit` 的 `convert()`。约束：静态内部 token 无过期、只允许 workspace 内 docx/xlsx/pptx→pdf、≤100MB、600s、并发 2、默认拒绝覆盖；失败明确报错，不 fallback。

## English

Connects the official OfficeCLI binary to DeepSeek Harness and ships nine OfficeCLI workflow skills, customized for Wanxiang delivery. Installing the package pins `@officecli/officecli`; the model submits structured argv through the `officecli` tool and creates DOCX templates through `officecli-create`.

### Skills (all registered by default, source = bundled)

`word`, `excel`, `pptx`, `word-form`, `morph-ppt`, `pitch-deck`, `academic-paper`, `data-dashboard`, `financial-model`.

Every skill carries the Wanxiang delivery rules: Chinese Word documents use GB/T 9704-2012 through `officecli-create` (22 pt FZXiaoBiaoSong black title, 16 pt SimHei black Heading 1, 16 pt FangSong_GB2312 body) and must not fall back to python-docx / docx-creator / office-docx; Excel and PowerPoint use 微软雅黑 / Segoe UI, `#2563EB` as the single accent, and no default Calibri or rainbow palettes. `officecli load_skill <name>` returns the same customized text.

Upstream skills are Apache-2.0; see `NOTICE` and `LICENSE-APACHE-2.0`.