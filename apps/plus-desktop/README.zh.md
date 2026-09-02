---
description: "已配置Plus Supervisor的可选Electron tray client。"
kind: "package-reference"
---

# @sparkelf/dsh-plus-desktop

[English](README.md) | 中文

## 概述

该可选Electron tray package读取既有Plus Supervisor manifest，在standalone Supervisor不存在时启动它，并通过tray提供打开Harness和进度页以及启动、停止、重启和构建runtime的命令。它不包含DSH source installer，也不持有Web child process。

## 使用此软件包

Electron host导入<code>runPlusDesktop</code>，传入自身Electron module及可选<code>manifestPath</code>。默认路径是<code>~/.dsh/supervisor/runtime.json</code>。关闭host后Supervisor及Harness runtime继续运行。

## 模型体验

Desktop不添加model content。tray中的restart委托给Supervisor package；其recovery prompt与token effect由[Supervisor README](../../packages/plus/supervisor/README.zh.md#model-experience)记录。

## 已知限制和延期工作

- Desktop管理已经materialize的Plus runtime；安装仍由<code>@sparkelf/dsh-plus</code>持有。
