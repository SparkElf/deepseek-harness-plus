# Agent Note: Desktop Tray Manager

Status: proposed

[English](2026-08-14-desktop-installer-tray-daemon.md) | 中文

## Problem

用户通过浏览器页面使用 DeepSeek Harness，但第一套本地 runtime 在页面能打开前就需要安装路径、一组 provider 凭据和默认模型。安装完成后，再做一套常驻桌面设置界面会复制 Web 页面，并让模型、凭据、预设和工作区选择出现互相冲突的 owner。

## Proposal

Plus 将为 macOS、Linux 和 Windows 提供一个常驻托盘的 Electron 管理器。本地 runtime 不存在时，它会打开一次性紧凑四步安装引导，并复用 Harness design token 与品牌资产。语言和主题选择会立即改变引导，并成为已安装 Harness 的默认设置。引导会收集空安装目录、一个默认 provider、其密钥、模型和可选推理强度；高级端口选项默认使用 3080。它支持已安装的 key-based catalog provider 与 OpenAI-compatible 自定义 provider，之后将 provider 和模型管理交给 Harness Web。

Windows 用户可以选择 Windows 文件系统或一个已安装的 WSL 发行版，然后通过系统文件选择器选择空目录。选择 WSL 目录时，文件管理器会打开所选发行版，并将结果转换为发行版内路径。所选 target 拥有 checkout、DSH_HOME、settings、Git 与 pnpm 命令、Supervisor、Harness Web process、rebuild、repair 和 update。Linux 与 macOS 使用本机环境。引导在该 target 中 clone 并构建 Plus，启动 Harness Web，打开浏览器页面，然后关闭。

安装后，管理器只拥有本地 runtime 生命周期和导航操作。托盘显示 Supervisor 与 Harness status；分别打开正式 Harness 和 Supervisor 页面；仅在 candidate Supervisor 报告受管 runtime 时提供测试版 Harness 入口；并提供启动、停止、构建、只检查而不安装可用 commit、升级、修复和打开 target 数据目录。它不会再次暴露模型、凭据、预设或工作区设置。Harness Web 拥有之后所有面向用户的配置和 agent 交互。

这项提议只针对 Plus 发行层，部分修订 [Source run without a managed installer](../../implemented/simplification/2026-08-10-source-run-without-managed-installer.md)。上游 Harness 仍保持没有受管安装器的源码运行方式；那份 Note 对其已经发布的表面仍然有效。

## Alternatives considered

**给 Electron 提供常驻设置 renderer。** 这会复制 Web 设置页面，并让 desktop process 对模型、凭据、预设和工作区拥有冲突职责。

**完全不收集初始配置。** Web 服务存在前无法使用选定的默认模型或原生凭据；首次引导让这些 bootstrap 值有一个明确 owner。

**把生命周期控制留在 shell script。** 浏览器用户仍要寻找检出目录，并记住普通安装、修复和升级所需的服务命令。

## Acceptance criteria

- 引导以一个纵向任务流呈现；修改语言或主题时，在保存偏好前就立即改变文案和外观。
- 在 Windows 上，引导可选择 Windows 或 WSL；WSL 还要选择一个已安装发行版，并让安装与 runtime 命令始终留在其中。
- 首次服务启动前，初始四步引导能收集安装路径、一个支持的 catalog 或 OpenAI-compatible 自定义 provider、其受管理密钥、默认模型和推理强度；端口选择保留为高级选项。
- 安装后，托盘显示 Supervisor 与 Harness status，打开正式与 Supervisor 页面，并根据 candidate Supervisor live status 启用测试版入口，并能对一套隔离的 Plus checkout 执行启动、停止、构建、检查更新、升级和修复，且不重新打开这些设置。
- Web 页面是之后唯一面向用户的模型、凭据、预设、工作区和 agent 表面。
- Linux AppImage/deb 和 Windows NSIS 包在对应 runner 上构建，并包含同一组引导和托盘操作；macOS 打包在配置好 Developer ID 签名和 notarization 后再恢复。
- 发布前，支持桌面的端到端环境要验证安装、服务就绪、浏览器打开、停止、升级和修复。

## Risks

所选 target 需要安装 Git 和 pnpm。WSL 安装还需要一个已经安装这些工具的发行版。引导会在安装时将一组初始 provider key 写入受管理凭据文档，因此它的 preload bridge 只保留安装 IPC，并会在成功后关闭。跨平台安装器和原生桌面流程验证在匹配 runner 产出并验证 artifact 前仍未交付。升级只允许快进 Git 更新；修改过的 checkout 如何恢复需要一项单独且明确的用户决策。
