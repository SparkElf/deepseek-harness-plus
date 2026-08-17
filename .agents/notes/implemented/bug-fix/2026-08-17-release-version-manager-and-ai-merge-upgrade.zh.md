# Agent Note: Release 版本管理与 AI 合并升级

Status: implemented

[English](2026-08-17-release-version-manager-and-ai-merge-upgrade.md) | 中文

## Problem

托盘更新操作只报告 upstream commit 数量，直接升级也跟随 remote branch。它没有展示 release 版本、回退目标，也没有把 release 与本地源码修改整合的入口。

## Decision

托盘打开由仓库 plus-v release tags 及其 peeled commit refs 驱动的版本管理器。每行提供普通源码刷新和 AI 合并两种操作。普通刷新 fetch 并 reset 到用户选择的精确 commit，重建依赖，并在原 runtime 运行时重启。该操作同时支持回退到旧 release，并把选中的 source ref 记录到 runtime metadata。

AI 合并会创建真实 Harness Web session，将已安装 workspace 作为 cwd，提交明确指令：检查本地修改、保留 .dsh-plus/home、获取并整合选择的 release、解决冲突并运行检查；随后通过 reload 前恢复 dsh.sessions.current，在 Electron BrowserWindow 中打开该 session。用户可以在正常 Harness 界面审阅 agent 的工作。

## Verification

Windows Electron package 包含 version manager renderer 和 release-pinned source generator。Windows NSIS workflow 在 native installer interaction 后继续作为 packaging gate。公开 fork 上的 Git exact-SHA fetch 已验证；pull-request build 从 pull_request event 的 head SHA 生成 source reference，release build 从 checked-out commit 生成，确保安装器从 fork 可达的 commit 获取源码，而不是 shallow checkout 的 merge ref。Windows 原生命令失败会在传给 renderer 前按 UTF-8 或 GBK 解码；root web build 改为通过 npm 调用 web package，不再依赖 shell 全局 pnpm 命令。runtime metadata version 4 保存 Harness、测试 Harness、Supervisor 和测试 Supervisor 四组端口；Windows native Supervisor 通过 Electron utilityProcess 和 unpacked bootstrap 启动，控制管道由选择的 Supervisor 端口命名，并等待 endpoint 开始监听后才继续启动。bootstrap 会持久化完整 startup stack，安装器会返回该错误，不再把子进程失败缩减为 named-pipe ENOENT。Windows 因替换已打开的 status manifest 可能以 EPERM 失败，因此原位写入该文件。命令 socket 在每次收到数据行时重置连接超时，Supervisor 在等待网页服务监听期间发送心跳，网页启动窗口为 120 秒，缓慢的首次启动不会再在进度中途超时。`yaml` 包随 unpacked Supervisor 源码一并解包，因为纯 Node 无法解析只存在于 app.asar 内的依赖；构建后的 `verify:unpacked-imports` 步骤会导入打包产物的 Supervisor 模块图，将仅打包环境出现的解析失败挡在发布之前。

## Alternatives considered

**统计领先 remote branch 的 commit 数量。** 否决，因为 commit 数量不标识 release，也不能提供回退目标。

**托盘升级始终使用 remote default branch。** 否决，因为 release 不可复现，可能安装比 packaged desktop manager 更新的代码。

**普通升级静默合并本地源码。** 否决，因为冲突解决需要模型和工具操作及用户可见审阅；普通模式保持确定性源码替换，AI merge 必须显式选择。

## Consequences

版本列表依赖可访问的仓库 tags 和配置的代理。普通升级将 tracked source files 替换到选择的 commit，并保留 untracked user data。AI merge 可以通过普通 Harness tools 修改 workspace，因此由独立 session 承载明确任务，而不是由托盘进程直接修改 checkout。
