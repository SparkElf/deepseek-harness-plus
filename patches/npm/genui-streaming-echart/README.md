# GenUI streaming EChart patch

English | [中文](README.zh.md)

This data-only npm package carries one temporary payload for the verified `@changfenhuang/dsh-genui 0.9.6` target. `dsh-plus apply` selects and applies the payload through the Plus profile's pnpm `patchedDependencies` map; installing this package does not run an npm lifecycle script.

The patch keeps nested tooltip, grid, axis, data, and series objects out of the streaming render tree until their enclosing top-level `items[]` component closes. This prevents a full-option EChart from receiving an intermediate xAxis-only option before its paired yAxis arrives. Complete specs, complete bare-component roots, bounded candidate collection, and settled rendering remain unchanged.

The upstream owner is [omdsh-dev/dsh-genui#87](https://github.com/omdsh-dev/dsh-genui/pull/87). Remove this package, its Plus dependency and patch-list entry, and its deployment-lock selection after an npm release contains that change and the real DataOps-to-inline-EChart Playwright path passes with no browser diagnostics.

## Model Experience

This package does not register a Cordis plugin, add model-visible text, alter token usage, or affect KV-cache reuse. The external GenUI package continues to own its `dsh-ui` teaching, parser, DOM/registry channels, components, and interaction behavior.

## Known Limitations and Deferred Work

The package supports only `@changfenhuang/dsh-genui 0.9.6`. Exact patch application fails loudly for other package content; there is no compatibility reader, runtime fallback, second renderer, or console-error suppression.
