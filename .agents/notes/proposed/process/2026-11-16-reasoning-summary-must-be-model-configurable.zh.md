# Agent Note: 模型必须能够固定或去掉 `reasoning.summary`

Status: proposed

[English](2026-11-16-reasoning-summary-must-be-model-configurable.md) | 中文

## 问题

DashScope 的 OpenAI-Responses 兼容端点提供 `deepseek-v4.1-flash` 与
`deepseek-v4.1-flash-1017`，但会拒绝每一个携带 `reasoning.summary` 的请求。
它接受该字段三个记录在案的值（`auto`、`concise`、`detailed`），随后以如下
错误让整轮回复失败：

```
<400> InternalError.Algo.InvalidParameter: 'thinking_display=summarized'
is not supported by this model
```

——DashScope 把 `reasoning.summary` 翻译成它自己的 `thinking_display` 字段，
再把翻译后的值报为不支持。2026-11-15 对线上端点实测：只发
`reasoning: {effort: "max"}` 返回 200 并带回完整的 `reasoning` 条目；加上任意
`summary` 值都会让整轮回复失败。同一端点接受 `/responses` 上的
`thinking_display=summarized`，所以这次拒绝针对的是 summary 的翻译，而不是
思考展示本身。

只要一个 Responses 模型在推理，`pi-ai` 就无条件写入该字段（其
`openai-responses` 适配器中为 `summary: options?.reasoningSummary || 'auto'`）。
因此，为这类模型声明了 `reasoningEfforts` 的路由连一轮都无法完成：模型变得
不可用，而不是仅仅少了摘要文本。现有的 `compat` 开关都无法触及该字段——
`PiAiCompatProfile` 的 24 个字段已逐一核对，适配器的 `summary` 默认值不在其中。

三条纯配置的规避路径各自的代价，都是本次部署无法付出的：

- 去掉 `reasoningEfforts` 会关闭思考。该模型正是因为推理能力而被选用。
- 换用 `deepseek-v4-pro` 保住了推理，但换掉了模型。该 pin 是有意为之。
- 从 `pi-ai` 适配器里删掉该字段会影响所有路由上的每个 Responses 模型，包括
  那些网关本就接受 `reasoning.summary` 的模型。

## 提案

在模型条目中新增 `reasoningSummary`，与 `compat` 并列：

```yaml
- id: deepseek-v4.1-flash-1017
  reasoningSummary: omit        # or auto | concise | detailed
```

`omit` 会把该字段从请求体中移除；指定某个值则会固定该值。省略时保持
`pi-ai` 自身的默认行为，因此所有现有路由都不受影响。

该值通过 `pi-ai` 已有的 payload 钩子上线，本包已用同一钩子实现
`responsesCompatibility.omitReasoningInputStatus`。`payloadOptions` 会把两处调整
组合成一个 `onPayload` 函数，而不是让任一者取代另一者，因为 `onPayload` 是单个
函数字段。

该开关放在模型级而非路由级，因为这次拒绝是一个模型事实：同一 DashScope 路由上
的其他模型（`deepseek-v4-pro`、`qwen3.8-max`、`glm-5.3`）接受
`reasoning.summary`，必须继续发送它。

## 后果

- 拒绝 `reasoning.summary` 的网关在推理能力保留的前提下变得可用，代价是摘要文本。
- `PiAiReasoningSummary` 是覆盖 `REASONING_SUMMARY_GATE` 的漂移闸门：新增的上游
  取值会在编译期失败，直到被归类——与 `MODALITIES`、`THINKING_LEVELS` 已采用的
  模式一致。
- 该字段承载在物化后的模型上而非路由 profile 上，因此 `resolveModel` 会把它展开
  进描述符，适配器按调用读取。
- `retireWhen` 记录了退役条件：官方 `llm-pi-ai` 提供模型级 summary 设置后，该补丁
  即冗余。

## 与现有 note 的关系

[pi-ai upgrade compatibility](../../implemented/bug-fix/2026-09-05-pi-ai-upgrade-compatibility.zh.md)
归类了哪些 `compat` 字段归部署所有、哪些归 catalog 所有。本 note 新增的设置
刻意**不是** `PiAiCompatProfile` 的成员：这次拒绝是按模型的网关事实，而路由级
compat 字段会把它落到接受该字段的同级模型上。两份 note 回答不同的问题，互不取代。

## 考虑过的替代方案

**在该模型上关闭 `reasoningEfforts`。** 已否决：它让模型不思考就作答，而该模型
正因推理能力被 pin。`pi-ai` 只在 `model.reasoning` 分支内写入
`reasoning.summary`，所以这在机制上可行，但交出了部署想要的能力。

**把路由换成接受该字段的模型。** 已否决：`deepseek-v4-pro` 与 `qwen3.8-max` 在
同一端点上都能通过 `reasoning.summary`，但模型 pin 是有意的，换模型不是针对网关
缺陷的配置修复。

**从 `pi-ai` 适配器删除 `summary` 默认值。** 已否决：只需一行、是最短的补丁，但
`pi-ai` 由所有 Responses 路由共享，这么做会让本就正常提供摘要的网关也失去摘要。
它还会为一个按模型的事实去改 vendored 依赖。

**把开关加到 `responsesCompatibility`（路由级）。** 已否决：该接口是 provider
作用域，设置会落到同一路由的 `deepseek-v4-pro`、`qwen3.8-max`、`glm-5.3` 上，
而它们当前接受 `reasoning.summary`。

## 验收标准

- 声明 `reasoningSummary: omit` 的模型条目发出的请求体不含 `reasoning.summary`
  键，且回复仍带回 `reasoning` 条目。
- 声明 `reasoningSummary: concise` 的模型条目发送 `summary: concise`。
- 未声明 `reasoningSummary` 的模型条目发送 `summary: auto`，与当前行为一致。
- `responsesCompatibility.omitReasoningInputStatus` 与 `reasoningSummary` 可组合：
  路由设前者、模型设后者时，产生一个同时应用两者调整的 `onPayload`。
- 该补丁在所有既有 `dsh-source` 条目之后可干净应用。

## 风险

**两处 payload 调整可能互相静默取代。** `onPayload` 是单个函数字段，同时赋值会
丢掉其中一处。`payloadOptions` 把它们组合成一个函数并依次应用；上面的验收标准
固定了该行为。

**未知的 summary 取值可能到达线上。** `REASONING_SUMMARY_GATE` 在编译期拒绝未归类
的取值，schema 在配置加载时拒绝，因此拼写错误会显式失败，而不是在回合中途由网关
返回 400。
