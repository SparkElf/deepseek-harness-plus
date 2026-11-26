# 知识库整理 — 分层归类与层索引

把一个知识库目录从「一堆平铺的文件」整理成「按主题分层的文件夹 + 每层一份索引 md」。核心是三件事：**读懂每篇文档在讲什么**、**按内容而不是文件名分层**、**每层留一份能被人和模型直接用的索引**。

整理偏好写在 `kb-organize-preferences.md`：工作区那份是权威，个人知识库里的副本是同步产物。

## 一、开始之前：先读偏好，再问两个问题

### 1. 先读既有偏好（必做第一步）

```bash
cat /workspace/kb-organize-preferences.md 2>/dev/null || echo "NO_PREFERENCES"
```

工作区缺失时读个人库副本（换设备时靠它）。

**个人库副本的路径有两个形态，别混用**——这是同一个文件，但在两个树里名字不同：

| 用途 | 路径形态 | 示例 |
| --- | --- | --- |
| **读**（`read` / `list`）= 视图路径 | `personal/<文件名>`，**不带 uid** | `personal/kb-organize-preferences.md` |
| **写**（`create` / `edit` / `upload`）= 权威路径 | `personal/<uid>/<文件名>`，**必须带 uid** | `personal/260afb31-…/kb-organize-preferences.md` |

```bash
# 读：视图路径，不带 uid
curl -sS -X POST http://127.0.0.1:3080/knowledge-base/api/read \
  -H 'content-type: application/json' \
  -d '{"path":"personal/kb-organize-preferences.md"}'

# 写：权威路径，必须带 uid（uid 从 status 的 caller.userId 取，见第六节）
#   {"relPath":"personal/<uid>/kb-organize-preferences.md", ...}
```

**为什么**：视图里的 `personal/` 已经隐去了 uid（一个用户的视图里只可能有自己的文件），所以读侧带上 uid 会 404；而权威树是所有人共用的一棵树，去掉 uid 就会落到 `personal/` 根下，**写入成功但视图里永远看不到**。这两个坑都实测复现过。

工作区文件是权威：两份都存在且不一致时，用工作区那份，并把差异告诉用户。只有工作区缺失时才采用个人库副本。

读到的偏好决定后面怎么建目录：`分类粒度`、`命名语言`、`已有分类` 三栏直接约束你的分层方案。**不要无视既有分类另起一套**，那会让同一个库出现两套并存的分类。

### 2. 问用户两个问题（一次问完，不要逐条追问）

> 开始整理前，我先确认两件事：
>
> 1. **这批知识有什么背景？** 例如属于哪些业务领域、有没有已知的大类划分、哪些文档必须放在一起、哪些是废弃稿。
> 2. **分类和命名上有什么偏好？** 例如分几层、用中文还是英文、文件夹名偏好（`涉边偷渡类` 还是 `border-crossing`）、索引文件想不想包含摘要。

用户不答或说「你看着办」时，采用**保守默认**并在结果里说明：

| 维度 | 保守默认 |
| --- | --- |
| 层数 | 最多两层（一级大类 + 必要时二级子类） |
| 命名 | 中文、`…类` 或业务名词，不用序号前缀 |
| 归类依据 | 文档正文主题，不按文件名猜 |
| 不确定的文档 | 留在 `待归类/`，不硬塞 |

保守默认要写进偏好文件，下次整理就不必再猜。

## 二、摸清现状：找出所有文档与缺失的索引

### 1. 列出要整理的目录

`list` 每次只返回一层，要逐层展开：

```bash
curl -sS -X POST http://127.0.0.1:3080/knowledge-base/api/list \
  -H 'content-type: application/json' \
  -d '{"path":""}'
```

`path` 用**视图路径**（`global`、`global/子目录`、`personal`、`department`）。省略时列根层，返回三个桶。

返回的 `entries` 里每项有 `relPath`、`name`、`isDir`、`mtimeMs`、`size`。目录项用它的 `relPath` 继续往下列。

### 2. 找出缺 md 文本副本的文档

知识库里 `.md` 是正文本身；`.docx`/`.pdf`/`.xlsx`/`.pptx` 这类原件**上传时**会由插件尝试在旁边生成一份同名 `.md` 副本（`报告.docx` → `报告.docx.md`），检索与阅读都靠它。

