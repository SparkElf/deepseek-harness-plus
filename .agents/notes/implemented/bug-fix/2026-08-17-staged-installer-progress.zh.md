# Agent Note: 分阶段安装进度

Status: implemented

[English](2026-08-17-staged-installer-progress.md) | 中文

## Problem

安装器在下载、安装依赖和构建 Harness 时只显示 spinner 与阶段句子。操作者无法判断任务是否在推进，也无法知道当前阶段与剩余安装工作的关系。

## Decision

main process 发布包含百分比和阶段文案的分阶段进度契约。准备、环境检查、Git 下载、设置写入、依赖安装、构建、启动和完成分别占用明确区间。Git 的真实 Receiving objects 与 Resolving deltas 输出会映射到下载区间；pnpm 输出只作为当前阶段的活动，不会被误表示为全局完成度。

renderer 在安装摘要下方显示紧凑的可访问 progressbar、百分比、spinner 和本地化阶段文案。命令失败时隐藏进度区域并保留错误消息。Preview 不能进入该流程，因此不能发出模拟安装进度。

## Verification

browser UI harness 使用相同进度 payload 驱动真实 renderer，并观察百分比、aria-valuenow、阶段文案和填充条。Native Windows Electron workflow 会在 NSIS package build 前运行安装器交互；该进度契约随 packaged renderer source 一同发布。

## Alternatives considered

**只显示不确定 spinner。** 否决，因为操作者无法区分任务正在运行还是下载卡住，也无法理解剩余阶段。

**把 pnpm resolved/downloaded 数量当成全局百分比。** 否决，因为这些数量只属于一次 package-manager 操作，不能代表完整安装生命周期。

**为每个命令增加字节级进度。** 否决，因为 Git 与 pnpm 在 native 和 WSL target 上没有统一稳定的总字节契约；阶段进度更诚实，也能跨 target 比较。

## Consequences

进度百分比表达生命周期位置，不承诺精确剩余时间。Git 原生输出可用时，下载阶段会在其区间内推进；依赖安装和构建在阶段边界推进。main process 与 renderer 必须保持阶段区间和本地化文案一致。
