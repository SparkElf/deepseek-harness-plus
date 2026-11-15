# Agent Note: The source mirror must run dsh-plus apply

Status: proposed

[English](2026-11-09-the-source-mirror-must-run-dsh-plus-apply.md) | 中文

## Problem

DSH Plus `0.2.9-alpha.75` 于 2026-11-09 发布。它把 base 提到 `0.2.2-rc.1`，并把 `dsh-better-sidebar 0.30.1-sparkelf.19`、`@sparkelf/dsh-dataops-managed 0.3.48`、`@sparkelf/dsh-group-chat 0.5.11` 固定为最新。3080 仍在服务 `plus-021rc2d`，因此升级是针对这个版本尝试的。

构建在切换之前就失败了。实测到四个事实：

- `dsh-plus-mirror` 仍从 `patches/npm/*` 应用源码补丁。0.2.9 的重构删除了那套载体；现在只剩 `better-locale-peer-range`，所以循环报告 `patches applied: 0 of 0`，而发行版里的 31 个 `dsh-source` 条目实际位于 `packages/bundle/plus/patches/*.patch`。
- 同一个脚本用 `git archive <tag> | tar -x` 加 `git init && git add -A && git commit` 创建 release 树。树的内容与 `dsh-v0.2.2-rc.1` 一致，但 HEAD 是一个新的本地提交（`c0b73522...`），不是官方的 `66491b05...`。`dsh-plus apply --dsh-root` 要求精确的官方 revision，因此拒绝这棵树。
- `dsh-plus install --edition team` 写出的 profile 带有 34 条形如 `"@deepseek-ai/dsh-client-connection": npm:@sparkelf/dsh-client-connection@0.2.2-rc.1` 的 redirect。这些是新补丁模型的 registry 侧一半。它们不是已退役的 npm patch 载体，但它们在 `0.2.2-rc.1` 上也没有发布；npm 上只有 `0.2.2-alpha.2`。
- 已发布的 `@sparkelf/dsh-plus@0.2.9-alpha.75` 为 `@sparkelf/dsh-plugin-backup` 和 `@sparkelf/dsh-plugin-mcp-credentials` 声明了 `workspace:` 依赖；pnpm 在工作区之外会拒绝它们。

一次手工源码构建应用了 31/31 个补丁，并在把 34 条 redirect 改写成官方 `0.2.2-rc.1` 包之后装出了 profile。随后它没能通过 `verify-profile-bundles`：manifest 声明 20 个 bundle，profile 有 21 个，且 profile 列表缺少 `@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-experimental-agent-team-profile`、`dsh-experimental-auto-review`、`dshmarket` 和 `@sparkelf/dsh-plus`。因此这份 profile 不能被称为 source-mirror 产物。

## Proposal

让 source-mirror 构建遵循 0.2.9 发行版已经实现的模型：

1. `dsh-plus-mirror build` 把树创建成官方 tag 的真实 checkout（`git clone --branch <tag>`，或 `git fetch` 后 `git checkout` 对应 tag 的 commit），使 HEAD 等于 `dshPlus.sourceBase.revision`。
2. 用官方包版本物化 profile：source mirror 不使用 `deriveRedirects` 的目标，因此从 `pnpm-workspace.yaml` 删除 34 条 `npm:@sparkelf/...@<runtime>`，并把对应的依赖别名改写成官方 runtime 版本；或者让发行版直接写出 source 模式的 profile。
3. 在 profile 存在且可安装之后运行 `dsh-plus apply --dsh-root <tree>`：它应用全部 31 条 `target.kind: dsh-source` 的 `patchSet.entries`，写出完整的 profile 组合（bundle 列表与 runtime 包），并把 `@deepseek-ai` 作用域链到打过补丁的源码。
4. 然后由 `dsh-plus-build` 编译打过补丁的树；`dsh-plus-exemptions` 为 runtime 写出 `compatibility.json`；`verify-profile-bundles` 对照 `apply` 写出的组合，而不是对照 registry edition。
5. `dsh-plus-switch` 提升已验证的树，失败时回滚。

发布侧的修复是独立的，但一个可发布的产物需要它们：在官方 revision 上发布那 34 个重发布包，或者停止为 source 构建派生 redirect；并用具体版本重新发布 `@sparkelf/dsh-plus`，而不是 `workspace:` 范围。

## Deployment outcome

