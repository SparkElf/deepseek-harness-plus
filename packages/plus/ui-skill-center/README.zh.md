---
description: "侧边栏技能中心：按来源浏览已加载技能、切换模型调用、新建与删除技能。"
kind: "package-reference"
---

# @sparkelf/dsh-client-ui-skill-center

[English](README.md) | 中文

<a id="summary"></a>
## 概述

dsh Web 侧边栏的技能中心：按来源分组浏览已加载的技能、启用或停用模型调用、新建技能，并把技能删除到可恢复的回收站。

<a id="what-it-does"></a>
## 功能

- **侧边栏入口**「技能中心」打开一个面板，它通过官方 `sidebar.panellist` 槽位与键控的 `main` 页面槽位注册 —— 与「插件」面板用的是同一批槽位，因此行、标签与选中态由外壳负责。
- **技能列表**：按发现来源分组（系统内置 / 运行时 / `~/.agents/skills` / `~/.dsh/skills` / 项目 `.agents/skills` / 项目 `.dsh/skills` / 自定义目录），并有一个搜索框按名称、描述或何时使用过滤。
- **启用 / 停用**：改写技能 YAML 前置块里的 `disable-model-invocation`。该字段是就地编辑而非重新序列化，因此注释、键顺序与正文都原样保留。
- **新建**：在用户级或项目级根目录下写入一个标准的 `SKILL.md`。
- **删除**：把技能移入同级的 `.trash` 目录，可从中恢复。

<a id="table-of-contents"></a>
## 目录

- [功能](#what-it-does)
- [设计](#design)
- [安装](#install)
- [模型体验](#model-experience)
- [已知限制和延期工作](#known-limitations-and-deferred-work)

-----

<a id="design"></a>
## 设计

读取走官方的 `ctx.skills` 注册表，因此目录与其热更新属于 harness 本身，而不是第二套扫描器。注册表的摘要有意省略文件路径 —— 它们是调用无关元数据 —— 所以写操作在真正需要触碰文件时通过 `ctx.skills.get()` 解析路径。这些调用共享的目录由 `collect()` 缓存，因此该解析不是第二次全量扫描。

三个写操作在官方没有等价物；注册表是只读的。

每一个颜色、边框与标签字重都来自共享别名 token（`--dsw-alias-*`），侧边栏图标是 `@deepseek-ai/dsh-client-ui-primitives` 的 `IconSkillOutline16`，因此面板与其行与旁边的官方面板一致。

<a id="install"></a>
## 安装

host 半边挂载 `/api/dsh-skill-center` 路由族；client 半边注册侧边栏入口与页面。两者都通过 profile 组合挂载。

<a id="model-experience"></a>
## 模型体验

无，因为本包是一个 Web GUI 表面：它注册一个侧边栏入口与一个面板，不贡献任何工具、系统提示段或会话事件。

#### KV Cache effect

无；本包拥有的任何字符串都不会抵达模型请求，因此请求的可缓存前缀不受该面板任何行为的影响。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和延期工作

No runtime invariant companion is published. 本包不拥有任何持久化的包内状态：路由处理器读取技能注册表并写入技能文件，每一个可观察结果都由路由测试覆盖。

- **删除会拒绝符号链接的技能**：通过符号链接发现的技能没有唯一归属目录可移动，因此对它不提供删除操作。
- **列表省略文件路径**：因此某个技能能否删除，要等到删除被尝试时才知道，那时才会报告。
- **分组跟随发现来源标签，而不是文件路径**：报告了无法识别的来源的提供者会落到自定义分组。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers, click to expand</summary>

This Dev Note is working context for maintainers; shipped behavior, limits, and rationale live in the sections above.

- host 路由位于 `src`，面板位于 `src/client`。host 半边通过 `ctx.skills` 读取目录，只在某个写操作需要时才解析文件路径，因为注册表的摘要属于调用无关元数据，不携带路径。
- No runtime invariant companion is published because the package owns no durable package-local state; the route tests observe the reads and writes directly.

</details>