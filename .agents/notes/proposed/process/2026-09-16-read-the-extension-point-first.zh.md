# Agent Note: Read the failing extension point before choosing a delivery mechanism

Status: proposed

[English](2026-09-16-read-the-extension-point-first.md) | 中文

## Problem

用户报告：点击产出文件链接（写入 / 读取）后，侧边栏编辑器打开并显示红色失败 —— HTML 预览路由返回 `400 fs-error: cannot resolve target "/kayako-saeki.html"`。会话 cwd 是 `/root/projects`，文件就在那里；路由收到的却是"工作区根相对"写法，被当成了文件系统绝对路径。

先后提出过三种交付机制，前两种是错的：

1. **替换侧边栏的 viewer。** 插件服务暴露 `registerFileViewer`，于是"自己写一个带正确路径解析的 viewer"看起来就是"用我们自己的插件"这一答案。并非如此：内置 `html` viewer 的组件**就是** `TextEditor` —— 同一个组件同时拥有编辑模式、保存，以及两个沙箱设置。以更高优先级取代它，等于用一个缺陷换掉 HTML 编辑能力。注册表只提供"整体替换 viewer"，没有"只改 src 计算"的钩子，而 `dsh-better-sidebar/client` 也不导出 `TextEditor` 可供委托。
2. **把第三方包重新发布到我们的 scope。** 那是官方 `@deepseek-ai/*` workspace 的机制：它们的构建产物 `lib/` 无法表达 TypeScript 改动，因此通过 `overrides: npm:@sparkelf/...` 交付。`dsh-better-sidebar` 不是这种情况 —— 它是外部 npm 包，早已由 `patchedDependencies` 覆盖，部署已经用它交付补丁数月。
3. **在已发布 bundle 上打一个 npm-target 补丁。** 正确，且与树中已有的 `better-sidebar-media-path` 完全同类：同一个包、同一个文件、同一类路径缺陷。

前两个错答案的代价：搭起来又删掉的一个插件包，以及一轮用户纠正。

## Why it reached the workspace

**机制是从 API 表面选的，而不是从出错代码选的。** `registerFileViewer` 被读作"这就是该用的扩展点"，descriptor 的 `priority` 被读作"我们可以接管"—— 两者都对，也都对"内置 viewer 还拥有什么"保持沉默。

**已有的技能没有被加载。** `.agents/skills/dsh-plugin-ownership-and-distribution/SKILL.md` 要求在实现前先读*"the capability's current Host and Client entries, package manifest, bundle patch, settings and persistence owners"*，并报告被拥有的表面。仅它的第一步证据就会显示出 `component: LazyTextEditor`。

**两种机制被混为一谈。** "patch"被当成一件事。在本仓库里它是两件：经 profile 的 `patchedDependencies` 交付的 npm-target 补丁（对外部包有效），以及经 `overrides` 交付的重发布自研包（对官方 workspace 有效）。对一个的判断被套用到了另一个上。

## Proposal

**在新增、迁移或替换任何能力之前，先读当前拥有它的代码，并明确命名适用哪两种交付机制之一。** 具体地：

1. 打开出错入口，读清它是什么 —— 组件、处理器还是配置。对 UI 能力，读当前匹配目标的那条 descriptor，以及它能渲染的每一个组件。
2. 列出该拥有者还提供什么。编辑模式、持久化、设置、disposal 都算被拥有的表面；取走那个 id 就一并取走了它们。
3. 明确命名交付机制，必须是以下之一：profile 配置、我们自己的插件、**对第三方包的 npm-target 补丁**、**重发布的自研包**。
4. 若答案是"我们自己的插件"，说明它挂载在哪个已发布扩展点上、替换了什么。一个静默丢掉既有能力的替换在第 2 步就不成立。

对 UI 能力而言，被跳过的是第 2 步：viewer 注册表的 `registerFileViewer` 读起来像扩展点，而它所取代的内置件是一整个编辑器。

出于同一规则，暴露空转门禁的那次 Agent Teams 依赖变更也由本文承载：这两个包随 dsh 家族一起发布，因此运行时可以依赖它们，而隔离检查现在命名了这一区分，而不是拒绝 `packages/experimental/` 下的每一个包。

## Acceptance criteria

- 从另一个插件接手的任何能力，都要说明该拥有者还提供了什么，且替代品不得丢掉其中任何一项。评审 `dsh-better-sidebar` 的内置 `html` viewer 时，要在动手写替代品之前就指明编辑、保存，以及两个沙箱设置。
- 每个补丁决策都要明确说出四种交付机制之一。针对外部 npm 包的 payload 经 profile 的 `patchedDependencies` 抵达注册表安装；构建产物 `lib/` 无法表达该改动的官方 workspace 则以我们 scope 下的重发布包交付。
- `verify-plus-governance` 会拒绝被改烂的 npm payload。实测：把 `better-sidebar-html-preview-path` payload 的所有上下文行替换为 `MANGLE-XYZ`，门禁以 `npm patch does not apply to dsh-better-sidebar@0.19.1` 失败；未改动的 payload 通过。
- `check-workspace-constraints` 仍拒绝运行时依赖私有实验包，并接受依赖已发布的实验包。spec 同时覆盖两者：`packages/experimental/prototype`（私有）被拒，`packages/experimental/agent-team` 被允许。

