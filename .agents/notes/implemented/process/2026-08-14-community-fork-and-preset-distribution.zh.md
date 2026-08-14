# Agent Note: Community Fork and Preset Distribution

Status: implemented

[English](2026-08-14-community-fork-and-preset-distribution.md) | 中文

## Problem

团队需要一个感知 DeepSeek Harness 上游变化、能够接受社区维护工作，并为可运行预设和部署资产提供明确路径的发行版。

## Decision

DeepSeek Harness Plus 是 `deepseek-ai/deepseek-harness` 的公开 GitHub fork。仓库将 `origin` 指向社区 fork，将 `upstream` 指向原始仓库。社区改动以聚焦补丁形式审查，并记录其运行影响。

根 README 将项目定义为独立于 DeepSeek 的项目，保留上游 MIT 许可证，并发布从源码启动的说明。预设章程定义代码交付、社区运营、多用户运行时和智能问数四条发布线。预设发布时必须同时包含配置、权限、凭据、安装路径和验证说明。

GitHub Discussions、Issues、Pull Request、社区行为准则、安全报告入口，以及 `kind/*` 和 `area/*` 标签构成公开贡献路径。

## Alternatives considered

**仅维护个人补丁分支。** 私有或无组织的分支无法为运营者提供可发现的贡献路径、预设目录和公开发布点。

**在没有可运行配置时宣称预设能力。** 把未经验证的部署或数据能力描述为可用，会误导运营者并削弱发布可信度。

**让浏览器直接访问每个 Harness runtime。** 直接暴露 runtime 会绕过网关对认证的所有权，并把本地特权 API 带入不安全的部署模型。

## Consequences

项目需要承担上游同步工作，并在导入每项变更时审查社区补丁。贡献者获得了提交运行修复和预设提案的明确路径。智能问数和多用户部署发布必须保留明确的权限、认证和审计要求。
