# Agent Note: 基于 MinerU 解析的持久文档附件

Status: proposed

[English](2026-08-24-mineru-document-attachments.md) | 中文

## 问题

Web 附件能力已经解决持久化问题，但它有意只支持图片。现有存储、prompt admission、session 引用、历史渲染和 provider projection 为 PNG/JPEG/WebP/GIF 建立了完整生命周期，而 generic file、PDF 与文件选择器当时明确留作后续。因此用户现在不能上传 PDF、DOCX、PPTX 或 XLSX，再让 Harness 对其中内容进行推理。

只增加文件选择器还不够。Office 文档和 PDF 在 parser 把它们转换成文本与结构之前，并不是通用模型可直接消费的内容；原文件与解析产物需要在 reload/fork 后继续存在；解析失败时也不能先写入一个模型之后无法重建的 user message。同时 Harness 不应该为了使用 MinerU 就获得一套固定 document-RAG 工作流、内嵌 Python ML runtime 或第二套附件存储。

MinerU 当前公开 parse API 接受 PDF、图片、DOCX、PPTX 与 XLSX，并能返回 Markdown、`content_list`、提取图片或 ZIP bundle。它的 `content_list` 是按阅读顺序展开的扁平结构，包含 text、image、table、chart、equation、code、list 与 page metadata，未来 Harness 程序可以直接利用，而不需要依赖 parser 内部的 `middle.json`。

## 提案

先对现有 attachment 能力做增量扩展，支持持久化文档文件；随后增加可选 MinerU parser provider，在 owning user message 写入之前把支持的文档转换成持久化解析 bundle。首版文档路径支持 PDF、DOCX、PPTX、XLSX；现有 raster image 继续走原生 multimodal image 路径，不重新路由到 MinerU。

实现有意拆成两个可独立评审的改动。第一部分只增加 generic document attachment intake、storage、wire representation、composer/history UI 与持久 `DocumentAttachmentRef` 语义，不依赖 MinerU。第二部分叠在这个能力上增加 MinerU 解析与 parsed-document model projection。这样存储/UI 可复用，而 parser 集成可以独立演进。

### 持久文档附件

现有 image 类型与操作保持不变。新增 document reference，包含不透明 attachment identifier、精确的支持媒体类型、字节数与展示文件名。首批接受 PDF 与 OOXML 的 DOCX/PPTX/XLSX 媒体类型。旧 DOC/PPT/XLS、ZIP、任意二进制和可执行格式不属于首版。

未发送的浏览器文档和未发送图片一样，仍然是 live composer 持有的 `File`。composer attachment union 增加 document case，以紧凑 file chip 显示类型、名称、大小和删除动作；文本、图片、文档可以共用一条 attachment rail。admission 或 parse 失败时，完整 in-flight draft 要恢复，并且不能覆盖请求执行期间用户继续修改的草稿。

Host 在接受消息前验证完整 document batch，把每个原始文档保存进同一个 content-addressed attachment backend，并构造 immutable durable reference。文档限制使用与图片 byte/pixel limit 分离的 deployment config，因为 parser 成本和文件语义不同。设计阶段不猜生产环境的 byte/count 默认值；实现时提供显式可验证配置并测试 admission 行为。

现有 `$DSH_HOME/attachments/v1/objects` content-addressed store 继续作为物理对象存储。在 DataOps 托管部署中，该 store 属于用户的隔离 DSH 容器，并与 DataOps 附件中心分离。local provider 只增加文档与 parser artifact 所需的最小 generic byte-file primitive，而不是再创建 MinerU 专属目录树。原始文件名只作为 display metadata，永远不参与 storage path。

### Parsed document reference

解析成功的文档同时保留原始 `DocumentAttachmentRef` 与 parser 输出的持久引用。实现采用以下字段：

```text
interface ParsedDocumentRef {
  parser: string
  markdown: FileAttachmentRef
  contentList: FileAttachmentRef
  images: readonly ImageAttachmentRef[]
}

interface DocumentBlock {
  type: 'document'
  attachment: DocumentAttachmentRef
  parsed: ParsedDocumentRef
}
```

