# Contributing

[中文](CONTRIBUTING.zh.md)

DeepSeek Harness Plus accepts community contributions that improve reliability, deployment, presets, documentation, and the developer experience.

## Start with the right channel

- Use **Discussions** for product direction, preset proposals, and operating-model questions.
- Use **Issues** for reproducible defects and bounded feature requests.
- Use **Pull Requests** for focused, reviewable changes with documentation and relevant verification evidence.
- Use private reporting for security vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Pull requests

Keep each pull request focused on one user-visible capability, operational repair, or documentation improvement. Explain the problem, the observable result, and the checks you ran. Changes to a preset must include its configuration, permission model, credential requirements, installation path, and verification instructions.

Do not commit model credentials, database credentials, customer data, session logs, or generated build output. Preserve upstream license and third-party notices when synchronizing code from DeepSeek Harness.

## Labels and review

Maintainers use `kind/*` and `area/*` labels to route work. Use `good first issue` and `help wanted` to find contributions with an identified owner and scope. A maintainer reviews permissions, deployment impact, documentation, and verification evidence before merge.

## Development

Follow [AGENTS.md](AGENTS.md), [docs/development.md](docs/development.md), and the package-specific instructions for the files you change.

### Sync upstream

Maintainers update a clean Plus checkout from DeepSeek Harness with:

```sh
git fetch upstream
git merge upstream/master
```

Review Plus diff records and resolve conflicts before publishing the result.
