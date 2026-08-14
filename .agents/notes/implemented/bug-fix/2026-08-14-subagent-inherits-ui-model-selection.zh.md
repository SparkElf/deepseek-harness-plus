# Agent Note: Subagent Inherits UI Model Selection

Status: implemented

[English](2026-08-14-subagent-inherits-ui-model-selection.md) | 中文

## Problem

父会话可以在 Web UI 中选择模型，但新委派出的子智能体会从部署默认值启动。子智能体因此可能路由到没有凭据的提供方，或使用与父任务不一致的模型。

## Decision

`resolveChildAgentOptions()` 优先从父会话最近一次 `request/header` 配置中解析 provider、model、推理强度和 `maxTokens`，没有已记录请求时再使用父级 `AgentOptions`；子级请求显式给出的覆盖值仍然优先。Web 模型选择只会对 durable origin 为 `subagent` 的空白会话使用这些已解析 options。子级自身已记录的请求和本进程内选择仍保持原有的更高优先级；普通空白会话继续观察动态的全局默认值。

## Alternatives considered

**只复制父级 AgentOptions。** Agent options 无法反映 Web 会话之后发生的模型切换，仍然会留下已经观察到的回退缺陷。

**在创建时为每个新会话写入全局默认值。** 普通空白会话本来就会跟随创建后保存的默认值，改变这条规则会让无关会话变成陈旧状态。

**向 Web UI 暴露子级模型目录。** 子级没有独立的模型选择界面。正确的路由应在委派创建时确定，而不是增加一个子级根本无法使用的 UI 操作。

## Consequences

除非委派请求显式覆盖，子智能体会以父会话选中的 provider、model、推理强度和输出上限启动。Web 网关继续让普通空白会话使用动态默认值。进程内委派和 API Proxy 选择的聚焦测试共同保护这条优先级规则。
