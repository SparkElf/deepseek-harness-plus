# Agent Note: 从 WSL 服务打开桌面

Status: proposed

[English](2026-09-13-wsl-desktop-opening.md) | 中文

## Problem

在 WSL 主机上，会话头部的「在应用中打开工作目录」动作报告失败，而它所需的 Windows 解释器一直就在已挂载的卷上。背后有两个彼此独立的原因。

打开路径按名称解析 `powershell.exe`。WSL 只把它启动的交互式进程的 Windows 目录加入 PATH，因此服务——浏览器 UI 通常正是经由服务到达的——继承到的 PATH 没有 Windows 条目，什么也解析不到。从该进程到达桌面因此不可能，即便挂载就在那里。

另外，目录在该主机上提供了 Linux 文件管理器。定位器询问 `canOpenNativePath()`，它回答的是「路径能否被打开」，对任何 WSL 主机都返回 true，因为 WSL 经 Windows 打开。而 Linux GUI 程序不是那里打开路径的东西，于是按钮渲染出一个不可能存在的应用，其图标请求也返回 404。

## Decision

当 PATH 中没有 Windows 条目时，按已挂载的 Windows 卷上的位置直接指定解释器。`openWindowsPath` 先试名称，让 PATH 健康的 WSL 主机沿用既有路径；只有在 spawn 以 ENOENT 失败时才回退到已知挂载点。PowerShell 的非零退出是真实的启动失败，仍然拒绝。

把 Linux 桌面的问题单独回答。`canOpenLinuxDesktop()` 报告 Linux GUI 程序能否接收路径：有 display server 且该主机不是 WSL。`requiresDesktop` 定位器检查改用它，于是 WSL 不再提供 `xdg-open`。

WSL 保留该项而不是失去它。两个问题的答案不同：`canOpenLinuxDesktop()` 在那里回答否，而 `canOpenNativePath()` 回答是，因为由 Windows 接管路径；这一组合选中带 Explorer 图标的 Windows shell open。无头 Linux 主机对两者都回答否，仍然移除该项，这正是该能力原本的用途。

resolver 在既有的 platform seam 之外新增了 `osRelease` seam。没有它时，声明了平台的测试仍会读宿主内核，同一套件因此在 WSL 工作站与 CI 上给出不同答案。

## Alternatives considered

**只做回退，不先试名称。** 拒绝：PATH 注入正常的 WSL 主机一直经名称到达解释器，把挂载点放在前面会改变本来可用的行为。

**在进程内加宽 PATH。** 拒绝：为了让某一个子进程解析成功而改进程环境，会泄漏到 Host 运行的其它每条命令。

**只要检测到 WSL 就把桌面问题回答为 false。** 作为主修复拒绝：那会移除一项可用的能力。抑制 Linux 文件管理器是 WSL 经 Windows 打开的后果，不是到达桌面的替代品。

## Consequences

WSL 服务现在可以为工作目录打开 Windows 桌面。`nativeFileManager()` 在那里本就返回 `explorer`，所以打开动作与定位动作彼此一致。

PATH 中没有 Windows 条目、且 Windows 卷未挂载在 `/mnt/c` 的主机仍无法打开路径；它报告 PowerShell 不可达，而不是一个没有指名任何对象的 spawn 错误。

断言平台行为的测试现在声明内核版本，因此其结果不再取决于在何处运行。七个测试此前在 WSL 工作站上失败，如今在任何主机上都通过。

## Proposal

在 `openWindowsPath` 中加入按挂载点指定解释器的回退，并在 `@deepseek-ai/dsh-native-command` 中加入 `canOpenLinuxDesktop()` 谓词；open-in-app resolver 的 `requiresDesktop` 定位器检查改用该谓词，并让该 resolver 获得 `osRelease` seam，使其测试能够声明所假设的内核。

## Acceptance criteria

- `canOpenLinuxDesktop()` 在 WSL 主机与无头 Linux 主机上回答 false，在声明了 display server 的 Linux 主机上回答 true。
- WSL 主机所提供的目录中不含 Linux 文件管理器，且其图标路由从不被请求。
- 对于 PATH 中没有 Windows 条目、且 Windows 卷挂载在 `/mnt/c` 的进程，`openNativePath` 能到达 Windows 桌面。
- 不是「可执行文件缺失」的 PowerShell 失败按原样报告，不做第二次尝试。
- 断言平台行为的测试在 WSL 主机与非 WSL 主机上同样通过。

## Risks

回退只指名了一种 Windows 安装布局。把 Windows 卷挂载在别处的主机保持原有行为，并报告解释器不可达——与本改动之前的结果相同。

来自确实不存在的 Windows 程序的 `ENOENT`，与挂载缺失无法区分，因此拼错的解释器会在错误浮现前先对挂载点重试一次。

## Verification

`packages/util/native-command`：45 个测试通过，含按挂载点指定解释器的回退与两个桌面谓词；该套件在此改动前于 WSL 工作站上失败六个测试。

`packages/host/open-in-app`：63 个测试通过；该套件在此改动前于 WSL 工作站上失败一个测试，Linux 文件管理器被正确抑制后又多失败两个，`osRelease` seam 随后解决了它们。

在受影响的主机上：用服务的 PATH 调用 `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` 返回 `PS-WORKS`，`canOpenLinuxDesktop()` 在该主机返回 false，而对普通 Linux 桌面返回 true、对无头 Linux 返回 false。
