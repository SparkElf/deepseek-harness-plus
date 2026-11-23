# Agent Note: 基座升级先于插件修复，Plus 从修复后的集合发版

Status: proposed

[English](2026-11-23-base-upgrade-precedes-plugin-repair.md) | 中文

## Problem

3080 部署目前运行 official `0.2.2-rc.2`，其上是 Plus `0.2.9-alpha.92`。用现有推进路径把它搬到 official `0.2.3-alpha.2`，会同时改变三件互相独立的事：基座运行时、插件集合、Plus 补丁载荷。结果一旦失败，没有任何观测能说明是哪一件造成的。2026-10-29 对 `0.2.2-alpha.2` 的尝试正是这样失败的：新基座拒绝了 profile 的审批策略，两个 bundle 无法解析，276 条 scope 链接仍指向上一个 release。每个缺陷都真实存在，但在整棵树已经切换并回滚之前，没有一个能被归因。

2026-11-09 的 source-mirror 失败记录了同一类混淆在构建侧的表现：apply 步骤、redirect 集合和 profile 组合各有不同的错误原因，报告只能在四项独立测量之后把它们分开（[记录](2026-11-09-the-source-mirror-must-run-dsh-plus-apply.zh.md)）。

推进路径还会在弄清新基座已经能做什么之前就发版。一个补丁或插件存在，是因为 `0.2.2-rc.2` 缺少某项能力；即使 `0.2.3-alpha.2` 已经提供同样的行为，它仍会在新基座上被重建、重新发布并挂载。于是 release 携带的代码，其唯一理由是一个已经不再运行的基座，而下一次升级会继承它。

## Proposal

每次基座升级都按六个阶段执行，顺序固定。前一阶段的验收证据不存在时，后一阶段不开始。

### Phase 0 — 冻结并记录基线

记录 `dsh-plus-status --json`、正在服务的 release 路径、`runtime.json`、`accepted-profile.json`、profile 的 `package.json` 与 `pnpm-workspace.yaml`，以及当前 `@sparkelf/dsh-plus` 版本。保持正在服务的 release 不动，作为回滚锚点。后续每个阶段都构建到新目录或隔离的 `DSH_HOME`。

### Phase 1 — 裸基座，然后剔除无法挂载的项

在隔离的 profile 中安装 official `@deepseek-ai/dsh-base@0.2.3-alpha.2` 与 `@deepseek-ai/dsh-web-app@0.2.3-alpha.2`，不加载 Plus 层。在备用端口启动，并证明一次真实轮次，而不只是 HTTP 200。然后逐个挂载该 edition 的 bundle，逐项记录它能否解析、导入、挂载，以及能否通过一次冒烟交互。

失败的 bundle 从本次 release 的候选集合中剔除。失败记录写明 bundle、版本、声明的 peer 范围、确切错误，以及失败所在的阶段。剔除是 release 决策，不是静默跳过：遗漏要记录在 edition manifest 与阶段报告中。

### Phase 2 — 逐个修复不兼容插件

每个被剔除的 bundle 一次只做一个修复：放宽或修正 peer 范围、适配被重命名或删除的 API、更新 client slot 或 settings schema，或重建原生依赖。修复后的包通过打包并把 tarball 安装进裸 profile 来测试，因此测试不依赖 registry 发布。若修复无法在插件自身边界内表达，则按插件归属流程重新分类，而不是打进 official 包。

阶段结束时产出一张兼容矩阵，写明每个 bundle、其旧版本与新版本、结论，以及该结论的证据。

### Phase 3 — 先退役，再优化

阅读 `dsh-v0.2.2-rc.2..dsh-v0.2.3-alpha.2` 的 release notes 与源码 diff。对每个 Plus 补丁条目和每个自研插件，追问新基座是否已经提供该行为。`retireWhen` 条件已满足的补丁应当退役，而不是 rebase。重复新基座能力的插件从 edition 中移除，其源码删除或归档。可以改为消费新扩展点、而不必自带 workaround 的插件，简化到该扩展点。

输出是逐条目的处置：`retire`、`simplify`、`keep` 或 `new`，并附上支持该判断的上游标识或 release note。

### Phase 4 — 发布修复后的集合，再组装清单

