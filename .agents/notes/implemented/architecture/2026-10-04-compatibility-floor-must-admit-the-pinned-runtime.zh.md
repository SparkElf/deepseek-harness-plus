# Agent Note：兼容性下限必须涵盖被 pin 的运行时

Status: implemented

[English](2026-10-04-compatibility-floor-must-admit-the-pinned-runtime.md) | 中文

## 问题

一个 Plus 发行版通过两个由发布一同移动的值到达它的运行时：`dshPlus.profile.overrides` 把每个官方包 pin 到一次重新发布构建，`dshPlus.compatibility.dsh` 声明该发行版接受的最旧运行时。`generate-manifest.ts` 把该下限写进 standalone manifest，作为 `@deepseek-ai/dsh` 依赖，npm 依据该下限解析出启动器。

没有任何东西比较这两者。把 overrides 移到 0.2.1-alpha.1 而下限仍停在 `>=0.2.0-rc.2`，产出的镜像在 0.2.1-alpha.1 插件旁装了 0.2.0-rc.2 启动器。插件兼容性门禁逐个拒绝它们，profile 从未启动，镜像报告 `DSH_START_FAILED`。

下限不能直接等于 pin。它是一个只增不减的范围，后续补丁可以抬高它；而 semver 只在比较器指名同一个 major.minor.patch 时才放行 prerelease：`>=0.2.0-rc.2` 会排除所有 0.2.1 prerelease，无论后者新多少。因此发布一个新 patch 版本的 prerelease 时必须移动下限，而没移动时失败点离操作者的改动很远。

## 决策

`verify-plus-governance` 要求 `dshPlus.profile.overrides` 里 pin 的每个版本都满足 `dshPlus.compatibility.dsh`。

该 gate 断言的是关系而非某个值，因此对任何后续发布都成立：它从 overrides 读出被 pin 的版本，再问 semver 该下限是否放行它们。低于 pin 的下限会让 gate 失败并同时点名两个版本；等于或高于 pin 的下限通过。

## 考虑过的替代方案

从 `sourceBase.revision` 推导下限可以省掉需要维护的第二个值，但仓库没有把 git revision 映射到已发布版本的途径：官方 tag 在上游远端，而发布本身已在 overrides 里携带它所指的版本。推导出的下限也会阻止一次补丁发布独立于 base 抬高下限，而后者正是当前表达一次经过评审的兼容性决策的方式。

在 `generate-manifest.ts` 里把下限改写成精确版本会 pin 住启动器依赖，但下限是被发布出去的，是消费者读取兼容性的依据，并且已经是 manifest 生成器消费的唯一输入。
