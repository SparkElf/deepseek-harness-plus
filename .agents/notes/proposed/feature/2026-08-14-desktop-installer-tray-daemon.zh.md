# Agent Note: Desktop Tray Manager

Status: proposed

[English](2026-08-14-desktop-installer-tray-daemon.md) | 中文

## Problem

用户通过浏览器页面使用 DeepSeek Harness，但第一套本地 runtime 在页面能打开前就需要安装路径、原生提供方凭据、默认模型和服务端口。安装完成后，再做一套常驻桌面设置界面会复制 Web 页面，并让模型、凭据、预设和工作区选择出现互相冲突的 owner。

## Proposal

Plus 将为 macOS、Linux 和 Windows 提供一个常驻托盘的 Electron 管理器。本地 runtime 不存在时，它会打开一次性安装引导，收集空安装目录、本地端口、DeepSeek key、默认模型和可选推理强度。引导会 clone 并构建 Plus，把初始原生 settings 和 key 写入隔离的 DSH_HOME，启动 dsh web，打开浏览器页面，然后关闭。

安装后，管理器只拥有本地 runtime 生命周期操作：启动、停止、打开浏览器页面、通过快进更新和重建来升级，以及修复锁定依赖和构建产物。它不会再次暴露模型、凭据、预设或工作区设置。Harness Web 拥有之后所有面向用户的配置和 agent 交互。

这项提议只针对 Plus 发行层，部分修订 [Source run without a managed installer](../../implemented/simplification/2026-08-10-source-run-without-managed-installer.md)。上游 Harness 仍保持没有受管安装器的源码运行方式；那份 Note 对其已经发布的表面仍然有效。

## Alternatives considered

**给 Electron 提供常驻设置 renderer。** 这会复制 Web 设置页面，并让 desktop process 对模型、凭据、预设和工作区拥有冲突职责。

**完全不收集初始配置。** Web 服务存在前无法使用选定的默认模型或原生凭据；首次引导让这些 bootstrap 值有一个明确 owner。

**把生命周期控制留在 shell script。** 浏览器用户仍要寻找检出目录，并记住普通安装、修复和升级所需的服务命令。

## Acceptance criteria

- 首次服务启动前，初始引导能收集安装路径、端口、DeepSeek key、默认模型和推理强度。
- 安装后，托盘菜单能对一套隔离的 Plus 检出执行启动、停止、打开本地 Web URL、升级和修复，且不重新打开这些设置。
- Web 页面是之后唯一面向用户的模型、凭据、预设、工作区和 agent 表面。
- Linux AppImage/deb 和 Windows NSIS 包在对应 runner 上构建，并包含同一组引导和托盘操作；macOS 打包在配置好 Developer ID 签名和 notarization 后再恢复。
- 发布前，支持桌面的端到端环境要验证安装、服务就绪、浏览器打开、停止、升级和修复。

## Risks

初版源码要求本机已安装 Git 和 pnpm。引导会在安装时写入初始 DeepSeek key，因此它的 preload bridge 只保留安装 IPC，并会在成功后关闭。跨平台安装器和原生桌面流程验证在匹配 runner 产出并验证 artifact 前仍未交付。升级只允许快进 Git 更新；修改过的检出如何恢复需要一项单独且明确的用户决策。
