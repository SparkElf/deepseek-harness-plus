# Agent Note：精简的 standalone 变体声明它省略了什么

Status: implemented

[English](2026-09-22-standalone-variants-declare-omissions.md) | 中文

## 问题

DataOps AI 工作区镜像不允许运行 computer-use、cua 驱动与 Exa 网络搜索，合规扫描也不应找到它们。此前镜像从 pinned 源码构建分发层、用 `dsh plugin add` 装配 profile，因此排除逻辑以 shell 的 `case` 语句与 `test ! -d` 断言存在于 Dockerfile 中。没有任何东西把它们与分发层自己的插件集合绑定，于是分发层新增的包会进入镜像，除非有人记得补一条断言。

已有机制中有两个事实使「包级别裁剪」无法实现：

1. `--omit=optional` 无法表达它。传递依赖树里还有平台包位于 `optionalDependencies` 中 —— `sharp`（`@img/sharp-libvips-*`）、`koffi`、`@vscode/ripgrep`、`pg-cloudflare` —— 省略它们会破坏镜像运行时。

2. npm 没有删除型 override。`overrides` 把包替换成另一个包，不能删除；而且依赖包自己的 `overrides` 会被忽略：npm 只从安装根读取它们。

实测：把这三个包从变体自己的 `dependencies` 中排除后它们仍被安装，因为 `@sparkelf/dsh-plus` 声明了它们，npm 会装上整棵树（`npm ls @deepseek-ai/dsh-computer-use` 经 `dsh-plus` 解析到了它）。

## 决策

**变体在分发层声明一次，由安装包把该声明带到 profile。**

三部分，各拥有一件事：

| 部分 | 拥有 |
|---|---|
| `dshPlus.profile.standaloneVariants` | 某个变体的包名、profile 名与被裁剪的包 |
| 生成 manifest 中的 `dshPlusStandalone` | 同样的事实，放在 npm 与 CLI 能读到的位置 |
| `dshPlusStandalone.omittedPackages` | 包名到 override spec 的映射，写入 profile 工作区 |
分发层把能力声明为 `optionalDependencies`，因为分发层能运行它们但不要求它们。这正是「省略」可被表达的前提：必需依赖意味着没有它部署无法工作，而对变体允许丢弃的能力来说这是错的。

被省略的能力是**被替换而非被删除**：`@sparkelf/dsh-omitted` 是一个不导出任何内容的占位包，变体的 `omittedPackages` 把每个被排除的名字指向它。替换使省略可审计 —— 扫描依赖树会找到占位包而不是该能力 —— 而占位包刻意不导出任何内容，因此挂载它会显式失败，而不是静默替换该能力。

CLI 从自身文件向外走到安装它的包来读取声明（`readStandaloneDeclaration`），这就是同一个 `dsh-plus` 构建能同时服务完整与精简部署的方式。它把省略项写入 profile 的 `pnpm-workspace.yaml`，与分发层的 `overrides` 放在一起，那是 pnpm 唯一会读取它们的位置。

## 本改动依据的实测事实

1. **生成器本来就参数化了分发层，而不是变体。** 缺的轴是 `--variant`；裁剪只是对生成器已读取事实的一个过滤，因此不存在第二个生成器。

2. **生成器会拒绝命名了分发层未声明内容的变体。** 把 `@sparkelf/dsh-mobile-bridge` 放进排除清单会让构建失败，因为该包完全不在分发层里。清单无法偏离它所裁剪的集合。

3. **默认 manifest 未变。** 不带 `--variant` 生成时仍产出 `@sparkelf/dsh-plus-standalone` 下的 29 个依赖，因此公网消费者拿到的与之前完全相同。

4. **被替换包已有名称对齐机制。** `alignReplacedPackageNames` 会把被替换包声明的名字改写为它所占据目录的官方名，因为客户端模块系统要求 `name === expectedPackageName`。占位包从不作为 loader 条目被挂载，因此不受该要求约束。


## 已考虑但未采用的方案

**安装后从镜像中删除这些包。** 未采用：这会让 `package.json` 声称依赖一份并不携带的树，下次安装会把它们装回来，而且它把排除藏在镜像构建里，而不是放在拥有该集合的分发层。

**保留 Dockerfile 中的断言。** 未采用：那正是本改动所替代的安排，且它只能断言包不存在，无法使其不存在。

**为每个部署准备一份变体专属的分发层 manifest。** 未采用：分发层经评审的集合是一个事实，它的第二份拷贝需要手工保持相同。

**完全不再把能力声明为依赖，改为启用能力时按需安装。** 未采用：内网部署无法按需访问 registry，而且它会让启用能力依赖启动时的网络。


## 影响

- 镜像可以从 registry 安装，无需源码检出也无需访问 GitHub，因为精简集合是被发布的而不是被装配的。
- `verify:standalone-variants` 与 `verify:standalone-manifest` 并列在共享门禁集中运行，因此分发层的变更若未被变体考虑会让构建失败。
- 被移入 `optionalDependencies` 的能力对保留它的部署仍会被安装；默认 manifest 把它列为普通依赖。
- 向分发层添加能力需要为每个变体决定是否保留它。生成器的校验让省略是显式的而不是隐含的。
