# Agent Note：Plus 是唯一的 patch 层，安装器负责选择版本

Status: implemented

[English](2026-10-30-plus-patchset-and-component-ownership.md) | 中文

## Problem

Plus 发行层把每个已接受的差异都做成单独发布的 `@sparkelf/dsh-patch-*` 包，再把这些包列进 `dshPlus.patchPackages`。这让发行层变成了 patch 的清单，而不是 patch 本身：清单与磁盘上的 payload 漂移，一次 base 线升级要移动几十个独立版本，解析不到清单的消费端则退回去用部署脚本改已安装的 `lib/`。于是 Plus 声称交付的行为，实际由部署脚本拥有。

能力内部也出现了同样的模糊：某个具体产品规则被写进官方包补丁（`activePanelId === "knowledge-base"`），而某个通用能力却留在一个插件的私有代码里。两边都无法独立退役或复用。

## Decision

`@sparkelf/dsh-plus` 就是官方 DSH 的 patch set，也是产品里唯一的 patch 层。payload 放在发行包内部，manifest 用一份 `dshPlus.patchSet` 承载有序的 `entries[]`，一个 Plus 版本命名整条增量。每个 entry 带 `id`、`target`（`dsh-source` 或 `npm`）、`file`、`retireWhen`；退役按 entry 记，发行与兼容随 Plus 走。

registry 安装是同一条 patch 的 materialize，不是第二个产品：`dsh-plus apply` 把内嵌 patch set 应用到精确的官方 checkout，发布流水线把打好补丁的官方 workspace 重新发布成 `@sparkelf/*` 包，由 profile 的 `overrides` 选中。republished 包是 patch 的构建产物，不是组件层。

组件归属只有三层：

- **DSH Plus** 拥有底座能力的增强：扩展点（slot、面板元数据、服务 API）、配置 schema、通用布局行为，以及官方包的通用修复。它是唯一对官方 DSH 携带 patch 的层。
- **第三方插件或 fork** 按上游发布使用；需要改这个插件时，用我们的 fork。fork 是该发布者边界内的一个独立插件包，记录 `upstreamUrl` 与 `retireWhen`，绝不构成 patch 层。如果改动增加的是底座能力，它属于 Plus，fork 只承载插件自己的行为。
- **自研插件** 拥有自己的具体功能、UI、设置、路由，以及对 Plus 能力的使用。它不 patch 官方包。

决定性问题不是“谁改了文件”，而是“这个改动是增加底座能力，还是实现某个插件对该能力的使用”。插件专属规则写进官方包，即使能跑也是边界违规；通用能力藏在单个插件里，是反方向的同一种违规。第三方改动无法表达成插件时，做成 fork；属于底座的改动，做成 Plus entry。不存在第三条通道。

`dsh-plus install --edition personal|team` 是安装入口。两个版本是不同的清单，安装不同的插件集合：personal 带个人工作流，team 带团队部署需要的共享插件与默认值。版本选择 bundles 与 packages，不改变 patch set——所有版本共享同一条 patch set。DataOps 容器按 team edition 安装。

CLI 直接写 profile 的 `package.json`。不再生成单独的 standalone 发行包：standalone 只是同一份清单的预生成副本，会和 CLI 产生分歧，而且每次改动都要重新生成。profile manifest 就是安装产物。

## 当前应用

- **allow 审批。** `dsh-user-approval` 接受该策略，`dsh-permission-presets` 在 preset schema 里接受它，base bundle 能把 full access 映射到它。为某个部署选择 `danger-full-access: approval: allow` 是 profile 策略（DataOps），不是 Plus 默认。
- **image hoist 回放。** `compaction-image-offload` 宽容地重放依赖投影的位置，`session-query` 用挂载的 projection 重放；两者都是对任意插件 projection 的通用支持。`@sparkelf/dsh-image-hoist` 写入 `image/hoist` 行，继续作为自研插件。
- **中转站兼容。** `llm-pi-ai` 的 route option 和 Models 复选框是 adapter 能力。为某条具体 gateway route 打开它是用户或部署配置。
- **工作流广场。** `ui-schedule` 声明 `schedule.manager.tabs` 子 slot，并在有插件贡献时渲染 tab；广场内容与工作流属于 `knowledge-base`，当前实现就在那里。
- **知识库右栏。** `ui-sidebar-right` 和 `ui-layout` 提供通用的“panel 可以请求右栏和 reader 布局”能力；`knowledge-base` 声明该需求，并拥有 reader 联动。

## Alternatives considered

**保留每个差异一个独立发布的 patch 包。** 否决：发行层变成一个带版本的包清单；清单与 payload 漂移（28 个条目对应磁盘上 1 个 payload），一次 base 升级移动几十个无关版本，解析不到名字的消费端退回去做部署期 `lib/` patch。

**把差异作为普通 fork commit 携带，并从 fork 构建所有官方包。** 否决：fork 变成第二个 source base；官方对某行为的拥有关系再也无法与我们的区分，退役的差异会留在 fork 里且没有退役记录。

**给每个第三方 fork 保留独立的 patch 层。** 否决：这会在插件边界重现第一个问题：每个 fork 长出各自的 patch 清单，base 升级移动无关版本，消费端要解析多条 patch 通道。fork 就是一个插件包，底座改动就是一条 Plus entry。

**把整条增量放进一个 monolithic diff 文件。** 否决：一个 hunk 无法单独退役或评审。带 per-entry id 和 `retireWhen` 的 patch set 在保持单一发行生命周期的同时，不丢失按行为退役的能力。

**让插件在自己需要底座 hook 时直接 patch 官方包。** 否决：这会让插件拥有一个底座包，两个需要同一 hook 的插件会重复实现或冲突。hook 属于 Plus，插件消费它。

## Consequences

- 只有一条 patch 层。每条官方增量都是 Plus entry，没有部署脚本或插件拥有对官方 DSH 的 patch。
- 一个 Plus 版本、一个兼容范围、一个 lock 描述整条增量；消费端不再解析 patch 包。
- 一次 base 升级是 rebase 一条 patch set，而不是协调发布几十个 patch 包。
- 第三方改动要么是 fork（一个插件包），要么是 Plus 底座能力；不存在第三条要维护的 patch 通道。
- 即使发行共享，仍可通过 `retireWhen` 按 entry 退役行为。
- 每个 `dsh-source` entry 必须命名一个 profile 会 republish 并 override 的 workspace；未 republish 的 target 是治理失败，而不是部署脚本该解决的问题。
- 安装器 CLI 是物化某个版本插件集合的受支持入口；personal 与 team 只在清单上不同，patch set 相同。
- 不再发布 standalone 包。CLI 写出的 profile manifest 就是安装产物，容器按 team edition 安装。
- 插件评审必须在实现前回答能力归属问题，具体规则不能悄悄落进底座补丁。
- 本 note 取代 [Capability-equivalent Plus npm distribution](2026-08-29-ranged-plus-patchset-distribution.zh.md) 中的独立 patch 包交付方式；该 note 的四种交付形态和官方拥有规则继续有效，其中对独立 patch 包的引用由本 note 取代。