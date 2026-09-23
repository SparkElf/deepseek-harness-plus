# Agent Note: A patched workspace reaches a registry installation only through an override

Status: proposed

[English](2026-09-17-a-patched-workspace-needs-an-override.md) | 中文

## Problem

发行版声明了十六个补丁，而从 registry 安装它的消费者只收到十三个。三个源码补丁 —— WSL 原生打开路径、旧式中断轮次恢复、以及 composer 弹层边界 —— 只到达了源码 checkout。

没有任何东西失败。`verify-plus-governance` 通过，closure gate 通过，已发布的 profile 也带着补丁包。这些能力只是对每一个从 npm 安装的消费者缺席，而对从源码构建的部署存在 —— 这使得「同一个发行版」这一说法以一种没有任何门禁报告的方式变得不成立。

## Why it stayed invisible

**这套机制有两条清单，而只有一条被检查。** 源码补丁抵达 registry 安装需要两步：其目标 workspace 被以我们的 scope 重发布，而消费者的依赖树只有在发行版的 `overrides` 点名它时才优先使用那个包：

```
patches/npm/<name>/                  the patch itself
  ↓ target.paths[].packages/host/open-in-app
PATCHED_WORKSPACES                   repackage this workspace as @sparkelf/dsh-*
  ↓
profile.overrides                    '@deepseek-ai/dsh-host-open-in-app': 'npm:@sparkelf/...'
  ↓
the consumer's install               resolves our package instead of the official one
```

`PATCHED_WORKSPACES` 早已对着补丁文件校验过，其注释恰好解释了这一失败模式。那个检查是通过的。第二环 —— override —— 完全没有检查，因此一个 workspace 可以被重发布却从未被引用。

**其中三个是新增的。** `wsl-native-open`、`session-format-legacy-restart`，以及弹层补丁向 `ui-permission-presets` 的迁移，都是在最近几轮加入的。每一个都带着自己的补丁包与 curation 条目 —— 而那正是既有门禁会看的东西 —— 却没有一个进入决定消费者是否安装它的那两条清单。

**另有一个条目在反方向过期。** `packages/client/ui-conversation` 仍在 `PATCHED_WORKSPACES` 里，而已无任何补丁点名它，于是它发布了一个补丁集并不描述的包。既有的检查抓到了这一个；缺失的那一半什么也没抓到。

## Proposal

**两条链接都检查，并让检查读取补丁文件而不是清单。**

`PATCHED_WORKSPACES` 增加四个条目、移除一个。那个已把它与补丁头对照的 spec，现在还会验证：对它里面的每一个 workspace，发行版的 `overrides` 都点名了该 workspace 自己的包名。包名以 workspace 的 `package.json` 为准，因为路径拼接产不出它：`apps/web` 发布为 `@deepseek-ai/dsh-web-frontend`，`packages/bundle/web-app` 发布为 `@deepseek-ai/dsh-web-app`。

`republish-patched-official.mjs` 增加 `--skip-publish`。一次在首个 registry 已有版本处停下的发布，会让其后的 tarball 根本未被解包 —— 而当一次发版新增一个 workspace 时，已发布集合正是常态：既有的每个成员都在，只有新增项是新的。

## Findings this change rests on

1. **重发布而没有 override，等于什么都没交付。** `package-patched-official.mjs` 写出 `@sparkelf/dsh-*`；除非 `dshPlus.profile.overrides` 做替换，消费者的依赖树仍会 import `@deepseek-ai/dsh-*`。
2. **三个 workspace 被重发布却未被引用。** 对照已发布的 registry 实测：`@sparkelf/dsh-host-open-in-app`、`@sparkelf/dsh-native-command`、`@sparkelf/dsh-session-format-v0-to-v1`、`@sparkelf/dsh-client-ui-permission-presets` 完全没有发布过任何版本，因此没有任何安装能抵达它们。
3. **补丁头点名了每一个被改动的 workspace。** `workspacesThePatchesModify` 已经从 `diff --git` 头推导期望集合，因此清单检查需要的只是它缺失的那一半，而不是新的真相来源。
4. **包名是 workspace 自己的 manifest 名。** `apps/web` 是 `@deepseek-ai/dsh-web-frontend`；从路径推导会得到一个不存在的包名。
5. **override 的 key 是官方名，value 是替换物。** 该检查拿 workspace 的 manifest 名与 keys 比较。
6. **已发布集合在新增项发布之前不等于完整集合。** 增加四个条目后，`republish` 打包 23 个而不是 20 个；已有的二十个版本会在第一个成员上返回 `E403` 并中止整轮运行，因此这四个新增项需要各自的发布过程。

## Acceptance criteria

- `PATCHED_WORKSPACES` 里的每个 workspace 都有一条 `overrides` 条目点名其包。移除其中一条时，spec 会以列出的缺失 workspace 失败 —— 已通过移除 `packages/host/open-in-app` 实测。
- `PATCHED_WORKSPACES` 与声明的补丁所改动的 workspace 集合双向相等。
- `republish-patched-official.mjs --skip-publish` 只打包并验证、不发布，且其输出目录含全部 tarball。
- 安装发行版的消费者为每个被补丁改动的 workspace 解析到我们的包。

## Alternatives considered

**只把四个条目加进 `PATCHED_WORKSPACES`。** 否决：仅重发布对消费者毫无改变，补丁仍然不可达。override 才是必须成立的那一环。

**从 `PATCHED_WORKSPACES` 自动推导 overrides。** 暂不采纳：发行版 manifest 是被评审过的数据，生成其中一部分会把一项经过评审的决定搬进构建步骤。检查让这份清单自我纠错，而不去生成它。

**只为新增项发布一个新发行版。** 否决：`profile.overrides` 是发行版自己的字段，因此条目与它们点名的包一起在下一个 Plus 版本中交付。

## Risks

**新增一个源码补丁仍需要两处手改。** 该检查会报告缺失的 override，但不会报告「尚无补丁引入、却缺失的 `PATCHED_WORKSPACES` 条目」；补丁作者两处都加，而只落一处时门禁会大声失败。

**override 钉住了版本。** 每条条目里都是 `0.1.6-alpha.2`，因此以新版本重发布需要全部更新。`verify-plus-governance` 比较的是 profile 依赖集合，那是相关但不同的字段。

**停留在旧 Plus 版本上的消费者仍带着这个缺口。** 修复在他们升级时抵达；没有任何东西能追溯地把补丁补进一个已经发布的版本。
