# @sparkelf/dsh-knowledge-base

DeepSeek-Harness knowledge base: a left-sidebar destination, Settings configuration, and
index tooling over a mounted directory. Runs standalone or against a DataOps backend.


## 记忆图谱（0.2.0）

图谱的权威拓扑从可见文件夹移到 `<scope>/.graphs/<graphId>/graph.json`：节点正文留在普通
分类目录，frontmatter 携带 `id/type/title/authority/internalizable/origin/reviewStatus`；
关系正文放在 `.graphs/<graphId>/links/`。旧 `<scope>/知识图谱/` 文件树仍会被扫描，但响应里
标记 `format=legacy`、`readOnly=true`；迁移工具见 `scripts/migrate-graphs.mjs` 和
`docs/migration-knowledge-graphs.md`（在 dataops 仓库）。

- 权限：普通成员看本部门非私有；部门管理员看本部门及下级；管理员/超管看管理范围；
  private 仅 owner。加载器在 Host 侧按 `canReadPath` 逐图谱门禁。
- 个人绑定：`users/<id>/bindings/*.yaml`，`pending / subscribe / internalize`；
  subscribe 是实时读源的代理，不复制正文；internalize 是独立个人分支。
  守护会话用 `runGuardianPass` 或 `scripts/memory-guardian.mjs` 手动运行。
- 红线：`authority: redline` 或 `internalizable: false` 在 Host 侧拒绝内化（节点与关系都
  继承端点策略），只能订阅；运行时注入带 `nonOverridable` 标记。
- AI 标签：`origin` / `reviewStatus` 在图谱行与选中条显示 `[AI 生成]` / `[已审核]` / `[红线]`。
- 摘要变更：`src/summaryIndex.ts` 提供 sha256 快照、确定性父目录链 dirty 和只重算 dirty 文档的
  入口；`src/summaryWriteback.ts` 已接到索引流程，把 changed/added/removed 文档的确定性摘要写回
  `kb_docs`/SQLite 并按需重写 `index/md/<docId>.INDEX.md`（LLM 摘要不降级，快照最后原子写入）。
- 运行时工具：`memory_context` 实时返回订阅代理、内化分支、调用者自己的当前个人记忆、本部门/全局已晋升的共享记忆和红线（`nonOverridable`）；
  `memory_guardian_run` 手动跑一次守护会话（需 `kb:config:manage`）。插件同时注册一条常驻
  系统提示指令，要求模型在依赖部门口径/流程/红线时先调用 `memory_context`。
- 图谱写入：`kg_get/kg_add/kg_set/kg_del` 对 `format: 'graph-json'` 的图谱读写
  `.graphs/<id>/graph.json` 与节点 frontmatter，validator 失败回滚，删除只移入 `_trash`。
- 文档级徽标：legacy 图谱的文档行与 topic 卡也显示 `[AI 生成]` / `[已审核]` / `[红线]`。

## 个人记忆（0.3.0）

- 五类记忆：`preference` 偏好、`pitfall` 踩坑、`episodic` 情景、`fact` 事实、`sop` 技能草稿；隐私维度 `normal/private/sensitive/secret`，`secret` 只存 `credentialRef`，不存明文。
- 存储：`个人记忆图谱/记忆日志/YYYY-MM-DD.md`、`偏好.md`、`踩坑.md`、`事实.md`、`SOP/<slug>.md`；写入同时更新 `.graphs/personal-memory/graph.json`，图谱页可见。
- 触发：普通会话空闲 30 分钟后调 `memory_guardian_send`；压缩时监听 `compaction/start` 发消息；每日 dream。没有插件队列/空闲 cron，消息投递本身就是队列。
- 守护会话用标准模式（不新增 preset），由 `users/<uid>/guardian.json` 记录 sessionId，懒创建；它读 `memory` 技能并加载 `references/guardian.md`，子代理分别加载 `references/extract.md` / `references/sop-evaluate.md`。
- 写入工具：`memory_record`（仅守护会话）写五类记忆；`memory_promote_sop` 把有效 SOP 晋升为 `$DSH_HOME/skills/<slug>/SKILL.md` 并删除 SOP。
- 运行时读取（0.6.2）：记忆开启时 `memory_context` 直接读调用者自己的 `MemoryStore` 当前条目（偏好/踩坑/事实/SOP/情景），与 bindings 按 id/内容去重；`sensitive`/`secret` 不进入模型上下文，只留在记忆页。
- 暂停语义（0.6.3）：暂停时不注入个人条目、个人图谱和 personal internalized 副本；部门/全局订阅、共享记忆和红线（`nonOverridable`）仍生效。

