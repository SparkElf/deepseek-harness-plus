# Agent Note: Supervisor 重启与中断会话恢复

Status: proposed

[English](2026-08-14-supervisor-restart-and-interrupted-session-recovery.md) | 中文

## 问题

直接重启 Harness Web 会绕过 desktop Supervisor 的端口 owner、分支身份、进度日志和 takeover 检查。Web 重启后也会停留在旧文档，直到用户手动刷新。如果 Web 进程消失时某个 turn 正在运行，新页面没有恢复动作。设置页还会在存在文档但当前 Linux runtime 没有桌面 opener 时隐藏文档操作。

## Proposal

Supervisor progress API 接收命令和目标分支。目标分支只由 <code>rebuild-and-restart</code> 接受；不带分支的 <code>restart</code> 只在 Supervisor status 已报告的当前分支上运行。请求通过已有本地 Supervisor socket 传输；HTTP 不会直接启动或终止 Web。目标必须是已经存在的本地分支。干净工作树可以切换分支；dirty 工作树只能继续当前分支。同分支 dirty rebuild 可用于汇总分支验收。operation 和 runtime 状态返回请求分支、实际分支、revision、dirty 状态、Web PID 和完成阶段。

现有 client-HMR EventSource 会保留仅插件重建的页面。首次成功打开后，如果 SSE 断开并再次连接，说明 Web runtime 已重启；浏览器会 arm recovery 并整页刷新一次。首次 open 和重复 open 不会刷新。

在丢弃 connection state 前，client runtime 保存 Host 摘要为 running 的 session id。HMR 刷新后，新 runtime 刷新 session list，并通过保留的 SessionFace 发送以下 queue prompt：<code>请继续完成任务，如果都已完成则回复没有未完成的任务即可</code>。prompt 接受后删除 id；session 不存在、刷新失败或 prompt 被拒绝时保持 pending。prompt 使用已有 Host API、session log 和正常 agent 执行。

settings-general header action 只要 Host metadata 报告存在本地文档就注册。当 <code>canOpenDocument</code> 为 false 时，action 保持显示但 disabled，并通过 tooltip 说明当前 runtime 无法调用桌面应用。不会只凭 <code>hasDocument</code> 宣称支持 native open。

## Ownership map

| Surface | Owner | 改动 |
| --- | --- | --- |
| Supervisor | <code>apps/plus-desktop/src/supervisor.mjs</code>、<code>supervisor-progress-server.mjs</code> | 按分支生命周期和进度身份。 |
| Progress UI | <code>apps/plus-desktop/progress</code> | 固定滚动面板、统一品牌、分类日志和带分支命令。 |
| HMR client | <code>packages/client/hmr</code> | 检测 runtime 重连并刷新一次。 |
| Session runtime | <code>packages/client/runtime</code> | 捕获运行中 session，并在刷新后发送恢复 prompt。 |
| Settings UI | <code>packages/client/ui-settings-general</code> | 没有 native opener 时保留可见但 disabled 的文档操作。 |
| 复用 | 既有 settings API、SessionFace prompt、session log、Cordis loader | 不新增 transport 或 agent 执行路径。 |
| 未修改 | <code>packages/core/agent-loop</code>、Host session wire contract、普通 tool lifecycle | 继续使用既有扩展点。 |

## Alternatives considered

**从 shell 直接重启 Web。** 不予采纳，因为这样会绕过 Supervisor 的分支和端口 owner。

**每次插件重建都刷新页面。** 不予采纳，因为插件 HMR 已经可以保留页面，整页刷新会不必要地丢失 UI 状态。

**直接调用 agent-loop 做恢复。** 不予采纳，因为已有 SessionFace prompt API 会记录普通 user turn，并拥有 admission、持久化和执行路径。

## Acceptance criteria

- 带分支的 rebuild/restart 在 <code>review/all-prs</code> 完成，并在 operation 与 runtime 状态返回该分支。
- 仅插件 HMR 保留页面 identity；Supervisor Web 重启后整页刷新一次。
- 重启前运行中的 session 会在刷新后收到一条持久 queue recovery prompt；被拒绝的 prompt 仍可恢复。
- 配置文档存在时 action 保持显示；没有 native opener 时如实 disabled。
- agent loop 和 Host session protocol 保持不变。

## Risks

dirty 工作树上拒绝跨分支切换。刚好在断线前完成的 session 可能收到保守的恢复 prompt，然后回复没有剩余工作。恢复候选属于同一 origin 的 browser session storage。无头 Linux 没有 desktop shell 提供 opener 时不能启用 native 文件打开。
