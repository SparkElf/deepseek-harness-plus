# Desktop Runtime Supervisor

[English](README.md) | 中文

桌面管理器安装并控制一套本地 Harness runtime。紧凑的四步安装引导会立即应用语言和主题，让用户选择安装位置，并把 <code>locale.preference</code> 与 <code>ui-theme.preference</code> 写入已安装 DSH_HOME 的 settings document。

在 Windows 上，引导可选择 Windows 或已安装的 WSL 发行版，然后通过系统文件选择器选择安装目录。选择 WSL 目录时，文件管理器会打开该发行版，并返回对应的 Linux 路径。安装目录、命令、settings、Supervisor、Harness Web process、rebuild、repair 和 update 都留在所选 target 内。Linux 与 macOS package 使用本机环境。

托盘读取 Supervisor status，并分别打开正式 Harness 页面和 Supervisor 页面。安装器保存正式实例、测试实例、Supervisor 和测试 Supervisor 四组端口，因此测试版 Harness 入口会探测配置的测试 Supervisor，不再依赖固定端口。版本管理会按精确 commit 列出带 tag 的 Plus release，支持普通升级或回退，也会为本地源码修改打开 AI 合并会话。托盘还提供启动、停止、构建并重启、修复和打开目标数据目录。备份与恢复把用户设置和数据目录导出为 zip 压缩包并可导入恢复，托盘启动在 Windows 上不再弹出控制台窗口。

引导会配置一个初始默认模型，支持 DeepSeek、OpenAI、Anthropic、Google、OpenRouter、Groq、Mistral、xAI 与 OpenAI-compatible 自定义提供方。它将 provider profile 写入 <code>settings.yaml</code>，将密钥写入受管理的 <code>.credentials.yaml</code>。之后添加或编辑 provider 和模型仍由 Harness Web 完成。

## 预览安装引导

运行只渲染界面的预览，不安装或写入配置：

~~~sh
pnpm --filter @deepseek-ai/dsh-plus-desktop preview:installer
~~~

打开 <code>http://127.0.0.1:4177</code>。预览会将真实的 980×780 安装卡片居中显示在反向主题画布中：深色卡片使用浅色画布，浅色卡片使用深色画布。Query parameter 可以选择审阅状态，例如 <code>?theme=dark&locale=zh&target=wsl&step=1</code>。预览会模拟 Windows 与已安装的 WSL 发行版；打包后的应用会读取真实平台和发行版列表。

## Supervisor commands

Command-line client 打印 Supervisor phase event 和最终 status。

~~~sh
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> status
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> rebuild-and-restart
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> --branch <branch-name> rebuild-and-restart
~~~

Supervisor 拥有 Harness Web、配置的 Harness 与 Supervisor 端口、可选 client HMR watcher、rebuild、runtime log 和 HTTP/SSE page。Windows 通过 unpacked bootstrap 使用 Electron utility process 启动 native Supervisor，并等待命名管道真正监听；Windows 可能拒绝替换已打开的 status manifest，因此会原位写入；初始化失败时会返回捕获的 startup stack。Supervisor 命令 socket 按空闲计时：进度行和端口等待心跳会让较长的 `start` 命令保持存活，网页启动窗口为 120 秒。`yaml` 依赖随 unpacked Supervisor 源码一起解包，使纯 Node 解析在 asar 之外也能成功；`verify:unpacked-imports` 在每次 Windows 构建后导入打包产物的 Supervisor 模块图，防止只有打包环境才会出现的解析失败再次流出。branch rebuild 在停止当前 Web process 前完成；failed build 保留当前 process，并把 raw output 留在 runtime log。

## Development modes

client-plugin source-only change 在 <code>pnpm run dev:web</code> watcher active 时使用当前 production worktree。Web shell、client runtime、Host、Supervisor、desktop、settings/schema、dependency、lockfile、bundle 与 built-artifact change 使用单独 worktree 中的 candidate branch，并拥有独立 DSH_HOME 以及单独选择的 Web 与 Supervisor 端口。可复用流程记录在 <code>.agents/skills/supervisor-runtime-control/SKILL.md</code>。