## 记忆设置（0.6.0）

- 记忆页同时管理开关和整理间隔：`memoryEnabled` 与 `consolidationIntervalMinutes`
  （默认 60，允许 15–1440 的整数分钟）。
- 设置仍写在 `<usersRoot>/<userId>/settings.json`，0.6.0 写入 `version: 2`；旧版
  `{version:1,memoryEnabled}` 或手写 `{memoryEnabled}` 继续可读，缺失/损坏的 interval
  回退 60，不会改变用户已经明确选择的开关。
- 保存走一次 tmp+rename 原子写：`memory.save-settings` 接受 `enabled` 和/或
  `consolidationIntervalMinutes`，只保存间隔时保留开关。`memory.settings` 返回
  `enabled`、`consolidationIntervalMinutes`、`intervalMin`、`intervalMax`、
  `intervalDefault`。
- 首次读取默认：只有 `/auth/me` 的 `permissions` 含配置项
  `memoryDefaultEnabledPermission`（默认 `kb:config:manage`，DataOps 中仅超管/管理员）
  的主体才默认 `memoryEnabled: true`；其他新用户仍为 paused。默认只在没有 settings 文件
  时生效，用户显式关闭写入的 `false` 永远优先。KB 包本身不硬编码角色名；部署可把该配置
  指向更严格的权限键，或设为空字符串关闭管理员默认。
- guardian/tool/trigger 与页面共用同一个默认策略；页面请求把本次请求已经解析的权限投影
  直接传给 store，避免重复调用 DataOps。
- `consolidationIntervalMinutes` 本轮只做校验、持久化和展示。现有触发模型是
  idle/compaction/dream，没有按该间隔运行的调度器；把 interval 接到 dream/外部调度属于
  下一阶段，不在本轮偷偷加一个 cron。

### 未完成项（2026-11-18）

- **Guardian**：`memory_context` / `memory_guardian_send` / `memory_guardian_run` 代码路径
  已存在；本轮补了 30s 的会话解析/投递上限（`GuardianTimeoutError`，code=unreachable），
  避免守护会话卡住时普通会话工具调用无限等待。守护会话模型回合本身的耗时仍由 DSH agent
  运行时决定，本轮未重新跑完整 AI guardian E2E。
- **SOP→技能**：`memory_promote_sop` 只有守护会话工具入口；它把有效 SOP 写成
  `$DSH_HOME/skills/<slug>/SKILL.md` 后删除 SOP。该路径与下节的「记忆晋升到部门/全局」
  是两件事，本轮未给前者增加产品页入口。
- **部门/全局晋升**：已由 0.6.1 的 `memory.promote` / `memory.promotions` /
  `memory.review-promotion` / `memory.shared` 落地（见下节）；撤回/降级、跨部门迁移和
  技能归属策略仍未做。

## 记忆晋升与部门/全局可见性（0.6.1）

- 产品 API：`memory.promote` 把调用者**自己的**一条普通隐私记忆（含 SOP）晋升到
  `department:<code>` 或 `global`。
- 权限：全局目标要求 `kb:config:manage` + 平台管理员；部门目标要求该部门在
  `review.departments` 内（部门管理员即可，不需要 `kb:config:manage`）。DataOps 的
  `canWrite` 仍是目标路径的最终权威，投影与后端不一致时只会更窄。
- 审核：默认创建 `pending` 记录，由**另一位**审核人通过；提交人自批返回 403
  `SELF_APPROVAL_FORBIDDEN`。管理员可用 `confirm: true` 走「显式确认」直接生效，审计
  记为 `confirmed`，与审核通过区分。
- 隐私：仅 `privacy: normal` 可晋升；`private`/`sensitive`/`secret` 直接拒绝
  （`PRIVACY_NOT_PROMOTABLE`），不会被降级后共享。
- 落盘：通过后写 `<scope>/记忆共享/<promotion-id>.md` 并登记
  `<scope>/.graphs/shared-memory/graph.json`；部门/全局列表按现有 KB 读写权限过滤，
  响应中不含 `sourceUserId`、session id 或个人来源标签。
