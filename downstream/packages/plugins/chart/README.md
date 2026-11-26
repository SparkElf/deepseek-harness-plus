# @sparkelf/dsh-chart

## 中文

`@sparkelf/dsh-chart` 是 SparkElf 维护的 DeepSeek Harness 独立交互图表插件。它把一个完整 capability 的 Host 与 Web Client 放在同一个 owner package 中：Host 提供模型可调用的 `render_chart`，Client 将 durable tool result 里的完整 ECharts option 渲染为 Harness 消息流中的交互图表。

当前 `feat/chart` 是发布候选源码，尚未在本文中声明任何已发布 npm 版本或生产 pin。正式发布前应以仓库 CI、打包结果和真实 npm artifact 为准。

### 行为

`render_chart` 接收：

- `sourceResultRef`：恰好一个生成该图表的数据结果引用，仅作为 provenance。
- `option`：完整、JSON 可序列化的 ECharts option；必须包含历史 replay 所需的数据。
- `title`：可选的短图表标题。

Host将完整option写入durable tool result。直接调用使用presentation metadata；Code Mode nested调用在`tool/code-dispatch.content`中追加chart-owned block，因为该日志内容不会回流模型。Web Client经同一校验器读取两种投影。历史replay、resume和fork因而不依赖仍然存活的DataOps resultRef；`sourceResultRef`只记录来源。

Web Client 为 `render_chart` 注册 keyed tool view，并负责 ECharts 初始化、`setOption`、容器 resize、Harness light/dark theme 切换和 disposal。正常结果只显示标题与交互图表，不显示 option JSON、resultRef、包名或 Host/Client 实现说明。加载、不可用和失败状态只显示必要的用户状态；底层渲染异常不会直接泄露到普通 UI。

### 数据准备边界

插件不实现固定的图表 query planner、自动采样或 AST policing。上游数据查询负责业务粒度；需要时可在调用 `render_chart` 前通过 Code Mode 做面向可视化的 map/filter/sort/reduce、reshape、派生统计或 annotation。最终传给 `render_chart` 的 option 必须自包含。

### 组合与分发

- Cordis plugin boundary：`@sparkelf/dsh-chart`
- npm publication：计划发布为 SparkElf package
- source owner：`SparkElf/dsh-plugins-plus`
- default composition：opt-in，不默认挂载
- 依赖边界：只使用已发布的上游 DeepSeek Harness 扩展点，不 import `deepseek-harness-plus` 私有源码

包通过 `dsh.bundle` 声明 Host composition，通过 `dsh.client` 声明 Web Client entry。安装、升级、禁用和卸载应以一个 capability 为单位完成。

### 验证

仓库测试覆盖：

- Host tool canonical result 与 durable presentation metadata
- 空 provenance 拒绝
- Host real Loader composition
- Client keyed view 注册与 lifecycle disposal
- Client real Loader composition
- history metadata replay 到 ECharts
- theme change 时 dispose + re-init
- ECharts 失败时仅显示用户可理解的失败状态
- 缺失 metadata 时 fail-soft

发布前必须通过仓库 `typecheck`、Vitest 和 publishable build。lockfile 必须由 pnpm 生成，不手工维护派生内容。

## English

`@sparkelf/dsh-chart` is an independent interactive-chart plugin for DeepSeek Harness maintained by SparkElf. One owner package contains the complete capability: the Host entry exposes the model-facing `render_chart` tool, while the Web Client renders the complete ECharts option stored on the durable tool result as an interactive chart in the Harness conversation.

The current `feat/chart` branch is release-candidate source. This document does not claim that an npm version or production pin already exists; release status must be established by repository CI, packaged artifacts, and an actual npm publication.

### Behavior

`render_chart` accepts:

- `sourceResultRef`: exactly one result reference used to prepare the chart, retained only as provenance.
- `option`: a complete JSON-serializable ECharts option containing the data required for history replay.
- `title`: an optional short chart title.

The Host stores the complete option in the durable tool result. A direct call uses presentation metadata; a nested Code Mode call appends a chart-owned block to `tool/code-dispatch.content`, whose log-only content never re-enters model context. The Web Client validates both projections through the same parser. History replay, resume, and fork therefore do not depend on a still-live DataOps resultRef; `sourceResultRef` records provenance only.

The Web Client registers a keyed tool view for `render_chart` and owns ECharts initialization, `setOption`, container resize, Harness light/dark theme changes, and disposal. The normal completed result shows the title and interactive chart rather than option JSON, resultRef, package names, or Host/Client implementation explanations. Loading, unavailable, and failure states expose only necessary user-facing state, and raw renderer exceptions are not surfaced in the normal UI.

### Data preparation boundary

The plugin does not implement a fixed chart query planner, automatic sampling, or AST policing. Upstream data queries own business granularity. When needed, Code Mode may perform visualization-oriented map/filter/sort/reduce, reshape, derived statistics, or annotations before `render_chart` is called. The final option passed to `render_chart` must be self-contained.

### Composition and distribution

- Cordis plugin boundary: `@sparkelf/dsh-chart`
- npm publication: intended as a SparkElf package
- source owner: `SparkElf/dsh-plugins-plus`
- default composition: opt-in, not mounted by default
- dependency boundary: published upstream DeepSeek Harness extension points only; no imports from private `deepseek-harness-plus` source

The package declares Host composition through `dsh.bundle` and its Web Client entry through `dsh.client`. Install, upgrade, disable, and uninstall should operate on the capability as one unit.

### Verification

Repository tests cover:

- Host canonical result and durable presentation metadata
- rejection of blank provenance
- real Host Loader composition
- keyed Client view registration and lifecycle disposal
- real Client Loader composition
- replay of history metadata through ECharts
- dispose + re-init on Harness theme changes
- user-facing failure state without exposing an ECharts exception
- fail-soft behavior for missing metadata

Before release, repository typecheck, Vitest, and publishable build must pass. The lockfile must be generated by pnpm rather than edited as derived text.
