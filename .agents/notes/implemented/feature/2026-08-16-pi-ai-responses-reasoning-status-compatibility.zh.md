# Agent Note: OpenAI Responses reasoning 状态兼容

Status: implemented

[English](2026-08-16-pi-ai-responses-reasoning-status-compatibility.md) | 中文

## 问题

OpenAI Responses 输出的 reasoning 项可能携带响应侧 `status` 字段，pi-ai 会把完整项目保存在 signature 中，以便后续请求回放提供方原生 reasoning。部分 OpenAI 兼容网关接受 reasoning 回放，却会在该项目回到 `input` 时拒绝此字段，使每次续聊都以 `input[n].status unknown_parameter` 失败。新会话在产生相关历史之前可以工作，而长会话会因此完全无法继续。

不能全局删除该字段。assistant `message` 项与 tool-search 项同样携带 `status`，且网关探针确认 message status 可被接受。实际失败项明确是 `type: reasoning`；递归删除会在没有证据的情况下改变无关协议元数据。

## 决策

`PiAiProviderProfile` 新增默认关闭的 `responsesCompatibility.omitReasoningInputStatus`。启用它必须显式配置 `api: openai-responses`，因为该调整属于此协议，而没有 API 覆盖的 catalog 路由可能包含不同协议的模型。

适配器只为已启用路由提供 pi-ai 支持的 `onPayload` 回调。pi-ai 在构造完整 Responses 请求之后、OpenAI SDK 发出请求之前调用它。回调浅拷贝请求及其 `input` 数组，仅从顶层 `type: reasoning` 项删除自身的 `status` 属性，并保持 message、工具、内容、顺序、id 与其他所有请求字段不变。没有匹配项时，回调不返回替换 payload。

模型设置编辑器只在 pi-ai 路由的有效协议恰好为 `openai-responses` 时，于「自定义设置」中显示一个二元控件。它通过既有路径操作写入嵌套字段，关闭时删除叶子，并保留该卡片不拥有的所有 profile 字段。

## 曾考虑的替代方案

- **把路由切到 Chat Completions。** 否决，因为这会改变提供方协议、回放表示与缓存行为，而不是纠正 Responses 中唯一不兼容的字段。
- **递归删除所有 `status`。** 否决，因为已被接受的 assistant 与工具元数据会在没有网关需求证据的情况下被改写。
- **改写持久化 replay state。** 否决，因为存储状态是提供方响应的无损记录；兼容处理属于出站路由，且必须可以按提供方撤销。
- **始终省略 reasoning status。** 否决，因为 OpenAI Responses schema 接受该字段，现有兼容端点必须保持默认请求逐字节不变。

## 后果

选项启用前，现有路由完全不变。启用后，路由可以通过能力较窄的网关继续原生 Responses 会话，同时保留 reasoning id、summary、encrypted content、assistant message status 与工具历史。启用会改变历史请求 JSON，因此首次兼容请求可能无法命中由未调整表示建立的缓存前缀；后续缓存复用仍由提供方决定。

该功能不增加提示词文本、session event 或持久化格式。配置校验、适配器请求测试、真实 Loader 组合与模型设置流程共同提供回归证据。对所报告长会话的重建产生了 492 个 Responses input 项；调整从 105 个 reasoning 项删除 status，保留 114 个 assistant message status，且上游完成了请求。