- 队列：`<actualRoot>/.memory/promotions.json`（v1），记录 actor、source memory、target
  graph、审核人、时间与逐步 audit。
- UI：记忆页显示每条的「待审核/已晋升/已拒绝」状态；有审核权限时显示晋升审核队列
  （自批按钮禁用并说明）；「部门和全局记忆」为只读表，不出现个人记忆的查看/纠正/忘记操作。

## 共享记忆运行时注入（0.6.3）

- `memory_context` 读取本部门链（`department/<chain>`）和 `global` 的
  `.graphs/shared-memory/graph.json`，把 `记忆共享/<id>.md` 作为 `mode: shared` 条目注入，
  不需要 binding。其他部门 scope 不会加载，`canViewGraph` 再按部门可见性拒绝。
- 只注入 `privacy: normal/private` 且 `reviewStatus` 不是 `draft` 的共享文档；`sensitive`/`secret` 不进入模型上下文。
- 共享条目保持文档的 `authority`（晋升写 `advisory`），排序低于 redline/canonical；
  预算先丢共享/情景条目，红线永不丢。与 bindings、个人记忆按 id + 标题/正文指纹去重。
- 读取前分别对 `global` 和本部门 scope root 调一次 DataOps `canRead`，与
  `memory.shared` 列表使用同一个权限门。共享图缺失/损坏按空处理，不影响个人与红线。
- 暂停个人记忆时共享记忆仍注入；个人 `MemoryStore`、personal 图谱和 internalized 副本
  不注入。
- 兼容：个人记忆文件、`settings.json` v1/v2 和既有 `memory.list` 契约不变；晋升是复制，
  原个人记忆保留。

## 两种部署形态

同一个包，一份代码，由**有没有配置 `baseUrl`** 决定跑哪种形态。这不是一个运行期开关，
而是部署事实：`baseUrl` 为空就是个人版。

### 个人版（`baseUrl` 未配置）

一个操作者，一个本地目录，**没有任何 DataOps 依赖**。

**能做：**
- 新建 / 编辑 / 重命名 / 复制 / 移动 / 删除文档与目录
- 上传文件并自动提取 Markdown（MinerU 地址取本插件 `mineruBaseUrl`，或按 `mineruPort` 推导）
- 目录浏览、全文搜索、预览
- 收藏、置顶、视图模式、回收站、审计记录——都是本地文件，不依赖后端
- 模板的读写

**不能做（因为没有可询问的权威）：**
- **没有成员与账号体系**：不知道「我是谁」，只有一个固定的 `local` 身份
- **没有权限控制**：路径不按用户隔离；唯一的限制是「不能越出知识根目录」
- **没有共享配置**：没有管理员可以下发地址，MinerU 地址要自己填
- **没有授权与共享**：不能把文档授权给别人，也看不到别人的共享
- **没有成员目录**：无法列出用户 / 角色 / 部门作为授权对象
- **没有组织树**：视图只有一个平铺层级
- **不读取共享 OCR 地址**：不调用 `GET /api/ocr/config`，只用本插件自己的配置

**边界仍然存在：** 所有路径都相对知识根目录，`..`、绝对路径、NUL 字节一律拒绝并给出原因
（`checkLocalPath`）。「没有权限体系」不等于「没有边界」。

### 团队版（`baseUrl` 已配置）

装到 DataOps 工作区里的形态，行为与之前一致：账号、按路径授权的读写、共享 MinerU 地址、
成员目录、共享配置、按用户隔离的视图（`/nas/kb/views/<userId>` 符号链接到 `mountPoint`）。

路径校验、上传、提取、搜索、预览这些核心链路两种形态共用同一份实现——区别只是权限判据
从「问后端」变成「查本地边界」。

## 写入即入库（0.4.3）

写入不是「字节落盘」就结束。`kb_file_write` 和 create/edit/upload/approve 路由在写成功后都走
`afterDocumentWrite`：

- PDF/DOCX/XLSX/PPTX 等可提取格式：进入 extractionQueue，worker 写出 `<source>.md` 后再 chunk +
  index；工具结果返回 `extraction` 任务句柄，用 `extract.status` 查终态。overwrite 会先删掉旧
  的派生 `.md`，避免文档继续按旧正文被检索。
