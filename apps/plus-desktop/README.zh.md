# Desktop Runtime Supervisor

[English](README.md) | 中文

桌面管理器安装并控制一套本地 Harness runtime。安装引导以单栏复用 Harness 视觉系统；语言和主题选择会立即改变引导外观，并写入已安装 DSH_HOME settings document 的 <code>locale.preference</code> 与 <code>ui-theme.preference</code>。

在 Windows 上，引导可以直接安装到 Windows，也可以安装到选定的已安装 WSL 发行版。安装目录、Git 与 pnpm 命令、settings、Supervisor、Harness Web process、rebuild、repair 和 update 都留在该 target 内。Linux 与 macOS package 使用本机环境。

托盘读取 Supervisor status，并分别打开正式 Harness 页面和 Supervisor 页面。只有 candidate workflow 的 3083 Supervisor 报告 3081 Web runtime 时，托盘才启用测试版 Harness 入口。它还提供启动、停止、构建并重启、只检查而不安装上游更新、升级、修复和打开目标数据目录。

## 预览安装引导

运行只渲染界面的预览，不安装或写入配置：

~~~sh
pnpm --filter @deepseek-ai/dsh-plus-desktop preview:installer
~~~

打开 <code>http://127.0.0.1:4177</code>。Query parameter 可以选择审阅状态，例如 <code>?theme=dark&locale=zh&target=wsl&step=1</code>。预览会模拟 Windows 与已安装的 WSL 发行版；打包后的应用会读取真实平台和发行版列表。

## Supervisor commands

Command-line client 打印 Supervisor phase event 和最终 status。

~~~sh
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> status
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> rebuild-and-restart
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> --branch <branch-name> rebuild-and-restart
~~~

Supervisor 拥有 Harness Web、配置端口、可选 client HMR watcher、rebuild、runtime log 和 HTTP/SSE page。branch rebuild 在停止当前 Web process 前完成；failed build 保留当前 process，并把 raw output 留在 runtime log。

## Development modes

client-plugin source-only change 在 <code>pnpm run dev:web</code> watcher active 时使用当前 production worktree。Web shell、client runtime、Host、Supervisor、desktop、settings/schema、dependency、lockfile、bundle 与 built-artifact change 使用单独 worktree 中的 candidate branch，并拥有独立 DSH_HOME、Web port 3081 与 progress page port 3083。可复用流程记录在 <code>.agents/skills/supervisor-runtime-control/SKILL.md</code>。
