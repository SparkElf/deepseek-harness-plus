# @deepseek-ai/dsh-document-parser-mineru

[English](README.md) | 中文

Harness [`documentParser`](../document-parser/README.zh.md) 能力的 MinerU HTTP 实现。它注册提供方 id `mineru`，并调用一个由部署方管理的 MinerU 同步 `/file_parse` 端点。Node 包不内嵌 Python、PyTorch、模型权重、GPU 生命周期或 MinerU 进程管理。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `endpoint` | 必填 | MinerU 同步 `/file_parse` 的绝对 URL。 |
| `timeoutMs` | 必填 | 单次解析请求的正数墙钟超时。 |
| `maxResponseBytes` | 必填 | 同时约束压缩 HTTP 响应与 ZIP 解压后总输出的正数字节上限。 |

```yaml
- id: document-parser-mineru
  name: '@deepseek-ai/dsh-document-parser-mineru'
  config:
    endpoint: 'http://127.0.0.1:8000/file_parse'
    timeoutMs: 120000
    maxResponseBytes: 67108864
```

提供方以 multipart 发送原始持久文档字节，请求 Markdown、`content_list`、提取图像和 ZIP 输出。它显式关闭 `middle.json`、原始模型输出和原文件回传，因为 Harness 已经持有原始持久对象。

## 输出校验

成功 ZIP 必须包含恰好一个 Markdown 结果和恰好一个版本一 `content_list` JSON 结果。提取图像只有在其字节属于附件子系统支持的栅格格式时才会被接受。最终产物缺失或歧义、ZIP 格式错误、响应/输出超限、HTTP 失败、中止和超时都会明确失败，并由 Host 保证发生在所属用户事件追加之前。

临时 ZIP 条目路径不会进入 session 状态。Host 通过现有内容寻址附件存储持久化最终 Markdown、`content_list` 和提取图像，session 中只记录持久引用。

## 模型体验

通过文档解析 seam 间接生效。MinerU 的完整 Markdown 是版本一送给文本模型的提供方中立表示，并在请求装配时从持久引用解析。`content_list` 和提取图像保持持久，可供未来 block/page/search 工具使用，但不会自动注入每次模型请求。

#### KV Cache 影响

不引入 MinerU 特定缓存行为。文档一旦被接受，完整 Markdown 就在该文档消息位置表现为普通模型可见文本；解析 HTTP/ZIP 细节永远不会进入模型前缀。

## 已知限制与后续工作

- **仅使用同步 `/file_parse`。** MinerU `/tasks` 标识不会被持久化为 Harness job 状态。
- **当前没有 DSH 自有的大型解析调参界面。** 后端、OCR、表格、公式和 effort 选择遵循所配置 MinerU 部署，直到产品证据支持提供方中立控制项。
- **ZIP 解析器要求每个提交文档对应一组最终 Markdown/content-list。** 多文档批次语义由 Host 准入层以独立解析调用处理。
- **提取图像用于保真持久化，而不是自动注入。** 未来文档工具可利用持久 `content_list` 映射按需检查页面、表格、图表或图像。