- Markdown/TXT/CSV 等文本格式：直接增量 index，结果返回 `index: {status, docId, chunks, indexedAt}`。
- `kb_file_write` 支持 `encoding:"base64"`，因此 AI 可以写真正的 PDF/DOCX/XLSX 字节，而不是把
  二进制当文本写坏。
- 只有两种结果：`indexed`（可检索，带行号）或 `pending-extraction`/`indexing`（异步进行中）。
  写成功但索引失败只作为状态返回，不回滚文件。

`kb_sync`/`views.sync` 不再把 view 里的「未注册文件」直接删掉：带写权限的文件先
`adoptViewFile` 导入 `actualRoot`（copy + hardlink 回 view），再补 extract/index；无写权限或与
authoritative 同名冲突才按原逻辑 unlink。这修的是「AI 用 shell cp 把 PDF 放进 view，extract 报
no such document，下一次 sync 把文件清掉」的原因。

## 工具按权限披露

模型看到的工具清单由 `src/toolDisclosure.ts` 的协调器决定，不在每个 `execute()` 里重复查
权限树。策略按组划分：

| 组 | 工具 | 要求 |
| --- | --- | --- |
| `read` | `kb_search`、`kb_chunk_get`、`kb_outline`、`kb_outline_rewrite`、`kb_vectorize`、`workflow_list` | `kb:file:read` / `workflow:read`，具体到工具 |
| `write` | `kb_file_write`、`kb_file_move`、`kb_file_delete`、`kb_file_mkdir`、`kb_file_extract`、`kb_outline_save` | `kb:file:write` / `kb:file:delete` / `kb:file:extract`；`kb_outline_save` 同时要求读和写 |
| `manage` | `kb_config_get`、`kb_config_update`、`kb_grant_list`、`kb_grant_set`、`kb_audit_list`、`kb_review_list`、`kb_review_decide`、`kb_sync`、`kb_index_rebuild`、`workflow_unpublish`、`workflow_review_*` | 对应的 manage / audit / review / config 权限，或审核/超管能力 |
| `publish` | `workflow_publish`、`workflow_update` | `workflow:publish`；`visibility=global` 仍在调用内检查 `workflow:review:global` |

披露点（都是插件已有的权限读取位置，没有新增每调用查询）：

- 插件初始化：个人版用本地全权上下文同步注册；团队版异步读取 `/api/ai/review/context`，
  读到之前不注册任何工具（fail-closed）。
- `status` 路由：页面每次加载本来就会读一次权限上下文，这里把同一个上下文交给协调器，
  不额外请求后端。
- 带权限映射的 `/knowledge-base/api/*` 路由：路由门禁已经读到的上下文同时刷新工具面。
- `credentials/reference-updated`：DataOps 令牌指向的凭据更新时重新同步。

**已知缺口：** DataOps 目前没有「角色变更」推送事件。角色在后台变化、但令牌未更新时，
工具面要到下一次 `status` 请求或下一次带权限门禁的 API 请求才会更新；模型在两者之间开始的
一个 turn 仍可能看到旧工具面。旧工具面只会导致后端拒绝调用，不会造成越权。权限上下文读取
失败、或后端返回空权限列表（旧版/未知后端）时，协调器按无权限处理并 dispose 全部工具，
同时记录原因。需要主动刷新时，宿主可通过
`knowledgeBaseToolDisclosure(ctx).syncToolDisclosure()` 触发一次。

路径级 `canRead` / `canWrite`（以及审计、授权、审核队列的部门范围过滤）保留在工具执行内：
它们决定「可见工具能碰哪些数据」，不是「工具是否出现」。DataOps 后端仍是每次请求的最终
授权边界。

## 本地验证一个个人版

个人版不依赖任何后端，所以可以直接起一个临时 profile 验证四条链路：

```bash
mkdir -p ~/.dsh/profiles/kb-personal/plugins
cd ~/.dsh/profiles/kb-personal
# package.json 的 dsh.profile.bundles 里放 @deepseek-ai/dsh-base + dsh-web-app + 本插件
# cordis.patch.yml 里放 baseUrl: '' 和两个根目录（见下）
~/.dsh/.../bin.js --profile kb-personal --port 6688 --no-open
```

**`mountPoint` 必须等于 `actualRoot`。** 团队版靠 `pointMountAtView` 把两者用符号链接接起来；
个人版没有视图层，列表读 `mountPoint`、写入落 `actualRoot`，写成两个目录就会表现为
「上传成功了但文件不见了」。