判断规则：

- 目录里存在 `X.docx` 但**没有** `X.docx.md` → 该文档缺文本副本
- 缺副本的文档读不出正文，**无法按内容归类**

`list` 返回的 `entries` 只给名字，用名字判断即可：原件扩展名是 `.pdf/.doc/.docx/.xls/.xlsx/.ppt/.pptx/.odt/.ods/.odp/.rtf`，且同目录下没有 `原件名.md`，就是缺副本。

### 3. 补文本副本（能补则补，补不了如实记录）

**唯一会生成 `.md` 副本的入口是 `upload`**：它写原件后调用抽取器。`kb_index` 工具不生成副本（它只重新统计文件数），**不要指望它**。

补副本 = 用 `upload` 重放同一个原件（同名会覆盖原件、重新触发抽取）：

```bash
# 单文件：先取回原件字节，再以 base64 上传
python3 -c "
import base64, json
data = open('/path/to/local/报告.docx','rb').read()
print(json.dumps({
  'relPath': 'global/涉边偷渡类/报告.docx',
  'encoding': 'base64',
  'content': base64.b64encode(data).decode(),
}))" | curl -sS -X POST http://127.0.0.1:3080/knowledge-base/api/upload \
  -H 'content-type: application/json' -d @-
```

响应里的 `extraction` 字段说明结果：

| `extraction` | 含义 | 下一步 |
| --- | --- | --- |
| `{"markdown":"…/报告.docx.md"}` | 补成功 | 重新 `list` 确认副本出现 |
| `{"markdown":"","reason":"no-extractor-succeeded: …"}` | 抽取器都不可用 | 记入「未归类」，不要重试到死 |

**抽取能力取决于部署**：`.pdf` 优先走 MinerU（需要配置 `mineruPort` 且服务在跑），其余格式靠 LibreOffice 或 Python 库。这些都不在时 `reason` 会列出尝试过的抽取器。

补不了副本时**不要卡住整个整理**：把这些文档列进「未归类/」，在最终报告里写清「缺文本副本、当前环境无可用抽取器」。**不要把文件名当内容去猜分类**。

你也可以直接读原件的 `.md` 副本判断内容；如果用户手上就有原文档，让用户重新从界面上传一次是最省事的补法。

## 三、逐篇读内容，归纳主题

### 读一篇文档

```bash
curl -sS -X POST http://127.0.0.1:3080/knowledge-base/api/read \
  -H 'content-type: application/json' \
  -d '{"path":"global/a.md"}'
```

返回 `{"kind":"text","content":"…","truncated":false,"mtimeMs":…}`。`truncated` 为 true 表示只读到前一段，需要换更窄的范围或按小节读。

### 读的时候记什么

每篇至少提炼三样，写进后面的索引：

1. **一句话主题** —— 这篇在讲什么，10-30 字
2. **归属大类** —— 落到哪个主题（`涉边偷渡类`、`经济犯罪类`、`队伍管理类`…）
3. **可复用的辨别信息** —— 文种（方案/通报/台账/讲话稿）、时间、涉及单位

**必须读正文再分类。** 文件名经常不准确（`通知1.md`、`材料(3).md`），只按名字归类等于没整理。内容相近的文档放同一层；一篇跨两个主题时归到**主要用途**那一类，在索引摘要里注明另一面。

### 分类粒度

- 一类**少于 3 篇**就别单独建文件夹，并入相邻类或放 `待归类/`
- 一类**超过 20 篇**才考虑拆二级
- 一级类目建议 3-8 个；超过 10 个说明分得太细，人记不住

## 四、建立分层目录并移动文档

### 路径规则（最容易踩错的地方）

`create` 与 `move` 的 `relPath` 相对**权威树根**，`list` 与 `read` 用**视图路径**。三个桶的目录不一定已经在权威树里建好，所以先建桶再建子目录，**逐级建**（不要指望一次建出多层）：

| 桶 | 写入用的权威路径 | 读取用的视图路径 |
| --- | --- | --- |
| `global` | `global/<类目>/<文件>` | 同左 |
| `department` | `department/<部门码>/…` | `department/<…>`（不带部门码） |
| `personal` | `personal/<uid>/<文件>` | `personal/<文件>`（**不带 uid**） |

