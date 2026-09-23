---
description: "DataOps AI 工作区的注册表安装入口：固定运行时与经评审的插件，但不含内网部署不允许运行的能力。"
kind: "package-reference"
---

# @sparkelf/dsh-dataops-standalone

[English](README.md) | 中文

从注册表安装 DataOps AI 工作区，无需源码检出、无需构建、无需 git，即可打开浏览器界面。
## 目录

- [使用](#use-this-package)
- [模型体验](#model-experience)
- [已知限制和延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

## 概述

一次 `npm install` 带来官方运行时、Plus 发行层，以及 DataOps 工作区所需经评审的插件。随后 `dsh-dataops start` 写入 `dataops-web` profile、选择空闲端口、启动服务并打印 URL。其余命令覆盖启动器交给用户的部分：stop、status、update、doctor。

本包是 `@sparkelf/dsh-plus-standalone` 的 **DataOps 变体**。它安装的内容严格更少：内网工作区不允许运行的能力**不在依赖集合里**，而不只是「安装但不挂载」，因此镜像合规扫描不会发现它们。

变体只在分发层的 `dshPlus.profile.standaloneVariants.dataops` 声明一次，本 manifest 由它生成。因此分发层新增的插件仍会进入本包，除非变体显式排除它。

<a id="use-this-package"></a>
## 使用

```sh
npm install -g @sparkelf/dsh-dataops-standalone
dsh-dataops start
```

| 命令 | 效果 |
|---|---|
| `dsh-dataops start` | 首次运行写入 profile、选择空闲端口、启动服务并打印 URL |
| `dsh-dataops stop` | 在宽限期内结束后台服务 |
| `dsh-dataops status` | 报告服务是否在运行以及端口 |
| `dsh-dataops update` | 升级到更新的已发布版本；`--check` 只报告不安装 |
| `dsh-dataops doctor` | 检查 Node、发行层、profile 与端口 |

<a id="capabilities-this-variant-omits"></a>
### Capabilities this variant omits

| 省略的包 | 能力 |
|---|---|
| `@deepseek-ai/dsh-computer-use` | 驱动 Windows 桌面 |
| `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp` | 该能力背后的 cua 驱动 |
| `@deepseek-ai/dsh-web-search-exa` | 通过 Exa 路由网络搜索 |

`@sparkelf/dsh-mobile-bridge` 在分发层即已省略，因此此处同样没有。

<a id="dev-note"></a>
## 开发备注

- `src/bin.ts` 把所有命令转发给 `@sparkelf/dsh-plus` CLI；后者读取本包的 `dshPlusStandalone` 声明来物化 `dataops-web` profile 并应用省略 overrides。该分发层为何拥有经评审的集合，记录在[分发层 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-29-ranged-plus-patchset-distribution.zh.md)中。
- 不发布运行时 invariant 伴随模块，因为本包只声明依赖集合并把每个命令转发给 CLI；它物化的 profile 由该 CLI 观察，而不是由本包观察。

```sh
tsx scripts/standalone/generate-manifest.ts --distribution packages/bundle/plus \
  --out packages/standalone/dataops-standalone/package.json \
  --runtime-version <dsh version> --variant dataops
```

<a id="model-experience"></a>
## 模型体验

### DataOps variant installation

#### What the model sees

没有它自己的内容。`@sparkelf/dsh-dataops-standalone` 选择运行时与 `dataops-web` profile 挂载的插件；它不注册任何工具、提示词段落或 Session 事件。模型只接触到被挂载插件所暴露的内容，而被省略能力的工具根本不会注册。

#### Token effect

零。本包不增加任何模型请求 token。它移除了被省略能力的工具，因此一次会话携带的工具 schema 少于完整 Plus 部署。

#### KV Cache effect

无。它不贡献提示词内容，因此不会移动缓存前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和延期工作

- 排除清单复述的是分发层拥有的事实。分发层新增的包在本变体命名它之前不会被排除；而变体命名了分发层未声明的包时生成器会失败，因此两个方向都不会静默漂移。
- 本变体是生成产物，不是手写文件。分发层变更后用 `--variant dataops` 重新生成，而不是直接编辑 manifest。
