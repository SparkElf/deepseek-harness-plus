# Agent Note: 外部插件维护方案

Status: implemented

[English](2026-08-19-external-plugin-maintenance.md) | 中文

## Problem

DeepSeek Harness Plus 会交付选定的外部插件，而这些插件仍由各自上游独立维护和发布。如果没有统一的策展流程，产品清单、锁文件、默认 profile、本地补丁和上游发布会静默漂移；自动升级又可能把未经评审的第三方代码带入 Plus 发布物。

## Decision

`deepseek-harness-plus` 负责第三方插件策展和产品组合。独立的 [dsh-plugins-plus 仓库](https://github.com/SparkElf/dsh-plugins-plus) 负责 SparkElf 自有插件源码，使这些插件无需依赖 Plus fork，也能安装在上游 dsh。

第三方插件保留在其上游仓库中。`.agents/plugins/curated.yaml` 记录来源、经过测试的精确版本或提交、所有者、关注理由、本地补丁生命周期，以及 Plus 是否默认挂载。包管理器锁文件获取该发布物；Plus 不复制或重新发布插件源码。

### 默认组合

带 `plusBundle: true` 的策展条目是由安装包维护的 Web 依赖。`pnpm run verify:plus-governance` 要求 npm 策展 pin 与 `packages/bundle/web-app/package.json` 中的精确依赖版本一致。`packages/boot/app-boot/src/profile.ts` 挂载封闭的默认集合，并且只规范化精确匹配的历史官方组合；其他 Bundle 列表均由用户所有。

`dsh-better-sidebar`、`@sparkelf/dsh-mobile-bridge` 和 `dshmarket` 是默认 Web Bundle。`dshmarket@1.29.2` 已包含[宿主所有权修复](https://github.com/dsh-market/dsh-market/pull/316)和[多分类兼容](https://github.com/dsh-market/dsh-market/pull/323)：发现目录识别活动的 profile Bundle，但不把安装包提供的 Bundle 加入更新或卸载目标；宿主提供市场时隐藏自身管理控件；字符串或数组分类都可以搜索和筛选。`dsh-better-sidebar@0.16.1` 已包含[移动端不可用状态和溢出修复](https://github.com/omdsh-dev/DSH-better-sidebar/pull/254)。这些已发布实现不再需要 Plus 补丁。

### 并行补丁生命周期

凡 Plus 对外部插件源码做的改动，无论是修复、增强还是新功能，都必须将代码和测试作为 pull request 提交上游。Issue 可以跟踪工作，但不能替代 pull request；无法创建 pull request 时，工作保持 blocked。临时 `pnpm patchedDependencies` 补丁记录该实现 PR 和退役条件，`scripts/check-curated-plugins.mjs` 会拒绝 Issue 或任意 URL。Plus 不维护长期源码 fork。

### 上游漂移与发布流程

`scripts/check-curated-plugins.mjs` 比较 npm pin 与已发布最新版，并比较 git pin 与远端 HEAD。`--offline` 在不访问网络时校验并报告本地清单；`--fail-on-drift` 在版本漂移时返回 2，上游查询未完成时返回 1。

`.github/workflows/curated-plugin-drift.yml` 每日执行联网检查，并维护一条包含当前报告的 GitHub Issue。全部匹配后关闭该 Issue。工作流不会修改 pin、锁文件、补丁、profile 或发布物。

Plus 发布任务只消费锁文件中经过评审的精确依赖。修改 pin 或退役补丁前，采纳评审会比较本地意图和涉及文件与已发布上游实现，再检查区间内的依赖、公共 API、profile 持久化、Host 和 Client 生命周期及 UI 改动。每个重叠项都报告为已吸收、语义分歧或相邻风险；未解决的分歧或未知行为会阻止更新。删除补丁或安装成功本身不属于兼容性证据。上游发布只有通过普通 pull request 更新策展记录、依赖 pin、锁文件、补丁生命周期、用户文档和相关验证后，才能进入 Plus。

## Verification

`scripts/check-curated-plugins.spec.ts` 在不访问网络时覆盖清单解析、实现 PR URL 校验、漂移状态、查询失败优先级、默认 Bundle pin 匹配和本地补丁注册。`scripts/dshmarket-inbox-compat.spec.ts` 导入精确锁定的上游源码，验证只用于目录的 Bundle 投影，以及多分类规范化、筛选和本地化标签搜索。`packages/boot/app-boot/tests/profile.spec.ts` 覆盖新 profile 初始化、已知安装包维护的 Web 组合迁移，以及自定义组合保留。候选 Web 验证在提升前通过实际组装的 profile 操作插件市场和侧边栏。

## Alternatives considered

**Vendor 或 fork 每个策展插件。** 拒绝，因为 npm 和 git 已负责获取与版本身份，而 fork 会让 Plus 接管无关源码树和发布线。带上游退役条件的短期补丁已经覆盖实际差异。

**定时检查后自动更新 pin。** 拒绝，因为外部插件会执行 Host 和浏览器代码，并可能修改 profile。检测自动完成；采纳仍是经过评审的产品发布决策。

**要求用户自行安装所有策展插件。** 对被选为 Plus 产品组成的能力不采用。封闭默认集合让新建和安装所有的 profile 使用同一份已测试组合，同时保留自定义 profile。

## Consequences

Plus 对每个默认策展插件承担明确的兼容性义务，并需要处理上游漂移报告。用户无需手工组装即可获得经过测试的市场和侧边栏；自定义 profile 组合保持不变；第三方本地改动始终保留回到上游的可见路径。
