# Agent Note: Independent runtime supervisor

Status: proposed

[English](2026-08-14-independent-runtime-supervisor.md) | 中文

## Problem

Desktop tray 必须能够重建并重启已安装 worktree 中的 Harness Web，而不能依赖 tray 直接持有的 child process，也不能依赖发起操作的 shell。

## Proposal

由 detached Supervisor 拥有配置中的 Web process、可选 client watcher、配置端口和 rebuild lifecycle。Electron tray 通过本地 Unix socket 或 Windows named pipe 作为 client。Manifest 是 runtime identity 的事实源，记录明确的 worktree、DSH_HOME、端口、模式、branch、revision、dirty state、phase 和 child PID。

Supervisor 拥有配置 runtime 的端口 takeover。只有 listener PID 匹配记录的 Web PID 时才停止它；明确设置 manifest 的 <code>allowPortTakeover: true</code> 才允许有意识地接管外部 listener。它会在 graceful 和 forced termination 后确认端口释放，构建记录的 worktree，再用记录的环境启动 Web。它不会从调用方 cwd 推断 branch 或 DSH_HOME。

同一时刻只有一个非 status lifecycle command 拥有 runtime；并发 lifecycle command 会失败且不改变其 state。它在最终响应前发送 language-neutral phase key 与 values。同一个 structured phase 会写回 manifest 和 runtime log。Progress page 读取配置 DSH_HOME 的 locale preference，用该语言展示当前和历史 phase；tray 与 command-line client 使用同一个 event stream。

## Owner map

| 范围 | Owner | 职责 |
| --- | --- | --- |
| Runtime process | <code>apps/plus-desktop/src/supervisor.mjs</code> | IPC、source identity、端口 takeover、process group、build、watcher、progress 和 log。 |
| Desktop client | <code>apps/plus-desktop/src/daemon.mjs</code> | 启动或连接 detached Supervisor，并把 lifecycle status 提供给 Electron。 |
| User-facing tray | <code>apps/plus-desktop/src/main.mjs</code> | 持久化 manifest 路径，并提供 start、stop、rebuild-and-restart 操作。 |
| Command-line client | <code>apps/plus-desktop/src/supervisor-client.mjs</code> | 为手动恢复和诊断打印 progress event 与最终 status。 |
| Progress page | <code>apps/plus-desktop/src/supervisor-progress-server.mjs</code> 与 <code>apps/plus-desktop/progress</code> | 渲染 Supervisor event stream、持久 history、原始 runtime output、control、icon 和配置语言。 |
| 明确不改 | Harness Web RPC、agent-loop、Settings 和 session persistence | 不改变 product 协议或 durable session 格式。 |

## Progress contract

一个 command 在同一个本地连接上发送零个或多个 structured phase message，随后恰好发送一个 success 或 failure response。Phase 带有稳定 key 和 JSON values；Supervisor 不存储 localized phrase。页面使用配置语言解析 phase text，并以 structured history 写入 runtime log。原始 process output 单独存储并原样展示。Failure 会记录原始 error object，并向 client 返回简短 error。

## Acceptance criteria

- Tray 不直接拥有 Web child。
- 独立启动的 Supervisor 能报告准确的 source path、branch、revision、DSH_HOME、mode、port、phase 和 child state。
- <code>rebuild-and-restart</code> 能重新接管记录 Web PID 的 listener，或显式允许的外部 listener，构建记录的 worktree，并等待 Web ready。
- Command-line client 能在长时间 build 运行时显示 progress。
- 本地 progress page 在 command 运行时更新 phase 与原始 build output，刷新后保留 phase history，并跟随 <code>locale.preference</code>。
- 只有 development mode 监管 client HMR；production rebuild 使用 build 加 restart。
- Supervisor teardown 会等待受管 child process 退出。

## Risks

显式 <code>allowPortTakeover</code> 设置可能在 manifest 指向其他应用端口时停止无关 process。默认路径只重新接管记录的 Web PID，并拒绝未知 owner。Dirty worktree 会在 status 中可见，调用方可以在 rebuild 前审阅准确 source state。

## Alternatives considered

让 Web child 归 Electron 所有，会让 restart ownership 绑定 tray 生命周期。让 agent shell 启动 child，会让 process 绑定 tool cancellation。只有持久 progress file 能帮助诊断，但不能在 rebuild 期间更新 tray。Detached Supervisor 加本地 progress stream 让 lifecycle 只有一个 owner，并让两个交互 client 使用同一个 phase source。
