# Agent Note: A WSL deployment reaches the Windows desktop through the MCP provider

Status: proposed

[English](2026-09-19-a-wsl-deployment-reaches-the-windows-desktop-through-the-mcp-provider.md) | 中文

## Problem

这里的 Plus 部署跑在 WSL 内，而 WSL 没有桌面：`DISPLAY` 与 `WAYLAND_DISPLAY` 均未设置，也没有 X server 在运行。用户在 Windows 宿主上为这里启用 computer-use，同时不把部署搬出 WSL。

两个 provider 都不能照文档那样工作。native provider 是最直觉的选择，却完全不可行：

```
@trycua/cua-driver-win32-x64-msvc/
  cua_driver_node_runtime.node   643920 bytes   Node native addon (Windows PE)
  cua_driver_sdk.dll           25250128 bytes   Windows DLL
```

Linux 的 Node 两个都加载不了。把 provider 的解析指向 Windows 那棵树 —— 也就是最初的想法，本 Note 的存在正是为了替下一个人省掉这次尝试 —— 会死在 `dlopen` 上，且没有任何配置能改变它，因为载荷是为另一个平台编译的。

## Proposal

**挂载 MCP provider，把它的 `command` 指向 Windows 可执行文件。**

```yaml
- insert:
    - id: computer-use
      name: '@deepseek-ai/dsh-computer-use'
    - id: computer-use-cua-driver
      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'
      config:
        command: /mnt/c/Users/Administrator/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe
        args: [mcp]
```

MCP provider spawn 一个进程、在它的 stdio 上讲 JSON-RPC，因此从不把载荷加载进自己的地址空间。WSL 的互操作层运行该 Windows 可执行文件：

```
$ ps aux | grep cua-driver
root 1305505 /init /mnt/c/.../cua-driver/bin/cua-driver.exe
```

`/init` 是 WSL 的互操作垫片，它背后是一个处于交互会话中的 Windows 进程。它既非模拟，也非远程受控：它之所以观察并操作真实桌面，正是因为它就跑在那里。

### The agent cursor is an overlay, not the pointer

`move_cursor` 接受一个 `scope`：

| `scope` | 效果 |
|---|---|
| `window` | 只移动该会话的覆盖层；OS 指针不动 |
| `desktop` | 移动真实的 OS 指针 |

在 `scope: "window"` 下实测：`get_cursor_position` 移动前后都回答 `(1002, 1501)`。该覆盖层是带动画的 —— `spring`、`arc_flow`、`arc_size`、`glide_duration_ms`、`dwell_after_click_ms`、`idle_hide_ms`、`start_handle`、`end_handle`、`turn_radius` —— 并且它出现在桌面自身的窗口列表里，名为 `Cua.AgentCursorOverlay.default`。主题可用 Lottie 源经 `cursor-theme build|install` 安装；随附主题是 `cua.default`。

两者相互独立：`click` 驱动真实指针，而覆盖层向观看的用户展示模型的意图。

## Findings this change rests on

1. **从 WSL 出发，Windows 驱动报告的是真实桌面。** `cua-driver doctor` 回答 `interactive session: session 1 has an attached interactive desktop`、`UI Automation: CoCreateInstance(CUIAutomation) succeeded`，以及 `EnumWindows visible: 17 windows`。
2. **坐标就是物理显示器。** `get_screen_size` 回答 `2880×1800, scale_factor 2.0`，`get_cursor_position` 跟随真实指针。
3. **MCP 握手可以完成。** 向 `cua-driver.exe mcp` 的 stdin 写入一个裸 `initialize`，会返回声明了 `tools` 能力的结果。
4. **经由该部署的一次模型回合可以端到端抵达它。** 被要求截取桌面并列出窗口标题时，3080 上的 DSH 返回了实时窗口栈 —— 包括它自己的浏览器窗口（并点名其为前台）—— 并保存了 `desktop_capture.png`。它还主动报告了一个真实的局限：截图被浏览器占据，因为其他窗口被遮挡；而 `list_windows` 的坐标是窗口位置，并非可见性的证据。
5. **daemon 是前置条件，不是副作用。** 在 `cua-driver autostart kick` 启动它之前，该二进制对每次调用都回答 `daemon is not running on \\.\pipe\cua-driver`。安装器以 `RunLevel=Highest` 注册它，因此重启后无需登录即可恢复。

## Acceptance criteria

- 位于 WSL 内、自身没有显示器的部署，能列出 Windows 桌面的窗口并截取它。
- 驱动报告的平台与会话是 Windows 交互会话，而不是某个 Linux 替代品。
- `move_cursor` 在 `scope: "window"` 下不改变 `get_cursor_position`。
- 没有运行 daemon 的部署以那条 socket 消息失败，而不是静默降级。

## Alternatives considered

**把 native provider 的解析重定向到 Windows 包树。** 否决：载荷是 Windows 插件与动态库，无论路径怎么解析，在 Linux 进程里加载都会失败。

**在 Windows 上再跑一个 DSH 并远程驱动它。** 对该部署否决：它会复制 profile、会话与插件，而目标是一个能触达另一平台桌面的部署。

**把 Windows daemon 暴露成 socket 并为它实现客户端。** 否决：MCP provider 已经自带那个客户端，而进程 spawn 与 stdio 上的 WSL 互操作边界是透明的。

## Risks

**该部署依赖 Windows 侧的安装与运行中的 daemon。** 两者缺失时在 WSL 内部都不可见，而最初的症状是一个空的工具命名空间，而不是启动时报错。

**`command` 经 `/mnt/c` 指定了一个绝对 Windows 路径。** 换成别的 Windows 用户或盘符就会失效，且加载时不校验该路径。

**该驱动控制真实桌面。** 多个会话与彼此独立的 DSH 进程可以操作同一个桌面，而 provider 的默认权限模式执行无提示自动化；调用方需自行协调完整的观察、操作、验证序列。
