---
description: "被省略能力的 overrides 占位包，使安装结果中不会出现真实包。"
kind: "package-reference"
---

# @sparkelf/dsh-omitted

[English](README.md) | 中文

当部署不允许安装某个能力时，把它指向的占位包。

## 目录

- [使用](#use-this-package)
- [已知限制和延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

## 概述

npm 通过 `overrides` 表达包替换，且没有删除语义：override 只能把包替换成另一个包，不能删除它。因此省略某能力的部署把 override 指向本包，被替换的名字就不会出现在安装结果里。

省略也因此可审计：扫描依赖树会找到占位包，而不是被它替换的能力包。

<a id="use-this-package"></a>
## 使用

```json
{
  "overrides": {
    "@deepseek-ai/dsh-computer-use": "npm:@sparkelf/dsh-omitted@0.2.0-rc.17"
  }
}
```

<a id="dev-note"></a>
## 开发备注

本包只为一件事存在，因此除了本仓库每个插件都声明的 Cordis peer 之外没有自己的依赖。

- 不发布运行时 invariant 伴随模块，因为本包不导出任何内容也不持有状态；替换由 npm 解析出的安装树观察，而不是由本模块观察。

<a id="model-experience"></a>
## 模型体验

### Omitted capability substitution

#### What the model sees

什么都没有。`@sparkelf/dsh-omitted` 不注册自己的工具、提示词段落或 Session 事件，而安装它的部署省略了它所替代的能力。

#### Token effect

零。本包不增加任何模型请求 token。

#### KV Cache effect

无。它不贡献提示词内容，因此不会移动缓存前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和延期工作

- 本模块不导出任何内容。把它当作真实插件加载会在挂载步骤以缺失导出报错，这是有意为之：省略了某能力的部署不应静默挂载它的替身。该部署也不应把被替换的名字作为 bundle 挂载。
- 本包无需配置的行为，也没有命令。
