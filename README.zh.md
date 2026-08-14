# DeepSeek Harness Plus

[English](README.md) · [规划中的内容](PRESETS.md) · [参与贡献](CONTRIBUTING.md)

<p align="center">
  <strong>阻塞问题先修好，新功能先用上，让 Harness 更适配眼前的工作。</strong><br>
  <em>DeepSeek Harness Plus 是把有用的 Harness 增强更早交到你手里的社区层。</em>
</p>

<p align="center">
  <a href="#run"><img src="https://img.shields.io/badge/从源码运行-pnpm-111111?style=for-the-badge&logo=pnpm&logoColor=white" alt="从源码运行 DeepSeek Harness Plus"></a>
  <a href="#not-shipped-yet"><img src="https://img.shields.io/badge/查看下一步-首个版本-0b7285?style=for-the-badge" alt="查看首个版本工作"></a>
</p>

[![Upstream](https://img.shields.io/badge/upstream-deepseek--harness-0b7285)](https://github.com/deepseek-ai/deepseek-harness) [![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE) [![Discussions](https://img.shields.io/badge/community-Discussions-8250df)](https://github.com/SparkElf/deepseek-harness-plus/discussions)

<p align="center">
  <img src="assets/plus-overview.zh.png" alt="DeepSeek Harness Plus：更快修好阻塞问题、抢先体验新功能、使用社区扩展和主题预设" width="100%">
</p>

## Plus 能为你做什么

当 Harness 已经很好用，但官方发布节奏还没跟上你下一步的需要时，你会用到 Plus。可能是一个缺陷正在阻塞真实工作，可能是一个能力还在上游 RFC 讨论，也可能是团队需要一套贴合具体任务的环境，而不是再从空白配置开始。

### 阻塞问题更快修好

当 DeepSeek 尚未发布一个会阻碍你工作的修复时，Plus 可以先提供范围明确的修复。每项被支持的修复都会记录目的、与上游的关系、影响文件和验证证据，让你在依赖它之前就知道改了什么。

### 新功能抢先体验

当上游能力仍在 RFC 讨论阶段时，Plus 可以先把它做成可选的实验性功能。你能查看实现、用真实工作验证、确认有用后继续使用，也能移除它，而不会把早期想法误认为官方正式发布。

### 扩展和主题预设直接可用

Plus 是社区插件和面向用户扩展能力的交付位置，也会提供围绕具体任务的预设。预设是一套带版本的 Harness 插件和相关配置，选择后直接使用，不需要再手动逐项拼装。

规划中的预设主题包括智能问数、多用户运行时、代码开发、AIGC 和社区运营。这些是产品方向，不是现成下载：只有插件集合、相关配置、权限说明和验证说明同时交付后，才会称为可安装预设。

## 为什么可以相信这层增强

Plus 会持续跟进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。每一项受支持的社区差异都会记录 owner、范围、兼容性说明和验证路径，上游改动也保持可见。这样，你可以使用更快的修复和更早的功能，而不是把环境变成一堆来路不明的补丁。

<a id="run"></a>

## 从源码运行

<a id="run-from-source"></a>

### 三步跑起来

1. 克隆仓库并安装锁定版本的依赖。
2. 构建源码，启动本地 Web UI。
3. 打开页面，配置模型提供方，开始第一个会话。

你需要 Node.js 22.19+ 或 24+、Corepack 和 pnpm。

```sh
git clone https://github.com/SparkElf/deepseek-harness-plus.git
cd deepseek-harness-plus
corepack enable
pnpm install
pnpm run build
pnpm dsh web
```

浏览器打开 `http://127.0.0.1:3080` 即可。模型凭据保存在本地配置里，不要提交到 Git。

## 📦 现在可以用什么

- 可以直接运行完整的上游 Harness 源码和 Web UI。
- 可以通过维护中的 `upstream` remote 持续跟进上游。
- 可以使用 Plus 源码分支中的子智能体模型继承修复，以及对应的回归覆盖。
- 可以公开报告阻塞问题、提出实验性功能，或贡献扩展、预设、文档和部署改进。

<a id="not-shipped-yet"></a>

## 还在构建的能力

以下能力在 release 明确标记为可用前，请不要依赖：

| 能力 | 状态 |
| --- | --- |
| 更快的修复和提前的实验性功能 | 持续社区工作；每一项都必须先具备自己的验证证据 |
| 桌面安装引导和 tray 管理的本地 runtime | 源码已实现；macOS、Linux、Windows 安装包尚未发布 |
| 代码开发预设 | 暂未实现 |
| 智能问数预设 | 暂未实现 |
| 多用户运行时预设 | 暂未实现 |
| AIGC 预设 | 暂未实现 |
| 社区运营预设 | 暂未实现 |

预设发布规则见 [PRESETS.md](PRESETS.md)。当前没有可用的多用户或公网部署预设，请把本地 Harness runtime 保持在私有环境中。

## ❓ 常见问题

**这是 DeepSeek 官方项目吗？** 不是。这是一个持续跟进上游源码并遵循上游许可证的独立社区项目。

**为什么不等官方发布？** 当 Plus 的修复或实验性功能正好解决你的紧急需要时，你可以选择使用它。Plus 会让差异保持明确、经过审查并可验证，而不是把它藏成私有 patch。

**现在能安装预设吗？** 不能。只有插件和相关配置能一起安装、权限明确、结果有验证证据时，一个主题才会被称为预设。

**现在能下载桌面安装器吗？** 不能。安装引导和托盘管理器源码仍在开发，macOS、Linux 和 Windows 安装器尚未发布。

**能直接部署到公网给团队使用吗？** 不能。多用户运行时预设还未交付，当前应把 Harness runtime 放在私有环境中运行。

**同步上游会不会把本地改动弄丢？** 不应该。准备进入 Plus 的改动会记录目的、影响文件和验证方式，避免留下无法解释的补丁。

## 🤝 一起把它做得更好

一个问题已经浪费了你很多时间，就创建 Issue。团队总在重复同一套流程，就发起 Discussion。你已经有一个经过验证的改动，就提交 Pull Request。

欢迎提交缺陷修复、实验性功能、社区插件、预设、部署资产、文档和评审意见。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请通过 [SECURITY.md](SECURITY.md) 报告，不要公开提交 Issue。

## 🔄 跟上游保持同步

```sh
git fetch upstream
git merge upstream/master
```

你应该始终能看清 Plus 和上游之间有什么不同。每一项受支持的社区差异都会记录改了什么、为什么要改、影响哪些部分，以及如何验证。

## 许可证

DeepSeek Harness Plus 沿用上游 [MIT 许可证](LICENSE)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目为独立社区项目，不隶属于 DeepSeek，也未获得 DeepSeek 背书。
