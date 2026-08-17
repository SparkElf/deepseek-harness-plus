# Agent Note: Web 设置页"备份"分区与 Host 备份 RPC 对

Status: implemented

[English](2026-08-18-web-settings-backup.md) | 中文

## Problem

Web GUI 没有导出或导入用户设置和数据的途径：桌面托盘备份覆盖已安装的 Windows 用户，但 3080 运行时的浏览器用户没有用于迁移或恢复的压缩包路径，设置面也没有命名该操作。

## Decision

设置对话框新增 `backup` 分区（`settings.section` 槽，新插件 `@deepseek-ai/dsh-client-ui-settings-backup`），把用户设置和数据导出为一个 zip 压缩包（浏览器下载），并从备份压缩包导入恢复。压缩包契约与桌面托盘备份一致（[2026-08-17-plus-desktop-backup-and-console-free-launch](2026-08-17-plus-desktop-backup-and-console-free-launch.md)）：`backup-manifest.json` 标记识别真备份；运行时生成的 `profiles` 和 `supervisor` 目录被排除；导入在改动任何文件前校验标记和每个条目路径（拒绝绝对路径、反斜杠、`..`、空段）；恢复按同名覆盖解压到 harness home。zip 核心放在 `dsh-host-apiproxy`，与设置 wire face 同包，复用其既有 `fflate` 依赖；压缩包以 base64 经回环 RPC 传输。两份笔记各自对应一个表面，保持活跃。

## Alternatives considered

**为备份核心单设 host 包。** 拒绝：设置域已拥有回环 wire face，两个方法挂在其上只保留一个网关、一张 schema 表和一个 client face，而不是第四个注册面。

**流式 HTTP 下载/上传路由。** 拒绝：用户数据量级的压缩包适合 base64 走 RPC，复用一元 carrier 对可以避免在 fetch handler 和 client 里引入第二套传输契约。

## Consequences

- 压缩包体积受浏览器与 Host 内存约束（JSON 上的 base64）。
- 导入恢复文件但不重启另行管理的桌面运行时；Web Host 对设置活体重读。
- 桌面托盘备份保持原样；两个表面共享契约但不共享代码（桌面应用用 adm-zip 打包，Host 用 fflate）。

## Verification

- `packages/host/apiproxy/tests/backup.spec.ts`：往返、缺标记拒绝、穿越/绝对/反斜杠/空段拒绝、运行时目录排除、符号链接跳过、同名覆盖且无关文件保留。
- `packages/client/ui-settings-backup/tests/backup-section.client.spec.tsx`：导出下载触发、本地化拒绝映射、导入成功与拒绝、繁忙态禁用、无文件选择忽略。
- `apps/web/tests/settings-backup.e2e.ts`：对真实 Host 的 UI 闭环——经分区导出、断言压缩包条目与标记、篡改 harness home、经文件输入导入、断言恢复；缺标记压缩包以本地化文案拒绝。
