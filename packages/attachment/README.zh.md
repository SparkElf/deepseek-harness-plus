# attachment/：持久附件能力族

[English](README.md) | 中文

持久二进制附件存储、提供方中立文档解析能力、本地内容寻址提供方，以及可选 MinerU HTTP 解析器。它们都是产品包；文档解析复用同一附件对象存储，不引入解析器自有存储。

| 包 | 角色 | ctx 键 |
|---|---|---|
| `attachment/` | 不可变文件/图片/文档引用、准入限制与存储服务 | `ctx.attachments` |
| `attachment-local/` | `DSH_HOME` 下的私有内容寻址存储 | （提供 `ctx.attachments`） |
| `document-parser/` | 解析提供方注册表与 Markdown 直接上下文合计准入预算 | `ctx.documentParser` |
| `document-parser-mineru/` | 同步外部 MinerU `/file_parse` 提供方 | （注册至 `ctx.documentParser`） |

未发送的浏览器草稿仍位于这项能力族之外。Host 会在所属用户事件前持久化已接受的原始附件字节；组合文档解析器后，还会把 Markdown、`content_list` 与提取图像保存为不可变附件对象，并只在 session 中记录它们的持久引用。