`personal` 桶是唯一「写带 uid、读不带 uid」的：视图里的 `personal/` 已经隐去了 uid，所以读侧不要带。写侧少写 uid 会落到 `actual/personal/` 根下，视图映射不到，表现为「写了但看不见」。uid 从 `status` 的 `caller.userId` 取。

```bash
# 1) 建一级类目（桶已存在时跳过）
curl -sS -X POST http://127.0.0.1:3080/knowledge-base/api/create \
  -H 'content-type: application/json' \
  -d '{"relPath":"global/涉边偷渡类","kind":"directory"}'

# 2) 需要二级时再建
curl -sS -X POST http://127.0.0.1:3080/knowledge-base/api/create \
  -H 'content-type: application/json' \
  -d '{"relPath":"global/涉边偷渡类/案件复盘","kind":"directory"}'
```

`create` 返回 `409 a document or folder already exists` 说明该层已存在，继续下一步即可，不要当失败。

### 移动文档

```bash
curl -sS -X POST http://127.0.0.1:3080/knowledge-base/api/move \
  -H 'content-type: application/json' \
  -d '{"from":"global/a.md","to":"global/涉边偷渡类"}'
```

`to` 是**目标目录**，不是完整目标路径。文件名保持不变：`move` 只负责换个位置，不能借它改名（要改名用 `rename`）。返回里的 `delta` 是视图同步结果。

移动前确认：

1. `from` 与 `to` 都要有写权限，否则会 403
2. 同名文件已在目标层时先停下，问用户是否覆盖或改名，不要盲目移
3. 成批移动时**一次一批、每批后校验**，不要一口气移完再检查

### 移动后校验

每一批移动后重新 `list` 目标层，确认文件都在预期位置、源层已清空。视图是授权结果的镜像，`delta` 里 `unlinked` 非空是正常的（旧位置解链）。

## 五、写每层的层索引

### 索引文件名

每层一个固定名字：**`_index.md`**。根层也写一份。

### 索引内容（三段，缺一不可）

```markdown
# 涉边偷渡类

本层收录边境管控、偷渡案件、口岸查验相关的方案、通报与台账，共 12 篇。

## 子条目

| 文档 | 摘要 | 路径 |
| --- | --- | --- |
| 边境管控方案.md | 2026 年边境管控总体方案，含三道防线部署 | 涉边偷渡类/边境管控方案.md |
| 偷渡案件通报.md | 二季度偷渡案件情况通报，含 7 起典型案例 | 涉边偷渡类/偷渡案件通报.md |

## 子目录

- [`案件复盘`](案件复盘/_index.md) — 5 篇案件复盘与复盘纪要

---

更新于 2026-10-21
```

要求：

- **本层简介**：一段话说清这一层收什么、为什么这些放一起
- **子条目**：每篇一行，`摘要` 是一句话（不是文件名重复），`路径` 用**本层内的相对路径**
- **子目录**：链接指向下一层的 `_index.md`，写清那层收什么、多少篇
- **更新时间**：`更新于 YYYY-MM-DD`，每次重写都要改

### 怎么写

用 `create` 写；已存在则用 `edit` 覆盖（`create` 遇到已存在会 409）：

```bash
curl -sS -X POST http://127.0.0.1:3080/knowledge-base/api/create \
  -H 'content-type: application/json' \
  -d '{"relPath":"global/涉边偷渡类/_index.md","content":"# 涉边偷渡类\n\n…"}'
```

内容较长时用文件传参更稳（见下节），避免 shell 转义问题。

**顺序很重要**：先移完这一层所有文档，再写这一层的索引。否则索引里的路径会指向还没移过去的文件。

### 根层索引

整理完成后，在整理根写 `_index.md`，列出所有一级类目与总数：

```markdown
# 知识库总索引

共 3 个类目、48 篇文档。

| 类目 | 篇数 | 说明 |
| --- | --- | --- |
| [涉边偷渡类](涉边偷渡类/_index.md) | 12 | 边境管控、偷渡案件、口岸查验 |
| [经济犯罪类](经济犯罪类/_index.md) | 21 | 涉税、非法集资、传销 |
| [待归类](待归类/_index.md) | 15 | 尚未确定归属 |

---

更新于 2026-10-21
```

