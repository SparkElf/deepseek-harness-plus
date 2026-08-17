# Agent Note: 受保护的 Harness 覆盖安装

Status: implemented

[English](2026-08-17-protected-harness-overwrite-installation.md) | 中文

## Problem

安装器只接受空目录。失败的 clone 或已有 Harness checkout 因此需要用户手动清理目录才能再次安装或升级，而无保护的清理可能删除 .dsh-plus/home 下的用户设置和凭据。

## Decision

安装位置的高级选项提供明确的覆盖选择，并说明会保留用户数据。安装包记录构建该 release 所使用的精确 Harness source commit。main process 将目标分类为空目录、已有 Harness checkout、链接或不安全路径以及其他非空目录。空目录会初始化到 pinned release commit；已有 Harness 目录必须勾选覆盖，并只用 Git 将受版本控制的源码刷新到同一 commit；其他非空目录继续拒绝。

覆盖安装不执行 git clean。[安装器代理与下载恢复](2026-08-17-installer-proxy-and-download-recovery.md)负责有界网络重试；覆盖重试保留已有目标，新安装重试可以重置由 installer 所有的目录。只有 settings.yaml 和 .credentials.yaml 缺失时安装器才写入，因此已有用户配置和凭据保持不变。代理和其他 runtime metadata 单独保存到本地 runtime record。review summary 会显示覆盖模式已启用。

## Verification

Native Electron workflow 操作高级覆盖控件，确认 review summary，并继续经过真实安装流程。Windows NSIS packaging 在 Electron interaction test 之后执行。runtime directory classifier 会在修改源码前拒绝链接目录和无关非空目录。

## Alternatives considered

**删除目标目录后重新 clone。** 否决，因为用户数据和本地 runtime 文件位于安装目录下，不能从 source repository 重建。

**把所有非空目录都作为覆盖目标。** 否决，因为目录选择器可能指向无关项目或个人目录；必须同时满足 source markers 和明确 checkbox。

**总是更新已有 checkout。** 否决，因为空目录必须保持可预测的首次安装路径，而已有 checkout 可能包含用户刻意保留的源码修改；覆盖是明确的源码破坏操作，同时保留用户数据。

## Consequences

勾选覆盖后，已有 Harness checkout 中的 tracked source edits 会被安装器记录的精确 source commit 替换。包括 .dsh-plus/home 在内的 untracked files 保持不变。链接路径和无关非空目录必须重新选择，不执行破坏性清理。
