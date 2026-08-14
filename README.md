# DeepSeek Harness Plus

[中文](README.zh.md) | [Preset charter](PRESETS.md) | [Contributing](CONTRIBUTING.md)

> An independent, community-maintained distribution of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for teams that need a faster path from upstream releases to dependable operation.

[![Upstream](https://img.shields.io/badge/upstream-deepseek--harness-0b7285)](https://github.com/deepseek-ai/deepseek-harness) [![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE) [![Discussions](https://img.shields.io/badge/community-Discussions-8250df)](https://github.com/SparkElf/deepseek-harness-plus/discussions)

DeepSeek Harness Plus tracks the upstream plugin architecture and maintains a community release path for operational fixes, curated presets, and deployment assets. It is an independent project and is not affiliated with or endorsed by DeepSeek.

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

The local Web UI starts at `http://127.0.0.1:3080`. Configure a model provider through the UI before starting a session. Do not commit provider credentials or workspace secrets.

## Why Plus

- **Upstream-aware maintenance**: preserve a direct `upstream` remote, review each sync, and publish focused fixes when an operational defect blocks users.
- **Community-owned contributions**: accept bug reports, documentation, presets, deployment assets, and code through Issues, Discussions, and pull requests.
- **Runnable preset releases**: publish a preset only with its configuration, install path, capability limits, and verification instructions.
- **Deployment-ready direction**: support a shared UI and authenticated gateway with isolated user runtimes rather than exposing local Harness APIs to the public network.

## Community preset charter

The catalog is defined in [PRESETS.md](PRESETS.md). Each release track becomes installable only when it includes a versioned configuration and a documented operating model.

| Track | Intended outcome |
| --- | --- |
| Code delivery | Repository-aware implementation, review, verification, and release workflows. |
| Community operations | Issue triage, discussion moderation, release notes, and contributor coordination. |
| Multi-user runtime | A shared UI and gateway that route each authenticated user to an isolated Harness runtime. |
| Intelligent data Q&A | Governed analysis over approved data sources, semantic metrics, query review, and audit records. |

## Contribute

Start a discussion for product direction, open an issue for a reproducible defect, or submit a focused pull request. The project labels work by kind and area so contributors can find maintained entry points. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Upstream synchronization

```sh
git fetch upstream
git merge upstream/master
```

Every sync is reviewed before release. Community patches remain small, documented, and independently testable so they can be carried forward or retired cleanly.

## Security

Run Harness runtimes on private infrastructure. A production multi-user deployment must authenticate at the gateway, keep each runtime unreachable from the public internet, and scope model and data credentials to the intended user or workspace. See [SECURITY.md](SECURITY.md) for reporting guidance.

## License

This repository remains available under the upstream [MIT License](LICENSE). Third-party notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
