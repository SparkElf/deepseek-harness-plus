# Install the optional packages

English | [中文](optional-packages.zh.md)

Two capabilities ship with Plus but install separately: computer use and the Exa web search provider. They appear in both `dependencies` and `optionalDependencies`, which is what makes them optional — a release always declares them, and a machine that cannot install one still gets the rest.

## What "optional" changes

| Declaration | Effect |
|---|---|
| `dependencies` | The package is part of the release and every consumer resolves the same range. |
| `optionalDependencies` | A failed install of this package does not fail the install. |

A package listed in both is released like any other and tolerated like a native addon. The install reports the failure and continues; nothing else in the profile is held back by it.

## Which packages are optional

| Package | Capability |
|---|---|
| `@deepseek-ai/dsh-computer-use` | Screenshot, click, and type against a desktop |
| `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp` | The CUA driver MCP server computer use talks to |
| `@deepseek-ai/dsh-web-search-exa` | Exa as a web search provider |

## Tell whether one is installed

`dsh` binds a capability through its plugin rows; a package that failed to install simply has no row to bind. Confirm the package itself:

```sh
ls "${DSH_HOME:-$HOME/.dsh}"/profiles/plus/node_modules/@deepseek-ai/dsh-computer-use
```

The command prints the directory when the package resolved and reports no such file when it did not. **Settings → Built-in plugins** lists the rows that actually mounted.

## Install one explicitly

```sh
dsh plugin --profile plus add @deepseek-ai/dsh-computer-use
```

`dsh plugin` forwards to pnpm in the profile directory, so every pnpm verb works and `add @scope/name@version` pins one.

Pin the version when the registry's newest is not the runtime's: computer use publishes the current line under `next` and an older line under `latest`, so a bare `add` resolves `latest` — a version this runtime refuses.

## Why computer use needs a display

The capability drives a desktop through screenshots and synthetic input, so it needs a session with a display. A headless container or a background service has none, and the package is declared optional so that deployment can omit it without editing the release.

## Continue

- [Configure models](./providers.md)
- [Use the Web UI](./index.md)
- [Subsystem reference](../../subsystems/README.md)
