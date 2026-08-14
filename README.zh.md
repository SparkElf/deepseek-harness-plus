# DeepSeek Harness Plus

[English](README.md) · [规划中的内容](PRESETS.md) · [参与贡献](CONTRIBUTING.md)

<p align="center">
  <strong>你不该为了修好最后一个阻塞 agent 的问题，苦等别人处理。</strong><br>
  <em>修掉关键问题，尝鲜下一步，让你的工作持续向前。</em>
</p>

<p align="center">
  <a href="#run"><img src="https://img.shields.io/badge/从源码运行-pnpm-111111?style=for-the-badge&logo=pnpm&logoColor=white" alt="从源码运行 DeepSeek Harness Plus"></a>
  <a href="#not-shipped-yet"><img src="https://img.shields.io/badge/查看下一步-首个版本-0b7285?style=for-the-badge" alt="查看首个版本工作"></a>
</p>

[![Upstream](https://img.shields.io/badge/upstream-deepseek--harness-0b7285)](https://github.com/deepseek-ai/deepseek-harness) [![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE) [![Discussions](https://img.shields.io/badge/community-Discussions-8250df)](https://github.com/SparkElf/deepseek-harness-plus/discussions)

<p align="center">
  <img src="assets/plus-overview.png" alt="DeepSeek Harness Plus 介绍板：修复阻塞问题、提前试用 RFC、共享维护好的插件编排" width="100%">
</p>

你已经用 DeepSeek Harness 做成了一些有用的事。然后你碰到一个会打断流程的问题，想在 RFC 落地前先试试它，或是发现一组插件还不能放心交给团队使用。DeepSeek Harness Plus 给你一个公开解决这些问题的地方。

你保留上游的插件架构。你得到的是可以审查的聚焦修复、可以明确启用的实验，以及一条逐步长成的预设路径，让团队不必从聊天碎片中重新拼装配置。Plus 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立社区 fork。

<a id="run"></a>

## 🚀 快速入门

<a id="run-from-source"></a>

### 三步运行

1. 克隆仓库并安装锁定的依赖。
2. 构建源码并启动本地 Web UI。
3. 打开 UI，选择模型提供方，然后开始会话。

你需要 Node.js 22.19+ 或 24+、Corepack 和 pnpm。

```sh
git clone https://github.com/SparkElf/deepseek-harness-plus.git
cd deepseek-harness-plus
corepack enable
pnpm install
pnpm run build
pnpm dsh web
```

打开 `http://127.0.0.1:3080`。凭据保存在本地配置中，不能提交到 Git。

## 💡 当你需要这些事时

| 你正在尝试... | 你需要... |
| --- | --- |
| 跨过一个阻塞真实工作的缺陷 | 一个范围明确、带验证证据并说明上游关系的小补丁。 |
| 试用一个上游想法，但不想押上整套环境 | 一个边界清楚的实现，你可以检查、测试、保留或移除。 |
| 给团队共享一组插件 | 围绕路由、工具、设置、权限和 UI 贡献维护好的编排。 |
| 不再从旧聊天记录里重建同一套配置 | 带安装、凭据、权限和验证说明的版本化预设。 |

## 📦 你今天可以使用的内容

- 你可以从本仓库运行完整的上游 Harness 源码和 Web UI。
- 你可以通过维护中的 `upstream` remote 跟进上游。
- 你可以创建 Issue、发起 Discussion、提交 Pull Request，并私下报告安全问题。
- 你可以在这个专门用于审查补丁、社区插件、预设和部署工作的仓库中提出改进。

<a id="not-shipped-yet"></a>

## 🧭 暂未发布

请不要安装或依赖下列内容。它们是你可以关注并参与塑造的开发工作：

| 规划工作 | 状态 |
| --- | --- |
| 子智能体跟随你在 UI 中选择的模型 | 开发中 |
| 桌面安装引导和托盘守护进程 | 开发中 |
| 代码交付预设 | 暂未实现 |
| 社区运营预设 | 暂未实现 |
| 多用户运行时预设 | 暂未实现 |
| 智能问数预设 | 暂未实现 |

你可以在 [PRESETS.md](PRESETS.md) 阅读发布条件。一个预设只有在你能运行它、理解它的权限、安装它并验证结果后，才会被标记为可用。

## ❓ 快速问答

**这是 DeepSeek 的官方项目吗？** 不是。你使用的是一个遵循上游源码和许可证的独立社区 fork。

**你今天能用它吗？** 可以，从源码运行。桌面安装器仍在开发，所以暂时没有可下载的安装包。

**你今天能安装预设吗？** 不能。代码交付、社区运营、多用户运行时和智能问数都明确标注为暂未实现。

**你能把它直接暴露到公网给团队使用吗？** 不能。多用户部署预设尚未提供，你应保持本地 Harness runtime 私有。

**同步上游时，你的本地变更会不会莫名消失？** 不应该。受支持的变更在进入 Plus 前都会记录目的、影响文件和验证路径。

## 🤝 让它真正有用

碰到一个浪费你时间的失败，请创建 Issue。团队每周都在重复一套工作流，请发起 Discussion。有经过验证的聚焦改动，请提交 Pull Request。

你可以贡献缺陷修复、提前实现的 RFC、社区插件、预设、部署资产、文档和审查。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请通过 [SECURITY.md](SECURITY.md) 报告，不要公开提交 Issue。

## 🔄 紧跟上游

```sh
git fetch upstream
git merge upstream/master
```

你应该始终能看清这个 fork 为什么与上游不同。每一项受支持的差异都记录改了什么、为什么存在、影响哪些部分，以及你如何验证它。

## 许可证

你可以在上游 [MIT 许可证](LICENSE) 下使用 DeepSeek Harness Plus。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目为独立社区项目，不隶属于 DeepSeek，也未获得 DeepSeek 背书。
