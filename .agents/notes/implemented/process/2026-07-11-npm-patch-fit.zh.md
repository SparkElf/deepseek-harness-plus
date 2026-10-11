# Agent Note: Patch fit is checked where pnpm applies it

Status: implemented

[English](2026-07-11-npm-patch-fit.md) | 中文

## Problem

`pnpm` 拒绝不精确的补丁。GNU `patch` 允许 fuzz，`git apply --3way` 会按上下文对齐，所以一个重定向后
hunk 头仍描述旧版本的补丁，能通过每一步不使用 pnpm 的构建——包括以「`git apply` 是否失败」来判断补丁
好坏的 mirror 构建。

2026-07-11 实测：把 better-sidebar catalog 补丁从 0.24.1 重定向到 0.25.0 时，补丁正文下移了 3078 行，
但 hunk 头没有跟着改。`patch` 在 fuzz 2 下接受，mirror 构建报告成功，镜像构建在 30 分钟后以
`ERR_PNPM_PATCH_FAILED` 失败。此前的两道门禁——manifest 检查与 dsh-source 补丁应用——都通过了，
因为两者都不按 pnpm 的方式应用补丁。

## Decision

`scripts/standalone/verify-npm-patches.mjs` 作为 `npm-patches` 门禁，与既有的 standalone 门禁并列，
检查两个属性：

1. **适用性**。用 `patch --fuzz=0`（即 pnpm 的严格度）把每个补丁应用到实际安装的目标包上，抓出
   已经完全不适用的补丁。
2. **自洽性**。把每个 hunk 头与它实际持有的行数对比。pnpm 在任何地方应用补丁都强制这一条，而重定向
   破坏的正是它：旧 header 声称 5 行旧、23 行新，而 hunk 实际是 6 行和 24 行。

安装是可选的，因此门禁也能在 CI 跑（那里没有 release 树），此时只做 header 检查；在本机上额外的适用性
检查覆盖正在服务的 profile——也就是镜像将要构建的来源。

## Alternatives considered

**依赖 mirror 构建**。它已经会应用 dsh-source 补丁并对结果做类型检查，而它正是漏掉这个问题的步骤。
它也抓不到：它用 `git apply --3way`，恰好会按上下文对齐 pnpm 拒绝的那种漂移。

**直接用 pnpm 应用**。要测试 pnpm 自身行为的唯一办法就是安装，而这正是本门禁要避免的开销——它预防的
失败花掉 30 分钟，检查本身不到 1 秒。

**检查已发布的包**。补丁的目标包属于其他发布者，逐个拉取会把网络放进每次 push 都要跑的门禁路径里。

## Consequences

不能应用的补丁在门禁处报告，而不是在镜像构建时。门禁无法证明补丁适用于本机未安装的版本，所以重定向仍
需在新目标第一次进入 profile 时对该目标验证。
