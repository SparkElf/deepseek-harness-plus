# Agent Note: Plus Governance and Diff Protocol

Status: implemented

[English](2026-08-14-plus-governance-and-diff-protocol.md) | 中文

## Problem

一个由社区维护的 Harness 发行版需要明确的贡献流程：AI 提交必须能够审查；上游运行时改动必须与社区层改动分开；插件之间不能因为隐式覆盖而互相冲突。

## Decision

Plus 将六个软件工程 skill 放在 `.agents/skills/` 中，在 Pull Request 模板里要求对应证据，并由 `Plus governance` workflow 检查这些段落。`.github/CODEOWNERS` 指定人工委员会 owner；AI 证据不会获得合并权限。

`diffs/core/registry.yaml` 负责记录上游 Harness 和核心插件的差异。`diffs/community/registry.yaml` 负责记录社区插件、预设、安装器、部署和治理改动。每条记录都标明功能、仓库、基线、文件、兼容性、owner 和验证方式。`presets/compositions/registry.yaml` 负责记录生效的工具、路由、设置命名空间、UI slot 和持久化 owner 声明。`verify-plus-governance` 会拒绝格式错误的记录和重复的生效编排声明。

## Alternatives considered

**把补丁说明只写在 Pull Request 里。** Pull Request 文本无法在上游合并、发布分支和后续维护中持续作为结构化事实来源。

**把所有改动放到一份注册表。** 单一列表会掩盖一个改动究竟是核心运行时差异，还是社区层的插件与部署改动。

**让插件加载顺序隐式解决冲突。** 依赖顺序覆盖会让编排问题难以发现，也无法通过稳定声明进行审查。

## Consequences

贡献者必须在同一个 Pull Request 中更新相应的 diff 注册表。新预设在宣称可用前必须声明其编排。审查者能获得插件所有权和冲突风险的具体清单，而人工委员会仍然拥有最终合并权。
