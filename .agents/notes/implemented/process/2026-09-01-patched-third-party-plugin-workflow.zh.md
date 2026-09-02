# Agent Note: 让打过补丁的三方插件继续由 Plus 补丁负责

Status: implemented

[English](2026-09-01-patched-third-party-plugin-workflow.md) | 中文

## 问题

一个三方插件可能同时存在两个有效代码位置：上游源码仓库，以及为 Plus profile 补丁展开的包。当前 DSH profile 执行的是打过补丁的包，因此只修改上游 checkout 不会改变待测产品。如果没有常驻的所有权检查，贡献者可能分别在两个代码平面实现和验证，却以为自己正在修改同一个插件。

## 决策

每个三方包或插件任务都先检查根工作区和当前 profile 的 `pnpm-workspace.yaml#patchedDependencies`。命中的包继续由 Plus 补丁负责：贡献者修改 `pnpm patch` 生成的目录或保留的 `packages-preview/<topic>/edit` 目录，使用 `pnpm patch-commit` 重新生成补丁，并验证声明该补丁的 profile。展开后的包已经包含此前的 Plus 改动，因此贡献者只做增量修改，不用上游产物替换整份构建文件。

受管 profile Host 只在 profile 安装和验证完成后通过自己的 supervisor 重启。official Plus 部署使用 `deepseek-harness-plus.service`；直接终止进程或用 `nohup` 启动会绕过 supervisor 所有权和诊断。

上游 checkout 属于独立的贡献平面。打过补丁的 Plus profile 通过所需验证后，贡献者再把相同行为移植到干净的上游分支并提交上游 PR。开发 Plus 时，上游源码改动不能替代内部补丁。

根 `AGENTS.md` 承载每次都会加载的所有权检查。贡献者操作步骤归 `docs/development.zh.md` 所有；补丁文件和 profile 的 `patchedDependencies` 条目继续作为可执行事实源。

## 曾考虑的替代方案

- **只在上游 checkout 开发，然后安装到本地。** 不采用，因为它绕过 Plus 实际交付的确切包和补丁，本地成功不能证明当前 profile。
- **直接修改 `node_modules` 或生成后的补丁。** 不采用，因为安装文件可随时重建，手工编辑补丁也无法保留可复现的展开和提交工作流。
- **把每个打补丁的插件都以源码形式收进仓库。** 不采用，因为 package patch 足以承载有界的下游改动，并能保持上游所有权，而无需把另一份源码树引入 Plus。

## 后果

- Agent 在编辑代码前识别包所有权，因此会在克隆上游仓库前发现当前 profile 补丁。
- 内部评审查看 Plus 实际交付的补丁；内部验证通过后，上游评审接收干净的源码级改动。
- 修改打补丁的包可能需要维护两份同步 diff，但每份 diff 都只有一个 owner 和一个验证目标。
- 增量 patch 修改保留既有 Plus 兼容性，supervisor 负责的重启把导入失败集中记录在同一个服务 journal 中。
