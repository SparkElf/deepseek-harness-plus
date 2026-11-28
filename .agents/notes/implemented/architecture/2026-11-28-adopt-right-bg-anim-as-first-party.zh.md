# Agent Note：将 right-bg-anim 收为自有插件

Status: implemented

[English](2026-11-28-adopt-right-bg-anim-as-first-party.md) | 中文

## 问题

`dsh-right-bg-anim` 是 SparkElf 自有的 DSH 装饰插件，但它以非 scoped 的 npm 包发布（`dsh-right-bg-anim@1.1.0`，author `forestlightelf`），在 Plus profile 里作为第三方 pin 挂载。源码还以 vendored 副本留在 `SparkElf/dataops`，导致所有权、仓库元数据和发布归属与实际维护者不一致。

## 决定

把源码迁到 `downstream/packages/plugins/dsh-right-bg-anim`，以 `@sparkelf/dsh-right-bg-anim@1.1.0` 发布：author 改为 `SparkElf`，repository 指向 `SparkElf/deepseek-harness-plus`，directory 为 `downstream/packages/plugins/dsh-right-bg-anim`。构建同时从 `src/` 生成 `lib/client.js` 和 `lib/index.js`。把该包加入 release manifest 的 `packages.plugins`、`localPackages`、`profileDependencies` 和 `profile.bundles`。LICENSE 与 README 保留对 `JohnnyTing/dsh-official-homepage-theme` 的 MIT 归属，因为流体与网格的运动算法源自它。

## 备选方案

**继续作为非 scoped 的第三方 npm pin。** 否决：这个包是 SparkElf 自有的，pin 会让 profile 依赖个人 npm 身份和 dataops 仓库里的源码副本。

**放到 `downstream/packages/forks/`。** 否决：它不是别人拥有的包的 fork。只有动画算法是派生的，且派生关系已记录在 LICENSE 和 README 中；插件源码和发布都是我们自己的。

## 后果

下一次重建生成的 profile 会解析 scoped 的 workspace 包。当前运行的 profile 在重建前仍使用旧的 `dsh-right-bg-anim@1.1.0`，或者在 scoped 包发布并重新 pin 之后切换。旧 npm 包为兼容性继续保留发布，但 release manifest 不再挂载它。

## 验证

`node scripts/build.mjs` 生成 `lib/client.js`（66,213 字符，10 个模块），并从 `src/index.js` 复制 `lib/index.js`；构建会拒绝重复的顶层声明和 default / export-list 形式。manifest 现在有 27 个自有插件、30 个 local package，`@sparkelf/dsh-right-bg-anim` 同时出现在 `profileDependencies` 和 `profile.bundles`。