升级已于 2026-11-09 完成。在 `66491b05` 的 clone 上改写 34 条 redirect 后装入了官方 rc.1 包；`dsh-plus apply --dsh-root` 应用了 31/31 个源码补丁，并写出完整的 20-bundle 组合；`dsh-plus-build` 通过了全部 10 个构建门禁。构建出的 profile 在备用端口启动，86 个客户端条目，侧边栏有会话行。`verify-profile-bundles` 被直接比对替代，因为已安装的 helper 仍在期待 `dshPlusStandalone.bundles`。

`dsh-plus-switch` 没能完成这次提升。它的 reload 客户端使用新 profile 的 supervisor，在 `/root/.dsh/supervisor/runtime.sock` 上收到 `ECONNREFUSED`；switch 随即回滚。在写完 manifest 后执行 `systemctl restart` 也失败：旧 supervisor 在停止时会把内存中的 manifest 写回，于是重启后的 supervisor 读到旧 CLI，而 profile 链接指向新树，旧 CLI 从新的 `@deepseek-ai/dsh-util-time` 导入 `Cron` 失败。可用的顺序是：先停 unit，写入带新 `cwd` 和 `args[0]` 的 `runtime.json`，再启动 unit。当前部署服务 `0.2.2-rc.1` 与 plus `0.2.9-alpha.76`；`verify-start` 报告 HTTP 200、86 个客户端模块、WebSocket 101。

## Evidence

| 检查 | 结果 |
|---|---|
| 手工应用源码补丁 | 31/31 |
| 用官方 rc.1 安装 profile | 改写 redirect 后成功 |
| `verify-profile-bundles` | manifest 20，profile 21；缺底座 bundle |
| 在已构建树上运行 `dsh-plus apply` | 拒绝：HEAD `c0b73522`，期望 `66491b05` |
| npm 上的 `@sparkelf/*@0.2.2-rc.1` | 34 个中 0 个存在；最新 `0.2.2-alpha.2` |
| 尝试期间 3080 | `plus-021rc2d`，HTTP 200，84 个客户端 bundle |

## Alternatives considered

**发布那 34 个重发布包，保留 registry 路径。** 这是 standalone 安装的文档化路线，也能让已发布产物自洽。但它不可撤回，为了一台主机发布 34 个包，而且不修复 3080 实际使用的 source-mirror 工具。

**使用 `0.2.8-alpha.50` 加 base `0.2.2-alpha.2`。** 该 runtime 的重发布包存在，但它的 `dsh-plus-mirror` 有同样的 `git archive`/heredoc/bundle 组合缺陷；同时放弃了 rc.1 base 和最新的插件固定版本。

**保留本地 workaround（打源码补丁、改写 redirect、编辑 bundle 列表）。** 它能产出 profile，但不是已验证的产物；bundle 列表仍与发行版不一致，而且每次重建都要重复工具本应拥有的手工修改。

## Acceptance criteria

- 一次全新的 `dsh-plus-mirror build --tag dsh-v0.2.2-rc.1 --runtime 0.2.2-rc.1` 在不依赖未发布 `@sparkelf` 包的情况下成功。
- 在 `dsh-plus apply` 运行之前，树的 HEAD 等于 `dshPlus.sourceBase.revision`。
- `dsh-plus apply` 应用 31/31 个源码补丁，并写出 `verify-profile-bundles` 接受的 bundle 列表。
- 构建出的 profile 能在备用端口启动，base 为 `0.2.2-rc.1`、plus 为 `0.2.9-alpha.75`，并使用固定的插件版本；页面能提供其客户端 bundle。
- `dsh-plus-switch` 提升该树，`dsh-plus-status` 报告新 release；切换失败时 `plus-021rc2d` 仍在服务。

## Risks

**edition 投影可能有意省略旧 profile 挂载的插件。** 构建出的 profile 缺少 `@sparkelf/dsh-mobile-bridge` 和 `@sparkelf/dsh-quant`；为了匹配旧的 24-bundle 组合把它们加回来，可能重新引入发行版已不再支持的插件。

**`0.2.2-rc.1` base 可能拒绝旧插件的 peer 范围。** `dsh-plus-exemptions` 是接纳它们的唯一机制；空的或过期的豁免列表会静默跳过插件。

**`apply` 和 `build` 绿灯仍不能证明页面能启动。** 客户端启动检查和一次真实回合才是验收证据，而不是构建退出码。