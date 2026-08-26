# Agent Note: 插件所有权与分发是相互独立的决策

Status: implemented

[English](2026-08-20-plugin-ownership-and-distribution.md) | 中文

## Problem

Harness 把每项产品能力都实现为插件，但这一事实并不决定其包是否发布到 npm、由哪个仓库拥有，或交付的 profile 是否默认挂载。把这些问题合并为一个决策，会让外部能力被拆到其源码包和宿主专用 UI 包装层两个所有者之间；把尚未发布的一方包视作非插件代码，则混淆了分发与组装。

## Decision

每次能力评审都独立决定四个维度：Cordis 插件生命周期、npm 发布、源码仓库所有权和默认 profile 组装。仓库工作流由 [`dsh-plugin-ownership-and-distribution`](../../../skills/dsh-plugin-ownership-and-distribution/SKILL.md) 编码，常设工作风格规则要求在实现前执行该评审。

一项能力只有一个所有者。该所有者承载能力专属的 Host 与 Client 入口、设置 UI、配置、路由、迁移、安装与移除行为、发布兼容性和用户文档。外部插件使用 Harness 已发布的扩展点，通过 `dsh.bundle` 声明 Host 组装，通过 `dsh.client` 声明浏览器端，并随其插件生命周期移除全部贡献。Harness 不增加只为外部能力注册 UI 的一方包。

集成需求本身不授权修改 Harness core。当已发布扩展点无法满足当前集成时，implementation 必须在编辑 core source 前停止。提案必须汇报具体扩展点缺口、拟修改的 core package 和 public API、plugin 或 profile 不能拥有该行为的原因、独立于本集成的通用消费者、原生模式与默认 profile 影响、替代方案，以及原生和集成模式的验证。只有用户显式批准所汇报的范围后才能开始 core 工作；对一个缺口的批准不授权相邻 core 改动。集成身份、endpoint、credential、产品 UI 和部署配置不得进入通用 core contract。

已声明的部署信任与管理控制是设计输入，不是等待应用代码补偿的缺陷。显式可信内网可以使用HTTP；外部ingress使用显式配置的HTTPS且不做fallback。没有产品或协议要求时，集成不得以通用安全为名增加短期token轮换、refresh机制、应用层加密、锁、队列或周期性remount。网络策略、账号与session生命周期、权限执行和运维撤销拥有这些控制，同时继续执行协议明确要求的身份与授权校验。

安全生命周期选择以完整用户路径为目标：一次可理解的授权应持续可用，直到用户或管理员改变其所属session、账号、权限或连接。没有明确威胁或协议要求时，即使某个机制通常被描述为加固，只要它增加重复授权、后台抖动、工具中断或恢复状态，就应否决。

仓库所有权服从变化所有权，而不是包的可见性。定义 Harness 基线扩展点、消费私有持久化格式或必须与内部包锁步变化的能力留在一方仓库。具有独立维护者或发布节奏、自有部署服务或协议、自有凭据或信任边界、有意义的安装选择，或服务于不止一个 Harness 发行版的能力归外部仓库。npm 产物可以继续以 Harness monorepo 为源码归属；外部产物也可以被 Plus 默认 profile 选中，而不改变任一所有者。

设置备份客户端继续作为一方包，因为其归档行为随 Harness 设置和存储数据演进；它以 `@sparkelf/dsh-client-ui-settings-backup` 加入 DSH 包家族发布，源码继续归 `deepseek-harness-plus`，并由 Web bundle 默认挂载。所有者选择的 npm scope 不转移仓库所有权。移动桥接归 `dsh-plugins-plus`：其 Host 隧道、Client 设置区、移动端呈现、中继协议、配置和文档均由 `@sparkelf/dsh-mobile-bridge` 交付。Plus Web profile 钉扎并默认挂载该外部包，因为所有者把移动访问选为此发行版的一部分；更高层 profile patch 可以禁用它，上游 Harness 不因此取得其源码或发布责任。

## Alternatives considered

**要求每个插件都存放在外部 npm 仓库。** 拒绝：对于已经通过 Cordis 组装且必须随一方私有格式演进的包，拆仓只增加发布协调，不能提高可替换性。

**外部 Host 代码留在 Harness 之外，但增加一方 UI adapter。** 拒绝：卸载与兼容跨越两个所有者，而 adapter 除了把外部能力转发到公开 Slot 外不承担协议或生命周期责任。

**把默认 profile 中的每个包都视为一方能力。** 拒绝：默认组装是发行选择，不会转移源码、安全、发布或兼容性所有权。

**只把规则存入 Agent 记忆或根说明。** 拒绝：记忆不受版本控制，完整决策流程也不属于根常设规则的篇幅。Agent Note 负责理由，Skill 负责执行，工作风格规则负责触发。

## Consequences

- 插件提案在实现前给出四个显式答案，npm 发布和默认纳入不能再隐式决定所有权。
- 外部能力保持完整的安装与移除单元；宿主专用包装包不是可接受的集成路径。
- 由集成触发的 core 提案是需要单独批准的通用能力变更，而不是 plugin PR 的实现细节。
- 一方包无需迁仓即可使用所有者选择的 npm scope 发布，在确需锁步开发时保留同仓协作。发布工具把任何非默认 scope 记录为精确的一方包；缺少该 scope 的凭据会阻塞发布，而不会授权改用其他 scope 或版本合同。
- Plus 可以策展或默认挂载外部包，同时由外部项目继续承担发布与安全责任。
- [外部插件维护方案](../process/2026-08-19-external-plugin-maintenance.md)继续负责策展钉扎、漂移、本地补丁和独立插件仓库；本决策负责更早的归属分类。
