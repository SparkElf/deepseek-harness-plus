# Agent Note：跟随官方 DSH 跨越 1461 个提交的升级

Status: implemented

[English](2026-09-23-following-official-dsh-across-a-release.md) | 中文

## 问题

Plus 分发针对官方 DSH 源码的十五个补丁。官方发布了 `0.1.7-alpha.2`，距这些补丁写作时的基准已有 1461 个提交。每个补丁都是上下文行必须匹配的 diff，因此基准移动这么远会让它们**同时**失效 —— 而且失效方式并不一致：对新基准实测，没有一个能干净应用，八个在 `--3way` 下带冲突应用，七个完全无法应用。

**冲突才是危险的那种。** `git apply --3way` 报告成功，却把双方的声明都留在文件里；而机械地保留补丁一侧，会静默删掉官方在附近新增的内容。本次升级发现了两处这样的删除：连接 RPC 主机里官方的 `OperatorPeer` 导入，以及会话导出菜单里官方新增的 feedback 动作。

## 决策

**按意图重做每个补丁，绝不按 diff 套用；对官方已经采纳其意图的补丁予以退役。**

每个补丁有三种可能结局，判断依据是**先读官方当前代码**再做决定：

| 结局 | 条件 | 需要的证据 |
|---|---|---|
| 重做 | 缺陷在新基准上仍然存在 | 重建补丁自己的断言，并保留官方的相邻内容 |
| 退役 | 官方现在做了补丁所做的事 | 取而代之的上游提交，且它不在旧基准中 |
| 适配 | 机制搬家了 | 新位置，以及从旧到新的映射 |

每次重做在计入之前要通过三项自检：新补丁能应用到干净基准、它的路径不超出该包声明的 `target.paths`、每一条被删除的行都是补丁本就要删的行，而不是官方新增的内容。

## 本改动依据的实测事实

1. **基准 pin 存在于比分发层更多的地方。** `compatibility.dsh`、`sourceBase.revision`、每个补丁包的 `dsh` range 与 `target.baseRevision`、`.agents/plugins/curated.yaml` 的 `pinned` 字段，以及 standalone 校验脚本的 `--runtime-version` 参数，都在指名官方发布版本。门禁能抓到「补丁不再适用」，但没有任何东西能抓到「pin 被落下」，所以升级要一起改。
2. **退役一个补丁是三处改动，而不是删除。** 补丁包目录、`curated.yaml` 里的 `localPatches` 条目、分发层 `profile.bundles` 与 `profile.dependencies` 里的名字。`verify-plus-governance` 分别报告每一处遗漏：前者是 `curation must own upstream retirement for every source patch package exactly once`，后者是 `dshPlus.profile.dependencies must own the exact reviewed production bundle set`。
3. **官方预声明了它自己的退役条件。** 两次退役都是补丁 README 已经写明的条件：*"Retire it when official DSH ships equivalent end-to-end base-path behavior"* 与 *"Retire this package when official DSH exposes an equivalent profile-selected browser-authentication policy"*。先读那一行，就把判断题变成了检查题。
4. **门禁可以把补丁应用到它声明的基准上，也能发现相关包不存在。** `patchPackages` 会物化每个声明的基准 revision 并把补丁应用上去，所以错误的 `baseRevision` 会和错误的 diff 一样响亮地失败。
5. **republish 是同一份源码的另一个消费者。** 分发层用自己构建的包替换二十七个官方包，而那些构建承载补丁。修正后的补丁只有在从补丁树重建并重新发布那个包之后，才会到达 registry 安装 —— 所以升级在补丁能应用时**还没有**完成，而是在重新发布的包承载它们时才完成。
6. **只为某个预览器存在的补丁，随该预览器一起退役。** 官方 `0.1.7-alpha.2` 在自己的右侧栏文档标签页里渲染 Office 与电子表格，且由 `web-app` 默认挂载。`@sparkelf/dsh-plugin-better-sidebar-office` 是为 `dsh-better-sidebar` 预览这些格式的，因此官方能力取代了它。
7. **`office-to-pdf` 接受绝对字体目录，所以公文字体不需要补丁。** 该 provider 暴露 `fontDirectories: string[]` 与 `fontFallbacks: string[][]`，并报告它找不到的字体族。中文公文会指名 方正小标宋 / 仿宋GB2312 / 楷体GB2312 / 黑体，而转换套件不带这些字体，因此由部署指名存放它们的目录。官方已经拥有的配置项能挺过下一次升级；补丁不能。
8. **重做不总是 rebase，有时是删除。** 从 alpha.2 跟到 rc.1（又 156 个提交），两个补丁失败，且失败方式相同：官方**已经实现了该行为**，所以补丁自己的实现不再能与它组合。`wsl-native-open` 曾安装一个 PowerShell 打开器并自带路径字面量构造；官方把它换成了 `explorer.exe` 加一个 `explorerTarget()`，为 Explorer 的命令行解析编码 Windows 路径。把两者拼在一起无法编译 —— 各自引用了对方删掉的辅助函数。该补丁只保留官方仍缺的能力（PATH 无 Windows 条目时在挂载卷上指名 Explorer），其余删除。

9. **基准 pin 是一个集合，移动基准的发布要同时移动它们全部。** 两次升级中，同样七处位置指名了官方版本：`compatibility.dsh`、`sourceBase.revision`、每个补丁包的 `dsh` range 与 `target.baseRevision`、`curated.yaml` 的 `pinned` 字段、standalone 脚本的 `--runtime-version`、以及 release-age 豁免。门禁能抓到「补丁不再适用」，但没有任何东西能抓到「pin 被落下」，所以只有当七处全部移动时这次版本提升才是正确的。

## 已考虑但未采用的方案

**用 `--3way` 应用补丁，合并到什么就用什么。** 未采用：本次升级实测，静默合并删掉了官方的 `OperatorPeer` 与一个 feedback 动作。两者都能编译，也都没有报错。

**把 Plus 机械地移植到新官方基准，只修失败的部分。** 未采用，因为「能干净应用」不等于「仍然需要」。十五个里有四个只需改 `dsh` range，而其中 `web-base-path` 必须退役 —— 官方以不同方式实现了同一行为。

**保留 `web-base-path` 与官方的文档相对路由。** 未采用：两者是**相反的架构**。补丁为保留前缀的代理配置 base path；官方在代理处剥离前缀并从文档目录解析。官方 note 明确否决了配置化 base URL，并且官方带一个门禁（`verify-client-route-resolution.ts`）拒绝补丁重新引入的绝对路由。

**保留已退役的补丁，只加一条 README 说明。** 未采用：`verify-plus-governance` 会遍历 `patches/npm` 下每个目录并把每个补丁应用到其声明的基准，因此留在树里的退役补丁会让构建失败。

## 影响

- 十五个补丁变成十三次重做与两次退役；两项能力从补丁转为官方行为，因此不再需要维护。
- 公文字体通过配置到达官方转换，因此少了一个需要跨版本携带的补丁。
- 未来的升级会重复这一流程。昂贵的部分不是 rebase 而是**阅读**：在碰 diff 之前，必须先针对官方当前代码重新确立每个补丁的意图。
- 重新发布的包是升级的另一半。在它们从补丁树重建之前，registry 安装仍会解析上一个发布的代码。
