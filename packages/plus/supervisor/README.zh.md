---
description: "独立的Plus runtime监管及受控重启Session恢复。"
kind: "package-bundle"
---

# @sparkelf/dsh-plugin-supervisor

[English](README.md) | 中文

## 概述

该package在一个npm release中连接两个process roles：Host Cordis plugin公开当前运行中的顶层Session集合并接收恢复prompt，plain Node Supervisor则启动、停止、构建及重启一个由显式manifest描述的Plus Web runtime。受控重启会在shutdown前立即记录running Sessions，并在replacement runtime开始监听后为每个Session排入一条恢复消息。

## 目录

- [使用此软件包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制和延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此软件包

Plus profile会mount Host entry并materialize <code>dsh-plus-supervisor</code> executable。外部process读取一个manifest：

~~~json
{
  "dshHome": "/root/.dsh",
  "port": 3080,
  "supervisorPort": 3082,
  "socketPath": "/root/.dsh/supervisor/runtime.sock",
  "runtime": {
    "command": "node",
    "args": ["/path/to/apps/cli/lib/bin.js", "--profile", "plus", "--port", "3080", "--no-open"],
    "cwd": "/path/to/materialized-dsh"
  },
  "build": {
    "command": "pnpm",
    "args": ["run", "build:official"],
    "cwd": "/path/to/materialized-dsh"
  }
}
~~~

使用 <code>dsh-plus-supervisor --manifest &lt;path&gt;</code> 启动Supervisor。同一executable还接受放在 <code>--manifest</code> 前的 <code>status</code>、<code>start</code>、<code>stop</code>、<code>restart</code>、<code>rebuild-and-restart</code>。进度页监听配置的<code>supervisorPort</code>，展示process、build、capture与recovery phases。

一次restart依次执行：可选build、捕获当前running顶层Session ids、停止旧process、启动配置命令、等待Web port，然后排入recovery prompt。普通start、stop、process crash及network reconnect不发送恢复消息。

<a id="model-experience"></a>
## 模型体验

### 受控重启恢复

#### 模型看到什么

每个被捕获的Session收到一条普通user message，说明Supervisor重启了DSH，要求模型检查durable history、当前workspace state和tool results，避免重复已经完成的操作，完成剩余工作，并在没有剩余任务时回复`已完成`。Session Controller通过正常`SessionController.prompt` path记录该消息。

#### Token影响

恢复后的Session会把固定恢复指令加入下一次request，并在后续history中保留，直到compaction将其shadow。

#### KV Cache影响

恢复prompt追加到既有Session request series。process重启不保留process-local cache state。

## 已知限制和延期工作
<a id="known-limitations-and-deferred-work"></a>

- 恢复prompt失败时Supervisor会报告失败，但不会自动重试。
- 每个Supervisor process管理一个runtime manifest及一个Web port。

<a id="dev-note"></a>
### 开发备注

[Supervisor package Agent Note](../../../.agents/notes/proposed/architecture/2026-09-02-plus-supervisor-packages.zh.md)持有process拆分及recovery lifecycle。
