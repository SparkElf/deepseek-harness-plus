# Agent Note: 已发布 subagent 入口的实时 Web 设置

Status: implemented

[English](2026-08-16-web-subagent-settings.md) | 中文

## 问题

Web 部署包含两个具体的委派入口，但它们已有的子 agent 默认字段只能在组合文本中配置。若浏览器页面把这些值复制到无关的产品设置里，界面看似可配置，却不会改变子 agent 的创建请求。

Web overlay 还禁用了两个入口。被禁用的插件不能注册自己的 settings 命名空间，因此页面无法识别真实入口，也无法持久化其执行器会读取的值。

## 决策

`dsh-tool-subagent` 接受可选的 `settingsNamespace`，并在每次新建子 agent 时读取这个由 Host 注册的分区。它的 `/startup` 子路径独立持有 `enabled`、`agentOptions`、`persona`、`toolFilter` 与 `maxDepth` 的 Host 生命周期注册。已配置的提供方会在 Agent 工具挂载时以及 Host owner 接受保存值时校验能力。

Web 基础组合为 `subagent` 与 `subagent-fork` 注册 Host 生命周期 owner；每个 Agent preset 再把这两个名称绑定到自己的 spawn/可继续与 fork/一次性工具。这样 Settings 注册保持唯一，工具生命周期则跟随 preset。Host 服务这两个已注册命名空间，`ui-settings-plugins` 在独立的“子代理”导航分区中用一张卡片的两个标签呈现它们。该分区从浏览器共享 Settings 镜像派生，并通过绑定的 Settings scope 只替换当前选择的命名空间。[安全的子代理默认值与统一设置](../bug-fix/2026-08-26-safe-subagent-defaults-and-unified-settings.md)负责这项展示和实时启用开关。

每个模式标签按名称显示其已发布入口，并把编辑区域限定为该入口的启用状态与既有子 agent 默认字段。提供方绑定、工具名称、后台模式和入口身份仍是组合选择，不在浏览器中编辑。

## 曾考虑的替代方案

**创建仅 Web 使用的子 agent 方案。** 当前 `dsh-tool-subagent` 没有方案、摘要、选择性父级上下文或命名评审角色对应的字段或执行行为。展示它们会创造无法影响子 agent 请求的选项。

**为每个提供方公开一个通用表单。** 外部提供方可能不支持 persona、工具过滤或深度强制。第一个页面只针对能力已知的两个已发布进程内入口；通用提供方目录需要能力驱动的 UI 处理。

**让浏览器修改入口身份。** 改变提供方、工具名称或可继续策略会改变路由和面向模型的行为。这些选择仍是组合配置；实时设置负责启用已有入口并改变其子 agent 默认值。

## 后果

保存子 agent 默认值会应用于后续子 agent 运行，不改变已经创建的子 agent。模型覆盖可以省略，以继承父级，同时仍可设置输出 token 上限。省略 persona 会保留部署角色，工具可见范围仍是可信进程中的组合限制，而不是授权系统。

子代理分区不添加任务摘要、选择性历史继承、自动模型选择、预算或内置子 agent 角色。未来的提供方入口必须先拥有能力驱动控件，才能加入该分区。
