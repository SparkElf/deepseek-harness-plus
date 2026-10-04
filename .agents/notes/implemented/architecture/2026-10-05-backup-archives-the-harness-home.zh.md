# Agent Note：Backup 扫描的是 Harness home，不是 profile 目录

Status: implemented

[English](2026-10-05-backup-archives-the-harness-home.md) | 中文

## 问题

Backup 插件从 Settings 文档推导它归档的目录：`dirname(ctx.settings.documentPath)`。该文档是 profile 的 `cordis.patch.yml`，因此归档根是 profile 目录。每个计划内的条目都按名字在那一个目录里查找，而 profile 不含任何用户数据：会话日志、附件、Workspace 存储、`.credentials.yaml` 与 `.anonymous-user-id` 都写在 Harness home 下。文档旁边唯一存在的计划内名字就是 patch 文件本身。

名字缺失时该查找静默通过，因此导出报告成功，实际几乎什么都没带。在一个 profile 目录含六个文件的部署上实测：`sessions` 导出产出的归档只含一个条目——它的 manifest——而 `all` 导出含两个。任何该部署能产出的归档都无法用于恢复会话。

配置导出携带的是 profile 的 patch 文件，而 `dsh-plus` 每次启动都会整文件重写它。若部署把模型提供方声明在 `$DSH_HOME/cordis.patch.yml`——loader 最后应用、且没有任何东西重写它的那一层，也是升级指南推荐的位置——导出就完全不含提供方。导入该归档不会恢复任何模型，缺陷正是这样暴露的：用户在两个部署之间迁移配置，发现模型不见了。

## 决策

`apply` 把归档根定在 `resolveDshHome()`，即 loader 作为 `$DSH_HOME` 读取、且持有全部被归档类别用户数据的目录。manifest 的 `settingsFile` 仍是 Settings 文档的 basename，因为导入要用它与接收方 profile 的文档比对。

`resolveDshHome` 来自 `@deepseek-ai/dsh-home-paths`，按仓库约定加入 peer 与 dev 依赖并补上 tsconfig reference。

## 考虑过的替代方案

从 Settings 文档推导根、并把 profile 目录当作 home，是此前行为；只有当部署把用户数据放在文档旁边时它才正确，而没有部署会这样，因为 loader 把会话与存储写在 Harness home 下。

在 Harness home 之外再归档 profile 层，会带上一个 profile 归属方每次启动都重写的文件，导入可能重新引入过期的能力行。真正存活的是 Harness home 自己的 patch 文件，它已作为普通顶层条目被归档。

## 测试

两个 spec 覆盖本次修复触及的两半。`archive.spec.ts` 断言各 scope 下 planner 的条目，以及归档字节来自被扫描的根；`index.spec.ts` 断言 `apply` 选择的根，因为 planner 把该根作为参数接收、观察不到它。回退根会让 `index.spec.ts` 以 profile 路径失败。该包此前没有任何测试，这正是「扫到几乎为空的根」长期未被发现的原因。