## 六、记录整理偏好

偏好文件：`/workspace/kb-organize-preferences.md`（**权威**），个人库副本 `personal/kb-organize-preferences.md`（同步产物）。

写入时机：用户回答了那两个问题之后、以及整理结束时（把这次实际采用的方案固化下来，下次直接复用）。

```bash
cat > /workspace/kb-organize-preferences.md <<'EOF'
# 知识库整理偏好

更新于 2026-10-21

## 背景先验

- 本库主要覆盖涉边偷渡与经济犯罪两类业务
- 每周新增通报，月度台账独立成册

## 分类偏好

- 粒度：两层（一级大类 + 必要时二级）
- 命名：中文、以「类」结尾
- 已有分类：涉边偷渡类 / 经济犯罪类 / 队伍管理类
- 未定归属：放 `待归类/`，不硬塞

## 索引偏好

- 每层 `_index.md`，含简介 + 子条目表 + 更新时间
- 摘要写一句话主题，不复述文件名
EOF
```

同步到个人库。**写用权威路径，必须带调用者的 uid**——`create`／`edit` 的 `relPath` 相对权威树根，少写 uid 会落到 `actual/personal/` 下、视图里看不到：

```bash
# 取 uid（视图树只显示 personal/，权威树才带 uid）
UID_KB=$(curl -sS -X POST http://127.0.0.1:3080/knowledge-base/api/status \
  -H 'content-type: application/json' -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["caller"]["userId"])')

python3 -c "
import json
print(json.dumps({
  'relPath': 'personal/$UID_KB/kb-organize-preferences.md',
  'content': open('/workspace/kb-organize-preferences.md').read(),
}))" | curl -sS -X POST http://127.0.0.1:3080/knowledge-base/api/create \
  -H 'content-type: application/json' -d @-
```

`create` 报 `already exists` 时改用 `edit`：

```bash
python3 -c "
import json
print(json.dumps({
  'relPath': 'personal/$UID_KB/kb-organize-preferences.md',
  'content': open('/workspace/kb-organize-preferences.md').read(),
}))" | curl -sS -X POST http://127.0.0.1:3080/knowledge-base/api/edit \
  -H 'content-type: application/json' -d @-
```

写完用**视图路径**校验一遍，两处都读得到才算同步成功：

```bash
curl -sS -X POST http://127.0.0.1:3080/knowledge-base/api/read \
  -H 'content-type: application/json' \
  -d '{"path":"personal/kb-organize-preferences.md"}'
```

两处内容保持一致。工作区那份是权威：先写它，再同步副本。

## 七、收尾与汇报

整理完成后向用户报告：

1. **分类结果**：建了哪些层、每层多少篇
2. **移动清单**：哪些文件从哪移到哪（移了很多时给汇总，不要逐条刷屏）
3. **未归类**：`待归类/` 里有什么、为什么没能归类（缺文本副本、内容不明、跨类）
4. **偏好**：这次用了什么默认、写在哪个文件
5. **下一步建议**：需要用户确认的分类、需要补材料的文档

## 八、边界与红线

- **只整理，不删内容。** 不调用 `trash.remove`。要删先问用户
- **不跨桶移动。** `global` / `department` / `personal` 之间移动等于改变可见范围，必须用户明确同意且两侧都有写权限
- **不改文档正文。** 整理只动位置和新增索引文件，不改原文（`edit` 只用来写 `_index.md` 和偏好文件）
- **不猜权限。** 403 是正确结果，报告「该路径需要写权限」而不是绕过
- **大库分批。** 超过 50 篇时按类目分批处理，每批结束汇报进度，不要静默跑很久
- **整理前先确认范围。** 「整理知识库」可能指整个库，也可能只指某个目录。范围不明时先 `list` 根层，把看到的结构给用户，让他指定范围

## 九、本参考的安装位置（维护者读）

本文件是 `knowledge-base` 技能的整理流程参考，随 `@sparkelf/dsh-knowledge-base` 包发布：`knowledgeBaseSkillProvider()` 注册 `knowledge-base` 主技能，主技能用 `references/organize.md` 链接到这里。不要再单独创建 `kb-organize` 技能或软链接，也不要在 profile 的 `cordis.patch.yml` 里手工挂载。
