# Agent Note: 通用持久文档附件基础

Status: implemented

[English](2026-08-24-durable-generic-document-attachments.md) | 中文

## Problem

原有持久附件能力只面向图片。若只在浏览器增加 PDF 或 Office 文件选择，得到的只是临时字节，没有可重建的会话表示；若先引入解析器，又会把存储、wire 语义和 UI 所有权绑定到某一个解析器实现。与此同时，通用文档也不能直接加入可扩展内容词汇，因为已有提供方适配器会在默认分支中静默忽略未知 block。

## Decision

已经落地的通用文档层先扩展现有附件能力，再叠加任何解析器集成。PDF、DOCX、PPTX 和 XLSX 原件通过通用 `saveFile` / `readFile` 原语，与图片共用同一套内容寻址对象命名空间。浏览器和 Host 准入会在用户消息可被接受之前持久保存不可变 `DocumentAttachmentRef`，核心内容则通过角色无关的 `DocumentBlock` 记录该引用。

本说明只负责通用基础。更完整的 MinerU 方案仍由 [使用 MinerU 解析的持久文档附件](../../proposed/feature/2026-08-24-mineru-document-attachments.md) 持有；解析、解析产物包以及直接正文投影仍属于后续工作。

## Admission and storage

文档限额与图片限额分离，包括单文档最大字节数、文档数量、文档总字节数和接受的媒体类型，均由部署策略解析。`admitEncodedDocuments` 先对完整批次解码规范 base64，规范化展示文件名，检查扩展名与媒体类型一致性，执行用于排除明显错配的最小格式检查（PDF 签名或 OOXML ZIP 容器），再校验数量和字节限制，只有全部通过后才开始内容寻址写入。

原始文件名只作为展示元数据，从不成为存储路径。`readFile` 同时校验附件 id 编码的内容摘要和已记录的字节长度。通用文件原语刻意不解释任何解析器专用语义，因此后续 Markdown、content-list 或其他不可变解析产物都可以复用同一存储层。

## Session and provider semantics

`session.prompt` 接受有序的 text、image 和 document wire part。图片和文档批次分别执行自己的准入策略，随后 Host 按浏览器原始混排顺序重建 `ContentBlock[]`。只有全部准入成功后，用户消息才会交给 Agent，从而保持“先持久化、后事件”的边界。

已经发布的 DeepSeek 和 pi-ai 请求投影绝不会静默丢弃通用 `DocumentBlock`。在尚无解析器时，适配器会插入明确文本标记，指出持久文档的名称，并说明其正文尚未解析。这种能力刻意弱于假装已经读过文件，但能保持语义诚实，并确保未解析文档对模型可见。

图片继续使用原有原生多模态路径和模型能力检查。通用文档不会冒充提供方原生文件模态；slash command 的附件提交也继续只接受图片，document id 若进入该 envelope 会被拒绝而不是强制转换。

## Browser and durable history

浏览器把未发送的 `File` 对象保留在 conversation runtime 中，现有输入状态机里只存不透明 draft id。runtime registry 区分图片和文档记录，因此可以用一条有序 id 列表保存混合附件顺序，而不会把浏览器对象放入输入状态或会话数据。

输入区在同一条附件 rail 中渲染图片缩略图和紧凑文档卡片。拖放和文件选择会把图片与文档路由到各自的校验路径。历史记录把持久文档引用显示为紧凑文件 chip，而不是未知 JSON block。由于 `DocumentBlock` 是普通持久会话内容而不是 presentation metadata，reload、replay 和 fork 都会保留它。

会话 ZIP 导出会扫描相同的持久内容载体查找文档引用，并把每个被引用的原件写入 `documents/<attachmentId>.<ext>`。导出通过 `readFile` 读取，因此原件缺失或损坏会明确失败，而不会生成一个引用了不可重建文档的日志包。

## Alternatives considered

**创建独立的文档或 MinerU 对象仓库。** 不采用，因为现有内容寻址存储已经提供原件和解析产物需要的不可变性与崩溃持久边界。解析器专用存储会重复生命周期所有权，也会增加替换解析器的成本。

**加入 `DocumentBlock`，让不支持它的适配器直接忽略。** 不采用，因为可扩展 switch 本来就允许未来 block 类型；默认分支若静默丢弃 document，会让持久用户附件变成模型不可见输入。通用占位投影在解析正文能力存在前显式暴露这一限制。

**把 PDF/OOXML 字节直接发给所有提供方。** 不采用，因为提供方文件能力并不一致，这会把某些提供方的原生文件 API 错当成 Harness 的通用契约。持久原件仍可供未来优化适配器读取，而通用路径保持提供方中立。

**在这个基础层直接构建解析或长文档检索。** 不采用，因为存储、wire 和会话正确性本身就是独立且可复用的能力。解析器选择、解析正文预算、检索和后台执行有各自的部署与产品契约，继续留在 MinerU 后续实现中。

## Consequences

Harness 现在拥有可重建的非图片文档原件、有序混合附件准入、持久会话引用、诚实的提供方行为、浏览器展示、fork/replay 保留以及导出覆盖，同时没有引入解析器依赖。

当前模型体验刻意受限：通用层只暴露文档身份，不提供文档正文。因此真正的文档推理仍需要后续解析器。最小 OOXML 准入也只证明输入属于预期 ZIP 容器家族；实际 Office 结构的校验和提取仍由解析器负责。

浏览器输入状态机还保留一个历史命名：通用混合附件列表仍叫 `imageIds`。runtime 语义已经不再假设每个 id 都是图片；由于重命名会造成大范围迁移而没有用户可见收益，该内部词汇调整被延后。