### 验证端口不要用 Chrome 的保留端口

**6666、6667 这类端口 Chrome 会拒绝加载**（`ERR_UNSAFE_PORT`，浏览器硬限制，与本插件无关），
表现为 Playwright / 浏览器连不上而 curl 正常：

```
page.goto: net::ERR_UNSAFE_PORT at http://127.0.0.1:6666/?token=...
```

选 6688 这类端口做本地验证。另外**起服务前先 `curl` 一次目标端口**再判断是否占用——
`ss` 显示空闲不代表绑定会成功（连续起停会有瞬时的绑定失败）。


## 引用契约

`kb_search` 的每个命中、`kb_chunk_get` 的每个响应都带一个稳定 token：

```
kb://doc/<docId>/chunk/<key>
```

`key` 是内容寻址的 `chunk_key`（16 位十六进制），旧索引里可能是数字 chunk id。模型回答时
**原样引用这个 token**，不要写 `:193`、`第N块`、`path:line`，也不要写 `.docx.md`/`.pdf.md`
派生路径。`kb_chunk_get` 接受完整 token，或 `docId` + `chunkId`（数字 id 或 chunk_key）。

`@sparkelf/dsh-kb-citation` 负责把 token 渲染成 `文件名:第N块`：点击后打开原始
`.docx/.pdf/.xlsx`，滚动到该 chunk 的首个命中页，并**每页只画 1 个 union 框**。source 面板、
正文、GenUI 三处共用同一解析与标签逻辑；旧 `.docx.md:line` 链接仅作兼容 fallback，新回答
不应再产生。

### 目录索引（INDEX.md）与 `kb_outline`

每篇文档建立 FTS 索引时会同步生成一份**导航结构**：目录（章/节/条）和章节行，
但**默认不生成摘要**。摘要是在用户明确要求时，由 agent 按 `knowledge-base` 技能的 `references/summarize.md` 阅读原文后
调用 `kb_outline_save` 写入的。

- 文件：`<indexDir>/md/<docId>.INDEX.md`（默认 `/nas/kb/index/md/<docId>.INDEX.md`），
  与 `kb-index.sqlite` 同级，**不写入源文件目录**，也不进入任何用户的可见视图。
- 上传/抽取后：`kb_docs.summary` 为空，`kb_outline` 返回 `summaryStatus: "missing"` +
  `hint` 指向摘要流程（`references/summarize.md`）；目录和 `kb_sections` 已可用。
- 显式生成：`kb_outline` 拿 `toc`/`sectionId`/`chunkIds` → 逐章 `kb_chunk_get` 读原文 →
  agent 生成 doc/section summary + keyFacts → `kb_outline_save` 校验并落库。
- 校验：摘要与 keyFacts 中的数字、比例、金额、条款号、责任主体必须能在对应 source chunks
  原文中找到（严格归一化）；不匹配返回 `rejected[]`，**不写任何半成品**。
- 存储：`kb_docs.summary` / `toc_json` / `summary_version` / `summary_kind`；章节行写入
  `kb_sections`；摘要与一级/全部章节摘要写入 `kb_summary_chunks` + `kb_summary_fts`
  （独立 FTS 表，不影响 `kb_chunks_fts`）。
- 兼容：0.1.9 的抽取式摘要保留为 `summary_kind='extractive'`；`outline.autoGenerate=true`
  可恢复旧的自动抽取式行为（默认 `false`）。显式保存后整篇文档覆盖为 `summary_kind='llm'`。
- 重建条件：源文件 hash 或 `CHUNKER_VERSION` 变化会重建目录结构并使旧摘要失效；旧索引升级时只补
  outline 行，**不重分块、不换 chunk id**，已有 citation token 仍然有效。

`kb_outline(docId | kb://doc/<docId>/chunk/<key>)` 返回
`{docId,path,summary,summaryKind,summaryStatus,toc,sections,indexPath}`，不返回整章全文。
`summaryStatus` 为 `missing` 时摘要为空，不应伪造；`kb_search` 命中在索引有摘要时附带
`sectionId/sectionPath/sectionSummary/docSummary`；摘要类结果永远不带 `citation`，只用于导航。
引用仍只能使用原文 chunk 的 `kb://doc/<docId>/chunk/<key>` token。

`knowledge-base` 主技能用 `references/{organize,summarize,vectorize,graph}.md` 承载专项流程；
`list()` 同时返回 `knowledge-base` 与 `memory` 两个 candidate。

