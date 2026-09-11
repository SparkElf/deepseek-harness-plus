---
description: "独立 Plus 安装的 package map：一个 registry package，用户安装后即可运行，无需 source checkout 或构建。"
kind: "package-group"
---

# standalone/ — SparkElf Plus 独立安装

[English](README.md) | 中文

## Summary

`standalone/` group 存放用户从 registry 安装并运行 Plus 所需的 package。`@sparkelf/dsh-plus-standalone` 是一份 manifest 而非 library：其 dependencies 选择 official runtime 与全部受审 plugin，其生成的 `dshPlusStandalone.bundles` 列表是 launcher 挂载它们的顺序。负责 lifecycle 的 `dsh-plus` command 随 [`bundle/plus/`](../bundle/plus/README.zh.md) 发布，因为基于 source 的安装与基于 registry 的安装驱动同一个 executable。

## Packages

| Package | Role | ctx key |
|---|---|---|
| [`plus-standalone/`](plus-standalone/README.zh.md) | Registry 入口：pin runtime 与 plugin 集合，并携带生成的挂载顺序 | 无；它被安装而非被挂载 |
