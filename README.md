# DeepSeek Harness Plus

[中文](README.zh.md) · [What is planned](PRESETS.md) · [Contributing](CONTRIBUTING.md)

<p align="center">
  <a href="#run"><img src="https://img.shields.io/badge/Run%20from%20source-pnpm-111111?style=for-the-badge&logo=pnpm&logoColor=white" alt="Run DeepSeek Harness Plus from source"></a>
  <a href="https://github.com/SparkElf/deepseek-harness-plus/releases/tag/plus-v0.2.0"><img src="https://img.shields.io/badge/Current%20release-0.2.0-0b7285?style=for-the-badge" alt="Download DeepSeek Harness Plus 0.2.0"></a>
</p>

[![Upstream](https://img.shields.io/badge/upstream-deepseek--harness-0b7285)](https://github.com/deepseek-ai/deepseek-harness) [![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE) [![Discussions](https://img.shields.io/badge/community-Discussions-8250df)](https://github.com/SparkElf/deepseek-harness-plus/discussions)

<p align="center">
  <img src="assets/plus-hero.png" alt="DeepSeek Harness Plus visual poster: repair blockers, explore emerging capabilities, and assemble themed tools" width="100%">
</p>

## ✨ What Plus does for you

### 🚑 Fix blockers sooner

A session, model, or tool problem should not put your work on pause. When DeepSeek has not released the fix yet, Plus can bring you a focused repair first, with the change and its verification kept clear.

### 🧪 Try new features early

Do not wait for a promising idea to become old news. When an upstream capability is still under RFC discussion, Plus can offer it as an optional experimental feature for your real workflow. Try it, keep it when it helps, and leave it behind when it does not.

### 🧩 Use extensions and themed presets

Plus is where community plugins and user-facing extensions show up for real work. A preset is a versioned collection of Harness plugins and the configuration they need, ready to choose instead of manually assemble.

## 🛡️ Why you can trust Plus

Plus stays close to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), so you can tell where an improvement came from, what it changes for your work, and how it was checked. You get the extra capability without turning your Harness environment into a mysterious pile of patches.

<a id="run"></a>

## 🚀 Run from source today

<a id="run-from-source"></a>

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

<a id="not-shipped-yet"></a>

## 🛠️ Availability and roadmap

Installable packages link to a release; source-only changes are labeled explicitly:

| Capability | Status |
| --- | --- |
| Subagent model-inheritance repair | Available from source with focused regression coverage |
| Desktop setup guide and tray-managed local runtime | Linux/Windows 0.2.0 packages are available on [Releases](https://github.com/SparkElf/deepseek-harness-plus/releases/tag/plus-v0.2.0); macOS is deferred pending signing and notarization |
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
