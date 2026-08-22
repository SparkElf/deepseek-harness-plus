# Agent Note: 可见命令历史终止新会话复用

Status: implemented

[English](2026-08-22-visible-command-history-ends-new-session-reuse.md) | 中文

## 问题

一个全新的 Web 会话可以执行斜杠命令并渲染持久命令内容，但 Host 仍把该会话报告为空白。Goal 命令会直接暴露这项矛盾：`/goal clear` 渲染输入气泡与结果后，点击「新建会话」会让 Workspace runtime 请求可复用空白会话，得到同一个会话 id，并继续显示旧命令，而不是进入欢迎页。

Host 只按缺少 `turn/start` 定义 `SessionSummary.blank`。这个定义把命令生命周期事件视为可复用，尽管 `command/run` 是持久的用户历史，而且 Client 会把其通用结果投影到 active conversation。Workspace runtime 正确地信任 Host summary；只修点击 handler 或某个 UI plugin 会让 reload 与其他命令会话继续不一致。

## 决策

Host 的列表元数据投影是新会话复用资格的唯一 owner。只有日志同时不含 `turn/start` 与 `command/run` 时，会话才保持 blank。同一个 `startsSessionHistory` predicate 驱动已挂载 summary 与增量投影更新。权威的实时 `session/event(command/run)` 到达时，Client 会复用 accepted prompt 的同一个单调 engaged mutation，降低既有 list mirror 与 resident Session；它不作独立复用决策。实时导航、cold log 验证、reload 与 Workspace 复用因此无需第二个字段就能保持一致。

`plan/mode`、标题、permission、sandbox 与 approval 事件等被动 plugin 状态本身不会终止空白复用。被拒绝的普通 prompt 没有已接受的 turn 或 command，仍可复用。任何命令生命周期都会在 `command/run` 时终止复用，不等待结果 settled。

Wire 不变：`SessionSummary.blank` 与 `host/session-added.blank` 承载 baseline，既有 `session/event(command/run)` 承载实时转换证据。Workspace runtime 仍复用符合条件的成员空白会话，并在不存在时创建会话。

本决策部分取代 [Web session-scope 决策](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.md)、[Goal command-input projection](../feature/2026-08-01-goal-command-input-projection.md)、[bounded cold verification](2026-08-13-bounded-cold-blank-verification.md) 与 [Workspace reuse membership 修复](2026-08-05-workspace-blank-session-reuse-membership.md)中只按 turn 判断 blank 的陈述。它们的 composition、cold read 与 membership 决策继续有效。

## 考虑过的替代方案

**在 Client 修补新建会话。** 当前渲染会话可以披露 active composer phase，但隐藏 blank 与 reload 仍依赖 Host summary。Client exclusion set 会复制持久状态，并在 reload 后失去权威性。

**增加第二个 `reusable` summary 字段。** 一旦命令建立持久历史，复用与列表可见性具有同一项用户合同。第二个 bit 会增加 schema、cache、frame、fixture 与 migration 工作，同时允许互相矛盾的组合。

**新建会话时总是创建。** 这样可以避免错误复用，但用户从已经为空的页面重复点击新建会话时，会积累隐藏且从未使用的 blank。复用真正为空的 Workspace member 仍是有界行为。

## 后果

只有命令的会话会激活其通用结果并出现在会话列表中，也不能成为后续新建会话动作的目标。Agent preset switching 同样会在命令后关闭，因为它消费同一个权威 blank bit；命令行为与后续模型 turn 因而保持同一套 composition。模型边界不变：除非命令 handler 本身已有相应行为，命令执行仍不会创建 user message 或 model turn。

## 验证

Host blank projection 测试区分被动状态、`command/run` 与 `turn/start`；plan-active semantic golden 固定通用命令结果取代欢迎 Hero。无密钥的真实 Host Goal 浏览器旅程会执行 `/goal clear`，在任何 reload 之前点击新建会话，观察欢迎页出现、composer 为空且旧命令消失。验收在运行中的 Web GUI 上使用同一路径，不使用 route interception、直接 API 调用或 screenshot 通过标准。
