# @sparkelf/dsh-plugin-supervisor

## 中文

该软件包把两个进程角色放在同一个 npm 发布中：Host Cordis 插件公开当前运行中的顶层 Session 集合并接收恢复提示词，独立 Node Supervisor 则根据显式 manifest 启动、停止、构建和重启一个 Plus Web runtime。受控重启会在关闭前捕获运行中的 Session，并在替代 runtime 开始监听后为每个 Session 排入一条恢复消息。

### 使用

Plus profile 挂载本软件包的 Host 入口，并提供 `dsh-plus-supervisor` 可执行文件。Supervisor 读取以下 manifest：

```json
{
  "dshHome": "/root/.dsh",
  "port": 3080,
  "supervisorPort": 3082,
  "socketPath": "/root/.dsh/supervisor/runtime.sock",
  "runtime": {
    "command": "node",
    "args": ["/path/to/apps/cli/lib/bin.js", "--profile", "plus", "--port", "3080", "--no-open"],
    "cwd": "/path/to/materialized-dsh"
  },
  "build": {
    "command": "pnpm",
    "args": ["run", "build:official"],
    "cwd": "/path/to/materialized-dsh"
  }
}
```

使用 `dsh-plus-supervisor --manifest <path>` 启动 Supervisor。同一可执行文件还接受放在 `--manifest` 前的 `status`、`start`、`stop`、`restart` 和 `rebuild-and-restart`。进度页监听配置的 `supervisorPort`，展示 process、build、capture 和 recovery 阶段。

一次重启依次执行：可选构建、捕获当前运行中的顶层 Session ID、停止旧进程、启动配置的命令、等待 Web 端口，然后排入恢复提示词。普通启动、停止、进程崩溃和网络重连不会发送恢复消息。

### 模型体验

每个被捕获的 Session 会收到一条普通用户消息，说明 Supervisor 重启了 DSH，要求模型检查持久化历史、当前 workspace 状态和工具结果，避免重复已完成的操作，若本会话存在目标则先把已暂停的目标重新置为执行，再完成剩余工作，并在没有剩余任务时回复“已完成”。Session Controller 通过正常的 `SessionController.prompt` 路径记录该消息。该固定指令会加入下一次请求并保留在后续历史中，直到 compaction 将其遮蔽；进程重启不会保留进程内缓存状态。

### 已知限制

- 恢复提示词失败时 Supervisor 会报告失败，但不会自动重试。
- 每个 Supervisor 进程管理一个 runtime manifest 和一个 Web 端口。

## English

This package joins two process roles under one npm release: a Host Cordis plugin exposes the current running top-level Session set and admits recovery prompts, while a plain Node Supervisor starts, stops, rebuilds, and restarts one explicitly described Plus Web runtime. A controlled restart captures running Sessions immediately before shutdown and queues one recovery message in each after the replacement runtime listens.

### Usage

The Plus profile mounts the package's Host entry and provides the `dsh-plus-supervisor` executable. The Supervisor reads this manifest:

```json
{
  "dshHome": "/root/.dsh",
  "port": 3080,
  "supervisorPort": 3082,
  "socketPath": "/root/.dsh/supervisor/runtime.sock",
  "runtime": {
    "command": "node",
    "args": ["/path/to/apps/cli/lib/bin.js", "--profile", "plus", "--port", "3080", "--no-open"],
    "cwd": "/path/to/materialized-dsh"
  },
  "build": {
    "command": "pnpm",
    "args": ["run", "build:official"],
    "cwd": "/path/to/materialized-dsh"
  }
}
```

Start the Supervisor with `dsh-plus-supervisor --manifest <path>`. The same executable accepts `status`, `start`, `stop`, `restart`, and `rebuild-and-restart` before `--manifest`. The progress page listens on the configured `supervisorPort` and reports process, build, capture, and recovery phases.

A restart performs one ordered operation: optional build, capture the current running top-level Session IDs, stop the old process, start the configured command, wait for its Web port, and queue the recovery prompt. Ordinary start, stop, process crash, and network reconnect do not send recovery messages.

### Model Experience

Each captured Session receives one ordinary user message stating that Supervisor restarted DSH, directing the model to inspect durable history, current workspace state, and tool results, avoid repeating completed operations, re-arm a paused goal when the Session has one, finish remaining work, and answer `已完成` when nothing remains. The Session Controller logs the message through its normal `SessionController.prompt` path. The fixed instruction is retained in later history until compaction shadows it; restarting the process does not preserve process-local cache state.

### Known Limitations

- A failed recovery prompt is reported by the Supervisor and is not retried automatically.
- The Supervisor manages one runtime manifest and one Web port per process.

The implementation was extracted from `SparkElf/deepseek-harness-plus` master at `d57a57795f25753a3ccf7d69fc25a34fa2e77d9e`.

## Accepted profile guard

Install `runtime/profile-guard.mjs` at a stable path outside the mutable profile, then add it as the service `ExecStartPre`. A closure-verified promotion explicitly records the accepted profile:

`dsh-plus-profile-guard accept --profile /path/to/profile --profile-link ~/.dsh/profiles/plus --manifest ~/.dsh/supervisor/runtime.json --state ~/.dsh/supervisor/accepted-profile.json`

Every Supervisor start must run:

`node ~/.dsh/supervisor/profile-guard.mjs guard --state ~/.dsh/supervisor/accepted-profile.json`

The guard verifies the accepted profile complete runtime fingerprint. If an updater changed the profile symlink without a new explicit acceptance, it atomically restores both the accepted symlink and its status-free runtime manifest before any code is imported from the mutable profile.
