# Desktop Runtime Supervisor

[English](README.md) | 中文

Desktop runtime 使用 detached Supervisor process 拥有 Harness Web、配置端口、可选 client HMR watcher 和 rebuild lifecycle。

Supervisor manifest 记录明确的 install path、DSH_HOME、端口、mode、branch、revision、dirty state、phase 和受管 child PID。Tray 通过本地 Unix socket 或 Windows named pipe 发送 lifecycle command，不再直接拥有 Web child。只有 listener PID 匹配记录的 Web PID 时才重新接管；只有有意识接管外部 listener 时才设置 `allowPortTakeover: true`。

## Commands

Command-line client 打印 Supervisor progress event 和最终 status。

```sh
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> status
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> rebuild-and-restart
```

## Progress Page

Progress server 提供本地控制页，只能通过 Supervisor socket 发送 start、restart 和 rebuild-and-restart。页面从配置 runtime log 渲染 phase history 和原始 process output。

```sh
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:progress -- --port 3082 --manifest <manifest-path> --socket <socket-path>
```

页面从配置 DSH_HOME 的 settings document 读取 `locale.preference`。没有显式 preference 时，页面跟随 browser language；除非 browser language 以 `en` 开头，否则使用中文。
