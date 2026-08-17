# Agent Note: OpenAI 兼容模型能力与图片生成

Status: proposed

[English](2026-08-14-openai-compatible-model-capabilities-and-image-generation.md) | 中文

## 问题

模型设置页可以创建手工声明的 pi-ai 提供方，但页面把它呈现为泛化的自定义提供方。用户无法立即识别 OpenAI 兼容网关，也看不到默认上下文容量、输出容量，或在所属的提供方和模型上声明图片输入与输出。上下文窗口和最大输出 token 只藏在折叠的模型行中。

持久附件设计已经提供助手图片引用和渲染，但没有生产提供方路径可以生成图片。没有执行路径的图片输出勾选项会承诺运行时无法生成的结果。

## Proposal

### 一个配置 owner

<code>llm-pi-ai</code> 提供方 profile 继续作为提供方路由、端点、凭据引用、聊天协议、容量、输入模态和输出模态的唯一存储 owner。

- 提供方默认值使用 <code>defaultContextWindow</code>、<code>defaultMaxTokens</code>、<code>defaultInput</code> 和 <code>defaultOutput</code>。
- 模型条目和覆盖使用 <code>contextWindow</code>、<code>maxTokens</code>、<code>input</code> 和 <code>output</code>。
- 输入 <code>image</code> 启用已有图片理解提示词路径。
- 输出 <code>image</code> 使模型可用于图片生成操作，不表示普通聊天流直接输出图片。
- 声明图片输出的路由必须指定 <code>imageApi: openai-images</code>，不能从端点推断能力。

设置 UI 增加 **OpenAI 兼容提供方** 入口，同时保留其他协议的高级入口。它展示提供方默认上下文窗口、最大输出 token、图片理解和图片生成；模型行展开区提供等价的逐模型覆盖。

### 运行时路径

<code>dsh-llm</code> 在流式操作旁新增按提供方路由的图片生成操作，并使用与聊天相同的提供方、模型和凭据路由。<code>agent-loop</code> 不修改：scoped 图片生成工具调用 <code>ctx.llm</code> 并返回普通工具结果。

<code>dsh-llm-pi-ai</code> 只为解析后输出包含 <code>image</code> 且 profile 指定 <code>openai-images</code> 的模型实现该操作。它向已配置 base URL 的 <code>/images/generations</code> 发送一个提示词，并要求 <code>b64_json</code>。提供方 URL 会被拒绝而不会下载。

适配器按附件策略限制收到的响应，解码、校验并通过已有附件服务保存图片，再返回 <code>ImageAttachmentRef</code>。工具以图片内容返回这个引用。现有工具结果持久化和助手图片渲染会直接消费它，无需新增 agent-loop 事件或第二个图片存储。

### 包归属

| 分类 | Owner | 改动 |
| --- | --- | --- |
| 主 capability 路径 | <code>packages/llm/llm</code> | 增加输出模态元数据和按提供方路由的图片生成。 |
| Provider 插件 | <code>packages/llm/llm-pi-ai</code> | 解析输出模态、校验 <code>openai-images</code>、调用 Images API 并持久化返回图片。 |
| Tool 插件 | 新增 <code>packages/extensions/tool-image-generation</code> | 将操作提供给 agent，并返回持久图片引用。 |
| 设置 UI 插件 | <code>packages/client/ui-settings-models</code> | 增加 OpenAI 兼容入口、提供方默认值和逐模型能力控件。 |
| 复用模块 | <code>packages/attachment/*</code>、<code>packages/client/ui-conversation</code>、工具结果投影 | 原样保存、持久化并渲染图片引用。 |
| 明确不改 | <code>packages/core/agent-loop</code>、<code>packages/core/session</code>、<code>packages/host/apiproxy</code> | 已有工具生命周期和持久图片内容提供执行与历史路径。 |

该提案扩展[持久附件决策](../../implemented/feature/2026-07-22-web-multimodal-image-input-and-durable-attachments.md)。实现后，原 Note 中“尚无生产图片输出提供方”的事实会在原处更新。

### 用户路径与失败反馈

1. 用户选择 **OpenAI 兼容提供方**，填写端点和密钥，再选择聊天协议。
2. 用户设置提供方默认值，并添加继承或覆盖上下文、输出 token、图片理解和图片生成的模型。
3. 只有声明图片输入的模型才接受图片提示词。
4. agent 使用图片生成工具，并指定支持图片输出的模型和提示词。生成图片会作为持久工具结果图片出现。
5. 不支持的模型、缺少图片 API 声明、提供方拒绝、非 base64 输出、响应过大、图片无效或附件失败都会返回可操作错误，且不会发布半成品图片块。

## Alternatives considered

**只重命名现有自定义提供方卡片。** 这能改善发现性，但默认能力仍不可见，也不能让图片生成真正可用。

**只增加图片输出勾选项而不增加运行时操作。** 现有聊天流携带文本、推理和工具调用，不携带生成图片。这会形成错误的能力承诺。

**让 <code>agent-loop</code> 直接调用 Images API。** 提供方协议、端点、凭据、附件和输出格式属于 LLM adapter。通过 LLM capability 的工具可以让这些逻辑留在 loop 外。

**创建平行的图片提供方 settings namespace。** 这会复制端点、凭据和模型事实。pi-ai provider profile 已经拥有这些事实。

**下载提供方图片 URL。** 响应 URL 会引入由外部响应控制的远程请求。要求 <code>b64_json</code> 可以限制适配器只处理已配置请求返回的字节。

## Acceptance criteria

- 模型页有可识别的 OpenAI 兼容路径，并展示默认上下文、输出 token、图片输入和图片输出设置。
- 模型继承或覆盖每个默认值，且不会重建无关 profile 字段。
- 图片输入模型使用已有提示词路径；纯文本模型会在附件持久化前被拒绝。
- 一个 <code>openai-images</code> 模型可通过图片生成工具生成一张持久图片。
- 图片通过 <code>AttachmentStore</code> 保存，在会话中渲染，并在重载后仍可读取。
- 畸形结果和失败不会发布半成品图片块。
- PR 归属图列出主 LLM seam、adapter、tool、UI 插件、复用模块和未修改的 agent loop。

## Risks

OpenAI 兼容网关可能支持聊天却拒绝 Images API。UI 要求显式图片 API 配置，不从模型名称推断支持。第一版只接受 <code>b64_json</code>；返回临时 URL 的网关会保持不支持，直到出现经过独立审阅的下载策略。

图片生成会产生外部成本。工具使用既有 approval policy，不创建队列、隐藏重试或 fallback 路径。