### 分块与 bbox 契约

- `kb_chunk_boxes` 按提取块（段落/表格行/OCR block）逐条保存 provenance，供排查与
  重新聚合使用，**不是**前端绘制粒度。
- `POST /knowledge-base/api/chunk`、`/api/resolve` 与 `kb_search` 的 `boxes` 字段均为
  **每页 1 个 union**；`kb_chunk_unions` 缓存该结果，旧索引没有缓存时由 API 现算。
- 分块以结构优先：`第X章/第X节`、`第X条`、Markdown/`一、` 标题、表格行都会开启新 chunk，
  章标题/条标题不会被并入上一块；`（一）` 等条内列表可以合并，但不得跨章。430 字只是软目标，
  上限 800 字只用于切分超长段落。`CHUNKER_VERSION` 变化会触发重建。
- 重建后旧 `chunk_key` 通过 `kb_chunk_key_aliases` 按文本重叠率（≥20%，短块要求完全一致）
  重映射；内容已被改写/删除的旧 token 解析为 404，引用侧显示「引用已失效」，不会落到相邻块。


## MinerU 部署（`scripts/deploy-mineru.mjs`）

知识库的文档索引依赖 MinerU 提供 Markdown 提取。这个脚本把「准备离线包」和
「装到目标机」拆成两步，因为这两件事通常不在同一台机器上发生：打包的机器有外网，
要部署的机器往往没有。

```bash
# 1) 在有外网的机器上：把镜像（和可选的模型缓存）打成一个可搬运的目录
node scripts/deploy-mineru.mjs fetch --image mineru:4 --output ./mineru-bundle

# 2) 把 ./mineru-bundle 拷到目标机后：加载镜像并起服务
node scripts/deploy-mineru.mjs deploy --host root@10.0.0.12 --bundle ./mineru-bundle

# 3) 用插件真正发送的请求验证一次
node scripts/deploy-mineru.mjs verify --url http://10.0.0.12:8000
```

每个子命令都支持 `--dry-run`：只打印将要执行的命令与产物路径，不下载、不复制、
不启动任何东西。第一次对某台机器操作前建议先跑一遍。

### 部署后的请求契约

`verify` 发送的就是知识库插件实际使用的形态，不是旧文档里的写法：

```
POST {base}/v1/file_parse?tier=basic&output_formats=markdown&ocr_mode=auto
Content-Type: multipart/form-data
body: 只有 files 一个字段
```

MinerU 4.x 以 `max_fields=0` 解析 multipart，body 里多一个字段就会被拒绝
（`Too many fields. Maximum number of fields is 0.`），所有解析选项都从 query 串读取。
`output_formats` 没有默认值必须显式传；`tier` 不传时服务器会自行选择 `standard`，
同一个单页 PDF 实测 17.8 秒对 `basic` 的 2.0 秒，所以脚本固定传 `tier=basic`。

### 幂等与凭据

- 重复执行安全：bundle 已存在则跳过重建（`--force` 才重做）；目标机上镜像已加载
  则跳过 `docker load`；容器已存在且未给 `--force` 时保持原样。
- SSH 只用密钥、ssh-agent 或 `~/.ssh/config`。需要密码时用
  `MINERU_DEPLOY_SSH_PASSWORD` 环境变量配 `--ask-pass`，**任何密码都不会写入文件或
  出现在命令行参数里**（helper 脚本从环境读，用后即删）。
- 退回到无 Docker 的机器用 `fetch --mode=wheels`：下载 wheel 与模型，但目标机仍需
  Python 3.10+ 与 venv；缺什么会在 `deploy` 时明确报出来，不会假装成功。

### 镜像从哪来

MinerU 官方发布的是 Dockerfile 而不是可直接 pull 的 tag：`docker/compose.yaml` 里用的
是本地构建的 `mineru:4`。所以 `fetch` 依次尝试「本地已有镜像 → `--build-from <仓库>`
构建 → `docker pull`」，并在最后一步失败时把构建命令打出来：

```bash
git clone https://github.com/opendatalab/MinerU
docker build -f docker/global/Dockerfile -t mineru:4 .
```

国内网络用 `docker/china/Dockerfile`（DaoCloud vllm 基底 + 阿里云 PyPI + ModelScope），
`fetch --model-source modelscope` 是默认值。