对每个载荷发生变化的包 bump 版本，构建整个仓库，运行治理门禁。把 `dshPlus.sourceBase`、`compatibility.dsh`、`runtime.version` 以及重新发布的 official 包更新到 `0.2.3-alpha.2`。用已验证的包版本组装 `dshPlus.editions.personal` 与 `dshPlus.editions.team`；`intranet-team` 遵循同一规则，因为工作区容器安装它。

通过 `release:ship --family plus` 发布有变化的 `@sparkelf/*` 包与新的 `@sparkelf/dsh-plus`。edition 清单、补丁集与已发布的包版本是一个产物，一起发布。

### Phase 5 — 在裸基座上安装 Plus

在干净的 `0.2.3-alpha.2` profile 中运行 `dsh-plus install --edition personal`，并把结果启动在备用端口。验证 client bundle 数量、已挂载的工具、一次真实轮次、Session 恢复与侧边栏。对 `team` 重复一遍。已发布发行版的 registry 安装是验收测试；源码镜像不能替代它，因为源码镜像不检验已发布的依赖图。

只有两个 edition 都通过之后，正在运行的部署才迁移。生产切换沿用现有的 supervisor、profile-guard 与闭包门禁流程。

### Phase 6 — 更新工作区容器

把 DataOps 工作区镜像的基座与 Plus pin 更新到已验证版本，重建镜像，并在容器内运行同样的裸安装验收。宿主部署与容器是同一个已发布产物的两个独立消费者，分别验证。

## Alternatives considered

**按现有推进技能的描述，直接把 Plus 推到新的 official tag 上。** 不予采纳，因为它一次改变基座、插件和补丁载荷。2026-10-29 的失败表明由此产生的错误无法归因，而回滚必须一次撤销三项变化。

**保留旧基座，只针对旧基座修复插件。** 不予采纳，因为它只是推迟基座迁移，并不降低其成本；插件之后仍要做同样的修复，而那时基座已经落后于已发布的 official 线。

**每个插件修好就立刻发布。** 不予采纳，因为这样 edition 与 Plus manifest 会由已发布和未发布版本混合组装，某个阶段失败时 registry 会领先于 release。修复先本地打包安装，直到集合自洽，再一次性发布。

**用源码镜像作为验收环境。** 不予采纳，因为源码镜像直接链接打过补丁的 workspace，不能证明已发布的依赖范围可解析。验收测试必须从 registry 安装，这才是一个消费者实际经历的过程。

## Acceptance criteria

- 裸 `0.2.3-alpha.2` profile 在备用端口启动、返回 HTTP、提供其 client 模块，并完成一次带工具调用的真实轮次。
- personal 与 team edition 中的每个 bundle 都有兼容结论，并附确切失败或通过证据。
- 每个修复过的插件都能从其打包 tarball 安装进裸 profile。
- 每个 Plus 补丁条目都有 `retire`、`simplify`、`keep` 或 `new` 处置，并绑定一个上游标识。
- `dshPlus.sourceBase.revision` 为 `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`，且 `dshPlus.compatibility.dsh` 写明 `0.2.3-alpha.2`。
- 干净的 profile 能从 registry 安装已发布的 personal 与 team edition，并以相同的 bundle 数量和一次可用轮次启动。
- 工作区容器运行同样的已发布版本，并通过同样的冒烟测试。
- 正在服务的 3080 部署由 `dsh-session`、`dsh-tools` 和 `dsh-host-webserver` 报告 `0.2.3-alpha.2`，而不只是分发包装层报告。

## Risks

**裸基座测试通过，Plus profile 仍可能失败**，因为 Plus 补丁会改变 official 包。Phase 5 就是为这个缺口存在；Phase 1 不是组合后 profile 的证据。

**为一个 edition 移除 bundle 可能让另一个 edition 无法挂载**，因为 team edition 与 personal edition 共享依赖。每个 edition 各自做挂载测试，移除按 edition 记录，而不是全局记录。

**插件修复可能掩盖基座回归。** 放宽 peer 范围只是让解析器接受某个版本，并不证明 API 行为仍然正确。每个修复都需要一次行为冒烟测试，而不只是安装成功。

**已发布产物可能与测试过的 tarball 不同。** 验收安装读取 registry，因此传播是测试的一部分；本地 tarball 通过是前置条件，不是结果。