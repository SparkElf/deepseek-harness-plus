# Agent Note: 原生桌面标题栏控件

Status: implemented

[English](2026-08-16-native-titlebar-overlay-controls.md) | 中文

## Problem

Plus Desktop 安装器此前使用无框 BrowserWindow，并由 renderer 自己实现最小化、最大化与关闭按钮。在 Windows 上，Electron 的拖拽区域命中测试可能先于 renderer handler 吞掉标题栏指针输入，导致可见控件没有响应。GitHub hosted Windows session 也无法为 Electron 窗口几何或最大化事件提供可靠的自动化证据。

## Decision

Windows 上，apps/plus-desktop/src/main.mjs 使用 titleBarStyle: 'hidden' 和 44px 的 titleBarOverlay 创建安装器。最小化、最大化和关闭控件由 Electron 与 Windows 拥有。renderer 会在品牌栏中为 overlay 预留宽度，并且只拥有带品牌的拖拽区域。installer:apply-appearance 会随所选主题更新 overlay 的背景和图标颜色。

Linux 与 macOS 使用默认原生 frame。preload、renderer 与 main-process IPC 均不再暴露或实现 renderer 自有的窗口控件。

## Verification

desktop Playwright 流程会在 Windows runner 上启动真实 Electron 应用，并通过 preload 与 main-process IPC 完成目录浏览、自定义提供方校验和恢复到确认页。原生 Windows workflow 在构建和上传 NSIS 安装器前运行了该流程，见 [run 31965864018](https://github.com/SparkElf/deepseek-harness-plus/actions/runs/31965864018)。安装器 artifact 的 SHA-256 为 6ff7e4e280f7730581b3cbcceaea33bf696344ddea9faed452b7d8b9804457c0。

最小化和最大化的外观仍由交互式 Windows 验收负责，因为 hosted Electron automation 无法可靠报告原生窗口的几何或状态事件。

## Alternatives considered

**无框窗口上的 renderer DOM 控件。** 直接 click 和 pointerdown handler、隔离后的拖拽区域以及 main-process IPC 都没有在 Windows Electron automation session 中接收到可用的标题栏事件。这个方案复制了 OS 控件，并留下了平台特有的命中测试缺陷。

**保留标准 Windows frame。** 原生控件可以工作，但 Windows 标题栏会把紧凑的品牌安装器 header 与系统按钮分开。titleBarOverlay 在保留原生控件所有权的同时维持预期的标题栏布局。

**以最大化几何或 isMaximized() 作为 CI 门禁。** Electron 的 Windows automation 对最大化和窗口尺寸存在公开限制，见 [Electron issue 33942](https://github.com/electron/electron/issues/33942)。CI 验证安装器用户流和 package，交互式桌面验证 OS window manager 行为。

## Consequences

Windows 控件从 Electron 继承平台行为、可访问性和命中测试，而不是由 renderer 提供。主题变化会更新原生 overlay 颜色。renderer 不再提供自定义控件图标或窗口管理 IPC，并且标题栏右侧 padding 必须始终足以容纳 Windows overlay 控件。
