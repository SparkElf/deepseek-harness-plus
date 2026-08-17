# Agent Note: Plus Desktop 内置包管理器

Status: implemented

[English](2026-08-17-bundled-package-manager-for-plus-desktop.md) | 中文

## Problem

打包后的 Plus Desktop 安装器按命令名 spawn pnpm。普通 Windows 安装不能保证 pnpm 位于 PATH，因此首次安装会失败并报 spawn pnpm ENOENT。已安装 Supervisor 的 Web 启动、watcher、upgrade 和 repair 路径也有同样假设。

## Decision

Plus Desktop 将 pnpm 11.7.0 声明为 production dependency，electron-builder 会把它的 CLI 和 bundled distribution 打进 app.asar。Native target 通过 Electron executable 并设置 ELECTRON_RUN_AS_NODE=1 执行内置 pnpm.mjs，不依赖用户 PATH。TargetRuntime 统一拥有 install、upgrade 和 repair 的这套调用。

Native Supervisor 通过 DSH_PNPM_CLI 接收内置 CLI 路径，并对 Web、watcher 和 build 使用同一调用。WSL 不会接收 Windows CLI；TargetRuntime 在所选 Linux distribution 内执行 corepack pnpm，并用 DSH_PNPM_COMMAND=corepack 启动 WSL Supervisor。

## Verification

内置 resolver 已在本地不查找 pnpm 命令而实际运行 pnpm 11.7.0。Linux directory package 的 app.asar 中包含 node_modules/pnpm/bin/pnpm.mjs 和 node_modules/pnpm/dist/pnpm.mjs。Native Windows workflow 负责 packaged NSIS artifact 及其真实 Electron installer interaction 的最终验收。

## Alternatives considered

**要求用户全局安装 pnpm。** 否决，因为系统安装器必须拥有首次安装所需的 runtime，并且要能在干净 Windows PATH 上运行。

**把平台专用的 pnpm executable 放在安装器旁边。** 否决，因为 pnpm 是 Node CLI，而 Electron runtime 已为 native target 提供匹配的原生 Node executable。

**在 WSL 中运行 Windows 内置 CLI。** 否决，因为 WSL 需要 Linux package-manager 进程；Corepack 会在所选 distribution 内解析 pnpm。

## Consequences

打包应用会因包含 pnpm distribution 而增大，但 native target 的 install、upgrade、repair、Supervisor start 和 build 不再依赖全局 pnpm 命令。WSL 仍需要所选 distribution 内有可用的 Node/Corepack，并会在该环境中报告失败，而不会误用 Windows executable。