Markdown 与 `content_list.json` 作为 immutable attachment object 保存，不把巨大字符串直接嵌进 session event。MinerU 提取出的图片如果属于现有支持的 raster 格式，也通过现有 image attachment 能力持久化。parser integration 会重写或记录 MinerU 相对图片路径，确保 durable reference 不依赖临时 ZIP 解压目录。

`DocumentBlock` 加入 merge-extensible core content vocabulary，在类型层保持 role-neutral；首版产品 intake 只处理用户上传文档。未来如果 assistant 产生文档，也必须遵守相同的 persist-before-event 规则。

### MinerU provider

MinerU 以外部服务运行，通常是 `mineru-api` 或 `mineru-router`；DSH Node 包不内嵌 Python、PyTorch、模型权重、GPU 生命周期或 MinerU 进程管理。parser plugin 是 HTTP multipart client，通过 endpoint 以及部署拥有的 timeout/size policy 配置。

首版使用同步 `POST /file_parse`。MinerU 公共 API 也可以暴露 `/tasks`，但当前 task state 属于服务进程状态，并不是 durable Harness job contract。因此 DSH 不持久化 MinerU task id，也不围绕它再建第二套 job lifecycle。如果真实文档后来需要后台解析，应由 DSH `ctx.jobs` 拥有对用户可见的 durable/background 语义，MinerU task API 最多作为 provider 内部实现细节。

请求 MinerU 返回真正有用的最终 bundle：Markdown、`content_list` 和提取图片，优先使用 ZIP response；parser 内部的 `middle.json`、raw model output 与 original file 不返回，因为 DSH 已经保存了原始对象。parser backend、effort、OCR 策略、公式处理和表格处理首版跟随 MinerU deployment 自己的配置默认，除非真实产品需求证明这些选项需要由 DSH 管理。

### Admission 顺序

从 session 角度看，document admission 是原子的：

```text
browser draft
  -> host validates the complete document batch
  -> host persists original documents
  -> MinerU parses each required document
  -> host validates and persists Markdown/content_list/images
  -> host proves the complete rendered document text, including delimiters and metadata, fits the configured version-one model projection budget
  -> host appends the user message with durable DocumentBlock references
```

如果验证、解析、输出持久化或 parsed-content admission 任一步失败，不追加 user event，浏览器恢复草稿。与现有 content-addressed image store 一样，如果较早步骤已经发布了 immutable original/parser-output object，而后续步骤失败，这些对象可以暂时成为 unreferenced object；首版不为了文档单独增加 destructive rollback 或 reference-counted garbage collection。

首版在消息接受前完成解析。UI 可以在提交期间显示通用的 attachment processing 状态，但不会在同步 API 没有提供真实百分比的情况下伪造进度。

### 模型投影

首版以 parsed Markdown 作为 provider-neutral model representation。provider/request projection 在发送模型请求时解析 durable Markdown reference，并输出带原始文档名和完整解析内容的清晰分隔文本。这样普通文本模型就能使用文档，不要求每个 LLM adapter 理解 PDF 或 OOXML bytes。

首版明确只接受完整渲染文本能放进可配置 direct-context budget 的文档。准入计算完整 Markdown、文档分隔符与元数据；如果结果超过 budget，系统会在 user event 写入前明确拒绝，而不会截断文档或把 partial content 当成完整内容。

长文档 retrieval 是后续能力，不是首个 parser integration 中隐藏的子系统。持久 `content_list` 为未来 `read_document`/`search_document` 工具、block/page read 或 semantic retrieval 留下直接基础，不需要重新解析原文档。首版不增加 embedding、vector database、自动 chunk/RAG orchestration、rerank 或固定 LangGraph 式 document workflow。

提取图片会为了完整性和未来使用而持久化，但首版不会在每次模型请求里自动把所有图片全部注入为 image block。默认模型投影仍是 Markdown 文本与 MinerU 生成的 caption/analysis；`content_list` 保留未来 Harness 工具定位特定 page、image、chart 或 table 并通过现有 multimodal image path 读取它们所需的映射。

