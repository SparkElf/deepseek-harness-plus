# Agent Note: Independent runtime supervisor

Status: proposed

[English](2026-08-14-independent-runtime-supervisor.md) | 中文

## Problem

桌面 tray 必须控制一个 Harness Web process，使它能 rebuild 和 restart 安装 worktree，且不依赖 tray 的 direct child process 或发起操作的 shell。开发者还需要为符合条件的 client-plugin change 使用快速 HMR path，并为必须启动新 Web process 的 change 使用隔离 path。

## Proposal

当前 developer deployment 使用 systemd，让 production Supervisor 独立于 agent shell 持续运行。打包后的桌面安装则由 Electron 在选定 native 或 WSL target 中启动一个 detached Supervisor。在两类 deployment 中，该 Supervisor 都拥有 production Web runtime、private local socket 或 named pipe 与 HTTP/SSE control page；页面属于 Supervisor process，不是独立 helper。

桌面安装选择一个 runtime target。原生安装直接在 host 执行。Windows host 上的 WSL 安装把 checkout、文件、Git 与 pnpm 命令、Supervisor、Web process、watcher 和 process lifecycle 留在选定发行版内。<code>TargetRuntime</code> 拥有这项差异；Electron 继续负责托盘和浏览器交接。Windows tray 会在该发行版内调用 WSL Supervisor client，不解释 Linux path、PID 或 Unix socket。

branch name 就是 deployment target。promotion 不接受也不比较 commit hash；manifest 可以为 source diagnostics 显示当前 revision。branch-scoped production command 切换到指定 local branch，构建该 branch，且只在 build 成功后停止当前 Web process。build failure 保留当前 3080 Web process，并报告简洁的 failure state 与 raw build output。

## Runtime modes

### HMR

client plugin 中的 source-only change 使用当前 production worktree 与已运行的 <code>pnpm run dev:web</code> watcher。Web shell、client runtime、Host、Supervisor、desktop process、settings/schema、dependency、lockfile、bundle composition 与 built artifact change 不支持 HMR。

### Candidate runtime

non-HMR change 在 candidate branch 的单独 Git worktree 中运行。systemd transient service 拥有它隔离的 DSH_HOME、3081 Web runtime 与 3083 candidate control page。production 3080 runtime 保持使用自己的 worktree 和 data directory。production control page 可以报告 candidate status，但一个 Harness runtime 不连接或观察另一个 runtime。

### Promotion

3081 browser acceptance 通过后，production Supervisor 接收带 candidate branch name 的 <code>rebuild-and-restart</code>。它将 production worktree 切到该 branch、构建它，然后才停止 production Web process、释放 configured port、启动 replacement，并在 3082 报告完成。该 branch 当前最新 local content 就是被 promote 的 content。

## Ownership map

| Area | Owner | Responsibility |
| --- | --- | --- |
| Developer production service | systemd | 让当前 developer Supervisor 独立于 agent shell 持续运行。 |
| Packaged production service | Electron desktop manager | 在选定 native 或 WSL target 中启动一个 detached Supervisor。 |
| Runtime process | <code>apps/plus-desktop/src/supervisor.mjs</code> | IPC、branch activation、source identity、port takeover、process groups、build、watcher、progress 与 logs。 |
| Progress page | <code>apps/plus-desktop/src/supervisor-progress-server.mjs</code> 与 <code>apps/plus-desktop/progress</code> | 从 Supervisor process 提供 3082，并渲染 branch、phase、history 与 raw output。 |
| Candidate service | systemd transient service | 拥有 candidate worktree、DSH_HOME、3081 Web runtime 与 3083 page。 |
| Runtime target | <code>apps/plus-desktop/src/target-runtime.mjs</code> | 在选定 native host 或 WSL 发行版内执行 target 文件、命令、Supervisor 启动和控制。 |
| Desktop client | <code>apps/plus-desktop/src/daemon.mjs</code> | 连接 target Supervisor 并向 Electron 暴露 lifecycle status。 |
| Explicitly untouched | Harness Web RPC、agent-loop、Settings、session persistence、providers | 不改变 product protocol 或 durable session format。 |

## Progress contract

一个 runtime 同时只由一个 non-status lifecycle command 拥有。它在 final response 前 stream language-neutral phase keys 与 values。Supervisor 持久化这些 phases 与 raw process output。页面按 configured locale 解析 structured phases。phase failure message 保持简洁；runtime log 是完整 compiler 与 build output 的来源。

## Alternatives considered

**在 branch activation 与 build 前停止 3080。** failed build 会使用户没有可用 runtime。

**使用 commit hash 作为 promotion target。** 已确认的 workflow promote selected branch 的最新 content，因此 branch name 是唯一 deployment identifier。

**让 3080 Harness 观察 3081 Harness。** runtime-to-runtime observation 会耦合独立的 data、session 与 process lifecycle。Supervisor control plane 拥有 cross-runtime visibility。

## Acceptance criteria

- agent tool invocation 结束后，systemd 仍保持当前 developer Supervisor 与其 3082 page 存活；打包后的桌面安装在选定 target 中启动 detached Supervisor。
- WSL 安装把 source、configuration、process、lifecycle command 和 Supervisor state 留在选定发行版内，同时由 Windows tray 打开 loopback 页面。
- HMR 只由 production worktree 中 active client-plugin watcher 使用。
- candidate branch test 使用独立 worktree、DSH_HOME、3081 与 3083。
- branch-scoped production rebuild 依次 switch branch、complete build、stop/start 3080。
- failed branch build 保留之前的 3080 Web process，并显示 failure，且 manifest phase 不持久化完整 raw output。
- completed production promotion 后 browser acceptance refresh 3080。

## Risks

branch 按设计是 mutable 的，因此 promotion 有意运行该 branch 的最新 local content，而不是历史 candidate commit。production branch switch 会在 build 结束前改动 source files；candidate test 与 build-first process lifecycle 保留运行中的 Web process，但不提供 immutable artifact deployment。显式 <code>allowPortTakeover</code> setting 在 manifest 指向另一应用 port 时可能停止无关 process；默认 path 只接管记录的 Web PID，并拒绝 unknown owner。
