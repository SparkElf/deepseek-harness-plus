# Agent Note：基于持久文档附件的 MinerU 解析

Status: implemented

[English](2026-08-24-mineru-document-parsing.md) | 中文

## 问题

通用文档附件层已经让 PDF、DOCX、PPTX 和 XLSX 原文件具备持久、可重建语义，但有意只向模型暴露明确的“未解析”标记。解析集成必须真正提供文档正文，同时不能把解析器临时路径、外部 task id、大段 Markdown 字符串或第二套对象存储塞进 session 生命周期。

该集成也不能成为 DeepSeek 专用文件功能。解析内容必须保持提供方中立，能够仅通过 session 日志与附件对象在重载/分叉后重建，并且解析或直接上下文准入失败时必须发生在用户事件追加之前。

## 决策

解析功能新增可选的 `ctx.documentParser` Service Definition，以及独立 MinerU 提供方包。service 拥有与注册顺序无关的提供方选择，以及针对一次提交全部解析 Markdown 合计字节的必填 `maxDirectMarkdownBytes` 策略。MinerU 包注册提供方 id `mineru`，与外部管理的同步 `/file_parse` 端点通信；Harness 不内嵌 MinerU 的 Python/模型/GPU 运行时。

解析后的 `DocumentAttachmentRef` 保留原始不可变文档身份，并新增 `ParsedDocumentRef`，其中保存完整 Markdown、完整 `content_list` JSON 和提取栅格图像的持久引用。因此 session 内容仍然只包含引用。解析响应条目名和提取出的字节缓冲只存在于本次准入操作期间。

## 准入生命周期

Host prompt 准入保持一个提交边界：

```text
校验文档批次
  -> 持久化原始文档字节
  -> 读取已持久化原文件
  -> 通过 ctx.documentParser 逐个解析
  -> 校验并持久化 Markdown/content_list/提取图像
  -> 检查本次提交的完整 Markdown 合计字节预算
  -> 构建携带持久解析引用的 DocumentBlock
  -> 追加/排队用户消息
```

内容寻址存储不会回滚已发布对象。因此后续解析、持久化或预算失败可能留下未被引用的不可变对象，这与现有附件存储策略一致；但失败 prompt 不会追加用户事件。

直接上下文检查会累加本次提交中每个文档完整已持久 Markdown 的字节长度。版本一不会静默截断文档，也不会只接受前几页。即使每个文档单独都能放入预算，只要合计超过 `maxDirectMarkdownBytes`，整个批次仍会在消息提交点之前以明确的解析准入错误失败。

## MinerU 传输

`@deepseek-ai/dsh-document-parser-mineru` 每次 multipart `POST /file_parse` 发送一个原始文档。请求最终 Markdown、`content_list`、提取图像和 ZIP 输出，同时显式关闭 `middle.json`、原始模型输出和原文件回传。

`endpoint`、`timeoutMs` 与 `maxResponseBytes` 都是必填部署配置；包不会臆造生产端点、超时或大小默认值。字节上限同时约束 HTTP 响应和 ZIP 解压后的总输出。合法响应必须恰好包含一个 Markdown 产物和一个版本一 content-list 产物；最终输出缺失或歧义会直接失败，而不是根据文件名猜测。提取图像只有在其字节属于附件系统支持的栅格类型时才会保留。

MinerU `/tasks` 不是 Harness 持久 job 状态。版本一保持同步；如果真实负载以后需要后台执行，`ctx.jobs` 应成为面向用户的未来生命周期，而 MinerU task API 只可作为提供方内部细节。

## 提供方中立模型投影

持久 session 日志从不内联保存解析 Markdown。在 DeepSeek 或 pi-ai 序列化包含已解析文档的请求前，adapter 会通过附件服务解析持久 Markdown 引用，并在临时请求快照中把 `DocumentBlock` 替换为带明确分隔标记、包含完整 UTF-8 Markdown 的文本 block。

两个 adapter 路径共享同一个投影 helper，因此文档语义不会因模型提供方而分叉。普通未解析文档继续使用既有的明确未解析标记。提取图像不会自动注入每次请求；其持久引用与 `content_list` 结构会被保留，供未来选择性页面/block/图像工具使用。

## 考虑过的替代方案

**把 Markdown 直接内联进 session 事件。** 否决，因为大型解析输出会把不可变附件数据重复写进每个可重放日志，并让 session artifact 变成对象存储。持久引用可以在不重复数据的前提下保持模型可见内容可重建。

**让每个 LLM adapter 原生上传 PDF/Office 字节。** 否决，因为不同提供方文件 API 和格式支持不一致。完整解析 Markdown 为所有文本模型提供统一表示，同时保留原文件以便未来优化 adapter。

**版本一持久化 MinerU task id 并异步解析。** 否决，因为外部服务进程的任务表不是持久 Harness 生命周期。只有在引入 Harness 自有 job 语义后才应增加后台解析。

**解析时同时增加 RAG/向量搜索。** 否决，因为第一步需要的是正确的持久解析与直接上下文推理。保留 `content_list` 正是为了未来无需重新解析即可增加页面/block 读取或搜索；embedding、向量数据库、切块编排和重排仍是独立产品决策。

## 结果

中小型受支持文档批次现在可以成为模型可读取的完整文本，同时原文件与解析产物在重放和分叉后仍保持持久。解析失败和合计 Markdown 超预算会成为明确的 prompt 准入失败，而不是静默模型降级。

代价是同步提交延迟和直接上下文的明确大小上限。该实现有意先建立正确的持久解析面；长文档检索、后台解析、解析调参 UX 和提取图像的选择性检查仍是后续能力，不会作为版本一的隐藏行为出现。