### `content_list` 作为 Harness 编程接口

即使 direct Markdown 已足够完成首版模型投影，也有意保存 `content_list.json`。它的 reading-order block 保留 page index 与结构化 content type，因此未来 Harness code 可以检查 heading、定位 table、选择 page range、找到 image/chart block，或者转换解析后的 table content，而不依赖 MinerU backend-specific internal tree。

这不会把 DSH 锁死在某一种 retrieval 策略。后续 document tool 可以从这个 durable representation 暴露 block，而 Code Mode 继续用 Harness 已有的 typed-return 模型组合这些工具。

### 产品 UI

Web composer 在已有 paste/drop image intake 之外增加支持 document type 的普通 file picker。document chip 显示用户文件名，并在有帮助时显示类型/大小和 remove 控件。历史中在 user message 上渲染紧凑 document card；普通 UI 不暴露 MinerU backend 名称、task id、Markdown bytes、OCR mode、ZIP 路径或 parser internal field。

原始文档对 session 保持持久可用。首版可以提供 session-authorized download/open action，让浏览器能够处理支持的文件，但不要求为了让解析可用就同时实现 Office viewer 或 PDF annotation UI。

### 包与能力所有权

Generic attachment 改动扩展现有 attachment Service Definition 与 local provider，不引入另一套 storage capability。MinerU parsing 是叠在持久文件上的可选 parser provider 与 consumer。精确 package split 遵循当前包命名规则，预期使用独立一方 MinerU integration package，使未部署 MinerU 的环境不会获得其 HTTP/config surface。

不需要修改 `agent-loop`。prompt admission、session logging、attachment persistence、provider projection 与 Web rendering 继续使用已有 extension point。面向产品的实现改动需要 package README、实现后把 Agent Note 改写为 implemented 生命周期、新 public type 对应的 subsystem 文档，以及真实 Loader composition coverage。

### DataOps 原文件备份扩展

DSH 继续作为 model projection、session replay、resume、fork 和 session export 的权威附件存储。后续可选 DataOps-specific DSH plugin 可以在 DSH 持久化后，把用户上传原文件复制到 DataOps 附件中心。DataOps copy 只是一份备份记录；DSH 不能把它作为读取 fallback，任何 DSH attachment reference 都不能通过 DataOps 解析。

备份 plugin 只复制用户原文件，以及 DataOps 附件中心需要的最小来源 metadata。MinerU Markdown、`content_list` 和提取图片继续作为 DSH-owned derived object，不参与备份。Delivery timing、用户可见状态、retry behavior、DataOps API authorization 和 retention 必须在实现备份 plugin 前由独立提案定义，不能扩张当前 document-attachment MVP。

## 考虑过的替代方案

**把 MinerU/Python 内嵌进 DSH。** 不采用，因为模型权重、GPU/CPU 依赖、Python 环境管理与 MinerU 升级拥有和 Node Harness 不同的 deployment lifecycle。外部 HTTP provider 能把这些复杂度留在 core runtime 之外。

**直接把原始 document bytes 交给 LLM provider。** 不作为通用设计，因为 provider 的 file/PDF support 不一致，OOXML 也不是可移植的模型约定。持久 parsed Markdown 为每条 text-capable route 提供统一 representation，同时保留 original file，未来仍可加 provider-specific 优化。

**只存 Markdown，丢弃 `content_list` 与 images。** 不采用，因为 Markdown image path 否则会依赖 transient parser output，而扁平 structural block 是便宜且对未来 Harness code 有用的信息。保留最终 parse bundle 可以避免未来 richer document tool 到来时重新解析原文档。

**把 MinerU `/tasks` id 持久化为 document state。** 不采用，因为这个 external task id 不提供 Harness session 暗含的 durable lifecycle 语义。如果需要 background work，应由 DSH jobs 拥有，而不是把用户状态委托给 parser process task table。

