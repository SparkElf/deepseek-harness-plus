# DeepSeek Harness Plus

[English](README.md) · [规划中的内容](PRESETS.md) · [参与贡献](CONTRIBUTING.md) · [English below](#english)

<p align="center">
  <a href="#run"><img src="https://img.shields.io/badge/从源码运行-pnpm-111111?style=for-the-badge&logo=pnpm&logoColor=white" alt="从源码运行 DeepSeek Harness Plus"></a>
  <a href="https://github.com/SparkElf/deepseek-harness-plus/releases/tag/plus-v0.5.0"><img src="https://img.shields.io/badge/当前版本-0.5.0-0b7285?style=for-the-badge" alt="下载 DeepSeek Harness Plus 0.5.0"></a>
</p>

[![Upstream](https://img.shields.io/badge/upstream-deepseek--harness-0b7285)](https://github.com/deepseek-ai/deepseek-harness) [![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE) [![Discussions](https://img.shields.io/badge/community-Discussions-8250df)](https://github.com/SparkElf/deepseek-harness-plus/discussions)

<p align="center">
  <img src="assets/plus-hero.png" alt="DeepSeek Harness Plus 海报：修好阻塞问题、探索新能力、组合主题工具" width="100%">
</p>

## ✨ Plus 能为你做什么

### 🚑 阻塞问题更快修好

会话、模型或工具出了关键问题，不该让你的工作停在原地。DeepSeek 还没发布修复时，Plus 会先带来范围明确的修复，让你清楚知道改了什么、如何验证。

### 🧪 新功能抢先体验

好点子不用等到过时才试。上游能力还在 RFC 讨论时，Plus 会把它做成可选的实验性功能，先放进你的真实工作流。好用就留下，不适合就不采用。

### 🧩 扩展、插件与主题预设直接可用

Plus 是社区插件和面向用户扩展能力的集合地：桌面托盘管理本地 runtime、安装向导、用户数据备份恢复、开机自启动，以及 [dsh-plugins-plus](https://github.com/SparkElf/dsh-plugins-plus) 自有插件和策展的第三方插件。预设是一套带版本的 Harness 插件和相关配置，可以按版本选择，不需要再手动一项项拼。

## 🛡️ 为什么可以放心用 Plus

Plus 会持续跟进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，让你知道一个增强从哪里来、会怎样影响你的工作、有没有被认真检查过。当前产品基线是 [`dsh-v0.1.0-rc.8`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8)。你可以用上额外能力，也不用把 Harness 环境变成一堆来路不明的补丁。

<a id="run"></a>

<a id="run-from-source"></a>

## 🚀 从源码运行

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

<a id="not-shipped-yet"></a>

## 🛠️ 可用状态与路线图

可安装内容会链接到 release；仅源码可用的改动会明确标注：

| 能力 | 状态 |
| --- | --- |
| 桌面安装引导与 tray 管理的本地 runtime（含无控制台启动、备份恢复、开机自启、端口接管） | Linux/Windows 0.5.0 安装包已在 [Releases](https://github.com/SparkElf/deepseek-harness-plus/releases/tag/plus-v0.5.0) 发布；macOS 延后到配置好签名和 notarization 后再恢复 |
| 外部插件维护（策展清单、漂移检查、并行补丁政策）与自有插件仓 dsh-plugins-plus | 已落地；首个策展插件 better-sidebar 已收录 |
| better-sidebar 侧边栏默认集成 | 0.4.0 起 web profile 模板默认挂载，存量安装自动规范化 |
| 泛用智能取数工具与中台协议 | 方案已记录（proposed Agent Note），待开发 |
| 代码开发预设 | 暂未实现 |
| 智能问数预设 | 暂未实现 |
| 多用户运行时预设 | 暂未实现；当前没有多用户或公网部署预设，请把本地 runtime 保持在私有环境中 |
| AIGC 预设 | 暂未实现 |
| 社区运营预设 | 暂未实现 |

预设发布规则见 [PRESETS.md](PRESETS.md)。

## 🤝 一起把 Plus 做出来

遇到浪费时间的问题就创建 Issue，团队反复执行同一流程就发起 Discussion，有经过验证的改动就提交 Pull Request。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请通过 [SECURITY.md](SECURITY.md) 报告，不要公开提交 Issue。

## 许可证

DeepSeek Harness Plus 沿用上游 [MIT 许可证](LICENSE)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目为独立社区项目，不隶属于 DeepSeek，也未获得 DeepSeek 背书。

---

<a id="english"></a>

# English

## ✨ What Plus does for you

### 🚑 Fix blockers sooner

A session, model, or tool problem should not put your work on pause. When DeepSeek has not released the fix yet, Plus can bring you a focused repair first, with the change and its verification kept clear.

### 🧪 Try new features early

Do not wait for a promising idea to become old news. When an upstream capability is still under RFC discussion, Plus can offer it as an optional experimental feature for your real workflow. Try it, keep it when it helps, and leave it behind when it does not.

### 🧩 Use extensions, plugins, and themed presets

Plus is where community plugins and user-facing extensions show up for real work: a desktop tray managing the local runtime, an install wizard, user-data backup/restore, launch-at-startup, plus our own plugins in [dsh-plugins-plus](https://github.com/SparkElf/dsh-plugins-plus) and curated third-party plugins. A preset is a versioned collection of Harness plugins and the configuration they need, ready to choose instead of manually assemble.

## 🛡️ Why you can trust Plus

Plus stays close to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), so you can tell where an improvement came from, what it changes for your work, and how it was checked. The current product baseline is [`dsh-v0.1.0-rc.8`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.8). You get the extra capability without turning your Harness environment into a mysterious pile of patches.

<a id="run-from-source-en"></a>

## 🚀 Run from source today

You need Node.js 22.19+ or 24+, Corepack, and pnpm.

```sh
git clone https://github.com/SparkElf/deepseek-harness-plus.git
cd deepseek-harness-plus
corepack enable
pnpm install
pnpm run build
pnpm dsh web
```

Open `http://127.0.0.1:3080`. Your credentials stay in local configuration, never in Git.

## 🛠️ Availability and roadmap

Installable packages link to a release; source-only changes are labeled explicitly:

| Capability | Status |
| --- | --- |
| Desktop setup wizard and tray-managed local runtime (console-free launch, backup/restore, launch-at-startup, port takeover) | Linux/Windows 0.5.0 packages on [Releases](https://github.com/SparkElf/deepseek-harness-plus/releases/tag/plus-v0.5.0); macOS deferred pending signing and notarization |
| External plugin maintenance (curation manifest, drift checker, parallel patch policy) and the dsh-plugins-plus repo | Shipped; first curated plugin better-sidebar recorded |
| better-sidebar default integration | 0.4.0 web profile template mounts it by default; stock installs normalize automatically |
| Generic intelligent data-query tool and middle-platform protocol | Design recorded (proposed Agent Note), implementation pending |
| Code development preset | Not implemented |
| Intelligent data Q&A preset | Not implemented |
| Multi-user runtime preset | Not implemented; keep the local runtime private because no multi-user or public-internet deployment preset is available |
| AIGC preset | Not implemented |
| Community operations preset | Not implemented |

Read [PRESETS.md](PRESETS.md) for the preset release rule.

## 🤝 Help shape Plus

Open an Issue for a costly failure, start a Discussion for a repeated team workflow, or send a focused pull request with evidence. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; report security issues through [SECURITY.md](SECURITY.md), not a public issue.

## License

You can use DeepSeek Harness Plus under the upstream [MIT License](LICENSE). Third-party notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This is an independent community project and is not affiliated with or endorsed by DeepSeek.
