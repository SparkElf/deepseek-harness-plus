# Agent Note: Plus 安装器目录浏览器移植

Status: implemented

[English](2026-08-17-plus-installer-directory-browser-port.md) | 中文

## Problem

Plus Desktop 安装器此前使用更小的单列目录 dialog，并在 renderer preview 中返回伪造的 Windows 路径。它没有保留 Harness 目录浏览器的面包屑、Miller 分栏、嵌套创建和隐藏条目交互，preview 还可能看起来像安装已经完成。

## Decision

安装器继续使用 plain HTML 和 JavaScript renderer，但完整移植[Harness 目录浏览器](../../architecture/2026-07-28-directory-picker-capability-seam.md)的交互契约：680×500 dialog、带编辑入口的 breadcrumb path bar、以选择项为锚的 Miller 分栏、嵌套新建文件夹 dialog、带 check 的隐藏条目开关，以及没有选中目录时回退到当前列目录的 Open 行为。

Electron main process 通过现有 preload IPC 提供真实的平台 home 目录、文件系统 ancestry crumbs 和按名称排序且上限为 1,000 条的目录列表。renderer 不再生成 Windows 用户名或目录列表。Node directory entry 只能识别点号开头的隐藏名称；Windows hidden 和 system attribute 无法通过此 API 获取，这与现有 Harness browse 的限制一致。浏览器 preview 没有文件系统能力，因此会拒绝选择目录和安装，不再发出模拟路径或进度事件。

## Verification

完整 Miller 布局已通过与 Electron IPC 使用相同 home、crumbs 和 entries 字段的浏览器 visual harness 驱动验证。它显示了选中的左列、右侧子目录列、面包屑、footer actions 以及 680×500 尺寸。真实 Electron Playwright 流程会断言初始路径不是旧的 C:\Users\you sentinel，选择目录后产生第二列，并且 Open 返回 Windows runner 上实际选中的目录。

## Alternatives considered

**使用原生 Windows 文件夹 dialog。** 否决，因为安装器必须复用 Harness 的 in-app 目录浏览器，并在所有支持的平台保持相同交互。

**保留更小的自定义单列 dialog。** 否决，因为它改变既有导航语义，隐藏被选目录的子目录，也是这次安装器与参考组件出现视觉差异的来源。

**让 preview 模拟安装。** 否决，因为浏览器无法访问目标机器的安装文件系统或 runtime 进程。看起来成功的 preview 会让未安装的应用无法与已完成安装区分。

## Consequences

Windows 和 WSL 安装流程使用同一个目录浏览器交互，而 main process 的路径适配仍然分开。目录浏览器组件发生变化时，其视觉与键盘行为必须同步到 Harness 组件契约。Preview 仍可用于静态布局检查，但不能声称文件系统或安装成功。
