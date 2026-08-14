# DeepSeek Harness Plus

[中文](README.zh.md) · [What is planned](PRESETS.md) · [Contributing](CONTRIBUTING.md)

<p align="center">
  <strong>The community build of DeepSeek Harness.</strong><br>
  <em>Fix the sharp edges. Try the next idea. Keep shipping.</em>
</p>

<p align="center">
  <a href="#run"><img src="https://img.shields.io/badge/Run%20from%20source-pnpm-111111?style=for-the-badge&logo=pnpm&logoColor=white" alt="Run DeepSeek Harness Plus from source"></a>
  <a href="#not-shipped-yet"><img src="https://img.shields.io/badge/See%20what%27s%20next-First%20release-0b7285?style=for-the-badge" alt="See first release work"></a>
</p>

[![Upstream](https://img.shields.io/badge/upstream-deepseek--harness-0b7285)](https://github.com/deepseek-ai/deepseek-harness) [![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE) [![Discussions](https://img.shields.io/badge/community-Discussions-8250df)](https://github.com/SparkElf/deepseek-harness-plus/discussions)

<p align="center">
  <img src="docs/user/guide/providers-models-page.png" alt="DeepSeek Harness model provider settings" width="960">
</p>

If DeepSeek Harness is almost the tool your team needs, this is the place to close the gap. Plus is an independent community fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for developers who need a bug fixed, an RFC tried, or a workflow made repeatable before an upstream release arrives.

It keeps the upstream plugin architecture intact, then gives the community a public place to review the changes that matter in daily use: fixes you can trace, experiments you can switch on deliberately, and plugin compositions you can trust in a shared setup.

## Run

### Run from source

Requires Node.js 22.19+ or 24+, Corepack, and pnpm.

```sh
git clone https://github.com/SparkElf/deepseek-harness-plus.git
cd deepseek-harness-plus
corepack enable
pnpm install
pnpm run build
pnpm dsh web
```

Open `http://127.0.0.1:3080`, choose a provider, and start a session. Keep credentials in local configuration, never in Git.

## Why Plus exists

| When you need... | Plus is here to provide... |
| --- | --- |
| A bug fix you can actually deploy | A focused patch with its scope, verification evidence, and upstream relationship recorded. |
| An upstream idea worth trying early | A bounded RFC implementation that can be discussed, tested, and either carried forward or removed. |
| A plugin stack your team can share | Maintained composition around routes, tools, settings, permissions, and UI contributions. |
| A setup that is more than a chat transcript | Versioned presets with installation, credential, permission, and verification guidance. |

## What you can use today

- The full upstream Harness source, with a source-based Web UI workflow.
- A public upstream-tracking fork and a maintained `upstream` remote.
- Issues, Discussions, pull requests, security reporting, and a community review path.
- A home for reviewed patches, community plugins, preset proposals, and deployment work.

## Not shipped yet

The items below are being built in public. They are not included in the current checkout or installer.

| Planned work | Status |
| --- | --- |
| UI-selected model inheritance for subagents | In development |
| Desktop installer and tray-managed local daemon | In development |
| Code delivery preset | Not implemented |
| Community operations preset | Not implemented |
| Multi-user runtime preset | Not implemented |
| Intelligent data Q&A preset | Not implemented |

The full scope and release requirements live in [PRESETS.md](PRESETS.md). A preset is not called available until it has a runnable configuration, defined permissions, an install path, and verification evidence.

## Build with us

Found a failure that blocks real work? Open an Issue. Have a workflow your team repeats every week? Start a Discussion. Have a focused improvement with evidence behind it? Send a pull request.

We welcome bug fixes, early RFC implementations, community plugins, presets, deployment assets, documentation, and review. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues through [SECURITY.md](SECURITY.md), not a public issue.

## Keep close to upstream

```sh
git fetch upstream
git merge upstream/master
```

Plus stays useful only when its patches remain understandable. Every supported divergence records what changed, why it exists, what it touches, and how it is verified.

## License

DeepSeek Harness Plus remains available under the upstream [MIT License](LICENSE). Third-party notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This is an independent community project and is not affiliated with or endorsed by DeepSeek.
