# Desktop Runtime Supervisor

[English](README.md) | 中文

Desktop runtime 使用一个 Supervisor process 拥有 Harness Web、配置端口、可选 client HMR watcher、rebuild lifecycle 和本地 control page。在当前 WSL development host 上，systemd 让 production Supervisor 独立于 Electron 与 agent shell 持续运行。

Supervisor manifest 记录明确的 install path、DSH_HOME、Web port、progress port、mode、branch、revision、dirty state、phase 和受管 child PID。Tray 通过本地 Unix socket 或 Windows named pipe 发送 lifecycle command，不直接拥有 Web child。3082 HTTP/SSE page 由 Supervisor 自身打开，不需要第二个 progress-server process。

## Commands

Command-line client 打印 Supervisor phase event 和最终 status。

~~~sh
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> status
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> rebuild-and-restart
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> --branch <branch-name> rebuild-and-restart
~~~

Progress page 也支持为 Build and restart 输入目标 branch。branch name 是 deployment target；Supervisor 先构建该 branch，build 成功后才停止 3080。build failure 会保留当前 Web process，并把完整 raw output 留在 runtime log。

## Development modes

client-plugin source-only change 在 <code>pnpm run dev:web</code> watcher active 时使用当前 production worktree。Web shell、client runtime、Host、Supervisor、desktop、settings/schema、dependency、lockfile、bundle 与 built-artifact change 使用单独 worktree 中的 candidate branch，并拥有独立 DSH_HOME、Web port 3081 与 progress page port 3083。可复用流程记录在 <code>.agents/skills/supervisor-runtime-control/SKILL.md</code>。

页面从配置 DSH_HOME 的 settings document 读取 <code>locale.preference</code>。没有显式 preference 时，页面跟随 browser language；除非 browser language 以 <code>en</code> 开头，否则使用中文。
