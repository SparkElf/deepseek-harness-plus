# @deepseek-ai/dsh-document-parser

[English](README.md) | 中文

DeepSeek Harness 的提供方中立外部文档解析能力。本包拥有 `ctx.documentParser`：解析提供方注册表，以及版本一的 Markdown 直接上下文字节预算。它本身不解析 PDF 或 Office 文件；具体实现注册 `DocumentParserProvider`，Host 只有在原始文档已经通过 [`@deepseek-ai/dsh-attachment`](../attachment/README.zh.md) 持久化之后才调用选中的提供方。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `provider` | 自动选择 | 解析提供方 id。省略时，必须恰好存在一个可用的已注册提供方。 |
| `maxDirectMarkdownBytes` | 必填 | 一次提交中所有文档完整解析 Markdown 合计允许的正安全整数字节上限。 |

```yaml
- id: document-parser
  name: '@deepseek-ai/dsh-document-parser'
  config:
    provider: mineru
    maxDirectMarkdownBytes: 1048576
```

提供方选择与注册顺序无关。配置的提供方缺失或不可用、没有可用提供方，或存在多个可用提供方时都会通过 `DocumentParserError` 明确失败；运行时不会静默切换到另一个后端。

## 生命周期

Host 先持久化本次提交中所有已通过准入的原始文档，再对每个文档调用 `ctx.documentParser.parse(...)`，把各自解析结果通过现有附件存储持久化，最后才追加所属用户消息。`maxDirectMarkdownBytes` 会针对该提交中全部文档完整 Markdown 的合计字节数在事件追加前检查。因此解析失败可能留下未被引用的不可变附件对象，但不会留下其模型可见内容无法重建的持久用户消息。

解析结果是临时字节：完整 Markdown、完整 `content_list` JSON，以及零个或多个提取出的栅格图像。持久 session 状态只记录 Host 创建的附件引用。

## 模型体验

通过 Host 文档准入与 LLM 请求投影间接生效。被接受的已解析文档会以完整 UTF-8 Markdown、置于明确的文档分隔标记之间，送给文本模型；session 历史只保留原文档与解析产物引用。一次提交中文档的解析 Markdown 合计超过所配置直接上下文预算时会被拒绝，而不是被截断。

#### KV Cache 影响

解析文档在其持久消息位置成为普通模型可见文本，因此从该消息开始，它对请求前缀的影响与等价用户文本相同。解析 seam 不引入隐藏的缓存失效或提供方私有文件状态。

## 已知限制与后续工作

- **版本一仅支持直接上下文。** 不包含自动切块、embedding、向量数据库、重排或文档 RAG 工作流。
- **解析位于 prompt 准入的同步路径。** 如果以后需要后台处理，其生命周期应由 Harness jobs 拥有，而不是持久化外部解析器 task id。
- **seam 只标准化最终解析产物。** OCR 策略、公式、表格、解析后端选择和服务特定调参仍属于提供方/部署关注点，直到出现明确的提供方中立需求。
