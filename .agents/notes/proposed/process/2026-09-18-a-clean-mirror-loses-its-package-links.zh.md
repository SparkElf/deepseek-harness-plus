# Agent Note: Rebuild the package links after any operation that cleans the mirror

Status: proposed

[English](2026-09-18-a-clean-mirror-loses-its-package-links.md) | 中文

## Problem

把被服务的镜像从 dsh 0.1.6-alpha.1 移到 0.1.6-alpha.2 后，产生了一个在 3080 上应答、却缺失两个插件的服务。启动日志报告：

```
dsh: warning: 3 entries did not activate
agent-team (@deepseek-ai/dsh-experimental-agent-team): failed to import
tool-agent-team (@deepseek-ai/dsh-experimental-tool-agent-team): failed to import
```

两个包都能从 profile 解析；而从镜像根导入它们会失败于 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'`。镜像的 `packages/experimental/agent-team/node_modules` 不存在，因此其清单声明的依赖没有可解析的链接。

## Why it happened

**仓库只在根级忽略 `node_modules/`。** `.gitignore` 第 6 行是 `node_modules/`，它匹配镜像顶层目录，不匹配 `packages/` 下的任何东西。于是每个 workspace 自己的链接目录既未被跟踪、也未被忽略 —— 而这正是 `git clean -fd` 会删除的状态。

**一次 rebase 步骤跑了那个 clean。** 把三个不兼容的补丁搬到 alpha.2 上，需要在多次尝试之间重置工作树，而 `git clean -qfd` 就是那次重置。它删除了整个镜像里的 `packages/*/node_modules`，其中包括那两个依赖链足够浅、因而会大声失败的 Agent Teams 包。

**没有任何东西把症状与原因连起来。** 这个失败读起来像是插件与新上游版本不兼容 —— 包存在，profile 声明了它们，而且 `pnpm install` 已经跑过。修复它的重装只要七秒。

## Proposal

**把镜像的包链接当作构建产物：clean 会删除它们，因此任何重置之后都要重跑安装。**

1. 永不在镜像里跑 `git clean -fd`。用 `git checkout -- .` 重置已跟踪文件，别动未跟踪目录。
2. 任何可能删除它们的操作之后，断言每个声明了依赖的 workspace 都有 `node_modules` 目录，缺了就重装。
3. 把启动警告当作门禁结果而不是日志噪音：「N entries did not activate」点名的是部署声称要挂载的包，每一个名字在被证伪之前都是回归。

## Findings this change rests on

1. **忽略规则只覆盖根级。** `git check-ignore packages/experimental/agent-team/node_modules` 退出码非零，因此 `git clean -qfd` 会删除它。
2. **该依赖是上游的，不是补丁集的。** `git show HEAD:packages/experimental/agent-team/package.json` 在 alpha.2 上列出 `"@deepseek-ai/schemastery": "workspace:^"`，且没有任何补丁修改那份清单。
3. **profile 侧始终完好。** `profile/node_modules/@deepseek-ai/schemastery` 指向 `vendor/schemastery` 并能解析；缺的只是包内的链接。
4. **`pnpm install --no-frozen-lockfile` 约七秒恢复它们**，并创建全部三个缺失目录。
5. **恢复后插件挂载正常。** `--dump-config` 列出 `agent-team`、`tool-agent-team` 与 `ui-agent-team`，且四个 `tool-subagent*` 条目处于禁用 —— 这正是 Agent Teams profile 层意图中的组合。
6. **命令式重启会恢复会话。** `supervisor reload` 报告 `sessionsCaptured count=1`，随后 `sessionsRecovered recovered=1, failed=0`。

## Acceptance criteria

- 镜像提升的任何步骤都不跑 `git clean`。
- 提升在启动服务之前，验证每个声明了依赖的 workspace 都有链接目录。
- 启动时的「did not activate」条目与 profile 声明的 bundles 对照，任何已知列表之外的名字都让提升失败。
- 重启走 supervisor 自己的命令（它们捕获并恢复会话），而不是 `systemctl`。

## Alternatives considered

**在 `.gitignore` 里加不带前导锚点的 `node_modules/`。** 作为修复被否决，但值得一提：裸 `node_modules/` 会让每个 workspace 的链接目录都被忽略，从而 clean 无法删除它们。然而镜像是上游的检出，改它的忽略规则会让一个下一次 `git checkout` 就会还原的文件产生分歧。

**留一条「rebase 后记得跑 pnpm install」的备注。** 否决：检查才让它成为门禁而不是习惯，而习惯正是这里失败的东西。

**把这些插件判为与 alpha.2 不兼容。** 测量推翻了它：链接存在后它们导入正常，且 `--dump-config` 显示 profile 层意图中的组合。

## Risks

**检查是按镜像的、且不快。** 遍历每个 workspace 清单要花几秒，且它必须针对被提升的那个镜像运行，而不是一份共享列表。

**缺失链接也可能来自真正缺席的可选依赖。** 检查报告的是 workspace 而非原因，因此操作者仍需先读清单再重装。
