# DeepSeek Harness Plus

[English](README.md) | [预设章程](PRESETS.md) | [参与贡献](CONTRIBUTING.md)

> 面向需要更快同步上游版本、修复运行问题并稳定部署的团队的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 独立社区维护发行版。

[![Upstream](https://img.shields.io/badge/upstream-deepseek--harness-0b7285)](https://github.com/deepseek-ai/deepseek-harness) [![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE) [![Discussions](https://img.shields.io/badge/community-Discussions-8250df)](https://github.com/SparkElf/deepseek-harness-plus/discussions)

DeepSeek Harness Plus 保持与上游插件架构同步，并为运行问题修复、精选预设和部署资产提供社区发布路径。本项目为独立社区项目，不隶属于 DeepSeek，也未获得 DeepSeek 背书。

## 运行

### 从源码运行

需要 Node.js 22.19+ 或 24+、Corepack 和 pnpm。

```sh
git clone https://github.com/SparkElf/deepseek-harness-plus.git
cd deepseek-harness-plus
corepack enable
pnpm install
pnpm run build
pnpm dsh web
```

本地 Web UI 默认运行在 `http://127.0.0.1:3080`。开始会话前请在 UI 中配置模型提供方；不要提交提供方凭据或工作区密钥。

## 为什么选择 Plus

- **感知上游的维护路径**：保留 `upstream` remote，审核每次同步，并在运行问题阻塞用户时发布聚焦修复。
- **社区共同维护**：通过 Issues、Discussions 和 Pull Request 接受缺陷报告、文档、预设、部署资产和代码贡献。
- **可运行预设发布**：每个预设发布都包含版本化配置、安装路径、能力边界和验证说明。
- **面向部署的方向**：支持共享 UI 与认证网关，把已认证用户路由到隔离的 Harness runtime，而不是向公网暴露本地 Harness API。

## 社区预设章程

预设目录见 [PRESETS.md](PRESETS.md)。每条发布线只有在提供版本化配置和明确运行模型后才会作为可安装预设发布。

| 预设方向 | 面向结果 |
| --- | --- |
| 代码交付 | 面向仓库的开发、审查、验证和发布流程。 |
| 社区运营 | Issue 分诊、讨论管理、发布说明和贡献者协作。 |
| 多用户运行时 | 共享 UI 和网关，将每位已认证用户路由到隔离的 Harness runtime。 |
| 智能问数 | 在获准数据源、语义指标、查询审查和审计记录之上完成受控分析。 |

## 参与贡献

产品方向请发起 Discussion，可复现问题请创建 Issue，聚焦改动可提交 Pull Request。项目用类型和领域标签组织工作，方便贡献者找到维护入口。提交前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 同步上游

```sh
git fetch upstream
git merge upstream/master
```

每次同步都会在发布前审核。社区补丁保持小而明确，并有独立文档和测试，便于后续延续或移除。

## 安全

Harness runtime 应运行在私有基础设施中。生产多用户部署必须在网关完成认证，禁止把 runtime 直接暴露到公网，并将模型与数据凭据限制在目标用户或工作区内。漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 许可证

本仓库沿用上游 [MIT 许可证](LICENSE)。第三方依赖许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
