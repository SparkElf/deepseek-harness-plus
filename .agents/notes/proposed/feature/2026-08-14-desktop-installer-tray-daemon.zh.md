# Agent Note: Desktop Installer and Tray Daemon

Status: proposed

[English](2026-08-14-desktop-installer-tray-daemon.md) | 中文

## Problem

运行一套本地 Harness 工作环境，需要 clone 仓库、选择独立 home、配置原生提供方、构建源码，还要记住管理 Web 服务的终端命令。这些安装步骤与新用户真正想开始的 agent 工作无关。

## Proposal

Plus 将新增一个私有 Electron workspace 应用，包含三步安装 renderer、context-isolated preload API 和主进程中的 HarnessDaemon。安装流程将接收空安装目录、已有工作区目录、本地端口、DeepSeek key、模型、推理强度和启动行为。主进程将 clone Plus 仓库，执行锁定依赖安装和构建，写入隔离的 DSH_HOME 与原生 DeepSeek settings，并把 key 写入仅本地 owner 可读写的环境文件。

守护进程将以 DSH_HOME、Code Mode 和选定端口启动 dsh web。关闭安装窗口只会隐藏窗口，Electron tray 将继续拥有进程。托盘将提供启动、停止、打开 UI、打开日志和退出操作。

这项提议只针对 Plus 发行层，部分修订 [Source run without a managed installer](../../implemented/simplification/2026-08-10-source-run-without-managed-installer.md)。上游 Harness 仍保持没有受管安装器的源码运行方式；那份 Note 对其已经发布的表面仍然有效。

## Alternatives considered

**把现有 Web UI 当作安装向导。** Web 入口依赖已经构建并运行的 Harness 服务，因此不能创建它自己打开所需的本地 runtime。

**把 settings 写进默认 Harness home。** 这样会覆盖或混入另一套本地 Harness 安装的 settings。

**在首版向导中导入未经验证的自定义提供方。** 当前原生提供方配置只针对 DeepSeek。没有经过验证的 Harness provider，就记录自定义 endpoint 会让安装页面承诺一条不能使用的路由。

## Acceptance criteria

- 安装器会把 Plus fork clone 到选定的空目录，创建隔离的 DSH_HOME，写入原生 DeepSeek settings，并启动所选端口。
- 窗口关闭后，托盘仍可以启动、停止、打开和退出已配置的本地服务。
- 生成的 Linux 包包含 renderer、preload 和主进程 daemon，同一发布流程还要定义 Windows 和 macOS 产物。
- 在把任何安装器作为可下载产物发布前，发布流程必须在支持桌面的端到端环境中验证安装路径。

## Risks

当前代码已经验证 Linux unpacked package，但还没有发布平台产物，也没有支持桌面的端到端环境。产品必须继续标记为开发中，直到这些路径完成。安装器拥有 source checkout 和 build 生命周期，因此未来升级与回滚必须明确设计，不能从首次 clone 流程中暗示出来。
