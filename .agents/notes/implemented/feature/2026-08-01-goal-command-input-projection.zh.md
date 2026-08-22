# Agent Note: Goal 命令输入投影

Status: implemented

[English](2026-08-01-goal-command-input-projection.md) | 中文

## 问题

面向用户的命令在模型轮次之外执行，并持久化为 `command/run` 与 `command/done`。Web transcript（文本记录）此前只渲染结果行。因此，在新会话中，`/goal` 会清空编辑器并成功完成，但页面仍停留在空白 Hero；只有后续对话内容激活 Chat 后，结果才会显示。若处理器追加普通 `user/message`，将改变模型可见历史与命令语义。

## 决策

命令注册表与持久命令生命周期保持不变。`command/run` 记录由解析器提供的名称、可选的原样参数、来源和调用 id；`command/done` 记录结算。两条事件都不携带浏览器呈现意图。

`ui-goal` 客户端插件会在通用命令 Definition 之外注册一个归 Goal 所有的 Conversation Definition。两者都匹配同一条 `/goal` `command/run`：通用 Definition 保留持久结果行，Goal Definition 则在更早的分数锚点构建独立的 `command-input` Chat Node。Goal 插件还为该 Node 注册 keyed React renderer。它的本地组件只复用用户气泡的右对齐几何形态和语义 token，使用 14px/22px 等宽字体文本，并且不挂载时间戳、复制或分支操作。

`Session.composerPhase` 会把 Host blank bit 为 false 视为 active，因此持久 `command/run` 会激活通用命令结果、让 Session 进入列表，并阻止 New Session 复用。Goal 自有的 `command-input` 还会把发起文本呈现为 human transcript content（[可见命令历史决策](../bug-fix/2026-08-22-visible-command-history-ends-new-session-reuse.md)）。

Goal Definition 根据结构化 run 派生 `/<name><args.trimEnd()>`：分隔符与内部多行输入保持不变；在已认领的裸命令形式中，参数只有一个空格时显示 `/goal`。仅包含 `command/done` 的历史窗口没有匹配的 Goal Context，因此会保留通用结果行，而不会虚构输入气泡；加载包含更早 run 的页面后，两个 Node 都会恢复。

模型边界保持不变。Goal 投影不会创建 `user/message`、`turn/start`、`step/start` 或 `request/header`。已接受的 goal 变更只会通过 goal 领域现有的 `<goal_state>` 快照或 clear tombstone 到达模型，与 `command-input` Node 无关。

## 验证

Goal 客户端测试固定双 Definition 输出、顺序、排除其他命令、裸命令与多行文本、仅含 done 的切分窗口、renderer 语义、资源释放和新会话 phase 选择。无密钥的完整组装 Web 场景在不含模型适配器的新会话中提交 `/goal clear`，验证其输入与无 Goal 结果，在任何 reload 之前新建干净的欢迎 Session，并看到旧命令消失且 composer 为空。

## 备选方案

**在 `/goal` 处理器中追加 `user/message`。**不予采纳，因为该命令会变成模型输入，并可能触发或改变后续请求。

**向命令注册表与持久事件添加呈现意图。**不予采纳，因为一个 Goal 视图会扩大通用命令接口，并要求 Session、Chat 和每个命令 fixture（测试前置数据）都携带浏览器呈现状态。现有 `command/run` 的名称和参数已足以让组合后的 Goal 客户端重建自有视图。

**让通用命令 renderer 识别 `/goal`。**不予采纳，因为命令专用视图的构建归 Goal 客户端插件所有。在组合中移除该插件后，气泡必须随之消失，且命令执行和通用结果行不能改变。

**把每条命令输入都渲染为用户气泡。**不予采纳，因为通用结果行已足以披露控制命令历史。把每次调用都呈现为 human transcript content 会在没有功能自有 Conversation Definition 的情况下扩大交互语义。

## 后果

一条持久 `/goal` run 会向两个各自独立归属的视图 Context 提供数据，而不改变命令能力。在组合中移除 `ui-goal` 后，普通命令执行及其结果行保持不变。实时标签页与冷重载会得到一致结果，因为两个视图都派生自同一条 run。页面切分只保留 `command/done` 时，会暂时只显示结果行；加载包含更早 run 的页面后会恢复输入 Node。完整日志中的 `command/run` 会让 Session 保持 active、可见且不能用于 blank reuse，即使模型 turn 尚未开始。
