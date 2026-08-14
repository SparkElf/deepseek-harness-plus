# DeepSeek Harness Plus

[中文](README.zh.md) · [What is planned](PRESETS.md) · [Contributing](CONTRIBUTING.md)

<p align="center">
  <strong>Fix the blocker. Try the next feature. Make Harness fit the work in front of you.</strong><br>
  <em>DeepSeek Harness Plus is the community layer that moves useful Harness improvements into your hands sooner.</em>
</p>

<p align="center">
  <a href="#run"><img src="https://img.shields.io/badge/Run%20from%20source-pnpm-111111?style=for-the-badge&logo=pnpm&logoColor=white" alt="Run DeepSeek Harness Plus from source"></a>
  <a href="#not-shipped-yet"><img src="https://img.shields.io/badge/See%20what%27s%20next-First%20release-0b7285?style=for-the-badge" alt="See first release work"></a>
</p>

[![Upstream](https://img.shields.io/badge/upstream-deepseek--harness-0b7285)](https://github.com/deepseek-ai/deepseek-harness) [![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE) [![Discussions](https://img.shields.io/badge/community-Discussions-8250df)](https://github.com/SparkElf/deepseek-harness-plus/discussions)

<p align="center">
  <img src="assets/plus-overview.png" alt="DeepSeek Harness Plus: fix blockers sooner, try new features early, and use community extensions and presets" width="100%">
</p>

## What Plus does for you

You use Plus when Harness is already useful, but the official release cycle has not caught up with what your work needs next. A bug is blocking a real task. A feature is still being discussed upstream. Or your team needs a setup built for a specific job rather than another blank configuration.

### Fix blockers sooner

When DeepSeek has not released a fix for a problem that stops your work, Plus can carry a focused repair first. Every supported repair records its purpose, relationship to upstream, affected files, and verification evidence, so you know what changed before you depend on it.

### Try new features early

When an upstream capability is still under RFC discussion, Plus can turn it into an optional experimental feature. You can inspect it, test it on real work, keep it if it helps, or remove it without confusing an early idea with an official release.

### Use extensions and themed presets

Plus is where community plugins and user-facing extensions can be delivered alongside task-focused presets. A preset means a versioned collection of Harness plugins and their required configuration, ready to select and use rather than manually assemble.

Planned preset themes include intelligent data Q&A, multi-user runtime, code development, AIGC, and community operations. These are product directions, not current downloads: no preset is installable until its plugin collection, configuration, permissions, and verification instructions ship together.

## Why you can trust the extra layer

Plus remains close to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It keeps upstream changes visible and records every supported community difference with an owner, scope, compatibility note, and verification path. That lets you use faster fixes and early functionality without turning your environment into an unexplained patch collection.

<a id="run"></a>

## Run from source today

<a id="run-from-source"></a>

### Run it in three steps

1. Clone the repository and install the locked dependencies.
2. Build the source and start the local Web UI.
3. Open the UI, choose your model provider, and start a session.

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

## 📦 What you can use today

- You can run the full upstream Harness source and Web UI from this repository.
- You can follow the upstream through the maintained `upstream` remote.
- You can use the subagent model-inheritance repair in the Plus source branch, with focused regression coverage.
- You can report a blocker, propose an experimental feature, or contribute an extension, preset, documentation, or deployment improvement in the open.

<a id="not-shipped-yet"></a>

## What is still being built

Do not depend on the following until a release marks them available:

| Capability | Status |
| --- | --- |
| Fast fixes and early experimental features | Ongoing community work; each item needs its own evidence before use |
| Desktop setup guide and tray-managed local runtime | Source implementation exists; macOS, Linux, and Windows packages are not published |
| Code development preset | Not implemented |
| Intelligent data Q&A preset | Not implemented |
| Multi-user runtime preset | Not implemented |
| AIGC preset | Not implemented |
| Community operations preset | Not implemented |

Read [PRESETS.md](PRESETS.md) for the preset release rule. Keep a local runtime private: no multi-user or public-internet deployment preset is available yet.

## ❓ Quick answers

**Is this an official DeepSeek project?** No. It is an independent community project that tracks the upstream source and follows its license.

**Why not wait for the official release?** You may choose a Plus repair or experimental feature when it solves an immediate need. Plus keeps the difference explicit, reviewed, and verifiable instead of hiding it in a private patch.

**Can you install a preset today?** No. A theme is only called a preset when its plugins and configuration install together, permissions are clear, and the result has verification evidence.

**Can you download the desktop installer today?** No. The guided setup and tray manager source are in development; there are no published macOS, Linux, or Windows installers yet.

**Can you expose this directly to the public internet for a team?** No. The multi-user runtime preset is not available. Keep your current Harness runtime private.

**Will your local changes disappear during an upstream sync?** They should not be mysterious. Supported changes are recorded with their purpose, affected files, and verification path before they become part of Plus.

## 🤝 Help make it useful

If you hit a failure that costs you time, open an Issue. If your team repeats a workflow, start a Discussion. If you have a focused improvement with proof behind it, send a pull request.

You are welcome to contribute bug fixes, early RFC implementations, community plugins, presets, deployment assets, documentation, and review. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Report security issues through [SECURITY.md](SECURITY.md), not a public issue.

## 🔄 Stay close to upstream

```sh
git fetch upstream
git merge upstream/master
```

You should always be able to see why Plus differs from upstream. Every supported community difference records what changed, why it exists, what it touches, and how you can verify it.

## License

You can use DeepSeek Harness Plus under the upstream [MIT License](LICENSE). Third-party notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This is an independent community project and is not affiliated with or endorsed by DeepSeek.
