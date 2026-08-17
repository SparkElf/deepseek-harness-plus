# Agent Note: Plus 桌面无控制台启动与备份恢复

Status: implemented

[English](2026-08-17-plus-desktop-backup-and-console-free-launch.md) | 中文

## Problem

Windows 上从托盘启动 Harness 会留下一个一直存在的 `cmd.exe` 控制台窗口：Supervisor 通过 `pnpm dsh web` 启动 Harness Web，pnpm 经 cmd.exe 运行 package script，这个控制台承载着长期运行的 web 服务直到停止。相关的托盘操作（git 探测、taskkill 停止、WSL 发行版列表）同样会闪现控制台窗口。另一方面，用户没有任何方式导出或导入自己的 Harness 设置和数据（`dshHome`：设置、会话、凭据）用于迁移或恢复。

## Decision

Supervisor 现在直接启动 Harness Web 和开发 watcher：在安装根目录执行 `node --import tsx/esm apps/cli/src/bin.ts web …`，使用 PATH 上的 `node`，stdio 接入 Supervisor 日志，并设置 `windowsHide: true`。这里刻意不使用 Electron 自带的 Node，因为它的 ESM 解析无法处理 pnpm 符号链接的工作区包。`pnpm` 只保留给 `pnpm run build`，其嵌套 script 链不做绕过。桌面侧所有 spawn（Supervisor 辅助命令、安装器的 git/pnpm/wsl 执行）都设置 `windowsHide: true`，GUI 进程的 console 子系统子进程不再创建窗口。

托盘新增"备份与恢复"入口，打开一个包含两个操作的专用窗口。导出把完整的 `dshHome` 目录加上 `backup-manifest.json` 标记条目打包为 zip，写入路径由保存对话框选择。导入先校验压缩包——标记必须存在，包含绝对路径、反斜杠或 `..` 段的条目被拒绝——然后才停止运行中的 Harness，按同名覆盖解压到 `dshHome`，若原本在运行则重新启动，因此无效压缩包不会把 runtime 停在停止状态。缺少标记或路径不安全的压缩包在解压前就以本地化错误拒绝。`dshHome` 的 `settings.yaml` 承载 provider 和模型配置，`.credentials.yaml` 承载被引用的密钥，因此压缩包覆盖完整的用户配置。窗口提示压缩包包含 API 密钥等敏感数据。WSL 目标会被明确拒绝，因为 `dshHome` 位于发行版文件系统内部。

## Verification

Windows NSIS 工作流运行 Playwright Electron 套件，其中新增针对真实已安装 runtime 的备份完整闭环：原生安装完成后，备份窗口导出的压缩包被断言包含 `settings.yaml` 和标记条目；导入无关 zip 会显示本地化拒绝错误且窗口可恢复；导入刚导出的压缩包能恢复被篡改的设置并重启运行中的 Harness——全部步骤经由窗口 UI 完成，仅原生文件对话框以固定选择替代。直接 node 执行另外覆盖了导出导入往返、缺标记拒绝和对构造压缩包的路径穿越拒绝。

## Alternatives considered

**保留 pnpm 启动，仅加 `windowsHide`。** 拒绝：`windowsHide` 只作用于直接子进程，pnpm 的 cmd.exe 孙进程会在服务的整个生命周期内持续可见。

**用 Electron 自带 Node（`process.execPath`）启动。** 拒绝：其 ESM 加载器在插件树加载阶段无法解析 pnpm 符号链接的工作区包；PATH 上的 `node` 与既有源码启动契约一致。

**用 node:zlib 打包 tar.gz。** 拒绝，改用 adm-zip：zip 是用户预期的压缩格式，adm-zip 消除了自持的序列化代码。

**备份 runtime.json 或安装目录。** 拒绝：runtime.json 是本机端口和路径配置，安装目录可从仓库复现；只有 `dshHome` 是用户数据。

## Consequences

启动 Harness Web 要求目标 PATH 上有 `node`，与之前经 cmd 启动时同样从 PATH 解析 `node` 的行为一致。导入按覆盖合并，压缩包中不存在的文件保持原样；刻意不提供清空后恢复。导入在解压前停止 runtime，导入失败时 Harness 保持停止，错误显示在窗口中。