**首版直接做 RAG/vector search。** 不采用，因为 direct Markdown 已足以建立真正有用的 document attachment，而 Harness 已经拥有可编程工具组合。应该等真实长文档工作负载明确 retrieval pattern 后再增加。

**一开始就给 PDF、DOCX、PPTX、XLSX 分别使用不同 parser。** 不采用，因为首个产品目标是一条一致 document-attachment path。MinerU 已支持这些格式并输出统一 Markdown/content-list 家族；只有格式专用原生 analyzer 展示出实际优势时再增加，例如 spreadsheet-scale data analysis。

**把 XLSX 通过这条路径当数据库规模数据源。** 不采用，因为“作为人类文档上传的 spreadsheet”和“需要分析几十万行的 workbook 数据集”是两个产品。前者由 MinerU 处理；高容量 tabular analysis 应走 data-query/import capability，而不是 document parser。

**让 DataOps attachment storage 成为 DSH 附件权威来源。** 不采用，因为 DSH session replay、fork、model projection 和 export 需要持久本地引用，不能依赖第二个系统。后续 DataOps plugin 可以复制原文件作为备份，但不改变 DSH ownership。

**把 MinerU parse bundle 备份到 DataOps。** 不采用，因为 Markdown、`content_list` 和提取图片是 DSH implementation artifact，不是用户上传附件。复制这些产物会要求第二套 derived-artifact 数据模型和协同 retention，却不能改善当前 DSH replay。

## 验收标准

- 现有 image attachment 行为保持不变，同时 Web composer 可以提交 PDF、DOCX、PPTX、XLSX，并支持 text/image/document 混合草稿。
- 原始 document bytes 在 owning user event 写入前已经保存到现有 content-addressed attachment store。
- MinerU integration 可以通过 `/file_parse` 同步解析已持久化支持文档，并保存 Markdown、`content_list` 与 extracted images，不把临时 parser path 写进 session。
- parse 或 persistence 失败不追加 user event，并恢复 browser draft；不增加自动 retry 或推测性 background queue。
- 接受后的 `DocumentBlock` 能通过 session log + durable attachment object 在 reload、resume、fork 中重建。
- 小/中型接受文档把完整 parsed Markdown 投影给 text-capable model；超过 budget 的完整渲染文档文本明确失败而不是静默截断。
- extracted image 保持 durable，`content_list` 保存 page/block structure 供后续 Harness tool 使用，但首版不在每次请求自动注入所有 extracted image。
- 实现增加聚焦的 attachment/parser test、Web composer/history behavior test、session replay coverage、provider projection coverage 和真实 Loader composition test。
- 首版不增加 vector database、embedding、automatic RAG pipeline、MinerU task persistence、embedded Python runtime 或第二套 attachment store。
- DSH 对所有当前附件行为保持权威。后续 DataOps backup plugin 只能复制用户原文件，不能提供 fallback read，也不能复制 parser-derived object。

## 风险

同步解析让 submit latency 与文档复杂度和 MinerU deployment 性能直接相关。首版接受这个简单生命周期；如果真实使用证明延迟不可接受，可以把 background ownership 移到 `ctx.jobs`，不需要改变 durable document reference。

MinerU 输出质量会受 layout、backend、OCR language、table、formula 与 Office conversion 影响。DSH 应忠实保留返回的 Markdown 与 structural output，而不是增加静默修复层。产品评估应先覆盖有代表性的文档，再决定是否值得暴露大量 parser tuning setting。

同时保存 original file、Markdown、structured JSON 和 extracted image 会增加 attachment storage。现有 attachment store 已经把 reference-aware garbage collection 留作后续；document support 继续这个策略，而不是增加会破坏 durable session 的按年龄清理。

首版 direct-context limit 意味着非常大的文档即使 MinerU 能解析，也会被拒绝。这是为了先建立正确 durable 语义而做的显式 scope trade-off；保存下来的 `content_list` 是后续 block retrieval/search 的基础。

后续 DataOps backup plugin 会引入具有独立 retention 和失败提示的第二份物理 copy。在独立提案定义这些行为前，DataOps 附件中心不能暗示所有 DSH 上传都已经完成备份。
