# @deepseek-ai/dsh-attachment

[English](README.md) | 中文

持久附件服务边界。`ctx.attachments` 为栅格图片、受支持的人类文档以及解析器产物共用一套内容寻址的不可变对象命名空间。消费方在会话事件中持久保存的是不透明引用，而不是浏览器路径、对象 URL、提供方 URL 或 base64 负载。

图片继续走格式专用路径。`validateImage` 在不写入的情况下应用部署策略，`saveImages` 在发布任何成员前先校验完整有序批次，`saveImage` 提交一张已接受的栅格图片，`readImage` 则同时校验摘要和已记录的图片元数据。`admitEncodedImages(attachments, images)` 是浏览器 wire 的标准入口：它先拒绝非规范 base64，再把数量、总字节、媒体类型、解码、尺寸和像素限制委托给存储服务。

通用文档是增量能力。第一版通过 `admitEncodedDocuments(documents, attachments)` 接受 PDF、DOCX、PPTX 和 XLSX。它会在持久化前校验完整解码批次，执行部署级 `DocumentAttachmentLimits`，规范化展示文件名，校验文件扩展名与声明媒体类型一致，并执行最小容器签名检查（PDF 文件头或 OOXML ZIP 容器）。随后通过 `saveFile` 保存原始字节，产生持久的 `DocumentAttachmentRef`。`readFile` 校验内容寻址摘要和已记录的字节长度。这些通用文件原语也为后续解析器产物提供存储表面，无需创建解析器专用对象仓库。

该服务刻意不解析文档正文。提供方投影、解析器编排、浏览器呈现和会话授权都属于各自消费方。通用文档生命周期先建立持久原件和引用；以后可以叠加可选解析器，而无需修改存储契约。

`AttachmentError.code` 仍是稳定失败词汇。`ImageAdmissionErrorCode` / `isImageAdmissionError` 与 `DocumentAdmissionErrorCode` / `isDocumentAdmissionError` 分别区分可由调用方修正的准入失败和存储故障，使每个协议边界都能映射成自己的 wire 错误。

## 模型体验

该包通过角色无关的核心 `ImageBlock` 和 `DocumentBlock` 间接影响模型。它只负责保存和校验字节；面向模型的投影由 LLM/提供方消费方负责。没有解析器的通用文档也必须由消费方显式表示，而不能被静默丢弃。

#### KV 缓存影响

添加图片或文档会改变提供方请求后缀，因此会使受影响的后缀失效。附件存储本身不会发起模型调用，也不消耗 token。

## 已知限制与待完成工作

- 栅格图片准入仅接受 PNG、JPEG、WebP 和 GIF；通用文档准入仅接受 PDF、DOCX、PPTX 和 XLSX。
- OOXML 准入只验证 ZIP 容器以及文件名/媒体类型一致性，不验证完整的 Office 包内部结构；可用正文仍应由文档解析器提取。
- 保留策略与垃圾回收尚未实现，因为恢复和 fork 后的会话可能共享不可变对象。
- 文档解析、长文档检索/搜索、音频、视频、任意二进制文件以及持久的未发送草稿需要单独的能力或生命周期契约。