## Alternatives considered

**以更高优先级替换内置 viewer。** 否决：它所取代的内置件就是该文件类型的编辑器，这笔交易是拿可用的预览换走编辑、保存及其设置。注册表也没有更窄的钩子，包也不导出可委托的编辑器。

**把 `dsh-better-sidebar` 重发布到我们 scope 下。** 否决：该机制是为构建产物无法表达 TypeScript 改动的官方 workspace 而存在的。这个包是外部的，且早已通过 `patchedDependencies` 抵达部署 —— media payload 自发布以来一直如此。

**保留可应用性门禁原样，继续验证工作区副本。** 否决：仓库忽略 `node_modules`，因此那里的 `git apply --check` 跳过文件并对任何 payload 返回 0。该门禁点名了两个 payload，两个都没检查。

**保留实验性隔离规则原文，在发行版之外启用 Agent Teams。** 被「发行版用户必须能运行它」这一要求否决：Agent Teams 包随 dsh 家族一起发布，所以它们的缺席并不是该规则所要防范的情形。

## Risks

**更高优先级的 viewer 是接管，不是装饰。** 未来任何针对他方拥有扩展点的注册都带有本文所述的同类风险；验收标准覆盖的是评审者的那一步，不是机械的一步。

**可应用性门禁现在需要联网。** `verify-plus-governance` 会按声明范围拉取已发布 tarball，因此无注册表访问时会失败，有访问时也会变慢。替代方案是一个什么都证明不了的检查。

**允许已发布实验包作为运行时依赖，扩大了发行版可承载的范围。** 该例外以显式的 `PUBLIC_EXPERIMENTAL_PACKAGE_DIRECTORIES` 名单为键，因此新的实验包在有人刻意加入该名单前仍保持隔离。Agent Teams 本身处于预稳定阶段：在发行版中启用它，会让每个用户的会话加载一层上游项目并不承诺保持兼容的团队层。

## Findings this change rests on

1. **内置 `html` viewer 就是编辑器。** `dsh-better-sidebar/src/client/builtins/viewers.tsx` 注册 `id: 'html'`、`exts: ['html','htm']`、`component: (props) => <LazyTextEditor {...props} />`；`LazyTextEditor` 加载 `TextEditor`，其 `ViewMode` 含 `preview` 与 `edit`，并拥有 `fsWrite`。三个 viewer（`md`、`html`、兜底 `code`）共用该组件。
2. **`registerFileViewer` 是替换 viewer，不是装饰 viewer。** `src/client/service.ts` 中的服务提供 `registerTab`、`registerFileViewer`、`registerFileIcon`、`openTab`、`closeTab`、`matchFileViewer`；`matchFileViewer` 按 `priority` 降序遍历。没有能收窄内置件 URL 构造的钩子。
3. **`dsh-better-sidebar/client` 只导出 `inject` 与 `apply`。** 外部插件无法导入 `TextEditor` 并委托给它，因此自研 HTML viewer 必须重实现编辑与保存。
4. **html 路由在工作区根相对路径上失败。** `lib/index.js` 调用 `ensureWorkspacePath(await sessionCwdOf(ctx, sessionId), path, fence)`，其中 `ensureWorkspacePath` 先执行 `requireAbsolute` 再 `realpath`。`/kayako-saeki.html` 满足 `isAbsolute` —— 它是合法的 POSIX 根 —— 随后无法解析。客户端经由 `resolveSidebarPath` 到达该状态，其 `isAbsolutePath` 按设计接受单个前导 `/`，并经 `TextEditor` 直接使用 tab path。
5. **media 路由有同一缺陷，且早已被修补。** `better-sidebar-media-path` 将客户端提供的路径约束到会话 cwd；该补丁抵达了已安装的包 —— 证据是其注释出现在 `node_modules/dsh-better-sidebar/lib/index.js` 中。
6. **`patchedDependencies` 能抵达注册表安装。** `apply.ts` 把每个 npm payload 写入 profile 的 `.dsh-plus/patches/` 并在 `pnpm-workspace.yaml` 中注册，由 `pnpm install` 应用。不涉及源码 checkout。
7. **`verify-plus-governance` 已经在把关 npm 补丁的可应用性。** `verifyNpmPatchApplies` 从 distribution 解析目标、核对已安装版本与 variant 范围，并运行 `git apply --check`。被篡改的上下文行会失败。被篡改的 hunk header 行号或被篡改的新增行不会失败，因为 `git apply` 靠搜索上下文定位，无从得知新增行本应是什么 —— 所以该门禁证明的是"补丁能应用"，不是"补丁应用的是预期改动"。
