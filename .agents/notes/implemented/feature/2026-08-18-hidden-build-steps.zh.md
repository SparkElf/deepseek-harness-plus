# Agent Note: 隐藏构建步骤取代 Supervisor 与安装器构建中的 pnpm

Status: implemented

[English](2026-08-18-hidden-build-steps.md) | 中文

## Problem

`pnpm run build` 会派生嵌套生命周期子进程（npm、cmd），Windows 会给它们分配可见的 console 窗口——`windowsHide` 只作用于直接子进程——于是每次 Supervisor 或安装器构建都弹出一个空终端，开几分钟，真正的输出进了 Supervisor 日志和安装进度条。

## Decision

`hiddenBuildSteps` 列出根构建的五个阶段——`tsc -b tsconfig.host.json`、`tsdown --env.DSH_BUILD_FACE host`、`tsc -b tsconfig.client.json`、`tsdown --env.DSH_BUILD_FACE client`、`apps/web` 下的 `vite build`——Supervisor 和安装/升级/修复流程直接经 `node` 以 `windowsHide` 逐阶段执行，绕过包管理器。WSL 目标用 posix join 复用同一组步骤。本决策取代 [2026-08-17-plus-desktop-backup-and-console-free-launch](2026-08-17-plus-desktop-backup-and-console-free-launch.md) 中"pnpm 仅保留给 build"的选择；pnpm 仍服务于依赖安装。

## Alternatives considered

**保留 pnpm 并隐藏其孙进程。** 拒绝：孙进程在 pnpm 内部派生且不带 `CREATE_NO_WINDOW`，每个无 console 父进程下的 console 子系统子进程都会拿到新的可见 console；我们直接子进程上的标志够不到它们。

**用 `cmd /c` 包裹构建。** 拒绝：同样的孙进程问题，只是深了一跳。

## Consequences

- 构建输出继续流进 Supervisor 运行时日志和安装进度行；任何构建路径都不再弹终端窗口。
- 步骤表复制了根 `build` 脚本的各阶段；脚本变更必须同步 `hiddenBuildSteps`。

## Verification

- Windows CI Electron 套件执行完整安装，其构建阶段经隐藏步骤运行（`installer-electron.spec.mjs` 用例 2、3）。
- Linux 宿主上的 Supervisor `rebuild-and-restart` 使用同一组步骤。
