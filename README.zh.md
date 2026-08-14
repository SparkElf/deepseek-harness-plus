# DeepSeek Harness Plus

[English](README.md) · [规划中的内容](PRESETS.md) · [参与贡献](CONTRIBUTING.md)

<p align="center">
  <strong>DeepSeek Harness 的社区增强版。</strong><br>
  <em>修好关键问题，尝鲜下一步，让 agent 持续交付。</em>
</p>

<p align="center">
  <a href="#run"><img src="https://img.shields.io/badge/从源码运行-pnpm-111111?style=for-the-badge&logo=pnpm&logoColor=white" alt="从源码运行 DeepSeek Harness Plus"></a>
  <a href="#not-shipped-yet"><img src="https://img.shields.io/badge/查看下一步-首个版本-0b7285?style=for-the-badge" alt="查看首个版本工作"></a>
</p>

[![Upstream](https://img.shields.io/badge/upstream-deepseek--harness-0b7285)](https://github.com/deepseek-ai/deepseek-harness) [![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE) [![Discussions](https://img.shields.io/badge/community-Discussions-8250df)](https://github.com/SparkElf/deepseek-harness-plus/discussions)

<p align="center">
  <img src="docs/user/guide/providers-models-page.png" alt="DeepSeek Harness 模型提供方设置" width="960">
</p>

当 DeepSeek Harness 已经接近你团队需要的工具，Plus 就是补齐最后一段路的地方。它是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立社区 fork，面向需要在上游发布前修一个问题、试一个 RFC，或把一套工作流沉淀为可重复配置的开发者。

它保留上游插件架构，同时给社区一个公开的地方审查日常真正重要的变化：可追溯的修复、可明确启用的实验，以及能在团队环境中放心使用的插件编排。

<a id="run"></a>

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

打开 `http://127.0.0.1:3080`，选择模型提供方后即可开始会话。凭据应保存在本地配置中，不能提交到 Git。

## Plus 为什么存在

| 当你需要... | Plus 希望提供... |
| --- | --- |
| 一个可以真正部署的缺陷修复 | 带范围、验证证据和上游关系记录的聚焦补丁。 |
| 提前试用一个值得关注的上游想法 | 边界清楚的 RFC 实现，可以讨论、测试，并决定延续或移除。 |
| 能在团队里共享的插件组合 | 围绕路由、工具、设置、权限和 UI 贡献维护的编排。 |
| 不止存在于聊天记录里的团队配置 | 带安装、凭据、权限和验证说明的版本化预设。 |

## 今天可以使用的内容

- 完整上游 Harness 源码和从源码启动 Web UI 的流程。
- 一个公开的上游同步 fork，并保留 `upstream` remote。
- Issues、Discussions、Pull Request、安全报告和社区审查入口。
- 用于承接审查后补丁、社区插件、预设提案和部署工作的仓库。

<a id="not-shipped-yet"></a>

## 暂未发布

下列内容正在公开开发，不包含在当前 checkout 或安装器中。

| 规划工作 | 状态 |
| --- | --- |
| 子智能体跟随 UI 当前模型选择 | 开发中 |
| 桌面安装引导和托盘守护进程 | 开发中 |
| 代码交付预设 | 暂未实现 |
| 社区运营预设 | 暂未实现 |
| 多用户运行时预设 | 暂未实现 |
| 智能问数预设 | 暂未实现 |

完整范围和发布条件见 [PRESETS.md](PRESETS.md)。一个预设只有具备可运行配置、明确权限、安装路径和验证证据后，才会被标记为可用。

## 一起建设

遇到真正阻塞工作的失败，请创建 Issue。有团队每周都在重复的工作流，请发起 Discussion。有经过验证的聚焦改动，请提交 Pull Request。

我们欢迎缺陷修复、提前实现的 RFC、社区插件、预设、部署资产、文档和审查。请从 [CONTRIBUTING.md](CONTRIBUTING.md) 开始。安全问题请通过 [SECURITY.md](SECURITY.md) 报告，不要公开提交 Issue。

## 紧跟上游

```sh
git fetch upstream
git merge upstream/master
```

Plus 只有在补丁保持可理解时才有价值。每一项受支持的差异都记录改了什么、为什么存在、影响哪些部分，以及如何验证。

## 许可证

DeepSeek Harness Plus 沿用上游 [MIT 许可证](LICENSE)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目为独立社区项目，不隶属于 DeepSeek，也未获得 DeepSeek 背书。
