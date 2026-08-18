# Agent Note: 外部插件维护方案

Status: proposed

[English](2026-08-19-external-plugin-maintenance.md) | 中文

## Problem

本项目不仅追踪、优化 DeepSeek Harness（dsh），也追踪、优化我们感兴趣的外部 dsh 插件，并且很快会有我们自己的独立插件。上游已移除 repository-plugin 机制，外部插件唯一独立分发路径是可安装的 profile 组合包（包声明 `dsh.bundle.patch` patch 层）。没有维护方案时，追踪是临时的（无钉扎、无漂移可见性、无补丁生命周期），而我们的自有插件也会缺少一个使其在上游 dsh 上可安装的归属。

## Proposal

1. **仓库划分。** `deepseek-harness-plus` 继续追踪 dsh 与 Plus 产品，并拥有第三方插件的策展。独立仓库 `dsh-plugins-plus` 存放我们自有插件的源码，使其保持在上游 dsh 上可安装、永不依赖产品 fork。新仓按需创建：第一个自有插件诞生时建仓，不提前；空仓是纯开销。其 CI（typecheck/lint/单测 + 对 dsh master 的组合 e2e）与 CD（npm 发包 + tag）复用本仓已验证的模式。
2. **策展清单** `.agents/plugins/curated.yaml`：每个被追踪的第三方插件一条，含 `name`、`source`（npm spec 或 git url）、`pinned`（Plus 集成与测试的精确版本/SHA）、`interest`、`owner`、`localPatches`（补丁文件、上游 PR 链接、退役条件）、`plusBundle`（Plus profile bundle 是否默认挂载，默认 false，纳入走评审的清单 PR）。第三方插件源码永不 fork 进仓库；钉扎加补丁即追踪。
3. **并行补丁政策。** 优化第三方插件时，向上游提 PR 的同时在 Plus 侧携带补丁，Plus 用户立即受益；清单条目记录上游 PR 链接与退役条件，上游合入即移除补丁。此为显式决策，取代"仅上游优先"政策。
4. **漂移追踪** `scripts/check-curated-plugins.mjs`：把每个钉扎与 `npm view` 最新版或 `git ls-remote` HEAD 对比，输出漂移报告；`--fail-on-drift` 留待后续 CI，`--offline` 供免网络运行；解析与钉扎比较有免网络单测。CI 定时漂移门禁与逐插件 CI 矩阵刻意推迟到首个插件策展之后；清单为空或极小时，手动运行才是正确的成本。
5. **Plus bundle 集成。** 策展插件通过把其 patch 层挂载进 Plus profile bundle 交付；默认集合保持封闭，插件配置在 patch 层完整声明，遵循上游 remove-repository-plugin 决策。

## Alternatives considered

**像 Cordis 一样 vendor 所有插件。** 拒绝：包管理器已负责获取、版本与锁文件；vendor 仍是对上游无响应的关键补丁的最后手段，遵循既有 vendor 政策。

**恢复 repository-plugin 式机制。** 拒绝上游；组合包路径是唯一独立分发路径，且给插件完整配置权。

**现在就建 dsh-plugins-plus。** 拒绝：仓库凭第一个插件挣得自己的存在；划分本身已认可，仅时机按需。

**仅上游优先的补丁政策。** 经决策拒绝：并行上游 PR 加 Plus 补丁立即交付用户价值；退役条件防止 fork 腐烂。

## Consequences

- 漂移在检查器中可见；每次 bump 都是显式、经评审的清单变更。
- 本地补丁带上游链接与退役条件，因而衰减而非累积。
- Plus 默认 bundle 保持封闭集合；策展变更是清单 PR，永不静默。

## Acceptance criteria

- 清单可被免依赖检查器解析，单测免网络通过。
- 首个策展或自有插件落地时，按本注一同落地 dsh-plugins-plus 仓库（自有时）、逐插件 CI 与组合 e2e。
- 每个本地补丁条目带上游 PR 链接与退役条件；两者缺一的补丁在评审中被拒绝。

## Risks

- 并行补丁可能与上游评审反馈分叉；退役条件与上游链接是缓解手段，清单 PR 评审复核它们。
- 漂移检查在首次策展前保持手动；过期钉扎可能滞留，以 bump 前的手动运行为限。

## Verification

- `scripts/check-curated-plugins.spec.ts` 免网络覆盖清单解析与钉扎比较。
- 检查器 `--offline` 免网络运行并报告钉扎。
- 组合 e2e、逐插件 CI 与 dsh-plugins-plus 仓库随首个策展或自有插件一同落地。
