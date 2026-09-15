# Agent Note：被替换的包必须声明其所在位置的名字

Status: proposed

[English](2026-09-15-substituted-package-declared-name.md) | 中文

## Problem

Plus 发行版通过在 profile 的 `overrides` 中把每个官方名映射到我们的名字，用我们的构建替换二十个官方包。pnpm 把我们的构建装到官方路径，因此消费方代码中已经存在的 import specifier 会解析到我们的代码。

这对**解析**有效，对**注册**无效。client 模块系统先解析 loader entry 声明的名字，然后要求它找到的 manifest 声明**同一个**名字：

```ts
// packages/client/modules
if (typeof name === 'string' && (expectedPackageName === undefined || name === expectedPackageName)) {
  return { path: candidate, packageName: name }
}
// no match: keep walking toward the declaring package root, then give up
```

我们的构建声明 `@sparkelf/dsh-client-ui-settings-models`，却位于 `@deepseek-ai/dsh-client-ui-settings-models`，因此比较失败，该包**完全不拥有任何浏览器模块**。二十个包因此什么都不加载，而它们渲染的每个面板——模型选择器、设置面板、交付物视图——都**静默地从不出现**。包装好了，服务器启动了，没有任何错误被报告。

## Proposal

**在 profile 安装期间，把每个被替换包声明的名字对齐到它所在的位置。**

包保留我们的版本与我们的代码；只有 `name` 字段改为它所装入目录的官方名。改写**替换 manifest 文件**，而不是写入原文件。

## Findings this change rests on

1. **该比较是精确且无条件的。** `name === expectedPackageName` 不接受任何 scope 别名，因此位于官方路径下却声明任何其他名字的包，对模块系统不可见。
2. **该失败是静默的。** 没有任何东西报告它：包在正确路径上、声明了 `dsh.client`、出现在 `cordis.patch.yml` 中、且能按名字解析。在真实安装上实测，服务端模块表带 54 个条目；把六个受影响的 manifest 改名后升到 60 并渲染出面板。
3. **pnpm 把 manifest 硬链接到它的内容寻址存储中。** 实测：profile 的 `package.json` 与存储条目共享 inode，链接数为 2。写入该链接会改动共享该存储条目的每个 profile，因此改写会创建新文件并移动到位置——之后链接数为 1，存储未被改动。
4. **对齐属于安装，而不是打包。** 已发布的包无法声明官方名：registry 每个名字只提供一个包，而我们的构建必须以我们的 scope 发布才能被安装。因此名字是"它被装在哪里"的属性，只有安装方知道。

## Acceptance criteria

- 全新 `dsh-plus start` 产生的 profile 中，每个被替换包都声明其目录的官方名。
- 服务端的 client 模块表包含每个声明 `dsh.client` 的被替换包的模块。
- 改写不改动 pnpm store 中该 manifest 的副本。
- 已经声明正确名字的包不被改写。

## Alternatives considered

- **以官方名发布我们的构建。** 否决：registry 不会在既有名字下提供第二个包，因此官方包无法在那里被替换。
- **给 client 模块的比较打补丁以接受别名。** 否决：它为一个消费方的利益改动官方行为，而这次替换是我们自己的事，应由我们正确表达。
- **把包复制进 profile，而不是安装它们。** 在更早的决定中已否决：复制不是安装，而 profile 需要真实的依赖树来完成它自己的解析。

## Risks

- **该改写假定官方目录名就是预期身份。** 装入不属于它的 scope 的包会被改名到那个 scope。对齐只触及 `@deepseek-ai`，那是发行版 overrides 所拥有的。
- **未来的模块系统可能比较名字之外的东西。** 对齐使 manifest 与其位置一致，而这正是该比较所检验的性质。

## Consequences

- **被替换的包在它所占据的路径上与官方包无法区分**，这正是替换对一个按名字解析它的代码所必须意味着的。
- **对齐在每次 profile 安装时运行**，因此由后续版本装入的包无需单独步骤即被对齐。
