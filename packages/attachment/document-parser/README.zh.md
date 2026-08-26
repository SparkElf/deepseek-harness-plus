# @deepseek-ai/dsh-document-parser

[English](README.md) | 中文

DeepSeek Harness 的提供方中立外部文档解析能力。本包拥有 `ctx.documentParser`：解析提供方注册表，以及版本一完整文档直读文本的字节预算。它本身不解析 PDF 或 Office 文件；具体实现注册 `DocumentParserProvider`，Host 只有在原始文档已经通过 [`@deepseek-ai/dsh-attachment`](../attachment/README.md) 持久化之后才调用选中的提供方。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `provider` | 自动选择 | 解析提供方 id。省略时，必须恰好存在一个已注册提供方。 |
| `maxDirectMarkdownBytes` | 必填 | 一次提交中所有文档完整模型可见文本（含分隔符与元数据）的正安全整数合计字节上限。 |

```yaml
- id: document-parser
  name: '@deepseek-ai/dsh-document-parser'
  config:
    provider: mineru
    maxDirectMarkdownBytes: 1048576
```

提供方选择与注册顺序无关。配置的提供方缺失、没有已注册提供方，或存在多个已注册提供方时都会通过 `DocumentParserError` 明确失败；运行时不会静默切换到另一个后端。提供方包在加载时校验执行配置。`isSelectionResolvable()` 只报告当前注册表状态是否选中一个提供方，Host 据此决定是否发布文档选择器策略；它不探测端点健康状态。

## 生命周期

Host 先持久化本次提交中所有已通过准入的原始文档，再对每个文档调用 `ctx.documentParser.parse(...)`，把各自解析结果通过现有附件存储持久化，最后才追加所属用户消息。`maxDirectMarkdownBytes` 会在事件追加前检查全部文档完整模型可见文本（含各自分隔符与元数据）的合计字节数。因此解析失败可能留下未被引用的不可变附件对象，但不会留下其模型可见内容无法重建的持久用户消息。

解析结果是临时字节：完整 Markdown、完整 `content_list` JSON，以及零个或多个提取出的栅格图像。持久 session 状态只记录 Host 创建的附件引用。

## 模型体验

### 解析文档投影

#### 模型看到什么

每个已接受的 `DocumentBlock` 都会以完整 UTF-8 Markdown、置于明确的文档分隔标记之间，送给文本模型。session 历史只保留原件与解析产物引用；超过预算的完整渲染文本会被拒绝，而不是被截断。

#### Token 影响

每份已接受文档都会把完整渲染文本加入包含其持久消息的每次请求。token 数取决于提供方 tokenizer；版本一不执行切块或选择性检索。

#### KV Cache 影响

解析文档在其持久消息位置成为普通模型可见文本，因此从该消息开始，它对请求前缀的影响与等价用户文本相同。解析 seam 不引入隐藏的缓存失效或提供方私有文件状态。

## 已知限制与后续工作

- **版本一仅支持直接上下文。** 不包含自动切块、embedding、向量数据库、重排或文档 RAG 工作流。
- **解析位于 prompt 准入的同步路径。** 如果以后需要后台处理，其生命周期应由 Harness jobs 拥有，而不是持久化外部解析器 task id。
- **seam 只标准化最终解析产物。** OCR 策略、公式、表格、解析后端选择和服务特定调参仍属于提供方/部署关注点，直到出现明确的提供方中立需求。
