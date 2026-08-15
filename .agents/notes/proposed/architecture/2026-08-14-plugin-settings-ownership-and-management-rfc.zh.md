# Agent Note: 插件设置归属与管理 RFC

Status: proposed

[English](2026-08-14-plugin-settings-ownership-and-management-rfc.md) | 中文

## 问题

Harness 的配置由插件拥有，但用户会在多个入口遇到它：模型设置、通用设置、preset 设置、提供方专属 section 和本地 YAML 文件。UI 可能展示某一层的字段，而运行时读取的是另一层继承后的值，因此一个 checkbox 可能描述“没有 override”，而不是描述模型的实际能力。

Web search 是一个具体例子。发布的 composition 选择了 DeepSeek search provider 和默认凭据，即使当前 agent 使用的是另一个 provider 和模型。于是用户会在一次本应跟随当前模型路由的搜索操作中收到 DeepSeek API key 错误。

配置文件操作是另一个例子。浏览器中的 Harness 可以有本地 settings document，但当前 Host 可能没有桌面 opener。UI 需要 Host 宣布能力，不能自行假设这个操作可用。

## Proposal

### 每个配置事实只有一个 owner

消费某项配置事实的插件拥有它的 schema、settings namespace、默认值、校验和生效时机。Settings UI 渲染注册 descriptor，不重新创建 provider 默认值，也不从标签推断运行时能力。

| 事实 | Owner | Settings 表示 |
| --- | --- | --- |
| Provider 端点、协议、凭据引用 | Provider 插件 | Provider namespace 中的 profile。 |
| 模型 ID、上下文窗口、输出上限、输入/输出模态 | Provider 插件 | Provider profile 内的模型条目。 |
| 新 agent 的默认 provider 和模型 | <code>dsh-agent-default-model</code> | <code>agent-default-model</code> namespace。 |
| 搜索请求路由 | Web search consumer/provider | 从当前 agent 模型选择解析，不在发布 profile 中固定 DeepSeek 路由。 |
| 是否能打开本地文档 | Host apiproxy | <code>settings.describe</code> 中的 capability 字段。 |

Consumer 可以读取另一个插件的 public service，但不能复制该插件的 settings schema，也不能为同一事实保存第二份值。

### Effective value 与 override

Settings descriptor 同时暴露解析后的 value、composition base 和 raw user layer。UI 控件按以下优先级工作：

1. 展示运行时实际读取的 effective value。
2. 当 value 来自 schema 默认或 composition base 时，标记为 inherited。
3. 只有用户修改字段时才写入 override。
4. Reset 通过删除 user-layer path，让 value 重新解析。

Provider 默认值和模型条目保持区分。模型行是模型容量和模态的事实来源。Provider 默认值可以为新模型提供初始值，但在描述已有模型时不能覆盖该模型的已知能力。

UI 使用紧凑的状态标记和控件，不在普通字段旁增加解释实现细节的长段落。

### 当前模型搜索

搜索工具跟随当前 agent 选择的 provider 和模型。session agent 有明确路由时使用该路由，否则使用运行时默认选择。Search provider 在操作开始时解析所选 provider profile 和凭据引用。

第一版当前路由实现支持 OpenAI Responses profile。它使用所选模型和 provider 凭据向配置的 Responses endpoint 发送内置 web search 工具请求，拒绝 redirect，并把 URL citation 映射为 web result。已有 DeepSeek Anthropic Messages provider 继续保留，供显式选择它的 deployment 使用。

协议不支持当前 web search operation 的 provider 返回稳定的 unavailable 错误。搜索路径不会静默替换成 DeepSeek 凭据或模型。

### Host 拥有配置文件打开能力

Settings API 报告 Host 是否能用 native editor 打开本地 text document。浏览器只有在 document 存在且 capability 为 true 时显示该操作。请求不携带路径；Host 解析并打开 settings provider 自己的 document。

因此 headless Web 进程可以提供 settings 编辑，但不会显示一个必然失败的 native-open 按钮。Desktop manager 继承平台 opener，继续打开同一个 settings document。

## Ownership map

| 范围 | Owner | 本 RFC 中的责任 |
| --- | --- | --- |
| Settings registry | <code>packages/settings/settings</code> | 分层 schema、默认值、用户值、revision 和生效时机。 |
| Settings wire 与 Host capability | <code>packages/host/apiproxy</code> | 脱敏 descriptor、无路径 document open 和 native opener availability。 |
| Settings 展示 | <code>packages/client/ui-settings-general</code> 及 provider UI 插件 | 渲染 descriptor 和 effective value，不复制运行时规则。 |
| 模型选择 | <code>packages/core/agent-default-model</code> 与 agent-scoped selection | 提供 agent 和辅助 consumer 使用的路由。 |
| Search consumer | <code>packages/web/web-search-deepseek</code> | 适配当前 provider/model 路由，或显式选择的 DeepSeek 路由。 |
| 明确不改 | <code>packages/core/agent-loop</code>、session persistence、attachment storage | 不需要修改 loop 协议或持久 session 格式。 |

## Alternatives considered

**由 Web UI 拥有中央 settings schema。** 这会让浏览器成为 provider 行为的 authority，并与 headless、desktop composition 漂移。Schema 继续由插件拥有。

**只显示原始 YAML。** 原始 YAML 适合高级用户，但不能展示 effective value、凭据状态或生效时机。它保留为 escape hatch，不作为主要管理方式。

**搜索继续固定 DeepSeek，只修改错误文案。** 这会隐藏依赖不匹配，且在用户配置其他 provider 时仍然失败。搜索必须解析当前路由。

**从模型 ID 推断 provider 能力。** 模型名称不是协议合同。能力来自 provider 的解析模型条目或明确的 adapter 声明。

## Discussion questions

- Settings shell 是否应自动展示每个注册 namespace，还是由每个插件通过 presentation order opt in？
- inherited 和 overridden 是否应在所有 provider editor 中使用统一的紧凑状态标记？
- OpenAI Responses 之后，current-model search adapter 应支持哪些 provider 协议？
- 当前模型不支持 web search 协议时，是隐藏 search tool，还是保留工具并返回明确 unavailable result？
- 哪些 restart-required 设置需要在 desktop tray 中统一显示 pending restart？

## Acceptance criteria

- Settings UI 能区分模型的 effective value 与不存在的 user override。
- 搜索请求使用当前 agent 的 provider、模型和凭据引用，或返回稳定的 unsupported-route 错误。
- Headless Host 不会宣传它无法执行的 native document 操作。
- Provider 专属 schema 继续作为 provider 和模型字段的 authority。
- 未来 Settings shell 可以新增 namespace，而不把 owner 移到浏览器。

## Risks

不同 provider 协议没有统一的 web-search 请求格式，因此 current-model adapter 必须拒绝不支持的协议，不能静默 fallback 到另一套凭据或模型。Native opener capability 依赖真实桌面桥接；环境判断不能只凭 kernel label 宣称支持。

## Decision boundary

本 RFC 建立 owner 和数据流规则。不新增 universal settings dashboard，不把所有插件迁移到一个页面，也不声称所有 provider 都支持 web search。每个新增 provider adapter 和 settings 展示仍是独立的 review change。
